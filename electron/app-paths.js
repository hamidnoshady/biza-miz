"use strict";

/**
 * Application/Data/Backup/Logs/Configuration folder split — the audit fix
 * for Section 8 ("installer should create separate Application/Data/Backup/
 * Logs/Configuration folders").
 *
 * The "Application" folder is already separate: electron-builder's NSIS
 * installer puts the program binaries under Program Files (or wherever the
 * owner picks during setup, via `allowToChangeInstallationDirectory`), which
 * has never been mixed with this app's runtime data. What WAS flat, before
 * this module, was everything under Electron's own `userData` directory:
 * `config.json`, the embedded Postgres data directory (`pgdata`), the local
 * HTTPS gateway's CA/certificates, log files, and emergency pre-restore
 * dumps all lived directly in one undifferentiated folder
 * (`backend-manager.js`'s `loadOrCreateConfig`/`emergencyBackupDir`,
 * `logger.js`'s `logDir`, `certificate-manager.js`'s `directory`).
 *
 * This module is the single source of truth for where each of those now
 * lives — Configuration/, Data/ (+ Data/pgdata, Data/gateway-certificates),
 * Backup/ (+ Backup/emergency-backups), Logs/ — and the one-time migration
 * that moves an EXISTING install's flat layout into it. `main.js` calls
 * `migrateLegacyLayout()` exactly once, right after `runStorageBootstrap()`
 * resolves the final `userData` root (default or owner-chosen) and before
 * `logger.js`/`backend-manager.js`/`certificate-manager.js` compute any path
 * from it, so nothing ever reads from the old flat locations after this
 * runs. A completed migration is recorded in `LEGACY_MIGRATION_MARKER` so it
 * runs at most once per install; this is the same "marker file next to the
 * data it describes" shape `local-storage.js` already uses for the storage
 * root choice.
 *
 * This is deliberately NOT the same thing as `local-storage.js`'s Section 3
 * wizard: that module lets the owner point *business* data (attachments,
 * images, reports, backups they manage) at any drive/folder they like — a
 * decision that is scoped to where the app looks for that content, not to
 * how Electron's own per-machine `userData` directory is organised
 * internally. This module only reorganises the latter.
 *
 * Every side-effecting function accepts an injectable `fs` (the sync fs
 * API), so the decision logic — what counts as "already migrated", which
 * entries need to move, how a cross-device move degrades gracefully — is
 * unit-testable without a real multi-volume machine. See
 * src/lib/app-paths.test.ts.
 */

const fs = require("node:fs");
const path = require("node:path");

const LEGACY_MIGRATION_MARKER = ".folder-layout-v1"; // schemaVersion 1 in migrateLegacyLayout()'s marker payload — bump alongside any future layout change.

/**
 * The canonical Configuration/Data/Backup/Logs layout for one `userData`
 * root. Pure and side-effect free — every other function in this module and
 * in `backend-manager.js`/`logger.js`/`certificate-manager.js` derives its
 * paths from this, so there is exactly one place that spells out where
 * anything lives.
 */
function computePaths(userDataDir) {
  const root = path.resolve(userDataDir);
  const configDir = path.join(root, "Configuration");
  const dataDir = path.join(root, "Data");
  const backupDir = path.join(root, "Backup");
  const logsDir = path.join(root, "Logs");
  return {
    root,
    configDir,
    configPath: path.join(configDir, "config.json"),
    configBackupPath: path.join(configDir, "config.backup.json"),
    dataDir,
    pgDataDir: path.join(dataDir, "pgdata"),
    certificatesDir: path.join(dataDir, "gateway-certificates"),
    backupDir,
    emergencyBackupDir: path.join(backupDir, "emergency-backups"),
    logsDir,
  };
}

/** Where the one-time migration records that it has already run. Lives at the `userData` root, alongside the folders it organises, not inside any of them. */
function migrationMarkerPath(userDataDir) {
  return path.join(path.resolve(userDataDir), LEGACY_MIGRATION_MARKER);
}

/**
 * True when `a` and `b` name the same directory entry on a case-insensitive,
 * case-preserving filesystem (NTFS — the only filesystem this app's
 * packaged Windows build actually runs on) but differ in letter case. This
 * matters for exactly one entry in `legacyMoves()`: legacy `logs` and the
 * new `Logs` live in the SAME parent directory and differ only by case. On
 * Windows, `fs.existsSync(next)` is true THE MOMENT `legacy` exists (they
 * are the identical on-disk entry), which would make the generic
 * "does the destination already exist?" conflict check in
 * `migrateLegacyLayout` misidentify a normal, always-safe rename as an
 * unrelated pre-existing destination and skip it — the exact bug this
 * function exists to route around.
 */
function isCaseOnlyRename(a, b) {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  return resolvedA !== resolvedB && resolvedA.toLowerCase() === resolvedB.toLowerCase();
}

/**
 * Move one file or directory from `src` to `dest`. `fs.renameSync` covers
 * the overwhelming majority of real installs (everything under one
 * `userData` root is on one volume); the EXDEV fallback (copy, then remove
 * the original) exists only for the rare case of a `userData` root that a
 * prior manual configuration pointed at a mount spanning volumes.
 *
 * A case-only rename (see `isCaseOnlyRename`) goes through a distinct
 * intermediate name rather than a direct `rename(src, dest)`: on a
 * case-insensitive filesystem, `src` and `dest` are the same directory
 * entry, and some platforms/tools silently no-op (rather than actually
 * update the stored case) when the source and destination differ only in
 * case. Renaming through a genuinely different name is the portable way to
 * force the case to change, and it degrades to two perfectly ordinary
 * renames — harmless — on a case-sensitive filesystem too.
 */
function moveEntry(src, dest, fsImpl) {
  if (isCaseOnlyRename(src, dest)) {
    const intermediate = `${src}.case-migrate-tmp-${process.pid}`;
    fsImpl.renameSync(src, intermediate);
    fsImpl.renameSync(intermediate, dest);
    return;
  }
  try {
    fsImpl.renameSync(src, dest);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    fsImpl.cpSync(src, dest, { recursive: true });
    fsImpl.rmSync(src, { recursive: true, force: true });
  }
}

/**
 * The legacy (pre-Section-8) flat paths, and where each now belongs. Order
 * matters only for log readability; each entry is independent.
 */
function legacyMoves(userDataDir, paths) {
  return [
    { key: "config", legacy: path.join(userDataDir, "config.json"), next: paths.configPath },
    { key: "pgdata", legacy: path.join(userDataDir, "pgdata"), next: paths.pgDataDir },
    { key: "gatewayCertificates", legacy: path.join(userDataDir, "gateway-certificates"), next: paths.certificatesDir },
    { key: "emergencyBackups", legacy: path.join(userDataDir, "emergency-backups"), next: paths.emergencyBackupDir },
    { key: "logs", legacy: path.join(userDataDir, "logs"), next: paths.logsDir },
  ];
}

/**
 * The one-time migration. Idempotent (checks the marker first) and safe to
 * call on every launch — a fresh install has nothing to move (every entry is
 * "not_present") and the marker is written immediately so this function is a
 * no-op check on every subsequent launch.
 *
 * A genuine move failure (permissions, a file locked by another process)
 * does NOT write the marker, so the migration is retried on the next
 * launch rather than silently leaving data split across old and new
 * locations forever. Every affected component keeps working from the
 * legacy path in the meantime because nothing here deletes a source that
 * failed to copy.
 */
function migrateLegacyLayout(userDataDir, opts = {}) {
  const fsImpl = opts.fs || fs;
  const marker = migrationMarkerPath(userDataDir);
  if (fsImpl.existsSync(marker)) {
    return { migrated: false, reason: "already_migrated" };
  }

  const paths = computePaths(userDataDir);
  // Only pre-create directories whose migration TARGETS are nested a level
  // further down (Configuration/config.json, Data/pgdata,
  // Data/gateway-certificates, Backup/emergency-backups) — never
  // `paths.logsDir` itself, because "logs" is the one legacy entry whose
  // destination IS the top-level folder, not something nested inside it.
  // Pre-creating it here would make it look like an already-occupied
  // destination below and incorrectly skip a real legacy `logs/` move.
  fsImpl.mkdirSync(paths.configDir, { recursive: true });
  fsImpl.mkdirSync(paths.dataDir, { recursive: true });
  fsImpl.mkdirSync(paths.backupDir, { recursive: true });

  const results = [];
  let hadFailure = false;
  for (const { key, legacy, next } of legacyMoves(userDataDir, paths)) {
    if (!fsImpl.existsSync(legacy)) {
      results.push({ key, legacy, next, action: "not_present" });
      continue;
    }
    // `legacy` and `next` are the SAME on-disk entry for the one case-only
    // rename in `legacyMoves()` (legacy `logs` -> new `Logs`) whenever the
    // filesystem is case-insensitive (NTFS — every real packaged Windows
    // install). `fsImpl.existsSync(next)` would be true there purely
    // because `legacy` itself exists, which is not a genuine conflict — it
    // must still go through `moveEntry` to actually correct the on-disk
    // case, not be mistaken for a pre-existing, unrelated destination.
    if (fsImpl.existsSync(next) && !isCaseOnlyRename(legacy, next)) {
      // A previous partially-completed migration (or a coincidental
      // pre-existing file) already occupies the destination. Leave both
      // alone rather than guess which one is authoritative — an operator
      // can resolve it by hand, which is safer than silently discarding
      // either copy.
      results.push({ key, legacy, next, action: "skipped_target_exists" });
      continue;
    }
    try {
      moveEntry(legacy, next, fsImpl);
      results.push({ key, legacy, next, action: "moved" });
    } catch (error) {
      hadFailure = true;
      results.push({ key, legacy, next, action: "failed", error: error?.message || String(error) });
    }
  }

  if (!hadFailure) {
    fsImpl.writeFileSync(
      marker,
      JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), results }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  }

  return { migrated: !hadFailure, results };
}

module.exports = {
  LEGACY_MIGRATION_MARKER,
  computePaths,
  migrationMarkerPath,
  isCaseOnlyRename,
  moveEntry,
  legacyMoves,
  migrateLegacyLayout,
};
