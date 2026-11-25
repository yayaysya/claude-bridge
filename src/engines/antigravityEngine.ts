import { ChildProcess, spawn } from "child_process";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getActiveWorkspacePath,
  resolveRemoteCliPath,
  shellQuote,
} from "../config";
import {
  QuotaPoolSummary,
  QuotaSnapshot,
  RateLimitWindow,
  ToolCallRecord,
} from "../sessionStore";
import {
  AgentRunHandle,
  AgentRunTurnParams,
  EngineModelOption,
  HandoffSummaryOptions,
  HandoffSummaryResult,
  IAgentEngine,
  SHARED_HANDOFF_STRUCTURE_SPEC,
} from "./types";

/** Antigravity CLI 常用模型预选项（与 agy models 输出一致） */
export const ANTIGRAVITY_PRESET_MODELS: EngineModelOption[] = [
  { value: "", short: "Default", title: "Default", desc: "跟随远程 Antigravity 默认配置" },
  { value: "gemini-4-neon-high", short: "gemini-4-neon-high", title: "Gemini 4 Neon (High)", desc: "旗舰高强度推理与复杂设计" },
  { value: "gemini-4-carbon-medium", short: "gemini-4-carbon-medium", title: "Gemini 4 Carbon (Medium)", desc: "日常开发均衡推荐" },
  { value: "gemini-4-hydrogen-high", short: "gemini-4-hydrogen-high", title: "Gemini 4 Hydrogen (High)", desc: "高强度代码分析与排错" },
  { value: "gemini-3.8-flash-medium", short: "gemini-3.8-flash-medium", title: "Gemini 3.8 Flash (Medium)", desc: "极速轻量问答与总结" },
  { value: "claude-opus-5-5-high", short: "claude-opus-5-5-high", title: "Claude Opus 5.5 (High)", desc: "Antigravity 内置 Claude 旗舰" },
  { value: "claude-sonnet-5-5-high", short: "claude-sonnet-5-5-high", title: "Claude Sonnet 5.5 (High)", desc: "Antigravity 内置 Claude 均衡" },
  { value: "gpt-oss-120b-medium", short: "gpt-oss-120b-medium", title: "GPT-OSS 120B (Medium)", desc: "开源大模型备选" },
];

const AGY_TOOL_LABEL_MAP: Record<string, string> = {
  open_workspace: "DevSpace · 打开工作区",
  read: "DevSpace · 读取文件",
  edit: "DevSpace · 编辑文件",
  write: "DevSpace · 写入文件",
  bash: "DevSpace · 执行命令",
  show_changes: "DevSpace · 查看改动",
  view_file: "读取文件",
  read_file: "读取文件",
  write_to_file: "写入文件",
  write_file: "写入文件",
  replace_file_content: "编辑文件",
  multi_replace_file_content: "批量编辑文件",
  run_command: "执行命令",
  grep_search: "搜索内容",
  find_by_name: "搜索文件",
  list_dir: "查看目录",
  search_web: "网页搜索",
  read_url_content: "读取网页",
};

/**
 * 远程 Google Antigravity CLI (agy) 流式引擎
 * 通过 SSH 驱动远程 `agy --input-format stream-json --output-format stream-json`，
 * 利用 --settings 权限规则禁掉远程文件写入与命令执行，强制只操作本地 DevSpace MCP。
 */
export class AntigravityEngine implements IAgentEngine {
  public readonly engineType = "antigravity" as const;
  private activeChild: ChildProcess | undefined;

  constructor(private readonly output: { appendLine(value: string): void }) {}

  public isRunning(): boolean {
    return Boolean(this.activeChild);
  }

  public abort(): void {
    if (this.activeChild) {
      try {
        this.activeChild.kill("SIGTERM");
      } catch {
        // 忽略已退出错误
      }
      this.activeChild = undefined;
    }
  }

  public getPresetModels(): EngineModelOption[] {
    return ANTIGRAVITY_PRESET_MODELS;
  }

  /**
   * 后台静默调用 `agy -p /usage` 获取实时额度（0 Token，纯文本输出）
   */
  public async fetchQuota(
    cfg: BridgeConfig
  ): Promise<Partial<QuotaSnapshot> | undefined> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return undefined;
    }

    const agyBin = shellQuote(resolveRemoteCliPath(cfg));
    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${agyBin} -p /usage`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine("[Quota] 正在后台静默查询远程 Antigravity 额度 (/usage)");

    return new Promise((resolve) => {
      const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
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
        this.output.appendLine("[Quota] 后台查询 Antigravity 额度超时");
        finish(undefined);
      }, 20_000);

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
      });

      child.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
      });

      child.on("error", (err) => {
        this.output.appendLine(`[Quota] 后台查询 Antigravity 额度失败: ${err.message}`);
        finish(undefined);
      });

      child.on("close", () => {
        const parsed = parseAgyUsageOutput(stdout, cfg.model);
        if (parsed) {
          this.output.appendLine(
            `[Quota] Antigravity 额度获取成功: 5h=${Math.round((parsed.fiveHour?.utilization ?? 0) * 100)}%, 7d=${Math.round((parsed.sevenDay?.utilization ?? 0) * 100)}%`
          );
        } else if (stderr.trim()) {
          this.output.appendLine(`[Quota] Antigravity 额度输出未识别: ${stderr.trim().slice(0, 200)}`);
        }
        finish(parsed);
      });
    });
  }

  /**
   * 压缩记忆：沿用统一的 3 板块 600~1000 字结构，冷缓存默认使用轻量 Flash 模型脱壳总结
   */
  public async generateHandoffSummary(
    cfg: BridgeConfig,
    options: HandoffSummaryOptions
  ): Promise<HandoffSummaryResult> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return { ok: false, reason: "尚未配置远程服务器连接信息，无法压缩记忆。" };
    }

    const agyBin = shellQuote(resolveRemoteCliPath(cfg));
    const readOnlySettings = JSON.stringify({
      permissions: {
        deny: ["write_file(*)", "command(*)"],
      },
    });

    const runSummaryOnce = (
      extraArgs: string[],
      promptText: string,
      logLabel: string
    ): Promise<HandoffSummaryResult> => {
      const agyArgs = [
        agyBin,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--mode",
        "plan",
        "--settings",
        shellQuote(readOnlySettings),
        ...extraArgs,
      ];

      const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${agyArgs.join(" ")}`;
      const sshArgs = [
        ...buildBaseSshArgs(cfg, { batchMode: true }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        remoteCmd,
      ];

      this.output.appendLine(`[Memory/AGY] ${logLabel}`);

      return new Promise((resolve) => {
        const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (res: HandoffSummaryResult) => {
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
          this.output.appendLine("[Memory/AGY] 远程压缩记忆超时");
          finish({ ok: false, reason: "远程压缩记忆超时，请检查网络或刷新连接后重试。" });
        }, 50_000);

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
          let errText = "";
          let isErr = false;

          for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith("{")) {
              continue;
            }
            try {
              const evt = JSON.parse(line) as Record<string, unknown>;
              if (evt.event === "step_update") {
                const su = evt.step_update as Record<string, unknown> | undefined;
                if (su?.step_type === "agent_response" && typeof su.text_delta === "string") {
                  resultText += su.text_delta;
                }
              } else if (evt.event === "result") {
                const r = evt.result as Record<string, unknown> | undefined;
                if (r) {
                  isErr = String(r.status ?? "") !== "SUCCESS";
                  if (typeof r.response === "string" && r.response.trim()) {
                    resultText = r.response.trim();
                  }
                  if (typeof r.error === "string" && r.error.trim()) {
                    errText = r.error.trim();
                  }
                }
              }
            } catch {
              // 忽略非 JSON 行
            }
          }

          resultText = resultText.trim();
          const combinedErr = errText || stderr.trim();
          if (/quota|rate limit|limit exceeded/i.test(combinedErr)) {
            finish({
              ok: false,
              reason: "当前额度已用完，请等额度重置后再压缩记忆，或先点右上角「+」开空白新对话。",
            });
            return;
          }
          if (code !== 0 || isErr || !resultText) {
            finish({
              ok: false,
              reason: errText || resultText || stderr.trim() || "远程压缩记忆失败，请稍后重试。",
            });
            return;
          }
          this.output.appendLine(`[Memory/AGY] 远程压缩记忆成功 (${resultText.length} 字符)`);
          finish({ ok: true, summary: resultText });
        });

        const payload = JSON.stringify({
          event: "user",
          message: { content: promptText },
        });
        child.stdin?.write(`${payload}\n`, "utf8");
        child.stdin?.end();
      });
    };

    if (options.mode === "warm-resume") {
      if (!options.claudeSessionId) {
        return { ok: false, reason: "当前会话尚未建立远程对话记录，无法压缩记忆。" };
      }
      const args = ["--conversation", shellQuote(options.claudeSessionId)];
      const safeModel = resolveAgyModelSlug(cfg.model);
      if (safeModel) {
        args.push("--model", shellQuote(safeModel));
      }
      const warmPrompt = [
        "请为即将新开的轻量对话压缩整理一份高质量的中文记忆摘要。",
        SHARED_HANDOFF_STRUCTURE_SPEC,
      ].join("\n\n");
      return runSummaryOnce(args, warmPrompt, "缓存尚热，正在请原会话低成本压缩记忆...");
    }

    const coldPrompt = [
      "下面是一段过往开发对话的分级摘录（更早轮次已精简，最近 3 轮保留高保真内容）。",
      "请帮我为即将新开的轻量对话压缩整理一份高质量的中文记忆摘要。",
      SHARED_HANDOFF_STRUCTURE_SPEC,
      "",
      "--- 对话记录摘录 ---",
      options.transcript,
    ].join("\n\n");

    const res = await runSummaryOnce(
      ["--model", shellQuote("gemini-3.8-flash-medium")],
      coldPrompt,
      "缓存已过期，采用轻量 Flash 模型脱壳压缩记忆..."
    );
    if (
      !res.ok &&
      res.reason &&
      !/额度|quota|limit/i.test(res.reason) &&
      /model|invalid|not found|recognized/i.test(res.reason)
    ) {
      return runSummaryOnce(
        [],
        coldPrompt,
        "Flash 模型不可用，回退默认模型继续轻量脱壳压缩记忆..."
      );
    }
    return res;
  }

  /** 发起一轮流式远程 Antigravity 对话 */
  public runTurn(params: AgentRunTurnParams): AgentRunHandle {
    const { cfg, prompt, claudeSessionId, assistantMsg, callbacks } = params;
    this.abort();

    const agyBin = shellQuote(resolveRemoteCliPath(cfg));
    const agyArgs: string[] = [
      agyBin,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
    ];

    // 权限模式与安全边界：始终禁掉远程 VPS 写入和命令执行，强制走本地 devspace MCP
    if (cfg.permissionMode === "plan") {
      agyArgs.push("--mode", "plan");
      const planSettings = JSON.stringify({
        permissions: {
          allow: [
            "mcp(devspace/open_workspace)",
            "mcp(devspace/read)",
            "mcp(devspace/show_changes)",
          ],
          deny: ["write_file(*)", "command(*)"],
        },
      });
      agyArgs.push("--settings", shellQuote(planSettings));
    } else if (cfg.permissionMode === "dontAsk") {
      const strictSettings = JSON.stringify({
        permissions: {
          allow: [
            "mcp(devspace/open_workspace)",
            "mcp(devspace/read)",
            "mcp(devspace/show_changes)",
          ],
          deny: ["write_file(*)", "command(*)"],
        },
      });
      agyArgs.push("--settings", shellQuote(strictSettings));
    } else {
      // bypassPermissions / acceptEdits：放行全部本地 devspace MCP 工具，但仍用 deny 锁死远程 VPS 写/执行
      agyArgs.push("--dangerously-skip-permissions");
      const devspaceOnlySettings = JSON.stringify({
        permissions: {
          allow: ["mcp(devspace/*)"],
          deny: ["write_file(*)", "command(*)"],
        },
      });
      agyArgs.push("--settings", shellQuote(devspaceOnlySettings));
    }

    const safeModel = resolveAgyModelSlug(cfg.model);
    if (safeModel) {
      agyArgs.push("--model", shellQuote(safeModel));
    }

    if (cfg.effort) {
      agyArgs.push("--effort", shellQuote(cfg.effort));
    }

    if (claudeSessionId) {
      agyArgs.push("--conversation", shellQuote(claudeSessionId));
    }

    // 首轮对话在正文前附加轻量工作区路由提示，确保远程 agy 优先使用 devspace MCP
    let effectivePrompt = prompt;
    if (!claudeSessionId) {
      const workspacePath = getActiveWorkspacePath();
      if (workspacePath) {
        const hint = `[Active local VS Code workspace: ${workspacePath}. Always use the \`devspace\` MCP server tools to open, read, search, edit, and run commands in this local project. Never operate on the remote VPS filesystem.]`;
        effectivePrompt = `${hint}\n\n${prompt}`;
      }
    }

    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${agyArgs.join(" ")}`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine(
      `[Antigravity] 发送远程请求 (mode=${cfg.permissionMode}, model=${safeModel || "default"}, resume=${claudeSessionId ? "yes" : "no"})`
    );

    const child = spawn("ssh", sshArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeChild = child;

    let aborted = false;
    let stdoutBuffer = "";
    let stderrText = "";
    let sawToolSinceLastText = false;

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

      const evtName = String(evt.event ?? "");

      if (evtName === "init") {
        const cid = typeof evt.conversation_id === "string" ? evt.conversation_id : "";
        if (cid) {
          callbacks.onSessionId(cid);
        }
        const initObj = evt.init as Record<string, unknown> | undefined;
        if (typeof initObj?.model === "string" && initObj.model) {
          assistantMsg.meta = { ...assistantMsg.meta, model: initObj.model };
        }
        callbacks.onUpdate();
        return;
      }

      if (evtName === "step_update") {
        const su = evt.step_update as Record<string, unknown> | undefined;
        if (!su) {
          return;
        }
        if (typeof su.conversation_id === "string" && su.conversation_id) {
          callbacks.onSessionId(su.conversation_id);
        }

        const stepType = String(su.step_type ?? "");
        const stepState = String(su.state ?? "");

        if (stepType === "agent_response") {
          if (typeof su.text_delta === "string" && su.text_delta.length > 0) {
            if (sawToolSinceLastText) {
              if (assistantMsg.text.trim().length > 0) {
                assistantMsg.text += "\n\n";
              }
              sawToolSinceLastText = false;
            }
            assistantMsg.text += su.text_delta;
            callbacks.onUpdate();
          }
        } else if (stepType === "thinking" || typeof su.thinking_delta === "string") {
          const td =
            typeof su.thinking_delta === "string"
              ? su.thinking_delta
              : typeof su.text_delta === "string"
                ? su.text_delta
                : "";
          if (td) {
            assistantMsg.thinking = (assistantMsg.thinking ?? "") + td;
            callbacks.onUpdate();
          }
        } else if (stepType === "tool") {
          const stepIndex = su.step_index ?? Date.now();
          const toolId = `agy_step_${String(stepIndex)}`;
          const toolInfo = (su.tool_info as Record<string, unknown> | undefined) ?? {};
          const rawName = String(toolInfo.name ?? su.tool_name ?? "tool");
          const paramsObj =
            (toolInfo.parameters as Record<string, unknown> | undefined) ?? {};
          const errObj = toolInfo.error as Record<string, unknown> | undefined;
          const outputStr =
            typeof toolInfo.output === "string"
              ? toolInfo.output
              : errObj
                ? String(errObj.message ?? JSON.stringify(errObj))
                : undefined;

          if (!assistantMsg.tools) {
            assistantMsg.tools = [];
          }
          const existing = assistantMsg.tools.find((t) => t.id === toolId);
          const built = buildAgyToolRecord(toolId, rawName, paramsObj);
          const nextStatus: ToolCallRecord["status"] =
            stepState === "DONE"
              ? errObj
                ? "error"
                : "done"
              : "running";

          if (existing) {
            existing.status = nextStatus;
            if (outputStr !== undefined) {
              existing.output = truncateText(outputStr, 2500);
            }
          } else {
            built.status = nextStatus;
            if (outputStr !== undefined) {
              built.output = truncateText(outputStr, 2500);
            }
            assistantMsg.tools.push(built);
          }
          sawToolSinceLastText = true;
          callbacks.onUpdate();
        }

        const usageObj = su.usage as Record<string, unknown> | undefined;
        if (usageObj && callbacks.onQuota) {
          const inTok = Number(usageObj.input_tokens ?? 0);
          const cacheRead = Number(usageObj.cache_read_tokens ?? 0);
          const totalCtx = inTok + cacheRead;
          if (totalCtx > 0) {
            const activeModel = assistantMsg.meta?.model || safeModel || cfg.model;
            callbacks.onQuota({
              lastContextTokens: totalCtx,
              lastContextWindow: estimateAgyContextWindow(activeModel),
              lastModel: activeModel || undefined,
              updatedAt: Date.now(),
            });
          }
        }
        return;
      }

      if (evtName === "result") {
        const res = evt.result as Record<string, unknown> | undefined;
        if (!res) {
          return;
        }
        if (typeof res.conversation_id === "string" && res.conversation_id) {
          callbacks.onSessionId(res.conversation_id);
        }
        const statusStr = String(res.status ?? "");
        const isError = statusStr !== "SUCCESS";
        const respText = typeof res.response === "string" ? res.response : "";
        const errText = typeof res.error === "string" ? res.error : "";

        if (!assistantMsg.text.trim()) {
          if (respText) {
            assistantMsg.text = respText;
          } else if (errText) {
            assistantMsg.text = `执行失败：${errText}`;
          }
        } else if (isError && errText && !assistantMsg.text.includes(errText)) {
          assistantMsg.text += `\n\n执行异常：${errText}`;
        }

        const durSec = typeof res.duration_seconds === "number" ? res.duration_seconds : undefined;
        assistantMsg.meta = {
          ...assistantMsg.meta,
          durationMs:
            durSec !== undefined ? Math.round(durSec * 1000) : assistantMsg.meta?.durationMs,
          isError,
        };

        const usageObj = res.usage as Record<string, unknown> | undefined;
        if (usageObj && callbacks.onQuota) {
          const inTok = Number(usageObj.input_tokens ?? 0);
          const cacheRead = Number(usageObj.cache_read_tokens ?? 0);
          const totalCtx = inTok + cacheRead;
          const activeModel = assistantMsg.meta?.model || safeModel || cfg.model;
          if (totalCtx > 0) {
            callbacks.onQuota({
              lastContextTokens: totalCtx,
              lastContextWindow: estimateAgyContextWindow(activeModel),
              lastModel: activeModel || undefined,
              updatedAt: Date.now(),
            });
          }
        }

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
          this.output.appendLine(`[Antigravity stderr] ${text.trim()}`);
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
          const reason = stderrText.trim() || `SSH / Antigravity 进程退出码 ${code}`;
          assistantMsg.text = `执行失败：${reason}`;
          assistantMsg.meta = { ...assistantMsg.meta, isError: true };
        }
        callbacks.onUpdate();
        resolve();
      });

      const userEvent = JSON.stringify({
        event: "user",
        message: { content: effectivePrompt },
      });
      child.stdin?.write(`${userEvent}\n`, "utf8");
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

/** 避免把 Claude Code 专属模型名（如 claude-fable-5-2[1m]）原样传给 agy 导致报错 */
function resolveAgyModelSlug(rawModel?: string): string {
  const m = (rawModel || "").trim();
  if (!m) {
    return "";
  }
  if (m === "claude-opus-5-5") {
    return "claude-opus-5-5-high";
  }
  if (m === "claude-sonnet-5-5") {
    return "claude-sonnet-5-5-high";
  }
  if (/^claude-(fable|haiku)/i.test(m) || m === "sonnet" || m === "opus" || m === "haiku") {
    return "";
  }
  return m;
}

/** 估算 Antigravity 对应模型的上下文窗口上限 */
function estimateAgyContextWindow(model?: string): number {
  if (model && /^(claude|gpt)/i.test(model)) {
    return 200_000;
  }
  return 1_000_000;
}

/** 解析 `agy -p /usage` 纯文本额度输出 */
export function parseAgyUsageOutput(
  rawText: string,
  activeModel?: string
): Partial<QuotaSnapshot> | undefined {
  if (!rawText || !rawText.trim()) {
    return undefined;
  }

  const pools = new Map<
    string,
    { label: string; fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }
  >();

  const lineRe =
    /^(Gemini Models|Claude and GPT models)\s+(Weekly Limit Remaining|Five Hour Limit Remaining)\s+(\d+(?:\.\d+)?)%\s*(.*)$/i;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = lineRe.exec(line);
    if (!m) {
      continue;
    }
    const groupRaw = m[1].trim();
    const kindRaw = m[2].toLowerCase();
    const remainingPct = Number(m[3]);
    const resetRaw = (m[4] || "").trim();
    if (Number.isNaN(remainingPct)) {
      continue;
    }

    const key = /^gemini/i.test(groupRaw) ? "gemini" : "claude_gpt";
    const label = key === "gemini" ? "Gemini 模型" : "Claude / GPT 模型";
    let entry = pools.get(key);
    if (!entry) {
      entry = { label };
      pools.set(key, entry);
    }

    const utilization = Math.max(0, Math.min(1, (100 - remainingPct) / 100));
    const resetsAt = parseAgyResetTimestamp(resetRaw);
    const win: RateLimitWindow = {
      utilization,
      resetsAt,
      status: remainingPct <= 0 ? "rejected" : "allowed",
    };

    if (kindRaw.includes("five hour")) {
      entry.fiveHour = win;
    } else if (kindRaw.includes("weekly")) {
      entry.sevenDay = win;
    }
  }

  if (pools.size === 0) {
    return undefined;
  }

  const preferClaudePool = Boolean(activeModel && /^(claude|gpt)/i.test(activeModel));
  const primary =
    (preferClaudePool ? pools.get("claude_gpt") : pools.get("gemini")) ??
    pools.get("gemini") ??
    pools.get("claude_gpt");

  const secondaryPools: QuotaPoolSummary[] = [];
  for (const pool of pools.values()) {
    secondaryPools.push({
      label: pool.label,
      fiveHour: pool.fiveHour,
      sevenDay: pool.sevenDay,
    });
  }

  const fiveHour = primary?.fiveHour;
  const sevenDay = primary?.sevenDay;
  const isRejected =
    (fiveHour && fiveHour.utilization >= 1) || (sevenDay && sevenDay.utilization >= 1);

  return {
    fiveHour,
    sevenDay,
    secondaryPools,
    status: isRejected ? "rejected" : "allowed",
    updatedAt: Date.now(),
  };
}

/** 解析类似 `2026-11-25 19:14 CST` 的重置时间为秒级时间戳（过滤 1970 占位值） */
function parseAgyResetTimestamp(raw: string): number | undefined {
  if (!raw || raw.startsWith("1970-")) {
    return undefined;
  }
  // 将常见时区缩写转为固定偏移，确保 Node Date.parse 稳定解析
  const tzNormalized = raw
    .replace(/\bCST\b/g, "+08:00")
    .replace(/\bUTC\b/g, "Z")
    .replace(/\bGMT\b/g, "Z")
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2:00");
  const ms = Date.parse(tzNormalized);
  if (Number.isNaN(ms) || ms < 946684800000) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}

function buildAgyToolRecord(
  id: string,
  rawName: string,
  input: Record<string, unknown>
): ToolCallRecord {
  let effectiveName = rawName;
  let effectiveInput = input;

  // 处理 call_mcp_tool 封装格式
  if (rawName === "call_mcp_tool" && typeof input.ToolName === "string") {
    effectiveName = `${String(input.ServerName || "mcp")}__${input.ToolName}`;
    if (input.Arguments && typeof input.Arguments === "object") {
      effectiveInput = input.Arguments as Record<string, unknown>;
    }
  }

  const lower = effectiveName.toLowerCase();
  const isDevspace = lower.includes("devspace");
  const shortKey = effectiveName.replace(/^(mcp[_-]+)?devspace[_/:-]+/i, "");

  let displayName = AGY_TOOL_LABEL_MAP[shortKey] ?? AGY_TOOL_LABEL_MAP[effectiveName];
  if (!displayName) {
    displayName = isDevspace ? `DevSpace · ${shortKey}` : effectiveName;
  }

  const filePath = pickFirstString(effectiveInput, [
    "file_path",
    "path",
    "Path",
    "TargetFile",
    "AbsolutePath",
    "workspace_path",
    "directory",
  ]);
  const command = pickFirstString(effectiveInput, [
    "command",
    "CommandLine",
    "cmd",
    "pattern",
    "Query",
    "query",
  ]);

  let inputSummary = filePath || command || "";
  if (!inputSummary) {
    const firstVal = Object.values(effectiveInput).find((v) => typeof v === "string");
    inputSummary = typeof firstVal === "string" ? firstVal : "";
  }

  let inputRaw = "";
  try {
    inputRaw = JSON.stringify(effectiveInput, null, 2);
  } catch {
    inputRaw = String(effectiveInput);
  }

  return {
    id,
    name: effectiveName,
    displayName,
    inputSummary: truncateText(inputSummary, 90),
    inputRaw: truncateText(inputRaw, 2000),
    status: "running",
    filePath: filePath || undefined,
  };
}

function pickFirstString(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}\n... (已截断，共 ${text.length} 字符)`;
}
