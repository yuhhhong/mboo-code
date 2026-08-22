import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface StartupPhaseRecord {
  phase: string;
  attempt: number;
  javaPort: number;
  nextPort: number;
  message: string;
}

export interface DesktopStartupDiagnostics {
  phase: string;
  message: string;
  logPath: string;
  attempt?: number;
  ports?: { javaPort: number; nextPort: number };
  runtime: { electronVersion: string; nodeVersion: string; javaRuntime: string };
  copyText: string;
}

/**
 * 将失败定位所需的最小信息集中写入单一日志与可复制摘要，避免页面通过循环重试掩盖子进程故障。
 */
export class DesktopDiagnosticsCollector {
  private readonly lines: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private latestPhase: StartupPhaseRecord | undefined;

  private constructor(private readonly logPath: string) {
  }

  static async create(logPath: string): Promise<DesktopDiagnosticsCollector> {
    await mkdir(path.dirname(logPath), { recursive: true });
    return new DesktopDiagnosticsCollector(logPath);
  }

  recordPhase(record: StartupPhaseRecord): void {
    this.latestPhase = record;
    this.recordLine(`phase=${record.phase} attempt=${record.attempt} javaPort=${record.javaPort} nextPort=${record.nextPort} message=${record.message}`);
  }

  recordOutput(service: string, stream: "stdout" | "stderr", message: string): void {
    this.recordLine(`${service} ${stream}: ${message}`);
  }

  recordExit(service: string, exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.recordLine(`${service} exited code=${String(exitCode)} signal=${String(signal)}`);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  snapshot(input: { phase: string; message: string; electronVersion: string; nodeVersion: string; javaRuntime: string }): DesktopStartupDiagnostics {
    const ports = this.latestPhase ? { javaPort: this.latestPhase.javaPort, nextPort: this.latestPhase.nextPort } : undefined;
    const attempt = this.latestPhase?.attempt;
    const copyText = [
      `阶段: ${input.phase}`,
      `信息: ${input.message}`,
      `尝试次数: ${attempt ?? "未知"}`,
      `端口: ${ports ? `Java ${ports.javaPort}, Next.js ${ports.nextPort}` : "未知"}`,
      `运行时: Electron ${input.electronVersion}, Node.js ${input.nodeVersion}, Java ${input.javaRuntime}`,
      `日志: ${this.logPath}`,
      ...this.lines.slice(-20),
    ].join("\n");
    return {
      phase: input.phase,
      message: input.message,
      logPath: this.logPath,
      attempt,
      ports,
      runtime: {
        electronVersion: input.electronVersion,
        nodeVersion: input.nodeVersion,
        javaRuntime: input.javaRuntime,
      },
      copyText,
    };
  }

  private recordLine(value: string): void {
    const line = `${new Date().toISOString()} ${redact(value)}`;
    this.lines.push(line);
    this.writeChain = this.writeChain.then(() => appendFile(this.logPath, `${line}\n`, "utf8")).catch(() => undefined);
  }
}

function redact(value: string): string {
  return value
    .replace(/(authorization)\s*:\s*bearer\s+[^\s]+/gi, "$1: Bearer [REDACTED]")
    .replace(/(api[_-]?key|authorization|token)\s*[:=]\s*[^\s]+/gi, "$1=[REDACTED]");
}
