import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** 附加到对话的本地上下文（文件或代码选区） */
export interface ContextAttachment {
  id: string;
  type: "file" | "selection";
  filePath: string;
  label: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}

/** 单次工具调用记录（用于前端折叠卡片展示） */
export interface ToolCallRecord {
  id: string;
  name: string;
  displayName: string;
  inputSummary: string;
  inputRaw: string;
  output?: string;
  status: "running" | "done" | "error";
  filePath?: string;
}

/** 单条聊天消息 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: ToolCallRecord[];
  attachments?: ContextAttachment[];
  meta?: {
    costUsd?: number;
    durationMs?: number;
    model?: string;
    isError?: boolean;
  };
  timestamp: number;
}

/** 单个会话（与远程 Claude session_id 绑定，含草稿持久化，支持重载窗口与切换会话不丢失） */
export interface ChatSession {
  id: string;
  title: string;
  claudeSessionId?: string;
  /** 最近一次已注入给该会话的工作区快照指纹，用于无变化时去重 */
  lastContextHash?: string;
  /** 输入框中未发送的草稿文本（持久化，防重载窗口丢失） */
  draftText?: string;
  /** 输入框中已挂起但未发送的附件芯片 */
  draftAttachments?: ContextAttachment[];
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** 单个额度时间窗口状态（来自 Claude Code 官方 rate_limit_event / usage_report） */
export interface RateLimitWindow {
  utilization: number;
  resetsAt?: number;
  status?: string;
}

/** 持久化的最近一次官方额度与上下文快照 */
export interface QuotaSnapshot {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
  status?: string;
  isUsingOverage?: boolean;
  updatedAt: number;
  lastContextTokens?: number;
  lastContextWindow?: number;
  lastModel?: string;
}

interface PersistedStoreFile {
  version: number;
  activeSessionId?: string;
  sessions: ChatSession[];
  quota?: QuotaSnapshot;
}

const DATA_DIR = path.join(os.homedir(), ".claude-bridge");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const STORAGE_KEY = "claudeBridge.sessions.v1";
const LEGACY_STORAGE_KEY = "ec2Claude.sessions.v1";
const ACTIVE_KEY = "claudeBridge.activeSessionId.v1";
const LEGACY_ACTIVE_KEY = "ec2Claude.activeSessionId.v1";
const QUOTA_KEY = "claudeBridge.quota.v1";
const LEGACY_QUOTA_KEY = "ec2Claude.quota.v1";
const MAX_SESSIONS = 40;

/**
 * 本地会话与草稿持久化管理器
 * 优先落盘到独立文件 ~/.claude-bridge/sessions.json（原子写入），
 * 避免因插件改名、更换 publisher 或卸载重装导致 VS Code globalState 隔离丢历史。
 */
export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId: string | undefined;
  private quota: QuotaSnapshot | undefined;

  constructor(private readonly state: vscode.Memento) {
    const fileData = this.loadFromFile();
    if (fileData && fileData.sessions.length > 0) {
      this.sessions = fileData.sessions;
      this.activeSessionId = fileData.activeSessionId;
      this.quota = fileData.quota;
    } else {
      // 首次从旧 globalState 自动迁移到独立文件
      const current = this.state.get<ChatSession[]>(STORAGE_KEY);
      const legacy = this.state.get<ChatSession[]>(LEGACY_STORAGE_KEY);
      this.sessions =
        current && current.length > 0 ? current : legacy ?? [];
      this.activeSessionId =
        this.state.get<string>(ACTIVE_KEY) ??
        this.state.get<string>(LEGACY_ACTIVE_KEY);
      this.quota =
        this.state.get<QuotaSnapshot>(QUOTA_KEY) ??
        this.state.get<QuotaSnapshot>(LEGACY_QUOTA_KEY);
    }

    if (this.sessions.length === 0) {
      this.createSession();
    } else if (
      !this.activeSessionId ||
      !this.sessions.some((s) => s.id === this.activeSessionId)
    ) {
      this.activeSessionId = this.sessions[0].id;
      this.persist();
    } else if (!fileData) {
      this.persist();
    }
  }

  public listSessions(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getActiveSession(): ChatSession {
    const found = this.sessions.find((s) => s.id === this.activeSessionId);
    if (found) {
      return found;
    }
    return this.createSession();
  }

  public getSessionById(sessionId: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === sessionId);
  }

  public setActiveSession(sessionId: string): ChatSession | undefined {
    const found = this.sessions.find((s) => s.id === sessionId);
    if (!found) {
      return undefined;
    }
    this.activeSessionId = found.id;
    this.persist();
    return found;
  }

  public createSession(): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: `sess_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: "新对话",
      draftText: "",
      draftAttachments: [],
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.unshift(session);
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    }
    this.activeSessionId = session.id;
    this.persist();
    return session;
  }

  public deleteSession(sessionId: string): ChatSession {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    if (this.sessions.length === 0) {
      return this.createSession();
    }
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0].id;
    }
    this.persist();
    return this.getActiveSession();
  }

  /** 更新指定会话的草稿文本并持久化 */
  public updateDraftText(sessionId: string, text: string): void {
    const target = this.sessions.find((s) => s.id === sessionId);
    if (!target) {
      return;
    }
    if ((target.draftText ?? "") === text) {
      return;
    }
    target.draftText = text;
    this.persist();
  }

  public save(): void {
    this.persist();
  }

  public getQuota(): QuotaSnapshot | undefined {
    return this.quota;
  }

  public saveQuota(quota: QuotaSnapshot): void {
    this.quota = quota;
    this.persist();
  }

  private loadFromFile(): PersistedStoreFile | undefined {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) {
        return undefined;
      }
      const raw = fs.readFileSync(SESSIONS_FILE, "utf8");
      const parsed = JSON.parse(raw) as PersistedStoreFile;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    const payload: PersistedStoreFile = {
      version: 1,
      activeSessionId: this.activeSessionId,
      sessions: this.sessions,
      quota: this.quota,
    };

    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmpPath = `${SESSIONS_FILE}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmpPath, SESSIONS_FILE);
    } catch {
      // 文件写盘异常时降级写入 globalState
    }

    void this.state.update(STORAGE_KEY, this.sessions);
    void this.state.update(ACTIVE_KEY, this.activeSessionId);
    if (this.quota) {
      void this.state.update(QUOTA_KEY, this.quota);
    }
  }
}
