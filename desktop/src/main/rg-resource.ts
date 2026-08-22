import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import { resolveDesktopPlatform, type DesktopArchitecture, type DesktopPlatform } from "../shared/platform.js";
import { getDesktopResourceLayout } from "../shared/resource-layout.js";

/**
 * 校验 Electron 即将传给 Java 的 rg 路径属于当前安装包资源，阻止缺失、权限丢失或路径逃逸后再进入服务启动循环。
 */
export async function verifyBundledRg(resourcesDirectory: string, platform: DesktopPlatform, architecture: DesktopArchitecture): Promise<string> {
  resolveDesktopPlatform(platform, architecture);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resourceRoot = pathApi.resolve(resourcesDirectory);
  const executable = pathApi.resolve(getDesktopResourceLayout(resourceRoot, platform, architecture).rgExecutable);
  const relative = pathApi.relative(resourceRoot, executable);
  if (!relative || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
    throw new Error("桌面随包 ripgrep 路径不在应用资源目录内");
  }

  try {
    const metadata = await stat(executable);
    if (!metadata.isFile()) throw new Error("桌面随包 ripgrep 不是普通文件");
    await access(executable, constants.X_OK);
  } catch (error) {
    if (error instanceof Error && error.message.includes("不是普通文件")) throw error;
    throw new Error(`桌面随包 ripgrep 不存在或不可执行：${executable}`);
  }
  return executable;
}
