import * as vscode from "vscode";
import {
  BridgeConfig,
  buildBaseSshArgs,
  getActiveWorkspacePath,
  shellQuote,
} from "./config";

/**
 * 原生远程终端管理器（方案 A 完整交互能力 + 复杂命令兜底）
 * 通过 SSH 在 EC2 上直接打开交互式 Claude Code 终端，不透传本地语言环境。
 */
export class TerminalManager {
  private terminal: vscode.Terminal | undefined;

  constructor(private readonly output: vscode.OutputChannel) {
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === this.terminal) {
        this.terminal = undefined;
      }
    });
  }

  public openRemoteClaudeTerminal(cfg: BridgeConfig): void {
    if (this.terminal) {
      this.terminal.show();
      return;
    }

    const claudeArgs: string[] = [
      shellQuote(cfg.remoteClaudePath || "claude"),
      "--permission-mode",
      shellQuote(cfg.permissionMode),
    ];

    if (cfg.model) {
      claudeArgs.push("--model", shellQuote(cfg.model));
    }

    if (cfg.effort) {
      claudeArgs.push("--effort", shellQuote(cfg.effort));
    }

    const activeWorkspace = getActiveWorkspacePath();
    if (activeWorkspace) {
      const hint = `Current active VS Code workspace on local machine: ${activeWorkspace}. Always use devspace MCP tools to inspect or edit files inside this workspace.`;
      claudeArgs.push("--append-system-prompt", shellQuote(hint));
    }

    const remoteCmd = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; exec ${claudeArgs.join(" ")}`;
    const sshArgs = [
      ...buildBaseSshArgs(cfg, { batchMode: false }),
      "-t",
      `${cfg.sshUser}@${cfg.sshHost}`,
      remoteCmd,
    ];

    this.output.appendLine(
      `[Terminal] 启动原生远程终端: ssh ${cfg.sshUser}@${cfg.sshHost} (mode=${cfg.permissionMode})`
    );

    this.terminal = vscode.window.createTerminal({
      name: "EC2 Claude",
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
