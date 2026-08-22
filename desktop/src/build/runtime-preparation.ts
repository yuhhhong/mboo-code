import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";

import type { RuntimePreparationComponent, RuntimePreparationPlan } from "./runtime-manifest.js";
import { verifyRuntimeArchive } from "./runtime-manifest.js";
import { getRuntimeExecutableRelativePath } from "./resource-verification.js";

export interface PrepareRuntimeCacheOptions {
  plan: RuntimePreparationPlan;
  downloadArchive?: (component: RuntimePreparationComponent) => Promise<void>;
  extractArchive?: (component: RuntimePreparationComponent, extractionDirectory: string) => Promise<string>;
}

/**
 * 下载、校验并解压一个目标的运行时资源，再以原子目录切换发布缓存，避免跨平台资源或半成品进入打包输入。
 */
export async function prepareRuntimeCache(options: PrepareRuntimeCacheOptions): Promise<void> {
  const downloadArchive = options.downloadArchive ?? downloadRuntimeArchive;
  const extractArchive = options.extractArchive ?? extractRuntimeArchive;
  const cacheParentDirectory = path.dirname(options.plan.cacheDirectory);
  await mkdir(options.plan.archivesDirectory, { recursive: true });
  await mkdir(cacheParentDirectory, { recursive: true });
  const temporaryCacheDirectory = await mkdtemp(path.join(cacheParentDirectory, `.${options.plan.targetKey}-`));

  try {
    for (const component of options.plan.components) {
      await downloadArchive(component);
      await verifyRuntimeArchive(component.archivePath, component.component.sha256);

      const extractionDirectory = path.join(temporaryCacheDirectory, ".extracted", component.kind);
      await mkdir(extractionDirectory, { recursive: true });
      const extractedDirectory = await extractArchive(component, extractionDirectory);
      const source = await locateExtractedResource(component, extractedDirectory, options.plan.targetKey === "win32-x64");
      const destination = path.join(temporaryCacheDirectory, path.relative(options.plan.cacheDirectory, component.outputPath));

      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: component.kind !== "rg", force: true, preserveTimestamps: true });
      if (component.kind === "rg" && options.plan.targetKey !== "win32-x64") {
        await chmod(destination, 0o755);
      }
    }

    await rm(path.join(temporaryCacheDirectory, ".extracted"), { recursive: true, force: true });
    await rm(options.plan.cacheDirectory, { recursive: true, force: true });
    await rename(temporaryCacheDirectory, options.plan.cacheDirectory);
  } catch (error) {
    await rm(temporaryCacheDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 缓存命中也重新验证 SHA-256；供应链清单变化或缓存被篡改时不能继续使用旧归档。
 */
export async function downloadRuntimeArchive(component: RuntimePreparationComponent): Promise<void> {
  try {
    await verifyRuntimeArchive(component.archivePath, component.component.sha256);
    return;
  } catch {
    // 校验失败时下载新的临时归档，旧缓存不会作为可信输入继续使用。
  }

  const response = await fetch(component.component.url);
  if (!response.ok || !response.body) {
    throw new Error(`下载桌面运行时失败：${component.component.url}（HTTP ${response.status}）`);
  }

  await mkdir(path.dirname(component.archivePath), { recursive: true });
  const temporaryArchivePath = `${component.archivePath}.download`;
  await rm(temporaryArchivePath, { force: true });
  await writeWebStreamToFile(response.body, temporaryArchivePath);
  await verifyRuntimeArchive(temporaryArchivePath, component.component.sha256);
  await rename(temporaryArchivePath, component.archivePath);
}

async function writeWebStreamToFile(body: ReadableStream<Uint8Array>, outputPath: string): Promise<void> {
  const reader = body.getReader();
  const output = createWriteStream(outputPath);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!output.write(value)) await once(output, "drain");
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy(error instanceof Error ? error : undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 使用系统 tar 解压 ZIP、tar.gz 与 tar.xz 归档；打包主机需要具备此基础工具，失败时直接阻断产物生成。
 */
export async function extractRuntimeArchive(component: RuntimePreparationComponent, extractionDirectory: string): Promise<string> {
  await runCommand("tar", ["-xf", component.archivePath, "-C", extractionDirectory]);
  return extractionDirectory;
}

async function locateExtractedResource(
  component: RuntimePreparationComponent,
  extractedDirectory: string,
  isWindows: boolean,
): Promise<string> {
  const executable = path.basename(getRuntimeExecutableRelativePath(component.kind, isWindows ? "win32-x64" : "darwin-arm64"));
  const match = await findMatchingResource(extractedDirectory, component.kind, executable, isWindows);
  if (!match) {
    throw new Error(`运行时归档缺少 ${component.kind} 可执行文件：${component.component.name}`);
  }
  return match;
}

async function findMatchingResource(
  directory: string,
  kind: RuntimePreparationComponent["kind"],
  executable: string,
  isWindows: boolean,
): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (!entry.isDirectory()) {
      if (isWindows && kind === "node" && entry.name === executable) return directory;
      if (kind === "rg" && entry.name === executable) return entryPath;
      continue;
    }
    if (kind === "rg" && entry.name === "rg") {
      const executablePath = path.join(entryPath, executable);
      if (await isFile(executablePath)) return executablePath;
    }
    if (kind !== "rg") {
      const executablePath = path.join(entryPath, "bin", executable);
      if (await isFile(executablePath)) return entryPath;
    }
    const nestedMatch = await findMatchingResource(entryPath, kind, executable, isWindows);
    if (nestedMatch) return nestedMatch;
  }

  if (kind === "rg") {
    const executablePath = path.join(directory, executable);
    if (await isFile(executablePath)) return executablePath;
  }
  return undefined;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function runCommand(command: string, argumentsList: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, argumentsList, { stdio: "pipe" });
    let errorOutput = "";
    process.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    process.once("error", reject);
    process.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`执行 ${command} 失败（退出码 ${code ?? "unknown"}）：${errorOutput.trim()}`));
    });
  });
}
