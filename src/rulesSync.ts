import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { BridgeConfig, buildBaseSshArgs, expandHomePath } from "./config";

const MARKER_START = "<!-- EC2-CLAUDE-BRIDGE:LOCAL-RULES:START -->";
const MARKER_END = "<!-- EC2-CLAUDE-BRIDGE:LOCAL-RULES:END -->";

const DEFAULT_ROUTING_HEADER = `# Workspace Routing Rule (DevSpace MCP)

You are running on a remote host, while the user's actual code repositories live on their local machine and are exposed through the \`devspace\` MCP server.

## Mandatory Rules
1. Always prefer \`devspace\` MCP tools to open, browse, search, read, edit, and run commands in the user's local project directories.
2. Do NOT use remote host filesystem tools (\`Read\`, \`Edit\`, \`Write\`, \`Glob\`, \`Grep\`, \`Bash\`) to look for or modify the user's project source code unless explicitly asked to inspect this remote machine itself.
`;

export interface RulesSyncResult {
  ok: boolean;
  skippedUnchanged?: boolean;
  files: string[];
  bytes: number;
  message: string;
}

const RULES_HASH_STORAGE_KEY = "ec2Claude.lastSyncedRulesHash.v1";

/**
 * 本地 CLAUDE.md 规则同步器
 * 使用起止标记区块无损合并到远程 ~/.claude/CLAUDE.md，
 * 并通过 globalState 持久化内容指纹，重启 VS Code 后内容无变化也不重复传输。
 */
export class RulesSyncManager {
  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly state: vscode.Memento
  ) {}

  /** 读取本地配置的所有规则文件并同步至远程 ~/.claude/CLAUDE.md */
  public async sync(
    cfg: BridgeConfig,
    options?: { force?: boolean }
  ): Promise<RulesSyncResult> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return {
        ok: false,
        files: [],
        bytes: 0,
        message: "SSH 连接信息尚未配置完成，无法同步规则。",
      };
    }

    const configuredPaths =
      cfg.localClaudeMdPaths.length > 0
        ? cfg.localClaudeMdPaths
        : ["~/.claude/CLAUDE.md"];

    const existingFiles: Array<{ filePath: string; content: string }> = [];
    for (const rawPath of configuredPaths) {
      const resolved = expandHomePath(rawPath);
      if (!resolved || !fs.existsSync(resolved)) {
        continue;
      }
      try {
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) {
          continue;
        }
        const text = fs.readFileSync(resolved, "utf8").trim();
        if (text) {
          existingFiles.push({ filePath: resolved, content: text });
        }
      } catch (err) {
        this.output.appendLine(`[RulesSync] 读取失败 ${resolved}: ${String(err)}`);
      }
    }

    if (existingFiles.length === 0) {
      return {
        ok: false,
        files: [],
        bytes: 0,
        message: `未找到可同步的本地规则文件（检查路径：${configuredPaths.join(", ")}）`,
      };
    }

    const mergedBody = existingFiles
      .map((item) => {
        if (existingFiles.length === 1) {
          return item.content;
        }
        return `<!-- source: ${path.basename(item.filePath)} -->\n${item.content}`;
      })
      .join("\n\n---\n\n");

    const hash = crypto
      .createHash("sha256")
      .update(`${cfg.sshHost}:${cfg.sshUser}\n${mergedBody}`)
      .digest("hex");

    const savedHash = this.state.get<string>(RULES_HASH_STORAGE_KEY);
    if (!options?.force && savedHash === hash) {
      return {
        ok: true,
        skippedUnchanged: true,
        files: existingFiles.map((f) => f.filePath),
        bytes: Buffer.byteLength(mergedBody, "utf8"),
        message: "本地 CLAUDE.md 无变化，已跳过重复同步。",
      };
    }

    const payload = JSON.stringify({
      markerStart: MARKER_START,
      markerEnd: MARKER_END,
      defaultHeader: DEFAULT_ROUTING_HEADER,
      localRules: mergedBody,
    });

    // 在远程使用 python3 安全做标记区块合并，避免 shell 转义问题
    const remoteScript = [
      "python3 -c '",
      "import json, os, sys",
      "data = json.loads(sys.stdin.read())",
      "target = os.path.expanduser(\"~/.claude/CLAUDE.md\")",
      "os.makedirs(os.path.dirname(target), exist_ok=True)",
      "existing = open(target, \"r\", encoding=\"utf-8\").read() if os.path.exists(target) else \"\"",
      "s, e = data[\"markerStart\"], data[\"markerEnd\"]",
      "block = s + \"\\n\" + data[\"localRules\"].strip() + \"\\n\" + e",
      "if s in existing and e in existing and existing.index(s) < existing.index(e):",
      "    before = existing[:existing.index(s)].rstrip()",
      "    after = existing[existing.index(e) + len(e):].lstrip()",
      "    parts = [p for p in [before, block, after] if p]",
      "    updated = \"\\n\\n\".join(parts) + \"\\n\"",
      "else:",
      "    base = existing.strip() if existing.strip() else data[\"defaultHeader\"].strip()",
      "    updated = base + \"\\n\\n\" + block + \"\\n\"",
      "with open(target, \"w\", encoding=\"utf-8\") as f:",
      "    f.write(updated)",
      "print(len(updated.encode(\"utf-8\")))",
      "'",
    ].join("\n");

    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteScript,
    ];

    this.output.appendLine(
      `[RulesSync] 正在同步 ${existingFiles.length} 个本地规则文件到远程 ~/.claude/CLAUDE.md`
    );

    const execResult = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
      });
      child.on("error", (err) => {
        resolve({ code: -1, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
      child.stdin?.write(payload, "utf8");
      child.stdin?.end();
    });

    if (execResult.code !== 0) {
      const errMsg = execResult.stderr.trim() || `SSH 退出码 ${execResult.code}`;
      this.output.appendLine(`[RulesSync] 同步失败: ${errMsg}`);
      return {
        ok: false,
        files: existingFiles.map((f) => f.filePath),
        bytes: 0,
        message: `同步本地规则失败：${errMsg}`,
      };
    }

    await this.state.update(RULES_HASH_STORAGE_KEY, hash);
    const totalBytes = Buffer.byteLength(mergedBody, "utf8");
    const fileNames = existingFiles.map((f) => path.basename(f.filePath)).join(", ");
    this.output.appendLine(
      `[RulesSync] 同步成功: ${fileNames} (${totalBytes} bytes)`
    );
    return {
      ok: true,
      files: existingFiles.map((f) => f.filePath),
      bytes: totalBytes,
      message: `已同步本地规则（${fileNames}，${totalBytes} 字节）到远程 ~/.claude/CLAUDE.md`,
    };
  }
}
