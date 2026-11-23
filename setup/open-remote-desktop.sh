#!/usr/bin/env bash
# ClaudeBridge · 渡桥 — 本地一键打开极简低画质远程登录画面（无需安装 RustDesk / VNC 客户端）
# 用法：
#   ./open-remote-desktop.sh <VPS_IP> <SSH_USER> <私钥路径.pem> [分辨率，默认 1366x768]
# 示例：
#   ./open-remote-desktop.sh 1.2.3.4 ubuntu ~/.ssh/my-vps.pem
#   ./open-remote-desktop.sh 1.2.3.4 ubuntu ~/.ssh/my-vps.pem 1280x720

set -euo pipefail

SSH_HOST="${1:-}"
SSH_USER="${2:-ubuntu}"
SSH_KEY="${3:-}"
GEOMETRY="${4:-1366x768}"
LOCAL_NOVNC_PORT="${LOCAL_NOVNC_PORT:-6080}"

if [[ -z "${SSH_HOST}" || -z "${SSH_KEY}" ]]; then
  echo "用法: $0 <VPS_IP> <SSH_USER> <私钥路径.pem> [分辨率，最大 1366x768]"
  exit 1
fi

if [[ ! -f "${SSH_KEY}" ]]; then
  echo "找不到私钥文件: ${SSH_KEY}"
  exit 1
fi
chmod 600 "${SSH_KEY}" 2>/dev/null || true

# 自动适配环境变量代理（与插件保持一致，绝不写死端口）
SSH_OPTS=(
  -i "${SSH_KEY}"
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=3
  -o SendEnv=-LANG
  -o SendEnv=-LC_*
)

PROXY_URL="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-${all_proxy:-}}}}}}"
if [[ -n "${PROXY_URL}" ]] && command -v nc >/dev/null 2>&1; then
  PROXY_CLEAN="${PROXY_URL#*://}"
  PROXY_HOST="${PROXY_CLEAN%%:*}"
  PROXY_PORT="${PROXY_CLEAN##*:}"
  PROXY_PORT="${PROXY_PORT%%/*}"
  if [[ -n "${PROXY_HOST}" && "${PROXY_PORT}" =~ ^[0-9]+$ ]]; then
    if [[ "${PROXY_URL}" == socks* ]]; then
      SSH_OPTS+=(-o "ProxyCommand=nc -X 5 -x ${PROXY_HOST}:${PROXY_PORT} %h %p")
    else
      SSH_OPTS+=(-o "ProxyCommand=nc -X connect -x ${PROXY_HOST}:${PROXY_PORT} %h %p")
    fi
    echo "检测到代理 ${PROXY_URL}，SSH 将经由该代理连接..."
  fi
fi

cleanup() {
  echo ""
  echo "正在关闭远程临时桌面以释放 VPS 内存..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" '$HOME/.local/bin/claude-login-desktop stop' >/dev/null 2>&1 || true
  echo "已清理完毕，VPS 桌面内存占用已归零。"
}
trap cleanup EXIT INT TERM

echo "[1/2] 在远程 VPS 启动极简无背景临时桌面 (${GEOMETRY}, 16位色)..."
START_OUT=$(ssh "${SSH_OPTS[@]}" "${SSH_USER}@${SSH_HOST}" "\$HOME/.local/bin/claude-login-desktop start '${GEOMETRY}'")
echo "远程状态: ${START_OUT}"

LOGIN_URL="http://127.0.0.1:${LOCAL_NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&quality=3&compression=9"

echo ""
echo "[2/2] 正在建立 SSH 加密转发（0 额外安全组端口）..."
echo "============================================"
echo " 请在本机浏览器打开下面链接进入远程登录画面（低画质高压缩、无背景）："
echo "   ${LOGIN_URL}"
echo ""
echo " 完成 Claude 登录与 /mcp 授权后，回到这里按 Ctrl+C 退出，"
echo " 脚本会自动彻底关闭 VPS 临时桌面释放内存！"
echo "============================================"

# 尝试自动打开本地浏览器（支持 WSL / macOS / Linux 桌面）
(
  sleep 2
  if command -v wslview >/dev/null 2>&1; then
    wslview "${LOGIN_URL}" >/dev/null 2>&1 || true
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "${LOGIN_URL}" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "${LOGIN_URL}" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${LOGIN_URL}" >/dev/null 2>&1 || true
  fi
) &

ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:${LOCAL_NOVNC_PORT}:127.0.0.1:6080" \
  "${SSH_USER}@${SSH_HOST}"
