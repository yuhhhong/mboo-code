export type DesktopPlatform = "win32" | "darwin";
export type DesktopArchitecture = "x64" | "arm64";
export type DesktopTargetKey = "win32-x64" | "darwin-x64" | "darwin-arm64";

export interface DesktopPlatformInfo {
  key: DesktopTargetKey;
  rgFileName: "rg.exe" | "rg";
}

/**
 * 将 Electron 运行时标识收敛为发布清单中的固定目标键，避免不同模块各自判断平台而选到错误资源。
 */
export function resolveDesktopPlatform(platform: string, architecture: string): DesktopPlatformInfo {
  if (platform === "win32" && architecture === "x64") return { key: "win32-x64", rgFileName: "rg.exe" };
  if (platform === "darwin" && architecture === "x64") return { key: "darwin-x64", rgFileName: "rg" };
  if (platform === "darwin" && architecture === "arm64") return { key: "darwin-arm64", rgFileName: "rg" };
  throw new Error(`不支持的平台或 CPU 架构: ${platform}/${architecture}`);
}
