import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  expandHomePath,
  resolveSshProxy,
} from "./config";
import { BridgeLogger } from "./logger";

const MEMORY_BACKUP_DIR = path.join(
  os.homedir(),
  ".claude-bridge",
  "remote-memory"
);

/** 单条远程 Claude 自动记忆条目 */
export interface RemoteMemoryItem {
  id: string;
  fileName: string;
  remotePath: string;
  localBackupPath: string;
  title: string;
  preview: string;
  modifiedAt: number;
  content: string;
}

export interface PullMemoriesResult {
  ok: boolean;
  items: RemoteMemoryItem[];
  backupDir: string;
  message: string;
}

/**
 * 远程 Claude 记忆拉取、本地备份与本地 CLAUDE.md 管理工具
 */
export class MemoryManager {
  constructor(private readonly logger: BridgeLogger) {}

  public getBackupDir(): string {
    return MEMORY_BACKUP_DIR;
  }

  /** 在 VS Code 编辑器中打开本地 CLAUDE.md（配置了多文件时弹选择器） */
  public async openLocalClaudeMd(cfg: BridgeConfig): Promise<void> {
    const rawList =
      cfg.localClaudeMdPaths.length > 0
        ? cfg.localClaudeMdPaths
        : ["~/.claude/CLAUDE.md"];
    const resolvedList = rawList.map((p) => expandHomePath(p)).filter(Boolean);

    let targetPath: string | undefined;
    if (resolvedList.length === 1) {
      targetPath = resolvedList[0];
    } else {
      const picked = await vscode.window.showQuickPick(
        resolvedList.map((filePath) => ({
          label: path.basename(filePath),
          description: fs.existsSync(filePath) ? filePath : `${filePath} (尚未创建)`,
          filePath,
        })),
        { placeHolder: "选择要打开的本地规则文件" }
      );
      targetPath = picked?.filePath;
    }

    if (!targetPath) {
      return;
    }

    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, "# 个人偏好与开发规范\n\n", "utf8");
    }

    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(targetPath)
    );
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** 读取本地已备份的远程记忆列表（无需联网即可先展示缓存） */
  public listCachedBackups(): RemoteMemoryItem[] {
    if (!fs.existsSync(MEMORY_BACKUP_DIR)) {
      return [];
    }
    const manifestPath = path.join(MEMORY_BACKUP_DIR, ".manifest.json");
    if (!fs.existsSync(manifestPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as RemoteMemoryItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 从远程服务器拉取 ~/.claude/projects 下各项目的 memory 目录并备份到本地 */
  public async pullRemoteMemories(
    cfg: BridgeConfig
  ): Promise<PullMemoriesResult> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return {
        ok: false,
        items: [],
        backupDir: MEMORY_BACKUP_DIR,
        message: "尚未配置远程服务器连接信息。",
      };
    }

    const remotePy = [
      "python3 -c '",
      "import glob, json, os",
      "base = os.path.expanduser(\"~/.claude/projects\")",
      "files = sorted(glob.glob(os.path.join(base, \"*\", \"memory\", \"*.md\")))",
      "out = []",
      "for fp in files:",
      "    try:",
      "        st = os.stat(fp)",
      "        txt = open(fp, \"r\", encoding=\"utf-8\", errors=\"replace\").read()",
      "        rel = os.path.relpath(fp, base)",
      "        out.append({\"remotePath\": fp, \"rel\": rel, \"fileName\": os.path.basename(fp), \"mtime\": int(st.st_mtime * 1000), \"content\": txt})",
      "    except Exception:",
      "        pass",
      "print(json.dumps(out, ensure_ascii=False))",
      "'",
    ].join("\n");

    const proxy = resolveSshProxy(cfg);
    const args = [
      ...buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      remotePy,
    ];

    this.logger.info("Memory", "正在从远程拉取 Claude 自动记忆 (memory/*.md)");

    const rawOut = await new Promise<{
      ok: boolean;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      execFile(
        "ssh",
        args,
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              stdout: stdout ?? "",
              stderr: (stderr ?? "").trim() || err.message,
            });
            return;
          }
          resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      );
    });

    if (!rawOut.ok) {
      this.logger.warn("Memory", `拉取远程记忆失败: ${rawOut.stderr}`);
      return {
        ok: false,
        items: this.listCachedBackups(),
        backupDir: MEMORY_BACKUP_DIR,
        message: `拉取远程记忆失败：${rawOut.stderr}`,
      };
    }

    let remoteFiles: Array<{
      remotePath: string;
      rel: string;
      fileName: string;
      mtime: number;
      content: string;
    }> = [];
    try {
      remoteFiles = JSON.parse(rawOut.stdout.trim() || "[]");
    } catch (err) {
      return {
        ok: false,
        items: this.listCachedBackups(),
        backupDir: MEMORY_BACKUP_DIR,
        message: `解析远程记忆数据失败：${String(err)}`,
      };
    }

    fs.mkdirSync(MEMORY_BACKUP_DIR, { recursive: true });
    const items: RemoteMemoryItem[] = [];

    for (const rf of remoteFiles) {
      // 安全落盘到本地备份目录
      const safeName = rf.rel.replace(/[\\/]+/g, "__");
      const localPath = path.join(MEMORY_BACKUP_DIR, safeName);
      fs.writeFileSync(localPath, rf.content, "utf8");

      const { title, preview } = extractMemorySummary(rf.fileName, rf.content);
      items.push({
        id: safeName,
        fileName: rf.fileName,
        remotePath: rf.remotePath,
        localBackupPath: localPath,
        title,
        preview,
        modifiedAt: rf.mtime || Date.now(),
        content: rf.content,
      });
    }

    // 排序：非 MEMORY.md 索引条目按最近修改倒序，MEMORY.md 排在最前
    items.sort((a, b) => {
      if (a.fileName === "MEMORY.md") return -1;
      if (b.fileName === "MEMORY.md") return 1;
      return b.modifiedAt - a.modifiedAt;
    });

    fs.writeFileSync(
      path.join(MEMORY_BACKUP_DIR, ".manifest.json"),
      JSON.stringify(items, null, 2),
      "utf8"
    );

    this.logger.info(
      "Memory",
      `已拉取并备份 ${items.length} 个远程记忆文件至 ${MEMORY_BACKUP_DIR}`
    );

    return {
      ok: true,
      items,
      backupDir: MEMORY_BACKUP_DIR,
      message:
        items.length > 0
          ? `已拉取并备份 ${items.length} 条远程记忆至 ~/.claude-bridge/remote-memory/`
          : "远程 Claude 当前尚未保存任何自动记忆条目。",
    };
  }

  /** 将某条远程记忆的正文追加合并到用户第一个本地 CLAUDE.md */
  public async mergeMemoryIntoLocalClaudeMd(
    cfg: BridgeConfig,
    item: RemoteMemoryItem
  ): Promise<string> {
    const rawTarget =
      cfg.localClaudeMdPaths.length > 0
        ? cfg.localClaudeMdPaths[0]
        : "~/.claude/CLAUDE.md";
    const targetPath = expandHomePath(rawTarget);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const cleanedBody = stripFrontmatter(item.content).trim();
    const section = `\n\n<!-- imported from remote memory: ${item.fileName} -->\n### ${item.title}\n\n${cleanedBody}\n`;

    const existing = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, "utf8")
      : "";
    if (existing.includes(`imported from remote memory: ${item.fileName}`)) {
      return `本地 ${path.basename(targetPath)} 中已包含该记忆条目，未重复写入。`;
    }

    fs.appendFileSync(targetPath, section, "utf8");
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(targetPath)
    );
    await vscode.window.showTextDocument(doc, { preview: false });
    return `已将「${item.title}」合并到本地 ${targetPath}`;
  }
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function extractMemorySummary(
  fileName: string,
  content: string
): { title: string; preview: string } {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let title = fileName === "MEMORY.md" ? "MEMORY.md（记忆索引）" : fileName.replace(/\.md$/i, "");
  let desc = "";

  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
    if (nameMatch?.[1]?.trim()) {
      title = nameMatch[1].trim();
    }
    if (descMatch?.[1]?.trim()) {
      desc = descMatch[1].trim();
    }
  }

  const body = stripFrontmatter(content)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .join(" ");

  const preview = (desc || body).slice(0, 120);
  return { title, preview };
}
