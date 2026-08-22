import type { DesktopBridge } from "../shared/contracts.js";

declare global {
  interface Window {
    mbooDesktop?: DesktopBridge;
  }
}

export {};
