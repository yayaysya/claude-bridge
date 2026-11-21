import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getActiveWorkspacePath,
  shellQuote,
} from "./config";
import { ChatMessage, ContextAttachment, ToolCallRecord } from "./sessionStore";

/** 远程对话执行回调 */
export interface ClaudeRunCallbacks {
  onUpdate: () => void;
  onSessionId: (claudeSessionId: string) => void;
}

/** 单次远程对话句柄，支持随时取消 */
export interface ClaudeRunHandle {
  promise: Promise<void>;
  abort: () => void;
}

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
 * 远程 Claude Code 流式客户端
 * 通过 SSH 将 Prompt 经由 stdin 传给 EC2 上的 `claude -p --output-format stream-json`，
 * 实时解析流式文本、思考过程与工具调用状态。
 */
export class ClaudeClient {
  private activeChild: ChildProcess | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

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

  /** 发起一轮流式远程对话 */
  public runTurn(params: {
    cfg: BridgeConfig;
    prompt: string;
    claudeSessionId?: string;
    assistantMsg: ChatMessage;
    callbacks: ClaudeRunCallbacks;
  }): ClaudeRunHandle {
    const { cfg, prompt, claudeSessionId, assistantMsg, callbacks } = params;
    this.abort();

    const claudeArgs: string[] = [
      shellQuote(cfg.remoteClaudePath || "claude"),
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

      if (evtType === "result") {
        if (typeof evt.session_id === "string" && evt.session_id) {
          callbacks.onSessionId(evt.session_id);
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
