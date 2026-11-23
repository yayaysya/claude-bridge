import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { BridgeManager } from "./bridgeManager";
import {
  BridgeConfig,
  buildBaseSshArgs,
  EffortLevel,
  expandHomePath,
  getBridgeConfig,
  PermissionMode,
  resolveSshProxy,
  updateBridgeConfigValues,
} from "./config";
import { BridgeLogger } from "./logger";
import { MemoryManager, RemoteMemoryItem } from "./memoryManager";
import { RulesSyncManager } from "./rulesSync";

/**
 * 专属可视化「设置中心」WebviewPanel（替代难用的 VS Code 原生设置页）
 * 单例模式：重复打开时自动聚焦已有标签页。
 */
export class SettingsPanel {
  private static currentPanel: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private cachedMemories: RemoteMemoryItem[] = [];

  public static show(params: {
    extensionUri: vscode.Uri;
    bridge: BridgeManager;
    rulesSync: RulesSyncManager;
    memory: MemoryManager;
    logger: BridgeLogger;
    focusSection?: "server" | "memory";
  }): SettingsPanel {
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      SettingsPanel.currentPanel.syncState(params.focusSection);
      return SettingsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeBridge.settings",
      "ClaudeBridge · 渡桥 设置中心",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(params.extensionUri, "media"),
          vscode.Uri.joinPath(params.extensionUri, "dist"),
        ],
      }
    );

    SettingsPanel.currentPanel = new SettingsPanel(
      panel,
      params.extensionUri,
      params.bridge,
      params.rulesSync,
      params.memory,
      params.logger
    );

    if (params.focusSection) {
      SettingsPanel.currentPanel.syncState(params.focusSection);
    }
    return SettingsPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: BridgeManager,
    private readonly rulesSync: RulesSyncManager,
    private readonly memory: MemoryManager,
    private readonly logger: BridgeLogger
  ) {
    this.panel = panel;
    this.cachedMemories = this.memory.listCachedBackups();
    this.panel.webview.html = this.renderHtml(this.panel.webview);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.bridge.onDidChangeState(() => this.syncState()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("claudeBridge") ||
          e.affectsConfiguration("ec2Claude")
        ) {
          this.syncState();
        }
      }),
      this.panel.webview.onDidReceiveMessage((msg) => {
        void this.handleMessage(msg);
      })
    );
  }

  /** 外部直接触发拉取远程记忆并刷新设置中心记忆列表 */
  public async triggerPullMemories(): Promise<void> {
    await this.handlePullMemories();
  }

  public syncState(focusSection?: string): void {
    const cfg = getBridgeConfig();
    const envProxy =
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      "";

    void this.panel.webview.postMessage({
      type: "state",
      payload: {
        config: cfg,
        bridge: this.bridge.getState(),
        envProxy,
        logFilePath: this.logger.getLogFilePath(),
        memoryBackupDir: this.memory.getBackupDir(),
        memories: this.cachedMemories,
        focusSection: focusSection ?? null,
      },
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
        this.syncState();
        break;

      case "save": {
        const form = (msg.config as Partial<BridgeConfig> | undefined) ?? {};
        const reconnect = Boolean(msg.reconnect);
        await this.saveConfig(form, reconnect);
        break;
      }

      case "pickKeyFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "选择 SSH 私钥文件",
          defaultUri: vscode.Uri.file(os.homedir()),
          filters: {
            "SSH 私钥": ["pem", "key", "pub"],
            "所有文件": ["*"],
          },
        });
        if (picked && picked[0]) {
          void this.panel.webview.postMessage({
            type: "pickedKeyFile",
            path: picked[0].fsPath,
          });
        }
        break;
      }

      case "pickRuleFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "添加本地规则文件 (Markdown)",
          defaultUri: vscode.Uri.file(path.join(os.homedir(), ".claude")),
          filters: {
            "Markdown 规则": ["md", "markdown", "txt"],
            "所有文件": ["*"],
          },
        });
        if (picked && picked[0]) {
          void this.panel.webview.postMessage({
            type: "pickedRuleFile",
            path: picked[0].fsPath,
          });
        }
        break;
      }

      case "testConnection": {
        const form = (msg.config as Partial<BridgeConfig> | undefined) ?? {};
        await this.runConnectionTest(form);
        break;
      }

      case "openLocalRules":
        await this.memory.openLocalClaudeMd(getBridgeConfig());
        break;

      case "syncRules": {
        const res = await this.rulesSync.sync(getBridgeConfig(), { force: true });
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "pullMemories":
        await this.handlePullMemories();
        break;

      case "openMemoryFile": {
        const localPath = String(msg.localBackupPath ?? "");
        if (localPath && fs.existsSync(localPath)) {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(localPath)
          );
          await vscode.window.showTextDocument(doc, { preview: false });
        }
        break;
      }

      case "mergeMemory": {
        const memId = String(msg.id ?? "");
        const found = this.cachedMemories.find((m) => m.id === memId);
        if (!found) {
          return;
        }
        const info = await this.memory.mergeMemoryIntoLocalClaudeMd(
          getBridgeConfig(),
          found
        );
        void this.panel.webview.postMessage({
          type: "toast",
          ok: true,
          message: info,
        });
        break;
      }

      case "openLogFile":
        await this.logger.openLogFile();
        break;

      case "openRawSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "claudeBridge"
        );
        break;
    }
  }

  private async saveConfig(
    raw: Partial<BridgeConfig>,
    reconnect: boolean
  ): Promise<void> {
    const patch: Partial<BridgeConfig> = {
      sshHost: String(raw.sshHost ?? "").trim(),
      sshUser: String(raw.sshUser ?? "ubuntu").trim() || "ubuntu",
      sshPort: Number(raw.sshPort) || 22,
      sshKeyPath: String(raw.sshKeyPath ?? "").trim(),
      sshProxy: String(raw.sshProxy ?? "auto").trim() || "auto",
      localPort: Number(raw.localPort) || 7676,
      remotePort: Number(raw.remotePort) || 7676,
      devspacePath: String(raw.devspacePath ?? "").trim(),
      remoteClaudePath: String(raw.remoteClaudePath ?? "claude").trim() || "claude",
      permissionMode: (raw.permissionMode ?? "bypassPermissions") as PermissionMode,
      model: String(raw.model ?? "").trim(),
      effort: (raw.effort ?? "") as EffortLevel,
      autoConnect: Boolean(raw.autoConnect),
      autoReconnect: Boolean(raw.autoReconnect),
      keepRunningOnClose: Boolean(raw.keepRunningOnClose),
      autoAttachWorkspaceContext: Boolean(raw.autoAttachWorkspaceContext),
      syncLocalRules: Boolean(raw.syncLocalRules),
      localClaudeMdPaths: Array.isArray(raw.localClaudeMdPaths)
        ? raw.localClaudeMdPaths.map((s) => String(s).trim()).filter(Boolean)
        : ["~/.claude/CLAUDE.md"],
    };

    await updateBridgeConfigValues(patch);
    this.syncState();

    if (reconnect) {
      const ok = await this.bridge.connect(true);
      void this.panel.webview.postMessage({
        type: "toast",
        ok,
        message: ok
          ? "设置已保存并成功重新连接远程服务器。"
          : `设置已保存，但重连失败：${this.bridge.getState().detail}`,
      });
    } else {
      void this.panel.webview.postMessage({
        type: "toast",
        ok: true,
        message: "设置已保存。",
      });
    }
  }

  private async runConnectionTest(form: Partial<BridgeConfig>): Promise<void> {
    const base = getBridgeConfig();
    const cfg: BridgeConfig = {
      ...base,
      sshHost: String(form.sshHost ?? base.sshHost).trim(),
      sshUser: String(form.sshUser ?? base.sshUser).trim() || "ubuntu",
      sshPort: Number(form.sshPort) || base.sshPort,
      sshKeyPath: expandHomePath(String(form.sshKeyPath ?? base.sshKeyPath)),
      sshProxy: String(form.sshProxy ?? base.sshProxy).trim() || "auto",
      remotePort: Number(form.remotePort) || base.remotePort,
      remoteClaudePath:
        String(form.remoteClaudePath ?? base.remoteClaudePath).trim() || "claude",
    };

    if (!cfg.sshHost || !cfg.sshKeyPath) {
      void this.panel.webview.postMessage({
        type: "testResult",
        ok: false,
        summary: "请先填写服务器地址和本地 SSH 私钥路径。",
      });
      return;
    }

    if (!fs.existsSync(cfg.sshKeyPath)) {
      void this.panel.webview.postMessage({
        type: "testResult",
        ok: false,
        summary: `找不到本地私钥文件：${cfg.sshKeyPath}`,
      });
      return;
    }

    const proxy = resolveSshProxy(cfg);
    const startAt = Date.now();
    const args = [
      ...buildBaseSshArgs(cfg, { batchMode: true, proxy: proxy ?? null }),
      `${cfg.sshUser}@${cfg.sshHost}`,
      `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; echo "HOST=$(hostname)"; echo "CLAUDE=$(${cfg.remoteClaudePath || "claude"} --version 2>/dev/null || echo NOT_FOUND)"; echo "MCP=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${cfg.remotePort}/mcp || echo 000)"`,
    ];

    const res = await new Promise<{ ok: boolean; stdout: string; stderr: string }>(
      (resolve) => {
        execFile("ssh", args, { timeout: 18_000 }, (err, stdout, stderr) => {
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
      }
    );

    const elapsed = Date.now() - startAt;
    if (!res.ok) {
      void this.panel.webview.postMessage({
        type: "testResult",
        ok: false,
        summary: `SSH 连接失败（${elapsed}ms${proxy ? `，经由代理 ${proxy.display}` : "，直连"}）：${res.stderr}`,
      });
      return;
    }

    const map: Record<string, string> = {};
    for (const line of res.stdout.split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    const mcpOk = map.MCP && map.MCP !== "000";
    void this.panel.webview.postMessage({
      type: "testResult",
      ok: true,
      summary: `连接成功（${elapsed}ms · ${proxy ? `代理 ${proxy.host}:${proxy.port}` : "直连"}） | 主机: ${map.HOST || cfg.sshHost} | Claude: ${map.CLAUDE || "未知"} | 隧道端口: ${mcpOk ? "已连通" : "尚未建立"}`,
    });
  }

  private async handlePullMemories(): Promise<void> {
    void this.panel.webview.postMessage({ type: "memoriesLoading", loading: true });
    const res = await this.memory.pullRemoteMemories(getBridgeConfig());
    this.cachedMemories = res.items;
    void this.panel.webview.postMessage({ type: "memoriesLoading", loading: false });
    this.syncState();
    void this.panel.webview.postMessage({
      type: "toast",
      ok: res.ok,
      message: res.message,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "settings.css")
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "settings.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ClaudeBridge · 渡桥 设置中心</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div class="page">
    <header class="page-head">
      <div class="head-brand">
        <div class="brand-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L14.4 9.2L22 12L14.4 14.8L12 22L9.6 14.8L2 12L9.6 9.2L12 2Z"/>
          </svg>
        </div>
        <div>
          <h1>ClaudeBridge · 渡桥</h1>
          <p class="subtitle">可视化配置中心 · 代码留在本地，AI 推理留在远程</p>
        </div>
      </div>
      <div class="head-actions">
        <span id="bridgeBadge" class="status-badge"><span class="dot"></span><span>检测中</span></span>
        <button id="saveBtn" class="btn secondary">仅保存</button>
        <button id="saveReconnectBtn" class="btn primary">保存并重连</button>
      </div>
    </header>

    <div id="toastBar" class="toast-bar"></div>

    <!-- 卡片 1：远程服务器与隧道 -->
    <section class="card" id="section-server">
      <div class="card-head">
        <div>
          <h2>远程服务器与隧道</h2>
          <p class="card-desc">配置远程 Linux / VPS 服务器 SSH 信息与代理策略，所有配置自动写入正确作用域。</p>
        </div>
      </div>

      <div class="grid-3">
        <div class="field span-2">
          <label for="sshHost">服务器地址 (IP 或域名)</label>
          <input id="sshHost" type="text" placeholder="例如 1.2.3.4 或 my-vps.example.com" />
        </div>
        <div class="field">
          <label for="sshPort">SSH 端口</label>
          <input id="sshPort" type="number" min="1" max="65535" placeholder="22" />
        </div>
      </div>

      <div class="grid-3">
        <div class="field">
          <label for="sshUser">SSH 用户名</label>
          <input id="sshUser" type="text" placeholder="ubuntu" />
        </div>
        <div class="field span-2">
          <label for="sshKeyPath">本地 SSH 私钥 (.pem)</label>
          <div class="input-with-btn">
            <input id="sshKeyPath" type="text" placeholder="例如 ~/.ssh/my-server.pem" />
            <button id="pickKeyBtn" class="btn secondary small" type="button">选择文件</button>
          </div>
        </div>
      </div>

      <div class="field">
        <label>SSH 代理策略（不写死端口，随时切换）</label>
        <div class="seg-group" id="proxyModeGroup">
          <button type="button" class="seg-btn" data-proxy-mode="auto">自动跟随环境代理 (推荐)</button>
          <button type="button" class="seg-btn" data-proxy-mode="off">强制直连</button>
          <button type="button" class="seg-btn" data-proxy-mode="custom">自定义代理地址</button>
        </div>
        <div id="proxyAutoHint" class="field-hint"></div>
        <div id="proxyCustomWrap" class="custom-proxy-wrap">
          <input id="sshProxyCustom" type="text" placeholder="例如 http://127.0.0.1:8080 或 socks5://127.0.0.1:1080" />
        </div>
      </div>

      <div class="card-footer">
        <button id="testConnBtn" class="btn secondary" type="button">测试连接</button>
        <div id="testResultBox" class="test-result"></div>
      </div>
    </section>

    <!-- 卡片 2：规则与记忆中心 -->
    <section class="card" id="section-memory">
      <div class="card-head">
        <div>
          <h2>规则与记忆中心</h2>
          <p class="card-desc">管理本地 CLAUDE.md 无损同步，并查看/备份远程 Claude 自动记住的编程习惯。</p>
        </div>
      </div>

      <div class="sub-block">
        <div class="toggle-row">
          <div>
            <div class="toggle-title">连接时自动同步本地 CLAUDE.md</div>
            <div class="toggle-desc">仅在本地文件内容变化时无损合并到远程 ~/.claude/CLAUDE.md，不覆盖远程路由规则</div>
          </div>
          <label class="switch-wrap">
            <input id="syncLocalRules" type="checkbox" />
            <span class="slider"></span>
          </label>
        </div>

        <div class="field" style="margin-top: 10px;">
          <label>本地规则文件列表</label>
          <div id="rulePathsList" class="path-list"></div>
          <div class="inline-actions">
            <button id="addRulePathBtn" class="btn secondary small" type="button">+ 添加规则文件</button>
            <button id="openLocalRuleBtn" class="btn secondary small" type="button">打开本地 CLAUDE.md</button>
            <button id="syncRulesNowBtn" class="btn secondary small" type="button">立即同步到远程</button>
          </div>
        </div>
      </div>

      <div class="divider"></div>

      <div class="sub-block">
        <div class="memory-head">
          <div>
            <div class="toggle-title">远程 Claude 自动记忆 (memory/)</div>
            <div class="toggle-desc" id="memoryBackupHint">将远程 Claude 记住的习惯拉取并备份到本地，防止更换服务器时丢失</div>
          </div>
          <button id="pullMemoriesBtn" class="btn secondary small" type="button">拉取并备份远程记忆</button>
        </div>
        <div id="memoriesList" class="memories-list"></div>
      </div>
    </section>

    <!-- 卡片 3：对话与连接习惯 -->
    <section class="card">
      <div class="card-head">
        <div>
          <h2>对话与连接习惯</h2>
          <p class="card-desc">设置默认权限、模型、思考强度与自动重连行为。</p>
        </div>
      </div>

      <div class="grid-3">
        <div class="field">
          <label for="permissionMode">默认权限模式</label>
          <select id="permissionMode">
            <option value="bypassPermissions">全部允许 (Bypass)</option>
            <option value="acceptEdits">自动改文件 (Accept Edits)</option>
            <option value="plan">只读规划 (Plan)</option>
            <option value="dontAsk">严格受限 (DontAsk)</option>
          </select>
        </div>
        <div class="field">
          <label for="model">默认模型（留空跟随远程）</label>
          <input id="model" type="text" list="modelPresets" placeholder="Default（留空）" />
          <datalist id="modelPresets">
            <option value="claude-opus-5-5"></option>
            <option value="claude-fable-5-2[1m]"></option>
            <option value="claude-sonnet-5-5"></option>
            <option value="claude-haiku-5-5"></option>
          </datalist>
        </div>
        <div class="field">
          <label for="effort">默认思考强度 (--effort)</label>
          <select id="effort">
            <option value="">Default（跟随远程）</option>
            <option value="low">low（快速）</option>
            <option value="medium">medium（均衡）</option>
            <option value="high">high（深入）</option>
            <option value="xhigh">xhigh（超高）</option>
            <option value="max">max（极限）</option>
          </select>
        </div>
      </div>

      <div class="toggles-stack">
        <div class="toggle-row">
          <div>
            <div class="toggle-title">打开 VS Code 时自动连接</div>
            <div class="toggle-desc">重启电脑或新开窗口时自动拉起本地 DevSpace 并建立 SSH 反向隧道</div>
          </div>
          <label class="switch-wrap"><input id="autoConnect" type="checkbox" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-title">断线自动重连</div>
            <div class="toggle-desc">切换 VPN、网络闪断或休眠唤醒后自动恢复隧道并清理远程僵尸端口</div>
          </div>
          <label class="switch-wrap"><input id="autoReconnect" type="checkbox" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-title">自动附带轻量工作区与 Git 现场</div>
            <div class="toggle-desc">发送消息时自动告知当前项目目录、打开文件与 Git 分支（同一会话无变化自动去重）</div>
          </div>
          <label class="switch-wrap"><input id="autoAttachWorkspaceContext" type="checkbox" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-title">关闭窗口时保持后台服务运行</div>
            <div class="toggle-desc">多窗口协作或频繁重启 VS Code 时可保持隧道不断开</div>
          </div>
          <label class="switch-wrap"><input id="keepRunningOnClose" type="checkbox" /><span class="slider"></span></label>
        </div>
      </div>
    </section>

    <!-- 卡片 4：高级路径与诊断 -->
    <details class="card advanced-card">
      <summary class="advanced-summary">
        <span>高级路径、端口与诊断日志</span>
        <span class="summary-hint">通常保持默认即可</span>
      </summary>
      <div class="advanced-body">
        <div class="grid-2">
          <div class="field">
            <label for="localPort">本地 DevSpace 端口</label>
            <input id="localPort" type="number" min="1" max="65535" />
          </div>
          <div class="field">
            <label for="remotePort">远程回环映射端口</label>
            <input id="remotePort" type="number" min="1" max="65535" />
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="devspacePath">本地 devspace 路径（留空自动查找）</label>
            <input id="devspacePath" type="text" placeholder="留空自动搜索 PATH 与 nvm" />
          </div>
          <div class="field">
            <label for="remoteClaudePath">远程 claude 命令或路径</label>
            <input id="remoteClaudePath" type="text" placeholder="claude" />
          </div>
        </div>
        <div class="inline-actions" style="margin-top: 8px;">
          <button id="openLogBtn" class="btn secondary small" type="button">打开诊断日志 (bridge.log)</button>
          <button id="openRawSettingsBtn" class="btn secondary small" type="button">打开原始 VS Code 设置</button>
        </div>
      </div>
    </details>
  </div>

  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    SettingsPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
