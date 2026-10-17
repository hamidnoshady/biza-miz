/**
 * Quitting the desktop while the backend is still starting (issue #985).
 *
 * The field report for #985 includes quits during a running migration/sync and
 * a postmaster left behind. `main.js` handles `before-quit` by calling
 * `backend.stop()` immediately, even when `backend.start()` is still awaiting
 * initdb, migrations or server readiness. Before this contract, `stop()` could
 * finish first and `start()` would then bring PostgreSQL (or the application
 * server) up with nothing left to supervise it — the postmaster outlived the
 * app.
 *
 * `start()` now checks a stop request at every await point, stops a postmaster
 * it already started before aborting, and never spawns the server after a
 * stop. These tests drive that race with a stub Postgres so no real cluster is
 * needed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { BackendManager, BackendStoppedError } = require("../../electron/backend-manager.js") as {
  BackendManager: new (options: { app: unknown; logger: unknown }) => {
    pg: unknown;
    server: unknown;
    start: () => Promise<unknown>;
    stop: () => Promise<void>;
    resolveRuntimeDir: () => string;
    loadEmbeddedPostgres: () => Promise<unknown>;
    stopPostgresGracefully: (instance?: unknown) => Promise<void>;
    installExitGuard: (dataDir: string) => Promise<void>;
    startPostgresWithPgCtl: (dataDir: string, port: number) => Promise<void>;
  };
  BackendStoppedError: new () => Error & { stage: string };
};

const temporaryDirectories: string[] = [];

/** A userData layout whose config is already complete, so no port is probed. */
function createUserData(): string {
  const userData = mkdtempSync(path.join(os.tmpdir(), "desktop-backend-quit-"));
  temporaryDirectories.push(userData);
  mkdirSync(path.join(userData, "Configuration"), { recursive: true });
  mkdirSync(path.join(userData, "Data"), { recursive: true });
  mkdirSync(path.join(userData, "Logs"), { recursive: true });
  writeFileSync(
    path.join(userData, "Configuration", "config.json"),
    JSON.stringify({
      pgPassword: "pg-password",
      jwtSecret: "jwt-secret",
      masterKey: "master-key",
      instanceId: "instance-under-test",
      pgPort: 5599,
      appPort: 3099,
      gatewayPort: 8443,
      gateway: { enabled: false, selectedAddress: null },
    }),
  );
  const runtime = path.join(userData, "runtime");
  mkdirSync(path.join(runtime, "bin"), { recursive: true });
  writeFileSync(path.join(runtime, "bin", "server.cjs"), "");
  return userData;
}

function createLogger(logs: string[]) {
  const record = (message: string) => logs.push(message);
  return { dir: undefined as string | undefined, info: record, warn: record, error: record, childOutput: record };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("BackendManager quitting while it is still starting", () => {
  function createBackend(userData: string, logs: string[]) {
    const backend = new BackendManager({
      app: {
        isPackaged: false,
        getPath: () => userData,
        getVersion: () => "1.0.64-test",
      },
      logger: createLogger(logs),
    });
    backend.resolveRuntimeDir = () => path.join(userData, "runtime");
    return backend;
  }

  it("stops a postmaster this start had just brought up and reports a cancellation, not a startup failure", async () => {
    const userData = createUserData();
    const logs: string[] = [];
    const backend = createBackend(userData, logs);

    let startEnteredStart = false;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let constructed = 0;
    let stoppedInstances = 0;

    class StubEmbeddedPostgres {
      constructor() {
        constructed += 1;
      }
      async initialise() {}
      async start() {
        startEnteredStart = true;
        await startGate;
      }
      async stop() {
        stoppedInstances += 1;
      }
      getPgClient() {
        throw new Error("the test never gets past the cancelled start");
      }
    }

    let guardInstalled = 0;
    const gracefulStops: unknown[] = [];
    backend.installExitGuard = async () => { guardInstalled += 1; };
    backend.loadEmbeddedPostgres = async () => StubEmbeddedPostgres;
    // Both strategies are stubbed so the race is identical on Windows and Linux.
    backend.startPostgresWithPgCtl = async () => {
      startEnteredStart = true;
      await startGate;
    };
    const instance = backend as unknown as { pg: { start?: () => Promise<void> } | null };
    backend.stopPostgresGracefully = async (target?: unknown) => {
      gracefulStops.push(target ?? instance.pg);
      if (target) await (target as { stop: () => Promise<void> }).stop();
      instance.pg = null;
    };

    const startResult = backend.start().catch((error: unknown) => error);
    await until(() => startEnteredStart);
    // The quit lands while the postmaster is coming up.
    const stop = backend.stop();
    releaseStart();

    const error = await startResult;
    await stop;

    expect(error).toBeInstanceOf(BackendStoppedError);
    expect((error as Error).name).toBe("BackendStoppedError");
    expect((error as Error & { stage: string }).stage).toBe("stopped");
    expect(guardInstalled).toBe(1);
    expect(constructed).toBe(1);
    // stop() stopped what was running, and start() stopped the instance it
    // created before aborting — the postmaster cannot be left behind.
    expect(gracefulStops.length).toBeGreaterThanOrEqual(1);
    expect(stoppedInstances).toBeGreaterThanOrEqual(1);
    expect(instance.pg).toBeNull();
  });

  it("aborts before PostgreSQL starts when the quit wins the race", async () => {
    const userData = createUserData();
    const logs: string[] = [];
    const backend = createBackend(userData, logs);

    let constructed = 0;
    class StubEmbeddedPostgres {
      constructor() {
        constructed += 1;
      }
      async initialise() {}
      async start() {
        throw new Error("start() must not be reached after a stop");
      }
      async stop() {}
      getPgClient() {
        throw new Error("unreachable");
      }
    }
    backend.installExitGuard = async () => {};
    backend.loadEmbeddedPostgres = async () => StubEmbeddedPostgres;
    backend.startPostgresWithPgCtl = async () => {
      throw new Error("pg_ctl start must not be reached after a stop");
    };

    const startResult = backend.start().catch((error: unknown) => error);
    await backend.stop();
    const error = await startResult;

    expect(error).toBeInstanceOf(BackendStoppedError);
    expect(constructed).toBe(0);
    expect(backend.pg).toBeNull();
    // No unsupervised application server either.
    expect(backend.server).toBeNull();
  });

  it("is idempotent: a second stop joins the first instead of racing it", async () => {
    const userData = createUserData();
    const logs: string[] = [];
    const backend = createBackend(userData, logs);
    backend.installExitGuard = async () => {};
    let gracefulStops = 0;
    backend.stopPostgresGracefully = async () => { gracefulStops += 1; };

    await Promise.all([backend.stop(), backend.stop(), backend.stop()]);

    expect(gracefulStops).toBe(1);
  });
});
