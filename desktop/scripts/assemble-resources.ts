import path from "node:path";
import { fileURLToPath } from "node:url";

import { assembleResourceBundle, createResourceAssemblyPlan } from "../src/build/resource-assembly.js";
import type { DesktopTargetKey } from "../src/shared/platform.js";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = path.resolve(desktopDirectory, "..");
const targetKey = readTargetKey();
const plan = createResourceAssemblyPlan({ desktopDirectory, workspaceDirectory, targetKey });

await assembleResourceBundle(plan);
console.log(`已组装 ${targetKey} 打包资源：${plan.outputDirectory}`);

function readTargetKey(): DesktopTargetKey {
  const targetKey = process.argv[2];
  if (targetKey === "win32-x64" || targetKey === "darwin-x64" || targetKey === "darwin-arm64") return targetKey;
  throw new Error("请传入目标平台：win32-x64、darwin-x64 或 darwin-arm64");
}
