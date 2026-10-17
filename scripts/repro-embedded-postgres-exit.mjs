#!/usr/bin/env node
/**
 * Repro for the packaged desktop shutdown error (issue #869):
 * `TypeError: done is not a function` from `embedded-postgres/dist/index.js`.
 *
 * The library registers `gracefulShutdown(done)` with `async-exit-hook` when
 * the module is loaded. For the `exit` event — the one `process.exit()` (and
 * Electron's quit) fires — `async-exit-hook` runs hooks with NO arguments
 * (it cannot: the event loop is dead), so `done` is `undefined`, and the
 * `done()` the shutdown function calls last throws. The desktop backend stops
 * PostgreSQL itself on quit, so main's `releaseEmbeddedPostgresExitHook`
 * (electron/embedded-postgres-exit.js) removes exactly that one hook.
 *
 * This script proves all three halves in one run, no PostgreSQL binary needed:
 *   1. baseline — load the library and fire the exit event: the hook's
 *      `done()` rejects (the defect is in the shipped dependency, not in
 *      this codebase);
 *   2. fixed — load the library, release the exit hook the way
 *      backend-manager does, and fire the exit event: no rejection, exit
 *      code 0;
 *   3. patched — copy the installed module, apply
 *      electron/scripts/patch-embedded-postgres-exit-hook.js the way the
 *      packaged build does, leave the exit hook registered, and fire the exit
 *      event: no rejection. This is the issue #985 guarantee that does not
 *      depend on which module instance registered the hook.
 *
 *   node scripts/repro-embedded-postgres-exit.mjs
 *
 * Exits non-zero when any half misbehaves. The vitest suite
 * (src/electron-embedded-postgres-shutdown.test.ts) runs the same scenarios
 * as regression coverage, so a dependency upgrade that re-introduces the hook
 * — or a backend-manager change that stops releasing it — fails CI.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The child programs. `--eval` + `--input-type=module` keeps the repro
 * self-contained; the child's CWD is the repo root, so the bare
 * `embedded-postgres` import resolves against this checkout's node_modules —
 * the same module instance `electron/embedded-postgres-exit.js` will unhook.
 *
 * Both children fire the `exit` event exactly as `process.exit()` does —
 * node emits it on the way out, and `async-exit-hook` runs the library's
 * handler with NO arguments for it. The rejection the handler's `done()`
 * produces is captured on `unhandledRejection` (the same event node's default
 * handler logs to the desktop app's console) instead of hoping the process
 * tears down after the microtask runs, so the repro is deterministic on every
 * node version and platform.
 */
export const CHILD_BASELINE = `
await import("embedded-postgres");
const errors = [];
process.on("unhandledRejection", (err) => errors.push(err && err.message ? err.message : String(err)));
process.emit("exit");
await new Promise((r) => setTimeout(r, 100));
console.log("ERRORS=" + JSON.stringify(errors));
process.exit(0);
`;

export const CHILD_FIXED = `
import { pathToFileURL } from "node:url";
const root = process.env.REPRO_REPO_ROOT;
await import("embedded-postgres");
const module_ = await import(pathToFileURL(root + "/electron/embedded-postgres-exit.js").href);
const release = module_.releaseEmbeddedPostgresExitHook ?? module_.default?.releaseEmbeddedPostgresExitHook;
if (typeof release !== "function") {
  console.error("repro: releaseEmbeddedPostgresExitHook not found");
  process.exit(3);
}
const removed = release(root + "/node_modules/embedded-postgres/dist/index.js");
const errors = [];
process.on("unhandledRejection", (err) => errors.push(err && err.message ? err.message : String(err)));
process.emit("exit");
await new Promise((r) => setTimeout(r, 100));
console.log("REMOVED=" + String(removed) + " ERRORS=" + JSON.stringify(errors));
process.exit(0);
`;

/**
 * The packaged build's path: the dependency on disk is patched at
 * install/packaging time, and the exit hook is left registered. If the patch
 * is not applied, this child reproduces the same "done is not a function"
 * rejection the baseline does — which is exactly what must never ship.
 *
 * The copy lives under the repo's node_modules so its bare imports (`pg`,
 * `async-exit-hook`, `@embedded-postgres/<platform>`) resolve the same way the
 * installed original's do; it is removed before the child exits.
 */
export const CHILD_PATCHED = `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.env.REPRO_REPO_ROOT;
const scratch = fs.mkdtempSync(path.join(root, "node_modules", ".tmp-patched-embedded-postgres-"));
const target = path.join(scratch, "node_modules", "embedded-postgres");
try {
  fs.cpSync(path.join(root, "node_modules", "embedded-postgres"), target, { recursive: true });
  const patch = await import(pathToFileURL(root + "/electron/scripts/patch-embedded-postgres-exit-hook.js").href);
  const status = patch.patchEmbeddedPostgresExitHook(path.join(target, "dist", "index.js")).status;
  await import(pathToFileURL(path.join(target, "dist", "index.js")).href);
  const errors = [];
  process.on("unhandledRejection", (err) => errors.push(err && err.message ? err.message : String(err)));
  process.emit("exit");
  await new Promise((r) => setTimeout(r, 100));
  console.log("PATCH=" + status + " ERRORS=" + JSON.stringify(errors));
  process.exit(0);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
`;

export function runChild(code, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: REPO_ROOT,
      env: { ...process.env, REPRO_REPO_ROOT: REPO_ROOT, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (codeValue, signal) => resolve({ code: codeValue, signal, stdout, stderr }));
  });
}

const SIGNATURE = /done is not a function/i;

/** The ERRORS=[...] the child captured from unhandledRejection. */
function capturedErrors(stdout) {
  const match = stdout.match(/ERRORS=(\[.*\])/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function main() {
  console.log("scenario 1 — baseline (library exit hook left in place)");
  const baseline = await runChild(CHILD_BASELINE);
  const baselineErrors = capturedErrors(baseline.stdout);
  const baselineHasError = Boolean(baselineErrors?.some((message) => SIGNATURE.test(String(message))));
  console.log(baselineHasError ? "  ✓ reproduces: `done is not a function` on exit" : "  ✗ expected the TypeError among the captured rejections");
  if (!baselineHasError) console.log("    stdout was: " + JSON.stringify(baseline.stdout.slice(0, 400)));
  console.log(`    exit code ${baseline.code}`);

  console.log("scenario 2 — fixed (exit hook released, like backend-manager does)");
  const fixed = await runChild(CHILD_FIXED);
  const fixedErrors = capturedErrors(fixed.stdout);
  const fixedClean = fixed.code === 0 && Array.isArray(fixedErrors) && fixedErrors.length === 0;
  console.log(fixedClean ? "  ✓ clean exit, no rejection" : "  ✗ the fixed path still rejects");
  console.log("    removed=" + (fixed.stdout.match(/REMOVED=(\w+)/)?.[1] ?? "?") + ", exit code " + fixed.code);
  if (!fixedClean) console.log("    stdout was: " + JSON.stringify(fixed.stdout.slice(0, 400)));

  console.log("scenario 3 — patched (packaged dependency, exit hook left registered)");
  const patched = await runChild(CHILD_PATCHED);
  const patchedErrors = capturedErrors(patched.stdout);
  const patchedClean =
    patched.code === 0 && /PATCH=patched/.test(patched.stdout) && Array.isArray(patchedErrors) && patchedErrors.length === 0;
  console.log(patchedClean ? "  ✓ clean exit, no rejection, hook still registered" : "  ✗ the patched dependency still rejects");
  console.log("    patch status " + (patched.stdout.match(/PATCH=(\w+)/)?.[1] ?? "?") + ", exit code " + patched.code);
  if (!patchedClean) console.log("    stdout was: " + JSON.stringify(patched.stdout.slice(0, 400)));

  if (!baselineHasError || !fixedClean || !patchedClean) {
    console.error("\nrepro failed");
    process.exit(1);
  }
  console.log(
    "\nrepro consistent with issues #869/#985: defect in the dependency, removed by the released hook and made harmless by the packaged patch",
  );
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
