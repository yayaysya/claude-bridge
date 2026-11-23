import * as fs from "fs";
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
 * 侧边栏 Agent 聊天面板（ClaudeBridge · 渡桥）
 * 支持流式回复、草稿与附件持久化、工作区/Git 感知、实时额度与文件行号点击跳转。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claudeBridge.chatView";

  private view: vscode.WebviewView | undefined;
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
    vscode.window.onDidChangeActiveTextEditor(() => {
      this.syncState();
    });
    vscode.window.onDidChangeTextEditorSelection(() => {
      this.syncState();
    });
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

  /** 将编辑器当前文件或选中代码添加到当前会话的草稿附件，并持久化 */
  public async addContextAttachment(att: ContextAttachment): Promise<void> {
    const session = this.sessions.getActiveSession();
    const list = session.draftAttachments ?? [];
    const exists = list.some(
      (item) =>
        item.type === att.type &&
        item.filePath === att.filePath &&
        item.startLine === att.startLine &&
        item.endLine === att.endLine
    );
    if (!exists) {
      list.push(att);
      session.draftAttachments = list;
      this.sessions.save();
    }
    await vscode.commands.executeCommand("claudeBridge.chatView.focus");
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
      hasDraft: Boolean(
        (s.draftText && s.draftText.trim()) ||
          (s.draftAttachments && s.draftAttachments.length > 0)
      ),
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
        attachments: activeSession.draftAttachments ?? [],
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

      case "saveDraft": {
        const sid =
          typeof msg.sessionId === "string" && msg.sessionId
            ? msg.sessionId
            : this.sessions.getActiveSession().id;
        const text = typeof msg.text === "string" ? msg.text : "";
        this.sessions.updateDraftText(sid, text);
        break;
      }

      case "openLocalRules":
        await vscode.commands.executeCommand("claudeBridge.openLocalRules");
        break;

      case "viewRemoteMemories":
        await vscode.commands.executeCommand("claudeBridge.viewRemoteMemories");
        break;

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

      case "refreshQuota":
        await this.refreshQuota();
        break;

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
        await vscode.commands.executeCommand("claudeBridge.openSettings");
        break;

      case "openLogFile":
        await vscode.commands.executeCommand("claudeBridge.openLogFile");
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
        await vscode.commands.executeCommand("claudeBridge.addCurrentFile");
        break;

      case "addSelection":
        await vscode.commands.executeCommand("claudeBridge.sendSelection");
        break;

      case "removeAttachment": {
        const attId = String(msg.id ?? "");
        const session = this.sessions.getActiveSession();
        session.draftAttachments = (session.draftAttachments ?? []).filter(
          (a) => a.id !== attId
        );
        this.sessions.save();
        this.syncState();
        break;
      }

      case "openFile": {
        const filePath = String(msg.filePath ?? "");
        const startLine =
          typeof msg.startLine === "number" ? msg.startLine : undefined;
        const endLine =
          typeof msg.endLine === "number" ? msg.endLine : undefined;
        if (filePath) {
          await this.openLocalFile(filePath, startLine, endLine);
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
        const session = this.sessions.getActiveSession();
        const hasAtt = (session.draftAttachments ?? []).length > 0;
        if (!text && !hasAtt) {
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
          "ClaudeBridge 未连接成功，请先点击状态栏或设置中心检查连接状态。"
        );
        return;
      }
    }

    const session = this.sessions.getActiveSession();
    const attachments = [...(session.draftAttachments ?? [])];
    // 发送即清空已持久化的草稿与附件
    session.draftText = "";
    session.draftAttachments = [];

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
    await this.refreshGitBadge(true);
    throttledSync(true);
  }

  private async openLocalFile(
    rawPath: string,
    startLine?: number,
    endLine?: number
  ): Promise<void> {
    try {
      const targetUri = await this.resolveLocalFileUri(rawPath);
      if (!targetUri) {
        vscode.window.showWarningMessage(`在当前工作区中未找到文件：${rawPath}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(targetUri);
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });

      if (startLine && startLine > 0 && doc.lineCount > 0) {
        const clampedStart = Math.min(Math.max(1, startLine), doc.lineCount) - 1;
        const clampedEnd =
          endLine && endLine >= startLine
            ? Math.min(endLine, doc.lineCount) - 1
            : clampedStart;

        const startLineObj = doc.lineAt(clampedStart);
        const endLineObj = doc.lineAt(clampedEnd);
        const startPos = new vscode.Position(
          clampedStart,
          startLineObj.firstNonWhitespaceCharacterIndex
        );
        const endPos = endLineObj.range.end;

        editor.selection = new vscode.Selection(startPos, endPos);
        editor.revealRange(
          new vscode.Range(startPos, endPos),
          vscode.TextEditorRevealType.InCenter
        );
      }
    } catch (err) {
      vscode.window.showWarningMessage(`无法打开本地文件：${rawPath} (${err})`);
    }
  }

  /** 智能解析绝对路径、相对路径或短文件名（如 main.c）为真实本地文件 URI */
  private async resolveLocalFileUri(
    rawInput: string
  ): Promise<vscode.Uri | undefined> {
    let cleaned = rawInput.trim();
    if (cleaned.startsWith("file://")) {
      try {
        cleaned = vscode.Uri.parse(cleaned).fsPath;
      } catch {
        cleaned = cleaned.replace(/^file:\/\//, "");
      }
    }
    cleaned = cleaned.replace(/\\/g, "/");

    if (path.isAbsolute(cleaned)) {
      if (this.isExistingFile(cleaned)) {
        return vscode.Uri.file(cleaned);
      }
      return undefined;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const candidate = path.join(folder.uri.fsPath, cleaned);
      if (this.isExistingFile(candidate)) {
        return vscode.Uri.file(candidate);
      }
    }

    const normalizedGlob = cleaned.replace(/^\.?\//, "");
    let matches = await vscode.workspace.findFiles(
      `**/${normalizedGlob}`,
      "**/{node_modules,.git,build,dist}/**",
      15
    );
    if (matches.length === 0) {
      matches = await vscode.workspace.findFiles(
        `**/${normalizedGlob}`,
        "**/.git/**",
        15
      );
    }

    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length === 1) {
      return matches[0];
    }

    const openPaths = new Set<string>();
    const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activePath) {
      const exactActive = matches.find((u) => u.fsPath === activePath);
      if (exactActive) {
        return exactActive;
      }
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri && input.uri.scheme === "file") {
          openPaths.add(input.uri.fsPath);
        }
      }
    }
    const openMatches = matches.filter((u) => openPaths.has(u.fsPath));
    if (openMatches.length === 1) {
      return openMatches[0];
    }

    const wsRoot = getActiveWorkspacePath();
    const picked = await vscode.window.showQuickPick(
      matches.map((uri) => ({
        label: path.basename(uri.fsPath),
        description: wsRoot
          ? path.relative(wsRoot, uri.fsPath)
          : uri.fsPath,
        uri,
      })),
      { placeHolder: `找到多个匹配 ${rawInput} 的文件，请选择要跳转的文件` }
    );
    return picked?.uri;
  }

  private isExistingFile(filePath: string): boolean {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch {
      return false;
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
  <title>ClaudeBridge · 渡桥</title>
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
        <button id="settingsBtn" class="icon-btn" title="规则、记忆与设置中心">
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
            <button id="modelBtn" class="pill-btn" title="切换远程模型与思考强度">
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
