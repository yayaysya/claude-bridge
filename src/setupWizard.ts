import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { ChildProcess, execFile, spawn } from "child_process";
import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  resolveDevspaceBinary,
  resolveSshProxy,
} from "./config";
import { BridgeLogger } from "./logger";

/** 本机 DevSpace 环境检测快照 */
export interface LocalSetupStatus {
  nodeVersion: string;
  nodeOk: boolean;
  devspaceInstalled: boolean;
  devspaceVersion: string;
  devspaceBin: string;
  configExists: boolean;
  allowedRoots: string[];
  subagentsDisabled: boolean;
  oauthDays: number;
  ownerToken: string;
}

/** 远程验收检测结果 */
export interface RemoteVerifyResult {
  sshOk: boolean;
  claudeInstalled: boolean;
  claudeVersion: string;
  claudeLoggedIn: boolean;
  devspaceMcpConnected: boolean;
  desktopInstalled: boolean;
  desktopRunning: boolean;
  summary: string;
}

/** 临时网页登录桌面状态 */
export interface LoginDesktopState {
  running: boolean;
  url: string;
  geometry: string;
  detail: string;
  profileId?: string;
  profileName?: string;
}

/** 密码一键配置免密私钥结果 */
export interface PasswordlessSetupResult {
  ok: boolean;
  keyPath: string;
  finalUser: string;
  createdUser: boolean;
  message: string;
}

const LOCAL_NOVNC_PORT = 6080;

/**
 * 图形化「新机配置向导」后端引擎
 * 负责本机 DevSpace 一键初始化、远程 VPS 一键装机、极简 noVNC 登录画面启停与一键验收。
 */
export class SetupWizardManager implements vscode.Disposable {
  private desktopTunnelProc: ChildProcess | undefined;
  private desktopState: LoginDesktopState = {
    running: false,
    url: "",
    geometry: "1366x768",
    detail: "未启动（平时 0 内存占用）",
  };

  private readonly desktopEmitter = new vscode.EventEmitter<LoginDesktopState>();
  public readonly onDidChangeDesktopState = this.desktopEmitter.event;

  constructor(private readonly logger: BridgeLogger) {}

  public getDesktopState(): LoginDesktopState {
    return { ...this.desktopState };
  }

  /** 检测本机 Node / DevSpace / 安全加固配置与 Owner Password */
  public async inspectLocalStatus(cfg: BridgeConfig): Promise<LocalSetupStatus> {
    const devspaceBin = resolveDevspaceBinary(cfg);
    const env = this.buildLocalEnv(devspaceBin);

    const nodeVer = await this.runSimpleCmd("node", ["-v"], env);
    const nodeOk = Boolean(nodeVer && /^v(22|23|24|25|26)\./.test(nodeVer));

    const dsVer = await this.runSimpleCmd(devspaceBin, ["--version"], env);
    const devspaceInstalled = Boolean(dsVer);

    const cfgPath = path.join(os.homedir(), ".devspace", "config.jsonc");
    const authPath = path.join(os.homedir(), ".devspace", "auth.json");
    let configExists = false;
    let allowedRoots: string[] = [];
    let subagentsDisabled = false;
    let oauthDays = 30;
    let ownerToken = "";

    if (fs.existsSync(cfgPath)) {
      configExists = true;
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<
          string,
          unknown
        >;
        const ws = parsed.workspaces as Record<string, unknown> | undefined;
        if (Array.isArray(ws?.allowedRoots)) {
          allowedRoots = ws.allowedRoots.map((v) => String(v));
        }
        const sub = parsed.subagents as Record<string, unknown> | undefined;
        subagentsDisabled = sub?.enabled === false;
        const oauth = parsed.oauth as Record<string, unknown> | undefined;
        if (typeof oauth?.refreshTokenTtlSeconds === "number") {
          oauthDays = Math.round(oauth.refreshTokenTtlSeconds / 86400);
        }
      } catch {
        // 忽略格式异常
      }
    }

    if (fs.existsSync(authPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
          string,
          unknown
        >;
        ownerToken = String(parsed.ownerToken ?? "");
      } catch {
        // 忽略
      }
    }

    return {
      nodeVersion: nodeVer || "未检测到",
      nodeOk,
      devspaceInstalled,
      devspaceVersion: dsVer || "",
      devspaceBin,
      configExists,
      allowedRoots,
      subagentsDisabled,
      oauthDays,
      ownerToken,
    };
  }

  /** Step 1：一键安装并安全初始化本机 DevSpace */
  public async setupLocalDevspace(
    cfg: BridgeConfig,
    projectRoot: string,
    onLog: (line: string) => void
  ): Promise<{ ok: boolean; status: LocalSetupStatus; message: string }> {
    const cleanRoot = projectRoot.trim();
    if (!cleanRoot) {
      const status = await this.inspectLocalStatus(cfg);
      return { ok: false, status, message: "请先选择需要授权的本地项目根目录。" };
    }

    if (!fs.existsSync(cleanRoot)) {
      fs.mkdirSync(cleanRoot, { recursive: true });
    }

    const before = await this.inspectLocalStatus(cfg);
    if (!before.nodeOk) {
      return {
        ok: false,
        status: before,
        message: `需要 Node.js 22~26（当前：${before.nodeVersion}），请先安装 Node.js 24 LTS。`,
      };
    }

    const env = this.buildLocalEnv(before.devspaceBin);

    if (!before.devspaceInstalled) {
      onLog("正在全局安装 @waishnav/devspace ...");
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const installCode = await this.spawnStreaming(
        npmCmd,
        ["install", "-g", "@waishnav/devspace"],
        env,
        onLog
      );
      if (installCode !== 0) {
        const st = await this.inspectLocalStatus(cfg);
        return {
          ok: false,
          status: st,
          message: `安装 @waishnav/devspace 失败（退出码 ${installCode}）`,
        };
      }
    } else {
      onLog(`已检测到 DevSpace v${before.devspaceVersion}，跳过安装。`);
    }

    const devspaceBin = resolveDevspaceBinary(cfg);
    const localPort = cfg.localPort || 7676;
    onLog(`正在初始化 DevSpace（授权目录：${cleanRoot}，端口：${localPort}）...`);
    const initCode = await this.spawnStreaming(
      devspaceBin,
      [
        "init",
        "--yes",
        "--public-url",
        `http://127.0.0.1:${localPort}`,
        "--roots",
        cleanRoot,
      ],
      this.buildLocalEnv(devspaceBin),
      onLog
    );

    if (initCode !== 0) {
      const st = await this.inspectLocalStatus(cfg);
      return {
        ok: false,
        status: st,
        message: `devspace init 失败（退出码 ${initCode}）`,
      };
    }

    // 自动执行安全加固：关闭本地 subagents + 拉长 OAuth 有效期至 365 天
    const cfgPath = path.join(os.homedir(), ".devspace", "config.jsonc");
    if (fs.existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<
          string,
          Record<string, unknown>
        >;
        parsed.server = {
          ...(parsed.server ?? {}),
          host: "127.0.0.1",
          port: localPort,
          publicBaseUrl: `http://127.0.0.1:${localPort}`,
        };
        parsed.oauth = {
          ...(parsed.oauth ?? {}),
          refreshTokenTtlSeconds: 31536000,
          refreshTokenGraceSeconds: 30,
        };
        parsed.subagents = {
          ...(parsed.subagents ?? {}),
          enabled: false,
        };
        fs.writeFileSync(cfgPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        onLog("安全加固完成：已关闭本地 subagents，OAuth 有效期已设为 365 天。");
      } catch (err) {
        onLog(`警告：自动修改 config.jsonc 失败：${String(err)}`);
      }
    }

    const after = await this.inspectLocalStatus(cfg);
    onLog("本机 DevSpace 初始化全部完成！");
    return {
      ok: true,
      status: after,
      message: "本机 DevSpace 初始化并加固完成！",
    };
  }

  /**
   * 针对只提供「IP + 端口 + 用户名 + 密码」的 VPS（如 RAKsmart / 搬瓦工等）：
   * 1. 本地自动生成专属 ed25519 密钥对（~/.ssh/claude-bridge_<host>）；
   * 2. 使用 SSH_ASKPASS 一次性喂入密码（不落盘、不依赖 sshpass），自动部署公钥到远程；
   * 3. 若使用 root 登录且勾选自动建普通用户，同步创建普通用户并配好免密 sudo 与公钥（规避 Claude Code 禁止 root 下 bypassPermissions 的限制）；
   * 4. 验证免密私钥登录成功并返回新的私钥路径与最终用户名。
   */
  public async setupPasswordlessSsh(
    cfg: BridgeConfig,
    params: {
      host: string;
      port: number;
      loginUser: string;
      password: string;
      createNonRootUser: boolean;
      newUserName: string;
    },
    onLog: (line: string) => void
  ): Promise<PasswordlessSetupResult> {
    const host = params.host.trim();
    const port = Number(params.port) || 22;
    const loginUser = params.loginUser.trim() || "root";
    const password = params.password;
    const newUserName = (params.newUserName || "claude").trim();

    if (!host || !password) {
      return {
        ok: false,
        keyPath: "",
        finalUser: loginUser,
        createdUser: false,
        message: "请填写服务器地址和一次性登录密码。",
      };
    }

    const needCreateUser =
      loginUser === "root" && params.createNonRootUser;
    if (needCreateUser && !/^[a-z_][a-z0-9_-]{1,30}$/.test(newUserName)) {
      return {
        ok: false,
        keyPath: "",
        finalUser: loginUser,
        createdUser: false,
        message: `普通用户名格式不合法：${newUserName}（仅允许小写字母、数字、下划线、连字符）`,
      };
    }

    // 1. 生成或复用专属 ed25519 密钥对
    const sshDir = path.join(os.homedir(), ".ssh");
    fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const safeHost = host.replace(/[^a-zA-Z0-9._-]/g, "_");
    const keyPath = path.join(sshDir, `claude-bridge_${safeHost}`);
    const pubPath = `${keyPath}.pub`;

    if (!fs.existsSync(keyPath) || !fs.existsSync(pubPath)) {
      onLog(`正在本地生成专属 SSH 密钥对: ${keyPath} ...`);
      const genCode = await this.spawnStreaming(
        "ssh-keygen",
        ["-t", "ed25519", "-N", "", "-C", `claude-bridge-${safeHost}`, "-f", keyPath],
        process.env,
        onLog
      );
      if (genCode !== 0 || !fs.existsSync(pubPath)) {
        return {
          ok: false,
          keyPath: "",
          finalUser: loginUser,
          createdUser: false,
          message: "本地生成 SSH 密钥对失败，请确认系统已安装 OpenSSH (ssh-keygen)。",
        };
      }
    } else {
      onLog(`复用已有本机专属密钥对: ${keyPath}`);
    }

    if (process.platform !== "win32") {
      try {
        fs.chmodSync(keyPath, 0o600);
      } catch {
        // 忽略
      }
    }

    const pubKey = fs.readFileSync(pubPath, "utf8").trim();
    if (!pubKey) {
      return {
        ok: false,
        keyPath,
        finalUser: loginUser,
        createdUser: false,
        message: `无法读取公钥文件：${pubPath}`,
      };
    }

    // 2. 构造远程免密部署脚本（通过 stdin 传入，零引号注入风险）
    const pubKeyB64 = Buffer.from(pubKey, "utf8").toString("base64");
    const remoteLines: string[] = [
      "set -euo pipefail",
      `PUB_KEY="$(echo '${pubKeyB64}' | base64 -d)"`,
      'mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
      'touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"',
      'grep -qxF "$PUB_KEY" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$PUB_KEY" >> "$HOME/.ssh/authorized_keys"',
      `echo "AUTH_KEY_INSTALLED_FOR=${loginUser}"`,
    ];

    if (needCreateUser) {
      remoteLines.push(
        `TARGET_USER="${newUserName}"`,
        'if ! id -u "$TARGET_USER" >/dev/null 2>&1; then',
        '  useradd -m -s /bin/bash "$TARGET_USER"',
        '  echo "CREATED_USER=$TARGET_USER"',
        "else",
        '  echo "REUSED_USER=$TARGET_USER"',
        "fi",
        'if command -v sudo >/dev/null 2>&1 || [ -d /etc/sudoers.d ]; then',
        '  mkdir -p /etc/sudoers.d',
        '  printf "%s ALL=(ALL) NOPASSWD:ALL\\n" "$TARGET_USER" > "/etc/sudoers.d/90-claude-bridge-$TARGET_USER"',
        '  chmod 440 "/etc/sudoers.d/90-claude-bridge-$TARGET_USER"',
        "fi",
        'TARGET_HOME="$(eval echo ~"$TARGET_USER")"',
        'mkdir -p "$TARGET_HOME/.ssh"',
        'touch "$TARGET_HOME/.ssh/authorized_keys"',
        'grep -qxF "$PUB_KEY" "$TARGET_HOME/.ssh/authorized_keys" || printf "%s\\n" "$PUB_KEY" >> "$TARGET_HOME/.ssh/authorized_keys"',
        'chmod 700 "$TARGET_HOME/.ssh" && chmod 600 "$TARGET_HOME/.ssh/authorized_keys"',
        'chown -R "$TARGET_USER:$TARGET_USER" "$TARGET_HOME/.ssh"',
        'echo "NON_ROOT_READY=$TARGET_USER"'
      );
    }

    const remoteScript = `${remoteLines.join("\n")}\n`;

    // 3. 创建临时 SSH_ASKPASS 脚本（密码仅通过进程环境变量传入，不写入任何磁盘文件）
    const isWin = process.platform === "win32";
    const askPassFile = path.join(
      os.tmpdir(),
      `cb-askpass-${process.pid}-${Date.now()}${isWin ? ".cmd" : ".sh"}`
    );
    const askPassBody = isWin
      ? "@echo off\r\necho %CLAUDE_BRIDGE_SSH_PASS%\r\n"
      : "#!/bin/sh\nprintf '%s\\n' \"$CLAUDE_BRIDGE_SSH_PASS\"\n";
    fs.writeFileSync(askPassFile, askPassBody, { mode: 0o700 });

    const tempCfg: BridgeConfig = {
      ...cfg,
      sshHost: host,
      sshPort: port,
      sshUser: loginUser,
      sshKeyPath: keyPath,
    };
    const proxy = resolveSshProxy(tempCfg);

    // 构造密码登录专用 SSH 参数（不带 BatchMode=yes，强制触发 SSH_ASKPASS）
    const baseWithoutKey = buildBaseSshArgs(tempCfg, {
      batchMode: false,
      proxy: proxy ?? null,
    }).filter((_, idx, arr) => {
      if (arr[idx] === "-i") return false;
      if (idx > 0 && arr[idx - 1] === "-i") return false;
      return true;
    });

    const sshArgs = [
      ...baseWithoutKey,
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "NumberOfPasswordPrompts=1",
      `${loginUser}@${host}`,
      "bash -s",
    ];

    onLog(
      `正在使用一次性密码连接 ${loginUser}@${host}:${port}${proxy ? `（经由代理 ${proxy.display}）` : "（直连）"}并部署公钥...`
    );

    let remoteOut = "";
    let remoteErr = "";
    let exitCode = -1;

    try {
      exitCode = await new Promise<number>((resolve) => {
        const child = spawn("ssh", sshArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            SSH_ASKPASS: askPassFile,
            SSH_ASKPASS_REQUIRE: "force",
            DISPLAY: process.env.DISPLAY || "claude-bridge:0",
            CLAUDE_BRIDGE_SSH_PASS: password,
          },
        });
        child.stdout?.on("data", (buf: Buffer) => {
          const text = buf.toString("utf8");
          remoteOut += text;
          for (const l of text.split(/\r?\n/)) {
            if (l.trim()) onLog(l);
          }
        });
        child.stderr?.on("data", (buf: Buffer) => {
          const text = buf.toString("utf8");
          remoteErr += text;
          for (const l of text.split(/\r?\n/)) {
            if (l.trim()) onLog(`[ssh] ${l}`);
          }
        });
        child.on("error", (err) => {
          remoteErr += err.message;
          resolve(-1);
        });
        child.on("close", (code) => resolve(code ?? -1));

        child.stdin?.write(remoteScript, "utf8");
        child.stdin?.end();
      });
    } finally {
      try {
        fs.unlinkSync(askPassFile);
      } catch {
        // 忽略清理异常
      }
    }

    if (exitCode !== 0) {
      const hint = remoteErr.toLowerCase().includes("permission denied")
        ? "密码认证被拒绝，请检查用户名、密码或端口是否正确。"
        : remoteErr.trim() || `SSH 退出码 ${exitCode}`;
      return {
        ok: false,
        keyPath,
        finalUser: loginUser,
        createdUser: false,
        message: `部署公钥失败：${hint}`,
      };
    }

    const finalUser = needCreateUser ? newUserName : loginUser;
    const createdUser = remoteOut.includes(`CREATED_USER=${newUserName}`);

    // 4. 用刚生成的私钥验证免密登录
    onLog(`正在验证免密私钥登录 (${finalUser}@${host}:${port})...`);
    const verifyCfg: BridgeConfig = {
      ...tempCfg,
      sshUser: finalUser,
      sshKeyPath: keyPath,
    };
    const verifyRes = await this.execSsh(
      [
        ...buildBaseSshArgs(verifyCfg, { batchMode: true, proxy: proxy ?? null }),
        `${finalUser}@${host}`,
        'echo "KEY_AUTH_OK $(whoami)"',
      ],
      18_000
    );

    if (!verifyRes.ok || !verifyRes.stdout.includes("KEY_AUTH_OK")) {
      return {
        ok: false,
        keyPath,
        finalUser,
        createdUser,
        message: `公钥已写入，但验证免密登录失败：${verifyRes.stderr || verifyRes.stdout}`,
      };
    }

    onLog(`免密登录验证成功！已自动配置私钥路径：${keyPath}，登录用户：${finalUser}`);
    this.logger.info(
      "Wizard",
      `密码一键转免密私钥成功: ${finalUser}@${host}:${port} -> ${keyPath}`
    );

    return {
      ok: true,
      keyPath,
      finalUser,
      createdUser,
      message: needCreateUser
        ? `配置成功！已创建/启用普通用户 ${finalUser} 并完成免密私钥部署（${keyPath}），已自动回填到设置中。`
        : `配置成功！已生成专属私钥并完成免密部署（${keyPath}），已自动回填到设置中。`,
    };
  }

  /** Step 2：通过 SSH 在远程新 VPS 上一键完成环境准备与极简 noVNC 桌面安装 */
  public async setupRemoteVps(
    cfg: BridgeConfig,
    options: { timezone: string; withDesktop: boolean; geometry: string },
    onLog: (line: string) => void
  ): Promise<{ ok: boolean; message: string }> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return { ok: false, message: "请先填写服务器地址、用户名与本地私钥路径。" };
    }
    if (!fs.existsSync(cfg.sshKeyPath)) {
      return { ok: false, message: `找不到本地私钥文件：${cfg.sshKeyPath}` };
    }

    const remoteScript = buildRemoteInitScript({
      timezone: options.timezone || "America/New_York",
      remotePort: cfg.remotePort || 7676,
      withDesktop: options.withDesktop,
      geometry: options.geometry || "1366x768",
    });

    const proxy = resolveSshProxy(cfg);
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      "bash -s",
    ];

    this.logger.info(
      "Wizard",
      `开始初始化远程 VPS: ${cfg.sshUser}@${cfg.sshHost} (desktop=${options.withDesktop}, tz=${options.timezone})`
    );
    onLog(
      `正在连接 ${cfg.sshUser}@${cfg.sshHost}${proxy ? `（经由代理 ${proxy.display}）` : "（直连）"}...`
    );

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout?.on("data", (buf: Buffer) => {
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (line.trim()) {
            onLog(line);
          }
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        for (const line of buf.toString("utf8").split(/\r?\n/)) {
          if (line.trim()) {
            onLog(`[stderr] ${line}`);
          }
        }
      });
      child.on("error", (err) => {
        onLog(`SSH 启动失败: ${err.message}`);
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));

      child.stdin?.write(remoteScript, "utf8");
      child.stdin?.end();
    });

    if (exitCode !== 0) {
      this.logger.error("Wizard", `远程 VPS 初始化失败 (exit=${exitCode})`);
      return {
        ok: false,
        message: `远程 VPS 初始化失败（退出码 ${exitCode}），请查看上方日志。`,
      };
    }

    this.logger.info("Wizard", "远程 VPS 初始化成功");
    return {
      ok: true,
      message: "远程 VPS 初始化完成！现在可以进行第 3 步打开网页登录画面。",
    };
  }

  /** Step 3：一键启动远程极简 noVNC 临时桌面 + 本地 SSH 加密转发 + 自动弹浏览器 */
  public async startRemoteLoginDesktop(
    cfg: BridgeConfig,
    geometry = "1366x768",
    meta?: { profileId?: string; profileName?: string; forwardDevspace?: boolean }
  ): Promise<{ ok: boolean; state: LoginDesktopState; message: string }> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath) {
      return {
        ok: false,
        state: this.getDesktopState(),
        message: "请先为当前目标服务器配置地址与私钥路径。",
      };
    }

    this.stopLocalDesktopTunnel();
    const proxy = resolveSshProxy(cfg);
    const baseArgs = buildBaseSshArgs(cfg, {
      batchMode: true,
      proxy: proxy ?? null,
    });

    const targetLabel = meta?.profileName
      ? `${meta.profileName} (${cfg.sshHost})`
      : cfg.sshHost;
    this.logger.info(
      "Wizard",
      `正在远程启动极简登录桌面: ${targetLabel} (${geometry}, 16位色)`
    );

    // 若远程已装旧版启动脚本（无 Ctrl+Shift+V 粘贴参数），顺手无感升级脚本后再启动
    const latestDeskB64 = Buffer.from(
      buildLoginDesktopScript(geometry),
      "utf8"
    ).toString("base64");
    const remoteStartCmd = [
      'DESK="$HOME/.local/bin/claude-login-desktop"',
      'if [ ! -x "$DESK" ]; then echo "NOT_INSTALLED"; exit 2; fi',
      `if ! grep -q "selectToClipboard" "$DESK" 2>/dev/null; then printf '%s' '${latestDeskB64}' | base64 -d > "$DESK" && chmod +x "$DESK"; fi`,
      `"$DESK" start "${geometry}"`,
    ].join("; ");

    const startRes = await this.execSsh(
      [...baseArgs, `${cfg.sshUser}@${cfg.sshHost}`, remoteStartCmd],
      20_000
    );

    if (!startRes.ok) {
      const notInstalled = startRes.stdout.includes("NOT_INSTALLED");
      return {
        ok: false,
        state: this.getDesktopState(),
        message: notInstalled
          ? "远程 VPS 尚未安装极简登录桌面，请先在第 2 步勾选桌面并点击「一键初始化远程 VPS」。"
          : `启动远程桌面失败：${startRes.stderr || startRes.stdout}`,
      };
    }

    // 拉起本地加密转发：-L 6080 供本机浏览器看画面；若为非活跃新机同时带 -R 供远程 /mcp 首次授权（不打断主力机）
    const tunnelArgs = [
      ...baseArgs,
      "-N",
      "-L",
      `127.0.0.1:${LOCAL_NOVNC_PORT}:127.0.0.1:6080`,
    ];
    if (meta?.forwardDevspace) {
      tunnelArgs.push(
        "-R",
        `127.0.0.1:${cfg.remotePort || 7676}:127.0.0.1:${cfg.localPort || 7676}`
      );
    } else {
      tunnelArgs.push("-o", "ExitOnForwardFailure=yes");
    }
    tunnelArgs.push(`${cfg.sshUser}@${cfg.sshHost}`);

    const child = spawn("ssh", tunnelArgs, { stdio: ["ignore", "pipe", "pipe"] });
    this.desktopTunnelProc = child;
    let tunnelErr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      tunnelErr += buf.toString("utf8");
    });
    child.on("exit", () => {
      if (this.desktopTunnelProc === child) {
        this.desktopTunnelProc = undefined;
        this.setDesktopState({
          running: false,
          url: "",
          geometry,
          detail: "本地 6080 加密转发已停止",
          profileId: meta?.profileId,
          profileName: meta?.profileName,
        });
      }
    });

    let listening = false;
    for (let i = 0; i < 16; i++) {
      if (child.exitCode !== null) {
        break;
      }
      listening = await this.isLocalPortListening(LOCAL_NOVNC_PORT);
      if (listening) {
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (!listening) {
      this.stopLocalDesktopTunnel();
      return {
        ok: false,
        state: this.getDesktopState(),
        message: `建立本地 6080 转发隧道失败：${tunnelErr.trim() || "端口未就绪"}`,
      };
    }

    const url = `http://127.0.0.1:${LOCAL_NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&quality=3&compression=9`;
    this.setDesktopState({
      running: true,
      url,
      geometry,
      detail: `${targetLabel} 运行中 (${geometry} · 16位色 · 低画质高压缩 · 0公网暴露)`,
      profileId: meta?.profileId,
      profileName: meta?.profileName,
    });

    await vscode.env.openExternal(vscode.Uri.parse(url));
    return {
      ok: true,
      state: this.getDesktopState(),
      message: `已打开 ${targetLabel} 的远程登录画面！浏览器支持 Ctrl+V，终端支持 Ctrl+Shift+V 粘贴。`,
    };
  }

  /** 将指定文本（如本机剪贴板或 DevSpace 密码）通过 SSH 写入远程桌面 :1 剪贴板 */
  public async syncClipboardToRemote(
    cfg: BridgeConfig,
    text: string,
    label = "本机剪贴板"
  ): Promise<{ ok: boolean; message: string }> {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath || !fs.existsSync(cfg.sshKeyPath)) {
      return { ok: false, message: "请先为当前目标服务器配置地址与私钥路径。" };
    }
    if (!text) {
      return { ok: false, message: `${label}内容为空，请先复制文本后再同步。` };
    }
    const byteLen = Buffer.byteLength(text, "utf8");
    if (byteLen > 64 * 1024) {
      return { ok: false, message: "剪贴板文本超过 64KB 上限，请缩短后再同步。" };
    }

    const b64 = Buffer.from(text, "utf8").toString("base64");
    const proxy = resolveSshProxy(cfg);
    // 注意：xclip -i 会在后台保持 X11 selection 所有权，必须重定向 stdout/stderr 到 /dev/null 避免 SSH 阻塞
    const remoteCmd = [
      'if ! pgrep -u "$USER" -f "Xtigervnc :1" >/dev/null 2>&1; then echo "NO_DESKTOP"; exit 2; fi',
      'if ! command -v xclip >/dev/null 2>&1; then sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y xclip >/dev/null 2>&1 || true; fi',
      'if ! command -v xclip >/dev/null 2>&1; then echo "NO_XCLIP"; exit 3; fi',
      'export DISPLAY=":1"',
      `printf '%s' '${b64}' | base64 -d | xclip -selection clipboard -i >/dev/null 2>&1`,
      `printf '%s' '${b64}' | base64 -d | xclip -selection primary -i >/dev/null 2>&1`,
      'echo "CLIP_OK"',
    ].join("; ");

    const res = await this.execSsh(
      [
        ...buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null }),
        `${cfg.sshUser}@${cfg.sshHost}`,
        remoteCmd,
      ],
      25_000
    );

    if (!res.ok || !res.stdout.includes("CLIP_OK")) {
      if (res.stdout.includes("NO_DESKTOP")) {
        return {
          ok: false,
          message: "目标服务器的远程临时桌面尚未启动，请先点击「打开远程登录画面」。",
        };
      }
      if (res.stdout.includes("NO_XCLIP")) {
        return {
          ok: false,
          message: "远程 VPS 缺少 xclip 且无法自动安装，请先重新运行第 2 步或在远程执行 sudo apt install -y xclip。",
        };
      }
      return {
        ok: false,
        message: `同步到远程剪贴板失败：${res.stderr || res.stdout || "SSH 执行超时"}`,
      };
    }

    this.logger.info(
      "Wizard",
      `已同步${label}到远程桌面剪贴板 (${cfg.sshHost}, ${text.length} 字符)`
    );
    return {
      ok: true,
      message: `已将${label}（${text.length} 字符）发送到远程剪贴板！远程浏览器按 Ctrl+V，终端按 Ctrl+Shift+V 即可粘贴。`,
    };
  }

  /** 关闭本地 6080 转发并彻底销毁远程临时桌面释放内存 */
  public async stopRemoteLoginDesktop(
    cfg: BridgeConfig
  ): Promise<{ ok: boolean; state: LoginDesktopState; message: string }> {
    this.stopLocalDesktopTunnel();

    if (cfg.sshHost && cfg.sshUser && cfg.sshKeyPath && fs.existsSync(cfg.sshKeyPath)) {
      const proxy = resolveSshProxy(cfg);
      await this.execSsh(
        [
          ...buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null }),
          `${cfg.sshUser}@${cfg.sshHost}`,
          'if [ -x "$HOME/.local/bin/claude-login-desktop" ]; then "$HOME/.local/bin/claude-login-desktop" stop; fi',
        ],
        12_000
      );
    }

    this.setDesktopState({
      running: false,
      url: "",
      geometry: this.desktopState.geometry,
      detail: "已关闭（VPS 桌面内存占用已归零）",
      profileId: undefined,
      profileName: undefined,
    });
    this.logger.info("Wizard", "已关闭远程临时桌面并释放内存");
    return {
      ok: true,
      state: this.getDesktopState(),
      message: "已关闭远程临时桌面，VPS 桌面内存占用已归零。",
    };
  }

  /** Step 4：一键验收远程 Claude 登录状态与 DevSpace MCP 连通状态 */
  public async verifyRemoteReady(
    cfg: BridgeConfig,
    options?: { forwardDevspace?: boolean }
  ): Promise<RemoteVerifyResult> {
    const empty: RemoteVerifyResult = {
      sshOk: false,
      claudeInstalled: false,
      claudeVersion: "",
      claudeLoggedIn: false,
      devspaceMcpConnected: false,
      desktopInstalled: false,
      desktopRunning: false,
      summary: "尚未配置服务器地址或私钥。",
    };

    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyPath || !fs.existsSync(cfg.sshKeyPath)) {
      return empty;
    }

    const proxy = resolveSshProxy(cfg);
    const probeScript = [
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"',
      'echo "SSH_OK=1"',
      'CLAUDE_VER=$(claude --version 2>/dev/null || true)',
      'echo "CLAUDE_VER=$CLAUDE_VER"',
      'if [ -s "$HOME/.claude/.credentials.json" ]; then echo "CLAUDE_CRED=1"; else echo "CLAUDE_CRED=0"; fi',
      'if [ -x "$HOME/.local/bin/claude-login-desktop" ]; then echo "DESK_INST=1"; echo "DESK_STAT=$("$HOME/.local/bin/claude-login-desktop" status 2>/dev/null || echo STOPPED)"; else echo "DESK_INST=0"; echo "DESK_STAT=STOPPED"; fi',
      'MCP_OUT=$(claude mcp list 2>&1 || true)',
      'if echo "$MCP_OUT" | grep -i "devspace" | grep -qi "connected"; then echo "MCP_OK=1"; else echo "MCP_OK=0"; fi',
    ].join("; ");

    const sshArgs = buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null });
    if (options?.forwardDevspace) {
      sshArgs.push(
        "-R",
        `127.0.0.1:${cfg.remotePort || 7676}:127.0.0.1:${cfg.localPort || 7676}`
      );
    }
    sshArgs.push(`${cfg.sshUser}@${cfg.sshHost}`, probeScript);

    const res = await this.execSsh(sshArgs, 25_000);

    if (!res.ok) {
      return {
        ...empty,
        summary: `SSH 连接失败：${res.stderr || "超时或拒绝连接"}`,
      };
    }

    const kv: Record<string, string> = {};
    for (const line of res.stdout.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }

    const claudeInstalled = Boolean(kv.CLAUDE_VER);
    const claudeLoggedIn = kv.CLAUDE_CRED === "1";
    const devspaceMcpConnected = kv.MCP_OK === "1";
    const desktopInstalled = kv.DESK_INST === "1";
    const desktopRunning = kv.DESK_STAT === "RUNNING";

    let summary = "全部检查通过，可以关闭临时桌面并开始对话！";
    if (!claudeInstalled) {
      summary = "远程尚未安装 Claude Code CLI，请先执行第 2 步。";
    } else if (!claudeLoggedIn) {
      summary = "远程 Claude 尚未登录账号，请在第 3 步打开登录画面完成登录。";
    } else if (!devspaceMcpConnected) {
      summary = "DevSpace MCP 尚未完成首次授权，请确保隧道已连接并在远程执行 /mcp 输入密码。";
    }

    return {
      sshOk: true,
      claudeInstalled,
      claudeVersion: kv.CLAUDE_VER || "",
      claudeLoggedIn,
      devspaceMcpConnected,
      desktopInstalled,
      desktopRunning,
      summary,
    };
  }

  private stopLocalDesktopTunnel(): void {
    if (this.desktopTunnelProc) {
      try {
        this.desktopTunnelProc.kill("SIGTERM");
      } catch {
        // 忽略
      }
      this.desktopTunnelProc = undefined;
    }
  }

  private setDesktopState(next: LoginDesktopState): void {
    this.desktopState = next;
    this.desktopEmitter.fire(this.getDesktopState());
  }

  private buildLocalEnv(devspaceBin: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const binDir = path.dirname(devspaceBin);
    if (binDir && binDir !== ".") {
      const sep = process.platform === "win32" ? ";" : ":";
      env.PATH = `${binDir}${sep}${env.PATH ?? ""}`;
    }
    return env;
  }

  private runSimpleCmd(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { env, timeout: 6000, shell: process.platform === "win32" },
        (err, stdout) => {
          if (err) {
            resolve("");
            return;
          }
          resolve((stdout ?? "").trim().split(/\r?\n/)[0] || "");
        }
      );
    });
  }

  private spawnStreaming(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onLog: (line: string) => void
  ): Promise<number> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        env,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (buf: Buffer) => {
        for (const l of buf.toString("utf8").split(/\r?\n/)) {
          if (l.trim()) onLog(l);
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        for (const l of buf.toString("utf8").split(/\r?\n/)) {
          if (l.trim()) onLog(l);
        }
      });
      child.on("error", (err) => {
        onLog(`命令启动失败: ${err.message}`);
        resolve(-1);
      });
      child.on("close", (code) => resolve(code ?? -1));
    });
  }

  private execSsh(
    args: string[],
    timeoutMs: number
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile("ssh", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            stdout: stdout ?? "",
            stderr: (stderr ?? "").trim() || err.message,
          });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
    });
  }

  private isLocalPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const done = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(800);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  }

  public dispose(): void {
    this.stopLocalDesktopTunnel();
    this.desktopEmitter.dispose();
  }
}

/** 构造在远程 Ubuntu/Debian VPS 上执行的无交互初始化脚本 */
function buildRemoteInitScript(opts: {
  timezone: string;
  remotePort: number;
  withDesktop: boolean;
  geometry: string;
}): string {
  const safeTz = /^[A-Za-z0-9_/+.-]+$/.test(opts.timezone)
    ? opts.timezone
    : "America/New_York";
  const safeGeom = /^\d{3,4}x\d{3,4}$/.test(opts.geometry)
    ? opts.geometry
    : "1366x768";

  return `#!/usr/bin/env bash
set -euo pipefail

echo "[1/5] 配置基础工具、英文语言与时区 (${safeTz})..."
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg python3 locales
sudo locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
sudo timedatectl set-timezone "${safeTz}" || true

echo "[2/5] 配置 sshd 服务端心跳（防止切 VPN 残留僵尸端口）..."
sudo mkdir -p /etc/ssh/sshd_config.d
printf "ClientAliveInterval 30\\nClientAliveCountMax 3\\n" | sudo tee /etc/ssh/sshd_config.d/99-claude-bridge-keepalive.conf >/dev/null
sudo sshd -t
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd 2>/dev/null || true

echo "[3/5] 检查并安装 Claude Code CLI..."
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
fi
echo "Claude CLI: $(claude --version 2>/dev/null || echo installed)"

echo "[4/5] 注册用户级 DevSpace MCP (127.0.0.1:${opts.remotePort})..."
claude mcp remove devspace -s user >/dev/null 2>&1 || true
claude mcp add --scope user --transport http devspace "http://127.0.0.1:${opts.remotePort}/mcp"

mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/CLAUDE.md" ]; then
  cat > "$HOME/.claude/CLAUDE.md" << 'RULE_EOF'
# Workspace Routing Rule (DevSpace MCP)

You are running on a remote host, while the user's actual code repositories live on their local machine and are exposed through the \`devspace\` MCP server.

## Mandatory Rules
1. Always prefer \`devspace\` MCP tools to open, browse, search, read, edit, and run commands in the user's local project directories.
2. Do NOT use remote host filesystem tools (\`Read\`, \`Edit\`, \`Write\`, \`Glob\`, \`Grep\`, \`Bash\`) to look for or modify the user's project source code unless explicitly asked to inspect this remote machine itself.
3. Keep all file operations strictly inside the user-specified local workspace exposed by DevSpace.
RULE_EOF
fi

if [ "${opts.withDesktop ? "true" : "false"}" = "true" ]; then
  echo "[5/5] 安装极简 noVNC 登录桌面（openbox 无背景 + TigerVNC 16位色 + xclip + Google Chrome）..."
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \\
    tigervnc-standalone-server novnc websockify openbox x11-xserver-utils \\
    xterm xclip xdg-utils fonts-dejavu-core fonts-noto-cjk wget

  if ! command -v google-chrome >/dev/null 2>&1; then
    wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y /tmp/google-chrome.deb
    rm -f /tmp/google-chrome.deb
  fi

  mkdir -p "$HOME/.local/bin"
  cat > "$HOME/.local/bin/claude-login-desktop" << 'DESK_EOF'
${buildLoginDesktopScript(safeGeom)}DESK_EOF
  chmod +x "$HOME/.local/bin/claude-login-desktop"
  echo "极简 noVNC 登录桌面已安装就绪（默认未启动，0 内存占用）。"
else
  echo "[5/5] 已按选项跳过登录桌面安装。"
fi

echo "ALL_DONE"
`;
}

/** 构造远程按需启停脚本 ~/.local/bin/claude-login-desktop（支持 xterm Ctrl+Shift+V 常规粘贴） */
function buildLoginDesktopScript(defaultGeom: string): string {
  const safeGeom = /^\d{3,4}x\d{3,4}$/.test(defaultGeom)
    ? defaultGeom
    : "1366x768";

  return `#!/usr/bin/env bash
set -euo pipefail
ACTION="\${1:-status}"
GEOM="\${2:-${safeGeom}}"
DISPLAY_NUM=":1"
VNC_PORT="5901"
NOVNC_PORT="6080"
PID_DIR="$HOME/.cache/claude-login-desktop"
mkdir -p "$PID_DIR"

clamp_geometry() {
  local raw="$1"
  local w="\${raw%x*}"
  local h="\${raw#*x}"
  if ! [[ "$w" =~ ^[0-9]+$ && "$h" =~ ^[0-9]+$ ]]; then echo "1366x768"; return; fi
  if (( w > 1366 )); then w=1366; fi
  if (( h > 768 )); then h=768; fi
  if (( w < 800 )); then w=800; fi
  if (( h < 600 )); then h=600; fi
  echo "\${w}x\${h}"
}

stop_all() {
  if [ -f "$PID_DIR/novnc.pid" ]; then
    kill "$(cat "$PID_DIR/novnc.pid")" 2>/dev/null || true
    rm -f "$PID_DIR/novnc.pid"
  fi
  pkill -u "$USER" -f "websockify.*127\\.0\\.0\\.1:\${NOVNC_PORT}" 2>/dev/null || true
  pkill -u "$USER" -f "Xtigervnc \${DISPLAY_NUM}" 2>/dev/null || true
  rm -f "/tmp/.X1-lock" "/tmp/.X11-unix/X1" 2>/dev/null || true
  echo "STOPPED"
}

start_all() {
  stop_all >/dev/null 2>&1 || true
  local safe_geom
  safe_geom="$(clamp_geometry "$GEOM")"

  Xtigervnc "$DISPLAY_NUM" -localhost yes -rfbport "$VNC_PORT" -SecurityTypes None \\
    -geometry "$safe_geom" -depth 16 -dpi 96 -AlwaysShared -AcceptSetDesktopSize=0 \\
    >"$PID_DIR/vnc.log" 2>&1 &
  echo $! >"$PID_DIR/vnc.pid"
  sleep 1

  export DISPLAY="$DISPLAY_NUM"
  export LANG="en_US.UTF-8"
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  xsetroot -solid "#181818" 2>/dev/null || true
  openbox >"$PID_DIR/openbox.log" 2>&1 &

  xterm -fa "DejaVu Sans Mono" -fs 11 -bg "#111111" -fg "#eeeeee" -geometry 96x26+40+40 \\
    -xrm 'XTerm*selectToClipboard: true' \\
    -xrm 'XTerm*VT100.translations: #override \\n Ctrl Shift <Key>V: insert-selection(CLIPBOARD) \\n Ctrl Shift <Key>C: copy-selection(CLIPBOARD)' \\
    -T "Claude Login Terminal" \\
    -e bash -lc 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; echo "=== Claude 首次登录终端 ==="; echo "1. 输入 claude 完成账号登录"; echo "2. 登录后输入 /mcp 授权 devspace"; echo "提示：在 VS Code 点「同步剪贴板到远程」后，浏览器按 Ctrl+V、终端按 Ctrl+Shift+V 即可粘贴"; echo ""; exec bash' \\
    >"$PID_DIR/xterm.log" 2>&1 &

  websockify --web=/usr/share/novnc "127.0.0.1:\${NOVNC_PORT}" "127.0.0.1:\${VNC_PORT}" \\
    >"$PID_DIR/novnc.log" 2>&1 &
  echo $! >"$PID_DIR/novnc.pid"
  sleep 1
  echo "READY geometry=\${safe_geom}"
}

case "$ACTION" in
  start) start_all ;;
  stop) stop_all ;;
  status)
    if pgrep -u "$USER" -f "Xtigervnc \${DISPLAY_NUM}" >/dev/null 2>&1 && pgrep -u "$USER" -f "websockify.*127\\.0\\.0\\.1:\${NOVNC_PORT}" >/dev/null 2>&1; then
      echo "RUNNING"
    else
      echo "STOPPED"
    fi
    ;;
esac
`;
}
