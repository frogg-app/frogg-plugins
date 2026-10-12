// Coalesces bursts of updates per key (an agent's status message, a turn's progress message)
// into at most one Discord edit per `delayMs`, and never more than `maxWaitMs` late. One run per
// key is in flight at a time; a schedule during a run queues exactly one follow-up.

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface DebouncerOptions<K> {
  delayMs: number;
  maxWaitMs: number;
  run: (key: K) => Promise<void>;
  onError?: (key: K, err: unknown) => void;
  timers?: Timers;
}

interface Slot {
  timer: unknown;
  firstScheduledAt: number;
  running: boolean;
  again: boolean;
}

export class KeyedDebouncer<K> {
  private readonly slots = new Map<K, Slot>();
  private stopped = false;

  private readonly opts: DebouncerOptions<K>;

  constructor(opts: DebouncerOptions<K>) {
    this.opts = opts;
  }

  private get timers(): Timers {
    return this.opts.timers ?? realTimers;
  }

  schedule(key: K): void {
    if (this.stopped) return;
    const now = this.timers.now();
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { timer: null, firstScheduledAt: now, running: false, again: false };
      this.slots.set(key, slot);
    }
    if (slot.running) {
      slot.again = true;
      return;
    }
    if (slot.timer === null) slot.firstScheduledAt = now;
    else this.timers.clearTimeout(slot.timer);
    const deadline = slot.firstScheduledAt + this.opts.maxWaitMs;
    const wait = Math.max(0, Math.min(this.opts.delayMs, deadline - now));
    slot.timer = this.timers.setTimeout(() => void this.fire(key), wait);
  }

  /** Runs now if anything is pending for `key`, and waits for it. */
  async flush(key: K): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot || slot.timer === null) return;
    this.timers.clearTimeout(slot.timer);
    await this.fire(key);
  }

  pending(key: K): boolean {
    const slot = this.slots.get(key);
    return !!slot && (slot.timer !== null || slot.running);
  }

  stop(): void {
    this.stopped = true;
    for (const slot of this.slots.values()) {
      if (slot.timer !== null) this.timers.clearTimeout(slot.timer);
    }
    this.slots.clear();
  }

  private async fire(key: K): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot || this.stopped) return;
    slot.timer = null;
    slot.running = true;
    try {
      await this.opts.run(key);
    } catch (err) {
      this.opts.onError?.(key, err);
    } finally {
      slot.running = false;
      if (slot.again && !this.stopped) {
        slot.again = false;
        this.schedule(key);
      } else if (slot.timer === null) {
        this.slots.delete(key);
      }
    }
  }
}
