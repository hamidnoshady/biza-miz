/**
 * Issue #1001 — the local application server is supervised after startup.
 *
 * `server.ts` exits on a non-network uncaught exception by design, and nothing
 * watched the child after its readiness check, so the window stayed open
 * against a dead port. These cases pin the restart policy: exponential backoff,
 * one attempt loop at a time, a reset after a real recovery, a bounded number of
 * failures before the owner-facing dialog, and silence while quitting.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { ServerSupervisor, restartDelayMs } = require("../../electron/server-supervisor.js") as {
  restartDelayMs: (attempt: number) => number;
  ServerSupervisor: new (options: {
    restart: () => Promise<void>;
    onRecovered?: (info: { attempt: number }) => void;
    onExhausted?: (info: { attempts: number; lastError: Error | null }) => unknown;
    logger?: { warn?: (...args: unknown[]) => unknown; error?: (...args: unknown[]) => unknown; info?: (...args: unknown[]) => unknown };
    maxAttempts?: number;
    wait?: (ms: number) => Promise<void>;
    delayFor?: (attempt: number) => number;
  }) => {
    consecutiveFailures: number;
    notifyExit: (info?: Record<string, unknown>) => Promise<string>;
    attemptRestart: (info?: Record<string, unknown>) => Promise<boolean>;
    reset: () => void;
    cancel: () => void;
  };
};

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

describe("restartDelayMs", () => {
  it("backs off exponentially from one second and caps at thirty", () => {
    expect([1, 2, 3, 4, 5, 6].map(restartDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(restartDelayMs(9)).toBe(30_000);
    expect(restartDelayMs(0)).toBe(0);
  });
});

describe("ServerSupervisor", () => {
  it("restarts after the first backoff and reports recovery", async () => {
    const waits: number[] = [];
    const restart = vi.fn(async () => {});
    const onRecovered = vi.fn();
    const onExhausted = vi.fn();
    const supervisor = new ServerSupervisor({
      restart,
      onRecovered,
      onExhausted,
      logger: silentLogger,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(supervisor.notifyExit({ code: 1, signal: null })).resolves.toBe("recovered");
    expect(waits).toEqual([1_000]);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(onRecovered).toHaveBeenCalledWith({ attempt: 1 });
    expect(onExhausted).not.toHaveBeenCalled();
    // A later crash starts again from the first backoff.
    expect(supervisor.consecutiveFailures).toBe(0);
  });

  it("keeps trying with growing backoff and only then asks the owner", async () => {
    const waits: number[] = [];
    const restart = vi.fn(async () => {
      throw new Error("still down");
    });
    const onExhausted = vi.fn(async (_info: { attempts: number; lastError: Error | null }) => {});
    const supervisor = new ServerSupervisor({
      restart,
      onExhausted,
      logger: silentLogger,
      maxAttempts: 3,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(supervisor.notifyExit({ code: 1 })).resolves.toBe("exhausted");
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(restart).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0]).toMatchObject({ attempts: 3 });
    expect(onExhausted.mock.calls[0][0].lastError).toBeInstanceOf(Error);
  });

  it("recovers mid-loop without spending the rest of the budget", async () => {
    const restart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce(undefined);
    const supervisor = new ServerSupervisor({
      restart,
      logger: silentLogger,
      maxAttempts: 3,
      wait: async () => {},
    });

    await expect(supervisor.notifyExit({})).resolves.toBe("recovered");
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("ignores a second exit while an attempt loop is already running", async () => {
    let release: () => void = () => {};
    const restart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const supervisor = new ServerSupervisor({ restart, logger: silentLogger, wait: async () => {} });

    const first = supervisor.notifyExit({ code: 1 });
    // Wait for the loop to reach `restart()`.
    await Promise.resolve();
    await Promise.resolve();
    await expect(supervisor.notifyExit({ code: 1 })).resolves.toBe("ignored");
    release();
    await expect(first).resolves.toBe("recovered");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart while the app is quitting", async () => {
    const restart = vi.fn(async () => {});
    const onExhausted = vi.fn();
    const supervisor = new ServerSupervisor({ restart, onExhausted, logger: silentLogger, wait: async () => {} });
    supervisor.cancel();
    await expect(supervisor.notifyExit({ code: 0 })).resolves.toBe("ignored");
    expect(restart).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("gives the owner's manual retry a fresh budget without nesting callbacks", async () => {
    let healthy = false;
    const restart = vi.fn(async () => {
      if (!healthy) throw new Error("down");
    });
    const supervisor = new ServerSupervisor({
      restart,
      logger: silentLogger,
      maxAttempts: 1,
      wait: async () => {},
    });
    await expect(supervisor.notifyExit({})).resolves.toBe("exhausted");
    expect(supervisor.consecutiveFailures).toBe(1);

    // The recovery dialog calls attemptRestart() directly: it never invokes
    // onExhausted, so the dialog's own loop cannot recurse into itself.
    healthy = true;
    supervisor.reset();
    await expect(supervisor.attemptRestart({ reason: "owner_restart" })).resolves.toBe(true);
    expect(supervisor.consecutiveFailures).toBe(0);
  });
});
