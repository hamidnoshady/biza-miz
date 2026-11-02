"use strict";

/**
 * Issue #1194 — packaged-install acceptance, driven entirely from outside the
 * application.
 *
 * This is the replacement for the old in-process `smoke-probe.js`, which was
 * compiled into the shipped main process and could create a predictable local
 * owner (plus a mock Cloud activation service) when a non-secret environment
 * variable was set. That code is gone: `electron/main.js` now has no test
 * branch at all, and `electron/package.json` no longer packages a probe. The
 * fresh-install / restart / platform-realm checks live here instead, speak
 * only the product's public HTTP API to the installed executable, and this
 * file is deliberately **not** in `build.files`.
 *
 * What a run proves about the bytes it launched:
 *
 *   1. The installed payload contains no test-bootstrap marker
 *      (`DESKTOP_SMOKE_`, `smoke-probe`, the hardcoded smoke password) and no
 *      Central platform route modules.
 *   2. Launching with the *old* bypass variables set changes nothing: no
 *      marker file is written, no owner appears, `setup/state` still says
 *      `needsBootstrap`, and no known-password login is accepted.
 *   3. A real first-run bootstrap over the public setup API creates the owner,
 *      signs them in, and the setup state flips.
 *   4. Restart keeps the same installation identity, refuses a second
 *      bootstrap, keeps the session/login working, and leaves no
 *      `postmaster.pid` behind after a graceful quit.
 *   5. The installed site runtime answers `/platform`, `/platform/login`,
 *      `/api/platform/*` with 404 — including with a valid tenant cookie, a
 *      forged platform cookie, and the tenant token replayed as a platform
 *      one. Nothing under those paths may mutate.
 *
 * A failure writes the desktop log tail and a GitHub annotation, as the old
 * harness did.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const rules = require(path.join(repoRoot, "scripts", "desktop", "release-scan-rules.cjs"));

const READY_TIMEOUT_MS = 5 * 60 * 1000; // above backend-manager's own readiness wait
const HTTP_TIMEOUT_MS = 20_000;
const QUIT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
/**
 * A whole-run ceiling. Every individual wait is bounded, but a Windows CI
 * runner can still wedge outside them (a hung `taskkill`, a modal dialog that
 * ignores WM_CLOSE). Without this, one such wedge burns the job's entire
 * timeout and reports nothing; with it, the run fails in a quarter of an hour
 * and says which stage it was in and what the app logged.
 */
const WATCHDOG_MS = Number(process.env.DESKTOP_ACCEPTANCE_WATCHDOG_MS || 15 * 60 * 1000);
/** Every external command gets a budget; a child that never exits is a failure. */
const COMMAND_TIMEOUT_MS = 60_000;

/** The stage the harness is in, so a watchdog or a throw can say where. */
let currentStage = "starting";

/** Paths middleware must deny on a site runtime (issue #1003 / #1194). */
const PLATFORM_DENIAL_PATHS = Object.freeze([
  { method: "GET", path: "/platform" },
  { method: "GET", path: "/platform/login" },
  { method: "POST", path: "/api/platform/auth/login", body: { email: "a@example.invalid", password: "irrelevant" } },
  { method: "GET", path: "/api/platform/auth/me" },
  { method: "POST", path: "/api/platform/mcp", body: { jsonrpc: "2.0", method: "initialize", id: 1 } },
]);

function log(message) {
  console.log(`[desktop-acceptance] ${message}`);
}

function fail(message) {
  const error = new Error(message);
  error.isAcceptanceFailure = true;
  throw error;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit tested in src/lib/desktop-acceptance-harness.test.ts)
 * ------------------------------------------------------------------ */

/** Read `Configuration/config.json`; `null` until the backend has written it. */
function readDesktopConfig(userDataDir) {
  const configPath = path.join(userDataDir, "Configuration", "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** The local application origin for a desktop config. */
function appOrigin(config) {
  if (!config || !Number.isInteger(config.appPort)) return null;
  return `http://127.0.0.1:${config.appPort}`;
}

/** The first `name=value` pair of a Set-Cookie header, or "". */
function sessionCookieFrom(headers) {
  const raw = typeof headers?.get === "function" ? headers.get("set-cookie") : headers;
  return (raw || "").split(";")[0] || "";
}

/**
 * The environment that used to switch the packaged build into test mode.
 * Set on one launch only, so the harness can prove it is inert now.
 */
function legacyBypassEnvironment(markerPath) {
  return {
    DESKTOP_SMOKE_MARKER: markerPath,
    DESKTOP_SMOKE_BOOTSTRAP: "1",
    DESKTOP_SMOKE_PACKAGED_PROBE: "1",
    LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK: "1",
  };
}

/**
 * Scan shipped bytes for the #1194 markers and Central routes.
 *
 * `readFile` is injectable so the check is unit-testable without a Windows
 * build; in production it reads `resources/app.asar` (raw bytes — the markers
 * are plain UTF-8 in the archive) and walks the staged runtime.
 */
function scanShippedPayload({ resourcesDir, readFile = fs.readFileSync, walk = walkFiles }) {
  const findings = [];
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) {
    return [{ id: "payload-shape", path: asarPath, description: "app.asar is missing; nothing was inspected" }];
  }
  const asar = readFile(asarPath);
  for (const finding of rules.scanTextBuffer(asar, "app.asar")) findings.push({ ...finding, path: `app.asar:${finding.marker}` });

  const runtimeDir = path.join(resourcesDir, "desktop-runtime");
  const runtimeFiles = walk(runtimeDir);
  for (const relative of runtimeFiles) {
    const normalized = relative.replace(/\\/g, "/");
    for (const finding of rules.scanPath(normalized)) findings.push(finding);
    const absolute = path.join(runtimeDir, relative);
    const stats = fs.statSync(absolute);
    // Configuration JSON and fonts are the bulk of the small files; skipping
    // nothing would re-read the whole 600 MiB runtime on every run. Route
    // bundles and server code are text and are scanned.
    if (!/\.(?:cjs|js|mjs|json|html|rsc|body|txt)$/.test(relative)) continue;
    if (stats.size > 64 * 1024 * 1024) continue;
    findings.push(...rules.scanTextBuffer(readFile(absolute), `desktop-runtime:${normalized}`));
  }
  const deduped = new Map();
  for (const finding of findings) deduped.set(`${finding.id}|${finding.path}`, finding);
  return [...deduped.values()];
}

function walkFiles(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of walkFiles(absolute)) files.push(path.join(entry.name, nested));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }
  return files;
}

/* ------------------------------------------------------------------ *
 * Process + HTTP plumbing
 * ------------------------------------------------------------------ */

async function httpJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
    redirect: "manual",
  });
  const text = await response.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function waitFor(description, predicate, { timeoutMs = READY_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      fail(`${description} did not become true within ${Math.round(timeoutMs / 1000)}s${lastError ? ` (last error: ${lastError.message})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Pre-write the storage-location marker so a first launch never opens the
 * "where should business data live?" dialog an unattended run cannot answer.
 *
 * This is ordinary product configuration (the same file the wizard writes),
 * not a test hook: the release has no "skip dialogs" switch, by design.
 */
function prepareProfile(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const marker = path.join(userDataDir, "storage-location.json");
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ root: userDataDir, setAt: new Date().toISOString() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const acceptanceDir = path.join(userDataDir, "acceptance");
  fs.mkdirSync(acceptanceDir, { recursive: true });
}

function ownerCredentialsPath(userDataDir) {
  return path.join(userDataDir, "acceptance", "owner.json");
}

function readOwnerCredentials(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(ownerCredentialsPath(userDataDir), "utf8"));
  } catch {
    return null;
  }
}

function writeOwnerCredentials(userDataDir, credentials) {
  fs.writeFileSync(ownerCredentialsPath(userDataDir), `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function desktopLogs(userDataDir) {
  // Both folder layouts, because the smoke run can start on either side of the
  // Configuration/Data/Backup/Logs migration (issue #985 acceptance).
  return [path.join(userDataDir, "Logs", "desktop.log"), path.join(userDataDir, "logs", "desktop.log")];
}

function logOffsets(userDataDir) {
  return desktopLogs(userDataDir).map((log) => (fs.existsSync(log) ? fs.statSync(log).size : 0));
}

function assertCleanShutdownLog(userDataDir, stage, offsets) {
  desktopLogs(userDataDir).forEach((log, index) => {
    if (!fs.existsSync(log)) return;
    const text = fs.readFileSync(log, "utf8").slice(offsets[index] ?? 0);
    const offending = text.split(/\r?\n/).filter((line) => /done is not a function/i.test(line));
    if (offending.length) fail(`${stage} logged an embedded-postgres exit-hook failure:\n${offending.join("\n")}`);
  });
}

function diagnosticTail(userDataDir) {
  const logs = desktopLogs(userDataDir);
  for (const log of logs) {
    if (fs.existsSync(log)) return `\nDesktop log tail (${log}):\n${fs.readFileSync(log, "utf8").slice(-16_384)}`;
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * One launch
 * ------------------------------------------------------------------ */

class InstalledApplication {
  constructor({ executable, userDataDir, environment = {} }) {
    this.executable = executable;
    this.userDataDir = userDataDir;
    this.environment = environment;
    this.child = null;
    this.exited = null;
  }

  async start() {
    const child = spawn(this.executable, [`--user-data-dir=${this.userDataDir}`], {
      env: { ...process.env, ...this.environment },
      windowsHide: true,
      stdio: "inherit",
    });
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
    });
    currentStage = "waiting for the installed application to answer /api/health";
    const origin = await waitFor("the installed application's HTTP server", async () => {
      // A crash or an early exit must fail the run at once instead of waiting
      // out the whole readiness budget with no diagnostic.
      if (child.exitCode !== null) {
        throw new Error(`the application exited before it was ready (code ${child.exitCode})${diagnosticTail(this.userDataDir)}`);
      }
      const config = readDesktopConfig(this.userDataDir);
      const candidate = appOrigin(config);
      if (!candidate) return null;
      const health = await httpJson(`${candidate}/api/health`).catch(() => null);
      return health?.status === 200 ? candidate : null;
    });
    this.origin = origin;
    this.config = readDesktopConfig(this.userDataDir);
    currentStage = "the application is running";
    log(`ready at ${origin} (instance ${this.config?.instanceId ?? "unknown"})`);
    return origin;
  }

  /** Resolve true once the process exits, false after `budgetMs`. */
  async waitForExit(budgetMs) {
    const settled = await Promise.race([
      this.exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), budgetMs)),
    ]);
    return settled === true;
  }

  /**
   * Ask the window to close and wait for the process to run its own quit
   * path (backend stop, postmaster shutdown). A forced kill would make the
   * "clean shutdown" assertions meaningless, so it is a failure, not a
   * fallback.
   */
  async stop(stage) {
    if (!this.child || this.child.exitCode !== null) return this.exited;
    // Ask the window to close, which is the product's own quit path
    // (`window-all-closed` -> `app.quit()` -> `before-quit` -> cleanup).
    //
    // Two attempts, because neither is universally reliable on a CI runner:
    // `CloseMainWindow()` posts WM_CLOSE to the process's main window, and
    // `taskkill` without `/F` asks a window to close too. A force kill is
    // never a fallback here — if neither gets a clean exit, that *is* the
    // finding this step exists for.
    if (process.platform === "win32") {
      spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `$null = (Get-Process -Id ${this.child.pid}).CloseMainWindow()`],
        { windowsHide: true, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const exitedEarly = await this.waitForExit(Math.min(30_000, QUIT_TIMEOUT_MS));
      if (!exitedEarly) {
        spawnSync("taskkill", ["/pid", String(this.child.pid)], {
          windowsHide: true,
          encoding: "utf8",
          timeout: COMMAND_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
      }
    } else {
      this.child.kill("SIGTERM");
    }
    const outcome = await Promise.race([
      this.exited,
      new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), QUIT_TIMEOUT_MS)),
    ]);
    if (outcome.code === "timeout") {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(this.child.pid), "/t", "/f"], {
          windowsHide: true,
          timeout: COMMAND_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
      } else {
        this.child.kill("SIGKILL");
      }
      fail(`${stage} did not exit within ${QUIT_TIMEOUT_MS / 1000}s of a graceful close; it was force-stopped`);
    }
    if (outcome.error) fail(`${stage} could not be monitored: ${outcome.error.message}`);
    if (outcome.code !== 0) fail(`${stage} exited ${outcome.code ?? outcome.signal} instead of quitting cleanly`);
    this.assertNoPostmasterPid(stage);
    return outcome;
  }

  assertNoPostmasterPid(stage) {
    for (const relative of [path.join("Data", "pgdata", "postmaster.pid"), path.join("pgdata", "postmaster.pid")]) {
      if (fs.existsSync(path.join(this.userDataDir, relative))) {
        fail(`PostgreSQL postmaster.pid remained after ${stage} (${relative})`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Acceptance steps
 * ------------------------------------------------------------------ */

async function assertLegacyBypassIsInert({ executable, userDataDir, freshProfile }) {
  currentStage = "legacy-bypass launch (the removed test switches must be inert)";
  const markerPath = path.join(userDataDir, "acceptance", "smoke-marker.json");
  fs.rmSync(markerPath, { force: true });
  const app = new InstalledApplication({
    executable,
    userDataDir,
    environment: legacyBypassEnvironment(markerPath),
  });
  try {
    const origin = await app.start();
    const state = await httpJson(`${origin}/api/setup/state`);
    if (state.status !== 200) fail(`setup/state answered ${state.status} with the legacy bypass variables set`);

    // The probe used to write this marker and exit 0. Nothing may write it now.
    if (fs.existsSync(markerPath)) {
      fail(
        "the installed release honoured DESKTOP_SMOKE_MARKER and wrote a smoke marker — a test-only launch path still exists in the packaged bytes",
      );
    }
    if (freshProfile) {
      if (state.json?.needsBootstrap !== true) {
        fail("a fresh profile with the legacy bypass variables set did not report needsBootstrap — an owner may have been created by test code");
      }
      // The removed branch's account must not exist, and its password must not work.
      const known = await httpJson(`${origin}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "packaged-runtime@example.invalid", password: "Packaged-Test-Password-2026" }),
      });
      if (known.status === 200) fail("the removed smoke owner's known password still signs in");
    }
    await app.stop("legacy-bypass launch");
  } catch (error) {
    await app.stop("legacy-bypass launch").catch(() => {});
    throw error;
  }
}

async function bootstrapOwner(origin, userDataDir) {
  currentStage = "first-run bootstrap through /api/setup/bootstrap";
  const password = `Acceptance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-Aa1!`;
  const email = `desktop-acceptance-${Date.now().toString(36)}@example.invalid`;
  const response = await httpJson(`${origin}/api/setup/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessName: "Desktop Acceptance Business",
      locationName: "Windows Acceptance Site",
      ownerName: "Acceptance Owner",
      ownerPhone: "09121234567",
      email,
      password,
      industry: "food_service",
      // Connected mode is a real product path that creates a local owner
      // without any Cloud round-trip, so the packaged test needs no mock
      // activation service (which is exactly what #1194 removed).
      deploymentMode: "connected",
    }),
  });
  if (response.status !== 200) {
    fail(`first-run bootstrap answered ${response.status}: ${response.text.slice(0, 500)}`);
  }
  const cookie = sessionCookieFrom(response.headers);
  if (!cookie) fail("first-run bootstrap returned no session cookie");
  const me = await httpJson(`${origin}/api/auth/me`, { headers: { cookie } });
  if (me.status !== 200) fail(`/api/auth/me answered ${me.status} immediately after bootstrap`);
  writeOwnerCredentials(userDataDir, { email, password });
  log("first-run bootstrap created the Owner and signed them in");
  return { email, password, cookie };
}

/**
 * Full Offline first-run enrollment (issue #974 path), against a real staging
 * Cloud when the release job supplies one.
 *
 * Deliberately *not* a mock: #1194 removed the mock activation service from
 * the shipped build, so the only honest way to exercise this path on release
 * bytes is to point them at an HTTPS Cloud origin with a real enrollment
 * token. Without that configuration the phase reports `skipped` and the
 * Hybrid coverage above still runs; with it, the packaged installer must
 * redeem the token, persist the activation record, sign the Owner in and
 * refuse a second bootstrap.
 */
async function runFullOfflinePhase({ executable }) {
  const cloudUrl = process.env.DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL?.trim();
  const token = process.env.DESKTOP_ACCEPTANCE_OFFLINE_TOKEN?.trim();
  if (!cloudUrl || !token) {
    return {
      status: "skipped",
      reason:
        "no staging Cloud supplied; set DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL and DESKTOP_ACCEPTANCE_OFFLINE_TOKEN to exercise Full Offline enrollment on the release bytes",
    };
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "biza-offline-acceptance-"));
  prepareProfile(profile);
  const app = new InstalledApplication({ executable, userDataDir: profile });
  let started = false;
  try {
    const origin = await app.start();
    started = true;

    // Preflight: validates the token against Cloud without consuming it or
    // creating local rows (the wizard's «Verify» button).
    const verifyOnly = await httpJson(`${origin}/api/setup/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyOnly: true, cloudUrl, offlineToken: token }),
    });
    if (verifyOnly.status !== 200) {
      fail(`Full Offline token preflight answered ${verifyOnly.status}: ${verifyOnly.text.slice(0, 400)}`);
    }

    const email = `offline-acceptance-${Date.now().toString(36)}@example.invalid`;
    const password = `Offline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-Aa1!`;
    const bootstrap = await httpJson(`${origin}/api/setup/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName: "Full Offline Acceptance Business",
        locationName: "Offline Acceptance Site",
        ownerName: "Offline Acceptance Owner",
        email,
        password,
        industry: "food_service",
        deploymentMode: "local",
        cloudUrl,
        offlineToken: token,
      }),
    });
    if (bootstrap.status !== 200) fail(`Full Offline bootstrap answered ${bootstrap.status}: ${bootstrap.text.slice(0, 400)}`);
    const cookie = sessionCookieFrom(bootstrap.headers);
    if (!cookie) fail("Full Offline bootstrap returned no session cookie");
    if ((await httpJson(`${origin}/api/auth/me`, { headers: { cookie } })).status !== 200) {
      fail("/api/auth/me answered non-200 after Full Offline bootstrap");
    }
    const state = await httpJson(`${origin}/api/setup/state`, { headers: { cookie } });
    if (state.json?.needsBootstrap === true) fail("setup/state still reports needsBootstrap after Full Offline bootstrap");
    // Same protection as Hybrid: an established install cannot be re-bootstrapped.
    const replay = await httpJson(`${origin}/api/setup/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName: "Second Offline Attempt",
        locationName: "Second Site",
        ownerName: "Intruder",
        email: "second-offline@example.invalid",
        password: "Second-Offline-Password-2026",
        industry: "food_service",
        deploymentMode: "local",
        cloudUrl,
        offlineToken: token,
      }),
    });
    if (replay.status !== 409) fail(`a second Full Offline bootstrap answered ${replay.status}; expected 409`);
    await app.stop("Full Offline acceptance launch");
    started = false;
    return { status: "passed", cloudOrigin: new URL(cloudUrl).origin, profile };
  } finally {
    if (started) await app.stop("failed Full Offline acceptance run").catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function assertLogin(origin, { email, password }) {
  const wrong = await httpJson(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `${password}-wrong` }),
  });
  if (wrong.status === 200) fail("a wrong password signed in");
  const right = await httpJson(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (right.status !== 200) fail(`owner login answered ${right.status} after restart: ${right.text.slice(0, 300)}`);
  const cookie = sessionCookieFrom(right.headers);
  if (!cookie) fail("owner login returned no session cookie");
  return cookie;
}

async function assertPlatformRealmDenied(origin, { tenantCookie, forgedPlatformCookie }) {
  for (const probe of PLATFORM_DENIAL_PATHS) {
    const response = await httpJson(`${origin}${probe.path}`, {
      method: probe.method,
      headers: {
        ...(probe.body ? { "Content-Type": "application/json" } : {}),
        // Cross-realm replay: a real tenant session presented as the platform
        // cookie, and a syntactically plausible forged platform cookie.
        cookie: `pos_session=${extractCookieValue(tenantCookie)}; pos_platform_session=${forgedPlatformCookie}`,
      },
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    });
    if (response.status !== 404) {
      fail(
        `${probe.method} ${probe.path} answered ${response.status} on the installed site runtime; expected 404 (no platform realm on a desktop install)`,
      );
    }
  }
  log("the installed runtime denied every platform-realm probe with 404");
}

function extractCookieValue(cookieHeader) {
  return String(cookieHeader || "").split(";")[0].split("=").slice(1).join("=");
}

async function runAcceptance() {
  const dist = path.resolve(__dirname, "..", "dist", "win-unpacked");
  const executable = process.env.DESKTOP_EXECUTABLE || path.join(dist, "Bizamiz.exe");
  if (!fs.existsSync(executable)) fail(`packaged executable is missing: ${executable}`);
  const userDataDir = process.env.DESKTOP_ACCEPTANCE_USER_DATA
    ? path.resolve(process.env.DESKTOP_ACCEPTANCE_USER_DATA)
    : fs.mkdtempSync(path.join(os.tmpdir(), "biza-desktop-acceptance-"));

  prepareProfile(userDataDir);
  const previouslyInitialized = readDesktopConfig(userDataDir) !== null;
  log(`executable: ${executable}`);
  log(`profile: ${userDataDir}${previouslyInitialized ? " (existing install)" : " (fresh install)"}`);

  /* 1 — the installed bytes carry no test bootstrap and no Central console. */
  const resourcesDir = path.join(path.dirname(executable), "resources");
  if (fs.existsSync(resourcesDir)) {
    const findings = scanShippedPayload({ resourcesDir });
    if (findings.length) {
      fail(
        `the installed payload still contains forbidden marker(s): ${findings
          .map((finding) => `${finding.id}@${finding.path}`)
          .join(", ")}`,
      );
    }
    log("installed payload scan found no test bootstrap, no Central platform routes and no private key material");
  } else {
    log("resources directory not found next to the executable; byte scan skipped for this layout");
  }

  /* 2 — the old bypass variables are inert on the release that was installed. */
  await assertLegacyBypassIsInert({ executable, userDataDir, freshProfile: !previouslyInitialized });

  /* 3 — real first run, restart and the platform-realm probes. */
  const running = { current: null };
  try {
    return await runLaunchPhases({ executable, userDataDir, previouslyInitialized, running });
  } finally {
    // A failed assertion must not leave an application (and its PostgreSQL
    // child) running on the acceptance machine.
    if (running.current) await running.current.stop("failed acceptance run").catch(() => {});
  }
}

/**
 * The launch phases proper. Split from `runAcceptance` so every path — success
 * or failure — goes through the `finally` that stops a live application.
 */
async function runLaunchPhases({ executable, userDataDir, previouslyInitialized, running }) {
  const offsetsBefore = logOffsets(userDataDir);
  const first = new InstalledApplication({ executable, userDataDir });
  running.current = first;
  const origin = await first.start();
  const stateBefore = await httpJson(`${origin}/api/setup/state`);
  if (stateBefore.status !== 200) fail(`setup/state answered ${stateBefore.status}`);

  let credentials = readOwnerCredentials(userDataDir);
  if (stateBefore.json?.needsBootstrap === true) {
    const created = await bootstrapOwner(origin, userDataDir);
    credentials = { email: created.email, password: created.password };
    const stateAfter = await httpJson(`${origin}/api/setup/state`, { headers: { cookie: created.cookie } });
    if (stateAfter.json?.needsBootstrap === true) fail("setup/state still reports needsBootstrap after a successful bootstrap");
  } else if (!credentials) {
    log("profile was initialized by another build and holds no acceptance credentials; login assertions are skipped");
  }

  let tenantCookie = "";
  if (credentials) {
    tenantCookie = await assertLogin(origin, credentials);
    log("owner login accepted the real password and rejected a wrong one");
  }

  /* 4 — site runtime denies the Central realm, including cross-realm replay. */
  await assertPlatformRealmDenied(origin, {
    tenantCookie,
    forgedPlatformCookie: "eyJhbGciOiJIUzI1NiJ9.eyJyZWFsbSI6InBsYXRmb3JtIiwicGFkbWluIjoiZm9yZ2VkIn0.invalid",
  });

  const firstInstanceId = first.config?.instanceId ?? null;
  await first.stop("first acceptance launch");
  running.current = null;
  assertCleanShutdownLog(userDataDir, "first acceptance launch", offsetsBefore);

  /* 5 — restart: identity persists, the install cannot be re-bootstrapped. */
  const secondOffsets = logOffsets(userDataDir);
  const second = new InstalledApplication({ executable, userDataDir });
  running.current = second;
  const secondOrigin = await second.start();
  if (firstInstanceId && second.config?.instanceId !== firstInstanceId) {
    fail("desktop instance identity did not persist across restart");
  }
  const state = await httpJson(`${secondOrigin}/api/setup/state`);
  if (state.json?.needsBootstrap !== false) fail("an initialized install reports needsBootstrap after restart");

  const replay = await httpJson(`${secondOrigin}/api/setup/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessName: "Second Business Attempt",
      locationName: "Second Site",
      ownerName: "Intruder",
      ownerPhone: "09121234567",
      email: "second-bootstrap@example.invalid",
      password: "Second-Bootstrap-Password-2026",
      industry: "food_service",
      deploymentMode: "connected",
    }),
  });
  if (replay.status !== 409) {
    fail(`a second bootstrap on an initialized install answered ${replay.status}; expected 409 already_initialized`);
  }
  if (credentials) {
    await assertLogin(secondOrigin, credentials);
    log("existing Owner credentials still work after restart");
  }
  await second.stop("restart acceptance launch");
  running.current = null;
  assertCleanShutdownLog(userDataDir, "restart acceptance launch", secondOffsets);

  const report = {
    ok: true,
    executable,
    profile: userDataDir,
    mode: previouslyInitialized ? "existing-install" : "fresh-install",
    instanceIdPersisted: Boolean(firstInstanceId && second.config?.instanceId === firstInstanceId),
    platformRealmDenied: true,
    legacyBypassInert: true,
    fullOffline: await runFullOfflinePhase({ executable }),
    timestamp: new Date().toISOString(),
  };
  const reportPath = process.env.DESKTOP_ACCEPTANCE_REPORT
    ? path.resolve(process.env.DESKTOP_ACCEPTANCE_REPORT)
    : path.join(os.tmpdir(), `biza-desktop-acceptance-${process.pid}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`acceptance passed; report written to ${reportPath}`);
  return report;
}

/* ------------------------------------------------------------------ */

/**
 * Start the whole-run ceiling. It is deliberately *not* `unref`ed: if every
 * other handle is gone the process is exiting anyway, and while a wedge is
 * live this timer is what ends it.
 */
function startWatchdog() {
  const timer = setTimeout(() => {
    console.error(`acceptance did not finish within ${Math.round(WATCHDOG_MS / 1000)}s`);
    console.error(`last stage: ${currentStage}`);
    const profile = process.env.DESKTOP_ACCEPTANCE_USER_DATA;
    if (profile) console.error(diagnosticTail(path.resolve(profile)));
    process.exit(1);
  }, WATCHDOG_MS);
  timer.unref?.();
  return timer;
}

if (require.main === module) {
  startWatchdog();
  runAcceptance().catch((error) => {
    console.error(`last stage: ${currentStage}`);
    console.error(error);
    const profile = process.env.DESKTOP_ACCEPTANCE_USER_DATA;
    if (profile) console.error(diagnosticTail(path.resolve(profile)));
    // GitHub's public job page exposes annotations even when raw Actions logs
    // require authentication. Keep the root cause visible to package reviewers.
    if (process.env.GITHUB_ACTIONS === "true") {
      const annotation = String(error?.stack || error)
        .slice(0, 8_000)
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.error(`::error title=Packaged desktop acceptance failed::${annotation}`);
    }
    process.exit(1);
  });
}

module.exports = {
  PLATFORM_DENIAL_PATHS,
  assertLogin,
  assertPlatformRealmDenied,
  legacyBypassEnvironment,
  readDesktopConfig,
  readOwnerCredentials,
  runAcceptance,
  scanShippedPayload,
  sessionCookieFrom,
  appOrigin,
  prepareProfile,
  walkFiles,
};
