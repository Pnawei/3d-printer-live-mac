#!/usr/bin/env node
// 直播专用小窗（弹窗）完整功能测试：场景模式视觉、设置面板、自动隐藏、领导者选举、恢复接管。
// 用法：node test-popup.mjs  （需先关闭正在运行的打印桌面版，避免端口/资源干扰）
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = 9226;
const BASE = 'http://127.0.0.1:8080';
const results = [];
const ok = (name, cond, detail = '') => { results.push([cond ? 'PASS' : 'FAIL', name, detail]); console.log((cond ? '✅' : '❌') + ' ' + name + (detail ? ' —— ' + detail : '')) };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => { const q = http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)) } catch (e) { rej(e) } }); }); q.on('error', rej); q.end(); });
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(p => fs.existsSync(p));

let browserProc = null, browserConn = null;
async function startBrowser() {
  fs.rmSync(path.join(ROOT, '.popup-test'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, '.diag-profile'), { recursive: true, force: true });
  browserProc = spawn(CHROME, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(ROOT, '.popup-test'), '--no-first-run', '--window-size=1100,700', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore', detached: false });
  let v = null;
  for (let i = 0; i < 25; i++) { await sleep(600); try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); break } catch { } }
  if (!v) throw new Error('测试浏览器启动超时');
  browserConn = await connect(v.webSocketDebuggerUrl, false);
}

function connect(wsUrl, enables = true) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let mid = 0; const pend = new Map();
    const errs = [];
    ws.addEventListener('message', ev => {
      let m; try { m = JSON.parse(ev.data) } catch { return }
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; errs.push((d.exception?.description || d.text || '').slice(0, 200)) }
    });
    const rpc = (method, params = {}) => new Promise((res, rej) => { const id = ++mid; pend.set(id, { res, rej, t: setTimeout(() => { pend.delete(id); rej(new Error('evaluate timeout')) }, 30000) }); ws.send(JSON.stringify({ id, method, params })); });
    ws.addEventListener('open', async () => {
      try { if (enables) { await rpc('Runtime.enable'); await rpc('Page.enable') } resolve({ rpc, errs }) } catch (e) { reject(e) }
    });
    ws.addEventListener('error', () => reject(new Error('CDP error')));
  });
}

async function evalIn(tab, expr, timeoutMs = 30000) {
  const v = await Promise.race([
    tab.conn.rpc('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => r.result?.value),
    sleep(timeoutMs).then(() => '__TIMEOUT__')
  ]);
  return v;
}

let conn;

async function openTab(url) {
  const { targetId } = await browserConn.rpc('Target.createTarget', { url });
  let t = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      t = list.find(x => (x.id === targetId || x.targetId === targetId) && x.webSocketDebuggerUrl);
      if (t) break;
    } catch { }
  }
  if (!t) {
    const all = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(e => [{ url: 'list-failed: ' + e.message }]);
    console.log('  [诊断] 当前 targets:', JSON.stringify(all.map(x => ({ id: (x.targetId || '').slice(0, 8), type: x.type, url: (x.url || '').slice(0, 60), ws: !!x.webSocketDebuggerUrl }))));
    throw new Error('标签页未就绪：' + url);
  }
  const c = await connect(t.webSocketDebuggerUrl);
  await sleep(4000);
  return { targetId, conn: c };
}

async function main() {
  console.log('—— 直播专用小窗（弹窗）完整测试 ——\n');
  // 0) 服务在位
  await startBrowser();
  const html = await new Promise((res, rej) => { http.get(BASE + '/index.html', r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)) }).on('error', rej) });
  ok('打印页可访问', html.includes('AVATAR PRINT STUDIO'));
  ok('场景模式代码在位', html.includes('SCENE_MODE') && html.includes('scene-only'));

  // 1) 先开主页面（普通模式）
  const main = await openTab(BASE + '/index.html');
  conn = main.conn;
  const mainState = await evalIn(main, `JSON.stringify({sceneOnly:document.body.classList.contains('scene-only'),note:(document.getElementById('yield-note')||{}).textContent||'',mode:(document.getElementById('mode')||{}).textContent||''})`);
  ok('主页面正常初始化（无场景类）', mainState !== '__TIMEOUT__' && JSON.parse(mainState).sceneOnly === false, mainState);
  ok('主页面初始无让位提示', JSON.parse(mainState).note === '');

  // 2) 开场景页（弹窗模式）
  const scene = await openTab(BASE + '/live-view.html');
  await sleep(5000);
  const sceneState = await evalIn(scene, `JSON.stringify({src:!!document.getElementById('v').srcObject,ready:(document.getElementById('v').readyState||0)>=2,hint:getComputedStyle(document.getElementById('hint')).display})`, 40000);
  console.log('  [小窗状态]', sceneState);
  if (sceneState !== '__TIMEOUT__') {
    const s = JSON.parse(sceneState);
    ok('小窗收到主窗口视频流（镜像）', s.src === true && s.ready === true, 'src=' + s.src + ' ready=' + s.ready);
    ok('流建立后提示自动隐藏', s.hint === 'none');
  } else ok('小窗镜像断言', false, 'evaluate 超时');

  // 3) 领导者选举：场景窗口应接管，主页面让位
  await sleep(4000);
  const mainNote = await evalIn(main, `(document.getElementById('yield-note')||{}).textContent||''`, 30000);
  ok('主窗口不冻结：镜像期间无“接管打印中”提示', mainNote !== '__TIMEOUT__' && !/接管打印中/.test(mainNote), mainNote || '(空)');

  // 4) 关闭场景窗口 → 主页面自动恢复
  await browserConn.rpc('Target.closeTarget', { targetId: scene.targetId });
  await sleep(14000);
  const mainNote2 = await evalIn(main, `(document.getElementById('yield-note')||{}).textContent||''`, 30000);
  ok('关闭小窗后镜像状态清除', mainNote2 !== '__TIMEOUT__' && !/直播小窗镜像中/.test(mainNote2), mainNote2 || '(空=已清除)');

  // 5) 场景页运行时异常统计（整个测试期间）
  const sceneErrs = scene.conn.errs;
  ok('小窗页面运行时 0 异常', sceneErrs.length === 0, sceneErrs.slice(0, 2).join(' | '));
  const mainErrs = main.conn.errs;
  ok('主页面运行时 0 异常', mainErrs.length === 0, mainErrs.slice(0, 2).join(' | '));

  console.log('\n—— 结果 ——');
  const pass = results.filter(r => r[0] === 'PASS').length;
  console.log(`${pass}/${results.length} 通过`);
  fs.writeFileSync('popup-test-result.json', JSON.stringify(results, null, 2));
  process.exit(pass === results.length ? 0 : 1);
}

main().then(() => { }, e => { console.error('测试失败：', e.message); process.exit(1) }).finally(() => { try { browserProc && browserProc.kill() } catch { } try { fs.rmSync(path.join(ROOT, '.popup-test'), { recursive: true, force: true }) } catch { } });
