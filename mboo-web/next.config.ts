import type { NextConfig } from "next";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// 开发态默认只放行 localhost；用局域网 IP 打开时 HMR/内部资源会被拦。
// 启动时收集本机非 loopback IPv4，写入 allowedDevOrigins。
function collectLanDevOrigins(): string[] {
  const origins = new Set<string>(["127.0.0.1"]);
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      const family = String(info.family);
      if ((family === "IPv4" || family === "4") && !info.internal) {
        origins.add(info.address);
      }
    }
  }
  return [...origins];
}

// 设计决策：MarkStream 可选图示 peer 写成静态 import()，Turbopack 会硬解析；
// 第一期映射到本地空模块，避免安装未使用的大依赖。
const optionalPeerAliases = {
  "@antv/infographic": "./src/lib/markstream-stubs/empty-module.ts",
  "@terrastruct/d2": "./src/lib/markstream-stubs/empty-module.ts",
  mermaid: "./src/lib/markstream-stubs/empty-module.ts",
  katex: "./src/lib/markstream-stubs/empty-module.ts",
  "stream-monaco": "./src/lib/markstream-stubs/empty-module.ts",
  "stream-markdown": "./src/lib/markstream-stubs/empty-module.ts",
};

const nextConfig: NextConfig = {
  // 桌面生产包由内置 Node.js 直接运行 standalone server.js，避免目标机器依赖 npm 或 next 命令。
  output: "standalone",
  // 允许本机局域网 IP 访问开发服务（含 /_next/webpack-hmr）
  allowedDevOrigins: collectLanDevOrigins(),
  reactCompiler: true,
  // 避免上层多 lockfile 导致 workspace root 误判与多余扫描
  turbopack: {
    root: rootDir,
    resolveAlias: optionalPeerAliases,
  },
  webpack: (config) => {
    const emptyModule = path.join(rootDir, "src/lib/markstream-stubs/empty-module.ts");
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@antv/infographic": emptyModule,
      "@terrastruct/d2": emptyModule,
      mermaid: emptyModule,
      katex: emptyModule,
      "stream-monaco": emptyModule,
      "stream-markdown": emptyModule,
    };
    return config;
  },
};

export default nextConfig;
