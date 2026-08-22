import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { DesktopTargetKey } from "../shared/platform.js";

const supportedTargets: ReadonlySet<string> = new Set(["win32-x64", "darwin-x64", "darwin-arm64"]);

export interface ResourceCopyOperation {
  source: string;
  destination: string;
}

export interface ResourceAssemblyPlan {
  outputDirectory: string;
  copyOperations: ResourceCopyOperation[];
}

export interface CreateResourceAssemblyPlanOptions {
  desktopDirectory: string;
  workspaceDirectory: string;
  targetKey: DesktopTargetKey;
}

/**
 * 固化单目标包的输入与输出位置，使构建阶段只复制当前架构资源，避免将其他系统二进制带入安装包。
 */
export function createResourceAssemblyPlan(options: CreateResourceAssemblyPlanOptions): ResourceAssemblyPlan {
  if (!supportedTargets.has(options.targetKey)) {
    throw new Error(`不支持的桌面资源目标: ${options.targetKey}`);
  }

  const outputDirectory = path.join(options.desktopDirectory, "build", "resources", options.targetKey);
  const cacheDirectory = path.join(options.desktopDirectory, ".runtime-cache", options.targetKey);
  const rgFileName = options.targetKey === "win32-x64" ? "rg.exe" : "rg";

  return {
    outputDirectory,
    copyOperations: [
      {
        source: path.join(cacheDirectory, "jre"),
        destination: path.join(outputDirectory, "runtime", options.targetKey, "jre"),
      },
      {
        source: path.join(cacheDirectory, "node"),
        destination: path.join(outputDirectory, "runtime", options.targetKey, "node"),
      },
      {
        source: path.join(cacheDirectory, "rg", rgFileName),
        destination: path.join(outputDirectory, "tools", "rg", rgFileName),
      },
      {
        source: path.join(options.workspaceDirectory, "build", "libs", "mboo-code-0.0.1-SNAPSHOT.jar"),
        destination: path.join(outputDirectory, "backend", "mboo-code.jar"),
      },
      {
        source: path.join(options.workspaceDirectory, "mboo-web", ".next", "standalone"),
        destination: path.join(outputDirectory, "web"),
      },
      {
        source: path.join(options.workspaceDirectory, "mboo-web", ".next", "static"),
        destination: path.join(outputDirectory, "web", ".next", "static"),
      },
      {
        source: path.join(options.workspaceDirectory, "mboo-web", "public"),
        destination: path.join(outputDirectory, "web", "public"),
      },
    ],
  };
}

/**
 * 将构建输入复制到临时目录后原子替换目标资源，避免构建中断时 Electron Builder 读取到半成品。
 */
export async function assembleResourceBundle(plan: ResourceAssemblyPlan): Promise<void> {
  const outputParentDirectory = path.dirname(plan.outputDirectory);
  await mkdir(outputParentDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(outputParentDirectory, ".resources-"));

  try {
    for (const operation of plan.copyOperations) {
      const destination = path.join(temporaryDirectory, path.relative(plan.outputDirectory, operation.destination));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(operation.source, destination, { recursive: true, force: true, preserveTimestamps: true });
    }

    await rm(plan.outputDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, plan.outputDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}
