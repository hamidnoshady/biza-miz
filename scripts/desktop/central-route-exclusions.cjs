"use strict";

/**
 * Issue #1194 — remove the Central Superadmin console from a site runtime.
 *
 * A desktop install (Hybrid or Full Offline) is a **site**: `DEPLOYMENT_ROLE`
 * is compiled to `site`, and `src/middleware.ts` answers 404 for `/platform/*`
 * and `/api/platform/*`. That is the request-time boundary. This module adds
 * the physical one: the console's pages, its API routes and their client
 * chunks are deleted from the staged runtime, so even a process patched to
 * skip middleware has no platform route module to load.
 *
 * Deliberately narrow. Only the Next build outputs under the `platform`
 * segment are removed — never a shared library, a tenant route, or anything
 * reached by `src/app/(app)`, `src/app/api` outside `/api/platform`, the
 * setup/sync/activation routes, or the offline server. `removeCentralRoutes`
 * returns a report (paths, files, bytes, manifest entries) which
 * `scripts/build-desktop-runtime.mjs` writes into `runtime-build.json`, and
 * `assertNoCentralRoutes` re-walks the staged tree afterwards so a future Next
 * output-layout change fails the build instead of silently shipping the
 * console again.
 *
 * The fs is injectable so the exclusion can be tested against a temporary
 * fixture tree (`src/lib/desktop-central-exclusions.test.ts`) without running
 * a Next build.
 */

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

/**
 * Next output directories that belong exclusively to the Central console.
 * POSIX relative paths, matched from the runtime root.
 */
const CENTRAL_RUNTIME_DIRECTORIES = Object.freeze([
  // Server-rendered console pages and their RSC payloads.
  ".next/server/app/platform",
  // Console APIs (admin management, billing, backup control, platform MCP,
  // platform login/MFA). The site keeps `/api/setup/*`, `/api/local-activation/*`,
  // `/api/server-sync/*` client routes, `/api/auth/*` and everything else.
  ".next/server/app/api/platform",
  // Client chunks the console pages would load.
  ".next/static/chunks/app/platform",
  ".next/static/chunks/app/api/platform",
]);

/**
 * Plain-JSON route manifests that still advertise a removed route. Pruning
 * them is what makes a direct request to `/api/platform/...` resolve to an
 * ordinary "no such route" instead of a module-not-found error, without
 * touching any manifest an actual site route depends on.
 */
const CENTRAL_MANIFESTS = Object.freeze([
  {
    // { "/api/platform/auth/login": "./app/api/platform/auth/login/route.js" }
    // Next emits this under `distDir/server` (pages-manifest-plugin.js).
    files: [".next/server/app-paths-manifest.json"],
    isPlatformEntry: (key, value) => isPlatformPath(key) || isPlatformPath(value),
  },
  {
    // { pages: { "/platform/login": ["static/chunks/..."] } }
    // Emitted at `distDir/app-build-manifest.json`; the server copy is kept as
    // a candidate because a future Next release may move it.
    files: [".next/app-build-manifest.json", ".next/server/app-build-manifest.json"],
    isPlatformEntry: (key, value) => isPlatformPath(key) || (Array.isArray(value) && value.some(isPlatformPath)),
    nested: "pages",
  },
]);

const PLATFORM_PATH = /(?:^|\/)platform(?:\/|$)/;

function isPlatformPath(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replace(/\\/g, "/");
  // `.next/server/app/api/platform/...` and `/api/platform/...` both match;
  // `/dashboard/platform` (a tenant page) does not.
  return PLATFORM_PATH.test(normalized) && !/\/dashboard\//.test(normalized);
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
 * Delete the Central-only directories from `root` and prune them from the
 * route manifests. Idempotent: a runtime that already lacks them reports
 * zeroes rather than failing, so a re-run of the build script is safe.
 */
async function removeCentralRoutes(root, { fsImpl = fsp } = {}) {
  const removed = [];
  let filesRemoved = 0;
  let bytesRemoved = 0;

  for (const relative of CENTRAL_RUNTIME_DIRECTORIES) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!(await exists(absolute, fsImpl))) continue;
    const files = await filesIn(absolute, fsImpl);
    filesRemoved += files.length;
    bytesRemoved += files.reduce((total, file) => total + file.bytes, 0);
    await fsImpl.rm(absolute, { recursive: true, force: true });
    removed.push({ path: relative, files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) });
  }

  let manifestEntriesRemoved = 0;
  for (const manifest of CENTRAL_MANIFESTS) {
    for (const file of manifest.files) {
      const absolute = path.join(root, ...file.split("/"));
      if (!(await exists(absolute, fsImpl))) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fsImpl.readFile(absolute, "utf8"));
      } catch {
        // A manifest this gate cannot parse is not something to "fix" here:
        // assertNoCentralRoutes still fails the build if a platform route
        // module survived, which is the security-relevant half.
        continue;
      }
      const container = manifest.nested ? parsed?.[manifest.nested] : parsed;
      if (!container || typeof container !== "object") continue;
      let prunedForFile = 0;
      for (const [key, value] of Object.entries(container)) {
        if (!manifest.isPlatformEntry(key, value)) continue;
        delete container[key];
        prunedForFile += 1;
      }
      if (prunedForFile > 0) {
        manifestEntriesRemoved += prunedForFile;
        await fsImpl.writeFile(absolute, `${JSON.stringify(parsed)}\n`);
        removed.push({ path: file, manifestEntries: prunedForFile });
      }
    }
  }

  return { removed, filesRemoved, bytesRemoved, manifestEntriesRemoved };
}

/** Every remaining staged path that still belongs to the Central console. */
async function centralRouteSurvivors(root, { fsImpl = fsp } = {}) {
  const survivors = [];
  if (!(await exists(root, fsImpl))) return survivors;
  for (const relative of CENTRAL_RUNTIME_DIRECTORIES) {
    const absolute = path.join(root, ...relative.split("/"));
    if (!(await exists(absolute, fsImpl))) continue;
    const files = await filesIn(absolute, fsImpl);
    survivors.push(...files.map((file) => path.relative(root, file.path).replace(/\\/g, "/")));
  }
  // A directory can be gone while a manifest still advertises the route.
  for (const manifest of CENTRAL_MANIFESTS) {
    for (const file of manifest.files) {
      const absolute = path.join(root, ...file.split("/"));
      if (!(await exists(absolute, fsImpl))) continue;
      let parsed;
      try {
        parsed = JSON.parse(await fsImpl.readFile(absolute, "utf8"));
      } catch {
        continue;
      }
      const container = manifest.nested ? parsed?.[manifest.nested] : parsed;
      if (!container || typeof container !== "object") continue;
      for (const [key, value] of Object.entries(container)) {
        if (manifest.isPlatformEntry(key, value)) survivors.push(`${file}#${key}`);
      }
    }
  }
  return survivors;
}

/**
 * Throw when a Central route module survived staging. This is the check the
 * build script runs after `removeCentralRoutes`; a false negative here means
 * a signed installer contains the console.
 */
async function assertNoCentralRoutes(root, { fsImpl = fsp } = {}) {
  const survivors = await centralRouteSurvivors(root, { fsImpl });
  if (survivors.length) {
    throw new Error(
      `Central Superadmin routes survived desktop runtime staging (${survivors.length} file(s), e.g. ${survivors
        .slice(0, 5)
        .join(", ")}). The site runtime must not contain the platform console; see scripts/desktop/central-route-exclusions.cjs.`,
    );
  }
  return { survivors: 0 };
}

async function exists(target, fsImpl) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CENTRAL_RUNTIME_DIRECTORIES,
  CENTRAL_MANIFESTS,
  isPlatformPath,
  removeCentralRoutes,
  centralRouteSurvivors,
  assertNoCentralRoutes,
};
