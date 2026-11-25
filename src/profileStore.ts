import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  AgentEngineType,
  BridgeConfig,
  expandHomePath,
  getBridgeConfig,
  getDefaultCliBinary,
  normalizeEngineType,
  resolveRemoteCliPath,
  updateBridgeConfigValues,
} from "./config";

/** 将指定服务器档案覆盖到基础配置上，用于向导独立操作非活跃服务器 */
export function profileToBridgeConfig(
  base: BridgeConfig,
  profile: ServerProfile
): BridgeConfig {
  const engine = normalizeEngineType(profile.engine);
  return {
    ...base,
    engine,
    sshHost: profile.sshHost.trim(),
    sshUser: profile.sshUser.trim() || "ubuntu",
    sshPort: Number(profile.sshPort) || 22,
    sshKeyPath: expandHomePath(profile.sshKeyPath.trim()),
    sshProxy: profile.sshProxy.trim() || "auto",
    remotePort: Number(profile.remotePort) || 7676,
    remoteClaudePath: resolveRemoteCliPath({
      engine,
      remoteClaudePath: profile.remoteClaudePath,
    }),
    model: profile.model !== undefined ? profile.model : base.model,
  };
}

/** 单个远程 VPS 服务器配置档案 */
export interface ServerProfile {
  id: string;
  name: string;
  /** 远程 CLI 后端引擎：claude | antigravity（旧档案缺省视为 claude） */
  engine: AgentEngineType;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string;
  sshProxy: string;
  remotePort: number;
  remoteClaudePath: string;
  /** 该档案偏好的模型名（切换 Claude/Antigravity 服务器时自动隔离，互不串模型） */
  model?: string;
}

interface ProfilesFileData {
  version: number;
  activeProfileId: string;
  profiles: ServerProfile[];
}

const DATA_DIR = path.join(os.homedir(), ".claude-bridge");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

/**
 * 多 VPS 服务器档案管理器（持久化存储在 ~/.claude-bridge/profiles.json）
 * - 支持维护多台 VPS（不同账号/不同地区/同事测试机），一键切换不互踩；
 * - 切换时同步写入 claudeBridge.* 配置，所有底层模块零侵入自动生效。
 */
export class ProfileStore {
  private profiles: ServerProfile[] = [];
  private activeProfileId = "default";

  private readonly changeEmitter = new vscode.EventEmitter<ServerProfile>();
  public readonly onDidChangeActiveProfile = this.changeEmitter.event;

  constructor() {
    this.loadOrBootstrap();
  }

  public listProfiles(): ServerProfile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  public getActiveProfile(): ServerProfile {
    const found = this.profiles.find((p) => p.id === this.activeProfileId);
    if (found) {
      return { ...found };
    }
    return { ...this.profiles[0] };
  }

  public getProfileById(id: string): ServerProfile | undefined {
    const found = this.profiles.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  /** 为同机多用户自动建议不冲突的远程隧道端口（7676, 7677, 7678...） */
  public suggestNextRemotePort(sshHost: string, excludeProfileId?: string): number {
    const cleanHost = sshHost.trim().toLowerCase();
    const usedPorts = new Set<number>();
    for (const p of this.profiles) {
      if (excludeProfileId && p.id === excludeProfileId) {
        continue;
      }
      if (!cleanHost || p.sshHost.trim().toLowerCase() === cleanHost) {
        usedPorts.add(Number(p.remotePort) || 7676);
      }
    }
    let port = 7676;
    while (usedPorts.has(port) && port < 7776) {
      port += 1;
    }
    return port;
  }

  /** 新增一个空白服务器档案（默认激活；向导新建时可传 makeActive: false 避免影响聊天主力机） */
  public async createProfile(
    name?: string,
    options?: { makeActive?: boolean; engine?: AgentEngineType; sshHost?: string }
  ): Promise<ServerProfile> {
    const makeActive = options?.makeActive ?? true;
    const engine = normalizeEngineType(options?.engine);
    const idx = this.profiles.length + 1;
    const suggestedPort = options?.sshHost
      ? this.suggestNextRemotePort(options.sshHost)
      : 7676;
    const profile: ServerProfile = {
      id: `vps_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: (name || "").trim() || `VPS 服务器 ${idx}`,
      engine,
      sshHost: (options?.sshHost || "").trim(),
      sshUser: "ubuntu",
      sshPort: 22,
      sshKeyPath: "",
      sshProxy: "auto",
      remotePort: suggestedPort,
      remoteClaudePath: getDefaultCliBinary(engine),
      model: "",
    };
    this.profiles.push(profile);
    if (makeActive) {
      this.activeProfileId = profile.id;
    }
    this.persist();
    if (makeActive) {
      await this.applyToVsCodeConfig(profile);
      this.changeEmitter.fire(this.getActiveProfile());
    }
    return { ...profile };
  }

  /** 保存/更新指定档案（若当前就是活跃档案则同步写入 VS Code 配置） */
  public async saveProfile(
    patch: Partial<ServerProfile> & { id?: string },
    makeActive = false
  ): Promise<ServerProfile> {
    const targetId = patch.id || this.activeProfileId;
    let existing = this.profiles.find((p) => p.id === targetId);
    if (!existing) {
      existing = this.profiles[0];
    }

    const nextEngine =
      patch.engine !== undefined
        ? normalizeEngineType(patch.engine)
        : normalizeEngineType(existing.engine);
    const engineChanged = nextEngine !== normalizeEngineType(existing.engine);
    const rawCliPath =
      patch.remoteClaudePath !== undefined
        ? patch.remoteClaudePath.trim()
        : existing.remoteClaudePath;
    const nextCliPath = resolveRemoteCliPath({
      engine: nextEngine,
      remoteClaudePath: rawCliPath,
    });

    const updated: ServerProfile = {
      id: existing.id,
      name:
        patch.name !== undefined
          ? patch.name.trim() || existing.name
          : existing.name,
      engine: nextEngine,
      sshHost:
        patch.sshHost !== undefined ? patch.sshHost.trim() : existing.sshHost,
      sshUser:
        patch.sshUser !== undefined
          ? patch.sshUser.trim() || "ubuntu"
          : existing.sshUser,
      sshPort:
        patch.sshPort !== undefined
          ? Number(patch.sshPort) || 22
          : existing.sshPort,
      sshKeyPath:
        patch.sshKeyPath !== undefined
          ? patch.sshKeyPath.trim()
          : existing.sshKeyPath,
      sshProxy:
        patch.sshProxy !== undefined
          ? patch.sshProxy.trim() || "auto"
          : existing.sshProxy,
      remotePort:
        patch.remotePort !== undefined
          ? Number(patch.remotePort) || 7676
          : existing.remotePort,
      remoteClaudePath: nextCliPath,
      model:
        patch.model !== undefined
          ? patch.model.trim()
          : engineChanged
            ? ""
            : existing.model,
    };

    const idx = this.profiles.findIndex((p) => p.id === existing!.id);
    this.profiles[idx] = updated;

    const switched = makeActive && this.activeProfileId !== updated.id;
    if (makeActive) {
      this.activeProfileId = updated.id;
    }
    this.persist();

    if (this.activeProfileId === updated.id) {
      await this.applyToVsCodeConfig(updated);
    }
    if (switched) {
      this.changeEmitter.fire(this.getActiveProfile());
    }
    return { ...updated };
  }

  /** 切换当前活跃的 VPS 档案 */
  public async switchProfile(profileId: string): Promise<ServerProfile | undefined> {
    const target = this.profiles.find((p) => p.id === profileId);
    if (!target) {
      return undefined;
    }
    const changed = this.activeProfileId !== target.id;
    this.activeProfileId = target.id;
    this.persist();
    await this.applyToVsCodeConfig(target);
    if (changed) {
      this.changeEmitter.fire(this.getActiveProfile());
    }
    return { ...target };
  }

  /** 删除指定档案（至少保留 1 个） */
  public async deleteProfile(
    profileId: string
  ): Promise<{ ok: boolean; active: ServerProfile; message: string }> {
    if (this.profiles.length <= 1) {
      return {
        ok: false,
        active: this.getActiveProfile(),
        message: "至少需要保留 1 个服务器档案。",
      };
    }
    const removed = this.profiles.find((p) => p.id === profileId);
    if (!removed) {
      return {
        ok: false,
        active: this.getActiveProfile(),
        message: "未找到要删除的服务器档案。",
      };
    }

    this.profiles = this.profiles.filter((p) => p.id !== profileId);
    const wasActive = this.activeProfileId === profileId;
    if (wasActive) {
      this.activeProfileId = this.profiles[0].id;
    }
    this.persist();

    const active = this.getActiveProfile();
    if (wasActive) {
      await this.applyToVsCodeConfig(active);
      this.changeEmitter.fire(active);
    }
    return {
      ok: true,
      active,
      message: `已删除服务器档案「${removed.name}」。`,
    };
  }

  private loadOrBootstrap(): void {
    try {
      if (fs.existsSync(PROFILES_FILE)) {
        const raw = fs.readFileSync(PROFILES_FILE, "utf8");
        const parsed = JSON.parse(raw) as ProfilesFileData;
        if (parsed && Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
          this.profiles = parsed.profiles.map((p) => {
            const eng = normalizeEngineType(p.engine);
            return {
              ...p,
              engine: eng,
              remoteClaudePath: resolveRemoteCliPath({
                engine: eng,
                remoteClaudePath: p.remoteClaudePath,
              }),
            };
          });
          this.activeProfileId = parsed.activeProfileId || this.profiles[0].id;
          if (!this.profiles.some((p) => p.id === this.activeProfileId)) {
            this.activeProfileId = this.profiles[0].id;
          }
          return;
        }
      }
    } catch {
      // 文件损坏时回退从当前 VS Code 设置引导
    }

    const cfg: BridgeConfig = getBridgeConfig();
    const initialEngine = normalizeEngineType(cfg.engine);
    const initial: ServerProfile = {
      id: "default",
      name: cfg.sshHost ? "主力服务器" : "默认服务器",
      engine: initialEngine,
      sshHost: cfg.sshHost,
      sshUser: cfg.sshUser || "ubuntu",
      sshPort: cfg.sshPort || 22,
      sshKeyPath: cfg.sshKeyPath,
      sshProxy: cfg.sshProxy || "auto",
      remotePort: cfg.remotePort || 7676,
      remoteClaudePath: resolveRemoteCliPath(cfg),
      model: cfg.model || "",
    };
    this.profiles = [initial];
    this.activeProfileId = initial.id;
    this.persist();
  }

  private async applyToVsCodeConfig(profile: ServerProfile): Promise<void> {
    const engine = normalizeEngineType(profile.engine);
    await updateBridgeConfigValues({
      engine,
      sshHost: profile.sshHost,
      sshUser: profile.sshUser,
      sshPort: profile.sshPort,
      sshKeyPath: profile.sshKeyPath,
      sshProxy: profile.sshProxy,
      remotePort: profile.remotePort,
      remoteClaudePath: resolveRemoteCliPath({
        engine,
        remoteClaudePath: profile.remoteClaudePath,
      }),
      model: profile.model !== undefined ? profile.model : "",
    });
  }

  private persist(): void {
    const payload: ProfilesFileData = {
      version: 1,
      activeProfileId: this.activeProfileId,
      profiles: this.profiles,
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${PROFILES_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      fs.renameSync(tmp, PROFILES_FILE);
    } catch {
      // 忽略写入异常
    }
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }
}
