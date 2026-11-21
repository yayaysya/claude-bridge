import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

/** 远程 Claude Code 支持的权限模式 */
export type PermissionMode =
  | "bypassPermissions"
  | "acceptEdits"
  | "plan"
  | "dontAsk";

/** 远程 Claude Code 支持的思考强度档位（空字符串表示跟随默认） */
export type EffortLevel = "" | "low" | "medium" | "high" | "xhigh" | "max";

/** 插件核心运行配置 */
export interface BridgeConfig {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string;
  localPort: number;
  remotePort: number;
  devspacePath: string;
  remoteClaudePath: string;
  permissionMode: PermissionMode;
  model: string;
  effort: EffortLevel;
  autoConnect: boolean;
  autoReconnect: boolean;
  keepRunningOnClose: boolean;
  autoAttachWorkspaceContext: boolean;
  syncLocalRules: boolean;
  localClaudeMdPaths: string[];
}

/** 展开路径开头的 ~ 为当前用户家目录 */
export function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** 读取当前插件配置 */
export function getBridgeConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration("ec2Claude");

  const permissionMode = cfg.get<string>("permissionMode", "bypassPermissions");
  const validModes: PermissionMode[] = [
    "bypassPermissions",
    "acceptEdits",
    "plan",
    "dontAsk",
  ];
  const resolvedMode: PermissionMode = validModes.includes(
    permissionMode as PermissionMode
  )
    ? (permissionMode as PermissionMode)
    : "bypassPermissions";

  const effortRaw = cfg.get<string>("effort", "").trim();
  const validEfforts: EffortLevel[] = ["", "low", "medium", "high", "xhigh", "max"];
  const resolvedEffort: EffortLevel = validEfforts.includes(
    effortRaw as EffortLevel
  )
    ? (effortRaw as EffortLevel)
    : "";

  return {
    sshHost: cfg.get<string>("sshHost", "").trim(),
    sshUser: cfg.get<string>("sshUser", "ubuntu").trim(),
    sshPort: cfg.get<number>("sshPort", 22),
    sshKeyPath: expandHomePath(cfg.get<string>("sshKeyPath", "")),
    localPort: cfg.get<number>("localPort", 7676),
    remotePort: cfg.get<number>("remotePort", 7676),
    devspacePath: expandHomePath(cfg.get<string>("devspacePath", "")),
    remoteClaudePath: cfg.get<string>("remoteClaudePath", "claude").trim(),
    permissionMode: resolvedMode,
    model: cfg.get<string>("model", "").trim(),
    effort: resolvedEffort,
    autoConnect: cfg.get<boolean>("autoConnect", true),
    autoReconnect: cfg.get<boolean>("autoReconnect", true),
    keepRunningOnClose: cfg.get<boolean>("keepRunningOnClose", false),
    autoAttachWorkspaceContext: cfg.get<boolean>(
      "autoAttachWorkspaceContext",
      true
    ),
    syncLocalRules: cfg.get<boolean>("syncLocalRules", false),
    localClaudeMdPaths: cfg.get<string[]>("localClaudeMdPaths", [
      "~/.claude/CLAUDE.md",
    ]),
  };
}

/** 更新全局权限模式 */
export async function updatePermissionMode(
  mode: PermissionMode
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ec2Claude");
  await cfg.update("permissionMode", mode, vscode.ConfigurationTarget.Global);
}

/** 更新全局模型设置 */
export async function updateModel(model: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ec2Claude");
  await cfg.update("model", model, vscode.ConfigurationTarget.Global);
}

/** 更新全局思考强度设置 */
export async function updateEffort(effort: EffortLevel): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ec2Claude");
  await cfg.update("effort", effort, vscode.ConfigurationTarget.Global);
}

/**
 * 构造基础 SSH 参数：
 * 关键隔离点：显式禁止透传本地 LANG / LC_* 环境变量，不向远程暴露本地语言特征。
 */
export function buildBaseSshArgs(
  cfg: BridgeConfig,
  options?: { batchMode?: boolean }
): string[] {
  const args: string[] = [
    "-i",
    cfg.sshKeyPath,
    "-p",
    String(cfg.sshPort),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "SendEnv=-LANG",
    "-o",
    "SendEnv=-LC_*",
  ];

  if (options?.batchMode !== false) {
    args.push("-o", "BatchMode=yes");
  }

  return args;
}

/** 查找可用的本地 devspace 可执行文件路径 */
export function resolveDevspaceBinary(cfg: BridgeConfig): string {
  if (cfg.devspacePath && fs.existsSync(cfg.devspacePath)) {
    return cfg.devspacePath;
  }

  // 自动扫描 nvm 安装目录，避免非交互环境 PATH 缺失 nvm 路径
  const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
  if (fs.existsSync(nvmDir)) {
    const versions = fs.readdirSync(nvmDir).sort().reverse();
    for (const ver of versions) {
      const candidate = path.join(nvmDir, ver, "bin", "devspace");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return "devspace";
}

/** POSIX shell 单引号安全转义 */
export function shellQuote(raw: string): string {
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

/** 获取当前 VS Code 打开的主工作区路径 */
export function getActiveWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}
