import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getActiveWorkspacePath } from "./config";

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

interface PersistedWorkspaceFile {
  version: number;
  workspacePath: string;
  activeSessionId?: string;
  sessions: ChatSession[];
}

interface LegacySessionsFile {
  version?: number;
  activeSessionId?: string;
  sessions?: ChatSession[];
  quota?: QuotaSnapshot;
}

const DATA_DIR = path.join(os.homedir(), ".claude-bridge");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
const QUOTA_FILE = path.join(DATA_DIR, "quota.json");
const LEGACY_SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const QUOTA_KEY = "claudeBridge.quota.v1";
const LEGACY_QUOTA_KEY = "ec2Claude.quota.v1";
const MAX_SESSIONS = 40;

/** 根据工作区绝对路径计算稳定的隔离文件名（可读项目名 + 8位哈希防重名） */
export function resolveWorkspaceSessionFile(workspacePath?: string): {
  normalizedWorkspace: string;
  filePath: string;
} {
  const cleaned = (workspacePath ?? "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) {
    return {
      normalizedWorkspace: "",
      filePath: path.join(WORKSPACES_DIR, "no-workspace.json"),
    };
  }
  const baseName = path.basename(cleaned).replace(/[^a-zA-Z0-9._-]/g, "_") || "project";
  const hash = crypto.createHash("sha256").update(cleaned).digest("hex").slice(0, 8);
  return {
    normalizedWorkspace: cleaned,
    filePath: path.join(WORKSPACES_DIR, `${baseName}_${hash}.json`),
  };
}

/**
 * 按工作区隔离的会话与草稿持久化管理器
 * - 每个项目目录独立落盘到 ~/.claude-bridge/workspaces/<project>_<hash>.json，
 *   多窗口并发开发彻底不串台、不互相覆盖；
 * - 额度单独存放在 ~/.claude-bridge/quota.json，所有窗口实时共享同一账号额度。
 */
export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionId: string | undefined;
  private workspacePath = "";
  private sessionFilePath = "";
  private quota: QuotaSnapshot | undefined;

  constructor(private readonly state: vscode.Memento) {
    this.quota = this.loadQuotaFromFile();
    this.switchWorkspace(getActiveWorkspacePath());
  }

  /** 切换或初始化当前工作区对应的独立会话文件 */
  public switchWorkspace(workspacePath?: string): void {
    const resolved = resolveWorkspaceSessionFile(workspacePath);
    if (
      this.sessionFilePath === resolved.filePath &&
      this.sessions.length > 0
    ) {
      return;
    }

    this.workspacePath = resolved.normalizedWorkspace;
    this.sessionFilePath = resolved.filePath;
    this.sessions = [];
    this.activeSessionId = undefined;

    const fileData = this.loadWorkspaceFile(this.sessionFilePath);
    if (fileData && fileData.sessions.length > 0) {
      this.sessions = fileData.sessions;
      this.activeSessionId = fileData.activeSessionId;
    } else {
      // 仅当旧版全局 sessions.json 存在且内容归属当前项目时认领迁移，绝不污染其他新项目
      const migrated = this.tryMigrateLegacyFileForWorkspace(this.workspacePath);
      if (migrated && migrated.sessions.length > 0) {
        this.sessions = migrated.sessions;
        this.activeSessionId = migrated.activeSessionId;
        this.persistSessions();
      }
    }

    if (this.sessions.length === 0) {
      this.createSession();
    } else if (
      !this.activeSessionId ||
      !this.sessions.some((s) => s.id === this.activeSessionId)
    ) {
      this.activeSessionId = this.sessions[0].id;
      this.persistSessions();
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
    this.persistSessions();
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
    this.persistSessions();
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
    this.persistSessions();
    return this.getActiveSession();
  }

  /** 更新指定会话的草稿文本并持久化到当前项目独立文件 */
  public updateDraftText(sessionId: string, text: string): void {
    const target = this.sessions.find((s) => s.id === sessionId);
    if (!target) {
      return;
    }
    if ((target.draftText ?? "") === text) {
      return;
    }
    target.draftText = text;
    this.persistSessions();
  }

  public save(): void {
    this.persistSessions();
  }

  /** 读取共享额度文件（支持多窗口实时共享最新额度） */
  public getQuota(): QuotaSnapshot | undefined {
    const latest = this.loadQuotaFromFile();
    if (latest) {
      this.quota = latest;
    }
    return this.quota;
  }

  public saveQuota(quota: QuotaSnapshot): void {
    this.quota = quota;
    this.atomicWriteJson(QUOTA_FILE, quota);
    void this.state.update(QUOTA_KEY, quota);
  }

  private loadWorkspaceFile(
    filePath: string
  ): PersistedWorkspaceFile | undefined {
    try {
      if (!fs.existsSync(filePath)) {
        return undefined;
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedWorkspaceFile;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private loadQuotaFromFile(): QuotaSnapshot | undefined {
    try {
      if (fs.existsSync(QUOTA_FILE)) {
        const raw = fs.readFileSync(QUOTA_FILE, "utf8");
        const parsed = JSON.parse(raw) as QuotaSnapshot;
        if (parsed && typeof parsed.updatedAt === "number") {
          return parsed;
        }
      }
    } catch {
      // 忽略损坏文件并回退
    }
    return (
      this.state.get<QuotaSnapshot>(QUOTA_KEY) ??
      this.state.get<QuotaSnapshot>(LEGACY_QUOTA_KEY)
    );
  }

  /** 将旧版未分项目的 sessions.json 精准迁移给匹配的工作区一次，防止串台到其他新项目 */
  private tryMigrateLegacyFileForWorkspace(
    currentWorkspace: string
  ): { sessions: ChatSession[]; activeSessionId?: string } | undefined {
    try {
      if (!fs.existsSync(LEGACY_SESSIONS_FILE)) {
        return undefined;
      }
      const raw = fs.readFileSync(LEGACY_SESSIONS_FILE, "utf8");
      const legacy = JSON.parse(raw) as LegacySessionsFile;

      // 顺手把旧文件里的额度迁到共享 quota.json
      if (legacy.quota && !fs.existsSync(QUOTA_FILE)) {
        this.saveQuota(legacy.quota);
      }

      if (!Array.isArray(legacy.sessions) || legacy.sessions.length === 0) {
        return undefined;
      }

      // 仅当旧会话内容明确引用了当前工作区路径或项目名时才认领，避免把 A 项目记录错配给 B 项目
      const wsName = currentWorkspace ? path.basename(currentWorkspace) : "";
      const matched =
        Boolean(currentWorkspace) &&
        (raw.includes(currentWorkspace) || (wsName.length >= 3 && raw.includes(wsName)));
      if (!matched) {
        return undefined;
      }

      const migratedBackup = path.join(DATA_DIR, "sessions.legacy.migrated.json");
      fs.renameSync(LEGACY_SESSIONS_FILE, migratedBackup);
      return {
        sessions: legacy.sessions,
        activeSessionId: legacy.activeSessionId,
      };
    } catch {
      return undefined;
    }
  }

  private persistSessions(): void {
    if (!this.sessionFilePath) {
      return;
    }
    const payload: PersistedWorkspaceFile = {
      version: 2,
      workspacePath: this.workspacePath,
      activeSessionId: this.activeSessionId,
      sessions: this.sessions,
    };
    this.atomicWriteJson(this.sessionFilePath, payload);
  }

  /** 带 PID 后缀的原子写盘，彻底避免多窗口并发写坏 JSON */
  private atomicWriteJson(targetPath: string, data: unknown): void {
    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const tmpPath = `${targetPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmpPath, targetPath);
    } catch {
      // 文件写入异常不影响主流程
    }
  }
}
