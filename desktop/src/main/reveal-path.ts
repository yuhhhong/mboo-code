import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type { RevealTarget } from "../shared/contracts.js";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESULT_ID_PATTERN = /^tr_[0-9a-f]{64}$/;

/**
 * 将无参数的显示路径入口限制为已确认目标，避免渲染进程把它组合为任意本机路径浏览能力。
 */
export function resolveRevealDirectory(
  target: RevealTarget,
  appDataDirectory: string,
  confirmedWorkspaceDirectory: string | undefined,
): string | undefined {
  if (target === "appData") return appDataDirectory;
  if (target === "workspace") return confirmedWorkspaceDirectory;
  return undefined;
}

/**
 * 结果文件由会话 ID 和结果 ID 定位并校验在应用数据目录内，避免接收来自页面的任意文件路径。
 */
export async function resolveToolResultFile(appDataDirectory: string, sessionId: string, resultId: string): Promise<string | undefined> {
  if (!SESSION_ID_PATTERN.test(sessionId) || !RESULT_ID_PATTERN.test(resultId)) {
    return undefined;
  }
  const resultDirectory = path.resolve(appDataDirectory, "sessions", sessionId, "tool-results");
  if (!isWithinDirectory(appDataDirectory, resultDirectory)) return undefined;
  for (const suffix of [".json", ".output", ".output.partial"]) {
    const candidate = path.resolve(resultDirectory, `${resultId}${suffix}`);
    if (!isWithinDirectory(resultDirectory, candidate)) continue;
    try {
      await access(candidate, constants.F_OK);
      return candidate;
    } catch {
      // 尝试下一种由 Java 工具结果存储使用的后缀。
    }
  }
  return undefined;
}

function isWithinDirectory(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
