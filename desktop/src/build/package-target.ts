import type { DesktopTargetKey } from "../shared/platform.js";

/**
 * 让 Electron Builder 的目标与资源组装目标一一对应，防止架构匹配但资源目录错位。
 */
export function createElectronBuilderArguments(targetKey: DesktopTargetKey): string[] {
  const commonArguments = ["--config", "electron-builder.config.cjs", "--publish", "never"];
  if (targetKey === "win32-x64") return ["--win", "--x64", ...commonArguments];
  if (targetKey === "darwin-x64") return ["--mac", "--x64", ...commonArguments];
  return ["--mac", "--arm64", ...commonArguments];
}
