import { proxyBackendJson } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  return proxyBackendJson(`/skill?${url.searchParams.toString()}`, { method: "DELETE" });
}
