import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimePreparationPlan, readRuntimeManifest } from "../src/build/runtime-manifest.js";
import { prepareRuntimeCache } from "../src/build/runtime-preparation.js";
import type { DesktopTargetKey } from "../src/shared/platform.js";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetKey = readTargetKey();
const manifest = await readRuntimeManifest(path.join(desktopDirectory, "resources", "runtime", "manifest.json"));
const plan = createRuntimePreparationPlan({ desktopDirectory, targetKey, manifest });

await prepareRuntimeCache({ plan });
console.log(`已准备 ${targetKey} 运行时资源：${plan.cacheDirectory}`);

function readTargetKey(): DesktopTargetKey {
  const targetKey = process.argv[2];
  if (targetKey === "win32-x64" || targetKey === "darwin-x64" || targetKey === "darwin-arm64") return targetKey;
  throw new Error("请传入目标平台：win32-x64、darwin-x64 或 darwin-arm64");
}
