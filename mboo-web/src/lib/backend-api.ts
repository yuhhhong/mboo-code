const DEFAULT_API_BASE_URL = "http://localhost:8080";

export function getApiBaseUrl() {
  return (process.env.MBOO_API_BASE_URL || DEFAULT_API_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

export async function proxyBackendJson(path: string, init: RequestInit = {}) {
  const apiBaseUrl = getApiBaseUrl();
  try {
    const upstream = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      cache: "no-store",
    });

    const contentType = upstream.headers.get("Content-Type") || "";
    const text = await upstream.text().catch(() => "");

    if (!contentType.toLowerCase().includes("application/json")) {
      return Response.json(
        { message: parseUpstreamErrorMessage(text) },
        { status: upstream.ok ? 502 : upstream.status },
      );
    }

    const headers = new Headers();
    headers.set("Content-Type", contentType || "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");

    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return backendConnectionFailedResponse(error);
  }
}

export async function proxyBackendResponse(path: string, init: RequestInit = {}) {
  const apiBaseUrl = getApiBaseUrl();
  try {
    const upstream = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      cache: "no-store",
    });
    const headers = new Headers();
    const contentType = upstream.headers.get("Content-Type");
    const contentDisposition = upstream.headers.get("Content-Disposition");
    if (contentType) headers.set("Content-Type", contentType);
    if (contentDisposition) headers.set("Content-Disposition", contentDisposition);
    headers.set("Cache-Control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    return backendConnectionFailedResponse(error);
  }
}

/**
 * 让页面得到一次可读失败结果而不是框架级 500；恢复行为由用户显式触发，避免服务故障时产生刷新循环。
 */
function backendConnectionFailedResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "未知错误";
  return Response.json(
    { message: `无法连接后端服务：${message}` },
    {
      status: 502,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export function parseUpstreamErrorMessage(text: string) {
  if (!text.trim()) {
    return "后端没有返回有效响应";
  }

  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message || data.msg || data.error || data.exception;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  } catch {
    return text.trim();
  }

  return text.trim();
}
