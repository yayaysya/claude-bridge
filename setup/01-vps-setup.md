# 01 · 远程 VPS 前置准备指南

> **推荐原则**：**1 人 1 台独立海外 VPS**（固定公网 IP、长期不频繁更换），账号凭证、记忆与隧道端口完全隔离。

---

## 一、云服务器选购与安全组（防火墙）最小权限配置

### 1. 基础规格建议
* **系统**：Ubuntu 22.04 / 24.04 LTS（推荐）或 Debian 12
* **配置**：2 vCPU / 2 GB 内存起（若仅短时跑极简无背景桌面，1~2 GB 内存即可流畅运行）
* **区域与 IP**：优先选择主流云厂商（如 AWS EC2 / Lightsail / GCP）受支持区域的固定公网 IP（弹性 IP），避免小厂被滥用过的黑名单 IP。

### 2. 安全组入站规则（Inbound）—— 只开 1 个端口！

**无论日常开发还是首次登录桌面，安全组都只需要放行 1 个入站端口：**

| 端口 | 协议 | 作用 | 来源建议 |
| :--- | :--- | :--- | :--- |
| **`22`** | TCP | SSH 管理、DevSpace 反向隧道与临时登录画面转发 | 建议限制为你常用的出口 IP；必须禁用密码登录、仅允许 SSH 私钥登录 |

> **绝对不要开放 `7676` 或 `6080` 入站端口！** DevSpace 与临时登录画面均只绑定在 VPS 本机回环 `127.0.0.1`，完全不暴露到公网。

### 3. 如果 VPS 只给了「用户名 + 密码 + 端口」（没有 `.pem` 私钥）怎么办？
像 RAKsmart、搬瓦工等 VPS 默认常只给 `root` + 密码 + 非默认 SSH 端口：
* **不要长期保存密码！** 直接在插件的 **「新机配置向导 → 第 2 步 → 没有 .pem 私钥？用密码一键生成免密私钥」** 里填入 IP、SSH 端口、用户名和一次性密码即可：
  1. 插件会自动在本地生成专属 `ed25519` 私钥（`~/.ssh/claude-bridge_<IP>`）并上传公钥到 VPS；
  2. 如果初始用户是 **`root`**，会自动创建普通用户（默认 `claude`）并配好免密 `sudo` 和公钥（解决 Claude Code 禁止在 `root` 下使用「全部允许」模式的限制）；
  3. 验证免密成功后自动回填设置，之后全程免密运行，密码绝不落盘。

---

## 二、极简低画质网页登录桌面（首选方案 · 本地免装任何客户端）

远程桌面和 Chrome **只在第 1 天登录 Claude 账号 + 首次 `/mcp` 授权时用 5 分钟**。为了解决 `xrdp` 跨洋卡顿以及同事不想装 RustDesk 的痛点，我们采用了 **极简 `TigerVNC + openbox + noVNC` + SSH 加密转发** 方案：

* **本地 0 软件安装**：直接用本机自带浏览器打开 `http://127.0.0.1:6080/...` 即可看到远程画面。
* **跨洋极速防卡顿**：
  * 强制限制分辨率最大 **`1366×768`**（也支持 `1280×720`）；
  * **16 位色深**（比默认 24/32 位色直接砍掉一半传输量）；
  * **纯深灰单色底、零壁纸、零动画特效**（使用不到 10MB 内存的 `openbox` 窗口管理器，不再安装整套 `xfce4`）；
  * noVNC 链接默认开启 **`quality=3&compression=9`**（低画质 + 最高压缩，弱网极流畅）。
* **平时 0 内存占用**：按需启动，关闭本地脚本（`Ctrl+C`）时自动彻底销毁远程桌面进程。

---

## 三、运行 VPS 一键初始化脚本

SSH 登录到新 VPS 后，上传或复制本目录的 `setup-vps.sh` 执行：

```bash
chmod +x setup-vps.sh

# 一键安装基础环境 + sshd 心跳 + Claude CLI + DevSpace MCP + 极简登录桌面（推荐）
./setup-vps.sh --with-desktop

# 如需指定与 VPS 所在地区一致的时区或更小分辨率：
./setup-vps.sh --with-desktop --tz America/Los_Angeles --geometry 1280x720
```

脚本会自动完成：
1. 配置英文语言（`en_US.UTF-8`）及地区时区（默认 `America/New_York`）。
2. 配置 `sshd` 服务端心跳（`ClientAliveInterval 30` / `ClientAliveCountMax 3`），防止切换 VPN 残留僵尸端口。
3. 安装 Claude Code CLI（`claude`）并注册用户级 MCP：`http://127.0.0.1:7676/mcp`。
4. 安装极简登录桌面组件（`tigervnc-standalone-server`、`novnc`、`websockify`、`openbox`、`xterm`、官方 `google-chrome`）以及启停命令 `~/.local/bin/claude-login-desktop`（默认不常驻，0 内存占用）。

---

## 四、本地一键打开远程登录画面（5 分钟完成首次授权）

回到你本地电脑（WSL / Linux / macOS），运行本目录的 `open-remote-desktop.sh`：

```bash
chmod +x open-remote-desktop.sh
./open-remote-desktop.sh <VPS公网IP> ubuntu <你的私钥.pem>
```

脚本会自动：
1. 在远程 VPS 启动无背景、`1366×768`、16 位色的临时登录桌面（自动弹出一个终端窗口）；
2. 拉起 SSH 加密转发 `127.0.0.1:6080 -> VPS 127.0.0.1:6080`（自动跟随环境变量代理）；
3. 自动用你的本机浏览器打开低画质高压缩画面。

在网页画面里的终端完成两件事：
1. 输入 `claude` 回车 → 在远程 Chrome 里登录你的 Claude 账号。
2. 等本地 VS Code 的 `ClaudeBridge` 连上后，在远程终端输入 `/mcp` → 选中 `devspace` → 粘贴本地 `Owner password` 完成一次性授权（365 天有效）。
3. 完成后回到本地脚本终端按 **`Ctrl+C`**，脚本会自动把 VPS 上的临时桌面彻底停掉，内存占用归零！

> 手动启停远程桌面命令（备用）：
> * 启动：`~/.local/bin/claude-login-desktop start 1366x768`
> * 停止：`~/.local/bin/claude-login-desktop stop`
> * 状态：`~/.local/bin/claude-login-desktop status`
