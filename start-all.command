#!/bin/bash
# 头像打印机（macOS）—— 一键启动主程序窗口（等价于 start.command）。
# 直播间窗口请打开主程序后，在「直播连接」面板填写房间号并点击「打开直播间窗口」。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
PY="$(command -v python3 || echo /usr/bin/python3)"
exec "$PY" launch.py
