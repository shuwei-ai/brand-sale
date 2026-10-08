/**
 * 令牌信号量：M14 只控制「模型并发」，数据源限流是 M10 的职责。
 * 这是 LLD §7.3 集成用例「限流不打架」的落点——两处各自只管自己那一层。
 */

export class Semaphore {
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }[] = [];

  constructor(private readonly permits: number, private readonly maxWaitMs = 10 * 60 * 1000) {}

  get available(): number {
    return this.permits - this.active;
  }

  get pending(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("aborted");
    if (this.active < this.permits) {
      this.active += 1;
      return this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.active += 1;
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve(this.release());
        },
        reject,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等待并发许可超时（${this.maxWaitMs}ms）`));
      }, this.maxWaitMs);
      waiter.timer.unref?.();
      signal?.addEventListener("abort", () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("aborted"));
      }, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.waiters.shift();
      next?.resolve();
    };
  }
}
