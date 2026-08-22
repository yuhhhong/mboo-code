import path from "node:path";

import type { DesktopPlatform } from "../shared/platform.js";

/**
 * 为 Java sidecar 构造唯一的 SQLite 地址，确保数据库与 Electron 指定的数据目录始终同源。
 */
export function buildSqliteJdbcUrl(appDataDirectory: string, platform: DesktopPlatform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(appDataDirectory)) {
    throw new Error("桌面应用数据目录必须是绝对路径");
  }

  return `jdbc:sqlite:${pathApi.join(appDataDirectory, "mboo_data.sqlite")}`;
}
