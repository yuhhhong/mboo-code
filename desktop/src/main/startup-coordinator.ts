import type { LoopbackPorts } from "./port-allocation.js";

export type StartupPhase = "java" | "next";

export interface DesktopStartupContext {
  attempt: number;
  instanceId: string;
  ports: LoopbackPorts;
  deadline: number;
}

export interface ManagedProcess {
  name: string;
  stop(): Promise<void>;
}

export interface DesktopServiceRuntime extends DesktopStartupContext {
  javaProcess: ManagedProcess;
  nextProcess: ManagedProcess;
}

export interface DesktopStartupDependencies {
  allocatePorts(): Promise<LoopbackPorts>;
  createInstanceId(): string;
  launchJava(context: DesktopStartupContext): Promise<ManagedProcess>;
  launchNext(context: DesktopStartupContext): Promise<ManagedProcess>;
  waitForHealth(options: { phase: StartupPhase; context: DesktopStartupContext; process: ManagedProcess }): Promise<void>;
  onPhase?(context: DesktopStartupContext, phase: string, message: string): void;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
}

export class StartupError extends Error {
}

/**
 * 按固定顺序托管 Java 与 Next 服务；失败时整轮回收并换用新端口，避免保留残留进程或误连旧实例。
 */
export class DesktopStartupCoordinator {
  private readonly maxAttempts: number;
  private readonly attemptTimeoutMs: number;

  constructor(private readonly dependencies: DesktopStartupDependencies) {
    this.maxAttempts = dependencies.maxAttempts ?? 3;
    this.attemptTimeoutMs = dependencies.attemptTimeoutMs ?? 30_000;
  }

  async start(): Promise<DesktopServiceRuntime> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const ports = await this.dependencies.allocatePorts();
      const context: DesktopStartupContext = {
        attempt,
        instanceId: this.dependencies.createInstanceId(),
        ports,
        deadline: Date.now() + this.attemptTimeoutMs,
      };
      let javaProcess: ManagedProcess | undefined;
      let nextProcess: ManagedProcess | undefined;

      try {
        this.reportPhase(context, "java-launch", "启动 Java sidecar");
        javaProcess = await this.dependencies.launchJava(context);
        this.reportPhase(context, "java-health", "等待 Java 健康检查");
        await this.dependencies.waitForHealth({ phase: "java", context, process: javaProcess });
        this.reportPhase(context, "next-launch", "启动 Next.js standalone 服务");
        nextProcess = await this.dependencies.launchNext(context);
        this.reportPhase(context, "next-health", "等待 Next.js 健康检查");
        await this.dependencies.waitForHealth({ phase: "next", context, process: nextProcess });
        this.reportPhase(context, "ready", "桌面服务健康检查通过");
        return { ...context, javaProcess, nextProcess };
      } catch (error) {
        lastError = error;
        this.reportPhase(context, "attempt-failed", error instanceof Error ? error.message : "启动失败");
        await this.stopAttempt(nextProcess, javaProcess);
      }
    }

    const message = lastError instanceof Error ? lastError.message : "未知错误";
    throw new StartupError(`桌面服务启动失败，已重试 ${this.maxAttempts} 次：${message}`);
  }

  private reportPhase(context: DesktopStartupContext, phase: string, message: string): void {
    this.dependencies.onPhase?.(context, phase, message);
  }

  private async stopAttempt(...processes: Array<ManagedProcess | undefined>): Promise<void> {
    for (const process of processes) {
      if (!process) continue;
      try {
        await process.stop();
      } catch {
        // 清理失败不应阻塞下一轮新端口尝试；最终诊断由调用方汇总。
      }
    }
  }
}
