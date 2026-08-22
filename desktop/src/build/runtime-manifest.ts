import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { DesktopTargetKey } from "../shared/platform.js";

const targetKeys: DesktopTargetKey[] = ["win32-x64", "darwin-x64", "darwin-arm64"];

export interface RuntimeComponent {
  name: string;
  version: string;
  url: string;
  sha256: string;
  license: string;
}

export interface DesktopRuntimeManifest {
  schemaVersion: 1;
  updatedAt: string;
  targets: Record<DesktopTargetKey, {
    jre: RuntimeComponent;
    node: RuntimeComponent;
    rg: RuntimeComponent;
  }>;
}

export interface RuntimePreparationComponent {
  kind: "jre" | "node" | "rg";
  component: RuntimeComponent;
  archivePath: string;
  outputPath: string;
}

export interface RuntimePreparationPlan {
  targetKey: DesktopTargetKey;
  cacheDirectory: string;
  archivesDirectory: string;
  components: RuntimePreparationComponent[];
}

/**
 * 读取并校验冻结的运行时清单，阻止构建脚本在来源、许可证或校验值不完整时继续下载资源。
 */
export async function readRuntimeManifest(manifestPath: string): Promise<DesktopRuntimeManifest> {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.updatedAt !== "string" || !isRecord(raw.targets)) {
    throw new Error("桌面运行时清单格式无效");
  }

  const targets = {} as DesktopRuntimeManifest["targets"];
  for (const targetKey of targetKeys) {
    const target = raw.targets[targetKey];
    if (!isRecord(target)) throw new Error(`桌面运行时清单缺少目标: ${targetKey}`);
    targets[targetKey] = {
      jre: parseComponent(target.jre, targetKey, "jre"),
      node: parseComponent(target.node, targetKey, "node"),
      rg: parseComponent(target.rg, targetKey, "rg"),
    };
  }

  return { schemaVersion: 1, updatedAt: raw.updatedAt, targets };
}

/**
 * 对下载归档做流式 SHA-256 校验，避免大体积 JRE 和 Node.js 资源在内存中产生重复副本。
 */
export async function verifyRuntimeArchive(archivePath: string, expectedChecksum: string): Promise<void> {
  const checksum = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) {
    checksum.update(chunk);
  }
  const actualChecksum = checksum.digest("hex");
  if (actualChecksum !== expectedChecksum.toLowerCase()) {
    throw new Error(`运行时归档 SHA-256 校验失败：期望 ${expectedChecksum}，实际 ${actualChecksum}`);
  }
}

/**
 * 将清单条目映射到单目标缓存目录，确保不同系统资源不会共用归档或解压输出。
 */
export function createRuntimePreparationPlan(options: {
  desktopDirectory: string;
  targetKey: DesktopTargetKey;
  manifest: DesktopRuntimeManifest;
}): RuntimePreparationPlan {
  const cacheDirectory = path.join(options.desktopDirectory, ".runtime-cache", options.targetKey);
  const archivesDirectory = path.join(options.desktopDirectory, ".runtime-archives", options.targetKey);
  const target = options.manifest.targets[options.targetKey];
  const rgFileName = options.targetKey === "win32-x64" ? "rg.exe" : "rg";

  return {
    targetKey: options.targetKey,
    cacheDirectory,
    archivesDirectory,
    components: [
      {
        kind: "jre",
        component: target.jre,
        archivePath: path.join(archivesDirectory, target.jre.name),
        outputPath: path.join(cacheDirectory, "jre"),
      },
      {
        kind: "node",
        component: target.node,
        archivePath: path.join(archivesDirectory, target.node.name),
        outputPath: path.join(cacheDirectory, "node"),
      },
      {
        kind: "rg",
        component: target.rg,
        archivePath: path.join(archivesDirectory, target.rg.name),
        outputPath: path.join(cacheDirectory, "rg", rgFileName),
      },
    ],
  };
}

function parseComponent(value: unknown, targetKey: DesktopTargetKey, componentName: string): RuntimeComponent {
  if (!isRecord(value)
    || typeof value.name !== "string"
    || typeof value.version !== "string"
    || typeof value.url !== "string"
    || typeof value.sha256 !== "string"
    || typeof value.license !== "string"
    || !value.url.startsWith("https://")
    || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) {
    throw new Error(`桌面运行时清单无效：${targetKey}/${componentName}`);
  }

  return {
    name: value.name,
    version: value.version,
    url: value.url,
    sha256: value.sha256.toLowerCase(),
    license: value.license,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
