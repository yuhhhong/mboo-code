export interface DesktopWorkspaceBridge {
  selectWorkspaceDirectory(): Promise<string | undefined>;
}

/**
 * 桌面环境优先使用受控 Preload 桥接；桥接存在时取消即是最终结果，不能误落到浏览器弹窗路径。
 */
export async function selectWorkspacePath(
  desktopBridge: DesktopWorkspaceBridge | undefined,
  selectInBrowser: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (desktopBridge) {
    return desktopBridge.selectWorkspaceDirectory();
  }
  return selectInBrowser();
}
