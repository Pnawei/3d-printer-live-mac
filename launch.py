"""macOS 版头像打印机：本地 HTTP 服务 + Chrome 应用模式窗口 + 抖音数据桥。

原 Windows/WebView2 桌面实现已替换为 macOS 原生方案：
- 主窗口 / 直播间窗口 / 场景窗口统一用已安装的 Chrome（或 Edge）以 --app 应用模式承载；
- 前端页面在检测不到 pywebview 时会自动走本页提供的 /__ HTTP 端点，无需改动前端；
- 数据桥（douyin-bridge.mjs）通过 Chrome 远程调试端口读取公开弹幕。
"""
import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from scene_relay import SceneRelay
from urllib.parse import urlparse, parse_qs
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# macOS 上可用的 Chromium 内核浏览器（按优先级）。用于承载应用窗口与直播抓取。
BROWSER_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    str(Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
]

# 保持后台渲染不被节流（窗口被遮挡/切后台时 3D 打印仍继续），供 OBS 采集。
CHROME_BASE_FLAGS = [
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=zh-CN',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
]

# HTTP 端点 /__start-bridge 拉起的数据桥进程，退出时需一并清理，避免残留 node 进程。
_BRIDGE = {'proc': None}


def find_browser():
    for path in BROWSER_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def find_node():
    node = shutil.which('node')
    if node:
        return node
    # .app 由 Finder 启动时 PATH 很精简，这里补查常见安装位置。
    candidates = [
        '/opt/homebrew/bin/node',
        '/usr/local/bin/node',
        str(Path.home() / '.local/bin/node'),
        str(Path.home() / '.volta/bin/node'),
        str(Path.home() / '.asdf/shims/node'),
    ]
    candidates += sorted(Path.home().glob('.nvm/versions/node/*/bin/node'), reverse=True)
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def room_id(raw):
    match = re.fullmatch(r'(?:https?://live\.douyin\.com/)?(\d{5,25})(?:[/?#].*)?', str(raw).strip())
    if not match:
        raise ValueError('请输入有效的直播间号或直播链接')
    return match[1]


def listening(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0


_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def local_get(url, timeout_s=1.5):
    # 本机健康检查必须直连：系统代理（Clash 等）会拦截 127.0.0.1 请求。
    return _LOCAL_OPENER.open(url, timeout=timeout_s)


def bridge_status():
    for port in range(8765, 8775):
        try:
            with local_get(f'http://127.0.0.1:{port}/health', 1.5) as response:
                data = json.load(response)
            if data.get('service') == 'avatar-printer' and os.path.normcase(data.get('identity', '')) == os.path.normcase(str(ROOT)):
                return dict(ok=True, port=port, url=f'ws://127.0.0.1:{port}')
        except Exception:
            pass
    return dict(ok=False)


def wait_bridge(process):
    for _ in range(30):
        if process.poll() is not None:
            raise RuntimeError('数据桥启动失败，请查看 desktop-bridge.log')
        status = bridge_status()
        if status['ok']:
            return status
        time.sleep(.1)
    raise RuntimeError('数据桥启动超时，请查看 desktop-bridge.log')


ACTIVE_PORT = 8080


def ensure_server():
    global ACTIVE_PORT
    # 8080 被代理等程序占用时自动换备用端口（8081/8181/8088）。
    for port in (8080, 8081, 8181, 8088, 8090, 8095, 8282, 8388):
        if not listening(port):
            ACTIVE_PORT = port
            break
        try:
            with local_get(f'http://127.0.0.1:{port}/', 3) as response:
                if 'AVATAR PRINT STUDIO' in response.read(100000).decode('utf-8', errors='replace'):
                    ACTIVE_PORT = port
                    return f'http://127.0.0.1:{port}/', None
        except Exception:
            pass
    ACTIVE_PORT = 8081
    relay = SceneRelay()

    class Handler(SimpleHTTPRequestHandler):
        def end_headers(self):
            # Ctrl+R must load edited local pages and their scripts immediately.
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            super().end_headers()

        # 叠加一个本地控制端点：让浏览器页面也能拉起“独立应用窗口”（无浏览器界面）。
        def _guard(self):
            # 只允许本机页面调用（防其它网站借用本地服务拉进程）。
            if not str(self.headers.get('Host', '')).startswith('127.0.0.1:' + str(ACTIVE_PORT)):
                return False
            return self.headers.get('Sec-Fetch-Site', '') == 'same-origin'

        def _spawn_app(self, url, size=(1280, 720), extra=None, profile='.app-chrome-profile'):
            exe = find_browser()
            if not exe:
                return False
            args = [exe, '--app=' + url, '--window-size=%d,%d' % size,
                    '--user-data-dir=' + str(ROOT / profile)] + CHROME_BASE_FLAGS
            if extra:
                args += extra
            subprocess.Popen(args, cwd=str(ROOT))
            return True

        def do_POST(self):
            if self.path != '/__scene-message' or not self._guard():
                return self._json(403, '{"error":"forbidden"}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 65536:
                    raise ValueError('bad length')
                body = json.loads(self.rfile.read(length))
                relay.publish(body['client'], body['message'])
                return self._json(200, '{"ok":true}')
            except (ValueError, KeyError, TypeError):
                return self._json(400, '{"error":"invalid message"}')

        def do_GET(self):
            if self.path == '/__bridge-status':
                if not self._guard():
                    return self._json(403, '{"ok":false}')
                return self._json(200, json.dumps(bridge_status()))
            if self.path.startswith('/__scene-events?'):
                if not self._guard():
                    return self._json(403, '{"error":"forbidden"}')
                try:
                    query = parse_qs(urlparse(self.path).query)
                    client = query['client'][0]
                    after = int(query['after'][0]) if 'after' in query else None
                    return self._json(200, json.dumps(relay.poll(client, after)))
                except (ValueError, KeyError):
                    return self._json(400, '{"error":"invalid cursor"}')
            if self.path.startswith('/__open-live'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                room = ''.join(ch for ch in (q.get('room') or [''])[0] if ch.isdigit())[-25:]
                if not re.fullmatch(r'\d{5,25}', room):
                    return self._json(400, '{"ok":false,"error":"bad room"}')
                size = (720, 1280) if (q.get('portrait') or ['0'])[0] == '1' else (1280, 720)
                extra = None
                if (q.get('debug') or ['0'])[0] == '1':
                    # 直播抓取：用独立调试端口 9223 打开直播间窗口，登录后可被数据桥附着。
                    extra = ['--remote-debugging-port=9223',
                             '--disable-gpu-compositing']
                if not self._spawn_app('https://live.douyin.com/' + room, size, extra, profile='.bridge-profile'):
                    return self._json(500, '{"ok":false,"error":"no browser found"}')
                return self._json(200, '{"ok":true}')
            if self.path.startswith('/__start-bridge'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                room = ''.join(ch for ch in (q.get('room') or [''])[0] if ch.isdigit())[-25:]
                if not re.fullmatch(r'\d{5,25}', room):
                    try:
                        room = ''.join(ch for ch in (ROOT / '.bridge-room').read_text(encoding='utf-8') if ch.isdigit())[-25:]
                    except Exception:
                        room = ''
                if not re.fullmatch(r'\d{5,25}', room):
                    return self._json(400, '{"ok":false,"error":"no room"}')
                if bridge_status()["ok"]:
                    return self._json(200, '{"ok":true,"already":true}')
                node = find_node()
                if not node:
                    return self._json(500, '{"ok":false,"error":"node not found"}')
                log = open(ROOT / 'desktop-bridge.log', 'ab')
                (ROOT / '.bridge-room').write_text(room, encoding='utf-8')
                env = os.environ.copy()
                # 直播间窗口固定开在 9223；若该端口在监听则显式告知数据桥。
                if listening(9223):
                    env['PRINTER_CDP_PORT'] = '9223'
                _BRIDGE['proc'] = subprocess.Popen([node, str(ROOT / 'douyin-bridge.mjs'), room], cwd=str(ROOT),
                                                   env=env, stdout=log, stderr=log)
                try:
                    return self._json(200, json.dumps(wait_bridge(_BRIDGE['proc'])))
                except RuntimeError as exc:
                    return self._json(500, json.dumps(dict(ok=False, error=str(exc))))
            if self.path.startswith('/__stop-bridge'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                proc = _BRIDGE['proc']
                if proc and proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                _BRIDGE['proc'] = None
                return self._json(200, '{"ok":true}')
            if self.path.startswith('/__open-scene'):
                if not self._guard():
                    return self._json(403, '{"ok":false,"error":"forbidden"}')
                q = parse_qs(urlparse(self.path).query)
                spath = (q.get('path') or [''])[0]
                orient = (q.get('orient') or ['landscape'])[0]
                sizes = {'landscape': (1280, 720), 'landscape-1080p': (1920, 1080),
                         'portrait': (720, 1280), 'portrait-1080p': (1080, 1920)}
                size = sizes.get(orient, (1280, 720))
                if not re.fullmatch(r'/[A-Za-z0-9_\-]+\.html\?scene=1', spath):
                    return self._json(400, '{"ok":false,"error":"bad path"}')
                if not self._spawn_app('http://127.0.0.1:' + str(ACTIVE_PORT) + spath, size, profile='.scene-chrome-profile'):
                    return self._json(500, '{"ok":false,"error":"no browser found"}')
                return self._json(200, '{"ok":true}')
            # Ignore validators from versions cached before no-store was enabled.
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
            return super().do_GET()

        def _json(self, code, body):
            data = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', ACTIVE_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{ACTIVE_PORT}/', server


def stop_bridge():
    proc = _BRIDGE['proc']
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    _BRIDGE['proc'] = None


def open_app_window(url, width=1380, height=860):
    """用 Chrome 应用模式打开主窗口，返回子进程句柄（窗口关闭即进程退出）。"""
    exe = find_browser()
    if not exe:
        return None
    flags = list(CHROME_BASE_FLAGS)
    if (ROOT / '.capture-compat').exists():
        flags += ['--disable-gpu', '--disable-accelerated-video-decode']
    args = [exe, '--app=' + url,
            '--user-data-dir=' + str(ROOT / '.printer-chrome-profile'),
            f'--window-size={width},{height}'] + flags
    return subprocess.Popen(args, cwd=str(ROOT))


def main():
    parser = argparse.ArgumentParser(description='头像打印机（macOS）')
    parser.add_argument('--server-only', action='store_true',
                        help='只启动本地 HTTP 服务，不自动打开应用窗口（自行用浏览器访问）')
    args = parser.parse_args()

    url, server = ensure_server()
    print(f'头像打印机已启动：{url}', flush=True)

    window = None
    if not args.server_only:
        window = open_app_window(url)
        if window is None:
            print('未找到 Chrome / Edge / Chromium，请安装 Google Chrome 后重试；'
                  f'或先用浏览器手动打开 {url}', flush=True)

    # Finder/终端退出（Cmd+Q、SIGTERM）时优雅清理：关窗口、停数据桥、关服务。
    def _on_signal(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        if window is not None:
            window.wait()          # 主窗口关闭即退出
        else:
            threading.Event().wait()  # 无窗口（server-only 或没找到浏览器）时常驻
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        if window is not None and window.poll() is None:
            window.terminate()
        stop_bridge()
        if server:
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    main()
