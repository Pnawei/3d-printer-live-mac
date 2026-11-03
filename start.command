#!/bin/bash
# 头像打印机（macOS）—— 双击运行：启动本地 HTTP 服务，并用 Chrome 应用窗口打开主程序。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
PY="$(command -v python3 || echo /usr/bin/python3)"
exec "$PY" launch.py
