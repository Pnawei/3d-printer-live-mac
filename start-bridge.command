#!/bin/bash
# 单独启动抖音数据桥（macOS）。
# 用法：可先双击本脚本，或带房间号运行：./start-bridge.command 123456789012
# 前提：主程序里已「打开直播间窗口」并完成登录，数据桥会自动附着该窗口（:9223）。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "未找到 Node.js，请先安装（例如 brew install node）。"; exit 1; fi
exec "$NODE" douyin-bridge.mjs "$@"
