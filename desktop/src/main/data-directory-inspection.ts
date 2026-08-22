import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type BusinessDataType = "sqlite" | "settings" | "sessions" | "toolResults";

export interface BusinessDataInspection {
  directory: string;
  hasBusinessData: boolean;
  types: BusinessDataType[];
}

/**
 * 只将可迁移的业务制品视为已有数据，避免桌面启动日志等壳层文件错误跳过历史导入提示。
 */
export async function inspectBusinessDataDirectory(directory: string): Promise<BusinessDataInspection> {
  const types: BusinessDataType[] = [];
  if (await isRegularFile(path.join(directory, "mboo_data.sqlite"))) types.push("sqlite");
  if (await isRegularFile(path.join(directory, "setting.json"))) types.push("settings");

  const sessionData = await inspectSessionData(path.join(directory, "sessions"));
  if (sessionData.hasSessions) types.push("sessions");
  if (sessionData.hasToolResults) types.push("toolResults");

  return { directory, hasBusinessData: types.length > 0, types };
}

/**
 * 仅当新桌面目录没有业务数据且旧目录存在支持的制品时，才应向用户提供一次导入选择。
 */
export async function shouldOfferLegacyDataImport(targetDirectory: string, legacyDirectory: string): Promise<boolean> {
  const [target, legacy] = await Promise.all([
    inspectBusinessDataDirectory(targetDirectory),
    inspectBusinessDataDirectory(legacyDirectory),
  ]);
  return !target.hasBusinessData && legacy.hasBusinessData;
}

async function inspectSessionData(sessionsDirectory: string): Promise<{ hasSessions: boolean; hasToolResults: boolean }> {
  try {
    const entries = await readdir(sessionsDirectory, { withFileTypes: true });
    let hasSessions = false;
    let hasToolResults = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDirectory = path.join(sessionsDirectory, entry.name);
      if (await isRegularFile(path.join(sessionDirectory, "session.jsonl"))) hasSessions = true;
      if (await hasFiles(path.join(sessionDirectory, "tool-results"))) hasToolResults = true;
    }
    return { hasSessions, hasToolResults };
  } catch {
    return { hasSessions: false, hasToolResults: false };
  }
}

async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function hasFiles(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch {
    return false;
  }
}
