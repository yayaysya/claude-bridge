import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import {
  AgentEngineType,
  BridgeConfig,
  buildBaseSshArgs,
  getActiveWorkspacePath,
  normalizeEngineType,
  resolveRemoteCliPath,
  shellQuote,
} from "./config";
import {
  ChatMessage,
  ContextAttachment,
  QuotaSnapshot,
  RateLimitWindow,
  ToolCallRecord,
} from "./sessionStore";
import { AntigravityEngine } from "./engines/antigravityEngine";
import {
  AgentRunCallbacks,
  AgentRunHandle,
  EngineModelOption,
  HandoffSummaryOptions,
  HandoffSummaryResult,
  IAgentEngine,
  SHARED_HANDOFF_STRUCTURE_SPEC,
} from "./engines/types";

/** 远程对话执行回调 */
export type ClaudeRunCallbacks = AgentRunCallbacks;

/** 单次远程对话句柄，支持随时取消 */
export type ClaudeRunHandle = AgentRunHandle;

/** Claude Code 常用模型预选项 */
export const CLAUDE_PRESET_MODELS: EngineModelOption[] = [
  { value: "", short: "Default", title: "Default", desc: "跟随远程 EC2 默认配置" },
  { value: "claude-opus-5-5", short: "claude-opus-5-5", title: "claude-opus-5-5", desc: "最强推理与复杂架构分析" },
  { value: "claude-fable-5-2[1m]", short: "claude-fable-5-2[1m]", title: "claude-fable-5-2[1m]", desc: "Fable 5.2 · 1M 超长上下文" },
  { value: "claude-sonnet-5-5", short: "claude-sonnet-5-5", title: "claude-sonnet-5-5", desc: "日常开发速度与质量均衡" },
  { value: "claude-haiku-5-5", short: "claude-haiku-5-5", title: "claude-haiku-5-5", desc: "极速轻量问答" },
];

const TOOL_LABEL_MAP: Record<string, string> = {
  mcp__devspace__open_workspace: "DevSpace · 打开工作区",
  mcp__devspace__read: "DevSpace · 读取文件",
  mcp__devspace__edit: "DevSpace · 编辑文件",
  mcp__devspace__write: "DevSpace · 写入文件",
  mcp__devspace__bash: "DevSpace · 执行命令",
  mcp__devspace__show_changes: "DevSpace · 查看改动",
  Read: "读取文件",
  Edit: "编辑文件",
  Write: "写入文件",
  Bash: "执行命令",
  Glob: "搜索文件",
  Grep: "搜索内容",
  WebSearch: "网页搜索",
};

/**
 * 远程多引擎流式客户端路由器
 * 统一封装 Claude Code (`claude`) 与 Google Antigravity (`agy`)，
 * 后续扩展 Codex 时只需实现 IAgentEngine 并在此注册即可。
 */
export class ClaudeClient {
  private activeChild: ChildProcess | undefined;
  private readonly antigravityEngine: AntigravityEngine;

  constructor(private readonly output: { appendLine(value: string): void }) {
    this.antigravityEngine = new AntigravityEngine(output);
  }

  public isRunning(): boolean {
    return Boolean(this.activeChild) || this.antigravityEngine.isRunning();
  }

  public abort(): void {
    this.antigravityEngine.abort();
    if (this.activeChild) {
      try {
        this.activeChild.kill("SIGTERM");
      } catch {
        // 忽略已退出错误
      }
      this.activeChild = undefined;
    }
  }

  /** 获取指定引擎的模型预选项列表 */
  public getPresetModels(engine: AgentEngineType): EngineModelOption[] {
    if (normalizeEngineType(engine) === "antigravity") {
      return this.antigravityEngine.getPresetModels();
    }
    return CLAUDE_PRESET_MODELS;
  }

  /**
   * 后台静默调用远程官方 `/usage` 命令获取实时额度（0 Token，不弹终端）
   */
  public async fetchQuota(
    cfg: BridgeConfig
  ): Promise<Partial<QuotaSnapshot> | undefined> {
    if (normalizeEngineType(cfg.engine) === "antigravity") {
      return this.antigravityEngine.fetchQuota(cfg);
    }
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return undefined;
    }

    const claudeBin = shellQuote(resolveRemoteCliPath(cfg));
    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${claudeBin} -p --output-format stream-json --verbose --no-session-persistence`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine("[Quota] 正在后台静默查询远程 Claude 额度 (/usage)");

    return new Promise((resolve) => {
      const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let settled = false;

      const finish = (result: Partial<QuotaSnapshot> | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // 忽略
        }
        this.output.appendLine("[Quota] 后台查询额度超时");
        finish(undefined);
      }, 20_000);

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
      });

      child.on("error", (err) => {
        this.output.appendLine(`[Quota] 后台查询额度失败: ${err.message}`);
        finish(undefined);
      });

      child.on("close", () => {
        const parsed = parseUsageOutput(stdout);
        if (parsed) {
          this.output.appendLine(
            `[Quota] 获取成功: 5h=${Math.round((parsed.fiveHour?.utilization ?? 0) * 100)}%, 7d=${Math.round((parsed.sevenDay?.utilization ?? 0) * 100)}%`
          );
        }
        finish(parsed);
      });

      child.stdin?.write("/usage", "utf8");
      child.stdin?.end();
    });
  }

  /**
   * 请远程 Claude 压缩提炼一份精简中文记忆摘要（不调用工具）：
   * - warm-resume：缓存尚热（<55 分钟），复用原会话命中 1 折热缓存；
   * - cold-stateless：缓存已失效，绝不重读几十万字冷会话，改将剥离日志后的轻量纯文本记录交给 Sonnet 独立总结（省 95%+ 额度）。
   */
  public async generateHandoffSummary(
    cfg: BridgeConfig,
    options: HandoffSummaryOptions
  ): Promise<HandoffSummaryResult> {
    if (normalizeEngineType(cfg.engine) === "antigravity") {
      return this.antigravityEngine.generateHandoffSummary(cfg, options);
    }
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return { ok: false, reason: "尚未配置远程服务器连接信息，无法压缩记忆。" };
    }

    const runSummaryOnce = (
      extraArgs: string[],
      promptText: string,
      logLabel: string
    ): Promise<HandoffSummaryResult> => {
      const claudeArgs = [
        shellQuote(resolveRemoteCliPath(cfg)),
        "-p",
        ...extraArgs,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "plan",
        "--max-turns",
        "1",
      ];

      const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${claudeArgs.join(" ")}`;
      const sshArgs = [
        ...buildBaseSshArgs(cfg, { batchMode: true }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        remoteCmd,
      ];

      this.output.appendLine(`[Memory] ${logLabel}`);

      return new Promise((resolve) => {
        const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (res: { ok: boolean; summary?: string; reason?: string }) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(res);
        };

        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // 忽略
          }
          this.output.appendLine("[Memory] 远程压缩记忆超时");
          finish({ ok: false, reason: "远程压缩记忆超时，请检查网络或刷新连接后重试。" });
        }, 45_000);

        child.stdout?.on("data", (buf: Buffer) => {
          stdout += buf.toString("utf8");
        });

        child.stderr?.on("data", (buf: Buffer) => {
          stderr += buf.toString("utf8");
        });

        child.on("error", (err) => {
          finish({ ok: false, reason: `连接远程失败：${err.message}` });
        });

        child.on("close", (code) => {
          let resultText = "";
          let isErr = false;
          for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith("{")) {
              continue;
            }
            try {
              const evt = JSON.parse(line) as Record<string, unknown>;
              if (evt.type === "result") {
                isErr = Boolean(evt.is_error);
                if (typeof evt.result === "string") {
                  resultText = evt.result.trim();
                }
              }
            } catch {
              // 忽略非 JSON 行
            }
          }
          if (/hit your 5-hour limit|rate limit/i.test(resultText)) {
            finish({
              ok: false,
              reason: "当前 5 小时额度已用完，等额度重置后再压缩记忆，或先点右上角「+」开空白新对话。",
            });
            return;
          }
          if (code !== 0 || isErr || !resultText) {
            finish({
              ok: false,
              reason: resultText || stderr.trim() || "远程压缩记忆失败，请稍后重试。",
            });
            return;
          }
          this.output.appendLine(`[Memory] 远程压缩记忆成功 (${resultText.length} 字符)`);
          finish({ ok: true, summary: resultText });
        });

        child.stdin?.write(promptText, "utf8");
        child.stdin?.end();
      });
    };

    const sharedStructureSpec = SHARED_HANDOFF_STRUCTURE_SPEC;

    if (options.mode === "warm-resume") {
      if (!options.claudeSessionId) {
        return { ok: false, reason: "当前会话尚未建立远程对话记录，无法压缩记忆。" };
      }
      const args = ["--resume", shellQuote(options.claudeSessionId)];
      if (cfg.model) {
        args.push("--model", shellQuote(cfg.model));
      }
      const warmPrompt = [
        "请为即将新开的轻量对话压缩整理一份高质量的中文记忆摘要。",
        sharedStructureSpec,
      ].join("\n\n");
      return runSummaryOnce(
        args,
        warmPrompt,
        "缓存尚热，正在请原会话低成本压缩记忆..."
      );
    }

    // 冷缓存脱壳模式：严禁 --resume 旧大上下文，使用 --no-session-persistence + sonnet 轻模型只读分级保真纯文本记录
    const coldPrompt = [
      "下面是一段过往开发对话的分级摘录（更早轮次已精简，最近 3 轮保留高保真内容）。",
      "请帮我为即将新开的轻量对话压缩整理一份高质量的中文记忆摘要。",
      sharedStructureSpec,
      "",
      "--- 对话记录摘录 ---",
      options.transcript,
    ].join("\n\n");

    const res = await runSummaryOnce(
      ["--no-session-persistence", "--model", "sonnet"],
      coldPrompt,
      "缓存已过期，采用轻量脱壳模式（Sonnet，不重读旧大上下文）压缩记忆..."
    );
    // 若远端不识别 sonnet 别名（非限流错误），自动回退不指定 --model 重试一次
    if (
      !res.ok &&
      res.reason &&
      !/额度|limit/i.test(res.reason) &&
      /model|invalid|not found/i.test(res.reason)
    ) {
      return runSummaryOnce(
        ["--no-session-persistence"],
        coldPrompt,
        "回退默认模型继续轻量脱壳压缩记忆..."
      );
    }
    return res;
  }

  /** 将实时工作区快照、附加文件/选区与用户输入组装成清晰 Prompt */
  public buildPrompt(
    userText: string,
    attachments: ContextAttachment[],
    contextBlock?: string
  ): string {
    const parts: string[] = [];

    if (contextBlock && contextBlock.trim()) {
      parts.push(contextBlock.trim());
    }

    if (attachments.length > 0) {
      parts.push("Attached local context from VS Code:");
      for (const att of attachments) {
        if (att.type === "selection" && att.content) {
          const range =
            att.startLine && att.endLine
              ? ` (lines ${att.startLine}-${att.endLine})`
              : "";
          parts.push(
            `[File Selection] ${att.filePath}${range}\n\`\`\`\n${att.content}\n\`\`\``
          );
        } else {
          parts.push(`[File Path] ${att.filePath}`);
        }
      }
    }

    if (parts.length === 0) {
      return userText;
    }

    parts.push(`User request:\n${userText}`);
    return parts.join("\n\n");
  }

  /** 发起一轮流式远程对话（按当前服务器引擎自动路由到 Claude Code 或 Antigravity） */
  public runTurn(params: {
    cfg: BridgeConfig;
    prompt: string;
    claudeSessionId?: string;
    assistantMsg: ChatMessage;
    callbacks: ClaudeRunCallbacks;
  }): ClaudeRunHandle {
    const { cfg, prompt, claudeSessionId, assistantMsg, callbacks } = params;
    this.abort();

    if (normalizeEngineType(cfg.engine) === "antigravity") {
      return this.antigravityEngine.runTurn(params);
    }

    const claudeArgs: string[] = [
      shellQuote(resolveRemoteCliPath(cfg)),
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      shellQuote(cfg.permissionMode),
    ];

    if (cfg.model) {
      claudeArgs.push("--model", shellQuote(cfg.model));
    }

    if (cfg.effort) {
      claudeArgs.push("--effort", shellQuote(cfg.effort));
    }

    if (claudeSessionId) {
      claudeArgs.push("--resume", shellQuote(claudeSessionId));
    }

    // 仅在首轮注入当前 VS Code 工作区路由提示，方便远程 Claude 直接定位 DevSpace 目录
    if (!claudeSessionId) {
      const workspacePath = getActiveWorkspacePath();
      if (workspacePath) {
        const hint = `Current active local workspace in VS Code: ${workspacePath}. Use devspace MCP tools to open and operate on files in this local project.`;
        claudeArgs.push("--append-system-prompt", shellQuote(hint));
      }
    }

    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${claudeArgs.join(" ")}`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine(
      `[Claude] 发送远程请求 (mode=${cfg.permissionMode}, resume=${claudeSessionId ? "yes" : "no"})`
    );

    const child = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeChild = child;

    let aborted = false;
    let stdoutBuffer = "";
    let stderrText = "";
    let hasReceivedTextDeltaInTurn = false;
    let hasReceivedThinkingDeltaInTurn = false;
    let sawToolSinceLastText = false;
    const processedToolIds = new Set<string>();
    const streamedAssistantMessageIds = new Set<string>();
    let currentStreamMessageId: string | undefined;

    const handleLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line || !line.startsWith("{")) {
        return;
      }

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const evtType = String(evt.type ?? "");

      if (evtType === "system" && evt.subtype === "init") {
        const sid = typeof evt.session_id === "string" ? evt.session_id : "";
        if (sid) {
          callbacks.onSessionId(sid);
        }
        if (typeof evt.model === "string") {
          assistantMsg.meta = { ...assistantMsg.meta, model: evt.model };
        }
        callbacks.onUpdate();
        return;
      }

      if (evtType === "stream_event") {
        const inner = evt.event as Record<string, unknown> | undefined;
        if (!inner) {
          return;
        }
        if (typeof evt.api_message_id === "string" && evt.api_message_id) {
          currentStreamMessageId = evt.api_message_id;
        }
        const innerType = String(inner.type ?? "");

        if (innerType === "message_start") {
          const msgObj = inner.message as Record<string, unknown> | undefined;
          currentStreamMessageId =
            typeof msgObj?.id === "string" ? msgObj.id : undefined;
          hasReceivedTextDeltaInTurn = false;
          hasReceivedThinkingDeltaInTurn = false;
          return;
        }

        if (innerType === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (!delta) {
            return;
          }
          const deltaType = String(delta.type ?? "");
          if (deltaType === "text_delta" && typeof delta.text === "string") {
            if (sawToolSinceLastText) {
              if (assistantMsg.text.trim().length > 0) {
                assistantMsg.text += "\n\n";
              }
              sawToolSinceLastText = false;
            }
            assistantMsg.text += delta.text;
            hasReceivedTextDeltaInTurn = true;
            if (currentStreamMessageId) {
              streamedAssistantMessageIds.add(currentStreamMessageId);
            }
            callbacks.onUpdate();
          } else if (
            deltaType === "thinking_delta" &&
            typeof delta.thinking === "string"
          ) {
            assistantMsg.thinking = (assistantMsg.thinking ?? "") + delta.thinking;
            hasReceivedThinkingDeltaInTurn = true;
            if (currentStreamMessageId) {
              streamedAssistantMessageIds.add(currentStreamMessageId);
            }
            callbacks.onUpdate();
          }
        }
        return;
      }

      if (evtType === "assistant") {
        const msgObj = evt.message as Record<string, unknown> | undefined;
        const msgId = typeof msgObj?.id === "string" ? msgObj.id : undefined;
        const usageObj = msgObj?.usage as Record<string, unknown> | undefined;
        if (usageObj && callbacks.onQuota) {
          const inTok = Number(usageObj.input_tokens ?? 0);
          const cacheRead = Number(usageObj.cache_read_input_tokens ?? 0);
          const cacheCreate = Number(usageObj.cache_creation_input_tokens ?? 0);
          const totalCtx = inTok + cacheRead + cacheCreate;
          if (totalCtx > 0) {
            callbacks.onQuota({
              lastContextTokens: totalCtx,
              lastModel:
                typeof msgObj?.model === "string" ? msgObj.model : undefined,
              updatedAt: Date.now(),
            });
          }
        }
        const blocks = Array.isArray(msgObj?.content)
          ? (msgObj?.content as Array<Record<string, unknown>>)
          : [];
        const alreadyStreamed =
          Boolean(msgId && streamedAssistantMessageIds.has(msgId)) ||
          hasReceivedTextDeltaInTurn;

        for (const block of blocks) {
          const bType = String(block.type ?? "");
          if (
            bType === "thinking" &&
            typeof block.thinking === "string" &&
            !hasReceivedThinkingDeltaInTurn &&
            !(msgId && streamedAssistantMessageIds.has(msgId))
          ) {
            assistantMsg.thinking =
              (assistantMsg.thinking ? `${assistantMsg.thinking}\n` : "") +
              block.thinking;
          } else if (
            bType === "text" &&
            typeof block.text === "string" &&
            !alreadyStreamed
          ) {
            if (sawToolSinceLastText) {
              if (assistantMsg.text.trim().length > 0) {
                assistantMsg.text += "\n\n";
              }
              sawToolSinceLastText = false;
            }
            assistantMsg.text += block.text;
          } else if (bType === "tool_use") {
            const toolId = String(block.id ?? `tool_${Date.now()}`);
            if (processedToolIds.has(toolId)) {
              continue;
            }
            processedToolIds.add(toolId);
            const toolName = String(block.name ?? "tool");
            const inputObj =
              (block.input as Record<string, unknown> | undefined) ?? {};
            const record = buildToolRecord(toolId, toolName, inputObj);
            if (!assistantMsg.tools) {
              assistantMsg.tools = [];
            }
            assistantMsg.tools.push(record);
            sawToolSinceLastText = true;
          }
        }
        hasReceivedTextDeltaInTurn = false;
        hasReceivedThinkingDeltaInTurn = false;
        callbacks.onUpdate();
        return;
      }

      if (evtType === "user") {
        const msgObj = evt.message as Record<string, unknown> | undefined;
        const blocks = Array.isArray(msgObj?.content)
          ? (msgObj?.content as Array<Record<string, unknown>>)
          : [];
        for (const block of blocks) {
          if (block.type !== "tool_result") {
            continue;
          }
          const toolUseId = String(block.tool_use_id ?? "");
          const isError = Boolean(block.is_error);
          const outputText = extractToolResultText(block.content);
          const toolRecord = assistantMsg.tools?.find((t) => t.id === toolUseId);
          if (toolRecord) {
            toolRecord.status = isError ? "error" : "done";
            toolRecord.output = truncateText(outputText, 2500);
          }
        }
        callbacks.onUpdate();
        return;
      }

      if (evtType === "rate_limit_event") {
        const info = evt.rate_limit_info as Record<string, unknown> | undefined;
        if (info && callbacks.onQuota) {
          const unified = info.unifiedWindows as
            | Record<string, unknown>
            | undefined;
          const parseWin = (raw: unknown): RateLimitWindow | undefined => {
            if (!raw || typeof raw !== "object") {
              return undefined;
            }
            const obj = raw as Record<string, unknown>;
            if (typeof obj.utilization !== "number") {
              return undefined;
            }
            return {
              utilization: obj.utilization,
              resetsAt:
                typeof obj.resetsAt === "number" ? obj.resetsAt : undefined,
              status: typeof obj.status === "string" ? obj.status : undefined,
            };
          };

          let fiveHour = parseWin(unified?.five_hour);
          let sevenDay = parseWin(unified?.seven_day);

          // 兼容新版 CLI 在顶层直接返回 rateLimitType + utilization + resetsAt 的结构
          if (!fiveHour && !sevenDay && typeof info.utilization === "number") {
            const singleWin: RateLimitWindow = {
              utilization: info.utilization,
              resetsAt:
                typeof info.resetsAt === "number" ? info.resetsAt : undefined,
              status: typeof info.status === "string" ? info.status : undefined,
            };
            const limitType = String(info.rateLimitType ?? "");
            if (limitType === "five_hour" || limitType === "session") {
              fiveHour = singleWin;
            } else if (limitType === "seven_day" || limitType === "weekly") {
              sevenDay = singleWin;
            }
          }

          if (fiveHour || sevenDay) {
            callbacks.onQuota({
              fiveHour,
              sevenDay,
              status: typeof info.status === "string" ? info.status : undefined,
              isUsingOverage:
                typeof info.isUsingOverage === "boolean"
                  ? info.isUsingOverage
                  : undefined,
              updatedAt: Date.now(),
            });
          }
        }
        return;
      }

      if (evtType === "result") {
        if (typeof evt.session_id === "string" && evt.session_id) {
          callbacks.onSessionId(evt.session_id);
        }
        // 提取当前模型的上下文窗口上限
        const modelUsage = evt.modelUsage as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (modelUsage && callbacks.onQuota) {
          const firstEntry = Object.entries(modelUsage)[0];
          if (firstEntry) {
            const [modelName, stats] = firstEntry;
            const ctxWin = Number(stats?.contextWindow ?? 0);
            if (ctxWin > 0) {
              callbacks.onQuota({
                lastContextWindow: ctxWin,
                lastModel: modelName,
                updatedAt: Date.now(),
              });
            }
          }
        }
        const isError = Boolean(evt.is_error);
        const resultText = typeof evt.result === "string" ? evt.result : "";
        if (!assistantMsg.text.trim() && resultText) {
          assistantMsg.text = resultText;
        }
        assistantMsg.meta = {
          ...assistantMsg.meta,
          costUsd:
            typeof evt.total_cost_usd === "number"
              ? evt.total_cost_usd
              : assistantMsg.meta?.costUsd,
          durationMs:
            typeof evt.duration_ms === "number"
              ? evt.duration_ms
              : assistantMsg.meta?.durationMs,
          isError,
        };
        // 将任何仍处于 running 的工具收敛为 done
        if (assistantMsg.tools) {
          for (const t of assistantMsg.tools) {
            if (t.status === "running") {
              t.status = isError ? "error" : "done";
            }
          }
        }
        callbacks.onUpdate();
      }
    };

    const promise = new Promise<void>((resolve) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrText += text;
        if (text.trim()) {
          this.output.appendLine(`[Claude stderr] ${text.trim()}`);
        }
      });

      child.on("error", (err) => {
        if (this.activeChild === child) {
          this.activeChild = undefined;
        }
        assistantMsg.text =
          assistantMsg.text || `启动远程 SSH 失败：${err.message}`;
        assistantMsg.meta = { ...assistantMsg.meta, isError: true };
        callbacks.onUpdate();
        resolve();
      });

      child.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          handleLine(stdoutBuffer);
        }
        if (this.activeChild === child) {
          this.activeChild = undefined;
        }
        if (aborted) {
          assistantMsg.text = assistantMsg.text
            ? `${assistantMsg.text}\n\n_(已手动停止)_`
            : "_(已手动停止)_";
        } else if (code !== 0 && !assistantMsg.text.trim()) {
          const reason = stderrText.trim() || `SSH / Claude 进程退出码 ${code}`;
          assistantMsg.text = `执行失败：${reason}`;
          assistantMsg.meta = { ...assistantMsg.meta, isError: true };
        }
        callbacks.onUpdate();
        resolve();
      });

      // 通过 stdin 传入 Prompt 并立即关闭，避免 3 秒 stdin 等待提示与命令行长度限制
      child.stdin?.write(prompt, "utf8");
      child.stdin?.end();
    });

    return {
      promise,
      abort: () => {
        aborted = true;
        this.abort();
      },
    };
  }
}

function buildToolRecord(
  id: string,
  name: string,
  input: Record<string, unknown>
): ToolCallRecord {
  const displayName = TOOL_LABEL_MAP[name] ?? name;
  const candidatePath = pickFirstString(input, [
    "path",
    "file_path",
    "filePath",
    "directory",
    "root",
    "cwd",
  ]);
  const commandStr = pickFirstString(input, ["command", "cmd", "query", "pattern"]);

  let inputSummary = "";
  if (candidatePath) {
    inputSummary = candidatePath;
  } else if (commandStr) {
    inputSummary = truncateText(commandStr, 100);
  } else {
    inputSummary = truncateText(JSON.stringify(input), 100);
  }

  // 仅当路径指向本地项目路径时提供点击跳转
  const filePath =
    candidatePath && candidatePath.startsWith("/") ? candidatePath : undefined;

  return {
    id,
    name,
    displayName,
    inputSummary,
    inputRaw: truncateText(JSON.stringify(input, null, 2), 2000),
    status: "running",
    filePath,
  };
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && "text" in item) {
          return String((item as Record<string, unknown>).text ?? "");
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content, null, 2);
  }
  return "";
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}\n... (已截断，共 ${text.length} 字符)`;
}

/** 解析 `/usage` 命令的 stream-json 输出，提取 5h/7d 官方额度与重置时间 */
function parseUsageOutput(rawStdout: string): Partial<QuotaSnapshot> | undefined {
  const lines = rawStdout.split(/\r?\n/);
  let fiveHour: RateLimitWindow | undefined;
  let sevenDay: RateLimitWindow | undefined;
  let isUsingOverage: boolean | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const usageReport = obj.usage_report as Record<string, unknown> | undefined;
    const rateLimits = usageReport?.rate_limits as
      | Record<string, unknown>
      | undefined;
    const limitsArr = Array.isArray(rateLimits?.limits)
      ? (rateLimits?.limits as Array<Record<string, unknown>>)
      : [];

    for (const item of limitsArr) {
      const kind = String(item.kind ?? "");
      const group = String(item.group ?? "");
      const percent = typeof item.percent === "number" ? item.percent : undefined;
      if (percent === undefined) {
        continue;
      }
      const resetsAtMs =
        typeof item.resets_at === "string" ? Date.parse(item.resets_at) : NaN;
      const win: RateLimitWindow = {
        utilization: Math.max(0, percent / 100),
        resetsAt: Number.isFinite(resetsAtMs)
          ? Math.floor(resetsAtMs / 1000)
          : undefined,
        status: typeof item.severity === "string" ? item.severity : undefined,
      };
      if (kind === "session" || group === "session") {
        fiveHour = win;
      } else if (kind === "weekly_all" || group === "weekly") {
        sevenDay = win;
      }
    }

    const extraUsage = rateLimits?.extra_usage as
      | Record<string, unknown>
      | undefined;
    if (extraUsage && typeof extraUsage.is_enabled === "boolean") {
      isUsingOverage = extraUsage.is_enabled;
    }
  }

  if (!fiveHour && !sevenDay) {
    return undefined;
  }

  const isRejected = Boolean(
    (fiveHour && (fiveHour.utilization >= 1 || fiveHour.status === "rejected")) ||
      (sevenDay && (sevenDay.utilization >= 1 || sevenDay.status === "rejected"))
  );

  return {
    fiveHour,
    sevenDay,
    status: isRejected ? "rejected" : "allowed",
    isUsingOverage,
    updatedAt: Date.now(),
  };
}
