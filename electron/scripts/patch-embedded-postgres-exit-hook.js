#!/usr/bin/env node
"use strict";

/**
 * Makes `embedded-postgres`'s own exit hook safe, at install/packaging time
 * (issue #985).
 *
 * `embedded-postgres@16.14.0-beta.17` ends its `dist/index.js` with:
 *
 *     function gracefulShutdown(done) {
 *         return __awaiter(this, void 0, void 0, function* () {
 *             yield Promise.all([...instances].map((instance) => instance.stop()));
 *             // Let NodeJS know we're done
 *             done();
 *         });
 *     }
 *     AsyncExitHook(gracefulShutdown);
 *
 * `async-exit-hook@2.0.1` registers a process `exit` listener without an exit
 * code, and `exit` hooks are invoked with NO arguments — the event loop is
 * already gone, so the library's comment "Cannot perform async hooks in `exit`
 * event" is the whole story. `done` is `undefined`, `done()` throws, and because
 * `gracefulShutdown` is an async function the throw surfaces as an unhandled
 * rejection on every clean quit of the desktop app.
 *
 * The desktop shell already stops PostgreSQL deterministically on quit and
 * releases the hook it can see (`electron/embedded-postgres-exit.js`), but a
 * field report on a shipped build (issue #985) shows the hook can still run —
 * whether through a second module instance, a packaged-module resolution
 * difference, or a build that predates the release call. Removing the crash
 * from the dependency itself is the only fix that does not depend on which
 * copy of the module registered the hook, so this script rewrites that single
 * line to tolerate a missing callback:
 *
 *     if (typeof done === "function") done();
 *
 * That keeps the instances' `stop()` calls intact, keeps the other (async,
 * callback-bearing) hooks intact, and makes the bare `exit` path a no-op
 * instead of a rejection. The packaged copy of the dependency is patched by
 * `postinstall` and again by `predist` (npm runs it before `npm run dist`);
 * `verify-runtime.js` refuses to package an unpatched copy. The root
 * devDependency is deliberately left unpatched: `scripts/repro-embedded-postgres-exit.mjs`
 * and its vitest suite prove the library defect is real, and then prove the
 * helper + patch each remove it.
 *
 * The script fails loudly when the expected source shape is gone (a dependency
 * bump), so a silent no-op can never ship. It is idempotent, and `--check`
 * reports without writing.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MODULE = path.join(__dirname, "..", "node_modules", "embedded-postgres", "dist", "index.js");
const UNSAFE_CALL = /^([ \t]*)done\(\);[ \t]*$/gm;
const SAFE_CALL = 'if (typeof done === "function") done();';
const SAFE_CALL_PATTERN = /if \(typeof done === "function"\) done\(\);/;

class UnsupportedEmbeddedPostgresError extends Error {
  constructor(file, detail) {
    super(
      `embedded-postgres at ${file} no longer matches the shutdown patch for issue #985 (${detail}). ` +
        "Re-read its dist/index.js, decide whether the missing-callback defect still exists, and update " +
        "electron/scripts/patch-embedded-postgres-exit-hook.js instead of shipping an unverified build.",
    );
    this.name = "UnsupportedEmbeddedPostgresError";
    this.file = file;
  }
}

/** True when the file already tolerates the callback-less `exit` invocation. */
function isPatched(source) {
  return SAFE_CALL_PATTERN.test(source);
}

/**
 * Patch one `embedded-postgres/dist/index.js`. Returns
 * `{ status: "patched" | "already-patched", file }`; throws
 * `UnsupportedEmbeddedPostgresError` when the expected source is absent.
 *
 * Only the `done();` line inside `gracefulShutdown` is touched. The file must
 * contain exactly one bare `done();` statement, which the shipped build does;
 * a second one means the library changed shape and a blind replacement could
 * break something else.
 */
function patchEmbeddedPostgresExitHook(file = DEFAULT_MODULE) {
  const source = fs.readFileSync(file, "utf8");
  if (isPatched(source)) return { status: "already-patched", file };
  if (!/function gracefulShutdown\(done\)/.test(source) || !/AsyncExitHook\(gracefulShutdown\)/.test(source)) {
    throw new UnsupportedEmbeddedPostgresError(file, "gracefulShutdown/AsyncExitHook registration not found");
  }
  const calls = [...source.matchAll(UNSAFE_CALL)];
  if (calls.length !== 1) {
    throw new UnsupportedEmbeddedPostgresError(file, `expected exactly one bare done() call, found ${calls.length}`);
  }
  const indent = calls[0][1];
  const replacement = `${indent}// Issue #985: async-exit-hook invokes hooks on the bare \`exit\` event with no
${indent}// arguments, so \`done\` is undefined there. The stops above still run; the
${indent}// callback is only a signal, and calling it unconditionally rejected.
${indent}${SAFE_CALL}`;
  fs.writeFileSync(file, source.replace(UNSAFE_CALL, replacement));
  return { status: "patched", file };
}

function parseArguments(argv) {
  const options = { check: false, module: DEFAULT_MODULE };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--module") {
      const value = argv[index + 1];
      if (!value) throw new Error("--module needs a path to embedded-postgres/dist/index.js");
      options.module = path.resolve(value);
      index += 1;
    } else if (argument.startsWith("--module=")) options.module = path.resolve(argument.slice("--module=".length));
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!fs.existsSync(options.module)) {
    // A missing module is a packaging/installation error, not a pass: the
    // desktop cannot start without it, and an unverifiable patch is exactly
    // what issue #985 is about.
    console.error(`embedded-postgres is not installed at ${options.module}`);
    return 1;
  }
  if (options.check) {
    if (!isPatched(fs.readFileSync(options.module, "utf8"))) {
      console.error(
        `embedded-postgres at ${options.module} still calls done() unconditionally; ` +
          "run `node scripts/patch-embedded-postgres-exit-hook.js` (issue #985)",
      );
      return 1;
    }
    console.log(`embedded-postgres exit hook is patched: ${options.module}`);
    return 0;
  }
  try {
    const result = patchEmbeddedPostgresExitHook(options.module);
    console.log(`${result.status}: ${result.file}`);
    return 0;
  } catch (error) {
    if (error instanceof UnsupportedEmbeddedPostgresError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  DEFAULT_MODULE,
  UnsupportedEmbeddedPostgresError,
  isPatched,
  main,
  patchEmbeddedPostgresExitHook,
};
