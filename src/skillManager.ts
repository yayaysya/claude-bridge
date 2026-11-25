import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  expandHomePath,
  getRemoteSkillsDir,
  normalizeEngineType,
  resolveRemoteCliPath,
  shellQuote,
} from "./config";
import { ChatSession } from "./sessionStore";

/** 本机 ~/.claude/skills 下的单个 Skill 元信息 */
export interface LocalSkillInfo {
  name: string;
  dirName: string;
  description: string;
  skillFilePath: string;
  fileCount: number;
  updatedAt: number;
}

/** Skill 增量同步到远程 VPS 的结果 */
export interface SkillSyncResult {
  ok: boolean;
  skippedUnchanged?: boolean;
  skillCount: number;
  fileCount: number;
  bytes: number;
  message: string;
}

/** 从历史对话中提炼出的候选编码/协作习惯 */
export interface HabitSuggestion {
  id: string;
  title: string;
  rule: string;
  kind: "rule" | "skill";
  reason: string;
}

interface SkillSyncStateFile {
  version: number;
  byTarget: Record<string, string>;
}

const DATA_DIR = path.join(os.homedir(), ".claude-bridge");
const SKILL_SYNC_STATE_FILE = path.join(DATA_DIR, "skill-sync-state.json");
const MAX_SINGLE_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_SYNC_BYTES = 4 * 1024 * 1024;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
]);

/**
 * 本机 Skill 管理器与对话习惯提炼引擎：
 * - 以本机 ~/.claude/skills/ 为唯一主库，连接或切换 VPS 时按内容指纹增量同步到远程 ~/.claude/skills/；
 * - 同步只覆盖同名本机 Skill 目录，绝不删除远程已有的第三方 Skill；
 * - 支持扫描近期对话中用户纠正 AI 的发言，借助轻模型提炼尚未记录的新习惯供用户勾选采纳。
 */
export class SkillManager {
  constructor(private readonly output: { appendLine(value: string): void }) {}

  public getLocalSkillsDir(): string {
    return path.join(os.homedir(), ".claude", "skills");
  }

  /** 扫描本机 ~/.claude/skills/ 下所有包含 SKILL.md 的 Skill */
  public listLocalSkills(): LocalSkillInfo[] {
    const root = this.getLocalSkillsDir();
    if (!fs.existsSync(root)) {
      return [];
    }

    const result: LocalSkillInfo[] = [];
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const dirPath = path.join(root, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) {
        continue;
      }
      const skillMd = path.join(dirPath, "SKILL.md");
      if (!fs.existsSync(skillMd)) {
        continue;
      }
      try {
        const mdStat = fs.statSync(skillMd);
        const content = fs.readFileSync(skillMd, "utf8");
        const meta = parseSkillFrontmatter(content, entry.name);
        const files = collectSkillFiles(dirPath);
        result.push({
          name: meta.name || entry.name,
          dirName: entry.name,
          description: meta.description || "自定义本地 Skill",
          skillFilePath: skillMd,
          fileCount: files.length || 1,
          updatedAt: mdStat.mtimeMs,
        });
      } catch {
        // 忽略单个损坏 Skill
      }
    }

    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 在本机新建一个标准 Skill 模板并在编辑器中打开 */
  public async createSkillTemplate(
    rawName: string,
    rawDesc: string
  ): Promise<{ ok: boolean; skill?: LocalSkillInfo; message: string }> {
    const cleanName = rawName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "");
    if (!cleanName || !/^[a-z0-9][a-z0-9_-]{1,40}$/.test(cleanName)) {
      return {
        ok: false,
        message: "Skill 名称仅支持小写字母、数字、连字符和下划线（长度 2~40），例如 embedded-c-review。",
      };
    }

    const dirPath = path.join(this.getLocalSkillsDir(), cleanName);
    const skillFile = path.join(dirPath, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      await this.openSkillFile(skillFile);
      return {
        ok: false,
        message: `Skill「${cleanName}」已存在，已为你直接打开编辑。`,
      };
    }

    const desc =
      rawDesc.trim() ||
      `自定义工作流 Skill（触发词：${cleanName}）。`;
    const body = [
      "---",
      `name: ${cleanName}`,
      `description: ${desc}`,
      "---",
      "",
      `# ${cleanName}`,
      "",
      "## 适用场景",
      "",
      "- 在这里说明什么时候使用这套工作流或检查清单。",
      "",
      "## 执行步骤",
      "",
      "1. 第一步做什么。",
      "2. 第二步核对哪些约束。",
      "",
      "## 输出要求",
      "",
      "- 先说结论，再用大白话分点说明，附带真实 `文件:行号`。",
      "",
    ].join("\n");

    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(skillFile, body, "utf8");
    await this.openSkillFile(skillFile);

    const created = this.listLocalSkills().find((s) => s.dirName === cleanName);
    return {
      ok: true,
      skill: created,
      message: `已创建本地 Skill「${cleanName}」，保存后点击「立即同步 Skill」即可推到远程 VPS。`,
    };
  }

  public async openSkillFile(skillFilePath: string): Promise<void> {
    if (!skillFilePath || !fs.existsSync(skillFilePath)) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(skillFilePath)
    );
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** 删除本机 ~/.claude/skills/<dirName>（带路径边界校验） */
  public deleteLocalSkill(dirName: string): { ok: boolean; message: string } {
    const clean = dirName.trim();
    if (!clean || clean.includes("/") || clean.includes("\\") || clean.startsWith(".")) {
      return { ok: false, message: "非法的 Skill 目录名称。" };
    }
    const root = this.getLocalSkillsDir();
    const target = path.join(root, clean);
    if (!fs.existsSync(target)) {
      return { ok: false, message: `未找到本地 Skill「${clean}」。` };
    }
    try {
      const lstat = fs.lstatSync(target);
      if (lstat.isSymbolicLink()) {
        fs.unlinkSync(target);
      } else {
        fs.rmSync(target, { recursive: true, force: true });
      }
      return { ok: true, message: `已删除本地 Skill「${clean}」。` };
    } catch (err) {
      return { ok: false, message: `删除失败：${String(err)}` };
    }
  }

  /** 按内容指纹增量同步本机 ~/.claude/skills/ 到远程 VPS 的 ~/.claude/skills/ */
  public async syncToRemote(
    cfg: BridgeConfig,
    options?: { force?: boolean }
  ): Promise<SkillSyncResult> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return {
        ok: false,
        skillCount: 0,
        fileCount: 0,
        bytes: 0,
        message: "SSH 连接信息尚未配置完成，无法同步 Skill。",
      };
    }

    const skills = this.listLocalSkills();
    if (skills.length === 0) {
      return {
        ok: true,
        skippedUnchanged: true,
        skillCount: 0,
        fileCount: 0,
        bytes: 0,
        message: "本机 ~/.claude/skills/ 暂无可同步的 Skill。",
      };
    }

    const bundleItems: Array<{
      dirName: string;
      files: Array<{ relPath: string; contentB64: string }>;
    }> = [];
    const engine = normalizeEngineType(cfg.engine);
    const remoteSkillsDir = getRemoteSkillsDir(engine);
    const hasher = crypto.createHash("sha256");
    const targetKey = `${engine}:${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort || 22}`;
    hasher.update(`${targetKey}\n${remoteSkillsDir}\n`);

    let totalBytes = 0;
    let totalFiles = 0;

    for (const sk of skills) {
      const dirPath = path.join(this.getLocalSkillsDir(), sk.dirName);
      const relFiles = collectSkillFiles(dirPath);
      const packed: Array<{ relPath: string; contentB64: string }> = [];

      for (const relPath of relFiles) {
        const abs = path.join(dirPath, relPath);
        try {
          const buf = fs.readFileSync(abs);
          if (buf.length > MAX_SINGLE_FILE_BYTES) {
            continue;
          }
          if (totalBytes + buf.length > MAX_TOTAL_SYNC_BYTES) {
            continue;
          }
          totalBytes += buf.length;
          totalFiles += 1;
          hasher.update(`${sk.dirName}/${relPath}\0`);
          hasher.update(buf);
          packed.push({
            relPath,
            contentB64: buf.toString("base64"),
          });
        } catch {
          // 跳过不可读文件
        }
      }

      if (packed.length > 0) {
        bundleItems.push({ dirName: sk.dirName, files: packed });
      }
    }

    const digest = hasher.digest("hex");
    const state = this.loadSyncState();
    if (!options?.force && state.byTarget[targetKey] === digest) {
      return {
        ok: true,
        skippedUnchanged: true,
        skillCount: bundleItems.length,
        fileCount: totalFiles,
        bytes: totalBytes,
        message: "本机 Skill 无变化，已跳过重复同步。",
      };
    }

    const payload = JSON.stringify({ targetDir: remoteSkillsDir, skills: bundleItems });
    const remoteScript = [
      "python3 -c '",
      "import base64, json, os, sys",
      "data = json.loads(sys.stdin.read())",
      "root = os.path.expanduser(data.get(\"targetDir\") or \"~/.claude/skills\")",
      "os.makedirs(root, exist_ok=True)",
      "written = 0",
      "for sk in data.get(\"skills\", []):",
      "    dname = sk[\"dirName\"]",
      "    if not dname or \"/\" in dname or \"..\" in dname:",
      "        continue",
      "    base = os.path.join(root, dname)",
      "    os.makedirs(base, exist_ok=True)",
      "    for f in sk.get(\"files\", []):",
      "        rel = f[\"relPath\"].replace(\"\\\\\", \"/\").lstrip(\"/\")",
      "        if \"..\" in rel.split(\"/\"):",
      "            continue",
      "        dst = os.path.join(base, rel)",
      "        os.makedirs(os.path.dirname(dst), exist_ok=True)",
      "        with open(dst, \"wb\") as out:",
      "            out.write(base64.b64decode(f[\"contentB64\"]))",
      "        written += 1",
      "print(written)",
      "'",
    ].join("\n");

    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteScript,
    ];

    this.output.appendLine(
      `[SkillSync] 正在同步 ${bundleItems.length} 个本地 Skill (${totalFiles} 个文件) 到 ${cfg.sshHost}`
    );

    const execRes = await new Promise<{
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

    if (execRes.code !== 0) {
      const errMsg = execRes.stderr.trim() || `SSH 退出码 ${execRes.code}`;
      this.output.appendLine(`[SkillSync] 同步失败: ${errMsg}`);
      return {
        ok: false,
        skillCount: bundleItems.length,
        fileCount: totalFiles,
        bytes: totalBytes,
        message: `同步 Skill 失败：${errMsg}`,
      };
    }

    state.byTarget[targetKey] = digest;
    this.saveSyncState(state);
    const names = bundleItems.map((b) => b.dirName).join("、");
    this.output.appendLine(
      `[SkillSync] 同步成功: ${bundleItems.length} 个 Skill (${totalFiles} 个文件, ${totalBytes} bytes)`
    );
    return {
      ok: true,
      skillCount: bundleItems.length,
      fileCount: totalFiles,
      bytes: totalBytes,
      message: `已同步 ${bundleItems.length} 个本地 Skill（${names}）到远程 ${remoteSkillsDir}/。`,
    };
  }

  /**
   * 扫描当前项目近期历史对话中用户的纠正与要求，对照现有本地 CLAUDE.md，
   * 用轻模型提炼尚未记录的新习惯建议，供用户勾选采纳。
   */
  public async extractHabitsFromSessions(
    cfg: BridgeConfig,
    sessions: ChatSession[]
  ): Promise<{ ok: boolean; items: HabitSuggestion[]; message: string }> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return { ok: false, items: [], message: "请先配置并连接远程服务器。" };
    }

    const userLines: string[] = [];
    let charBudget = 12_000;
    const ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

    for (const s of ordered) {
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role !== "user") {
          continue;
        }
        const txt = (m.text || "").replace(/\s+/g, " ").trim();
        // 过滤纯礼貌确认短句，保留有信息量的要求与纠正
        if (txt.length < 10 || /^(好的|嗯嗯|可以|行|谢谢|ok|yes)[。.!！]*$/i.test(txt)) {
          continue;
        }
        const entry = `- ${txt.slice(0, 260)}`;
        if (charBudget - entry.length < 0 || userLines.length >= 65) {
          break;
        }
        userLines.push(entry);
        charBudget -= entry.length;
      }
      if (charBudget <= 0 || userLines.length >= 65) {
        break;
      }
    }

    if (userLines.length < 3) {
      return {
        ok: false,
        items: [],
        message: "当前项目的历史对话较少，多聊几轮后再来提炼习惯会更准确。",
      };
    }

    const primaryRulePath = expandHomePath(
      cfg.localClaudeMdPaths[0] || "~/.claude/CLAUDE.md"
    );
    const existingRules = fs.existsSync(primaryRulePath)
      ? fs.readFileSync(primaryRulePath, "utf8").slice(0, 5000)
      : "（暂无）";

    const prompt = [
      "请分析下面用户在近期编程对话里发过的提问和纠正，帮我提炼出**尚未写进现有 CLAUDE.md**、但有长期复用价值的个人编程/协作习惯或可沉淀为 Skill 的固定工作流。",
      "要求：",
      "1. 只返回**严格合法的 JSON 数组**（不要额外解释文字），最多 6 条，宁缺毋滥；如果现有规则已覆盖则返回 []。",
      "2. 每条对象包含字段：title（8~18字短标题）、rule（1~2句简洁中文规则，可直接写入 CLAUDE.md）、kind（\"rule\" 或 \"skill\"）、reason（一句话说明从哪类纠正看出来的）。",
      "3. 忽略一次性具体业务需求（例如某个具体变量名），只提炼跨任务通用习惯。",
      "",
      "=== 现有 CLAUDE.md ===",
      existingRules,
      "",
      "=== 用户近期发言 ===",
      userLines.reverse().join("\n"),
    ].join("\n");

    const engine = normalizeEngineType(cfg.engine);
    const cliBin = shellQuote(resolveRemoteCliPath(cfg));

    const runExtract = (modelArgs: string[]) => {
      const cliArgs =
        engine === "antigravity"
          ? [
              cliBin,
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--mode",
              "plan",
              ...modelArgs,
            ]
          : [
              cliBin,
              "-p",
              "--no-session-persistence",
              ...modelArgs,
              "--output-format",
              "stream-json",
              "--verbose",
              "--permission-mode",
              "plan",
              "--max-turns",
              "1",
            ];
      const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${cliArgs.join(" ")}`;
      const sshArgs = [
        ...buildBaseSshArgs(cfg, { batchMode: true }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        remoteCmd,
      ];

      return new Promise<{ ok: boolean; text: string; reason: string }>((resolve) => {
        const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (v: { ok: boolean; text: string; reason: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // 忽略
          }
          finish({ ok: false, text: "", reason: "分析习惯超时，请稍后重试。" });
        }, 45_000);

        child.stdout?.on("data", (buf: Buffer) => {
          stdout += buf.toString("utf8");
        });
        child.stderr?.on("data", (buf: Buffer) => {
          stderr += buf.toString("utf8");
        });
        child.on("error", (err) => finish({ ok: false, text: "", reason: err.message }));
        child.on("close", (code) => {
          let resultText = "";
          for (const rawLine of stdout.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line.startsWith("{")) continue;
            try {
              const evt = JSON.parse(line) as Record<string, unknown>;
              if (engine === "antigravity") {
                if (evt.event === "step_update") {
                  const su = evt.step_update as Record<string, unknown> | undefined;
                  if (su?.step_type === "agent_response" && typeof su.text_delta === "string") {
                    resultText += su.text_delta;
                  }
                } else if (evt.event === "result") {
                  const r = evt.result as Record<string, unknown> | undefined;
                  if (typeof r?.response === "string" && r.response.trim()) {
                    resultText = r.response.trim();
                  }
                }
              } else if (evt.type === "result" && typeof evt.result === "string") {
                resultText = evt.result.trim();
              }
            } catch {
              // 忽略
            }
          }
          resultText = resultText.trim();
          if (/hit your 5-hour limit|rate limit|quota/i.test(resultText)) {
            finish({ ok: false, text: "", reason: "当前额度已用完，请重置后再试。" });
            return;
          }
          if (code !== 0 || !resultText) {
            finish({
              ok: false,
              text: "",
              reason: resultText || stderr.trim() || "远程分析习惯失败。",
            });
            return;
          }
          finish({ ok: true, text: resultText, reason: "" });
        });
        if (engine === "antigravity") {
          const payload = JSON.stringify({ event: "user", message: { content: prompt } });
          child.stdin?.write(`${payload}\n`, "utf8");
        } else {
          child.stdin?.write(prompt, "utf8");
        }
        child.stdin?.end();
      });
    };

    this.output.appendLine(
      `[Habit] 正在基于近期 ${userLines.length} 条用户发言提炼新习惯 (${engine})...`
    );
    const preferredModelArgs =
      engine === "antigravity"
        ? ["--model", shellQuote("gemini-3.8-flash-medium")]
        : ["--model", "sonnet"];
    let res = await runExtract(preferredModelArgs);
    if (!res.ok && /model|invalid|not found|recognized/i.test(res.reason)) {
      res = await runExtract([]);
    }
    if (!res.ok) {
      return { ok: false, items: [], message: res.reason };
    }

    const parsed = parseHabitSuggestionsJson(res.text);
    if (parsed.length === 0) {
      return {
        ok: true,
        items: [],
        message: "太棒了！你现有的 CLAUDE.md 已经覆盖了近期对话中的主要偏好，暂未发现新遗漏。",
      };
    }

    return {
      ok: true,
      items: parsed,
      message: `从最近 ${userLines.length} 条发言中发现了 ${parsed.length} 条可沉淀的新习惯，请勾选采纳。`,
    };
  }

  /** 将用户勾选认可的习惯条目无损追加到本地 CLAUDE.md */
  public appendRulesToLocalClaudeMd(
    cfg: BridgeConfig,
    rules: string[]
  ): { ok: boolean; filePath: string; added: number; message: string } {
    const cleanRules = rules.map((r) => r.trim()).filter(Boolean);
    if (cleanRules.length === 0) {
      return { ok: false, filePath: "", added: 0, message: "请先勾选至少 1 条要采纳的习惯。" };
    }

    const targetPath = expandHomePath(
      cfg.localClaudeMdPaths[0] || "~/.claude/CLAUDE.md"
    );
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const existing = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, "utf8")
      : "# 个人偏好\n";

    const toAdd = cleanRules.filter((r) => !existing.includes(r));
    if (toAdd.length === 0) {
      return {
        ok: true,
        filePath: targetPath,
        added: 0,
        message: "所选条目已存在于本地 CLAUDE.md 中，无需重复添加。",
      };
    }

    const bulletLines = toAdd.map((r) => (r.startsWith("- ") ? r : `- ${r}`)).join("\n");
    const sectionHeader = "## 从近期对话沉淀的新习惯";
    let nextContent = "";
    if (existing.includes(sectionHeader)) {
      nextContent = `${existing.trimEnd()}\n${bulletLines}\n`;
    } else {
      nextContent = `${existing.trimEnd()}\n\n${sectionHeader}\n\n${bulletLines}\n`;
    }

    fs.writeFileSync(targetPath, nextContent, "utf8");
    return {
      ok: true,
      filePath: targetPath,
      added: toAdd.length,
      message: `已将 ${toAdd.length} 条习惯写入本地 ${path.basename(targetPath)}！`,
    };
  }

  private loadSyncState(): SkillSyncStateFile {
    try {
      if (fs.existsSync(SKILL_SYNC_STATE_FILE)) {
        const parsed = JSON.parse(
          fs.readFileSync(SKILL_SYNC_STATE_FILE, "utf8")
        ) as SkillSyncStateFile;
        if (parsed && parsed.byTarget && typeof parsed.byTarget === "object") {
          return parsed;
        }
      }
    } catch {
      // 忽略
    }
    return { version: 1, byTarget: {} };
  }

  private saveSyncState(state: SkillSyncStateFile): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${SKILL_SYNC_STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, SKILL_SYNC_STATE_FILE);
    } catch {
      // 忽略
    }
  }
}

function parseSkillFrontmatter(
  content: string,
  fallbackName: string
): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: fallbackName, description: "" };
  }
  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(.+)$/m);
  const clean = (s?: string) =>
    (s ?? "").trim().replace(/^["']|["']$/g, "");
  return {
    name: clean(nameMatch?.[1]) || fallbackName,
    description: clean(descMatch?.[1]),
  };
}

function collectSkillFiles(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string, relBase: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      const abs = path.join(cur, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, rel);
      } else if (st.isFile() && st.size <= MAX_SINGLE_FILE_BYTES) {
        out.push(rel);
      }
    }
  };
  walk(rootDir, "");
  return out.sort();
}

function parseHabitSuggestionsJson(raw: string): HabitSuggestion[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1)) as Array<
      Record<string, unknown>
    >;
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .map((item, idx) => ({
        id: `habit_${Date.now()}_${idx}`,
        title: String(item.title ?? "").trim(),
        rule: String(item.rule ?? "").trim(),
        kind: (item.kind === "skill" ? "skill" : "rule") as "rule" | "skill",
        reason: String(item.reason ?? "").trim(),
      }))
      .filter((h) => h.title && h.rule)
      .slice(0, 8);
  } catch {
    return [];
  }
}
