# ClaudeBridge · 渡桥 — 部署与前置准备指南

本目录汇总了使用 **ClaudeBridge（渡桥）** 插件前的所有前置准备工作与一键脚本，适合：
- 给新购买的远程 VPS（AWS EC2 / GCP / Lightsail / 普通 Linux VPS）快速建站；
- 给团队同事分发安装，5 分钟完成接入。

> **核心架构原则**：代码 100% 留在本地电脑，AI 推理与外网请求 100% 留在远程 VPS；通过本地 `DevSpace MCP + SSH 反向隧道` 安全互通，不将任何开发端口暴露到公网。

---

## 目录说明

| 文件 | 用途 | 适用对象 |
| :--- | :--- | :--- |
| [01-vps-setup.md](01-vps-setup.md) | 远程 VPS 环境准备、安全组最小权限、RustDesk 零暴露接入与用完停机 | 服务器管理员 / 自己买新 VPS |
| [02-local-setup.md](02-local-setup.md) | 本地电脑 DevSpace 安装、插件安装与首次授权（含 WSL 与纯 Windows） | 每一位开发者 / 同事 |
| [setup-vps.sh](setup-vps.sh) | 新 VPS 一键初始化脚本（含极简 `noVNC` 1366×768 无背景登录桌面） | 在新 VPS 上运行一次 |
| [open-remote-desktop.sh](open-remote-desktop.sh) | 本地一键打开低画质网页登录画面（0 客户端、0 安全组端口、退出自动销毁） | 首次登录 Claude / `/mcp` 时运行 |
| [setup-local.sh](setup-local.sh) | WSL / Linux / macOS 本地一键初始化脚本 | 在本地终端运行一次 |
| [setup-local.ps1](setup-local.ps1) | 纯 Windows 本地一键初始化脚本（PowerShell） | 在纯 Windows 上运行一次 |

---

## 最快上手顺序（总共 3 步）

1. **准备远程 VPS（1 人 1 台，一次性约 5 分钟）**
   * 见 [01-vps-setup.md](01-vps-setup.md)，运行 `setup-vps.sh`，完成一次 Claude 账号登录。
2. **准备本地电脑（一次性约 3 分钟）**
   * 见 [02-local-setup.md](02-local-setup.md)，运行 `setup-local.sh`（或 `setup-local.ps1`）安装并初始化 DevSpace，记下 `Owner password`。
3. **安装并配置 VS Code 插件（1 分钟）**
   * 安装 `claude-bridge-*.vsix` → 打开右上角 `⚙ → 打开可视化设置中心` → 填入 VPS IP、用户名和私钥 `.pem` → 点击「测试连接」并「保存并重连」→ 打开终端输入 `/mcp` 填一次密码完成授权（365 天有效）。
   * 完成后即可停掉 VPS 远程桌面服务省内存，之后日常开发全部在本地 VS Code 内完成。
