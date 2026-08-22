export const revealTargets = ["workspace", "appData", "toolResult"] as const;
export type RevealTarget = (typeof revealTargets)[number];

export interface DesktopRuntimeState {
  mode: "initializing" | "ready" | "failed";
  version: string;
}

export interface DesktopDiagnostics {
  phase: string;
  message: string;
  logPath?: string;
  attempt?: number;
  ports?: { javaPort: number; nextPort: number };
  runtime?: { electronVersion: string; nodeVersion: string; javaRuntime: string };
  copyText?: string;
}

export interface DesktopBridge {
  selectWorkspaceDirectory(): Promise<string | undefined>;
  revealPath(target: RevealTarget): Promise<boolean>;
  revealToolResult(sessionId: string, resultId: string): Promise<boolean>;
  getVersion(): Promise<string>;
  getRuntimeState(): Promise<DesktopRuntimeState>;
  getDiagnostics(): Promise<DesktopDiagnostics>;
}

export function isRevealTarget(value: unknown): value is RevealTarget {
  return typeof value === "string" && revealTargets.includes(value as RevealTarget);
}
