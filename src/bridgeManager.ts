import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { ChildProcess, execFile, spawn } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getBridgeConfig,
  ResolvedSshProxy,
  resolveDevspaceBinary,
  resolveSshProxy,
} from "./config";
import { BridgeLogger } from "./logger";

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
  activeProxy?: string;
}

interface ProbeResult {
  ok: boolean;
  httpCode: string;
  elapsedMs: number;
  errorText: string;
}

/**
 * 本地 DevSpace MCP + SSH 反向隧道连接管家
 * 负责一键启动、动态代理检测、防误杀健康检查、断线原因诊断日志与自动重连。
 */
export class BridgeManager implements vscode.Disposable {
  private devspaceProc: ChildProcess | undefined;
  private tunnelProc: ChildProcess | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private reconnectAttempts = 0;
  private consecutiveHealthFailures = 0;
  private manualDisconnected = false;
  private connectingPromise: Promise<boolean> | undefined;
  private lastTunnelStderr = "";
  private activeProxy: ResolvedSshProxy | undefined;

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

  constructor(private readonly logger: BridgeLogger) {}

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
      this.logger.info("Bridge", "触发强制重连，正在重置当前管理的 SSH 隧道");
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
      activeProxy: undefined,
    });
    this.logger.info("Bridge", "已手动断开连接");
  }

  private async doConnect(): Promise<boolean> {
    const cfg = getBridgeConfig();
    this.setState({
      ...this.state,
      status: "connecting",
      detail: "正在检查本地 DevSpace、代理与 SSH 隧道...",
    });

    // 1. 基础配置与密钥检查
    if (!cfg.sshHost || !cfg.sshUser) {
      this.fail("SSH 主机或用户名未配置（请在插件设置中填写 ec2Claude.sshHost）");
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
        this.logger.info("Bridge", `已自动修正密钥权限为 600: ${cfg.sshKeyPath}`);
      }
    } catch (err) {
      this.logger.warn("Bridge", `检查密钥权限失败: ${String(err)}`);
    }

    // 2. 动态检测代理是否存活（auto 模式下若代理端口未开启则自动回退直连，不写死）
    const candidateProxy = resolveSshProxy(cfg);
    if (candidateProxy) {
      const proxyAlive = await this.isTcpListening(
        candidateProxy.host,
        candidateProxy.port,
        1200
      );
      if (proxyAlive) {
        this.activeProxy = candidateProxy;
        this.logger.info("Proxy", `检测到可用代理，SSH 将经由 ${candidateProxy.display} 连接`);
      } else if ((cfg.sshProxy || "auto").toLowerCase() === "auto") {
        this.activeProxy = undefined;
        this.logger.warn(
          "Proxy",
          `环境变量代理 ${candidateProxy.display} 当前未监听，自动回退为直连`
        );
      } else {
        this.activeProxy = candidateProxy;
        this.fail(
          `指定的 SSH 代理不可达 (${candidateProxy.display})，请检查 VPN/代理是否启动或端口是否变更`
        );
        this.scheduleReconnectIfNeeded(cfg);
        return false;
      }
    } else {
      this.activeProxy = undefined;
      this.logger.info("Proxy", "未配置代理或已设为直连，SSH 将直接连接远程主机");
    }

    // 3. 启动或复用本地 DevSpace MCP
    const devspaceOk = await this.ensureDevspace(cfg);
    if (!devspaceOk) {
      this.fail(`本地 DevSpace 启动失败（端口 ${cfg.localPort}）`);
      this.scheduleReconnectIfNeeded(cfg);
      return false;
    }

    // 4. 建立或复用 SSH 反向隧道
    const tunnelResult = await this.ensureTunnel(cfg);
    if (!tunnelResult.ok) {
      this.fail(tunnelResult.reason);
      this.scheduleReconnectIfNeeded(cfg);
      return false;
    }

    this.reconnectAttempts = 0;
    this.consecutiveHealthFailures = 0;
    const proxySuffix = this.activeProxy
      ? ` · 经由代理 ${this.activeProxy.host}:${this.activeProxy.port}`
      : " · 直连";
    this.setState({
      status: "connected",
      devspaceReady: true,
      tunnelReady: true,
      detail: `已连通 ${cfg.sshHost} (127.0.0.1:${cfg.remotePort}${proxySuffix})`,
      lastConnectedAt: Date.now(),
      managedDevspace: Boolean(this.devspaceProc),
      managedTunnel: Boolean(this.tunnelProc),
      activeProxy: this.activeProxy?.display,
    });
    this.logger.info(
      "Bridge",
      `连接就绪：本地 :${cfg.localPort} <-> ${cfg.sshHost}:${cfg.remotePort}${proxySuffix}`
    );
    this.startHealthCheck();
    return true;
  }

  /** 确保本地 DevSpace MCP 正常监听 */
  private async ensureDevspace(cfg: BridgeConfig): Promise<boolean> {
    const alreadyListening = await this.isTcpListening("127.0.0.1", cfg.localPort);
    if (alreadyListening) {
      this.logger.info(
        "DevSpace",
        `检测到本地端口 ${cfg.localPort} 已有 DevSpace 监听，直接复用`
      );
      return true;
    }

    const binPath = resolveDevspaceBinary(cfg);
    const binDir = path.dirname(binPath);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (binDir && binDir !== ".") {
      env.PATH = `${binDir}:${env.PATH ?? ""}`;
    }

    this.logger.info("DevSpace", `正在启动本地 DevSpace: ${binPath} serve`);
    const child = spawn(binPath, ["serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.devspaceProc = child;

    child.stdout?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.logger.info("DevSpace", line);
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.logger.warn("DevSpace", line);
      }
    });
    child.on("exit", (code, signal) => {
      this.logger.warn("DevSpace", `进程退出 code=${code} signal=${signal}`);
      if (this.devspaceProc === child) {
        this.devspaceProc = undefined;
      }
      if (!this.manualDisconnected && this.state.status === "connected") {
        const latest = getBridgeConfig();
        this.fail(`本地 DevSpace 意外退出 (code=${code})，正在自动重连...`);
        this.scheduleReconnectIfNeeded(latest);
      }
    });

    for (let i = 0; i < 24; i++) {
      if (child.exitCode !== null) {
        return false;
      }
      const ready = await this.isTcpListening("127.0.0.1", cfg.localPort);
      if (ready) {
        return true;
      }
      await this.delay(500);
    }
    return false;
  }

  /** 确保 EC2 上的反向隧道打通且可访问本地 DevSpace */
  private async ensureTunnel(
    cfg: BridgeConfig
  ): Promise<{ ok: boolean; reason: string }> {
    const initialProbe = await this.probeRemoteMcp(cfg, 18_000);
    if (initialProbe.ok) {
      this.logger.info(
        "Tunnel",
        `检测到远程 127.0.0.1:${cfg.remotePort} 已连通 (HTTP ${initialProbe.httpCode}, ${initialProbe.elapsedMs}ms)，直接复用`
      );
      return { ok: true, reason: "" };
    }
    this.logger.info(
      "Tunnel",
      `初始远程探测未连通 (${initialProbe.errorText || `HTTP ${initialProbe.httpCode}`}, ${initialProbe.elapsedMs}ms)，准备拉起新隧道`
    );

    this.stopManagedTunnel();
    this.lastTunnelStderr = "";

    const sshArgs = [
      ...buildBaseSshArgs(cfg, {
        batchMode: true,
        proxy: this.activeProxy ?? null,
      }),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `127.0.0.1:${cfg.remotePort}:127.0.0.1:${cfg.localPort}`,
      `${cfg.sshUser}@${cfg.sshHost}`,
    ];

    this.logger.info(
      "Tunnel",
      `启动 SSH 反向隧道: ${cfg.sshUser}@${cfg.sshHost} (R 127.0.0.1:${cfg.remotePort} -> 127.0.0.1:${cfg.localPort}${this.activeProxy ? `, via ${this.activeProxy.display}` : ", direct"})`
    );
    const child = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.tunnelProc = child;

    child.stderr?.on("data", (buf: Buffer) => {
      const line = buf.toString("utf8").trim();
      if (line) {
        this.lastTunnelStderr = line;
        this.logger.warn("SSH Tunnel", line);
      }
    });

    child.on("exit", (code, signal) => {
      const reason = this.classifyDisconnectReason(
        this.lastTunnelStderr,
        code,
        signal
      );
      this.logger.warn(
        "SSH Tunnel",
        `隧道进程退出 code=${code} signal=${signal} | 诊断=${reason}`
      );
      if (this.tunnelProc === child) {
        this.tunnelProc = undefined;
      }
      if (!this.manualDisconnected && this.state.status === "connected") {
        const latest = getBridgeConfig();
        this.fail(`${reason}，正在自动重连...`);
        this.scheduleReconnectIfNeeded(latest);
      }
    });

    // 等待远程端口真正可用（最多 5 次探测，避免误判慢握手）
    let lastProbe: ProbeResult | undefined;
    for (let i = 0; i < 5; i++) {
      await this.delay(i === 0 ? 1800 : 2000);
      if (child.exitCode !== null) {
        return {
          ok: false,
          reason: this.classifyDisconnectReason(
            this.lastTunnelStderr,
            child.exitCode,
            null
          ),
        };
      }
      lastProbe = await this.probeRemoteMcp(cfg, 18_000);
      if (lastProbe.ok) {
        this.logger.info(
          "Tunnel",
          `隧道验证成功 (HTTP ${lastProbe.httpCode}, ${lastProbe.elapsedMs}ms)`
        );
        return { ok: true, reason: "" };
      }
      this.logger.warn(
        "Tunnel",
        `第 ${i + 1}/5 次隧道探测未就绪: ${lastProbe.errorText || `HTTP ${lastProbe.httpCode}`} (${lastProbe.elapsedMs}ms)`
      );
    }

    const detailReason = this.classifyDisconnectReason(
      this.lastTunnelStderr || lastProbe?.errorText || "",
      child.exitCode,
      null
    );
    return { ok: false, reason: detailReason };
  }

  /**
   * 定时健康检查（60 秒周期，20 秒超时，连续失败 3 次才触发重连）：
   * 避免跨洋网络单次短暂抖动误杀原本健康的 SSH 隧道。
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthTimer = setInterval(async () => {
      if (this.manualDisconnected || this.connectingPromise) {
        return;
      }
      const cfg = getBridgeConfig();
      const localOk = await this.isTcpListening("127.0.0.1", cfg.localPort);
      if (!localOk) {
        this.logger.error("HealthCheck", `本地 DevSpace 端口 ${cfg.localPort} 未监听，立即触发重连`);
        this.triggerHealthReconnect("本地 DevSpace 停止响应，正在重连...");
        return;
      }

      const probe = await this.probeRemoteMcp(cfg, 20_000);
      if (probe.ok) {
        if (this.consecutiveHealthFailures > 0) {
          this.logger.info(
            "HealthCheck",
            `链路恢复正常 (HTTP ${probe.httpCode}, ${probe.elapsedMs}ms)`
          );
        }
        this.consecutiveHealthFailures = 0;
        return;
      }

      this.consecutiveHealthFailures += 1;
      const reason = this.classifyDisconnectReason(probe.errorText, null, null);
      this.logger.warn(
        "HealthCheck",
        `远程探测失败 (${this.consecutiveHealthFailures}/3) | ${probe.errorText || `HTTP ${probe.httpCode}`} (${probe.elapsedMs}ms) | 诊断=${reason}`
      );

      // 连续失败达到 3 次，或插件托管的隧道进程已经退出，才判定真断联并重连
      const tunnelGone = this.state.managedTunnel && !this.tunnelProc;
      if (tunnelGone || this.consecutiveHealthFailures >= 3) {
        this.consecutiveHealthFailures = 0;
        this.triggerHealthReconnect(`${reason}，正在自动重连...`);
      }
    }, 60_000);
  }

  private triggerHealthReconnect(detail: string): void {
    this.setState({
      ...this.state,
      status: "connecting",
      tunnelReady: false,
      detail,
    });
    void this.connect(true);
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
    this.logger.info(
      "Bridge",
      `将在 ${waitSeconds} 秒后自动重试连接（第 ${this.reconnectAttempts} 次）`
    );
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

  /** 探测指定 TCP 地址与端口是否在监听 */
  private isTcpListening(
    host: string,
    port: number,
    timeoutMs = 1200
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  }

  /** 探测 EC2 本机回环端口是否能收到 DevSpace MCP 响应，并记录真实错误原因 */
  private probeRemoteMcp(
    cfg: BridgeConfig,
    timeoutMs = 18_000
  ): Promise<ProbeResult> {
    const startAt = Date.now();
    return new Promise((resolve) => {
      const args = [
        ...buildBaseSshArgs(cfg, {
          batchMode: true,
          proxy: this.activeProxy ?? null,
        }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        `curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${cfg.remotePort}/mcp || true`,
      ];
      execFile("ssh", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        const elapsedMs = Date.now() - startAt;
        const code = (stdout ?? "").trim();
        if (err) {
          const errDetail =
            (stderr ?? "").trim() ||
            (err.killed ? `探测超时 (>${timeoutMs}ms)` : err.message);
          resolve({
            ok: false,
            httpCode: code,
            elapsedMs,
            errorText: errDetail,
          });
          return;
        }
        const ok = code !== "" && code !== "000";
        resolve({
          ok,
          httpCode: code,
          elapsedMs,
          errorText: ok
            ? ""
            : (stderr ?? "").trim() ||
              `远程 127.0.0.1:${cfg.remotePort} 无响应 (HTTP ${code || "000"})`,
        });
      });
    });
  }

  /** 将底层 SSH/网络错误翻译成通俗可读的断线原因 */
  private classifyDisconnectReason(
    rawError: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): string {
    const text = (rawError || "").toLowerCase();
    if (
      text.includes("proxy") ||
      (text.includes("nc:") && text.includes("refused"))
    ) {
      return `本地代理不可用 (${this.activeProxy?.display ?? "auto"})，请检查 VPN/代理状态`;
    }
    if (
      text.includes("remote port forwarding failed") ||
      text.includes("cannot listen to port")
    ) {
      return "EC2 远程端口被旧连接占用（网络闪断残留）";
    }
    if (
      text.includes("connection timed out") ||
      text.includes("operation timed out") ||
      text.includes("探测超时")
    ) {
      return this.activeProxy
        ? `连接超时（经由代理 ${this.activeProxy.host}:${this.activeProxy.port} 连不上 EC2）`
        : "直连 EC2 超时（如本地需走代理，请检查 VPN 或 ec2Claude.sshProxy 设置）";
    }
    if (text.includes("permission denied") || text.includes("bad permissions")) {
      return "SSH 密钥认证失败，请检查私钥路径与权限";
    }
    if (
      text.includes("connection reset") ||
      text.includes("broken pipe") ||
      text.includes("client_loop") ||
      text.includes("kex_exchange_identification")
    ) {
      return "网络连接中断（可能是 VPN 切换节点或网络波动）";
    }
    if (text.includes("no route to host") || text.includes("network is unreachable")) {
      return "本地网络不可达";
    }
    if (rawError.trim()) {
      return rawError.trim().slice(0, 120);
    }
    if (signal) {
      return `SSH 隧道被信号终止 (${signal})`;
    }
    if (exitCode !== null) {
      return `SSH 隧道异常退出 (exit=${exitCode})`;
    }
    return "远程隧道暂时不可达";
  }

  private fail(detail: string): void {
    this.logger.error("Bridge", detail);
    this.setState({
      status: "error",
      devspaceReady: Boolean(this.devspaceProc),
      tunnelReady: false,
      detail,
      managedDevspace: Boolean(this.devspaceProc),
      managedTunnel: Boolean(this.tunnelProc),
      activeProxy: this.activeProxy?.display,
    });
  }

  private setState(next: BridgeState): void {
    this.state = next;
    this.stateEmitter.fire(this.getState());
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
