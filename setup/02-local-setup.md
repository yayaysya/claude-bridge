# 02 · 本地电脑前置准备与插件接入指南

> **重要提醒**：如果一台电脑上同时有 Windows 和 WSL，请**只在一侧**安装 DevSpace 与插件（推荐优先在 **WSL** 中使用），避免两边抢占 `7676` 端口和 OAuth 授权互相冲突。

---

## 一、路线 A：WSL / Linux / macOS（推荐）

### 1. 运行本地一键初始化脚本
打开你的 WSL / Linux / macOS 终端，执行 `setup-local.sh`（将路径替换为你存放项目的根目录）：

```bash
chmod +x setup-local.sh
./setup-local.sh ~/project
```

脚本会自动帮你完成：
* 检查 Node.js 版本（需要 `>= 22.19 < 27`）；
* 全局安装 `@waishnav/devspace`；
* 执行 `devspace init` 授权你的项目目录，仅监听本机 `127.0.0.1:7676`（绝不暴露公网）；
* **自动关闭本地 `subagents`**（防止远程 Claude 误调你本地 CLI 发出外网流量）；
* **自动将 OAuth 刷新令牌有效期延长到 365 天**（避免频繁重输密码）；
* 打印并提示保存生成的 **`Owner password`**（存放在 `~/.devspace/auth.json`）。

### 2. 安装并配置 VS Code 插件
1. 在 VS Code（如果是 WSL，请确保左下角已连上 `WSL: Ubuntu`）中安装 `claude-bridge-*.vsix`：
   ```bash
   code --install-extension claude-bridge-0.4.0.vsix --force
   ```
2. 按 `Ctrl + Shift + P` → 运行 **`Developer: Reload Window`**。
3. 点左侧活动栏的星形图标打开 **ClaudeBridge · 渡桥** → 点右上角 **`⚙` → 打开可视化设置中心**。
4. 填写远程 VPS 的 **IP 地址**、**用户名**、**本地私钥 `.pem`**（点「选择文件」挑选），代理策略保持默认的 **自动跟随环境代理 (`auto`)**。
5. 点 **「测试连接」** 确认绿勾通过，再点 **「保存并重连」**。

### 3. 完成首次 `/mcp` 授权（仅此一次）
1. 状态栏显示 `ClaudeBridge: 已连接` 后，点侧边栏右上角 **`>_`（终端图标）** 打开远程 Claude 终端（或在 VPS 远程桌面的终端里运行 `claude`）。
2. 输入 `/mcp` 回车 → 选中 `devspace` → 按提示在远程浏览器输入步骤 1 记下的 **`Owner password`** 并点 Authorize。
3. 授权完成后，回到本地 VS Code 侧边栏就可以直接对话操作本地项目了！

---

## 二、路线 B：纯 Windows（未安装 WSL）

### 1. 前置依赖
* 安装 **[Git for Windows](https://git-scm.com/download/win)**（DevSpace 在纯 Windows 上依赖 Git Bash 执行命令）。
* 安装 **Node.js 24 LTS**（版本要求 `>= 22.19 < 27`）。
* 确保系统自带 OpenSSH 客户端（Windows 10/11 默认已带 `ssh` 命令）。

### 2. 运行 Windows 一键初始化脚本
在 PowerShell 中运行 `setup-local.ps1`（将路径替换为你自己的代码根目录）：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-local.ps1 -ProjectRoot "D:\projects"
```

### 3. 安装插件与注意事项
* 用 VS Code 打开扩展面板 → 右上角 `...` → **从 VSIX 安装...** → 选中 `claude-bridge-*.vsix`。
* **纯 Windows 代理说明**：当前 `v0.4.0` 的自动代理功能在 Linux/WSL/macOS 下使用系统 `nc` 命令；如果纯 Windows 环境下需要通过本地代理连海外 VPS，请升级到后续跨平台代理版本，或临时开启 VPN 的系统级 TUN 模式后在设置中心将代理策略设为 **强制直连 (`off`)**。
