import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { getActiveWorkspacePath } from "./config";

/** 本地仓库 Git 实时概况（纯只读查询） */
export interface GitSummary {
  isGitRepo: boolean;
  branch: string;
  lastCommit: string;
  changedCount: number;
  statusLines: string[];
  diffStat: string;
}

/** 轻量级界面展示用 Git 状态 */
export interface GitBadgeInfo {
  workspaceName: string;
  workspacePath: string;
  isGitRepo: boolean;
  branch: string;
  changedCount: number;
}

/** 每次发消息时采集的实时本地工作区快照 */
export interface WorkspaceSnapshot {
  workspaceFolders: string[];
  primaryWorkspace?: string;
  workspaceName?: string;
  activeFile?: {
    filePath: string;
    relativePath: string;
    line: number;
    selectionRange?: string;
  };
  openFiles: string[];
  git?: GitSummary;
}

function runGit(cwd: string, args: string[], timeoutMs = 2500): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** 获取用于欢迎页和输入区展示的轻量分支与改动数 */
export async function collectGitBadgeInfo(): Promise<GitBadgeInfo | undefined> {
  const primary = getActiveWorkspacePath();
  if (!primary) {
    return undefined;
  }
  const workspaceName = path.basename(primary);

  const inside = await runGit(primary, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.trim() !== "true") {
    return {
      workspaceName,
      workspacePath: primary,
      isGitRepo: false,
      branch: "",
      changedCount: 0,
    };
  }

  const [branchOut, statusOut] = await Promise.all([
    runGit(primary, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(primary, ["status", "--porcelain"]),
  ]);

  let branch = (branchOut ?? "").trim();
  if (branch === "HEAD" || !branch) {
    const shortSha = await runGit(primary, ["rev-parse", "--short", "HEAD"]);
    branch = shortSha ? `detached@${shortSha.trim()}` : "HEAD";
  }

  const lines = (statusOut ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  return {
    workspaceName,
    workspacePath: primary,
    isGitRepo: true,
    branch,
    changedCount: lines.length,
  };
}

/** 采集当前工作区、活动文件与 Git 实时状态快照（发送消息前现采） */
export async function collectWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(
    (f) => f.uri.fsPath
  );
  const primary = folders[0];
  const workspaceName = primary ? path.basename(primary) : undefined;

  // 当前激活编辑器与光标行号
  let activeFile: WorkspaceSnapshot["activeFile"];
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    const filePath = editor.document.uri.fsPath;
    const relativePath =
      primary && filePath.startsWith(primary + path.sep)
        ? path.relative(primary, filePath)
        : filePath;
    const sel = editor.selection;
    activeFile = {
      filePath,
      relativePath,
      line: sel.active.line + 1,
      selectionRange: !sel.isEmpty
        ? `${sel.start.line + 1}-${sel.end.line + 1}`
        : undefined,
    };
  }

  // 其他已打开的本地文件标签页（最多 8 个）
  const openSet = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      if (input?.uri && input.uri.scheme === "file") {
        const fsPath = input.uri.fsPath;
        if (fsPath !== activeFile?.filePath) {
          openSet.add(fsPath);
        }
      }
      if (openSet.size >= 8) {
        break;
      }
    }
    if (openSet.size >= 8) {
      break;
    }
  }

  // Git 实时状态（只读）
  let git: GitSummary | undefined;
  if (primary) {
    const inside = await runGit(primary, ["rev-parse", "--is-inside-work-tree"]);
    if (inside && inside.trim() === "true") {
      const [branchOut, commitOut, statusOut, unstagedStat, stagedStat] =
        await Promise.all([
          runGit(primary, ["rev-parse", "--abbrev-ref", "HEAD"]),
          runGit(primary, ["log", "-1", "--oneline"]),
          runGit(primary, ["status", "--short"]),
          runGit(primary, ["diff", "--stat"]),
          runGit(primary, ["diff", "--cached", "--stat"]),
        ]);

      let branch = (branchOut ?? "").trim();
      if (branch === "HEAD" || !branch) {
        const shortSha = await runGit(primary, ["rev-parse", "--short", "HEAD"]);
        branch = shortSha ? `detached@${shortSha.trim()}` : "HEAD";
      }

      const allStatusLines = (statusOut ?? "")
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0);
      const maxLines = 30;
      const statusLines = allStatusLines.slice(0, maxLines);
      if (allStatusLines.length > maxLines) {
        statusLines.push(
          `... and ${allStatusLines.length - maxLines} more changed files`
        );
      }

      const statParts: string[] = [];
      if (stagedStat && stagedStat.trim()) {
        statParts.push(`[staged]\n${limitLines(stagedStat.trim(), 20)}`);
      }
      if (unstagedStat && unstagedStat.trim()) {
        statParts.push(`[unstaged]\n${limitLines(unstagedStat.trim(), 20)}`);
      }

      git = {
        isGitRepo: true,
        branch,
        lastCommit: (commitOut ?? "").trim(),
        changedCount: allStatusLines.length,
        statusLines,
        diffStat: statParts.join("\n"),
      };
    } else {
      git = {
        isGitRepo: false,
        branch: "",
        lastCommit: "",
        changedCount: 0,
        statusLines: [],
        diffStat: "",
      };
    }
  }

  return {
    workspaceFolders: folders,
    primaryWorkspace: primary,
    workspaceName,
    activeFile,
    openFiles: Array.from(openSet),
    git,
  };
}

/** 格式化为紧凑的英文实时上下文块，附在发给远程 Claude 的消息前 */
export function formatSnapshotForPrompt(snapshot: WorkspaceSnapshot): string {
  const lines: string[] = ["<ide_workspace_context>"];

  if (snapshot.primaryWorkspace) {
    lines.push(`Local Workspace Root: ${snapshot.primaryWorkspace}`);
    if (snapshot.workspaceFolders.length > 1) {
      lines.push(
        `Additional Workspace Folders: ${snapshot.workspaceFolders.slice(1).join(", ")}`
      );
    }
  }

  if (snapshot.activeFile) {
    const selInfo = snapshot.activeFile.selectionRange
      ? `, selection lines ${snapshot.activeFile.selectionRange}`
      : "";
    lines.push(
      `Active Editor File: ${snapshot.activeFile.filePath} (cursor line ${snapshot.activeFile.line}${selInfo})`
    );
  }

  if (snapshot.openFiles.length > 0) {
    lines.push(`Other Open Files: ${snapshot.openFiles.join(", ")}`);
  }

  if (snapshot.git?.isGitRepo) {
    lines.push(`Git Branch: ${snapshot.git.branch}`);
    if (snapshot.git.lastCommit) {
      lines.push(`Latest Commit: ${snapshot.git.lastCommit}`);
    }
    if (snapshot.git.changedCount === 0) {
      lines.push("Git Working Tree: clean (no uncommitted changes)");
    } else {
      lines.push(
        `Git Status (${snapshot.git.changedCount} changed):\n${snapshot.git.statusLines.join("\n")}`
      );
      if (snapshot.git.diffStat) {
        lines.push(`Git Diff Stat:\n${snapshot.git.diffStat}`);
      }
    }
  }

  lines.push(
    "Instruction: All paths and git status above belong to the user's local machine. Use devspace MCP tools to open the workspace and read detailed file contents or full git diff."
  );
  lines.push("</ide_workspace_context>");
  return lines.join("\n");
}

function limitLines(text: string, maxLines: number): string {
  const arr = text.split(/\r?\n/);
  if (arr.length <= maxLines) {
    return text;
  }
  return `${arr.slice(0, maxLines).join("\n")}\n... (${arr.length - maxLines} more lines)`;
}
