import { spawn, type ChildProcess } from "node:child_process";

import type { ManagedProcess } from "./startup-coordinator.js";

export interface ProcessLaunchSpec {
  name: string;
  executable: string;
  arguments: string[];
  supervisorExecutable?: string;
  supervisorScript?: string;
  environment: Record<string, string>;
  cwd: string;
  onOutput?(service: string, stream: "stdout" | "stderr", message: string): void;
  onExit?(service: string, exitCode: number | null, signal: NodeJS.Signals | null): void;
}

/**
 * 将子进程封装为可观察、可终止的资源，供启动重试与应用退出共用，避免服务失败后留下监听端口。
 */
export function launchManagedProcess(spec: ProcessLaunchSpec): ManagedProcess & { hasExited(): boolean } {
  const child = spawn(spec.supervisorExecutable ?? spec.executable, createProcessArguments(spec), {
    cwd: spec.cwd,
    env: { ...process.env, ...(!spec.supervisorExecutable || !spec.supervisorScript ? spec.environment : {}) },
    stdio: "pipe",
    windowsHide: true,
  });
  let exited = false;
  child.once("exit", (exitCode, signal) => {
    exited = true;
    spec.onExit?.(spec.name, exitCode, signal);
  });
  child.stdout?.on("data", (chunk: Buffer) => spec.onOutput?.(spec.name, "stdout", chunk.toString("utf8").trim()));
  child.stderr?.on("data", (chunk: Buffer) => spec.onOutput?.(spec.name, "stderr", chunk.toString("utf8").trim()));
  child.once("error", (error) => {
    exited = true;
    spec.onOutput?.(spec.name, "stderr", error.message);
  });

  return {
    name: spec.name,
    hasExited: () => exited,
    stop: () => stopChildProcess(child),
  };
}

function createProcessArguments(spec: ProcessLaunchSpec): string[] {
  if (!spec.supervisorExecutable || !spec.supervisorScript) return spec.arguments;
  return [
    spec.supervisorScript,
    "--parent-pid",
    String(process.pid),
    "--target-executable",
    encodeJson(spec.executable),
    "--target-arguments",
    encodeJson(spec.arguments),
    "--target-environment",
    encodeJson(spec.environment),
  ];
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const forceStopTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(forceStopTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
