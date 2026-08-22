import { contextBridge, ipcRenderer } from "electron";

import type { DesktopBridge, DesktopDiagnostics, DesktopRuntimeState, RevealTarget } from "../shared/contracts.js";

/**
 * 渲染进程只通过命名且类型受限的桥接调用桌面能力，避免暴露可组合成任意文件或命令访问的底层 IPC。
 */
const desktopBridge: DesktopBridge = {
  selectWorkspaceDirectory: () => ipcRenderer.invoke("mboo:workspace:select-directory"),
  revealPath: (target: RevealTarget) => ipcRenderer.invoke("mboo:path:reveal", target),
  revealToolResult: (sessionId: string, resultId: string) => ipcRenderer.invoke("mboo:tool-result:reveal", sessionId, resultId),
  getVersion: () => ipcRenderer.invoke("mboo:app:version"),
  getRuntimeState: (): Promise<DesktopRuntimeState> => ipcRenderer.invoke("mboo:runtime:get"),
  getDiagnostics: (): Promise<DesktopDiagnostics> => ipcRenderer.invoke("mboo:diagnostics:get")
};

contextBridge.exposeInMainWorld("mbooDesktop", desktopBridge);
