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
  sshProxy: string;
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
    sshProxy: cfg.get<string>("sshProxy", "auto").trim(),
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

/** 更新全局自动同步本地 CLAUDE.md 开关 */
export async function updateSyncLocalRules(enabled: boolean): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("ec2Claude");
  await cfg.update("syncLocalRules", enabled, vscode.ConfigurationTarget.Global);
}

/** 解析后的 SSH 代理配置 */
export interface ResolvedSshProxy {
  protocol: "connect" | "5";
  host: string;
  port: number;
  display: string;
}

/**
 * 动态解析 SSH 代理设置（不写死任何端口）：
 * - off / none：直连
 * - auto：自动读取环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 * - 手动地址：支持 http://host:port、socks5://host:port 或 host:port
 */
export function resolveSshProxy(cfg: BridgeConfig): ResolvedSshProxy | undefined {
  const rawSetting = (cfg.sshProxy || "auto").trim();
  const lower = rawSetting.toLowerCase();
  if (lower === "off" || lower === "none" || lower === "direct") {
    return undefined;
  }

  let candidate = rawSetting;
  if (lower === "auto" || !candidate) {
    candidate =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      "";
  }

  candidate = candidate.trim();
  if (!candidate) {
    return undefined;
  }

  const normalized = /^[a-z0-9+.-]+:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.trim();
    const port = Number(parsed.port);
    if (
      !host ||
      !/^[a-zA-Z0-9._:-]+$/.test(host) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      return undefined;
    }
    const isSocks = parsed.protocol.toLowerCase().startsWith("socks");
    return {
      protocol: isSocks ? "5" : "connect",
      host,
      port,
      display: `${isSocks ? "socks5" : "http"}://${host}:${port}`,
    };
  } catch {
    return undefined;
  }
}

/**
 * 构造基础 SSH 参数：
 * 1. 显式禁止透传本地 LANG / LC_* 环境变量，不向远程暴露本地语言特征；
 * 2. 按 sshProxy 设置动态挂载 nc ProxyCommand（支持 HTTP CONNECT 与 SOCKS5）。
 */
export function buildBaseSshArgs(
  cfg: BridgeConfig,
  options?: { batchMode?: boolean; proxy?: ResolvedSshProxy | null }
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
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "SendEnv=-LANG",
    "-o",
    "SendEnv=-LC_*",
  ];

  const effectiveProxy =
    options?.proxy === undefined ? resolveSshProxy(cfg) : options.proxy;
  if (effectiveProxy) {
    args.push(
      "-o",
      `ProxyCommand=nc -X ${effectiveProxy.protocol} -x ${effectiveProxy.host}:${effectiveProxy.port} %h %p`
    );
  }

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
