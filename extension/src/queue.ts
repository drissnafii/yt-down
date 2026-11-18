/** FIFO scheduling with bounded concurrency and exclusive access to output keys. */
export class TaskQueue<T> {
  private waiting: Array<{ value: T; key: string }> = [];
  private running = new Map<T, string>();
  private pumping = false;
  private stopped = false;

  constructor(private limit: number, private start: (value: T, done: () => void) => void) {}

  add(value: T, key: string): void {
    if (this.stopped) return;
    this.waiting.push({ value, key });
    this.pump();
  }

  remove(value: T): boolean {
    const index = this.waiting.findIndex(task => task.value === value);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  setLimit(limit: number): void { this.limit = Math.max(1, Math.min(3, limit)); this.pump(); }
  get active(): number { return this.running.size; }
  get queued(): number { return this.waiting.length; }
  stop(): void { this.stopped = true; this.waiting = []; }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.running.size < this.limit) {
        const keys = new Set(this.running.values());
        const index = this.waiting.findIndex(task => !keys.has(task.key));
        if (index < 0) break;
        const task = this.waiting.splice(index, 1)[0]!;
        this.running.set(task.value, task.key);
        let finished = false;
        this.start(task.value, () => {
          if (finished) return;
          finished = true;
          this.running.delete(task.value);
          this.pump();
        });
      }
    } finally { this.pumping = false; }
  }
}
