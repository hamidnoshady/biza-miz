import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncRunner } from "./sync-wake";

afterEach(() => vi.useRealTimers());

describe("createSyncRunner", () => {
  it("never overlaps runs, and runs once more when asked during one", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release: () => void = () => {};
    const tick = vi.fn(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      active -= 1;
    });
    const runner = createSyncRunner(tick);
    const first = runner.run();
    void runner.run();
    void runner.run();
    release();
    await first;
    expect(maxActive).toBe(1);
    // The two requests made during the first run collapse into one more.
    expect(calls).toBe(2);
  });

  it("debounces a burst of wake-ups into one run", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {});
    const runner = createSyncRunner(tick);
    runner.kick(1000);
    runner.kick(1000);
    runner.kick(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("keeps running after a failed tick and reports it", async () => {
    const onError = vi.fn();
    const runner = createSyncRunner(async () => {
      throw new Error("boom");
    }, onError);
    await runner.run();
    await runner.run();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
