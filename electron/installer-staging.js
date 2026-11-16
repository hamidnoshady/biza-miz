// Issue #1000 - secure installer staging for the Desktop updater.
//
// The downloaded installer used to be verified where it landed, in the
// user-writable `Data\Updates` folder, and launched from that same path later.
// Between those two moments any process running as the same Windows account
// could replace the bytes, so a re-hash alone is not a fix.
//
// This module does what the Windows privilege model actually allows:
//
//   1. the verified download is copied into a dedicated staging folder whose
//      ACL is restricted to this account (other accounts cannot write there);
//   2. the *copy* is re-verified by the engine (size, SHA-256, Authenticode and
//      the signed publisher + thumbprint pin);
//   3. immediately before execution the file identity that was verified is
//      compared again (device/inode/size/mtime), so a replaced or swapped file
//      never reaches the launcher;
//   4. on Windows the launcher opens the staged file with `FileShare.Read`
//      (denying write, delete and rename), recomputes SHA-256 from that same
//      handle and only then starts the process while the handle is still held.
//      The bytes hashed are the bytes mapped into the new process, so the
//      verification-to-execution window is closed rather than narrowed.
//
// A same-account administrator can still do anything to its own files; the
// guarantee is that the updater never executes bytes it did not verify while
// they were protected.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STAGED_RETENTION = 2;

function stagingError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-64_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(executable)} exited ${code}: ${stderr.trim()}`)));
  });
}

function stagingDirectory(updatesDir) {
  return path.join(updatesDir, "staging");
}

/**
 * `lstat`, never `stat`: a reparse point would otherwise resolve to whatever
 * the attacker pointed it at, and we would hash a file we never verified.
 */
function inspectRegularFile(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { throw stagingError("installer_missing", error); }
  if (stat.isSymbolicLink()) throw stagingError("installer_reparse_point");
  if (!stat.isFile()) throw stagingError("installer_not_regular_file");
  return stat;
}

function fileIdentity(stat) {
  // `ctimeMs` is included because it cannot be set from userland: an attacker
  // who rewrites the staged file can restore `mtime`, not the inode change time.
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

/** Restrict the staging folder to this account so no other user can write to it. */
async function lockDownStagingDirectory(directory, { commandRunner, logger } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* POSIX modes do not apply on Windows */ }
  if (process.platform !== "win32") return { applied: false };
  const account = process.env.USERNAME || os.userInfo().username;
  if (!account) return { applied: false };
  try {
    await (commandRunner || run)("icacls", [directory, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`]);
    return { applied: true };
  } catch (error) {
    // The launch lock is the guarantee; a refused ACL is reported, not assumed.
    logger?.warn?.("Could not restrict the updater staging folder ACL", { detail: error?.message });
    return { applied: false };
  }
}

/**
 * Copy a verified installer into the protected staging folder and snapshot the
 * identity of the exact copy. The caller re-verifies this copy's bytes.
 */
async function stageInstaller({
  sourcePath,
  updatesDir,
  version,
  expectedSize,
  commandRunner,
  logger,
}) {
  const source = inspectRegularFile(sourcePath);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || source.size !== expectedSize) {
    throw stagingError("installer_size_mismatch");
  }
  const directory = stagingDirectory(updatesDir);
  const acl = await lockDownStagingDirectory(directory, { commandRunner, logger });
  // A fresh random name every attempt: a predictable path could be pre-created
  // or pre-planted; `COPYFILE_EXCL` then refuses to reuse whatever is there.
  const stagedPath = path.join(directory, `Bizamiz-${String(version || "update").replace(/[^0-9A-Za-z.-]/g, "_")}-${crypto.randomUUID()}.exe`);
  fs.copyFileSync(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(stagedPath, 0o600); } catch { /* Windows: ACL above applies */ }
  const stagedStat = inspectRegularFile(stagedPath);
  if (stagedStat.size !== expectedSize) {
    fs.rmSync(stagedPath, { force: true });
    throw stagingError("installer_size_mismatch");
  }
  return { path: stagedPath, identity: fileIdentity(stagedStat), aclApplied: acl.applied };
}

/** The identity check that runs between verification and execution. */
function assertStagedUnchanged(staged) {
  const stat = inspectRegularFile(staged?.path);
  const current = fileIdentity(stat);
  const expected = staged.identity;
  if (!expected || current.dev !== expected.dev || current.ino !== expected.ino ||
      current.size !== expected.size || current.mtimeMs !== expected.mtimeMs ||
      current.ctimeMs !== expected.ctimeMs) {
    throw stagingError("installer_replaced_after_verification");
  }
  return stat;
}

/** Keep the newest staged installers (plus the one about to be used). */
function pruneStagedInstallers(updatesDir, keepPath) {
  const directory = stagingDirectory(updatesDir);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Bizamiz-.+\.exe$/.test(entry.name))
      .map((entry) => {
        const filePath = path.join(directory, entry.name);
        return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch { return []; }
  const keep = new Set(keepPath ? [keepPath] : []);
  for (const entry of entries) {
    if (keep.size >= STAGED_RETENTION + 1) break;
    keep.add(entry.filePath);
  }
  const removed = [];
  for (const entry of entries) {
    if (keep.has(entry.filePath)) continue;
    fs.rmSync(entry.filePath, { force: true });
    removed.push(entry.filePath);
  }
  return removed;
}

/**
 * Windows launcher: hold the staged bytes open for reading only (write, delete
 * and rename are denied), hash that handle, and start the process while the
 * handle is still open. Anything that is not the verified file fails here.
 */
function lockedLaunchScript() {
  return [
    "$ErrorActionPreference='Stop'",
    "$p=$env:BIZAMIZ_STAGED_INSTALLER",
    "$h=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "try{",
    "$sha=[Security.Cryptography.SHA256]::Create()",
    "$digest=([BitConverter]::ToString($sha.ComputeHash($h))).Replace('-','').ToLowerInvariant()",
    "if($digest -cne $env:BIZAMIZ_STAGED_SHA256){throw 'staged_installer_hash_mismatch'}",
    "$child=Start-Process -FilePath $p -ArgumentList @('/S',('/D='+$env:BIZAMIZ_INSTALL_DIR)) -PassThru",
    "Write-Output $child.Id",
    "}finally{$h.Dispose()}",
  ].join(";");
}

function hashFileDescriptor(fd) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

async function launchStagedInstaller({ staged, installDirectory, sha256, commandRunner }) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ""))) throw stagingError("installer_sha256_mismatch");
  // Re-check identity first: a swapped file must not even be opened.
  assertStagedUnchanged(staged);
  if (process.platform !== "win32") {
    // Same rule without the Windows lock: hash the open handle again, and only
    // start the file if the bytes are still the verified ones.
    let handle;
    try { handle = fs.openSync(staged.path, "r"); }
    catch (error) { throw stagingError("installer_missing", error); }
    try {
      const opened = fileIdentity(fs.fstatSync(handle));
      if (opened.ino !== staged.identity.ino || opened.dev !== staged.identity.dev) {
        throw stagingError("installer_replaced_after_verification");
      }
      if (hashFileDescriptor(handle) !== sha256) throw stagingError("installer_sha256_mismatch");
      assertStagedUnchanged(staged);
      // Development hosts without Windows: same verified bytes, no Windows lock.
      const child = spawn(staged.path, ["/S", `/D=${installDirectory}`], { detached: true, windowsHide: false, stdio: "ignore" });
      child.unref();
      return { installerPid: child.pid ?? null, locked: false };
    } finally { fs.closeSync(handle); }
  }
  const { stdout } = await (commandRunner || run)("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", lockedLaunchScript(),
  ], {
    env: {
      ...process.env,
      BIZAMIZ_STAGED_INSTALLER: staged.path,
      BIZAMIZ_STAGED_SHA256: sha256,
      BIZAMIZ_INSTALL_DIR: installDirectory,
    },
  });
  const installerPid = Number.parseInt(String(stdout).trim().split(/\r?\n/).pop(), 10);
  if (!Number.isSafeInteger(installerPid) || installerPid < 1) throw stagingError("installer_launch_failed");
  return { installerPid, locked: true };
}

module.exports = {
  STAGED_RETENTION,
  assertStagedUnchanged,
  fileIdentity,
  inspectRegularFile,
  launchStagedInstaller,
  lockDownStagingDirectory,
  lockedLaunchScript,
  pruneStagedInstallers,
  stageInstaller,
  stagingDirectory,
};
