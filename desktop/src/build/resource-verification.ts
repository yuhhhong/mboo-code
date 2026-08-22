import { spawn } from "node:child_process";

import type { DesktopTargetKey } from "../shared/platform.js";

export type RuntimeComponentKind = "jre" | "node" | "rg";

/**
 * 统一三类运行时在 Windows 与 POSIX 资源目录中的可执行文件相对路径。
 */
export function getRuntimeExecutableRelativePath(kind: RuntimeComponentKind, targetKey: DesktopTargetKey): string {
  const isWindows = targetKey === "win32-x64";
  if (kind === "jre") return isWindows ? "bin/java.exe" : "bin/java";
  if (kind === "node") return isWindows ? "node.exe" : "bin/node";
  return isWindows ? "rg.exe" : "rg";
}

/**
 * 校验 `file` 返回的目标架构标识，提前阻止将错误 CPU 二进制组装进安装包。
 */
export function assertExecutableArchitecture(fileDescription: string, targetKey: DesktopTargetKey, componentName: string): void {
  const normalizedDescription = fileDescription.toLowerCase();
  const expectedArchitecture = targetKey.endsWith("arm64") ? "arm64" : "x64";
  const architectureMatches = expectedArchitecture === "arm64"
    ? /\barm64\b/.test(normalizedDescription)
    : /\bx86_64\b|\bx86-64\b/.test(normalizedDescription);

  if (!architectureMatches) {
    throw new Error(`${componentName} CPU 架构不匹配：目标 ${targetKey}，实际 ${fileDescription}`);
  }
}

/**
 * 以清单冻结版本校验可执行文件输出，确保下载镜像或缓存替换不会悄悄降低运行时版本。
 */
export function assertExecutableVersion(output: string, expectedVersion: string, componentName: string): void {
  const comparableVersion = expectedVersion.replace(/\+.*/, "");
  if (!output.includes(comparableVersion)) {
    throw new Error(`${componentName} 版本不匹配：期望包含 ${comparableVersion}，实际 ${output}`);
  }
}

/**
 * 使用构建主机的 `file` 工具读取二进制头；此检查不依赖目标二进制可在当前系统执行。
 */
export async function verifyExecutableArchitecture(executablePath: string, targetKey: DesktopTargetKey, componentName: string): Promise<void> {
  const description = await runFileCommand(executablePath);
  assertExecutableArchitecture(description, targetKey, componentName);
}

function runFileCommand(executablePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("file", ["-b", executablePath], { stdio: "pipe" });
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
      if (code === 0) resolve(output.trim());
      else reject(new Error(`无法读取 ${executablePath} 的二进制架构：${errorOutput.trim()}`));
    });
  });
}
