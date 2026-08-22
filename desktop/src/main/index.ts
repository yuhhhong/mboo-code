import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ShutdownCoordinator } from "./shutdown-coordinator.js";
import { createDiagnosticsDataUrl, createWindowSecurityOptions, isAllowedNavigation } from "./window-security.js";
import { isRevealTarget, type DesktopDiagnostics, type DesktopRuntimeState } from "../shared/contracts.js";
import { DesktopServiceStartError, startDesktopServices } from "./desktop-service-manager.js";
import { normalizeSelectedWorkspaceDirectory } from "./workspace-picker.js";
import { resolveRevealDirectory, resolveToolResultFile } from "./reveal-path.js";
import { runLegacyImportFlow } from "./legacy-import-flow.js";
import { resolveDesktopAppDataDirectory } from "./app-data-directory.js";
import type { BusinessDataType } from "./data-directory-inspection.js";
import type { DesktopServiceRuntime } from "./startup-coordinator.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(currentDirectory, "../preload/index.js");
const shutdownCoordinator = new ShutdownCoordinator();
let mainWindow: BrowserWindow | undefined;
let isQuitting = false;
let currentDesktopUrl: string | undefined;
let confirmedWorkspaceDirectory: string | undefined;
let activeServices: DesktopServiceRuntime | undefined;
let isManualImportRunning = false;
const runtimeState: DesktopRuntimeState = { mode: "initializing", version: app.getVersion() };
const diagnostics: DesktopDiagnostics = { phase: "initializing", message: "桌面服务正在初始化" };

function registerBridgeHandlers(): void {
  ipcMain.handle("mboo:workspace:select-directory", async () => {
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return undefined;
    confirmedWorkspaceDirectory = normalizeSelectedWorkspaceDirectory(result.filePaths[0], process.platform as "win32" | "darwin");
    return confirmedWorkspaceDirectory;
  });
  ipcMain.handle("mboo:path:reveal", async (_event, target: unknown) => {
    if (!isRevealTarget(target)) return false;
    const targetPath = resolveRevealDirectory(target, getDesktopAppDataDirectory(), confirmedWorkspaceDirectory);
    return targetPath ? (await shell.openPath(targetPath)) === "" : false;
  });
  ipcMain.handle("mboo:tool-result:reveal", async (_event, sessionId: unknown, resultId: unknown) => {
    if (typeof sessionId !== "string" || typeof resultId !== "string") return false;
    const resultPath = await resolveToolResultFile(getDesktopAppDataDirectory(), sessionId, resultId);
    if (!resultPath) return false;
    shell.showItemInFolder(resultPath);
    return true;
  });
  ipcMain.handle("mboo:app:version", () => app.getVersion());
  ipcMain.handle("mboo:runtime:get", () => runtimeState);
  ipcMain.handle("mboo:diagnostics:get", () => diagnostics);
}

function getDesktopAppDataDirectory(): string {
  return resolveDesktopAppDataDirectory(app.getPath("home"));
}

/**
 * 只由主进程创建窗口并集中处理导航策略，避免渲染进程取得系统权限或离开本地应用页面后继续使用桥接能力。
 */
function createMainWindow(localUrl?: string): BrowserWindow {
  const window = new BrowserWindow(createWindowSecurityOptions(preloadPath));

  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (localUrl && isAllowedNavigation(targetUrl, localUrl)) return;
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  if (localUrl) {
    void window.loadURL(localUrl);
  } else {
    void window.loadURL(createDiagnosticsDataUrl(diagnostics));
    window.show();
  }
  return window;
}

/**
 * 开发模式保留显式前端地址，生产模式仅在两个 sidecar 经健康检查确认后才加载窗口，避免连接残留端口或展示无限错误页。
 */
async function initializeDesktop(): Promise<void> {
  if (currentDesktopUrl) {
    mainWindow = createMainWindow(currentDesktopUrl);
    return;
  }
  const developmentUrl = process.env.MBOO_DESKTOP_URL;
  if (developmentUrl) {
    currentDesktopUrl = developmentUrl;
    runtimeState.mode = "ready";
    diagnostics.phase = "development";
    diagnostics.message = "已连接开发前端服务";
    mainWindow = createMainWindow(currentDesktopUrl);
    return;
  }

  try {
    await runLegacyImportFlow(
      getDesktopAppDataDirectory(),
      path.join(app.getPath("home"), ".mboo"),
      requestLegacyImportDecision,
    );
    await startProductionServices();
    mainWindow = createMainWindow(currentDesktopUrl);
  } catch (error) {
    runtimeState.mode = "failed";
    if (error instanceof DesktopServiceStartError) {
      Object.assign(diagnostics, error.diagnostics);
    } else {
      diagnostics.phase = "startup-failed";
      diagnostics.message = error instanceof Error ? error.message : "桌面服务启动失败";
    }
    mainWindow = createMainWindow();
  }
}

/**
 * 将生产 sidecar 的运行态集中登记，确保手动导入和应用退出始终作用于同一组已验证的子进程。
 */
async function startProductionServices(): Promise<void> {
  const result = await startDesktopServices({
    resourcesDirectory: process.resourcesPath,
    userDataDirectory: app.getPath("userData"),
    appDataDirectory: getDesktopAppDataDirectory(),
    platform: process.platform,
    architecture: process.arch,
  });
  const { runtime: services, diagnostics: serviceDiagnostics } = result;
  activeServices = services;
  shutdownCoordinator.register(() => services.javaProcess.stop());
  shutdownCoordinator.register(() => services.nextProcess.stop());
  runtimeState.mode = "ready";
  Object.assign(diagnostics, serviceDiagnostics);
  currentDesktopUrl = `http://${services.ports.host}:${services.ports.nextPort}`;
}

async function stopActiveServices(): Promise<void> {
  const services = activeServices;
  activeServices = undefined;
  currentDesktopUrl = undefined;
  if (!services) return;
  await services.nextProcess.stop();
  await services.javaProcess.stop();
}

/**
 * 手动导入先停止当前服务，以免 SQLite 与 JSONL 在复制时被写入；失败后重新启动原目录对应的服务。
 */
async function importLegacyDataManually(): Promise<void> {
  if (isManualImportRunning || process.env.MBOO_DESKTOP_URL || isUsingLegacyDataDirectory()) return;
  isManualImportRunning = true;
  runtimeState.mode = "initializing";

  try {
    await stopActiveServices();
    await runLegacyImportFlow(
      getDesktopAppDataDirectory(),
      path.join(app.getPath("home"), ".mboo"),
      (types) => requestLegacyImportDecision(types, true),
      { allowReplaceTarget: true },
    );
    await startProductionServices();
    if (mainWindow && currentDesktopUrl) await mainWindow.loadURL(currentDesktopUrl);
  } catch (error) {
    diagnostics.phase = "manual-import-failed";
    diagnostics.message = error instanceof Error ? error.message : "手动导入失败";
    try {
      await startProductionServices();
      if (mainWindow && currentDesktopUrl) await mainWindow.loadURL(currentDesktopUrl);
    } catch (restartError) {
      runtimeState.mode = "failed";
      diagnostics.phase = "manual-import-restart-failed";
      diagnostics.message = restartError instanceof Error ? restartError.message : "导入失败后无法恢复服务";
    }
  } finally {
    isManualImportRunning = false;
  }
}

function isUsingLegacyDataDirectory(): boolean {
  return path.resolve(getDesktopAppDataDirectory()) === path.resolve(path.join(app.getPath("home"), ".mboo"));
}

/**
 * 通过一次明确选择取得旧数据导入授权；不默认导入，避免首次安装时静默移动或复制用户历史会话。
 */
async function requestLegacyImportDecision(types: BusinessDataType[], replaceTarget = false): Promise<"import" | "skip"> {
  const labels: Record<BusinessDataType, string> = {
    sqlite: "SQLite 数据库",
    settings: "模型与设置",
    sessions: "会话事件",
    toolResults: "工具结果",
  };
  const result = await dialog.showMessageBox({
    type: "question",
    buttons: ["导入历史数据", "跳过"],
    defaultId: 0,
    cancelId: 1,
    message: replaceTarget ? "导入旧版数据将替换当前桌面数据" : "发现旧版 Mboo Code 数据",
    detail: replaceTarget
      ? `将以以下旧数据替换当前桌面数据：${types.map((type) => labels[type]).join("、")}。导入前已停止服务，失败会恢复当前数据。`
      : `将在启动前复制以下数据到桌面应用目录：${types.map((type) => labels[type]).join("、")}。原目录不会被修改。`,
  });
  return result.response === 0 ? "import" : "skip";
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    registerBridgeHandlers();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: "数据",
        submenu: [{ label: "导入旧版数据", click: () => void importLegacyDataManually() }],
      },
    ]));
    void initializeDesktop();
    app.on("activate", () => {
      if (!mainWindow && runtimeState.mode === "ready") void initializeDesktop();
    });
  });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();
    void shutdownCoordinator.shutdown().finally(() => app.quit());
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
