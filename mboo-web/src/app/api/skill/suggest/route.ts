import { proxyBackendJson } from "@/lib/backend-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyBackendJson(`/skill/suggest?${url.searchParams.toString()}`);
}
