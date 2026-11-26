import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { BridgeManager } from "./bridgeManager";
import {
  AgentEngineType,
  BridgeConfig,
  buildBaseSshArgs,
  ChatTheme,
  EffortLevel,
  expandHomePath,
  getBridgeConfig,
  getEngineDisplayName,
  normalizeEngineType,
  PermissionMode,
  resolveRemoteCliPath,
  resolveSshProxy,
  updateBridgeConfigValues,
  updateChatTheme,
} from "./config";
import { BridgeLogger } from "./logger";
import { MemoryManager, RemoteMemoryItem } from "./memoryManager";
import { RulesSyncManager } from "./rulesSync";
import { LocalSetupStatus, SetupWizardManager } from "./setupWizard";
import {
  ProfileStore,
  ServerProfile,
  profileToBridgeConfig,
} from "./profileStore";
import { HabitSuggestion, SkillManager } from "./skillManager";
import { SessionStore } from "./sessionStore";

export type SettingsTabId = "server" | "knowledge" | "preferences" | "wizard";

/**
 * 专属可视化「设置中心」+「新机配置向导」WebviewPanel
 * 单例模式：重复打开时自动聚焦已有标签页。
 */
export class SettingsPanel {
  private static currentPanel: SettingsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private cachedMemories: RemoteMemoryItem[] = [];
  private cachedHabits: HabitSuggestion[] = [];
  private cachedLocalStatus: LocalSetupStatus | undefined;
  private wizardTargetProfileId = "";

  public static show(params: {
    extensionUri: vscode.Uri;
    bridge: BridgeManager;
    rulesSync: RulesSyncManager;
    memory: MemoryManager;
    wizard: SetupWizardManager;
    profiles: ProfileStore;
    skills: SkillManager;
    sessions: SessionStore;
    logger: BridgeLogger;
    focusSection?: "server" | "memory";
    initialTab?: SettingsTabId;
  }): SettingsPanel {
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      SettingsPanel.currentPanel.syncState(
        params.focusSection,
        params.initialTab
      );
      if (params.initialTab === "wizard") {
        void SettingsPanel.currentPanel.refreshLocalWizardStatus();
      }
      return SettingsPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeBridge.settings",
      "DuDuNiao · 渡渡鸟 设置中心",
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
      params.wizard,
      params.profiles,
      params.skills,
      params.sessions,
      params.logger
    );

    SettingsPanel.currentPanel.syncState(
      params.focusSection,
      params.initialTab
    );
    void SettingsPanel.currentPanel.refreshLocalWizardStatus();
    return SettingsPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: BridgeManager,
    private readonly rulesSync: RulesSyncManager,
    private readonly memory: MemoryManager,
    private readonly wizard: SetupWizardManager,
    private readonly profiles: ProfileStore,
    private readonly skills: SkillManager,
    private readonly sessions: SessionStore,
    private readonly logger: BridgeLogger
  ) {
    this.panel = panel;
    this.cachedMemories = this.memory.listCachedBackups();
    this.wizardTargetProfileId = this.profiles.getActiveProfile().id;
    this.panel.webview.html = this.renderHtml(this.panel.webview);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.bridge.onDidChangeState(() => this.syncState()),
      this.wizard.onDidChangeDesktopState(() => this.syncState()),
      this.profiles.onDidChangeActiveProfile(() => this.syncState()),
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

  private async refreshLocalWizardStatus(): Promise<void> {
    this.cachedLocalStatus = await this.wizard.inspectLocalStatus(
      getBridgeConfig()
    );
    this.syncState();
  }

  /** 外部直接触发拉取远程记忆并刷新设置中心记忆列表 */
  public async triggerPullMemories(): Promise<void> {
    await this.handlePullMemories();
  }

  private getWizardTargetProfile(): ServerProfile {
    const found = this.wizardTargetProfileId
      ? this.profiles.getProfileById(this.wizardTargetProfileId)
      : undefined;
    if (found) {
      return found;
    }
    const active = this.profiles.getActiveProfile();
    this.wizardTargetProfileId = active.id;
    return active;
  }

  private getWizardTargetConfig(profile?: ServerProfile): BridgeConfig {
    return profileToBridgeConfig(
      getBridgeConfig(),
      profile ?? this.getWizardTargetProfile()
    );
  }

  private async saveWizardTargetPatch(
    raw: Record<string, unknown> | undefined
  ): Promise<ServerProfile> {
    const target = this.getWizardTargetProfile();
    if (!raw) {
      return target;
    }
    const patch: Partial<ServerProfile> & { id: string } = { id: target.id };
    if (typeof raw.name === "string" && raw.name.trim()) {
      patch.name = raw.name.trim();
    }
    if (raw.engine === "claude" || raw.engine === "antigravity") {
      patch.engine = raw.engine;
    }
    if (typeof raw.sshHost === "string") {
      patch.sshHost = raw.sshHost.trim();
    }
    if (typeof raw.sshUser === "string" && raw.sshUser.trim()) {
      patch.sshUser = raw.sshUser.trim();
    }
    if (raw.sshPort !== undefined && Number(raw.sshPort) > 0) {
      patch.sshPort = Number(raw.sshPort);
    }
    if (raw.remotePort !== undefined && Number(raw.remotePort) > 0) {
      patch.remotePort = Number(raw.remotePort);
    }
    if (typeof raw.sshKeyPath === "string") {
      patch.sshKeyPath = raw.sshKeyPath.trim();
    }
    return this.profiles.saveProfile(patch, false);
  }

  public syncState(focusSection?: string, activeTab?: SettingsTabId): void {
    const cfg = getBridgeConfig();
    const wizardTargetProfile = this.getWizardTargetProfile();
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
        activeProfile: this.profiles.getActiveProfile(),
        wizardTargetProfile,
        profiles: this.profiles.listProfiles(),
        bridge: this.bridge.getState(),
        envProxy,
        logFilePath: this.logger.getLogFilePath(),
        memoryBackupDir: this.memory.getBackupDir(),
        skillsDir: this.skills.getLocalSkillsDir(),
        skills: this.skills.listLocalSkills(),
        memories: this.cachedMemories,
        habits: this.cachedHabits,
        localStatus: this.cachedLocalStatus ?? null,
        desktopState: this.wizard.getDesktopState(),
        focusSection: focusSection ?? null,
        activeTab: activeTab ?? null,
      },
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    switch (type) {
      case "ready":
        this.syncState();
        void this.refreshLocalWizardStatus();
        break;

      case "copyText": {
        const text = String(msg.text ?? "");
        if (text) {
          await vscode.env.clipboard.writeText(text);
          void this.panel.webview.postMessage({
            type: "toast",
            ok: true,
            message: "已复制到剪贴板。",
          });
        }
        break;
      }

      case "wizardRefreshLocal":
        await this.refreshLocalWizardStatus();
        break;

      case "wizardPickProjectRoot": {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择要授权给 DevSpace 的项目根目录",
          defaultUri: vscode.Uri.file(os.homedir()),
        });
        if (picked && picked[0]) {
          void this.panel.webview.postMessage({
            type: "wizardPickedRoot",
            path: picked[0].fsPath,
          });
        }
        break;
      }

      case "wizardSetupLocal": {
        const projectRoot = String(msg.projectRoot ?? "").trim();
        void this.panel.webview.postMessage({ type: "wizardBusy", step: "local", busy: true });
        const res = await this.wizard.setupLocalDevspace(
          getBridgeConfig(),
          projectRoot,
          (line) => {
            void this.panel.webview.postMessage({ type: "wizardLog", target: "local", line });
          }
        );
        this.cachedLocalStatus = res.status;
        void this.panel.webview.postMessage({ type: "wizardBusy", step: "local", busy: false });
        this.syncState();
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "selectWizardTarget": {
        const pid = String(msg.profileId ?? "");
        const found = this.profiles.getProfileById(pid);
        if (!found) {
          return;
        }
        this.wizardTargetProfileId = found.id;
        this.syncState();
        break;
      }

      case "createWizardProfile": {
        const name = String(msg.name ?? "").trim();
        const engine = normalizeEngineType(msg.engine);
        const sshHost = String(msg.sshHost ?? "").trim();
        const active = this.profiles.getActiveProfile();
        const created = await this.profiles.createProfile(name, {
          makeActive: false,
          engine,
          sshHost,
        });
        this.wizardTargetProfileId = created.id;
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: true,
          message: `已在向导中新建目标档案「${created.name}」（远程端口 ${created.remotePort}），当前聊天仍保持在「${active.name}」不受影响。`,
        });
        break;
      }

      case "suggestRemotePort": {
        const sshHost = String(msg.sshHost ?? "").trim();
        const target = this.getWizardTargetProfile();
        const suggested = this.profiles.suggestNextRemotePort(sshHost, target.id);
        void this.panel.webview.postMessage({
          type: "suggestedRemotePort",
          port: suggested,
        });
        break;
      }

      case "saveWizardTarget": {
        const saved = await this.saveWizardTargetPatch(
          msg.target as Record<string, unknown> | undefined
        );
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: true,
          message: `已保存向导目标「${saved.name}」的连接参数。`,
        });
        break;
      }

      case "pickWizardKeyFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "选择目标服务器的 SSH 私钥文件",
          defaultUri: vscode.Uri.file(os.homedir()),
          filters: {
            "SSH 私钥": ["pem", "key", "pub"],
            "所有文件": ["*"],
          },
        });
        if (picked && picked[0]) {
          void this.panel.webview.postMessage({
            type: "pickedWizardKeyFile",
            path: picked[0].fsPath,
          });
        }
        break;
      }

      case "wizardSetupVps": {
        const target = await this.saveWizardTargetPatch(
          msg.target as Record<string, unknown> | undefined
        );
        this.syncState();
        const targetCfg = this.getWizardTargetConfig(target);
        const timezone = String(msg.timezone ?? "America/New_York");
        const withDesktop = Boolean(msg.withDesktop);
        const geometry = String(msg.geometry ?? "1366x768");

        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "vps",
          busy: true,
          profileId: target.id,
        });
        const res = await this.wizard.setupRemoteVps(
          targetCfg,
          { timezone, withDesktop, geometry },
          (line) => {
            void this.panel.webview.postMessage({
              type: "wizardLog",
              target: "vps",
              profileId: target.id,
              line,
            });
          }
        );
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "vps",
          busy: false,
          profileId: target.id,
        });
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "wizardSetupPasswordless": {
        const target = await this.saveWizardTargetPatch(
          msg.target as Record<string, unknown> | undefined
        );
        const targetCfg = this.getWizardTargetConfig(target);
        const host = String(msg.host ?? target.sshHost ?? "").trim();
        const port = Number(msg.port ?? target.sshPort) || 22;
        const loginUser = String(msg.loginUser ?? "root").trim() || "root";
        const password = String(msg.password ?? "");
        const createNonRootUser = Boolean(msg.createNonRootUser);
        const newUserName = String(msg.newUserName ?? "claude").trim() || "claude";

        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "passwordless",
          busy: true,
          profileId: target.id,
        });
        const res = await this.wizard.setupPasswordlessSsh(
          targetCfg,
          {
            host,
            port,
            loginUser,
            password,
            createNonRootUser,
            newUserName,
          },
          (line) => {
            void this.panel.webview.postMessage({
              type: "wizardLog",
              target: "passwordless",
              profileId: target.id,
              line,
            });
          }
        );
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "passwordless",
          busy: false,
          profileId: target.id,
        });

        if (res.ok) {
          await this.profiles.saveProfile(
            {
              id: target.id,
              sshHost: host,
              sshPort: port,
              sshUser: res.finalUser,
              sshKeyPath: res.keyPath,
            },
            false
          );
          this.syncState();
        }
        void this.panel.webview.postMessage({
          type: "passwordlessDone",
          ok: res.ok,
          profileId: target.id,
          message: res.message,
        });
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "wizardStartDesktop": {
        const target = await this.saveWizardTargetPatch(
          msg.target as Record<string, unknown> | undefined
        );
        const targetCfg = this.getWizardTargetConfig(target);
        const isActiveTarget = target.id === this.profiles.getActiveProfile().id;
        const geometry = String(msg.geometry ?? "1366x768");
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "desktop",
          busy: true,
          profileId: target.id,
        });
        // 若目标是当前主力机则确保主隧道连接；若目标是新机则只保证本机 DevSpace 存活，由临时桌面隧道顺带转发 /mcp，完全不打断主力机
        if (isActiveTarget) {
          if (this.bridge.getState().status !== "connected") {
            await this.bridge.connect(false);
          }
        } else {
          await this.bridge.ensureLocalDevspace(targetCfg);
        }
        const res = await this.wizard.startRemoteLoginDesktop(targetCfg, geometry, {
          profileId: target.id,
          profileName: target.name,
          forwardDevspace: !isActiveTarget,
        });
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "desktop",
          busy: false,
          profileId: target.id,
        });
        this.syncState();
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "wizardOpenDesktopUrl": {
        const st = this.wizard.getDesktopState();
        if (st.running && st.url) {
          await vscode.env.openExternal(vscode.Uri.parse(st.url));
        }
        break;
      }

      case "wizardStopDesktop": {
        const ds = this.wizard.getDesktopState();
        const ownerProfile =
          (ds.profileId && this.profiles.getProfileById(ds.profileId)) ||
          this.getWizardTargetProfile();
        const res = await this.wizard.stopRemoteLoginDesktop(
          this.getWizardTargetConfig(ownerProfile)
        );
        this.syncState();
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "wizardSyncClipboard": {
        const ds = this.wizard.getDesktopState();
        const ownerProfile =
          (ds.running && ds.profileId && this.profiles.getProfileById(ds.profileId)) ||
          this.getWizardTargetProfile();
        const text = await vscode.env.clipboard.readText();
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "clipboard",
          busy: true,
        });
        const res = await this.wizard.syncClipboardToRemote(
          this.getWizardTargetConfig(ownerProfile),
          text,
          "本机剪贴板"
        );
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "clipboard",
          busy: false,
        });
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "wizardPushDevspacePassword": {
        if (!this.cachedLocalStatus) {
          this.cachedLocalStatus = await this.wizard.inspectLocalStatus(getBridgeConfig());
        }
        const token = this.cachedLocalStatus?.ownerToken || "";
        if (!token) {
          void this.panel.webview.postMessage({
            type: "toast",
            ok: false,
            message: "尚未检测到本机 DevSpace 密码，请先完成第 1 步。",
          });
          break;
        }
        const ds = this.wizard.getDesktopState();
        const ownerProfile =
          (ds.running && ds.profileId && this.profiles.getProfileById(ds.profileId)) ||
          this.getWizardTargetProfile();
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "clipboard",
          busy: true,
        });
        const res = await this.wizard.syncClipboardToRemote(
          this.getWizardTargetConfig(ownerProfile),
          token,
          "DevSpace 密码"
        );
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "clipboard",
          busy: false,
        });
        void this.panel.webview.postMessage({ type: "toast", ok: res.ok, message: res.message });
        break;
      }

      case "wizardVerify": {
        const target = this.getWizardTargetProfile();
        const targetCfg = this.getWizardTargetConfig(target);
        const isActiveTarget = target.id === this.profiles.getActiveProfile().id;
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "verify",
          busy: true,
          profileId: target.id,
        });
        if (isActiveTarget) {
          if (this.bridge.getState().status !== "connected") {
            await this.bridge.connect(false);
          }
        } else {
          await this.bridge.ensureLocalDevspace(targetCfg);
        }
        const verify = await this.wizard.verifyRemoteReady(targetCfg, {
          forwardDevspace: !isActiveTarget,
        });
        void this.panel.webview.postMessage({
          type: "wizardBusy",
          step: "verify",
          busy: false,
          profileId: target.id,
        });
        void this.panel.webview.postMessage({
          type: "wizardVerifyResult",
          profileId: target.id,
          result: verify,
        });
        break;
      }

      case "wizardFinish": {
        const target = this.getWizardTargetProfile();
        const ds = this.wizard.getDesktopState();
        const ownerProfile =
          (ds.profileId && this.profiles.getProfileById(ds.profileId)) || target;
        await this.wizard.stopRemoteLoginDesktop(this.getWizardTargetConfig(ownerProfile));

        const switched = target.id !== this.profiles.getActiveProfile().id;
        if (switched) {
          await this.profiles.switchProfile(target.id);
          await this.bridge.connect(true);
        } else {
          await this.bridge.connect(false);
        }
        this.syncState();
        await vscode.commands.executeCommand("claudeBridge.openChat");
        break;
      }

      case "save": {
        const form = (msg.config as (Partial<BridgeConfig> & { profileName?: string }) | undefined) ?? {};
        const reconnect = Boolean(msg.reconnect);
        await this.saveConfig(form, reconnect);
        break;
      }

      case "createProfile": {
        const name = String(msg.name ?? "").trim();
        const created = await this.profiles.createProfile(name);
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: true,
          message: `已新建并切换到服务器档案「${created.name}」，可安全填写新 VPS 信息，不影响原主力机。`,
        });
        break;
      }

      case "selectProfile": {
        const pid = String(msg.profileId ?? "");
        const reconnect = Boolean(msg.reconnect);
        const switched = await this.profiles.switchProfile(pid);
        if (!switched) {
          return;
        }
        this.syncState();
        if (reconnect && switched.sshHost && switched.sshKeyPath) {
          const ok = await this.bridge.connect(true);
          void this.panel.webview.postMessage({
            type: "toast",
            ok,
            message: ok
              ? `已切换到「${switched.name}」并连接成功。`
              : `已切换到「${switched.name}」，但连接失败：${this.bridge.getState().detail}`,
          });
        } else {
          void this.panel.webview.postMessage({
            type: "toast",
            ok: true,
            message: `已切换到服务器档案「${switched.name}」。`,
          });
        }
        break;
      }

      case "deleteProfile": {
        const pid = String(msg.profileId ?? "");
        const res = await this.profiles.deleteProfile(pid);
        if (this.wizardTargetProfileId === pid) {
          this.wizardTargetProfileId = this.profiles.getActiveProfile().id;
        }
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
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

      case "setChatTheme": {
        const raw = String(msg.theme ?? "claude");
        const valid: ChatTheme[] = ["claude", "wechat", "feishu", "vscode"];
        const theme: ChatTheme = valid.includes(raw as ChatTheme)
          ? (raw as ChatTheme)
          : "claude";
        await updateChatTheme(theme);
        this.syncState();
        break;
      }

      case "refreshSkills":
        this.syncState();
        break;

      case "createSkill": {
        const name = String(msg.name ?? "");
        const desc = String(msg.description ?? "");
        const res = await this.skills.createSkillTemplate(name, desc);
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "openSkill": {
        const skillPath = String(msg.path ?? "");
        await this.skills.openSkillFile(skillPath);
        break;
      }

      case "deleteSkill": {
        const dirName = String(msg.dirName ?? "");
        const res = this.skills.deleteLocalSkill(dirName);
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "syncSkillsNow": {
        void this.panel.webview.postMessage({ type: "skillsBusy", busy: true });
        const res = await this.skills.syncToRemote(getBridgeConfig(), { force: true });
        void this.panel.webview.postMessage({ type: "skillsBusy", busy: false });
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "extractHabits": {
        void this.panel.webview.postMessage({ type: "habitsLoading", loading: true });
        const res = await this.skills.extractHabitsFromSessions(
          getBridgeConfig(),
          this.sessions.listSessions()
        );
        if (res.ok) {
          this.cachedHabits = res.items;
        }
        void this.panel.webview.postMessage({ type: "habitsLoading", loading: false });
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: res.ok,
          message: res.message,
        });
        break;
      }

      case "applyHabits": {
        const rules = Array.isArray(msg.rules)
          ? msg.rules.map((r) => String(r))
          : [];
        const cfg = getBridgeConfig();
        const writeRes = this.skills.appendRulesToLocalClaudeMd(cfg, rules);
        let finalMsg = writeRes.message;
        if (writeRes.ok && writeRes.added > 0 && this.bridge.getState().status === "connected") {
          const syncRes = await this.rulesSync.sync(cfg, { force: true });
          if (syncRes.ok) {
            finalMsg += " 并已自动同步到远程 VPS。";
          }
        }
        if (writeRes.ok) {
          this.cachedHabits = this.cachedHabits.filter(
            (h) => !rules.includes(h.rule)
          );
        }
        this.syncState();
        void this.panel.webview.postMessage({
          type: "toast",
          ok: writeRes.ok,
          message: finalMsg,
        });
        break;
      }
    }
  }

  private async saveConfig(
    raw: Partial<BridgeConfig> & { profileName?: string },
    reconnect: boolean
  ): Promise<void> {
    const engine = normalizeEngineType(raw.engine);
    const cliPath = resolveRemoteCliPath({
      engine,
      remoteClaudePath: String(raw.remoteClaudePath ?? "").trim(),
    });
    const patch: Partial<BridgeConfig> = {
      engine,
      sshHost: String(raw.sshHost ?? "").trim(),
      sshUser: String(raw.sshUser ?? "ubuntu").trim() || "ubuntu",
      sshPort: Number(raw.sshPort) || 22,
      sshKeyPath: String(raw.sshKeyPath ?? "").trim(),
      sshProxy: String(raw.sshProxy ?? "auto").trim() || "auto",
      localPort: Number(raw.localPort) || 7676,
      remotePort: Number(raw.remotePort) || 7676,
      devspacePath: String(raw.devspacePath ?? "").trim(),
      remoteClaudePath: cliPath,
      permissionMode: (raw.permissionMode ?? "bypassPermissions") as PermissionMode,
      model: String(raw.model ?? "").trim(),
      effort: (raw.effort ?? "") as EffortLevel,
      autoConnect: Boolean(raw.autoConnect),
      autoReconnect: Boolean(raw.autoReconnect),
      keepRunningOnClose: Boolean(raw.keepRunningOnClose),
      autoAttachWorkspaceContext: Boolean(raw.autoAttachWorkspaceContext),
      syncLocalRules: Boolean(raw.syncLocalRules),
      syncLocalSkills:
        raw.syncLocalSkills !== undefined ? Boolean(raw.syncLocalSkills) : true,
      localClaudeMdPaths: Array.isArray(raw.localClaudeMdPaths)
        ? raw.localClaudeMdPaths.map((s) => String(s).trim()).filter(Boolean)
        : ["~/.claude/CLAUDE.md"],
    };

    await updateBridgeConfigValues(patch);
    await this.profiles.saveProfile({
      name: raw.profileName,
      engine,
      sshHost: patch.sshHost,
      sshUser: patch.sshUser,
      sshPort: patch.sshPort,
      sshKeyPath: patch.sshKeyPath,
      sshProxy: patch.sshProxy,
      remotePort: patch.remotePort,
      remoteClaudePath: patch.remoteClaudePath,
      model: patch.model,
    });
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
    const engine = normalizeEngineType(form.engine ?? base.engine);
    const cliPath = resolveRemoteCliPath({
      engine,
      remoteClaudePath: String(form.remoteClaudePath ?? base.remoteClaudePath),
    });
    const cfg: BridgeConfig = {
      ...base,
      engine,
      sshHost: String(form.sshHost ?? base.sshHost).trim(),
      sshUser: String(form.sshUser ?? base.sshUser).trim() || "ubuntu",
      sshPort: Number(form.sshPort) || base.sshPort,
      sshKeyPath: expandHomePath(String(form.sshKeyPath ?? base.sshKeyPath)),
      sshProxy: String(form.sshProxy ?? base.sshProxy).trim() || "auto",
      remotePort: Number(form.remotePort) || base.remotePort,
      remoteClaudePath: cliPath,
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
      `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; echo "HOST=$(hostname)"; echo "CLI=$(${cliPath} --version 2>/dev/null | head -n 1 || echo NOT_FOUND)"; echo "MCP=$(curl -sS -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${cfg.remotePort}/mcp || echo 000)"`,
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
      summary: `连接成功（${elapsed}ms · ${proxy ? `代理 ${proxy.host}:${proxy.port}` : "直连"}） | 主机: ${map.HOST || cfg.sshHost} | ${getEngineDisplayName(engine)}: ${map.CLI || "未知"} | 隧道端口 ${cfg.remotePort}: ${mcpOk ? "已连通" : "尚未建立"}`,
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
  <title>DuDuNiao · 渡渡鸟 设置中心</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div class="page">
    <header class="page-head">
      <div class="head-brand">
        <div class="brand-logo">
          <svg width="22" height="17" viewBox="0 0 18 14" fill="currentColor" shape-rendering="crispEdges">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M2 1H16V4H18V7H16V9H15V13H13V9H12V13H10V9H8V13H6V9H5V13H3V9H2V7H0V4H2V1ZM5 4V6H7V4H5ZM11 4V6H13V4H11Z"/>
          </svg>
        </div>
        <div>
          <h1>DuDuNiao · 渡渡鸟</h1>
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

    <nav class="tab-bar">
      <button type="button" class="tab-btn active" data-tab="server">服务器与连接</button>
      <button type="button" class="tab-btn" data-tab="knowledge">规则、记忆与 Skill</button>
      <button type="button" class="tab-btn" data-tab="preferences">外观与对话习惯</button>
      <button type="button" class="tab-btn" data-tab="wizard">新机配置向导</button>
    </nav>

    <!-- Tab 1：服务器与连接 -->
    <div id="tab-server" class="tab-pane active">
    <section class="card" id="section-server">
      <div class="card-head">
        <div>
          <h2>远程服务器与隧道（支持多 VPS 切换）</h2>
          <p class="card-desc">可维护多台 VPS / 多个 Claude 账号，互不覆盖；本地 DevSpace 共用，点一下即可秒切服务器。</p>
        </div>
      </div>

      <div class="profile-bar-wrap">
        <div id="profileBar" class="profile-bar"></div>
      </div>

      <div class="grid-3">
        <div class="field span-2">
          <label for="profileName">当前服务器档案名称</label>
          <input id="profileName" type="text" placeholder="例如 AWS 主力 / 同事 Antigravity" />
        </div>
        <div class="field" style="justify-content: flex-end;">
          <button id="deleteProfileBtn" class="btn secondary small" type="button" style="height: 33px;">删除此档案</button>
        </div>
      </div>

      <div class="field">
        <label>远程 AI 后端引擎（支持 Claude Code / Antigravity 秒切，后续可扩展 Codex）</label>
        <div class="seg-group" id="engineModeGroup">
          <button type="button" class="seg-btn active" data-engine-mode="claude">Claude Code (claude)</button>
          <button type="button" class="seg-btn" data-engine-mode="antigravity">Google Antigravity (agy)</button>
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
            <label for="remoteClaudePath">远程 CLI 命令或路径（Claude 默认 claude，Antigravity 默认 agy）</label>
            <input id="remoteClaudePath" type="text" placeholder="claude 或 agy" />
          </div>
        </div>
        <div class="inline-actions" style="margin-top: 8px;">
          <button id="openLogBtn" class="btn secondary small" type="button">打开诊断日志 (bridge.log)</button>
          <button id="openRawSettingsBtn" class="btn secondary small" type="button">打开原始 VS Code 设置</button>
        </div>
      </div>
    </details>
    </div>

    <!-- Tab 2：规则、记忆与 Skill 知识库 -->
    <div id="tab-knowledge" class="tab-pane">
    <section class="card" id="section-memory">
      <div class="card-head">
        <div>
          <h2>个人规则 (CLAUDE.md)</h2>
          <p class="card-desc">管理本地 CLAUDE.md 编码与沟通习惯，连接 VPS 时仅在内容变化时无损合并到远程。</p>
        </div>
      </div>

      <div class="sub-block">
        <div class="toggle-row">
          <div>
            <div class="toggle-title">连接或切换服务器时自动同步本地 CLAUDE.md</div>
            <div class="toggle-desc">仅在本地文件内容变化时无损同步，绝不覆盖远程路由规则，也不在聊天中途触发</div>
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
            <button id="syncRulesNowBtn" class="btn primary small" type="button">立即同步规则到远程</button>
          </div>
        </div>
      </div>
    </section>

    <section class="card" id="section-skills">
      <div class="card-head">
        <div>
          <h2>我的 Skill 库（本机维护，自动同步多台 VPS）</h2>
          <p class="card-desc">以本机 <code>~/.claude/skills/</code> 为唯一主库；在聊天输入框敲 <code>/</code> 即可快捷调用，换新 VPS 自动带走不丢失。</p>
        </div>
      </div>

      <div class="toggle-row">
        <div>
          <div class="toggle-title">连接或切换 VPS 时自动增量同步本机 Skill</div>
          <div class="toggle-desc">按内容指纹比对，仅同步有变动的 Skill，绝不误删远程已有的其他 Skill</div>
        </div>
        <label class="switch-wrap">
          <input id="syncLocalSkills" type="checkbox" />
          <span class="slider"></span>
        </label>
      </div>

      <div class="inline-actions">
        <button id="syncSkillsNowBtn" class="btn primary small" type="button">立即同步 Skill 到当前 VPS</button>
        <button id="refreshSkillsBtn" class="btn secondary small" type="button">刷新列表</button>
      </div>

      <div id="skillsList" class="memories-list"></div>

      <details class="sub-expander" id="newSkillBox">
        <summary>+ 新建本地 Skill 模板</summary>
        <div class="sub-expander-body">
          <div class="grid-2">
            <div class="field">
              <label for="newSkillName">Skill 英文标识（小写字母/数字/连字符）</label>
              <input id="newSkillName" type="text" placeholder="例如 embedded-c-review" />
            </div>
            <div class="field">
              <label for="newSkillDesc">一句话用途与触发场景</label>
              <input id="newSkillDesc" type="text" placeholder="例如：评审嵌入式 C 模块接口与实现" />
            </div>
          </div>
          <div class="inline-actions">
            <button id="createSkillBtn" class="btn primary small" type="button">创建并打开编辑</button>
          </div>
        </div>
      </details>
    </section>

    <section class="card" id="section-habits">
      <div class="card-head">
        <div>
          <h2>习惯提炼与远程记忆</h2>
          <p class="card-desc">从你近期纠正 AI 的历史发言里提炼尚未沉淀的个人偏好，勾选确认后再写入本地 CLAUDE.md。</p>
        </div>
      </div>

      <div class="sub-block">
        <div class="memory-head">
          <div>
            <div class="toggle-title">从近期对话提炼我的新习惯</div>
            <div class="toggle-desc">只读取你发过的要求与纠正（不含代码日志），对照现有 CLAUDE.md 筛出新建议供你把关</div>
          </div>
          <button id="extractHabitsBtn" class="btn primary small" type="button">开始提炼新习惯</button>
        </div>
        <div id="habitsList" class="memories-list"></div>
        <div id="habitsApplyRow" class="inline-actions" style="display:none;">
          <button id="applyHabitsBtn" class="btn primary small" type="button">采纳勾选的习惯写入 CLAUDE.md</button>
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
    </div>

    <!-- Tab 3：外观与对话习惯 -->
    <div id="tab-preferences" class="tab-pane">
    <section class="card">
      <div class="card-head">
        <div>
          <h2>界面主题（含聊天页、Markdown 与设置中心）</h2>
          <p class="card-desc">点选立刻生效并同步保存，浅色 VS Code 下也会自动适配柔和浅色版本。</p>
        </div>
      </div>

      <div class="theme-cards-grid" id="settingsThemeGrid">
        <button type="button" class="theme-card-btn" data-settings-theme="claude">
          <span class="theme-card-dot" style="background:#d97757"></span>
          <div>
            <div class="theme-card-name">Claude 风格</div>
            <div class="theme-card-desc">暖炭黑画布 · 陶土暖橙气泡</div>
          </div>
        </button>
        <button type="button" class="theme-card-btn" data-settings-theme="wechat">
          <span class="theme-card-dot" style="background:#07c160"></span>
          <div>
            <div class="theme-card-name">微信风格</div>
            <div class="theme-card-desc">经典左灰右绿聊天双气泡</div>
          </div>
        </button>
        <button type="button" class="theme-card-btn" data-settings-theme="feishu">
          <span class="theme-card-dot" style="background:#3370ff"></span>
          <div>
            <div class="theme-card-name">飞书风格</div>
            <div class="theme-card-desc">飞书品牌蓝 · 云文档高亮块排版</div>
          </div>
        </button>
        <button type="button" class="theme-card-btn" data-settings-theme="vscode">
          <span class="theme-card-dot" style="background:#8e8e93"></span>
          <div>
            <div class="theme-card-name">跟随 VS Code</div>
            <div class="theme-card-desc">完全贴合当前编辑器原生配色</div>
          </div>
        </button>
      </div>
    </section>

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
    </div>

    <!-- Tab 2：新机配置向导（4 步图形化一键部署） -->
    <div id="tab-wizard" class="tab-pane">
      <!-- Step 1 -->
      <section class="card">
        <div class="step-head">
          <span class="step-num">1</span>
          <div>
            <h2>本机 DevSpace 一键准备</h2>
            <p class="card-desc">自动检查 Node、安装 DevSpace、授权本地代码目录、关闭本地 subagents 并设置 365 天免重输密码。</p>
          </div>
        </div>
        <div id="wizLocalChecklist" class="checklist"></div>
        <div class="field">
          <label for="wizProjectRoot">授权给 DevSpace 的本地项目根目录</label>
          <div class="input-with-btn">
            <input id="wizProjectRoot" type="text" placeholder="例如 /home/you/project 或 D:\projects" />
            <button id="wizPickRootBtn" class="btn secondary small" type="button">选择文件夹</button>
            <button id="wizSetupLocalBtn" class="btn primary small" type="button">一键安装并初始化</button>
          </div>
        </div>
        <div id="wizPasswordRow" class="password-box" style="display:none;">
          <span class="pw-label">DevSpace Owner Password：</span>
          <code id="wizOwnerPw" class="pw-val">••••••••</code>
          <button id="wizTogglePwBtn" class="btn secondary small" type="button">显示</button>
          <button id="wizCopyPwBtn" class="btn secondary small" type="button">复制密码</button>
        </div>
        <pre id="wizLocalLog" class="wizard-log"></pre>
      </section>

      <!-- Step 2 -->
      <section class="card">
        <div class="step-head">
          <span class="step-num">2</span>
          <div>
            <h2>新 VPS 免密配置与一键装机</h2>
            <p class="card-desc">点「+ 新增服务器档案」只在向导里配新机，不会切换你正在聊天的「主力服务器」，各服务器日志完全隔离。</p>
          </div>
        </div>

        <div class="profile-bar-wrap">
          <div id="wizProfileBar" class="profile-bar"></div>
        </div>

        <div id="wizTargetBanner" class="target-banner"></div>

        <div class="target-mini-form">
          <div class="grid-3">
            <div class="field">
              <label for="wizTargetName">目标档案名称</label>
              <input id="wizTargetName" type="text" placeholder="例如 同事A-Antigravity / 备用机" />
            </div>
            <div class="field">
              <label for="wizTargetEngine">远程 AI 后端引擎</label>
              <select id="wizTargetEngine">
                <option value="claude">Claude Code (claude)</option>
                <option value="antigravity">Google Antigravity (agy)</option>
              </select>
            </div>
            <div class="field">
              <label for="wizTargetRemotePort">远程隧道端口（同机多人请错开）</label>
              <div class="input-with-btn">
                <input id="wizTargetRemotePort" type="number" min="1024" max="65535" placeholder="7676" />
                <button id="wizSuggestPortBtn" class="btn secondary small" type="button" title="按当前 IP 自动建议不冲突端口">自动</button>
              </div>
            </div>
          </div>
          <div class="grid-3">
            <div class="field span-2">
              <label for="wizTargetHost">目标服务器地址 (IP / 域名)</label>
              <input id="wizTargetHost" type="text" placeholder="例如 1.2.3.4" />
            </div>
            <div class="field">
              <label for="wizTargetPort">SSH 端口</label>
              <input id="wizTargetPort" type="number" min="1" max="65535" placeholder="22" />
            </div>
          </div>
          <div class="grid-3">
            <div class="field">
              <label for="wizTargetUser">SSH 用户名（同机多人各自独立）</label>
              <input id="wizTargetUser" type="text" placeholder="ubuntu / claude / alice" />
            </div>
            <div class="field span-2">
              <label for="wizTargetKeyPath">目标本地私钥 (.pem / 无私钥请展开下方用密码一键生成)</label>
              <div class="input-with-btn">
                <input id="wizTargetKeyPath" type="text" placeholder="例如 ~/.ssh/claude-bridge_x.x.x.x" />
                <button id="wizPickKeyBtn" class="btn secondary small" type="button">选择私钥</button>
                <button id="wizSaveTargetBtn" class="btn secondary small" type="button">保存参数</button>
              </div>
            </div>
          </div>
        </div>

        <details class="sub-expander" id="passwordlessBox">
          <summary>没有 .pem 私钥？用密码一键生成免密私钥（支持 root 自动创建普通用户）</summary>
          <div class="sub-expander-body">
            <div class="grid-3">
              <div class="field span-2">
                <label for="pwHost">VPS 地址 (IP / 域名)</label>
                <input id="pwHost" type="text" placeholder="留空则沿用上方目标服务器地址" />
              </div>
              <div class="field">
                <label for="pwPort">SSH 端口</label>
                <input id="pwPort" type="number" min="1" max="65535" placeholder="22" />
              </div>
            </div>
            <div class="grid-3">
              <div class="field">
                <label for="pwUser">初始用户名</label>
                <input id="pwUser" type="text" value="root" placeholder="root 或 ubuntu" />
              </div>
              <div class="field span-2">
                <label for="pwPassword">一次性登录密码（仅用于此次上传公钥，绝不保存）</label>
                <input id="pwPassword" type="password" autocomplete="off" placeholder="输入 VPS 登录密码" />
              </div>
            </div>
            <div class="grid-2" id="pwNonRootRow">
              <div class="field" style="justify-content:center;">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                  <input id="pwCreateNonRoot" type="checkbox" checked />
                  <span>自动创建独立普通用户（同机 2~4 位同事请为每人建不同用户名）</span>
                </label>
              </div>
              <div class="field">
                <label for="pwNewUserName">新建普通用户名（如 claude / alice / bob）</label>
                <input id="pwNewUserName" type="text" value="claude" placeholder="claude 或同事英文名" />
              </div>
            </div>
            <div class="inline-actions">
              <button id="wizPasswordlessBtn" class="btn primary small" type="button">用密码一键配置免密登录</button>
            </div>
            <pre id="wizPasswordlessLog" class="wizard-log"></pre>
          </div>
        </details>

        <div class="grid-3">
          <div class="field">
            <label for="wizTimezone">VPS 地区时区</label>
            <select id="wizTimezone">
              <option value="America/New_York">美东 (America/New_York)</option>
              <option value="America/Los_Angeles">美西 (America/Los_Angeles)</option>
              <option value="Europe/London">欧洲 (Europe/London)</option>
              <option value="Asia/Tokyo">日本 (Asia/Tokyo)</option>
              <option value="Asia/Singapore">新加坡 (Asia/Singapore)</option>
            </select>
          </div>
          <div class="field">
            <label for="wizGeometry">临时桌面最大分辨率</label>
            <select id="wizGeometry">
              <option value="1366x768">1366 × 768（推荐上限）</option>
              <option value="1280x720">1280 × 720（更省带宽）</option>
            </select>
          </div>
          <div class="field" style="justify-content: flex-end;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;">
              <input id="wizWithDesktop" type="checkbox" checked />
              <span>安装极简 noVNC 登录桌面</span>
            </label>
          </div>
        </div>
        <div class="inline-actions">
          <button id="wizSetupVpsBtn" class="btn primary" type="button">一键初始化远程 VPS</button>
          <span id="wizStep2Target" class="target-inline-tag"></span>
        </div>
        <pre id="wizVpsLog" class="wizard-log"></pre>
      </section>

      <!-- Step 3 -->
      <section class="card">
        <div class="step-head">
          <span class="step-num">3</span>
          <div>
            <h2>免客户端打开远程登录画面（一次性授权）</h2>
            <p class="card-desc" id="wizStep3Desc">无需安装 RustDesk！在远程终端输入 <code>claude</code> 登录账号，再输入 <code>/mcp</code> 授权 DevSpace。需要粘贴时点下方「同步本机剪贴板到远程」，浏览器按 <code>Ctrl+V</code>、终端按 <code>Ctrl+Shift+V</code> 即可。</p>
          </div>
        </div>
        <div id="wizDesktopStatus" class="field-hint">当前状态：未启动（平时 0 内存占用）</div>
        <div class="inline-actions">
          <button id="wizStartDesktopBtn" class="btn primary" type="button">打开远程登录画面（网页直连）</button>
          <button id="wizReopenDesktopBtn" class="btn secondary small" type="button" style="display:none;">重新打开浏览器</button>
          <button id="wizStopDesktopBtn" class="btn secondary small" type="button" style="display:none;">关闭临时桌面释放内存</button>
        </div>
        <div class="clipboard-bar">
          <span class="clip-hint">远程粘贴助手（按需点一次同步，不在后台监听）：</span>
          <button id="wizSyncClipboardBtn" class="btn secondary small" type="button">同步本机剪贴板到远程</button>
          <button id="wizSendPwToRemoteBtn" class="btn secondary small" type="button">一键发 DevSpace 密码到远程</button>
          <button id="wizCopyPwBtn2" class="btn secondary small" type="button">复制 DevSpace 密码</button>
        </div>
      </section>

      <!-- Step 4 -->
      <section class="card">
        <div class="step-head">
          <span class="step-num">4</span>
          <div>
            <h2>一键验收并切换到此服务器</h2>
            <p class="card-desc" id="wizStep4Desc">检查当前目标 VPS 的 CLI 登录与 DevSpace MCP 是否全部绿灯；验收通过后再关闭临时桌面并切换到此服务器对话。</p>
          </div>
        </div>
        <div id="wizVerifyChecklist" class="checklist"></div>
        <div id="wizVerifySummary" class="field-hint"></div>
        <div class="inline-actions">
          <button id="wizVerifyBtn" class="btn secondary" type="button">一键检测授权状态</button>
          <button id="wizFinishBtn" class="btn primary" type="button">关闭临时桌面并开始对话</button>
        </div>
      </section>
    </div>
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
