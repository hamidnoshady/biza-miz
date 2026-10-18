// Issue #984 — the main-app half of the cross-runtime maintenance gate.
// The companion holds `%ProgramData%\Biza\maintenance.lock` with a share-none
// HANDLE while it runs repairs; Node cannot hold such a HANDLE, so this side
// claims with a PID-stamped file plus a mtime heartbeat instead:
//
//   %ProgramData%\Biza\maintenance.electron.<pid>.claim
//   pid=<pid>
//   started=<this process's start, ISO>
//   acquired=<claim time, ISO>
//
// The C# side (`MaintenanceLock`) refuses while a claim looks live and
// deletes provably stale ones; this side probes the lock file with an open
// (share-none held = open fails) before claiming. Crash-safe both ways: a
// dead C# holder's HANDLE dies with the OS, a dead Electron holder's PID
// dies with the process. Claim-first-then-probe ordering plus the C#
// post-open re-check close the simultaneous-acquire race.
//
// Heartbeat ownership ends at process exit — including the installer
// handoff (`handoff`), where the claim is re-stamped to the detached
// installer's PID so the companion stays out until the installer exits.
// `BIZA_MAINTENANCE_LOCK` overrides the lock path (tests, portable
// layouts), with the same full-path rule as the C# side.
"use strict";

const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const LOCK_FILE_NAME = "maintenance.lock";
const CLAIM_PREFIX = "maintenance.electron.";
const CLAIM_SUFFIX = ".claim";
const LOCK_OVERRIDE_VARIABLE = "BIZA_MAINTENANCE_LOCK";
const HEARTBEAT_MS = 15_000;

function resolveLockPath(env = process.env) {
  const override =
    typeof env[LOCK_OVERRIDE_VARIABLE] === "string" ? env[LOCK_OVERRIDE_VARIABLE].trim() : "";
  if (override) return override;
  const programData = typeof env.ProgramData === "string" ? env.ProgramData.trim() : "";
  if (!programData) return null;
  return defaultPath.join(programData, "Biza", LOCK_FILE_NAME);
}

function claimFileName(pid) {
  return `${CLAIM_PREFIX}${pid}${CLAIM_SUFFIX}`;
}

function parseClaimPid(fileName) {
  if (
    typeof fileName !== "string" ||
    !fileName.startsWith(CLAIM_PREFIX) ||
    !fileName.endsWith(CLAIM_SUFFIX)
  ) {
    return null;
  }
  const pid = Number(fileName.slice(CLAIM_PREFIX.length, -CLAIM_SUFFIX.length));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** An open probe: share-none held reads fail; a missing file is free. */
function probeLockFile(lockPath, { fs = defaultFs } = {}) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "r");
  } catch (err) {
    // Only "no such file" means free — every other failure (held, ACL,
    // not-a-file) is conservative: someone may be maintaining.
    return err && err.code === "ENOENT" ? "free" : "held";
  }
  try {
    fs.closeSync(fd);
  } catch {
    // The probe already answered; a close failure changes nothing.
  }
  return "free";
}

function pidAlive(pid, { processRef = process } = {}) {
  try {
    processRef.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. Anything else (EPERM for another user's
    // process, …) means it exists.
    return err && err.code === "ESRCH" ? false : true;
  }
}

/** Deletes claims whose PID is provably dead. Returns the deleted count. */
function cleanupStaleClaims(dir, { fs = defaultFs, path = defaultPath, processRef = process } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const file of files) {
    const pid = parseClaimPid(file);
    if (pid === null) continue;
    if (pidAlive(pid, { processRef })) continue;
    try {
      fs.unlinkSync(path.join(dir, file));
      deleted += 1;
    } catch {
      // Someone else owns it now; the next sweep retries.
    }
  }
  return deleted;
}

function processStartIso({ processRef = process, dateNow = Date.now } = {}) {
  const uptimeMs =
    typeof processRef.uptime === "function" ? processRef.uptime() * 1000 : 0;
  return new Date(dateNow() - uptimeMs).toISOString();
}

function writeClaim(claimPath, pid, startedIso, { fs = defaultFs } = {}) {
  const body = `pid=${pid}\nstarted=${startedIso}\nacquired=${new Date().toISOString()}\n`;
  fs.writeFileSync(claimPath, body, "utf8");
}

function touchClaim(claimPath, { fs = defaultFs } = {}) {
  const now = new Date();
  fs.utimesSync(claimPath, now, now);
}

/**
 * Claims the gate: writes our claim, then refuses if the companion holds
 * the lock file. Returns `{ ok: true, handle }` or `{ ok: false, error }`
 * with `lock_dir_unavailable` / `claim_unwritable` /
 * `companion_maintenance_running`. Never throws.
 */
function acquireLock({
  env = process.env,
  fs = defaultFs,
  path = defaultPath,
  processRef = process,
  heartbeatMs = HEARTBEAT_MS,
} = {}) {
  const lockPath = resolveLockPath(env);
  if (!lockPath) return { ok: false, error: "lock_dir_unavailable" };
  const dir = path.dirname(lockPath);
  const pid = processRef.pid;

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: "claim_unwritable" };
  }

  const claimPath = path.join(dir, claimFileName(pid));
  try {
    writeClaim(claimPath, pid, processStartIso({ processRef }), { fs });
  } catch {
    return { ok: false, error: "claim_unwritable" };
  }

  if (probeLockFile(lockPath, { fs }) === "held") {
    try {
      fs.unlinkSync(claimPath);
    } catch {
      // A leftover live-PID claim only delays the companion until our
      // heartbeat stops and the PID dies with this process.
    }
    return { ok: false, error: "companion_maintenance_running" };
  }

  cleanupStaleClaims(dir, { fs, path, processRef });

  let timer = null;
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      try {
        touchClaim(claimPath, { fs });
      } catch {
        // A missed beat only matters past the C# side's 60s suspicion
        // window, and a matching PID+start still reads live regardless.
      }
    }, heartbeatMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  const stopHeartbeat = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const handle = {
    lockPath,
    claimPath,
    pid,
    /** Normal end of maintenance: stop the heartbeat, delete the claim. */
    release() {
      stopHeartbeat();
      try {
        fs.unlinkSync(claimPath);
      } catch {
        // Best effort: a dead PID makes it collectible.
      }
      return { ok: true };
    },
    /**
     * Installer handoff: re-stamp the claim to the detached installer's
     * PID (no heartbeat — the installer owns its lifetime; the C# side
     * reads live-PID claims as live). Null/own PID leaves the claim.
     */
    handoff(installerPid) {
      stopHeartbeat();
      if (!Number.isInteger(installerPid) || installerPid <= 0 || installerPid === pid) {
        return { ok: true, handedOff: false };
      }
      const nextPath = path.join(dir, claimFileName(installerPid));
      try {
        // The installer spawned moments ago: now is its start within the
        // C# side's tolerance. `acquired` is preserved in spirit (fresh
        // stamp) — the C# side keys liveness off PID + mtime + start.
        writeClaim(nextPath, installerPid, new Date().toISOString(), { fs });
        fs.unlinkSync(claimPath);
        handle.claimPath = nextPath;
        handle.pid = installerPid;
        return { ok: true, handedOff: true };
      } catch {
        return { ok: false, error: "handoff_failed" };
      }
    },
  };
  return { ok: true, handle };
}

module.exports = {
  LOCK_FILE_NAME,
  CLAIM_PREFIX,
  CLAIM_SUFFIX,
  LOCK_OVERRIDE_VARIABLE,
  HEARTBEAT_MS,
  resolveLockPath,
  claimFileName,
  parseClaimPid,
  probeLockFile,
  pidAlive,
  cleanupStaleClaims,
  acquireLock,
};
