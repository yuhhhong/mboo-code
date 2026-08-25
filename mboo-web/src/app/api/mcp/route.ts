import { proxyBackendJson } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return proxyBackendJson("/mcp", {
    method: "POST",
    headers: { "Content-Type": request.headers.get("Content-Type") || "application/json" },
    body: await request.text(),
  });
}
