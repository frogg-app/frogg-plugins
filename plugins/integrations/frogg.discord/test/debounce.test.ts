import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyedDebouncer, type Timers } from "../src/debounce.ts";

class FakeTimers implements Timers {
  t = 0;
  private queue: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.nextId; this.queue.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(h: unknown) { this.queue = this.queue.filter((q) => q.id !== h); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    this.t = end;
  }
}

function setup(delayMs = 100, maxWaitMs = 300) {
  const timers = new FakeTimers();
  const runs: { key: string; at: number }[] = [];
  let hold: Promise<void> | null = null;
  const d = new KeyedDebouncer<string>({
    delayMs, maxWaitMs, timers,
    run: async (key) => { runs.push({ key, at: timers.t }); if (hold) await hold; },
  });
  return { d, timers, runs, setHold: (p: Promise<void> | null) => { hold = p; } };
}

test("coalesces a burst into one run after the quiet period", async () => {
  const { d, timers, runs } = setup();
  d.schedule("a"); await timers.advance(50);
  d.schedule("a"); await timers.advance(50);
  d.schedule("a"); await timers.advance(99);
  assert.equal(runs.length, 0);
  await timers.advance(1);
  assert.deepEqual(runs, [{ key: "a", at: 200 }]);
});

test("a steady stream still runs by maxWait", async () => {
  const { d, timers, runs } = setup(100, 300);
  for (let i = 0; i < 10; i++) { d.schedule("a"); await timers.advance(60); }
  assert.ok(runs.length >= 1);
  assert.equal(runs[0]!.at, 300);
});

test("keys are independent", async () => {
  const { d, timers, runs } = setup();
  d.schedule("a"); d.schedule("b");
  await timers.advance(100);
  assert.deepEqual(runs.map((r) => r.key).sort(), ["a", "b"]);
});

test("a schedule during a run queues exactly one follow-up", async () => {
  const { d, timers, runs, setHold } = setup();
  let release!: () => void;
  setHold(new Promise<void>((r) => { release = r; }));
  d.schedule("a");
  await timers.advance(100);
  assert.equal(runs.length, 1);
  d.schedule("a"); d.schedule("a"); d.schedule("a");
  setHold(null);
  release();
  await new Promise((r) => setImmediate(r));
  await timers.advance(100);
  assert.equal(runs.length, 2);
  await timers.advance(1000);
  assert.equal(runs.length, 2);
});

test("flush runs pending work immediately; stop cancels it", async () => {
  const { d, timers, runs } = setup();
  d.schedule("a");
  await d.flush("a");
  assert.equal(runs.length, 1);
  d.schedule("b");
  d.stop();
  await timers.advance(1000);
  assert.equal(runs.length, 1);
});

test("errors are reported and don't wedge the key", async () => {
  const timers = new FakeTimers();
  const errors: unknown[] = [];
  let n = 0;
  const d = new KeyedDebouncer<string>({
    delayMs: 10, maxWaitMs: 10, timers,
    run: async () => { n++; if (n === 1) throw new Error("rate limited"); },
    onError: (_k, e) => errors.push(e),
  });
  d.schedule("a"); await timers.advance(10);
  d.schedule("a"); await timers.advance(10);
  assert.equal(n, 2);
  assert.equal(errors.length, 1);
  assert.equal(d.pending("a"), false);
});
