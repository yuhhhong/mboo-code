import type { BrowserWindowConstructorOptions } from "electron";

export interface DiagnosticsDocumentData {
  phase: string;
  message: string;
  logPath?: string;
  copyText?: string;
}

/**
 * 将渲染进程权限收敛在单一配置中，避免新增窗口时意外开放 Node.js 或绕过受控桥接。
 */
export function createWindowSecurityOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    show: false,
    backgroundColor: "#f4f9ff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath
    }
  };
}

/**
 * 生成不依赖 Next.js 的本地故障文档，让 sidecar 启动失败时用户仍能看到可复制的诊断信息。
 */
export function createDiagnosticsDataUrl(diagnostics: DiagnosticsDocumentData): string {
  const copyText = diagnostics.copyText || `${diagnostics.phase}\n${diagnostics.message}`;
  const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mboo Code 启动诊断</title>
<style>
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f9ff; color: #12233d; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(720px, calc(100vw - 48px)); padding: 32px; border: 1px solid #c9d8e8; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgba(28, 59, 91, .12); }
h1 { margin: 0 0 12px; font-size: 24px; }
p { line-height: 1.6; }
code, pre { color: #40556e; white-space: pre-wrap; overflow-wrap: anywhere; }
pre { padding: 16px; border-radius: 8px; background: #eef4fa; }
button { cursor: pointer; border: 1px solid #1687a7; border-radius: 7px; padding: 9px 14px; color: #fff; background: #1687a7; font: inherit; }
button:focus-visible { outline: 3px solid rgba(22, 135, 167, .3); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>Mboo Code 暂时无法启动</h1>
<p id="message"></p>
<p>请把下面的诊断信息提供给开发者：</p>
<pre id="details"></pre>
<button id="copy" type="button">复制诊断信息</button>
</main>
<script>
const details = ${serializeScriptValue(copyText)};
document.getElementById("message").textContent = ${serializeScriptValue(diagnostics.message)};
document.getElementById("details").textContent = details;
document.getElementById("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(details);
    document.getElementById("copy").textContent = "已复制";
  } catch {
    document.getElementById("copy").textContent = "复制失败，请手动复制";
  }
});
</script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function serializeScriptValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * 只允许当前 Electron 启动的本地 Next.js 服务承载页面，防止页面重定向到任意远程地址后继承桌面桥接。
 */
export function isAllowedNavigation(targetUrl: string, localOrigin: string): boolean {
  try {
    return new URL(targetUrl).origin === new URL(localOrigin).origin;
  } catch {
    return false;
  }
}
