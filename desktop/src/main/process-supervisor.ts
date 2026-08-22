import { spawn, type ChildProcess } from "node:child_process";

/**
 * 作为 Electron 主进程与 Java/Next.js 之间的故障隔离层；主进程被强制终止时，supervisor 仍能发现父进程消失并回收目标服务。
 */
async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const parentPid = Number(options.parentPid);
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("supervisor 父进程标识无效");
  const targetExecutable = decodeJson<string>(options.targetExecutable);
  const targetArguments = decodeJson<string[]>(options.targetArguments);
  const targetEnvironment = decodeJson<Record<string, string>>(options.targetEnvironment);
  const target = spawnTarget(targetExecutable, targetArguments, targetEnvironment);
  let isStopping = false;

  const stopParentWatch = watchParentProcess(parentPid, () => {
    if (isStopping) return;
    isStopping = true;
    void stopTarget(target).finally(() => process.exit(0));
  });

  target.once("error", (error) => {
    process.stderr.write(`supervisor target error: ${error.message}\n`);
    stopParentWatch();
    process.exit(1);
  });
  target.once("close", (code, signal) => {
    if (isStopping) return;
    isStopping = true;
    stopParentWatch();
    process.exit(code ?? (signal ? 1 : 0));
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK"] as const) {
    process.once(signal, () => {
      if (isStopping) return;
      isStopping = true;
      stopParentWatch();
      void stopTarget(target).finally(() => process.exit(0));
    });
  }
}

function readOptions(argumentsList: string[]): {
  parentPid: string;
  targetExecutable: string;
  targetArguments: string;
  targetEnvironment: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("supervisor 参数不完整");
    values.set(key, value);
  }
  const parentPid = values.get("--parent-pid");
  const targetExecutable = values.get("--target-executable");
  const targetArguments = values.get("--target-arguments");
  const targetEnvironment = values.get("--target-environment");
  if (!parentPid || !targetExecutable || !targetArguments || !targetEnvironment) {
    throw new Error("supervisor 缺少目标进程参数");
  }
  return { parentPid, targetExecutable, targetArguments, targetEnvironment };
}

function decodeJson<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

function spawnTarget(executable: string, argumentsList: string[], environment: Record<string, string>): ChildProcess {
  const child = spawn(executable, argumentsList, {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  return child;
}

function watchParentProcess(parentPid: number, onParentExit: () => void): () => void {
  // 仅依赖父 PID 是否仍存在可能误判 PID 复用，因此同时检查 supervisor 当前的父 PID。
  const timer = setInterval(() => {
    if (process.ppid !== parentPid || !isProcessAlive(parentPid)) onParentExit();
  }, 500);
  return () => clearInterval(timer);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopTarget(target: ChildProcess): Promise<void> {
  if (target.exitCode !== null || target.signalCode !== null) return;
  if (process.platform === "win32" && target.pid) {
    await runTaskKill(target.pid);
    return;
  }
  target.kill("SIGTERM");
  await waitForExit(target, 5_000);
  if (target.exitCode === null && target.signalCode === null) target.kill("SIGKILL");
}

function runTaskKill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const taskKill = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    taskKill.once("close", () => resolve());
    taskKill.once("error", () => resolve());
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "supervisor 启动失败"}\n`);
  process.exit(1);
});
