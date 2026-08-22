import type { DesktopArchitecture, DesktopPlatform } from "../shared/platform.js";
import { getDesktopResourceLayout } from "../shared/resource-layout.js";
import { buildSqliteJdbcUrl } from "./sqlite-url.js";

export interface JavaServerLaunchSpec {
  executable: string;
  arguments: string[];
  environment: Record<string, string>;
}

export interface JavaServerLaunchOptions {
  resourcesDirectory: string;
  appDataDirectory: string;
  platform: DesktopPlatform;
  architecture: DesktopArchitecture;
  port: number;
  instanceId: string;
}

/**
 * 统一生成 Java sidecar 的启动契约，使 SQLite、JSONL、工具结果与随包 rg 都由 Electron 的同一数据和资源边界控制。
 */
export function createJavaServerLaunchSpec(options: JavaServerLaunchOptions): JavaServerLaunchSpec {
  const layout = getDesktopResourceLayout(options.resourcesDirectory, options.platform, options.architecture);

  return {
    executable: layout.javaExecutable,
    arguments: [
      `-Dserver.port=${options.port}`,
      "-Dserver.address=127.0.0.1",
      `-Dmboo.appDataDir=${options.appDataDirectory}`,
      `-Dspring.datasource.url=${buildSqliteJdbcUrl(options.appDataDirectory, options.platform)}`,
      `-Dmboo.rgPath=${layout.rgExecutable}`,
      "-jar",
      layout.backendJar,
    ],
    environment: { MBOO_INSTANCE_ID: options.instanceId },
  };
}
