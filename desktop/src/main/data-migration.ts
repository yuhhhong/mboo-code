import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { inspectBusinessDataDirectory, type BusinessDataInspection } from "./data-directory-inspection.js";

/**
 * 在同一父目录中先构建并校验临时副本，再原子切换到桌面目录，确保任一步失败都不会损坏旧数据或目标业务数据。
 */
export async function importLegacyBusinessData(
  legacyDirectory: string,
  targetDirectory: string,
  options: { allowReplaceTarget?: boolean } = {},
): Promise<BusinessDataInspection> {
  const source = await inspectBusinessDataDirectory(legacyDirectory);
  if (!source.hasBusinessData) throw new Error("旧目录没有可导入的业务数据");

  const existingTarget = await inspectBusinessDataDirectory(targetDirectory);
  if (existingTarget.hasBusinessData && !options.allowReplaceTarget) throw new Error("桌面数据目录已有业务数据，不能覆盖导入");

  const parentDirectory = path.dirname(targetDirectory);
  const temporaryDirectory = `${targetDirectory}.import-${randomUUID()}.tmp`;
  const backupDirectory = `${targetDirectory}.pre-import-${randomUUID()}.backup`;
  await mkdir(parentDirectory, { recursive: true });

  try {
    await copySupportedBusinessData(legacyDirectory, temporaryDirectory, source.types);
    await validateImportedBusinessData(temporaryDirectory, source.types);
    await activateImportedData(temporaryDirectory, targetDirectory, backupDirectory);
    return inspectBusinessDataDirectory(targetDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    if (await exists(backupDirectory) && !(await exists(targetDirectory))) {
      await rename(backupDirectory, targetDirectory);
    }
    throw error;
  } finally {
    await rm(backupDirectory, { recursive: true, force: true });
  }
}

async function copySupportedBusinessData(source: string, target: string, types: BusinessDataInspection["types"]): Promise<void> {
  await mkdir(target, { recursive: true });
  if (types.includes("sqlite")) {
    await cp(path.join(source, "mboo_data.sqlite"), path.join(target, "mboo_data.sqlite"));
    for (const suffix of ["-wal", "-shm"]) {
      const companion = path.join(source, `mboo_data.sqlite${suffix}`);
      if (await exists(companion)) await cp(companion, path.join(target, `mboo_data.sqlite${suffix}`));
    }
  }
  if (types.includes("settings")) await cp(path.join(source, "setting.json"), path.join(target, "setting.json"));
  if (types.includes("sessions") || types.includes("toolResults")) {
    await cp(path.join(source, "sessions"), path.join(target, "sessions"), { recursive: true, errorOnExist: true });
  }
}

async function validateImportedBusinessData(directory: string, types: BusinessDataInspection["types"]): Promise<void> {
  if (types.includes("sqlite")) await validateSqlite(path.join(directory, "mboo_data.sqlite"));
  if (types.includes("settings")) await validateSettings(path.join(directory, "setting.json"));
  if (types.includes("sessions")) await validateSessionJsonl(path.join(directory, "sessions"));
}

async function activateImportedData(temporary: string, target: string, backup: string): Promise<void> {
  if (await exists(target)) await rename(target, backup);
  try {
    await rename(temporary, target);
  } catch (error) {
    if (await exists(backup) && !(await exists(target))) await rename(backup, target);
    throw error;
  }
}

async function validateSqlite(file: string): Promise<void> {
  const header = await readFile(file, { encoding: null });
  if (header.length < 16 || !header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
    throw new Error("mboo_data.sqlite 无法识别为 SQLite 数据库");
  }
}

async function validateSettings(file: string): Promise<void> {
  try {
    JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`setting.json 无法解析：${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function validateSessionJsonl(sessionsDirectory: string): Promise<void> {
  const entries = await readdir(sessionsDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(sessionsDirectory, entry.name, "session.jsonl");
    if (!(await exists(file))) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        throw new Error(`会话事件文件无法读取：${file}`);
      }
    }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
