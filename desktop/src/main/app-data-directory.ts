import path from "node:path";

/**
 * 保持桌面版与原有 Java 浏览器模式共用同一业务数据目录，避免启动桌面 App 后出现两套会话和模型配置。
 */
export function resolveDesktopAppDataDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, ".mboo");
}
