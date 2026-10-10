"use strict";

const { createRequire } = require("node:module");

/**
 * `embedded-postgres` registers its shutdown with `async-exit-hook` when it is
 * loaded: `AsyncExitHook(gracefulShutdown)`, where `gracefulShutdown(done)` stops
 * every instance and then calls `done()`. The library's `exit` hook is registered
 * without the async flag, so `gracefulShutdown` runs with no `done`. Stopping the
 * instances is async and cannot finish inside an `exit` listener, and `done()` then
 * fails with "done is not a function", which is the error the desktop build logs
 * on shutdown (issue #869 CI).
 *
 * The desktop backend stops PostgreSQL itself on quit (`backend.stop()`, which runs
 * `pg_ctl stop` and falls back to `instance.stop()`), so the `exit` hook adds nothing
 * that works. This removes that one hook and keeps the others: `beforeExit` (async,
 * with `done`), the signal hooks and the PM2 message hook still stop PostgreSQL.
 *
 * `entry` is the path of embedded-postgres' `dist/index.js`. The hook module must be
 * the same instance that module loaded, so it is resolved from that file. Returns
 * true when an `exit` hook was removed, false when there was none to remove.
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

module.exports = { releaseEmbeddedPostgresExitHook };
