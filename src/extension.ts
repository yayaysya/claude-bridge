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
import { MemoryManager } from "./memoryManager";
import { SettingsPanel } from "./settingsPanel";

let bridgeManager: BridgeManager | undefined;
let terminalManager: TerminalManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("ClaudeBridge · 渡桥");
  const logger = new BridgeLogger(outputChannel);
  bridgeManager = new BridgeManager(logger);
  terminalManager = new TerminalManager(logger);
  const claudeClient = new ClaudeClient(logger);
  const sessionStore = new SessionStore(context.globalState);
  const rulesSync = new RulesSyncManager(logger, context.globalState);
  const memoryManager = new MemoryManager(logger);
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
  statusBar.command = "claudeBridge.showMenu";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const updateStatusBar = (state: BridgeState) => {
    switch (state.status) {
      case "connected":
        statusBar.text = "$(plug) ClaudeBridge: 已连接";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = `${state.detail}\n点击打开渡桥快捷菜单`;
        break;
      case "connecting":
        statusBar.text = "$(sync~spin) ClaudeBridge: 连接中";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = state.detail;
        break;
      case "error":
        statusBar.text = "$(error) ClaudeBridge: 已断开";
        statusBar.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground"
        );
        statusBar.tooltip = `${state.detail}\n点击重连或查看诊断日志`;
        break;
      default:
        statusBar.text = "$(debug-disconnect) ClaudeBridge: 未连接";
        statusBar.backgroundColor = undefined;
        statusBar.tooltip = "点击一键连接本地 DevSpace 与远程 Claude";
        break;
    }
  };

  let prevBridgeStatus = bridgeManager.getState().status;
  updateStatusBar(bridgeManager.getState());
  context.subscriptions.push(
    bridgeManager.onDidChangeState((st) => {
      updateStatusBar(st);
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

  const openSettingsPanel = (focusSection?: "server" | "memory") =>
    SettingsPanel.show({
      extensionUri: context.extensionUri,
      bridge: bridgeManager!,
      rulesSync,
      memory: memoryManager,
      logger,
      focusSection,
    });

  // 注册全部插件命令
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeBridge.connect", async () => {
      const ok = await bridgeManager?.connect(true);
      if (ok) {
        vscode.window.showInformationMessage("ClaudeBridge 已连接成功。");
      } else {
        vscode.window.showErrorMessage(
          "ClaudeBridge 连接失败，请点击状态栏查看诊断日志或打开设置中心。"
        );
      }
    }),

    vscode.commands.registerCommand("claudeBridge.disconnect", () => {
      bridgeManager?.disconnect();
      vscode.window.showInformationMessage("ClaudeBridge 已断开连接。");
    }),

    vscode.commands.registerCommand("claudeBridge.openChat", async () => {
      await vscode.commands.executeCommand("claudeBridge.chatView.focus");
    }),

    vscode.commands.registerCommand("claudeBridge.openTerminal", async () => {
      if (bridgeManager && bridgeManager.getState().status !== "connected") {
        await bridgeManager.connect(false);
      }
      terminalManager?.openRemoteClaudeTerminal(getBridgeConfig());
    }),

    vscode.commands.registerCommand("claudeBridge.sendSelection", async () => {
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

    vscode.commands.registerCommand("claudeBridge.addCurrentFile", async () => {
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

    vscode.commands.registerCommand("claudeBridge.showLogs", () => {
      logger.showChannel();
    }),

    vscode.commands.registerCommand("claudeBridge.openLogFile", async () => {
      await logger.openLogFile();
    }),

    vscode.commands.registerCommand("claudeBridge.openSettings", () => {
      openSettingsPanel("server");
    }),

    vscode.commands.registerCommand("claudeBridge.openLocalRules", async () => {
      await memoryManager.openLocalClaudeMd(getBridgeConfig());
    }),

    vscode.commands.registerCommand("claudeBridge.syncRules", async () => {
      const cfg = getBridgeConfig();
      const res = await rulesSync.sync(cfg, { force: true });
      if (res.ok) {
        vscode.window.showInformationMessage(res.message);
      } else {
        vscode.window.showWarningMessage(res.message);
      }
    }),

    vscode.commands.registerCommand(
      "claudeBridge.viewRemoteMemories",
      async () => {
        const panel = openSettingsPanel("memory");
        await panel.triggerPullMemories();
      }
    ),

    vscode.commands.registerCommand("claudeBridge.showMenu", async () => {
      const state = bridgeManager?.getState();
      const items: Array<vscode.QuickPickItem & { action: string }> = [
        {
          label: "$(comment-discussion) 打开渡桥聊天面板",
          description: "流式对话 + 工具卡片 + 文件行号跳转",
          action: "chat",
        },
        {
          label: "$(gear) 打开可视化设置中心",
          description: "服务器、代理、测试连接、规则与远程记忆",
          action: "settings",
        },
        {
          label: "$(terminal) 打开原生远程 Claude 终端",
          description: "交互式 CLI（支持 /mcp、/usage 等命令）",
          action: "terminal",
        },
        {
          label:
            state?.status === "connected"
              ? "$(sync) 重新连接（刷新隧道）"
              : "$(plug) 一键连接远程 Claude",
          description: state?.detail ?? "",
          action: "connect",
        },
        {
          label: "$(book) 打开本地 CLAUDE.md",
          description: "编辑个人偏好与编码规范",
          action: "openLocalRules",
        },
        {
          label: "$(cloud-download) 拉取并查看远程 Claude 记忆",
          description: "查看远程自动记住的习惯并备份到本地",
          action: "viewRemoteMemories",
        },
        {
          label: "$(sync) 立即同步本地 CLAUDE.md 到远程",
          description: "无损合并到远程 ~/.claude/CLAUDE.md",
          action: "syncRules",
        },
        {
          label: "$(file-text) 打开诊断日志文件 (bridge.log)",
          description: "~/.claude-bridge/bridge.log（含断线原因与耗时）",
          action: "openLogFile",
        },
        {
          label: "$(debug-disconnect) 断开连接",
          description: "停止本插件拉起的隧道与 DevSpace",
          action: "disconnect",
        },
      ];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `ClaudeBridge · 渡桥 (${state?.detail ?? "未连接"})`,
      });
      if (!picked) {
        return;
      }
      const actionMap: Record<string, string> = {
        chat: "claudeBridge.openChat",
        settings: "claudeBridge.openSettings",
        terminal: "claudeBridge.openTerminal",
        connect: "claudeBridge.connect",
        disconnect: "claudeBridge.disconnect",
        openLocalRules: "claudeBridge.openLocalRules",
        viewRemoteMemories: "claudeBridge.viewRemoteMemories",
        syncRules: "claudeBridge.syncRules",
        openLogFile: "claudeBridge.openLogFile",
      };
      const cmd = actionMap[picked.action];
      if (cmd) {
        await vscode.commands.executeCommand(cmd);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("claudeBridge") ||
        e.affectsConfiguration("ec2Claude")
      ) {
        chatProvider.syncState();
      }
    })
  );

  // 启动时自动连接
  const cfg = getBridgeConfig();
  if (cfg.autoConnect) {
    void bridgeManager.connect(false);
  }
}

export function deactivate(): void {
  terminalManager?.dispose();
  bridgeManager?.dispose();
}
