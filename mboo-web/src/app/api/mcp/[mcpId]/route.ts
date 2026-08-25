import { proxyBackendJson } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ mcpId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const { mcpId } = await context.params;
  return proxyBackendJson(`/mcp/${encodeURIComponent(mcpId)}`, {
    method: "PUT",
    headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
    body: await request.text(),
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { mcpId } = await context.params;
  return proxyBackendJson(`/mcp/${encodeURIComponent(mcpId)}`, { method: "DELETE" });
}
