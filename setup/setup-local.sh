#!/usr/bin/env bash
# ClaudeBridge · 渡桥 — 本地环境一键初始化脚本（WSL / Linux / macOS）
# 用法：./setup-local.sh [项目根目录，默认 ~/project] [端口，默认 7676]

set -euo pipefail

PROJECT_ROOT="${1:-$HOME/project}"
LOCAL_PORT="${2:-7676}"

mkdir -p "${PROJECT_ROOT}"
PROJECT_ROOT="$(cd "${PROJECT_ROOT}" && pwd)"

echo "============================================"
echo " ClaudeBridge · 渡桥 — 本地 DevSpace 初始化"
echo " 授权目录: ${PROJECT_ROOT}"
echo " 监听地址: http://127.0.0.1:${LOCAL_PORT}/mcp (仅本机，不暴露公网)"
echo "============================================"

echo "[1/4] 检查 Node.js 环境..."
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 Node.js 24 LTS (>=22.19 <27)，例如使用 nvm："
  echo "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  nvm install 24"
  exit 1
fi
echo "当前 Node.js: $(node -v)"

echo "[2/4] 安装或更新 @waishnav/devspace..."
npm install -g @waishnav/devspace

echo "[3/4] 初始化 DevSpace 配置..."
devspace init --yes \
  --public-url "http://127.0.0.1:${LOCAL_PORT}" \
  --roots "${PROJECT_ROOT}"

echo "[4/4] 安全加固：关闭本地 subagents，延长 OAuth 有效期至 365 天..."
python3 - "${LOCAL_PORT}" << 'PYEOF'
import json, os, sys

port = int(sys.argv[1])
cfg_path = os.path.expanduser("~/.devspace/config.jsonc")
with open(cfg_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

cfg.setdefault("server", {})["host"] = "127.0.0.1"
cfg["server"]["port"] = port
cfg["server"]["publicBaseUrl"] = f"http://127.0.0.1:{port}"
cfg.setdefault("oauth", {})["refreshTokenTtlSeconds"] = 31536000
cfg["oauth"]["refreshTokenGraceSeconds"] = 30
if "subagents" in cfg and isinstance(cfg["subagents"], dict):
    cfg["subagents"]["enabled"] = False
else:
    cfg["subagents"] = {"enabled": False, "instructions": "on-demand", "providers": []}

with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

auth_path = os.path.expanduser("~/.devspace/auth.json")
owner_token = ""
if os.path.exists(auth_path):
    with open(auth_path, "r", encoding="utf-8") as f:
        owner_token = json.load(f).get("ownerToken", "")

print("")
print("============================================")
print(" 本地初始化完成！")
print(" 你的 DevSpace Owner Password（首次 /mcp 授权时使用，请妥善保管）：")
print(f"   {owner_token}")
print(" 配置文件位置: ~/.devspace/config.jsonc")
print("============================================")
PYEOF
