import { type DesktopArchitecture, type DesktopPlatform } from "../shared/platform.js";
import { getDesktopResourceLayout } from "../shared/resource-layout.js";

export interface NextServerLaunchSpec {
  executable: string;
  arguments: string[];
  environment: Record<string, string>;
}

export interface NextServerLaunchOptions {
  resourcesDirectory: string;
  platform: DesktopPlatform;
  architecture: DesktopArchitecture;
  port: number;
  javaPort: number;
  instanceId: string;
}

/**
 * 统一生成 Next.js standalone 的启动参数，确保桌面生产包不依赖系统 Node.js、npm 或固定端口。
 */
export function createNextServerLaunchSpec(options: NextServerLaunchOptions): NextServerLaunchSpec {
  const layout = getDesktopResourceLayout(options.resourcesDirectory, options.platform, options.architecture);

  return {
    executable: layout.nodeExecutable,
    arguments: [layout.webServer],
    environment: {
      HOSTNAME: "127.0.0.1",
      PORT: String(options.port),
      MBOO_API_BASE_URL: `http://127.0.0.1:${options.javaPort}`,
      MBOO_INSTANCE_ID: options.instanceId,
    },
  };
}
