#!/bin/bash
# 常驻守护（macOS）：数据桥退出后自动重启。房间号读取 .bridge-room（由主程序写入）。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "未找到 Node.js，请先安装（例如 brew install node）。"; exit 1; fi
ROOM="$(cat .bridge-room 2>/dev/null)"
while true; do
  "$NODE" douyin-bridge.mjs "$ROOM"
  echo "数据桥已退出，3 秒后重启…（Ctrl+C 结束守护）"
  sleep 3
done
