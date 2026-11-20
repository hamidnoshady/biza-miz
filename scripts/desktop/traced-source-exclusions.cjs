"use strict";

/**
 * Issue #1194 — remove the original TypeScript Next's node-file-trace copies
 * into the standalone runtime.
 *
 * The desktop runtime executes compiled JavaScript: Next's server chunks for
 * the web app and `bin/server.cjs` for the custom server. A dynamic import
 * (`await import("./billing/entitlement/outbox-service")`) is compiled into a
 * chunk by Next, but the tracer can also copy the *source* file into
 * `standalone/src/...`. The copy is never loaded, and it is not a harmless
 * extra byte: it discloses the implementation of a Central-facing billing
 * entitlement client (`/api/platform/billing/entitlements/v1`) and its
 * credential column names inside a site installer.
 *
 * This module deletes our own traced `.ts`/`.tsx` copies under the staged
 * runtime's `src/` (font assets stay) and then asserts that no raw TypeScript
 * survives anywhere outside `node_modules`. The assertion scans the whole
 * runtime rather than only `src/`, so a future output-layout change fails the
 * build instead of silently shipping source again.
 *
 * The fs is injectable so the deletion can be tested against a temporary
 * fixture tree (`src/lib/desktop-traced-source.test.ts`) without running a
 * Next build.
 */

const fsp = require("node:fs/promises");
const path = require("node:path");

/** Source-file extensions that must never be executed or shipped raw. */
const RAW_TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/i;

/** Package manager trees legitimately contain declarations and source. */
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

async function exists(target, fsImpl) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function filesIn(directory, fsImpl) {
  const entries = [];
  async function walk(current) {
    const stats = await fsImpl.stat(current);
    if (stats.isFile()) {
      entries.push({ path: current, bytes: stats.size });
      return;
    }
    for (const entry of await fsImpl.readdir(current)) {
      await walk(path.join(current, entry));
    }
  }
  await walk(directory);
  return entries;
}

/**
 * Delete the raw TypeScript copies under `root/src`. Idempotent: a runtime
 * without them reports zeroes and succeeds.
 */
async function removeTracedSourceCopies(root, { fsImpl = fsp } = {}) {
  const sourceRoot = path.join(root, "src");
  if (!(await exists(sourceRoot, fsImpl))) {
    return { filesRemoved: 0, bytesRemoved: 0, removed: [] };
  }

  const removed = [];
  let filesRemoved = 0;
  let bytesRemoved = 0;
  for (const file of await filesIn(sourceRoot, fsImpl)) {
    const relative = path.relative(root, file.path).replace(/\\/g, "/");
    if (!RAW_TYPESCRIPT.test(relative)) continue;
    await fsImpl.unlink(file.path);
    filesRemoved += 1;
    bytesRemoved += file.bytes;
    removed.push({ path: relative, bytes: file.bytes });
  }

  return { filesRemoved, bytesRemoved, removed };
}

/** Every raw TypeScript file still present, ignoring `node_modules`. */
async function rawTypeScriptSurvivors(root, { fsImpl = fsp } = {}) {
  if (!(await exists(root, fsImpl))) return [];

  const survivors = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fsImpl.readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const absolute = path.join(current, entry);
      const stats = await fsImpl.stat(absolute);
      if (stats.isDirectory()) {
        await walk(absolute);
      } else if (RAW_TYPESCRIPT.test(entry)) {
        survivors.push(path.relative(root, absolute).replace(/\\/g, "/"));
      }
    }
  }
  await walk(root);
  return survivors;
}

/**
 * Throw when raw TypeScript survived staging. The build script runs this after
 * `removeTracedSourceCopies`; a failure means the payload would contain source
 * that no runtime path needs.
 */
async function assertNoRawTypeScript(root, { fsImpl = fsp } = {}) {
  const survivors = await rawTypeScriptSurvivors(root, { fsImpl });
  if (survivors.length) {
    throw new Error(
      `Raw TypeScript source survived desktop runtime staging (${survivors.length} file(s), e.g. ${survivors
        .slice(0, 5)
        .join(", ")}). The packaged runtime executes compiled chunks only; see scripts/desktop/traced-source-exclusions.cjs.`,
    );
  }
  return { survivors: 0 };
}

module.exports = {
  RAW_TYPESCRIPT,
  removeTracedSourceCopies,
  rawTypeScriptSurvivors,
  assertNoRawTypeScript,
};
