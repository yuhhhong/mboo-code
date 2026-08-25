import { proxyBackendResponse } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return proxyBackendResponse("/skill/import", {
    method: "POST",
    headers: { "Content-Type": request.headers.get("Content-Type") || "multipart/form-data" },
    body: request.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}
