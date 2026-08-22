type ShutdownTask = () => Promise<void> | void;

/**
 * 以逆序执行清理任务，保证后启动的依赖先停止，并避免多个 Electron 退出事件重复终止同一进程。
 */
export class ShutdownCoordinator {
  private readonly tasks: ShutdownTask[] = [];
  private shutdownPromise: Promise<void> | undefined;

  register(task: ShutdownTask): void {
    this.tasks.push(task);
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.run();
    return this.shutdownPromise;
  }

  private async run(): Promise<void> {
    for (const task of [...this.tasks].reverse()) {
      try {
        await task();
      } catch (error) {
        console.error("桌面端退出清理失败", error);
      }
    }
  }
}
