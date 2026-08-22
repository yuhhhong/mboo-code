import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRuntimePreparationPlan, readRuntimeManifest } from "../src/build/runtime-manifest.js";
import { assertExecutableVersion, getRuntimeExecutableRelativePath, verifyExecutableArchitecture } from "../src/build/resource-verification.js";
import type { DesktopTargetKey } from "../src/shared/platform.js";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetKey = readTargetKey();
const manifest = await readRuntimeManifest(path.join(desktopDirectory, "resources", "runtime", "manifest.json"));
const plan = createRuntimePreparationPlan({ desktopDirectory, targetKey, manifest });
const executableByKind = Object.fromEntries(plan.components.map((component) => [component.kind, component.outputPath])) as Record<"jre" | "node" | "rg", string>;
const javaExecutable = path.join(executableByKind.jre, getRuntimeExecutableRelativePath("jre", targetKey));
const nodeExecutable = path.join(executableByKind.node, getRuntimeExecutableRelativePath("node", targetKey));

await verifyExecutableArchitecture(javaExecutable, targetKey, "JRE");
await verifyExecutableArchitecture(nodeExecutable, targetKey, "Node.js");
await verifyExecutableArchitecture(path.join(path.dirname(executableByKind.rg), getRuntimeExecutableRelativePath("rg", targetKey)), targetKey, "rg");

if (isCurrentHostTarget(targetKey)) {
  const nodeVersion = await readCommandOutput(nodeExecutable, ["--version"]);
  const rgExecutable = path.join(path.dirname(executableByKind.rg), getRuntimeExecutableRelativePath("rg", targetKey));
  const rgVersion = await readCommandOutput(rgExecutable, ["--version"]);
  const javaVersion = await readCommandOutput(javaExecutable, ["-version"]);
  assertExecutableVersion(nodeVersion, manifest.targets[targetKey].node.version, "Node.js");
  assertExecutableVersion(rgVersion, manifest.targets[targetKey].rg.version, "rg");
  assertExecutableVersion(javaVersion, manifest.targets[targetKey].jre.version, "JRE");
}

console.log(`已通过 ${targetKey} 资源完整性校验${isCurrentHostTarget(targetKey) ? "（含本机版本执行）" : "（跨架构静态校验）"}`);

function readTargetKey(): DesktopTargetKey {
  const targetKey = process.argv[2];
  if (targetKey === "win32-x64" || targetKey === "darwin-x64" || targetKey === "darwin-arm64") return targetKey;
  throw new Error("请传入目标平台：win32-x64、darwin-x64 或 darwin-arm64");
}

function isCurrentHostTarget(targetKey: DesktopTargetKey): boolean {
  return (targetKey === "darwin-arm64" && process.platform === "darwin" && process.arch === "arm64")
    || (targetKey === "darwin-x64" && process.platform === "darwin" && process.arch === "x64")
    || (targetKey === "win32-x64" && process.platform === "win32" && process.arch === "x64");
}

function readCommandOutput(command: string, argumentsList: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: "pipe" });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(`${output}\n${errorOutput}`.trim());
      else reject(new Error(`无法执行 ${command}：${errorOutput.trim()}`));
    });
  });
}
