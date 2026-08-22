import path from "node:path";

import { resolveDesktopPlatform, type DesktopArchitecture, type DesktopPlatform } from "./platform.js";

export interface DesktopResourceLayout {
  javaExecutable: string;
  nodeExecutable: string;
  rgExecutable: string;
  backendJar: string;
  webServer: string;
}

/**
 * 让运行时和打包脚本使用同一份目标资源结构，防止 Java、Node 或 rg 在不同阶段被拼到不同目录。
 */
export function getDesktopResourceLayout(
  resourcesDirectory: string,
  platform: DesktopPlatform,
  architecture: DesktopArchitecture,
): DesktopResourceLayout {
  const target = resolveDesktopPlatform(platform, architecture);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const javaExecutable = platform === "win32" ? "java.exe" : "java";
  const nodeExecutable = platform === "win32" ? "node.exe" : "node";

  return {
    javaExecutable: pathApi.join(resourcesDirectory, "runtime", target.key, "jre", "bin", javaExecutable),
    nodeExecutable: pathApi.join(resourcesDirectory, "runtime", target.key, "node", ...(platform === "win32" ? [nodeExecutable] : ["bin", nodeExecutable])),
    rgExecutable: pathApi.join(resourcesDirectory, "tools", "rg", target.rgFileName),
    backendJar: pathApi.join(resourcesDirectory, "backend", "mboo-code.jar"),
    webServer: pathApi.join(resourcesDirectory, "web", "server.js"),
  };
}
