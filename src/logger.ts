import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

const LOG_DIR = path.join(os.homedir(), ".claude-bridge");
const LOG_FILE = path.join(LOG_DIR, "bridge.log");
const MAX_LOG_BYTES = 1024 * 1024; // 1MB 自动滚动，避免长期占用磁盘

/**
 * 统一诊断日志器：同时写入 VS Code 输出面板与本地持久化日志文件，
 * 方便排查断联究竟是网络/代理抖动、EC2 端口占用还是本地服务异常。
 */
export class BridgeLogger implements vscode.Disposable {
  constructor(private readonly channel: vscode.OutputChannel) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    } catch {
      // 目录创建失败时降级为仅输出面板
    }
  }

  public getLogFilePath(): string {
    return LOG_FILE;
  }

  public info(scope: string, message: string): void {
    this.write("INFO", scope, message);
  }

  public warn(scope: string, message: string): void {
    this.write("WARN", scope, message);
  }

  public error(scope: string, message: string): void {
    this.write("ERROR", scope, message);
  }

  public appendLine(rawLine: string): void {
    this.write("INFO", "App", rawLine);
  }

  public showChannel(): void {
    this.channel.show(true);
  }

  /** 在 VS Code 编辑器中直接打开持久化诊断日志文件并跳到最新行 */
  public async openLogFile(): Promise<void> {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      if (!fs.existsSync(LOG_FILE)) {
        fs.writeFileSync(LOG_FILE, "", "utf8");
      }
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(LOG_FILE)
      );
      const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
      });
      const lastLine = Math.max(0, doc.lineCount - 1);
      const pos = new vscode.Position(lastLine, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.Default
      );
    } catch (err) {
      this.channel.show(true);
      vscode.window.showWarningMessage(`无法打开日志文件：${String(err)}`);
    }
  }

  private write(level: string, scope: string, message: string): void {
    const now = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const ts =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    const line = `[${ts}] [${level}] [${scope}] ${message}`;

    this.channel.appendLine(line);

    try {
      if (fs.existsSync(LOG_FILE)) {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size >= MAX_LOG_BYTES) {
          const backup = `${LOG_FILE}.1`;
          if (fs.existsSync(backup)) {
            fs.unlinkSync(backup);
          }
          fs.renameSync(LOG_FILE, backup);
        }
      }
      fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
    } catch {
      // 文件写入异常不影响主流程
    }
  }

  public dispose(): void {
    this.channel.dispose();
  }
}
