// Issue #984 — launching the standalone Windows support companion from the
// desktop shell (startup-failure dialog, ticket "open companion" actions).
//
// The companion is a separate install with its own EXE; this module only
// resolves and spawns it — it never implements companion behavior. Launch
// prefers a direct spawn over the `biza-support://` protocol: in the failure
// scenarios that need the companion most (broken main install, broken
// protocol registration), the EXE path still works. The deep-link builder is
// the shared contract for web/renderer affordances.
//
// Install locations (checked in order):
//   1. `BIZA_SUPPORT_COMPANION_EXE` override (tests, portable layouts),
//   2. `%ProgramFiles%\Biza Support Companion\BizaSupportCompanion.exe`,
//   3. `%LocalAppData%\Biza Support Companion\BizaSupportCompanion.exe`.
// The companion installer owns these paths; they are documented here so the
// shell and the installer cannot drift silently.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
// win32 explicitly: these are Windows install paths by definition, and the
// unit tests exercise them on Linux CI too.
const path = require("node:path").win32;

const SUPPORT_PROTOCOL = "biza-support";
const COMPANION_EXE = "BizaSupportCompanion.exe";
const COMPANION_DIR = "Biza Support Companion";

function candidateInstallPaths(env = process.env) {
  const override = typeof env.BIZA_SUPPORT_COMPANION_EXE === "string"
    ? env.BIZA_SUPPORT_COMPANION_EXE.trim()
    : "";
  if (override) return [override];
  const out = [];
  if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, COMPANION_DIR, COMPANION_EXE));
  if (env.LocalAppData) out.push(path.join(env.LocalAppData, COMPANION_DIR, COMPANION_EXE));
  return out;
}

function resolveCompanionExe({ env = process.env, existsSync = fs.existsSync } = {}) {
  for (const candidate of candidateInstallPaths(env)) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is not an install; keep looking.
    }
  }
  return null;
}

/** The one link shape the companion accepts; opening alone authorizes nothing. */
function companionDeepLink(ticketId) {
  const id = typeof ticketId === "string" ? ticketId.trim() : "";
  return id ? `${SUPPORT_PROTOCOL}://ticket/${encodeURIComponent(id)}` : `${SUPPORT_PROTOCOL}://open`;
}

function launchArgs(ticketId) {
  const id = typeof ticketId === "string" ? ticketId.trim() : "";
  return id ? ["--ticket", id] : [];
}

function launchCompanion({ ticketId = null, exePath = undefined, spawnFn = spawn } = {}) {
  const exe = exePath === undefined ? resolveCompanionExe() : exePath;
  if (!exe) return { ok: false, error: "not_installed" };
  try {
    const child = spawnFn(exe, launchArgs(ticketId), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    if (child && typeof child.unref === "function") child.unref();
    return { ok: true, exe };
  } catch (err) {
    return {
      ok: false,
      error: "launch_failed",
      detail: err && err.message ? String(err.message).slice(0, 200) : undefined,
    };
  }
}

function companionStatus(overrides = {}) {
  const exe = resolveCompanionExe(overrides);
  return { installed: exe !== null, exe, protocol: SUPPORT_PROTOCOL };
}

module.exports = {
  SUPPORT_PROTOCOL,
  COMPANION_EXE,
  COMPANION_DIR,
  candidateInstallPaths,
  resolveCompanionExe,
  companionDeepLink,
  launchCompanion,
  companionStatus,
};
