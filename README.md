# EC2 Claude Bridge

一个用于打通 **本地开发环境（Linux / WSL）** 与 **远程服务器（如 AWS EC2）上的 Claude Code CLI** 的 VS Code 插件。

代码始终留在本地，AI 推理与外网请求 100% 留在远程服务器；通过本地 **DevSpace MCP + SSH 反向隧道** 实现安全互通，并在 VS Code 侧边栏提供原生风格的 Agent 对话体验。

## 核心特性

- **一键连接与自动自愈**：打开 VS Code 自动拉起（或复用）本地 `devspace serve` 并建立 SSH 反向隧道，支持断线指数退避重连与休眠唤醒恢复。
- **网络与环境隔离**：本地仅监听 `127.0.0.1` 不暴露公网；SSH 连接强制禁用 `LANG` / `LC_*` 本地环境变量透传。
- **侧边栏 Agent 聊天面板**：
  - 流式回复、思考过程折叠、DevSpace 工具调用单行状态卡片（支持点击路径直接跳转本地编辑器）。
  - 完整 GFM Markdown 渲染（表格、代码块复制、有序/无序列表、引用）、一键复制整条输出，以及点击回复中的 `文件名:行号`（如 `main.c:1818`）直接跳转并高亮对应代码行。
  - 底部快捷切换权限模式（`bypassPermissions` / `acceptEdits` / `plan` / `dontAsk`）、原版模型名称与思考强度（`--effort`）。
  - 顶栏实时展示官方 5 小时 / 7 天额度进度条、重置倒计时与最近会话上下文占用（随正常对话自动更新，零额外请求）。
  - 会话历史持久化与 `--resume` 断点续聊。
- **本地规则无损同步**：可在设置中开启 `ec2Claude.syncLocalRules`，自动或一键将本地 `CLAUDE.md`（支持多文件）以独立标记区块合并同步至远程 `~/.claude/CLAUDE.md`，不覆盖远程路由规则。
- **实时工作区与 Git 感知**：欢迎页与输入区实时显示当前工作区和 Git 分支/改动数；每次发送消息自动附带轻量现场快照（项目路径、活动文件与行号、分支与 `git status`），具体代码与 Diff 由远程 Claude 通过 DevSpace 按需读取。
- **原生终端兜底**：一键在 VS Code 内直连远程打开原生交互式 `claude` 终端（支持 `/mcp`、`/usage` 等全部官方命令）。

## 快速上手

### 1. 本地准备
1. 安装 Node.js (`>= 22.19`) 与 DevSpace MCP：
   ```bash
   npm install -g @waishnav/devspace
   devspace init --yes --public-url http://127.0.0.1:7676 --roots /path/to/your/projects
   ```
   > 建议在 `~/.devspace/config.jsonc` 中将 `subagents.enabled` 设为 `false`，避免远程误调本地 CLI。

### 2. 远程服务器准备
1. 安装并登录 `claude`（Claude Code CLI）。
2. 建立隧道后，在远程注册 DevSpace MCP 并完成首次 `/mcp` 授权：
   ```bash
   claude mcp add --scope user --transport http devspace http://127.0.0.1:7676/mcp
   ```
3. 在远程 `~/.claude/CLAUDE.md` 中指引 Claude 默认通过 `devspace` MCP 工具访问本地工作区。

### 3. 安装与配置插件
```bash
npm install
npm run package
code --install-extension ec2-claude-vscode-*.vsix
```

在 VS Code 设置中搜索 `ec2Claude`，填入：
- `ec2Claude.sshHost`：远程服务器 IP 或域名
- `ec2Claude.sshUser`：SSH 登录用户名（默认 `ubuntu`）
- `ec2Claude.sshKeyPath`：本地 SSH 私钥 `.pem` 绝对路径

## 开源协议

MIT License（详见项目根目录 `LICENSE` 文件）
