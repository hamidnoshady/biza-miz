#!/usr/bin/env node
"use strict";

/**
 * Pre-populate electron-builder's `winCodeSign` cache, working around a
 * Windows-only extraction failure that otherwise stops the build before it
 * ever produces the installer `.exe`.
 *
 * Why this is needed even though we don't code-sign anything:
 *
 * electron-builder downloads the `winCodeSign` bundle unconditionally on
 * Windows — not for signing (that's correctly skipped with no certificate),
 * but because the same archive carries `rcedit`, which stamps the app icon,
 * product name and version onto `Bizamiz.exe`. Without it the build fails,
 * and even a build that skips it (`win.signAndEditExecutable: false`) ships an
 * exe still branded "Electron" with the stock Electron icon.
 *
 * The failure: the archive contains macOS symlinks
 * (darwin/10.12/lib/libcrypto.dylib, libssl.dylib). Creating a symlink on
 * Windows needs SeCreateSymbolicLinkPrivilege — which a normal, non-elevated
 * account without Developer Mode doesn't hold — so 7-Zip exits non-zero:
 *
 *     ERROR: Cannot create symbolic link : A required privilege is not held
 *     by the client. : ...\darwin\10.12\lib\libcrypto.dylib
 *
 * electron-builder treats that non-zero exit as fatal, retries four times, and
 * gives up. Nothing in the `darwin/` or `linux/` trees is used when building a
 * Windows installer on Windows, so this script extracts the archive itself with
 * those two directories excluded and leaves the result exactly where
 * electron-builder looks for it. electron-builder then finds a populated cache
 * and skips the download that would have failed.
 *
 * Idempotent and best-effort: if the cache is already populated it does
 * nothing, and any unexpected failure here is a warning rather than an error —
 * electron-builder is still free to try the download itself (which is what
 * happens on machines where extraction works fine, e.g. CI runners and
 * Developer-Mode machines).
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Pinned by electron-builder 25.x (app-builder-lib's getSignVendorPath ->
// getBin("winCodeSign")). If a future electron-builder bumps this, the cache
// name below simply won't match, this script becomes a no-op, and the build
// falls back to electron-builder's own download.
const NAME = "winCodeSign";
const VERSION = "231615067";
const DIR_NAME = `${NAME}-${VERSION}`;
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${DIR_NAME}/${DIR_NAME}.7z`;

// Directories that only matter when signing *from* macOS/Linux. These are the
// ones holding the symlinks Windows refuses to create.
const EXCLUDED = ["darwin", "linux"];

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) {
    return path.resolve(process.env.ELECTRON_BUILDER_CACHE);
  }
  // Mirrors app-builder's own default on Windows.
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "electron-builder", "Cache");
}

function main() {
  if (process.platform !== "win32") {
    return;
  }

  const targetDir = path.join(cacheRoot(), NAME, DIR_NAME);

  // rcedit-x64.exe is what the build actually reaches for; treat its presence
  // as "cache already good" so repeat builds skip all of this.
  if (fs.existsSync(path.join(targetDir, "rcedit-x64.exe"))) {
    return;
  }

  let path7za;
  try {
    path7za = require("7zip-bin").path7za;
  } catch {
    console.warn("[prepare-wincodesign-cache] 7zip-bin not resolvable; leaving the download to electron-builder.");
    return;
  }

  // Staged next to the destination rather than in %TEMP%, so the final rename
  // is always same-volume (a rename across volumes fails with EXDEV, and the
  // cache can easily sit on a different drive than the temp dir).
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(targetDir), ".staging-"));
  const archive = path.join(tmpDir, `${DIR_NAME}.7z`);

  try {
    console.log(`[prepare-wincodesign-cache] fetching ${DIR_NAME} (excluding ${EXCLUDED.join(", ")} — Windows cannot create their symlinks)`);
    execFileSync(
      "curl.exe",
      ["--fail", "--location", "--silent", "--show-error", "--output", archive, URL],
      { stdio: ["ignore", "ignore", "inherit"] }
    );

    // Extract to a staging dir first so an interrupted run can never leave a
    // half-populated cache that the check above would mistake for complete.
    const staging = path.join(tmpDir, "out");
    execFileSync(
      path7za,
      ["x", "-bd", "-y", ...EXCLUDED.map((d) => `-x!${d}`), archive, `-o${staging}`],
      { stdio: ["ignore", "ignore", "inherit"] }
    );

    if (!fs.existsSync(path.join(staging, "rcedit-x64.exe"))) {
      throw new Error("extracted archive is missing rcedit-x64.exe");
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(staging, targetDir);
    console.log(`[prepare-wincodesign-cache] ready: ${targetDir}`);
  } catch (error) {
    // Non-fatal on purpose — see the header comment.
    console.warn(`[prepare-wincodesign-cache] skipped (${error.message}); leaving the download to electron-builder.`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
