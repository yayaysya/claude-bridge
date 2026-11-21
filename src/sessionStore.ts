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

/** 单个会话（与远程 Claude session_id 绑定，支持重启后继续对话） */
export interface ChatSession {
  id: string;
  title: string;
  claudeSessionId?: string;
  /** 最近一次已注入给该会话的工作区快照指纹，用于无变化时去重 */
  lastContextHash?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** 单个额度时间窗口状态（来自 Claude Code 官方 rate_limit_event） */
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

const STORAGE_KEY = "ec2Claude.sessions.v1";
const ACTIVE_KEY = "ec2Claude.activeSessionId.v1";
const QUOTA_KEY = "ec2Claude.quota.v1";
const MAX_SESSIONS = 40;

/** 轻量级本地会话持久化管理器 */
export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId: string | undefined;

  constructor(private readonly state: vscode.Memento) {
    this.sessions = this.state.get<ChatSession[]>(STORAGE_KEY, []);
    this.activeSessionId = this.state.get<string>(ACTIVE_KEY);
    if (this.sessions.length === 0) {
      this.createSession();
    } else if (
      !this.activeSessionId ||
      !this.sessions.some((s) => s.id === this.activeSessionId)
    ) {
      this.activeSessionId = this.sessions[0].id;
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

  public setActiveSession(sessionId: string): ChatSession | undefined {
    const found = this.sessions.find((s) => s.id === sessionId);
    if (!found) {
      return undefined;
    }
    this.activeSessionId = found.id;
    void this.persist();
    return found;
  }

  public createSession(): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      id: `sess_${now}_${Math.random().toString(36).slice(2, 8)}`,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.unshift(session);
    if (this.sessions.length > MAX_SESSIONS) {
      this.sessions = this.sessions.slice(0, MAX_SESSIONS);
    }
    this.activeSessionId = session.id;
    void this.persist();
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
    void this.persist();
    return this.getActiveSession();
  }

  public save(): void {
    void this.persist();
  }

  public getQuota(): QuotaSnapshot | undefined {
    return this.state.get<QuotaSnapshot>(QUOTA_KEY);
  }

  public saveQuota(quota: QuotaSnapshot): void {
    void this.state.update(QUOTA_KEY, quota);
  }

  private async persist(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.sessions);
    await this.state.update(ACTIVE_KEY, this.activeSessionId);
  }
}
