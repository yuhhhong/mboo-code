import { randomUUID } from "node:crypto";

/**
 * 每轮桌面启动均使用新的不可预测标识，防止健康检查误认残留服务为当前 sidecar。
 */
export function createInstanceId(): string {
  return randomUUID();
}
