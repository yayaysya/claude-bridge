# DuDuNiao · 渡渡鸟

> 声明：本项目为独立开发的第三方开源社区工具，与 Anthropic、Google 无官方隶属关系。

**渡渡鸟（DuDuNiao）** 是一个用于打通 **本地开发环境（Windows / WSL / Linux / macOS）** 与 **远程服务器（AWS EC2 / VPS / 云主机）上 Claude Code CLI 及 Google Antigravity CLI (`agy`)** 的 VS Code 插件。

核心理念：**代码始终留在本地，AI 推理与外网流量 100% 留在远程服务器**。通过本地 **DevSpace MCP + SSH 反向隧道** 安全互通，在 VS Code 中提供多标签 Agent 侧边栏、4 套完整视觉主题、可视化设置中心、本机 Skill 同步与 4 步新机配置向导。

## 核心特性

- **双引擎支持（Claude Code + Google Antigravity，预留 Codex 扩展层）**
  - 每个服务器档案独立选择后端引擎（`Claude Code` / `Antigravity (agy)`）与偏好模型，一键秒切不串台。
  - Antigravity 模式通过权限规则锁死远程 VPS 写入与命令执行，确保只通过 `devspace` MCP 操作本地代码目录。
- **同机多人隔离（适合 2～4 位同事共用一台 VPS）**
  - 支持在向导中为每位同事创建独立 Linux 用户、独立 SSH 私钥，并自动分配不冲突的远程隧道端口（`7676 / 7677 / 7678 / 7679`）与独立 `noVNC` 临时登录桌面端口；同机新增同事时自动跳过已装系统包，几十秒完成装机。
- **一键连接与全自动自愈**
  - 打开 VS Code 自动拉起（或复用）本地 `devspace serve` 并建立 SSH 反向隧道。
  - 动态代理跟随（`claudeBridge.sshProxy = "auto"` 自动识别环境变量代理或回退直连，内置纯 Node.js 跨平台代理桥，Windows / WSL / Linux / macOS 全平台通用，绝不写死端口）。
  - 切换 VPN / 网络闪断自动清理远程僵尸端口并秒级重连，配备连续失败防误杀健康检查与持久化诊断日志 `~/.claude-bridge/bridge.log`。
- **多 VPS 档案一键切换**：支持在 `~/.claude-bridge/profiles.json` 中维护多台 VPS / 多个 Claude 账号，顶栏点一下即可 3 秒秒切服务器；本地 DevSpace 共用，各台 VPS 的额度与会话自动隔离不串台。
- **内置「4 步新机配置向导」**：
  - 图形化一键完成本机 DevSpace 安装与安全加固、无 `.pem` 密码一键生成免密密钥（支持 `root` 自动创建普通用户）、新 VPS 一键装机、免客户端弹出低画质无背景 `noVNC` 网页登录画面（最大 `1366×768`、16 位色、0 额外安全组端口、用完一键销毁 0 内存占用）以及一键验收。
- **原生风格 Agent 聊天侧边栏**
  - 流式回复、思考过程折叠、DevSpace 工具调用单行状态卡片。
  - 完整 GFM Markdown 渲染（表格、代码块复制、有序/无序列表、引用）、一键复制整条输出，以及点击回复里的 `文件名:行号`（如 `main.c:1818`）直接跳转并高亮对应代码行。
  - 底部快捷切换权限模式、原版模型名称与思考强度（`--effort`）。
  - 顶栏静默展示官方 5 小时 / 7 天额度与重置倒计时（后台 `/usage` 查询，0 Token，不弹终端）。
  - **按项目隔离的会话历史与草稿持久化**：每个工作区独立存储在 `~/.claude-bridge/workspaces/`，多窗口并行开发绝不串台、不互相覆盖；重载窗口、重启 VS Code 或切换历史会话，输入框写到一半的内容与附件均不会丢失。
- **专属可视化设置中心**
  - 告别杂乱的原生设置页，提供卡片式配置界面、私钥文件选择器、一键 **测试连接**、本地 `CLAUDE.md` 快捷打开与无损同步，以及 **远程 Claude 自动记忆 (`memory/`) 一键拉取、本地备份与合并到本地规则**。
- **实时工作区与 Git 感知**
  - 欢迎页与输入区实时显示当前项目、Git 分支与未提交改动数；发消息时自动附带轻量现场快照（同一会话内现场无变化自动去重省 Token）。
- **原生终端兜底**
  - 一键直连远程打开交互式 `claude` 终端（支持 `/mcp`、`/usage` 等全部官方命令）。

## 快速上手

> 完整的新 VPS 搭建、安全组最小权限配置、RustDesk 零暴露接入，以及同事本地一键初始化脚本，详见仓库内的 **`setup/README.md`**（含 `setup-vps.sh`、`setup-local.sh`、`setup-local.ps1`）。

### 1. 本地准备
```bash
npm install -g @waishnav/devspace
devspace init --yes --public-url http://127.0.0.1:7676 --roots /path/to/your/projects
```
> 建议在 `~/.devspace/config.jsonc` 中将 `subagents.enabled` 设为 `false`，防止远程误调本地 CLI。

### 2. 远程服务器准备
1. 安装并登录 `claude`（Claude Code CLI）。
2. 在远程注册 DevSpace MCP 并完成首次 `/mcp` 授权：
   ```bash
   claude mcp add --scope user --transport http devspace http://127.0.0.1:7676/mcp
   ```

### 3. 构建与安装插件
```bash
npm install
npm run package
code --install-extension claude-bridge-*.vsix
```
安装后点击侧边栏右上角 **`⚙` → 打开可视化设置中心**，填入服务器地址与私钥路径，点「测试连接」并「保存并重连」即可开始使用。

## 开源协议

MIT License（详见项目根目录 `LICENSE` 文件）
