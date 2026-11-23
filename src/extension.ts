import * as path from "path";
import * as vscode from "vscode";
import { BridgeManager, BridgeState } from "./bridgeManager";
import { ChatViewProvider } from "./chatViewProvider";
import { ClaudeClient } from "./claudeClient";
import { getBridgeConfig } from "./config";
import { ContextAttachment, SessionStore } from "./sessionStore";
import { TerminalManager } from "./terminalManager";
import { RulesSyncManager } from "./rulesSync";
import { BridgeLogger } from "./logger";

let bridgeManager: BridgeManager | undefined;
let terminalManager: TerminalManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("EC2 Claude Bridge");
  const logger = new BridgeLogger(outputChannel);
  bridgeManager = new BridgeManager(logger);
  terminalManager = new TerminalManager(logger);
  const claudeClient = new ClaudeClient(logger);
  const sessionStore = new SessionStore(context.globalState);
  const rulesSync = new RulesSyncManager(logger, context.globalState);
  const chatProvider = new ChatViewProvider(
    context.extensionUri,
    bridgeManager,
    claudeClient,
    sessionStore,
    terminalManager,
    rulesSync
  );

  // 注册左侧 Agent 聊天面板
  context.subscriptions.push(
    logger,
    bridgeManager,
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewId,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 创建左下角状态栏一键按钮
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = "ec2Claude.showMenu";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const updateStatusBar = (state: BridgeState) => {
    switch (state.status) {
      case "connected":
        statusBar.text = "$(plug) EC2 Claude: 已连接";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = `${state.detail}\n点击打开快捷操作菜单`;
        break;
      case "connecting":
        statusBar.text = "$(sync~spin) EC2 Claude: 连接中";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = state.detail;
        break;
      case "error":
        statusBar.text = "$(error) EC2 Claude: 已断开";
        statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
        statusBar.tooltip = `${state.detail}\n点击重连或查看日志`;
        break;
      default:
        statusBar.text = "$(debug-disconnect) EC2 Claude: 未连接";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = "点击一键连接本地 DevSpace 与远程 EC2";
        break;
    }
  };

  let prevBridgeStatus = bridgeManager.getState().status;
  updateStatusBar(bridgeManager.getState());
  context.subscriptions.push(
    bridgeManager.onDidChangeState((st) => {
      updateStatusBar(st);
      // 首次连上或重连恢复时：静默刷新额度，若开启本地规则同步则按指纹去重同步
      if (st.status === "connected" && prevBridgeStatus !== "connected") {
        void chatProvider.refreshQuota();
        const cfg = getBridgeConfig();
        if (cfg.syncLocalRules) {
          void rulesSync.sync(cfg, { force: false });
        }
      }
      prevBridgeStatus = st.status;
    })
  );

  // 注册全部插件命令
  context.subscriptions.push(
    vscode.commands.registerCommand("ec2Claude.connect", async () => {
      const ok = await bridgeManager?.connect(true);
      if (ok) {
        vscode.window.showInformationMessage("EC2 Claude 已连接成功。");
      } else {
        vscode.window.showErrorMessage(
          "EC2 Claude 连接失败，请点击状态栏查看连接日志。"
        );
      }
    }),

    vscode.commands.registerCommand("ec2Claude.disconnect", () => {
      bridgeManager?.disconnect();
      vscode.window.showInformationMessage("EC2 Claude 已断开连接。");
    }),

    vscode.commands.registerCommand("ec2Claude.openChat", async () => {
      await vscode.commands.executeCommand("ec2Claude.chatView.focus");
    }),

    vscode.commands.registerCommand("ec2Claude.openTerminal", async () => {
      if (bridgeManager && bridgeManager.getState().status !== "connected") {
        await bridgeManager.connect(false);
      }
      terminalManager?.openRemoteClaudeTerminal(getBridgeConfig());
    }),

    vscode.commands.registerCommand("ec2Claude.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("请先打开一个代码文件。");
        return;
      }
      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const filePath = editor.document.uri.fsPath;
      const baseName = path.basename(filePath);

      const att: ContextAttachment = selectedText.trim()
        ? {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: "selection",
            filePath,
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            label: `${baseName}:${selection.start.line + 1}-${selection.end.line + 1}`,
            content: selectedText,
          }
        : {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            type: "file",
            filePath,
            label: baseName,
          };

      await chatProvider.addContextAttachment(att);
    }),

    vscode.commands.registerCommand("ec2Claude.addCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("当前没有打开的文件。");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      const att: ContextAttachment = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "file",
        filePath,
        label: path.basename(filePath),
      };
      await chatProvider.addContextAttachment(att);
    }),

    vscode.commands.registerCommand("ec2Claude.showLogs", () => {
      logger.showChannel();
    }),

    vscode.commands.registerCommand("ec2Claude.openLogFile", async () => {
      await logger.openLogFile();
    }),

    vscode.commands.registerCommand("ec2Claude.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "ec2Claude"
      );
    }),

    vscode.commands.registerCommand("ec2Claude.syncRules", async () => {
      const cfg = getBridgeConfig();
      const res = await rulesSync.sync(cfg, { force: true });
      if (res.ok) {
        vscode.window.showInformationMessage(res.message);
      } else {
        vscode.window.showWarningMessage(res.message);
      }
    }),

    vscode.commands.registerCommand("ec2Claude.showMenu", async () => {
      const state = bridgeManager?.getState();
      const items: Array<vscode.QuickPickItem & { action: string }> = [
        {
          label: "$(comment-discussion) 打开侧边栏聊天面板",
          description: "方案 B：气泡聊天 + 工具卡片 + 上下文引用",
          action: "chat",
        },
        {
          label: "$(terminal) 打开原生远程 Claude 终端",
          description: "方案 A：原生 CLI（支持 /mcp、/usage 等命令）",
          action: "terminal",
        },
        {
          label:
            state?.status === "connected"
              ? "$(sync) 重新连接（刷新隧道）"
              : "$(plug) 一键连接 EC2 Claude",
          description: state?.detail ?? "",
          action: "connect",
        },
        {
          label: "$(debug-disconnect) 断开连接",
          description: "停止本插件拉起的隧道与 DevSpace",
          action: "disconnect",
        },
        {
          label: "$(sync) 同步本地 CLAUDE.md 规则到远程",
          description: "无损合并到远程 ~/.claude/CLAUDE.md",
          action: "syncRules",
        },
        {
          label: "$(file-text) 打开诊断日志文件 (bridge.log)",
          description: "~/.ec2-claude-bridge/bridge.log（含断线原因与耗时）",
          action: "openLogFile",
        },
        {
          label: "$(output) 查看实时输出面板",
          action: "logs",
        },
        {
          label: "$(gear) 打开插件设置",
          description: "配置 EC2 IP、密钥、权限模式、自动重连",
          action: "settings",
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `EC2 Claude Bridge (${state?.detail ?? "未连接"})`,
      });
      if (!picked) {
        return;
      }
      if (picked.action === "chat") {
        await vscode.commands.executeCommand("ec2Claude.openChat");
      } else if (picked.action === "terminal") {
        await vscode.commands.executeCommand("ec2Claude.openTerminal");
      } else if (picked.action === "connect") {
        await vscode.commands.executeCommand("ec2Claude.connect");
      } else if (picked.action === "disconnect") {
        await vscode.commands.executeCommand("ec2Claude.disconnect");
      } else if (picked.action === "syncRules") {
        await vscode.commands.executeCommand("ec2Claude.syncRules");
      } else if (picked.action === "openLogFile") {
        await vscode.commands.executeCommand("ec2Claude.openLogFile");
      } else if (picked.action === "logs") {
        logger.showChannel();
      } else if (picked.action === "settings") {
        await vscode.commands.executeCommand("ec2Claude.openSettings");
      }
    }),

    // 监听配置变更同步刷新面板
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ec2Claude")) {
        chatProvider.syncState();
      }
    })
  );

  // 启动时自动连接（重启电脑再打开 VS Code 无需手工敲任何命令）
  const cfg = getBridgeConfig();
  if (cfg.autoConnect) {
    void bridgeManager.connect(false);
  }
}

export function deactivate(): void {
  terminalManager?.dispose();
  bridgeManager?.dispose();
}
