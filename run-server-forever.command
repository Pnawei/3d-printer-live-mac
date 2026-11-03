#!/bin/bash
# 常驻守护（macOS）：仅启动 HTTP 服务（不自动开窗口），退出后 3 秒自动重启。
# 适合把服务长期挂着，再用浏览器访问 http://127.0.0.1:8080。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
PY="$(command -v python3 || echo /usr/bin/python3)"
while true; do
  "$PY" launch.py --server-only
  echo "服务已退出，3 秒后重启…（Ctrl+C 结束守护）"
  sleep 3
done
