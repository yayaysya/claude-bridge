import { AgentEngineType, BridgeConfig } from "../config";
import { ChatMessage, QuotaSnapshot } from "../sessionStore";

/** 远程对话执行回调 */
export interface AgentRunCallbacks {
  onUpdate: () => void;
  onSessionId: (remoteSessionId: string) => void;
  onQuota?: (partial: Partial<QuotaSnapshot>) => void;
}

/** 单次远程对话句柄，支持随时取消 */
export interface AgentRunHandle {
  promise: Promise<void>;
  abort: () => void;
}

/** 压缩记忆请求参数 */
export type HandoffSummaryOptions =
  | { mode: "warm-resume"; claudeSessionId: string }
  | { mode: "cold-stateless"; transcript: string };

/** 压缩记忆返回结果 */
export interface HandoffSummaryResult {
  ok: boolean;
  summary?: string;
  reason?: string;
}

/** 单个模型预选项 */
export interface EngineModelOption {
  value: string;
  short: string;
  title: string;
  desc: string;
}

/** 单轮远程对话参数 */
export interface AgentRunTurnParams {
  cfg: BridgeConfig;
  prompt: string;
  claudeSessionId?: string;
  assistantMsg: ChatMessage;
  callbacks: AgentRunCallbacks;
}

/**
 * 统一远程 AI CLI 引擎接口
 * 后续新增 Codex 等后端时，只需实现本接口并在 ClaudeClient 中注册即可，
 * 聊天面板、DevSpace 隧道、多标签、历史搜索均零改动复用。
 */
export interface IAgentEngine {
  readonly engineType: AgentEngineType;
  isRunning(): boolean;
  abort(): void;
  fetchQuota(cfg: BridgeConfig): Promise<Partial<QuotaSnapshot> | undefined>;
  generateHandoffSummary(
    cfg: BridgeConfig,
    options: HandoffSummaryOptions
  ): Promise<HandoffSummaryResult>;
  runTurn(params: AgentRunTurnParams): AgentRunHandle;
  getPresetModels(): EngineModelOption[];
}

/** 共用的 3 板块 600~1000 字压缩记忆结构要求 */
export const SHARED_HANDOFF_STRUCTURE_SPEC = [
  "请严格按下面 3 个固定板块输出中文 Markdown 记忆摘要（总字数控制在 600~1000 字以内，不要调用任何工具，直接输出正文）：",
  "",
  "### 1. 当前全局背景",
  "- 总任务目标、已定案的关键技术结论、涉及的核心文件路径与未提交改动概况。",
  "",
  "### 2. 最近 3 轮对话焦点与当前进展（重点！）",
  "- 围绕**用户最近 3 轮想做的事情**，逐轮梳理并明确标注每件事的当前状态：",
  "  - **已完成**：哪些改动/确认已经落地到代码或文档；",
  "  - **已定待改**：哪些用户已同意但尚未动手修改；",
  "  - **尚未定论**：哪些疑问/设计点还在讨论、卡在哪里、待用户拍板。",
  "",
  "### 3. 紧接着下一步",
  "- 明确新对话接上后最可能需要继续处理的具体事项，避免丢失当前思路。",
].join("\n");
