"use strict";

/**
 * Where Electron keeps this app's per-user data (`userData`): the embedded
 * database, config, certificates, logs.
 *
 * Electron derives that folder from the app's *name*. The product was renamed
 * to Bizamiz, and an installer whose productName changes would otherwise look
 * in `%APPDATA%\Bizamiz`, find nothing, and start an empty business next to the
 * real one. So the folder is pinned explicitly: an existing install keeps the
 * folder it already has, and only a machine with no data yet gets the new name.
 *
 * Pure apart from the injected `fs`, so the decision is unit-testable
 * (src/lib/desktop-user-data-path.test.ts).
 */

const fs = require("node:fs");
const path = require("node:path");

const USER_DATA_FOLDER = "Bizamiz";

/**
 * Folder names earlier builds used, newest first. "Business Suite" is the
 * productName; "business-suite-desktop" is the package name Electron falls back
 * to when no productName reaches the packaged package.json.
 */
const LEGACY_USER_DATA_FOLDERS = ["Business Suite", "business-suite-desktop"];

/** A folder counts as "has data" if any file the app writes first is in it. */
function hasInstallData(dir, fsApi = fs) {
  return [
    path.join(dir, "Configuration", "config.json"),
    path.join(dir, "config.json"),
    path.join(dir, "storage-location.json"),
  ].some((candidate) => fsApi.existsSync(candidate));
}

/**
 * The `userData` folder for this machine: the first of the new name and the
 * legacy names that already holds data, otherwise the new name.
 */
function resolveUserDataDir(appDataDir, fsApi = fs) {
  for (const folder of [USER_DATA_FOLDER, ...LEGACY_USER_DATA_FOLDERS]) {
    const candidate = path.join(appDataDir, folder);
    if (hasInstallData(candidate, fsApi)) return candidate;
  }
  return path.join(appDataDir, USER_DATA_FOLDER);
}

module.exports = { USER_DATA_FOLDER, LEGACY_USER_DATA_FOLDERS, hasInstallData, resolveUserDataDir };
