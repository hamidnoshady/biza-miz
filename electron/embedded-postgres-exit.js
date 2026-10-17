"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");

/**
 * Two independent protections around `embedded-postgres`'s shutdown hook
 * (issues #869 and #985).
 *
 * 1. `releaseEmbeddedPostgresExitHook` — remove the hook the library registers
 *    for the bare `exit` event.
 *
 *    The library registers `AsyncExitHook(gracefulShutdown)` when it loads,
 *    where `gracefulShutdown(done)` stops every instance and then calls
 *    `done()`. `async-exit-hook` registers the `exit` event without an exit
 *    code, so `exit === false`, and it always takes the synchronous branch:
 *    `hook()` with no arguments. `done` is `undefined` and `done()` rejects.
 *    Stopping the instances is asynchronous and can never complete inside an
 *    `exit` listener, so that hook cannot work by construction.
 *
 *    The desktop backend stops PostgreSQL itself on quit (`backend.stop()`,
 *    which runs `pg_ctl stop` and falls back to `instance.stop()`), so the hook
 *    adds nothing that works. Removing it also keeps the process from waiting
 *    on async-exit-hook's 10-second force-exit timer.
 *
 *    `entry` is the path of embedded-postgres' `dist/index.js`. The hook module
 *    must be the same instance that module loaded, so it is resolved from that
 *    file. Returns true when an `exit` hook was removed, false when there was
 *    none to remove.
 *
 * 2. `installPostmasterExitGuard` — a last-resort, *synchronous* stop at
 *    process exit.
 *
 *    The issue's field evidence includes a quit that left the postmaster
 *    behind. Asynchronous shutdown cannot be trusted at `exit` time, and a
 *    quit can land while the backend is still starting (between PostgreSQL
 *    coming up and the application server being supervised). This installs a
 *    `pg_ctl stop` that runs synchronously, only when `postmaster.pid` says a
 *    cluster for our data directory is still up. It is a no-op after a clean
 *    shutdown, so it cannot delay a normal quit.
 */

/**
 * @param {string} entry path of embedded-postgres' `dist/index.js`
 * @returns {boolean} true when an `exit` hook was removed
 */
function releaseEmbeddedPostgresExitHook(entry) {
  const requireFrom = createRequire(entry);
  const asyncExitHook = requireFrom("async-exit-hook");
  if (typeof asyncExitHook.hookedEvents !== "function" || typeof asyncExitHook.unhookEvent !== "function") {
    return false;
  }
  if (!asyncExitHook.hookedEvents().includes("exit")) return false;
  asyncExitHook.unhookEvent("exit");
  return true;
}

/**
 * Whether a cluster for `dataDir` is still running, by PostgreSQL's own marker.
 *
 * @param {string} dataDir
 * @param {{ existsSync?: (file: string) => boolean }} [options]
 * @returns {boolean}
 */
function postmasterIsRunning(dataDir, { existsSync = fs.existsSync } = {}) {
  return typeof dataDir === "string" && dataDir.length > 0 && existsSync(path.join(dataDir, "postmaster.pid"));
}

/**
 * Blocking `pg_ctl stop` for the `exit` event. `spawnSync` is intentional: at
 * `exit` time nothing can await a promise, and this is the last chance to keep
 * a postmaster from outliving the app. `pg_ctl stop -D` acts only on the
 * postmaster that owns this data directory, so a stale `postmaster.pid` from a
 * crash fails fast instead of touching another cluster.
 *
 * Injectable `spawnSync`/`existsSync` and an optional `timeoutSeconds` keep the
 * decision logic testable without a real PostgreSQL install.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.pgCtl]
 * @param {(file: string, args: string[], options?: object) => { status?: number | null, error?: Error }} [options.spawnSync]
 * @param {(file: string) => boolean} [options.existsSync]
 * @param {number} [options.timeoutSeconds]
 * @returns {{ stopped: boolean, reason: string, error?: Error }}
 */
function stopPostmasterSync({
  dataDir,
  pgCtl,
  spawnSync: spawn = spawnSync,
  existsSync = fs.existsSync,
  timeoutSeconds = 10,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof pgCtl !== "string" || !pgCtl) {
    return { stopped: false, reason: "unavailable" };
  }
  if (!postmasterIsRunning(dataDir, { existsSync })) return { stopped: false, reason: "not-running" };
  const wait = Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 10;
  let result;
  try {
    result = spawn(pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", String(wait)], {
      windowsHide: true,
      stdio: "ignore",
      // pg_ctl enforces the wait itself; the process-level cap is a backstop
      // for a pg_ctl that never returns.
      timeout: (wait + 5) * 1000,
    });
  } catch (error) {
    return { stopped: false, reason: "spawn-error", error };
  }
  if (result?.error) return { stopped: false, reason: "spawn-error", error: result.error };
  if (result?.status === 0) return { stopped: true, reason: "stopped" };
  return { stopped: false, reason: `pg_ctl-exit-${result?.status ?? "unknown"}` };
}

/**
 * Register the exit guard. Returns a disposer; the guard is also safe to leave
 * installed for the whole process lifetime because a clean `stop()` removes
 * `postmaster.pid` and turns every later invocation into a no-op.
 *
 * `logger` is optional and uses synchronous file logging (`logger.warn`), so it
 * is safe inside an `exit` listener. `emitter` is injectable for tests.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.pgCtl]
 * @param {(options: { dataDir: string, pgCtl: string }) => { stopped?: boolean, reason?: string }} [options.stopPostmaster]
 * @param {{ warn?: (message: string, details?: unknown) => void }} [options.logger]
 * @param {NodeJS.EventEmitter} [options.emitter]
 * @returns {() => void} disposer
 */
function installPostmasterExitGuard({
  dataDir,
  pgCtl,
  stopPostmaster = stopPostmasterSync,
  logger,
  emitter = process,
} = {}) {
  if (typeof dataDir !== "string" || !dataDir || typeof pgCtl !== "string" || !pgCtl) {
    return () => {};
  }
  let installed = true;
  const handler = () => {
    if (!installed) return;
    try {
      const outcome = stopPostmaster({ dataDir, pgCtl });
      if (outcome?.stopped) {
        logger?.warn?.("Stopped the PostgreSQL postmaster during process exit", { dataDir, reason: outcome.reason });
      }
    } catch (error) {
      // The guard must never turn a quit into a crash.
      logger?.warn?.("PostgreSQL postmaster exit guard failed", error);
    }
  };
  emitter.on("exit", handler);
  return function removePostmasterExitGuard() {
    if (!installed) return;
    installed = false;
    emitter.removeListener("exit", handler);
  };
}

module.exports = {
  installPostmasterExitGuard,
  postmasterIsRunning,
  releaseEmbeddedPostgresExitHook,
  stopPostmasterSync,
};
