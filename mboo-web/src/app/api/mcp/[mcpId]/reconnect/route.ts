import { proxyBackendJson } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ mcpId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { mcpId } = await context.params;
  return proxyBackendJson(`/mcp/${encodeURIComponent(mcpId)}/reconnect`, { method: "POST" });
}
