export const dynamic = "force-dynamic";

/**
 * 独立提供 Next.js 进程归属证明，使 Electron 能在 Java 尚未可用时区分前端服务是否已成功启动。
 */
export async function GET() {
  return Response.json(
    {
      status: "UP",
      version: process.env.MBOO_VERSION || "0.1.0",
      instanceId: process.env.MBOO_INSTANCE_ID || "",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
