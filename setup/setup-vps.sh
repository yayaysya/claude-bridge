#!/usr/bin/env bash
# ClaudeBridge · 渡桥 — 远程 VPS 一键初始化脚本（Ubuntu / Debian）
# 用法：
#   ./setup-vps.sh                          # 仅安装基础环境 + sshd 心跳 + Claude CLI + DevSpace MCP
#   ./setup-vps.sh --with-desktop           # 额外安装极简 noVNC 登录桌面（openbox 无背景 + 1366x768 + Chrome）
#   ./setup-vps.sh --tz America/Los_Angeles # 自定义与 VPS 地区一致的时区（默认 America/New_York）

set -euo pipefail

WITH_DESKTOP=false
TARGET_TZ="America/New_York"
REMOTE_PORT="7676"
VNC_GEOMETRY="1366x768"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-desktop|--with-login-desktop)
      WITH_DESKTOP=true
      shift
      ;;
    --tz)
      TARGET_TZ="${2:?--tz 需要指定时区，例如 America/New_York}"
      shift 2
      ;;
    --port)
      REMOTE_PORT="${2:?--port 需要指定端口号，默认 7676}"
      shift 2
      ;;
    --geometry)
      VNC_GEOMETRY="${2:?--geometry 需要指定分辨率，例如 1280x720 或 1366x768}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1"
      exit 1
      ;;
  esac
done

echo "============================================"
echo " ClaudeBridge · 渡桥 — 远程 VPS 初始化"
echo " 时区: ${TARGET_TZ} | MCP 端口: ${REMOTE_PORT} | 极简登录桌面: ${WITH_DESKTOP}"
echo "============================================"

echo "[1/5] 安装基础工具与配置英文语言/时区..."
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg python3 locales
sudo locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
sudo timedatectl set-timezone "${TARGET_TZ}" || true

echo "[2/5] 配置 sshd 服务端心跳（防止切 VPN 残留僵尸端口）..."
sudo mkdir -p /etc/ssh/sshd_config.d
printf "ClientAliveInterval 30\nClientAliveCountMax 3\n" \
  | sudo tee /etc/ssh/sshd_config.d/99-claude-bridge-keepalive.conf >/dev/null
sudo sshd -t
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd 2>/dev/null || true

echo "[3/5] 检查并安装 Claude Code CLI..."
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
fi
echo "Claude CLI 版本: $(claude --version 2>/dev/null || echo '已安装，请重新打开终端确认 PATH')"

echo "[4/5] 注册用户级 DevSpace MCP 并写入默认路由规则..."
claude mcp remove devspace -s user >/dev/null 2>&1 || true
claude mcp add --scope user --transport http devspace "http://127.0.0.1:${REMOTE_PORT}/mcp"

mkdir -p "$HOME/.claude"
if [[ ! -f "$HOME/.claude/CLAUDE.md" ]]; then
  cat > "$HOME/.claude/CLAUDE.md" << 'EOF'
# Workspace Routing Rule (DevSpace MCP)

You are running on a remote host, while the user's actual code repositories live on their local machine and are exposed through the `devspace` MCP server.

## Mandatory Rules
1. Always prefer `devspace` MCP tools to open, browse, search, read, edit, and run commands in the user's local project directories.
2. Do NOT use remote host filesystem tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`) to look for or modify the user's project source code unless explicitly asked to inspect this remote machine itself.
3. Keep all file operations strictly inside the user-specified local workspace exposed by DevSpace.
EOF
fi

if [[ "${WITH_DESKTOP}" == "true" ]]; then
  echo "[5/5] 安装极简 noVNC 临时登录桌面（openbox 无背景 + TigerVNC 16位色 + Google Chrome）..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    tigervnc-standalone-server \
    novnc \
    websockify \
    openbox \
    x11-xserver-utils \
    xterm \
    xdg-utils \
    fonts-dejavu-core \
    fonts-noto-cjk \
    wget

  if ! command -v google-chrome >/dev/null 2>&1; then
    wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
  fi

  # 安装按需启停脚本 ~/claude-login-desktop（平时 0 内存占用，仅监听 127.0.0.1 不暴露公网）
  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/claude-login-desktop" << DESK_EOF
#!/usr/bin/env bash
# 极简临时登录桌面控制器：最大 1366x768、16 位色、纯黑底无背景、仅绑定 127.0.0.1:6080
set -euo pipefail

ACTION="\${1:-status}"
GEOM="\${2:-${VNC_GEOMETRY}}"
DISPLAY_NUM=":1"
VNC_PORT="5901"
NOVNC_PORT="6080"
PID_DIR="\$HOME/.cache/claude-login-desktop"
mkdir -p "\$PID_DIR"

# 强制限制分辨率不超过 1366x768，避免跨洋高分辨率卡顿
clamp_geometry() {
  local raw="\$1"
  local w="\${raw%x*}"
  local h="\${raw#*x}"
  if ! [[ "\$w" =~ ^[0-9]+$ && "\$h" =~ ^[0-9]+$ ]]; then
    echo "1366x768"
    return
  fi
  if (( w > 1366 )); then w=1366; fi
  if (( h > 768 )); then h=768; fi
  if (( w < 800 )); then w=800; fi
  if (( h < 600 )); then h=600; fi
  echo "\${w}x\${h}"
}

stop_all() {
  if [[ -f "\$PID_DIR/novnc.pid" ]]; then
    kill "\$(cat "\$PID_DIR/novnc.pid")" 2>/dev/null || true
    rm -f "\$PID_DIR/novnc.pid"
  fi
  pkill -u "\$USER" -f "websockify.*127\.0\.0\.1:\${NOVNC_PORT}" 2>/dev/null || true
  pkill -u "\$USER" -f "Xtigervnc \${DISPLAY_NUM}" 2>/dev/null || true
  rm -f "/tmp/.X1-lock" "/tmp/.X11-unix/X1" 2>/dev/null || true
  echo "STOPPED"
}

start_all() {
  stop_all >/dev/null 2>&1 || true
  local safe_geom
  safe_geom="\$(clamp_geometry "\$GEOM")"

  # 1. 启动仅监听本机 127.0.0.1 的 Xtigervnc（16 位色 + 无加密额外开销，安全由 SSH 隧道保障）
  Xtigervnc "\$DISPLAY_NUM" \
    -localhost yes \
    -rfbport "\$VNC_PORT" \
    -SecurityTypes None \
    -geometry "\$safe_geom" \
    -depth 16 \
    -dpi 96 \
    -AlwaysShared \
    -AcceptSetDesktopSize=0 \
    >"\$PID_DIR/vnc.log" 2>&1 &
  echo \$! >"\$PID_DIR/vnc.pid"

  sleep 1

  # 2. 启动纯色无背景的极简 openbox + 自动弹出终端提示运行 claude
  export DISPLAY="\$DISPLAY_NUM"
  export LANG="en_US.UTF-8"
  export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:\$PATH"

  # 纯深灰单色底（无壁纸、无图标、无动画特效，压缩率极高）
  xsetroot -solid "#181818" 2>/dev/null || true
  openbox >"\$PID_DIR/openbox.log" 2>&1 &

  # 居中自动打开一个干净终端，方便直接执行 claude 登录与 /mcp 授权
  xterm -fa "DejaVu Sans Mono" -fs 11 -bg "#111111" -fg "#eeeeee" -geometry 96x26+40+40 \
    -T "Claude Login Terminal" \
    -e bash -lc 'export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:\$PATH"; echo "=== Claude 首次登录终端 ==="; echo "1. 输入 claude 登录你的账号"; echo "2. 登录后输入 /mcp 授权 devspace"; echo ""; exec bash' \
    >"\$PID_DIR/xterm.log" 2>&1 &

  # 3. 启动仅监听 127.0.0.1:6080 的 noVNC Web 网关
  websockify --web=/usr/share/novnc "127.0.0.1:\${NOVNC_PORT}" "127.0.0.1:\${VNC_PORT}" \
    >"\$PID_DIR/novnc.log" 2>&1 &
  echo \$! >"\$PID_DIR/novnc.pid"

  sleep 1
  echo "READY geometry=\${safe_geom} depth=16 url=http://127.0.0.1:\${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&quality=3&compression=9"
}

case "\$ACTION" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  status)
    if pgrep -u "\$USER" -f "Xtigervnc \${DISPLAY_NUM}" >/dev/null 2>&1 && pgrep -u "\$USER" -f "websockify.*127\.0\.0\.1:\${NOVNC_PORT}" >/dev/null 2>&1; then
      echo "RUNNING"
    else
      echo "STOPPED"
    fi
    ;;
  *)
    echo "用法: claude-login-desktop <start [1366x768]|stop|status>"
    exit 1
    ;;
esac
DESK_EOF

  chmod +x "$HOME/.local/bin/claude-login-desktop"
  echo "极简登录桌面已就绪：~/.local/bin/claude-login-desktop（当前默认未启动，0 内存占用）"
else
  echo "[5/5] 跳过登录桌面安装（如需免客户端网页登录画面，可带 --with-desktop 重新运行）。"
fi

echo ""
echo "============================================"
echo " VPS 初始化完成！"
echo " 如已安装登录桌面，可在本地电脑运行 setup/open-remote-desktop.sh 一键弹出低画质极速登录画面。"
echo "============================================"
