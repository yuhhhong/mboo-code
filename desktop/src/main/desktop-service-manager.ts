import { mkdir } from "node:fs/promises";
import path from "node:path";

import { createInstanceId } from "./instance-id.js";
import { createJavaServerLaunchSpec } from "./java-server.js";
import { launchManagedProcess } from "./managed-process.js";
import { createNextServerLaunchSpec } from "./next-server.js";
import { waitForServiceHealth } from "./health-check.js";
import { allocateLoopbackPorts } from "./port-allocation.js";
import { DesktopStartupCoordinator, type DesktopServiceRuntime } from "./startup-coordinator.js";
import { resolveDesktopPlatform, type DesktopArchitecture, type DesktopPlatform } from "../shared/platform.js";
import { getDesktopResourceLayout } from "../shared/resource-layout.js";
import { DesktopDiagnosticsCollector, type DesktopStartupDiagnostics } from "./diagnostics.js";
import { verifyBundledRg } from "./rg-resource.js";

export interface DesktopServiceManagerOptions {
  resourcesDirectory: string;
  userDataDirectory: string;
  appDataDirectory?: string;
  platform: string;
  architecture: string;
}

export interface DesktopServiceStartResult {
  runtime: DesktopServiceRuntime;
  diagnostics: DesktopStartupDiagnostics;
}

export class DesktopServiceStartError extends Error {
  constructor(message: string, readonly diagnostics: DesktopStartupDiagnostics) {
    super(message);
  }
}

/**
 * 组装生产桌面端的服务托管链路。开发时设置 MBOO_DESKTOP_URL 会绕过本管理器，仍保留原有前端调试方式。
 */
export async function startDesktopServices(options: DesktopServiceManagerOptions): Promise<DesktopServiceStartResult> {
  const platform = requireSupportedPlatform(options.platform, options.architecture);
  const architecture = options.architecture as DesktopArchitecture;
  const appDataDirectory = options.appDataDirectory ?? path.join(options.userDataDirectory, "mboo");
  await mkdir(appDataDirectory, { recursive: true });
  const collector = await DesktopDiagnosticsCollector.create(path.join(appDataDirectory, "logs", "desktop-startup.log"));
  const javaRuntime = getDesktopResourceLayout(options.resourcesDirectory, platform, architecture).javaExecutable;
  try {
    await verifyBundledRg(options.resourcesDirectory, platform, architecture);
  } catch (error) {
    const message = error instanceof Error ? error.message : "桌面随包 ripgrep 校验失败";
    collector.recordOutput("启动预检", "stderr", message);
    await collector.flush();
    throw new DesktopServiceStartError(message, collector.snapshot({
      phase: "resource-check-failed",
      message,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      javaRuntime,
    }));
  }

  const supervisorScript = path.join(options.resourcesDirectory, "process-supervisor.js");
  const nodeExecutable = getDesktopResourceLayout(options.resourcesDirectory, platform, architecture).nodeExecutable;

  const coordinator = new DesktopStartupCoordinator({
    allocatePorts: allocateLoopbackPorts,
    createInstanceId,
    launchJava: async (context) => {
      const spec = createJavaServerLaunchSpec({
        resourcesDirectory: options.resourcesDirectory,
        appDataDirectory,
        platform,
        architecture,
        port: context.ports.javaPort,
        instanceId: context.instanceId,
      });
      return launchManagedProcess({
        name: "Java sidecar",
        executable: spec.executable,
        arguments: spec.arguments,
        supervisorExecutable: nodeExecutable,
        supervisorScript,
        environment: spec.environment,
        cwd: options.resourcesDirectory,
        onOutput: (service, stream, message) => collector.recordOutput(service, stream, message),
        onExit: (service, exitCode, signal) => collector.recordExit(service, exitCode, signal),
      });
    },
    launchNext: async (context) => {
      const spec = createNextServerLaunchSpec({
        resourcesDirectory: options.resourcesDirectory,
        platform,
        architecture,
        port: context.ports.nextPort,
        javaPort: context.ports.javaPort,
        instanceId: context.instanceId,
      });
      return launchManagedProcess({
        name: "Next.js standalone",
        executable: spec.executable,
        arguments: spec.arguments,
        supervisorExecutable: nodeExecutable,
        supervisorScript,
        environment: spec.environment,
        cwd: options.resourcesDirectory,
        onOutput: (service, stream, message) => collector.recordOutput(service, stream, message),
        onExit: (service, exitCode, signal) => collector.recordExit(service, exitCode, signal),
      });
    },
    waitForHealth: ({ phase, context, process }) => waitForServiceHealth({
      phase,
      context,
      process,
      url: `http://${context.ports.host}:${phase === "java" ? context.ports.javaPort : context.ports.nextPort}${phase === "java" ? "/desktop/health" : "/api/desktop/health"}`,
    }),
    onPhase: (context, phase, message) => collector.recordPhase({
      phase,
      attempt: context.attempt,
      javaPort: context.ports.javaPort,
      nextPort: context.ports.nextPort,
      message,
    }),
  });
  try {
    const runtime = await coordinator.start();
    await collector.flush();
    return {
      runtime,
      diagnostics: collector.snapshot({
        phase: "ready",
        message: "桌面服务已就绪",
        electronVersion: process.versions.electron ?? "unknown",
        nodeVersion: process.versions.node,
        javaRuntime,
      }),
    };
  } catch (error) {
    await collector.flush();
    const message = error instanceof Error ? error.message : "桌面服务启动失败";
    throw new DesktopServiceStartError(message, collector.snapshot({
      phase: "startup-failed",
      message,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      javaRuntime,
    }));
  }
}

function requireSupportedPlatform(platform: string, architecture: string): DesktopPlatform {
  resolveDesktopPlatform(platform, architecture);
  return platform as DesktopPlatform;
}
