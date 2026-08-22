import net from "node:net";

export interface LoopbackPorts {
  host: "127.0.0.1";
  javaPort: number;
  nextPort: number;
}

/**
 * 同时向操作系统申请两组环回端口，缩小重复候选端口的窗口；端口归属仍必须由后续健康检查确认。
 */
export async function allocateLoopbackPorts(): Promise<LoopbackPorts> {
  const host = "127.0.0.1" as const;
  const javaServer = net.createServer();
  const nextServer = net.createServer();

  try {
    const [javaPort, nextPort] = await Promise.all([
      listenOnLoopback(javaServer, host),
      listenOnLoopback(nextServer, host),
    ]);
    return { host, javaPort, nextPort };
  } finally {
    await Promise.all([closeServer(javaServer), closeServer(nextServer)]);
  }
}

function listenOnLoopback(server: net.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法取得环回端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
