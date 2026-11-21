import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { BridgeManager } from "./bridgeManager";
import { ClaudeClient, ClaudeRunHandle } from "./claudeClient";
import {
  EffortLevel,
  getActiveWorkspacePath,
  getBridgeConfig,
  PermissionMode,
  updateEffort,
  updateModel,
  updatePermissionMode,
  updateSyncLocalRules,
} from "./config";
import {
  ChatMessage,
  ContextAttachment,
  QuotaSnapshot,
  SessionStore,
} from "./sessionStore";
import { TerminalManager } from "./terminalManager";
import { RulesSyncManager } from "./rulesSync";
import {
  collectGitBadgeInfo,
  collectWorkspaceSnapshot,
  formatSnapshotForPrompt,
  GitBadgeInfo,
} from "./workspaceContext";

/**
 * 方案 B：侧边栏 Agent 聊天面板（对标 Claude Code 官方风格）
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "ec2Claude.chatView";

  private view: vscode.WebviewView | undefined;
  private pendingAttachments: ContextAttachment[] = [];
  private activeRun: ClaudeRunHandle | undefined;
  private gitBadge: GitBadgeInfo | undefined;
  private lastGitRefreshAt = 0;
  private isRefreshingQuota = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: BridgeManager,
    private readonly claude: ClaudeClient,
    private readonly sessions: SessionStore,
    private readonly terminal: TerminalManager,
    private readonly rulesSync: RulesSyncManager
  ) {
    this.bridge.onDidChangeState(() => {
      this.syncState();
    });
    // 实时同步当前打开的文件与选区，方便输入框一键引用
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.syncState();
    });
    vscode.window.onDidChangeTextEditorSelection(() => {
      this.syncState();
    });
    // 保存文件或切换工作区时轻量刷新 Git 分支与改动数量
    vscode.workspace.onDidSaveTextDocument(() => {
      void this.refreshGitBadge(true);
    });
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void this.refreshGitBadge(true);
    });
    void this.refreshGitBadge(true);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "dist"),
      ],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleWebviewMessage(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshGitBadge(false);
        this.syncState();
      }
    });

    void this.refreshGitBadge(false);
    this.syncState();
  }

  /** 刷新本地工作区的轻量 Git 分支与改动数量 */
  public async refreshGitBadge(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastGitRefreshAt < 3000) {
      return;
    }
    this.lastGitRefreshAt = now;
    this.gitBadge = await collectGitBadgeInfo();
    this.syncState();
  }

  /** 后台静默刷新远程 Claude 实时额度（0 Token，不弹终端） */
  public async refreshQuota(): Promise<void> {
    if (this.isRefreshingQuota) {
      return;
    }
    this.isRefreshingQuota = true;
    this.syncState();
    try {
      const partial = await this.claude.fetchQuota(getBridgeConfig());
      if (partial) {
        const prev = this.sessions.getQuota();
        const merged: QuotaSnapshot = {
          ...prev,
          ...partial,
          updatedAt: partial.updatedAt ?? Date.now(),
        };
        this.sessions.saveQuota(merged);
      }
    } finally {
      this.isRefreshingQuota = false;
      this.syncState();
    }
  }

  /** 将编辑器当前文件或选中代码添加到输入框上下文标签，并唤起侧边栏 */
  public async addContextAttachment(att: ContextAttachment): Promise<void> {
    const exists = this.pendingAttachments.some(
      (item) =>
        item.type === att.type &&
        item.filePath === att.filePath &&
        item.startLine === att.startLine &&
        item.endLine === att.endLine
    );
    if (!exists) {
      this.pendingAttachments.push(att);
    }
    await vscode.commands.executeCommand("ec2Claude.chatView.focus");
    this.syncState();
  }

  /** 向 Webview 推送完整状态快照 */
  public syncState(): void {
    if (!this.view) {
      return;
    }
    const cfg = getBridgeConfig();
    const activeSession = this.sessions.getActiveSession();
    const sessionSummaries = this.sessions.listSessions().map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      hasRemoteSession: Boolean(s.claudeSessionId),
    }));

    const editor = vscode.window.activeTextEditor;
    let activeEditor:
      | {
          filePath: string;
          fileName: string;
          hasSelection: boolean;
          selectionRange: string;
        }
      | undefined;

    if (editor && editor.document.uri.scheme === "file") {
      const sel = editor.selection;
      const hasSel = !sel.isEmpty;
      activeEditor = {
        filePath: editor.document.uri.fsPath,
        fileName: path.basename(editor.document.uri.fsPath),
        hasSelection: hasSel,
        selectionRange: hasSel
          ? `${sel.start.line + 1}-${sel.end.line + 1}`
          : "",
      };
    }

    void this.view.webview.postMessage({
      type: "state",
      payload: {
        bridge: this.bridge.getState(),
        permissionMode: cfg.permissionMode,
        model: cfg.model,
        effort: cfg.effort,
        syncLocalRules: cfg.syncLocalRules,
        quota: this.sessions.getQuota() ?? null,
        isRefreshingQuota: this.isRefreshingQuota,
        workspacePath: getActiveWorkspacePath() ?? "",
        gitBadge: this.gitBadge ?? null,
        activeEditor,
        isRunning: this.claude.isRunning(),
        attachments: this.pendingAttachments,
        activeSession,
        sessions: sessionSummaries,
      },
    });
  }

  private async handleWebviewMessage(
    msg: Record<string, unknown>
  ): Promise<void> {
    const type = String(msg.type ?? "");

    switch (type) {
      case "ready":
        void this.refreshGitBadge(false);
        this.syncState();
        break;

      case "refreshGit":
        await this.refreshGitBadge(true);
        break;

      case "copyText": {
        const text = String(msg.text ?? "");
        if (text) {
          await vscode.env.clipboard.writeText(text);
        }
        break;
      }

      case "syncRules": {
        const res = await this.rulesSync.sync(getBridgeConfig(), { force: true });
        if (res.ok) {
          vscode.window.showInformationMessage(res.message);
        } else {
          vscode.window.showWarningMessage(res.message);
        }
        break;
      }

      case "toggleSyncLocalRules": {
        const nextEnabled = Boolean(msg.enabled);
        await updateSyncLocalRules(nextEnabled);
        this.syncState();
        if (nextEnabled && this.bridge.getState().status === "connected") {
          const res = await this.rulesSync.sync(getBridgeConfig(), {
            force: false,
          });
          if (res.ok && !res.skippedUnchanged) {
            vscode.window.showInformationMessage(res.message);
          }
        }
        break;
      }

      case "refreshQuota": {
        await this.refreshQuota();
        break;
      }

      case "connect":
        await this.bridge.connect(Boolean(msg.force));
        this.syncState();
        break;

      case "disconnect":
        this.bridge.disconnect();
        this.syncState();
        break;

      case "openTerminal":
        this.terminal.openRemoteClaudeTerminal(getBridgeConfig());
        break;

      case "openSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "ec2Claude"
        );
        break;

      case "setPermissionMode": {
        const mode = String(msg.mode ?? "bypassPermissions") as PermissionMode;
        await updatePermissionMode(mode);
        this.syncState();
        break;
      }

      case "setModel": {
        const model = String(msg.model ?? "");
        await updateModel(model);
        this.syncState();
        break;
      }

      case "setEffort": {
        const effort = String(msg.effort ?? "") as EffortLevel;
        await updateEffort(effort);
        this.syncState();
        break;
      }

      case "newSession":
        if (this.activeRun) {
          this.activeRun.abort();
          this.activeRun = undefined;
        }
        this.sessions.createSession();
        this.syncState();
        break;

      case "selectSession": {
        const id = String(msg.sessionId ?? "");
        if (this.activeRun) {
          this.activeRun.abort();
          this.activeRun = undefined;
        }
        this.sessions.setActiveSession(id);
        this.syncState();
        break;
      }

      case "deleteSession": {
        const id = String(msg.sessionId ?? "");
        this.sessions.deleteSession(id);
        this.syncState();
        break;
      }

      case "addCurrentFile":
        await vscode.commands.executeCommand("ec2Claude.addCurrentFile");
        break;

      case "addSelection":
        await vscode.commands.executeCommand("ec2Claude.sendSelection");
        break;

      case "removeAttachment": {
        const attId = String(msg.id ?? "");
        this.pendingAttachments = this.pendingAttachments.filter(
          (a) => a.id !== attId
        );
        this.syncState();
        break;
      }

      case "openFile": {
        const filePath = String(msg.filePath ?? "");
        const startLine =
          typeof msg.startLine === "number" ? msg.startLine : undefined;
        if (filePath) {
          await this.openLocalFile(filePath, startLine);
        }
        break;
      }

      case "stop":
        if (this.activeRun) {
          this.activeRun.abort();
          this.activeRun = undefined;
          this.syncState();
        }
        break;

      case "send": {
        const text = String(msg.text ?? "").trim();
        if (!text && this.pendingAttachments.length === 0) {
          return;
        }
        await this.handleSendPrompt(text);
        break;
      }
    }
  }

  private async handleSendPrompt(userText: string): Promise<void> {
    if (this.claude.isRunning()) {
      return;
    }

    const bridgeState = this.bridge.getState();
    if (bridgeState.status !== "connected") {
      const ok = await this.bridge.connect(false);
      if (!ok) {
        vscode.window.showErrorMessage(
          "EC2 Claude 未连接成功，请先检查本地 DevSpace 与 SSH 隧道状态。"
        );
        return;
      }
    }

    const session = this.sessions.getActiveSession();
    const attachments = [...this.pendingAttachments];
    this.pendingAttachments = [];

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: "user",
      text: userText || "请分析附件中的内容",
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: Date.now(),
    };

    const assistantMsg: ChatMessage = {
      id: `msg_${Date.now()}_a`,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      timestamp: Date.now(),
    };

    if (session.messages.length === 0) {
      const cleanTitle = (userText || attachments[0]?.label || "新对话")
        .replace(/\s+/g, " ")
        .trim();
      session.title =
        cleanTitle.length > 26 ? `${cleanTitle.slice(0, 26)}...` : cleanTitle;
    }

    session.messages.push(userMsg, assistantMsg);
    session.updatedAt = Date.now();
    this.sessions.save();
    this.syncState();

    const cfg = getBridgeConfig();
    let contextBlock: string | undefined;
    if (cfg.autoAttachWorkspaceContext) {
      const snapshot = await collectWorkspaceSnapshot();
      const formatted = formatSnapshotForPrompt(snapshot);
      const contextHash = crypto
        .createHash("sha256")
        .update(formatted)
        .digest("hex");

      // 同一会话内：仅在首轮或工作区/Git 现场发生变化时附带，无变化则跳过以省 Token
      if (!session.claudeSessionId || session.lastContextHash !== contextHash) {
        contextBlock = formatted;
        session.lastContextHash = contextHash;
      }

      // 顺手同步最新 Git 状态到界面徽标
      if (snapshot.primaryWorkspace && snapshot.workspaceName) {
        this.gitBadge = {
          workspaceName: snapshot.workspaceName,
          workspacePath: snapshot.primaryWorkspace,
          isGitRepo: Boolean(snapshot.git?.isGitRepo),
          branch: snapshot.git?.branch ?? "",
          changedCount: snapshot.git?.changedCount ?? 0,
        };
        this.lastGitRefreshAt = Date.now();
      }
    }

    const fullPrompt = this.claude.buildPrompt(
      userMsg.text,
      attachments,
      contextBlock
    );

    let lastPushAt = 0;
    const throttledSync = (force = false) => {
      const now = Date.now();
      if (force || now - lastPushAt >= 60) {
        lastPushAt = now;
        this.syncState();
      }
    };

    const handle = this.claude.runTurn({
      cfg,
      prompt: fullPrompt,
      claudeSessionId: session.claudeSessionId,
      assistantMsg,
      callbacks: {
        onSessionId: (sid) => {
          session.claudeSessionId = sid;
        },
        onQuota: (partial) => {
          const prev = this.sessions.getQuota();
          const merged: QuotaSnapshot = {
            ...prev,
            ...partial,
            updatedAt: partial.updatedAt ?? Date.now(),
          };
          this.sessions.saveQuota(merged);
          throttledSync(true);
        },
        onUpdate: () => {
          throttledSync(false);
        },
      },
    });
    this.activeRun = handle;

    await handle.promise;
    if (this.activeRun === handle) {
      this.activeRun = undefined;
    }
    session.updatedAt = Date.now();
    this.sessions.save();
    // 对话结束（Claude 可能修改了本地文件），刷新一次 Git 改动计数
    await this.refreshGitBadge(true);
    throttledSync(true);
  }

  private async openLocalFile(
    rawPath: string,
    startLine?: number
  ): Promise<void> {
    try {
      let targetPath = rawPath;
      if (!path.isAbsolute(targetPath)) {
        const ws = getActiveWorkspacePath();
        if (ws) {
          targetPath = path.join(ws, targetPath);
        }
      }
      const uri = vscode.Uri.file(targetPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });
      if (startLine && startLine > 0) {
        const pos = new vscode.Position(Math.max(0, startLine - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (err) {
      vscode.window.showWarningMessage(`无法打开本地文件：${rawPath} (${err})`);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EC2 Claude</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="header-left">
        <button id="sessionTrigger" class="session-trigger" title="切换历史会话">
          <span class="brand-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L14.4 9.2L22 12L14.4 14.8L12 22L9.6 14.8L2 12L9.6 9.2L12 2Z"/>
            </svg>
          </span>
          <span id="sessionTitleText" class="session-name">新对话</span>
          <span class="chevron">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </span>
        </button>
      </div>
      <div class="header-right">
        <button id="quotaBtn" class="quota-pill" title="查看远程 Claude 额度与上下文占用">
          <span id="quotaText">额度</span>
        </button>
        <button id="statusBtn" class="status-dot-btn" title="点击一键连接或重连">
          <span id="statusDot" class="dot"></span>
          <span id="statusText">连接中</span>
        </button>
        <button id="newChatBtn" class="icon-btn" title="新建对话">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
        <button id="terminalBtn" class="icon-btn" title="打开原生远程 Claude 终端">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
        </button>
        <button id="settingsBtn" class="icon-btn" title="插件设置">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
    </header>

    <div id="historyPopover" class="popover history-popover"></div>
    <div id="quotaPopover" class="popover quota-popover"></div>
    <div id="settingsPopover" class="popover settings-popover"></div>

    <main id="messages" class="messages"></main>

    <div id="permPopover" class="popover menu-popover"></div>
    <div id="modelPopover" class="popover menu-popover model-popover"></div>

    <footer class="composer-outer">
      <div class="composer-card">
        <div id="composerContext" class="composer-context"></div>
        <textarea id="promptInput" placeholder="Ask Claude anything... (Enter 发送，Shift+Enter 换行)"></textarea>
        <div class="composer-bar">
          <div class="composer-bar-left">
            <button id="permBtn" class="pill-btn mode-bypass" title="切换权限模式">
              <span id="permBtnLabel">Bypass permissions</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <button id="modelBtn" class="pill-btn" title="切换远程模型">
              <span id="modelBtnLabel">Default</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          <div class="composer-bar-right">
            <button id="attachBtn" class="icon-btn" title="引用当前文件或选中代码">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="4"/>
                <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
              </svg>
            </button>
            <button id="sendBtn" class="send-circle muted" title="发送 (Enter)">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </footer>
  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
