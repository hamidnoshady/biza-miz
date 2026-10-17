/**
 * The desktop's embedded PostgreSQL shutdown (issues #869 and #985).
 *
 * Loading `embedded-postgres` registers an `exit` hook through `async-exit-hook`
 * whose shutdown cannot run on the bare `exit` event: the library calls hooks
 * with no arguments there, so `done` is `undefined` and `done()` rejects with
 * "done is not a function". Two independent protections cover it:
 *
 *   1. `releaseEmbeddedPostgresExitHook` removes exactly that hook from the
 *      `async-exit-hook` instance the library registered with (issue #869).
 *   2. `electron/scripts/patch-embedded-postgres-exit-hook.js` rewrites the
 *      packaged dependency's compiled `gracefulShutdown` so a missing callback
 *      is tolerated (issue #985). The postinstall/predist hooks apply it, and
 *      verify-runtime refuses to package an unpatched copy — because issue #985
 *      reports the rejection from a shipped build that already had (1).
 *
 * The last guarantee tested here is the synchronous exit guard: a quit must
 * never leave a postmaster behind, including when no promise can run at exit.
 */
import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPostmasterExitGuard,
  releaseEmbeddedPostgresExitHook,
  stopPostmasterSync,
} from "../../electron/embedded-postgres-exit.js";

const require = createRequire(import.meta.url);
const { isPatched, patchEmbeddedPostgresExitHook, UnsupportedEmbeddedPostgresError } = require(
  "../../electron/scripts/patch-embedded-postgres-exit-hook.js",
) as {
  isPatched: (source: string) => boolean;
  patchEmbeddedPostgresExitHook: (file?: string) => { status: "patched" | "already-patched"; file: string };
  UnsupportedEmbeddedPostgresError: new (...args: never[]) => Error;
};

const ENTRY = path.join(process.cwd(), "node_modules", "embedded-postgres", "dist", "index.js");

describe("the embedded PostgreSQL exit hook", () => {
  it("is removed from exit, the same instance embedded-postgres registered with, and nothing else", async () => {
    await import("embedded-postgres");
    const hook = createRequire(ENTRY)("async-exit-hook") as {
      hookedEvents: () => string[];
    };
    expect(hook.hookedEvents()).toContain("exit");
    const exitListeners = process.listenerCount("exit");

    expect(releaseEmbeddedPostgresExitHook(ENTRY)).toBe(true);

    expect(hook.hookedEvents()).not.toContain("exit");
    expect(process.listenerCount("exit")).toBe(exitListeners - 1);
    // The async-capable hooks that really stop PostgreSQL stay registered.
    expect(hook.hookedEvents()).toEqual(expect.arrayContaining(["beforeExit", "SIGINT", "SIGTERM"]));
  });

  it("does nothing the second time, so loading the module again is harmless", async () => {
    await import("embedded-postgres");
    releaseEmbeddedPostgresExitHook(ENTRY);
    expect(releaseEmbeddedPostgresExitHook(ENTRY)).toBe(false);
  });
});

describe("the packaged dependency patch for issue #985", () => {
  const directories: string[] = [];

  function copyOfTheInstalledModule(): string {
    const directory = mkdtempSync(path.join(os.tmpdir(), "embedded-postgres-patch-"));
    directories.push(directory);
    const file = path.join(directory, "index.js");
    copyFileSync(ENTRY, file);
    return file;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("makes the exit callback optional, idempotently, without touching the hook registration", () => {
    const file = copyOfTheInstalledModule();
    expect(isPatched(readFileSync(file, "utf8"))).toBe(false);

    expect(patchEmbeddedPostgresExitHook(file)).toEqual({ status: "patched", file });

    const patched = readFileSync(file, "utf8");
    expect(patched).toContain('if (typeof done === "function") done();');
    expect(patched).not.toMatch(/^[ \t]*done\(\);[ \t]*$/m);
    // The instances still get stopped and the hook is still registered: this
    // patch only removes the crash, not the shutdown work.
    expect(patched).toContain("instance.stop()");
    expect(patched.match(/AsyncExitHook\(gracefulShutdown\)/g)).toHaveLength(1);
    expect(isPatched(patched)).toBe(true);

    expect(patchEmbeddedPostgresExitHook(file)).toEqual({ status: "already-patched", file });
    expect(readFileSync(file, "utf8")).toBe(patched);
  });

  it("refuses an unrecognised dependency instead of silently shipping an unpatched build", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "embedded-postgres-shape-"));
    directories.push(directory);
    const file = path.join(directory, "index.js");
    writeFileSync(file, "export default class EmbeddedPostgres {}\n");

    expect(() => patchEmbeddedPostgresExitHook(file)).toThrow(UnsupportedEmbeddedPostgresError);
    expect(readFileSync(file, "utf8")).toBe("export default class EmbeddedPostgres {}\n");
  });
});

describe("the postmaster exit guard", () => {
  it("runs pg_ctl stop only when postmaster.pid says this data directory still has a cluster", () => {
    const calls: string[][] = [];
    const spawnSync = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      return { status: 0 };
    };

    expect(stopPostmasterSync({ dataDir: "/data/pgdata", pgCtl: "/pg/pg_ctl", spawnSync, existsSync: () => false })).toEqual({
      stopped: false,
      reason: "not-running",
    });
    expect(calls).toEqual([]);

    expect(stopPostmasterSync({ dataDir: "/data/pgdata", pgCtl: "/pg/pg_ctl", spawnSync, existsSync: () => true })).toEqual({
      stopped: true,
      reason: "stopped",
    });
    expect(calls).toEqual([["/pg/pg_ctl", "stop", "-D", "/data/pgdata", "-m", "fast", "-w", "-t", "10"]]);
  });

  it("reports a failed pg_ctl and a spawn error instead of throwing at exit", () => {
    expect(
      stopPostmasterSync({
        dataDir: "/data/pgdata",
        pgCtl: "/pg/pg_ctl",
        existsSync: () => true,
        spawnSync: () => ({ status: 1 }),
      }),
    ).toEqual({ stopped: false, reason: "pg_ctl-exit-1" });

    const failure = new Error("ENOENT");
    expect(
      stopPostmasterSync({
        dataDir: "/data/pgdata",
        pgCtl: "/pg/pg_ctl",
        existsSync: () => true,
        spawnSync: () => ({ error: failure }),
      }),
    ).toEqual({ stopped: false, reason: "spawn-error", error: failure });
  });

  it("is installed on exit and disarmed by its disposer", () => {
    const emitter = new EventEmitter();
    const seen: unknown[] = [];
    const remove = installPostmasterExitGuard({
      dataDir: "/data/pgdata",
      pgCtl: "/pg/pg_ctl",
      emitter,
      stopPostmaster: (options: unknown) => {
        seen.push(options);
        return { stopped: false, reason: "not-running" };
      },
    });

    emitter.emit("exit");
    expect(seen).toEqual([{ dataDir: "/data/pgdata", pgCtl: "/pg/pg_ctl" }]);

    remove();
    emitter.emit("exit");
    expect(seen).toHaveLength(1);
    expect(emitter.listenerCount("exit")).toBe(0);
  });

  it("registers nothing when no pg_ctl path is available, so a dev/test process is untouched", () => {
    const emitter = new EventEmitter();
    const remove = installPostmasterExitGuard({ dataDir: "/data/pgdata", pgCtl: "", emitter });
    expect(emitter.listenerCount("exit")).toBe(0);
    expect(() => remove()).not.toThrow();
  });

  it("swallows a guard failure: a quit must never crash on cleanup", () => {
    const emitter = new EventEmitter();
    const warnings: unknown[] = [];
    const logger = { warn: (message: string, details: unknown) => warnings.push([message, details]) };
    installPostmasterExitGuard({
      dataDir: "/data/pgdata",
      pgCtl: "/pg/pg_ctl",
      emitter,
      logger,
      stopPostmaster: () => {
        throw new Error("pg_ctl exploded");
      },
    });

    expect(() => emitter.emit("exit")).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain("exit guard failed");
  });
});

describe("the desktop main process's local modules are all packaged", () => {
  // A module electron-builder leaves out fails at launch with a dialog and no log,
  // so every ./module any main-process file requires must be in `build.files`.
  it("lists every ./module the main-process files require in electron/package.json's build files", async () => {
    const fs = await import("node:fs");
    const dir = path.join(process.cwd(), "electron");
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      build: { files: string[] };
    };
    const packaged = pkg.build.files.filter((file) => file.endsWith(".js"));
    const required = new Set<string>();
    for (const file of packaged) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const match of source.matchAll(/require\("\.\/([^"]+)"\)/g)) {
        required.add(path.extname(match[1]) ? match[1] : `${match[1]}.js`);
      }
    }
    expect(required.size).toBeGreaterThan(0);
    const missing = [...required].filter((file) => file !== "package.json" && !pkg.build.files.includes(file));
    expect(missing, "modules the packaged desktop loads but electron-builder would leave out").toEqual([]);
  });
});
