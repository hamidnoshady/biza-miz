"use strict";

/**
 * Local storage configuration for the desktop app — the audit fix for
 * Section 3 ("Local storage configuration wizard: let user choose
 * drive/folder for DB, attachments, images, reports, local backups, printer
 * config; provide Browse button, disk-space check, permission check, test
 * folder access").
 *
 * Before this module, the desktop app had exactly one folder an owner could
 * point anywhere: the backup destination (`src/app/setup/backup/page.tsx`,
 * saved through `/api/backup/config`). Everything else — the embedded
 * Postgres data directory, `config.json`, logs — was hard-coded to Electron's
 * `userData` path (`electron/backend-manager.js`'s `loadOrCreateConfig`) with
 * no visibility, no space check, and no way to move it to a bigger disk
 * before first run, which is exactly when it matters (an embedded Postgres
 * data directory, once initialised, is not something this app relocates
 * later without a full backup/restore).
 *
 * This module is the FIRST-RUN, pre-Postgres half of that fix: a plain
 * Node/Electron-side check of a folder BEFORE the app commits to it —
 * writable?, how much free space does its volume report?, does a real file
 * survive a write+read+delete round trip? — driving `main.js`'s native
 * `dialog`-based prompt (`runStorageBootstrap`/`promptForStorageLocation`),
 * which runs before the Next.js server (and therefore any renderer page)
 * exists — there is no `src/app/setup/storage` page; the whole flow is
 * native Electron dialogs. The same functions are also exposed over IPC
 * (`desktop:storage-*`, see main.js/preload.js's `window.businessSuiteDesktop
 * .localStorage`) for any renderer-side surface that wants to show the same
 * checks later (e.g. a "change storage location" action from within the
 * running app, post first-run). Every side-effecting piece takes injectable
 * collaborators (`fsp`, `platform`) so the decision logic here is
 * unit-testable without touching a real disk — see
 * src/lib/local-storage.test.ts.
 *
 * What this module deliberately does NOT do: move an already-initialised
 * Postgres data directory. Once `pgdata` exists, `backend-manager.js` always
 * reads `app.getPath("userData")`; relocating it is a distinct, higher-risk
 * feature (stop Postgres, move ~100+ files, verify, restart) that belongs
 * with the Section 10 restore/relocate wizard, not first-run folder choice.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** 1 GiB in bytes — comfortably above an empty embedded-Postgres data dir (tens of MB) but conservative for headroom. */
const RECOMMENDED_FREE_BYTES = 1024 * 1024 * 1024;
/** Below this, refuse outright — there isn't even room for Postgres to initialise. */
const MINIMUM_FREE_BYTES = 150 * 1024 * 1024;

const STORAGE_KINDS = /** @type {const} */ ([
  "database",
  "attachments",
  "images",
  "reports",
  "backups",
  "printerConfig",
]);

/**
 * Kilo/Mega/Giga-byte formatting for the Persian-RTL UI, in the vocabulary
 * the rest of the app already uses (`toPersianDigits` is applied client-side;
 * this returns plain ASCII numbers + a Latin unit, matching how the printing
 * client already reports byte counts).
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

/**
 * Every check runs against the closest existing ancestor of `targetPath` —
 * the folder itself very often does not exist yet (that's the whole point of
 * "choose where to create it"), but `fs.promises.statfs` requires a path
 * that exists. Returns null only if nothing on the path chain exists at all,
 * which cannot happen on a real filesystem (the root always exists).
 */
async function closestExistingAncestor(targetPath, fsp) {
  let current = path.resolve(targetPath);
  for (;;) {
    try {
      await fsp.stat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Disk-space check for a candidate folder. Reports free space on the volume
 * that would hold it (its closest existing ancestor) even if the folder
 * itself doesn't exist yet.
 */
async function checkDiskSpace(targetPath, opts = {}) {
  const fsp = opts.fsp || fs.promises;
  const ancestor = await closestExistingAncestor(targetPath, fsp);
  if (!ancestor) {
    return { ok: false, error: "path_not_found", detail: `No existing ancestor for ${targetPath}.` };
  }
  try {
    const stats = await fsp.statfs(ancestor);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    return {
      ok: true,
      freeBytes,
      totalBytes,
      freeLabel: formatBytes(freeBytes),
      totalLabel: formatBytes(totalBytes),
      sufficient: freeBytes >= MINIMUM_FREE_BYTES,
      recommended: freeBytes >= RECOMMENDED_FREE_BYTES,
      checkedPath: ancestor,
    };
  } catch (error) {
    // statfs is unsupported on a handful of virtual/network filesystems and
    // some very old Windows builds; the folder is still usable, we just
    // cannot report a number. The permission/write-test check below is the
    // one that actually gates whether the folder is usable.
    return { ok: false, error: "statfs_unavailable", detail: error?.message || String(error) };
  }
}

/**
 * Round-trip test: create the folder if needed, write a small marker file,
 * read it back, delete it. This is the only check that actually proves the
 * app can use the folder — a `statfs` success says nothing about write
 * permission, and `fs.access` can pass while OS-level Windows ACLs/AV
 * software still block the write moments later.
 */
async function testFolderAccess(targetPath, opts = {}) {
  const fsp = opts.fsp || fs.promises;
  const markerName = `.pos-write-test-${opts.marker || Date.now().toString(36)}`;
  const markerPath = path.join(targetPath, markerName);
  try {
    await fsp.mkdir(targetPath, { recursive: true });
  } catch (error) {
    return { ok: false, error: "cannot_create_folder", detail: error?.message || String(error) };
  }
  const payload = "cafe-pos-local-storage-check";
  try {
    await fsp.writeFile(markerPath, payload, { encoding: "utf8" });
  } catch (error) {
    return { ok: false, error: "cannot_write", detail: error?.message || String(error) };
  }
  try {
    const readBack = await fsp.readFile(markerPath, "utf8");
    if (readBack !== payload) {
      return { ok: false, error: "readback_mismatch", detail: "Written content did not match on read-back." };
    }
  } catch (error) {
    return { ok: false, error: "cannot_read", detail: error?.message || String(error) };
  } finally {
    try {
      await fsp.unlink(markerPath);
    } catch {
      // Best-effort cleanup; a leftover marker file is harmless, and failing
      // to delete it must not turn a working folder into a reported failure.
    }
  }
  return { ok: true };
}

/**
 * The full first-run check for one candidate folder: existence/creatability,
 * free space, and a real write/read/delete round trip. This is what the IPC
 * handler (`desktop:storage-check-folder`) calls; the wizard shows all three
 * results side by side rather than collapsing them into one pass/fail, since
 * each failure mode needs different owner-facing guidance (pick a folder
 * that exists vs. free up space vs. fix folder permissions/antivirus).
 */
async function evaluateFolder(targetPath, opts = {}) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, error: "empty_path" };
  }
  const resolved = path.resolve(targetPath.trim());
  const [space, access] = await Promise.all([
    checkDiskSpace(resolved, opts),
    testFolderAccess(resolved, opts),
  ]);
  return {
    ok: access.ok,
    path: resolved,
    space,
    access,
  };
}

/**
 * The default per-kind subfolder layout under one chosen root, used when the
 * owner picks a single root folder rather than a separate one per data kind
 * (the common case — the wizard offers "advanced" per-kind pickers, but a
 * single root is the one-click default). Mirrors the installer's own
 * Application/Data/Backup/Logs/Configuration split (Section 8) so a desktop
 * install and this in-app wizard describe the same physical layout.
 */
function defaultLayout(root) {
  const base = path.resolve(root);
  return {
    database: path.join(base, "database"),
    attachments: path.join(base, "attachments"),
    images: path.join(base, "images"),
    reports: path.join(base, "reports"),
    backups: path.join(base, "backups"),
    printerConfig: path.join(base, "printer-config"),
  };
}

/** A sane default root to preselect: the user's Documents folder, one level under a product-named folder. */
function suggestedDefaultRoot(homedir = os.homedir()) {
  return path.join(homedir, "Documents", "Bizamiz Data");
}

const STORAGE_MARKER_FILE = "storage-location.json";

/**
 * Where the chosen storage root is recorded — always in Electron's DEFAULT
 * `userData` path (before any `app.setPath` override), never inside the
 * chosen root itself. This is deliberate: the marker must be findable on the
 * very next launch no matter what the owner picked last time, the same way
 * a bootloader's own config lives somewhere fixed rather than on the disk it
 * is about to mount.
 */
function markerPath(defaultUserDataDir) {
  return path.join(defaultUserDataDir, STORAGE_MARKER_FILE);
}

/**
 * Reads the recorded storage root, or `{ root: null }` if this is a fresh
 * install (or an install that predates Section 3 of the desktop audit and
 * has always used the default location — see `main.js`'s upgrade-path
 * backfill, which writes this marker retroactively rather than ever
 * re-prompting an existing install).
 */
async function readStorageRootMarker(defaultUserDataDir, opts = {}) {
  const fsp = opts.fsp || fs.promises;
  try {
    const raw = await fsp.readFile(markerPath(defaultUserDataDir), "utf8");
    const parsed = JSON.parse(raw);
    const root = typeof parsed?.root === "string" && parsed.root.trim() ? parsed.root.trim() : null;
    return { root };
  } catch {
    return { root: null };
  }
}

/** Records the chosen storage root so every future launch reuses it without re-asking. */
async function writeStorageRootMarker(defaultUserDataDir, root, opts = {}) {
  const fsp = opts.fsp || fs.promises;
  await fsp.mkdir(defaultUserDataDir, { recursive: true });
  await fsp.writeFile(markerPath(defaultUserDataDir), JSON.stringify({ root, setAt: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/**
 * The one first-run decision that matters, factored out as a pure function
 * so it is unit-testable without touching Electron's `app` module or a real
 * disk: given what's already on this machine, what should `main.js` do
 * before it lets `BackendManager` (and therefore embedded Postgres) start?
 *
 *   - `hasExistingConfigAtDefault: true`  → this install already has data at
 *     the OS-default `userData` path (an install that predates Section 3, or
 *     one that already answered this prompt and kept the default). NEVER
 *     prompt or move anything — see local-storage.js's header for why
 *     relocating an initialised data directory is out of scope here.
 *   - a marker recorded a non-default root → reuse it silently, every launch
 *     after the first. This is what makes the choice "once, not every time".
 *   - neither → a genuinely first launch: ask.
 */
function decideStorageBootstrap({ hasExistingConfigAtDefault, markerRoot }) {
  if (hasExistingConfigAtDefault) return { action: "use_default" };
  if (typeof markerRoot === "string" && markerRoot.trim()) {
    return { action: "use_marker_root", root: markerRoot.trim() };
  }
  return { action: "prompt" };
}

module.exports = {
  STORAGE_KINDS,
  RECOMMENDED_FREE_BYTES,
  MINIMUM_FREE_BYTES,
  STORAGE_MARKER_FILE,
  formatBytes,
  closestExistingAncestor,
  checkDiskSpace,
  testFolderAccess,
  evaluateFolder,
  defaultLayout,
  suggestedDefaultRoot,
  markerPath,
  readStorageRootMarker,
  writeStorageRootMarker,
  decideStorageBootstrap,
};
