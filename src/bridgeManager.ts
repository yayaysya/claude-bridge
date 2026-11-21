import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { ChildProcess, execFile, spawn } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getBridgeConfig,
  resolveDevspaceBinary,
} from "./config";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/** 连接桥实时状态快照 */
export interface BridgeState {
  status: ConnectionStatus;
  devspaceReady: boolean;
  tunnelReady: boolean;
  detail: string;
  lastConnectedAt?: number;
  managedDevspace: boolean;
  managedTunnel: boolean;
}

/**
 * 本地 DevSpace MCP + SSH 反向隧道连接管家
 * 负责一键启动、复用已有健康进程、断线自动重连、休眠唤醒自愈。
 */
export class BridgeManager implements vscode.Disposable {
  private devspaceProc: ChildProcess | undefined;
  private tunnelProc: ChildProcess | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private manualDisconnected = false;
  private connectingPromise: Promise<boolean> | undefined;

  private state: BridgeState = {
    status: "disconnected",
    devspaceReady: false,
    tunnelReady: false,
    detail: "尚未连接",
    managedDevspace: false,
    managedTunnel: false,
  };

  private readonly stateEmitter = new vscode.EventEmitter<BridgeState>();
  public readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly output: vscode.OutputChannel) {}

  public getState(): BridgeState {
    return { ...this.state };
  }

  /** 启动或重连本地 DevSpace 与 SSH 反向隧道 */
  public async connect(forceReconnect = false): Promise<boolean> {
    if (this.connectingPromise && !forceReconnect) {
      return this.connectingPromise;
    }

    this.manualDisconnected = false;
    this.clearReconnectTimer();

    if (forceReconnect) {
      this.stopManagedTunnel();
    }

    this.connectingPromise = this.doConnect().finally(() => {
      this.connectingPromise = undefined;
    });
    return this.connectingPromise;
  }

  /** 主动断开连接，停止自动重连 */
  public disconnect(): void {
    this.manualDisconnected = true;
    this.clearReconnectTimer();
    this.stopHealthCheck();
    this.stopManagedTunnel();
    this.stopManagedDevspace();

    this.setState({
      status: "disconnected",
      devspaceReady: false,
      tunnelReady: false,
      detail: "已手动断开",
      managedDevspace: false,
      managedTunnel: false,
    });
    this.log("已手动断开连接");
  }

  private async doConnect(): Promise<boolean> {
    const cfg = getBridgeConfig();
    this.setState({
      ...this.state,
      status: "connecting",
      detail: "正在检查本地 DevSpace 与 SSH 隧道...",
    });

    // 1. 基础配置与密钥检查
    if (!cfg.sshHost || !cfg.sshUser) {
      this.fail("SSH 主机或用户名未配置");
      return false;
    }
    if (!fs.existsSync(cfg.sshKeyPath)) {
      this.fail(`找不到 SSH 密钥文件: ${cfg.sshKeyPath}`);
      return false;
    }

    // 自动确保私钥权限为 600，防止 SSH 拒绝加载
    try {
      const stat = fs.statSync(cfg.sshKeyPath);
      if ((stat.mode & 0o077) !== 0) {
        fs.chmodSync(cfg.sshKeyPath, 0o600);
        this.log(`已自动修正密钥权限为 600: ${cfg.sshKeyPath}`);
      }
    } catch (err) {
      this.log(`检查密钥权限失败: ${String(err)}`);
    }

    // 2. 启动或复用本地 DevSpace MCP
    const devspaceOk = await this.ensureDevspace(cfg);
    if (!devspaceOk) {
      this.fail(`本地 DevSpace 启动失败（端口 ${cfg.localPort}）`);
      this.scheduleReconnectIfNeeded(cfg);
      return false;
    }

    // 3. 建立或复用 SSH 反向隧道
    const tunnelOk = await this.ensureTunnel(cfg);
    if (!tunnelOk) {
      this.fail(`SSH 反向隧道建立失败（${cfg.sshUser}@${cfg.sshHost}）`);
      this.scheduleReconnectIfNeeded(cfg);
      return false;
    }

    this.reconnectAttempts = 0;
    this.setState({
      status: "connected",
      devspaceReady: true,
      tunnelReady: true,
      detail: `已连通 ${cfg.sshHost} (127.0.0.1:${cfg.remotePort})`,
      lastConnectedAt: Date.now(),
      managedDevspace: Boolean(this.devspaceProc),
      managedTunnel: Boolean(this.tunnelProc),
    });
    this.log(`连接就绪：本地 :${cfg.localPort} <-> EC2(${cfg.sshHost}) :${cfg.remotePort}`);
    this.startHealthCheck();
    return true;
  }

  /** 确保本地 DevSpace MCP 正常监听 */
  private async ensureDevspace(cfg: BridgeConfig): Promise<boolean> {
    const alreadyListening = await this.isLocalPortListening(cfg.localPort);
    if (alreadyListening) {
      this.log(`检测到本地端口 ${cfg.localPort} 已有 DevSpace 监听，直接复用`);
      return true;
    }

    const binPath = resolveDevspaceBinary(cfg);
    const binDir = path.dirname(binPath);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (binDir && binDir !== ".") {
      env.PATH = `${binDir}:${env.PATH ?? ""}`;
    }

    this.log(`正在启动本地 DevSpace: ${binPath} serve`);
    const child = spawn(binPath, ["serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.devspaceProc = child;

    child.stdout?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.log(`[DevSpace] ${line}`);
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.log(`[DevSpace stderr] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.log(`[DevSpace] 进程退出 code=${code} signal=${signal}`);
      if (this.devspaceProc === child) {
        this.devspaceProc = undefined;
      }
      if (!this.manualDisconnected && this.state.status === "connected") {
        const latest = getBridgeConfig();
        this.fail("本地 DevSpace 意外退出，准备重连...");
        this.scheduleReconnectIfNeeded(latest);
      }
    });

    // 轮询等待最多 12 秒
    for (let i = 0; i < 24; i++) {
      if (child.exitCode !== null) {
        return false;
      }
      const ready = await this.isLocalPortListening(cfg.localPort);
      if (ready) {
        return true;
      }
      await this.delay(500);
    }
    return false;
  }

  /** 确保 EC2 上的反向隧道打通且可访问本地 DevSpace */
  private async ensureTunnel(cfg: BridgeConfig): Promise<boolean> {
    // 若已有健康隧道（如其他 VS Code 窗口或后台已拉起），直接复用
    const alreadyReachable = await this.probeRemoteMcp(cfg);
    if (alreadyReachable) {
      this.log(`检测到 EC2 127.0.0.1:${cfg.remotePort} 已连通 DevSpace，直接复用`);
      return true;
    }

    // 清理可能失效的旧子进程
    this.stopManagedTunnel();

    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true }),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `127.0.0.1:${cfg.remotePort}:127.0.0.1:${cfg.localPort}`,
      `${cfg.sshUser}@${cfg.sshHost}`,
    ];

    this.log(
      `正在建立 SSH 反向隧道: ${cfg.sshUser}@${cfg.sshHost} (R 127.0.0.1:${cfg.remotePort} -> 127.0.0.1:${cfg.localPort})`
    );
    const child = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.tunnelProc = child;

    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.log(`[SSH Tunnel] ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      this.log(`[SSH Tunnel] 进程退出 code=${code} signal=${signal}`);
      if (this.tunnelProc === child) {
        this.tunnelProc = undefined;
      }
      if (!this.manualDisconnected && this.state.status === "connected") {
        const latest = getBridgeConfig();
        this.fail("SSH 隧道已断开，正在尝试自动重连...");
        this.scheduleReconnectIfNeeded(latest);
      }
    });

    // 等待远程端口真正可用（最多约 12 秒）
    for (let i = 0; i < 6; i++) {
      await this.delay(1500);
      if (child.exitCode !== null) {
        return false;
      }
      const reachable = await this.probeRemoteMcp(cfg);
      if (reachable) {
        return true;
      }
    }
    return false;
  }

  /** 定时健康检查，处理电脑休眠唤醒或外部复用隧道断开的场景 */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (this.manualDisconnected || this.connectingPromise) {
        return;
      }
      const cfg = getBridgeConfig();
      const localOk = await this.isLocalPortListening(cfg.localPort);
      const remoteOk = localOk ? await this.probeRemoteMcp(cfg) : false;

      if (!localOk || !remoteOk) {
        this.log(
          `[HealthCheck] 检测到链路异常 (local=${localOk}, remote=${remoteOk})，触发自动修复`
        );
        this.setState({
          ...this.state,
          status: "connecting",
          devspaceReady: localOk,
          tunnelReady: remoteOk,
          detail: "检测到链路中断，正在自动重连...",
        });
        void this.connect(true);
      }
    }, 30_000);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  /** 指数退避自动重连 */
  private scheduleReconnectIfNeeded(cfg: BridgeConfig): void {
    if (this.manualDisconnected || !cfg.autoReconnect) {
      return;
    }
    this.clearReconnectTimer();
    const waitSeconds = Math.min(30, 3 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.log(`将在 ${waitSeconds} 秒后自动重试连接（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect(false);
    }, waitSeconds * 1000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private stopManagedTunnel(): void {
    if (this.tunnelProc) {
      try {
        this.tunnelProc.kill("SIGTERM");
      } catch {
        // 忽略已退出进程错误
      }
      this.tunnelProc = undefined;
    }
  }

  private stopManagedDevspace(): void {
    if (this.devspaceProc) {
      try {
        this.devspaceProc.kill("SIGTERM");
      } catch {
        // 忽略已退出进程错误
      }
      this.devspaceProc = undefined;
    }
  }

  /** 探测本地 TCP 端口是否在监听 */
  private isLocalPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(1200);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  }

  /** 探测 EC2 本机回环端口是否能收到 DevSpace MCP 响应 */
  private probeRemoteMcp(cfg: BridgeConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const args = [
        ...buildBaseSshArgs(cfg, { batchMode: true }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        `curl -sS -m 4 -o /dev/null -w "%{http_code}" http://127.0.0.1:${cfg.remotePort}/mcp || true`,
      ];
      execFile("ssh", args, { timeout: 10_000 }, (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        const code = stdout.trim();
        // DevSpace 正常响应通常为 401（未带 token）、200 或 405
        resolve(code !== "" && code !== "000");
      });
    });
  }

  private fail(detail: string): void {
    this.log(`[Error] ${detail}`);
    this.setState({
      status: "error",
      devspaceReady: Boolean(this.devspaceProc),
      tunnelReady: false,
      detail,
      managedDevspace: Boolean(this.devspaceProc),
      managedTunnel: Boolean(this.tunnelProc),
    });
  }

  private setState(next: BridgeState): void {
    this.state = next;
    this.stateEmitter.fire(this.getState());
  }

  private log(message: string): void {
    const time = new Date().toLocaleTimeString();
    this.output.appendLine(`[${time}] ${message}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public dispose(): void {
    this.clearReconnectTimer();
    this.stopHealthCheck();
    const cfg = getBridgeConfig();
    if (!cfg.keepRunningOnClose) {
      this.stopManagedTunnel();
      this.stopManagedDevspace();
    }
    this.stateEmitter.dispose();
  }
}
