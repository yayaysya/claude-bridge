import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getActiveWorkspacePath,
  getEngineDisplayName,
  normalizeEngineType,
  resolveRemoteCliPath,
  shellQuote,
} from "./config";

/**
 * 原生远程终端管理器（完整交互能力 + 复杂命令兜底）
 * 根据当前服务器引擎通过 SSH 打开远程交互式 Claude Code 或 Antigravity (agy) 终端。
 */
export class TerminalManager {
  private terminal: vscode.Terminal | undefined;
  private lastTerminalKey = "";

  constructor(private readonly output: { appendLine(value: string): void }) {
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.terminal = undefined;
        this.lastTerminalKey = "";
      }
    });
  }

  public openRemoteClaudeTerminal(cfg: BridgeConfig): void {
    const engine = normalizeEngineType(cfg.engine);
    const key = `${engine}:${cfg.sshUser}@${cfg.sshHost}:${cfg.sshPort}`;
    if (this.terminal && this.lastTerminalKey === key) {
      this.terminal.show();
      return;
    }
    if (this.terminal && this.lastTerminalKey !== key) {
      this.terminal.dispose();
      this.terminal = undefined;
    }

    const cliBin = shellQuote(resolveRemoteCliPath(cfg));
    const cliArgs: string[] = [cliBin];

    if (engine === "antigravity") {
      if (cfg.permissionMode === "plan") {
        cliArgs.push("--mode", "plan");
      } else if (cfg.permissionMode === "acceptEdits") {
        cliArgs.push("--mode", "accept-edits");
      } else if (cfg.permissionMode === "bypassPermissions") {
        cliArgs.push("--dangerously-skip-permissions");
      }
      if (cfg.model && !/^claude-(fable|haiku)/i.test(cfg.model)) {
        cliArgs.push("--model", shellQuote(cfg.model));
      }
      if (cfg.effort) {
        cliArgs.push("--effort", shellQuote(cfg.effort));
      }
    } else {
      cliArgs.push("--permission-mode", shellQuote(cfg.permissionMode));
      if (cfg.model) {
        cliArgs.push("--model", shellQuote(cfg.model));
      }
      if (cfg.effort) {
        cliArgs.push("--effort", shellQuote(cfg.effort));
      }
      const activeWorkspace = getActiveWorkspacePath();
      if (activeWorkspace) {
        const hint = `Current active VS Code workspace on local machine: ${activeWorkspace}. Always use devspace MCP tools to inspect or edit files inside this workspace.`;
        cliArgs.push("--append-system-prompt", shellQuote(hint));
      }
    }

    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${cliArgs.join(" ")}`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: false }),
      "-t",
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine(
      `[Terminal] 启动原生远程终端 (${getEngineDisplayName(engine)}): ssh ${cfg.sshUser}@${cfg.sshHost} (mode=${cfg.permissionMode})`
    );

    this.lastTerminalKey = key;
    this.terminal = vscode.window.createTerminal({
      name: engine === "antigravity" ? "ClaudeBridge · AGY" : "ClaudeBridge · Claude",
      shellPath: "ssh",
      shellArgs: sshArgs,
    });
    this.terminal.show();
  }

  public dispose(): void {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = undefined;
    }
  }
}
