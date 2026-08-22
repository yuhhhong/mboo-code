import type { DesktopStartupContext, ManagedProcess, StartupPhase } from "./startup-coordinator.js";

interface HealthResponse {
  status?: unknown;
  instanceId?: unknown;
}

/**
 * 轮询健康接口直到本轮剩余时间耗尽；端口可访问不足以确认归属，必须同时验证 instanceId。
 */
export async function waitForServiceHealth(options: {
  phase: StartupPhase;
  url: string;
  context: DesktopStartupContext;
  process: ManagedProcess & { hasExited?: () => boolean };
  fetcher?: typeof fetch;
}): Promise<void> {
  let lastFailure = "健康检查尚未就绪";

  while (Date.now() < options.context.deadline) {
    if (options.process.hasExited?.()) {
      throw new Error(`${options.phase} 服务在健康检查完成前退出`);
    }
    try {
      const response = await (options.fetcher ?? fetch)(options.url, { cache: "no-store" });
      if (!response.ok) {
        lastFailure = `${options.phase} 健康检查返回 HTTP ${response.status}`;
      } else {
        const body = await response.json() as HealthResponse & { data?: HealthResponse };
        const health: HealthResponse = body.data ?? body;
        if (health.status !== "UP") {
          lastFailure = `${options.phase} 健康检查状态不是 UP`;
        } else if (health.instanceId !== options.context.instanceId) {
          throw new Error(`${options.phase} 健康检查实例标识不匹配：期望 ${options.context.instanceId}，实际 ${String(health.instanceId)}`);
        } else {
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("实例标识不匹配")) throw error;
      lastFailure = error instanceof Error ? error.message : "健康检查请求失败";
    }
    await delay(Math.min(250, Math.max(0, options.context.deadline - Date.now())));
  }

  throw new Error(`${options.phase} 服务健康检查超时：${lastFailure}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
