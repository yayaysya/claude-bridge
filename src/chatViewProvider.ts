import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as vscode from "vscode";
import { BridgeManager } from "./bridgeManager";
import { ClaudeClient, ClaudeRunHandle } from "./claudeClient";
import {
  ChatTheme,
  EffortLevel,
  getActiveWorkspacePath,
  getBridgeConfig,
  getEngineDisplayName,
  normalizeEngineType,
  PermissionMode,
  updateChatTheme,
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
import { ProfileStore } from "./profileStore";
import { SkillManager } from "./skillManager";
import {
  collectGitBadgeInfo,
  collectWorkspaceSnapshot,
  formatSnapshotForPrompt,
  GitBadgeInfo,
} from "./workspaceContext";

/**
 * 侧边栏 Agent 聊天面板（ClaudeBridge · 渡桥）
 * 支持流式回复、多 VPS 秒切、草稿与附件持久化、工作区/Git 感知、实时额度与文件行号点击跳转。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "claudeBridge.chatView";

  private view: vscode.WebviewView | undefined;
  private activeRun: ClaudeRunHandle | undefined;
  private runningSessionId: string | undefined;
  private streamingMessageId: string | undefined;
  private consecutiveFailures = 0;
  private isHandingOff = false;
  /** 当前会话默认只向前端下发最近 N 条消息，上滑到顶部自动按批加载更早记录，避免几百条历史拖慢打开速度 */
  private visibleMessageCount = 20;
  private lastSyncedSessionId = "";
  private gitBadge: GitBadgeInfo | undefined;
  private lastGitRefreshAt = 0;
  private isRefreshingQuota = false;
  private lastAutoQuotaAt = 0;
  private static readonly AUTO_QUOTA_COOLDOWN_MS = 10 * 60 * 1000;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: BridgeManager,
    private readonly claude: ClaudeClient,
    private readonly sessions: SessionStore,
    private readonly terminal: TerminalManager,
    private readonly rulesSync: RulesSyncManager,
    private readonly profiles: ProfileStore,
    private readonly skills: SkillManager
  ) {
    this.bridge.onDidChangeState(() => {
      this.syncState();
    });
    this.profiles.onDidChangeActiveProfile((profile) => {
      this.consecutiveFailures = 0;
      this.sessions.ensureActiveSessionForProfile(profile.id);
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
      this.sessions.switchWorkspace(getActiveWorkspacePath());
      void this.refreshGitBadge(true);
      this.syncState();
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

  /** 后台静默刷新当前活跃 VPS 的 Claude 实时额度（0 Token，不弹终端） */
  public async refreshQuota(): Promise<void> {
    if (this.isRefreshingQuota) {
      return;
    }
    this.isRefreshingQuota = true;
    this.syncState();
    const profileId = this.profiles.getActiveProfile().id;
    try {
      const partial = await this.claude.fetchQuota(getBridgeConfig());
        if (partial) {
          const prev = this.sessions.getQuota(profileId);
          const now = Date.now();
          const merged: QuotaSnapshot = {
            ...prev,
            ...partial,
            updatedAt: partial.updatedAt ?? now,
          };
          this.sessions.saveQuota(merged, profileId);
          this.lastAutoQuotaAt = now;
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
    const activeProfile = this.profiles.getActiveProfile();
    const allProfiles = this.profiles.listProfiles();
    const allQuotas = this.sessions.getAllQuotas();
    const profileNameMap = new Map(allProfiles.map((p) => [p.id, p.name]));

    const activeSession = this.sessions.getActiveSession();
    const orderedSessions = this.sessions.listSessions();
    const continuedSession = orderedSessions.find(
      (s) => s.handoff?.sourceSessionId === activeSession.id
    );
    if (this.lastSyncedSessionId !== activeSession.id) {
      this.lastSyncedSessionId = activeSession.id;
      this.visibleMessageCount = 20;
    }

    const totalMessages = activeSession.messages.length;
    const loadedStartIndex = Math.max(0, totalMessages - this.visibleMessageCount);
    const slicedActiveSession = {
      ...activeSession,
      messages: activeSession.messages.slice(loadedStartIndex),
    };

    const activeProfileQuota = allQuotas[activeProfile.id] ?? null;
    const sessionSummaries = orderedSessions.map((s) => ({
      id: s.id,
      title: s.title,
      profileId: s.profileId || "default",
      profileName: profileNameMap.get(s.profileId || "default") || "",
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      hasRemoteSession: Boolean(s.claudeSessionId),
      hasDraft: Boolean(
        (s.draftText && s.draftText.trim()) ||
          (s.draftAttachments && s.draftAttachments.length > 0)
      ),
    }));

    // 计算当前会话的「最近一次成功回复时间」与「上下文估算大小」，供前端展示缓存冷热预警
    let effectiveLastReplyAt = activeSession.lastReplyAt ?? 0;
    if (!effectiveLastReplyAt) {
      for (let i = activeSession.messages.length - 1; i >= 0; i--) {
        const m = activeSession.messages[i];
        if (m.role === "assistant" && !m.meta?.isError && (m.text || "").trim()) {
          effectiveLastReplyAt = m.timestamp;
          break;
        }
      }
    }
    let effectiveContextTokens = activeSession.lastContextTokens ?? 0;
    if (
      !effectiveContextTokens &&
      activeSession.messages.length >= 20 &&
      activeProfileQuota?.lastContextTokens &&
      sessionSummaries[0]?.id === activeSession.id
    ) {
      effectiveContextTokens = activeProfileQuota.lastContextTokens;
    }

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

    const openTabs = this.sessions.getOpenTabs().map((s) => ({
      id: s.id,
      title: s.title || "新对话",
      isRunning: this.claude.isRunning() && this.runningSessionId === s.id,
      hasDraft: Boolean(
        (s.draftText && s.draftText.trim()) ||
          (s.draftAttachments && s.draftAttachments.length > 0)
      ),
    }));

    const localSkills = this.skills.listLocalSkills().map((sk) => ({
      name: sk.name,
      dirName: sk.dirName,
      description: sk.description,
    }));

    const anyRunning = this.claude.isRunning();
    const isCurrentTabRunning =
      anyRunning && (!this.runningSessionId || this.runningSessionId === activeSession.id);

    const activeEngine = normalizeEngineType(cfg.engine);
    void this.view.webview.postMessage({
      type: "state",
      payload: {
        bridge: this.bridge.getState(),
        engine: activeEngine,
        engineLabel: getEngineDisplayName(activeEngine),
        modelOptions: this.claude.getPresetModels(activeEngine),
        permissionMode: cfg.permissionMode,
        model: cfg.model,
        effort: cfg.effort,
        chatTheme: cfg.chatTheme,
        syncLocalRules: cfg.syncLocalRules,
        activeProfile,
        profiles: allProfiles.map((p) => ({
          id: p.id,
          name: p.name,
          engine: normalizeEngineType(p.engine),
          remotePort: p.remotePort || 7676,
          sshHost: p.sshHost,
          quota5h: allQuotas[p.id]?.fiveHour
            ? Math.round(allQuotas[p.id].fiveHour!.utilization * 100)
            : null,
        })),
        quota: activeProfileQuota,
        isRefreshingQuota: this.isRefreshingQuota,
        isHandingOff: this.isHandingOff,
        sessionCacheInfo: {
          lastReplyAt: effectiveLastReplyAt || null,
          contextTokens: effectiveContextTokens || 0,
          messageCount: activeSession.messages.length,
          hasRemoteSession: Boolean(activeSession.claudeSessionId),
        },
        workspacePath: getActiveWorkspacePath() ?? "",
        gitBadge: this.gitBadge ?? null,
        activeEditor,
        isRunning: isCurrentTabRunning,
        anyRunning,
        runningSessionId: anyRunning ? this.runningSessionId ?? null : null,
        streamingMessageId: isCurrentTabRunning ? this.streamingMessageId ?? null : null,
        attachments: activeSession.draftAttachments ?? [],
        activeSession: slicedActiveSession,
        totalMessageCount: totalMessages,
        loadedStartIndex,
        hasMoreOlder: loadedStartIndex > 0,
        continuedToSession: continuedSession
          ? { id: continuedSession.id, title: continuedSession.title }
          : null,
        openTabs,
        skills: localSkills,
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
        this.maybeAutoRefreshExpiredQuota();
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

      case "connect": {
        const ok = await this.bridge.connect(Boolean(msg.force));
        if (ok) {
          this.consecutiveFailures = 0;
        }
        this.syncState();
        break;
      }

      case "switchProfile": {
        const pid = String(msg.profileId ?? "");
        if (!pid) {
          return;
        }
        if (this.activeRun) {
          this.activeRun.abort();
          this.activeRun = undefined;
        }
        const switched = await this.profiles.switchProfile(pid);
        if (switched) {
          this.sessions.ensureActiveSessionForProfile(switched.id);
          this.syncState();
          await this.bridge.connect(true);
          this.syncState();
        }
        break;
      }

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

      case "openSetupWizard":
        await vscode.commands.executeCommand("claudeBridge.openSetupWizard");
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
        await this.profiles.saveProfile({
          id: this.profiles.getActiveProfile().id,
          model,
        });
        this.syncState();
        break;
      }

      case "setEffort": {
        const effort = String(msg.effort ?? "") as EffortLevel;
        await updateEffort(effort);
        this.syncState();
        break;
      }

      case "setChatTheme": {
        const raw = String(msg.theme ?? "claude");
        const valid: ChatTheme[] = ["claude", "wechat", "feishu", "vscode"];
        const theme: ChatTheme = valid.includes(raw as ChatTheme)
          ? (raw as ChatTheme)
          : "claude";
        await updateChatTheme(theme);
        this.syncState();
        break;
      }

      case "newSession":
        // 多标签模式：新建标签时不打断后台正在回复的旧标签
        this.sessions.createSession(this.profiles.getActiveProfile().id);
        this.visibleMessageCount = 20;
        this.syncState();
        break;

      case "selectSession": {
        const id = String(msg.sessionId ?? "");
        // 切换标签不断开另一个标签正在跑的回复
        this.sessions.setActiveSession(id);
        this.visibleMessageCount = 20;
        this.syncState();
        break;
      }

      case "closeTab": {
        const id = String(msg.sessionId ?? "");
        if (!id) {
          return;
        }
        // 只关闭标签页，底层聊天记录完好保留在历史列表与搜索库里
        this.sessions.closeTab(id, this.profiles.getActiveProfile().id);
        this.visibleMessageCount = 20;
        this.syncState();
        break;
      }

      case "loadMoreMessages": {
        const step = Math.max(10, Math.min(60, Number(msg.step) || 20));
        const active = this.sessions.getActiveSession();
        const prev = this.visibleMessageCount;
        this.visibleMessageCount = Math.min(
          active.messages.length,
          this.visibleMessageCount + step
        );
        if (this.visibleMessageCount !== prev) {
          this.syncState();
        }
        break;
      }

      case "jumpToMessage": {
        const sid = String(msg.sessionId ?? "");
        const mid = String(msg.messageId ?? "");
        if (!sid) {
          return;
        }
        const targetSession = this.sessions.setActiveSession(sid);
        if (!targetSession) {
          return;
        }
        this.lastSyncedSessionId = targetSession.id;
        const msgIdx = mid
          ? targetSession.messages.findIndex((m) => m.id === mid)
          : -1;
        if (msgIdx >= 0) {
          const needed = targetSession.messages.length - msgIdx + 6;
          this.visibleMessageCount = Math.max(20, needed);
        } else {
          this.visibleMessageCount = 20;
        }
        this.syncState();
        break;
      }

      case "deleteSession": {
        const id = String(msg.sessionId ?? "");
        this.sessions.deleteSession(id);
        this.syncState();
        break;
      }

      case "searchHistory": {
        const query = String(msg.query ?? "");
        const allProfiles = this.profiles.listProfiles();
        const profileNameMap = new Map(allProfiles.map((p) => [p.id, p.name]));
        const hits = this.sessions.searchHistory(query, 36).map((h) => ({
          ...h,
          profileName: profileNameMap.get(h.profileId) || "",
        }));
        void this.view?.webview.postMessage({
          type: "searchResults",
          query,
          hits,
        });
        break;
      }

      case "handoffSession": {
        await this.handleHandoffToNewSession();
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

      case "retryMessage": {
        const messageId = String(msg.messageId ?? "").trim();
        if (!messageId) {
          return;
        }
        await this.handleRetryMessage(messageId);
        break;
      }
    }
  }

  private async handleSendPrompt(userText: string): Promise<void> {
    if (this.claude.isRunning() || this.isHandingOff) {
      if (this.claude.isRunning() && this.runningSessionId) {
        const cur = this.sessions.getActiveSession();
        if (this.runningSessionId !== cur.id) {
          vscode.window.showInformationMessage(
            "另一个对话标签正在回复中，等它完成或切过去停止后再发送，避免并发改坏同一文件。"
          );
          void this.view?.webview.postMessage({ type: "restoreDraft", text: userText });
        }
      }
      return;
    }

    let session = this.sessions.getActiveSession();
    const attachments = [...(session.draftAttachments ?? [])];

    // 强保护：若当前是一个缓存已过期（>=58 分钟）的长会话，禁止直接冷启动续发，避免一发白烧 20%~30% 额度
    if (this.isColdLongSession(session)) {
      const choice = await vscode.window.showWarningMessage(
        "这条老对话停了超过 1 小时，直接续聊会多扣很多 5 小时额度。是否先自动压缩记忆、新开对话再发送？",
        { modal: true },
        "压缩记忆并发送（推荐）",
        "直接开空白新对话并发送"
      );

      if (!choice) {
        // 用户取消：把刚输入的文字与附件完好无损还回输入框
        session.draftText = userText;
        session.draftAttachments = attachments;
        this.sessions.save();
        void this.view?.webview.postMessage({ type: "restoreDraft", text: userText });
        this.syncState();
        return;
      }

      if (choice === "压缩记忆并发送（推荐）") {
        // 暂存附件，压缩成功后自动迁入新会话并立刻发出；若失败再把文字还回输入框
        session.draftText = "";
        session.draftAttachments = attachments;
        const ok = await this.handleHandoffToNewSession();
        if (!ok) {
          session.draftText = userText;
          session.draftAttachments = attachments;
          this.sessions.save();
          void this.view?.webview.postMessage({ type: "restoreDraft", text: userText });
          this.syncState();
          return;
        }
        session = this.sessions.getActiveSession();
      } else {
        // 直接开空白新对话并带着刚输入的内容和附件发送
        session.draftText = "";
        session.draftAttachments = [];
        const fresh = this.sessions.createSession(this.profiles.getActiveProfile().id);
        fresh.draftAttachments = attachments;
        this.visibleMessageCount = 20;
        session = fresh;
      }
    }

    const finalAttachments = [...(session.draftAttachments ?? attachments)];
    // 发送即清空已持久化的草稿与附件
    session.draftText = "";
    session.draftAttachments = [];

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: "user",
      text: userText || "请分析附件中的内容",
      attachments: finalAttachments.length > 0 ? finalAttachments : undefined,
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
      const cleanTitle = (userText || finalAttachments[0]?.label || "新对话")
        .replace(/\s+/g, " ")
        .trim();
      session.title =
        cleanTitle.length > 26 ? `${cleanTitle.slice(0, 26)}...` : cleanTitle;
    }

    session.messages.push(userMsg, assistantMsg);
    this.visibleMessageCount += 2;
    session.updatedAt = Date.now();
    this.sessions.save();
    this.syncState();

    await this.executeAssistantTurn(session, userMsg, assistantMsg, 0);
  }

  /** 原地重试某条失败的助手回复（复用同一轮用户提问与附件，不产生重复气泡） */
  private async handleRetryMessage(assistantMsgId: string): Promise<void> {
    if (this.claude.isRunning()) {
      return;
    }

    const session = this.sessions.getActiveSession();
    const idx = session.messages.findIndex(
      (m) => m.id === assistantMsgId && m.role === "assistant"
    );
    if (idx <= 0) {
      return;
    }

    let userMsg: ChatMessage | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") {
        userMsg = session.messages[i];
        break;
      }
    }
    if (!userMsg) {
      return;
    }

    const assistantMsg = session.messages[idx];
    const prevFailCount = Math.max(1, assistantMsg.meta?.failCount ?? 1);

    // 清空上一轮失败内容，原地重新流式输出
    assistantMsg.text = "";
    assistantMsg.thinking = "";
    assistantMsg.tools = [];
    assistantMsg.meta = undefined;
    assistantMsg.timestamp = Date.now();
    session.updatedAt = Date.now();
    this.sessions.save();
    this.syncState();

    await this.executeAssistantTurn(session, userMsg, assistantMsg, prevFailCount);
  }

  /** 执行单轮远程 Claude 调用，并统一维护失败计数与连续 3 次失败的连接刷新提醒 */
  private async executeAssistantTurn(
    session: ReturnType<SessionStore["getActiveSession"]>,
    userMsg: ChatMessage,
    assistantMsg: ChatMessage,
    prevFailCount: number
  ): Promise<void> {
    const bridgeState = this.bridge.getState();
    if (bridgeState.status !== "connected") {
      const ok = await this.bridge.connect(false);
      if (!ok) {
        this.consecutiveFailures += 1;
        const failCount = Math.max(prevFailCount + 1, this.consecutiveFailures);
        assistantMsg.text = `执行失败：本地桥接未连接成功（${this.bridge.getState().detail || "请检查网络或代理设置"}）`;
        assistantMsg.meta = { isError: true, failCount };
        session.updatedAt = Date.now();
        this.sessions.save();
        this.syncState();
        this.notifyIfRepeatedFailures(failCount);
        return;
      }
    }

    const activeProfile = this.profiles.getActiveProfile();
    // 防止历史会话跨 VPS 复用无效的 --resume session_id
    const sessionOwner = session.profileId || "default";
    const canResumeRemote =
      Boolean(session.claudeSessionId) && sessionOwner === activeProfile.id;
    if (!session.claudeSessionId && session.messages.length <= 2) {
      session.profileId = activeProfile.id;
    }

    const attachments = userMsg.attachments ?? [];
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
      this.mergeHandoffIntoContext(session, contextBlock)
    );

    let lastPushAt = 0;
    const throttledSync = (force = false) => {
      const now = Date.now();
      if (force || now - lastPushAt >= 60) {
        lastPushAt = now;
        this.syncState();
      }
    };

    this.runningSessionId = session.id;
    this.streamingMessageId = assistantMsg.id;
    let sawLiveFiveHourQuota = false;
    const handle = this.claude.runTurn({
      cfg,
      prompt: fullPrompt,
      claudeSessionId: canResumeRemote ? session.claudeSessionId : undefined,
      assistantMsg,
      callbacks: {
        onSessionId: (sid) => {
          session.claudeSessionId = sid;
          session.profileId = activeProfile.id;
        },
        onQuota: (partial) => {
          if (partial.fiveHour) {
            sawLiveFiveHourQuota = true;
            this.lastAutoQuotaAt = Date.now();
          }
          if (typeof partial.lastContextTokens === "number" && partial.lastContextTokens > 0) {
            session.lastContextTokens = partial.lastContextTokens;
          }
          const prev = this.sessions.getQuota(activeProfile.id);
          const merged: QuotaSnapshot = {
            ...prev,
            ...partial,
            updatedAt: partial.updatedAt ?? Date.now(),
          };
          this.sessions.saveQuota(merged, activeProfile.id);
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
      this.runningSessionId = undefined;
    }
    if (this.streamingMessageId === assistantMsg.id) {
      this.streamingMessageId = undefined;
    }

    if (assistantMsg.meta?.isError) {
      this.consecutiveFailures += 1;
      const failCount = Math.max(prevFailCount + 1, this.consecutiveFailures);
      assistantMsg.meta = {
        ...assistantMsg.meta,
        isError: true,
        failCount,
      };
      this.notifyIfRepeatedFailures(failCount);
    } else if (!assistantMsg.text.includes("_(已手动停止)_")) {
      this.consecutiveFailures = 0;
      session.lastReplyAt = Date.now();
      if (session.handoff && !session.handoff.injected) {
        session.handoff.injected = true;
      }
      if (assistantMsg.meta?.failCount) {
        assistantMsg.meta = { ...assistantMsg.meta, failCount: undefined };
      }
    }

    session.updatedAt = Date.now();
    this.sessions.save();
    await this.refreshGitBadge(true);
    throttledSync(true);

    // 若本轮流式回复未携带实时 5h 百分比，按 10 分钟冷却在后台静默查一次 0-Token /usage 自动更新
    if (
      !sawLiveFiveHourQuota &&
      !assistantMsg.text.includes("_(已手动停止)_")
    ) {
      this.maybeAutoRefreshQuotaAfterTurn();
    }
  }

  /** 连续失败达到 3 次时提醒用户刷新连接状况，并提供一键重连入口 */
  private notifyIfRepeatedFailures(failCount: number): void {
    if (failCount < 3) {
      return;
    }
    void vscode.window
      .showWarningMessage(
        `ClaudeBridge 已连续失败 ${failCount} 次，可能是网络波动或代理变动导致连接异常，建议刷新连接状况。`,
        "刷新连接状况"
      )
      .then(async (choice) => {
        if (choice === "刷新连接状况") {
          const ok = await this.bridge.connect(true);
          if (ok) {
            this.consecutiveFailures = 0;
          }
          this.syncState();
        }
      });
  }

  /** 将新会话尚未注入的交接摘要拼接到首轮上下文前缀中 */
  private mergeHandoffIntoContext(
    session: ReturnType<SessionStore["getActiveSession"]>,
    contextBlock?: string
  ): string | undefined {
    if (!session.handoff || session.handoff.injected || session.claudeSessionId) {
      return contextBlock;
    }
    const handoffHeader = [
      `[Handoff context from archived session "${session.handoff.sourceSessionTitle}"]`,
      session.handoff.summary,
      "[End of handoff context — continue naturally based on the user's new message below]",
    ].join("\n\n");
    return contextBlock ? `${handoffHeader}\n\n${contextBlock}` : handoffHeader;
  }

  /**
   * 压缩记忆并开新对话（由远程 Claude 总结；热缓存复用 1 折缓存，冷缓存自动剥离冗余由轻模型独立总结，绝不触发冷缓存大额扣费）
   */
  private async handleHandoffToNewSession(): Promise<boolean> {
    if (this.claude.isRunning() || this.isHandingOff) {
      return false;
    }

    const oldSession = this.sessions.getActiveSession();
    if (oldSession.messages.length === 0) {
      vscode.window.showInformationMessage("当前对话还没有可压缩的记录，直接开始提问即可。");
      return false;
    }

    const activeProfile = this.profiles.getActiveProfile();

    // 仅当 5h 利用率确实 >= 100% 且重置时间尚未到达时才提前拦截，避免被旧的 status 字段误杀
    const quota = this.sessions.getQuota(activeProfile.id);
    const resetSec = quota?.fiveHour?.resetsAt ?? 0;
    const fiveHourUtil = quota?.fiveHour?.utilization ?? 0;
    const stillLimited =
      Boolean(quota?.fiveHour) &&
      fiveHourUtil >= 1 &&
      resetSec > 0 &&
      resetSec * 1000 > Date.now();
    if (stillLimited) {
      vscode.window.showWarningMessage(
        "当前 5 小时额度已用完，暂无法由 Claude 压缩记忆。你可以等额度重置后再压缩，或先点右上角「+」开空白新对话。"
      );
      return false;
    }

    if (this.bridge.getState().status !== "connected") {
      const ok = await this.bridge.connect(false);
      if (!ok) {
        vscode.window.showWarningMessage(
          "当前未连接到远程服务器，暂无法压缩记忆，请先刷新连接状况。"
        );
        return false;
      }
    }

    const lastReplyAt = this.resolveSessionLastReplyAt(oldSession);
    const idleMinutes = lastReplyAt
      ? (Date.now() - lastReplyAt) / 60_000
      : 999;
    const canWarmResume =
      idleMinutes < 55 &&
      Boolean(oldSession.claudeSessionId) &&
      (oldSession.profileId || "default") === activeProfile.id;

    this.isHandingOff = true;
    this.syncState();

    try {
      const res = canWarmResume && oldSession.claudeSessionId
        ? await this.claude.generateHandoffSummary(getBridgeConfig(), {
            mode: "warm-resume",
            claudeSessionId: oldSession.claudeSessionId,
          })
        : await this.claude.generateHandoffSummary(getBridgeConfig(), {
            mode: "cold-stateless",
            transcript: this.buildCleanTranscriptForCompression(oldSession),
          });

      if (!res.ok || !res.summary) {
        vscode.window.showWarningMessage(
          res.reason || "压缩记忆失败，请稍后重试或直接开空白新对话。"
        );
        return false;
      }

      const oldTitle = (oldSession.title || "上一轮对话").replace(/^接续：/, "").trim();
      const newSession = this.sessions.createSession(activeProfile.id);
      const nextTitle = `接续：${oldTitle}`;
      newSession.title =
        nextTitle.length > 26 ? `${nextTitle.slice(0, 26)}...` : nextTitle;
      newSession.handoff = {
        sourceSessionId: oldSession.id,
        sourceSessionTitle: oldSession.title || "上一轮对话",
        summary: res.summary,
        createdAt: Date.now(),
        injected: false,
      };
      // 把老会话未发出的草稿一起带进新会话
      if (oldSession.draftText && oldSession.draftText.trim()) {
        newSession.draftText = oldSession.draftText;
        oldSession.draftText = "";
      }
      if (oldSession.draftAttachments && oldSession.draftAttachments.length > 0) {
        newSession.draftAttachments = [...oldSession.draftAttachments];
        oldSession.draftAttachments = [];
      }
      this.visibleMessageCount = 20;
      this.sessions.save();
      this.maybeAutoRefreshQuotaAfterTurn();
      return true;
    } finally {
      this.isHandingOff = false;
      this.syncState();
    }
  }

  /** 判断当前会话是否处于「缓存已失效且上下文较长」的高危扣费状态 */
  private isColdLongSession(
    session: ReturnType<SessionStore["getActiveSession"]>
  ): boolean {
    if (!session.claudeSessionId || session.messages.length < 10) {
      return false;
    }
    const lastReplyAt = this.resolveSessionLastReplyAt(session);
    if (!lastReplyAt) {
      return false;
    }
    const idleMinutes = (Date.now() - lastReplyAt) / 60_000;
    if (idleMinutes < 58) {
      return false;
    }
    const activeProfile = this.profiles.getActiveProfile();
    const quota = this.sessions.getQuota(activeProfile.id);
    const tokens =
      session.lastContextTokens ||
      (session.messages.length >= 20 ? quota?.lastContextTokens ?? 0 : 0);
    return tokens >= 100_000 || session.messages.length >= 20;
  }

  private resolveSessionLastReplyAt(
    session: ReturnType<SessionStore["getActiveSession"]>
  ): number {
    if (session.lastReplyAt) {
      return session.lastReplyAt;
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "assistant" && !m.meta?.isError && (m.text || "").trim()) {
        return m.timestamp;
      }
    }
    return 0;
  }

  /**
   * 为冷缓存脱壳压缩提取分级保真纯文本摘录：
   * - 更早轮次（最多 12 轮）高度浓缩作为全局背景；
   * - 最近 3 轮对话保留高保真原文（单轮给足预算），确保“做了什么 / 还差什么 / 还没定论什么”零失真。
   */
  private buildCleanTranscriptForCompression(
    session: ReturnType<SessionStore["getActiveSession"]>
  ): string {
    const touchedFiles = new Set<string>();
    const cleanTurns: Array<{ user: string; assistant: string }> = [];
    let pendingUser = "";

    for (const m of session.messages) {
      if (m.attachments) {
        for (const a of m.attachments) {
          if (a.filePath) {
            touchedFiles.add(a.filePath);
          }
        }
      }
      if (m.tools) {
        for (const t of m.tools) {
          if (t.filePath) {
            touchedFiles.add(t.filePath);
          }
        }
      }
      const txt = (m.text || "").trim();
      if (!txt) {
        continue;
      }
      if (m.role === "user") {
        pendingUser = txt;
      } else if (
        m.role === "assistant" &&
        !m.meta?.isError &&
        !/^执行失败：|^启动远程 SSH 失败：|hit your 5-hour limit/i.test(txt)
      ) {
        if (pendingUser) {
          cleanTurns.push({ user: pendingUser, assistant: txt });
          pendingUser = "";
        }
      }
    }

    const parts: string[] = [];
    if (session.handoff?.summary) {
      parts.push(`[Earlier summary]\n${session.handoff.summary.slice(0, 1500)}`);
    }
    const files = Array.from(touchedFiles).slice(-16);
    if (files.length > 0) {
      parts.push(`[Touched files]\n${files.join("\n")}`);
    }

    // 1. 更早轮次（倒数第 4 ~ 倒数第 15 轮）：精简保留背景脉络
    const recent3Count = Math.min(3, cleanTurns.length);
    const earlierTurns = cleanTurns.slice(
      Math.max(0, cleanTurns.length - 15),
      cleanTurns.length - recent3Count
    );
    if (earlierTurns.length > 0) {
      const earlierBlocks: string[] = [];
      let earlierBudget = 5_500;
      for (let i = earlierTurns.length - 1; i >= 0; i--) {
        const q = earlierTurns[i].user.slice(0, 220);
        const a = earlierTurns[i].assistant.slice(0, 420);
        const block = `User: ${q}\nAssistant: ${a}`;
        if (earlierBudget - block.length < 0 && earlierBlocks.length >= 2) {
          break;
        }
        earlierBlocks.unshift(block);
        earlierBudget -= block.length;
      }
      if (earlierBlocks.length > 0) {
        parts.push(`[Earlier context (condensed)]\n${earlierBlocks.join("\n\n")}`);
      }
    }

    // 2. 最近 3 轮对话：高保真保留（重点对齐用户意图、已完成改动与悬而未决的问题）
    const latestThree = cleanTurns.slice(-recent3Count);
    if (latestThree.length > 0) {
      const latestBlocks = latestThree.map((turn, idx) => {
        const q = turn.user.slice(0, 900);
        const a = turn.assistant.slice(0, 2200);
        return `### Recent Turn -${latestThree.length - idx}\nUser: ${q}\nAssistant: ${a}`;
      });
      parts.push(`[Latest 3 turns (high fidelity)]\n${latestBlocks.join("\n\n")}`);
    }

    // 若最后一条用户发言尚未收到成功回复，也保留为“用户最新刚提的诉求”
    if (pendingUser) {
      parts.push(`[Latest pending user request]\nUser: ${pendingUser.slice(0, 600)}`);
    }

    return parts.join("\n\n");
  }

  /** 对话或压缩记忆完成后按 10 分钟冷却静默查一次额度，避免高频请求 /usage；手动刷新不受限制 */
  private maybeAutoRefreshQuotaAfterTurn(): void {
    if (this.isRefreshingQuota || this.bridge.getState().status !== "connected") {
      return;
    }
    const now = Date.now();
    if (
      this.lastAutoQuotaAt > 0 &&
      now - this.lastAutoQuotaAt < ChatViewProvider.AUTO_QUOTA_COOLDOWN_MS
    ) {
      return;
    }
    this.lastAutoQuotaAt = now;
    void this.refreshQuota();
  }

  /** 当本地缓存的 5 小时重置时间已过时，后台静默刷一次额度让界面自动归零 */
  private maybeAutoRefreshExpiredQuota(): void {
    const now = Date.now();
    if (now - this.lastAutoQuotaAt < 60_000) {
      return;
    }
    if (this.bridge.getState().status !== "connected") {
      return;
    }
    const activeProfile = this.profiles.getActiveProfile();
    const quota = this.sessions.getQuota(activeProfile.id);
    const resetSec = quota?.fiveHour?.resetsAt ?? 0;
    if (
      quota?.fiveHour &&
      quota.fiveHour.utilization > 0 &&
      resetSec > 0 &&
      resetSec * 1000 <= now
    ) {
      this.lastAutoQuotaAt = now;
      void this.refreshQuota();
    }
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
            <svg width="16" height="13" viewBox="0 0 18 14" fill="currentColor" shape-rendering="crispEdges">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M2 1H16V4H18V7H16V9H15V13H13V9H12V13H10V9H8V13H6V9H5V13H3V9H2V7H0V4H2V1ZM5 4V6H7V4H5ZM11 4V6H13V4H11Z"/>
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
        <button id="searchHistoryBtn" class="icon-btn" title="搜索所有历史聊天记录">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
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

    <div id="tabStrip" class="tab-strip" style="display:none;"></div>

    <div id="historyPopover" class="popover history-popover">
      <div class="history-search-wrap">
        <svg class="history-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="7"/>
          <line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input id="historySearchInput" class="history-search-input" type="text" placeholder="搜历史记录，如 1444、文件名..." autocomplete="off" />
        <button id="historySearchClear" class="history-search-clear" title="清空搜索" style="display:none;">×</button>
      </div>
      <div id="historyListBody" class="history-list-body"></div>
    </div>
    <div id="quotaPopover" class="popover quota-popover"></div>
    <div id="serverPopover" class="popover settings-popover"></div>
    <div id="settingsPopover" class="popover settings-popover"></div>

    <main id="messages" class="messages"></main>

    <div id="permPopover" class="popover menu-popover"></div>
    <div id="modelPopover" class="popover menu-popover model-popover"></div>
    <div id="slashPopover" class="popover slash-popover"></div>

    <footer class="composer-outer">
      <div id="cacheAlertBar" class="cache-alert-bar" style="display:none;"></div>
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
            <button id="handoffBtn" class="icon-btn" title="压缩记忆并开新对话（由 Claude 总结当前进度，省额度）" style="display:none;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14"/>
                <path d="M13 5l7 7-7 7"/>
                <path d="M5 5v14"/>
              </svg>
            </button>
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
