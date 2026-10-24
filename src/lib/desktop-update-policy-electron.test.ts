/**
 * The device-side half of the central update policy. These run the real
 * electron/update-policy.js and electron/update-engine.js (no Electron needed):
 * the safe-window rules, the fail-closed safety gate, the rollback guard on a
 * delivered document, and that unattended install stays off unless an
 * unexpired central policy explicitly allows it.
 */
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_POLICY,
  POLICY_KEYS,
  validateDesktopUpdatePolicyPatch,
} from "./desktop-update-policy";

const require = createRequire(import.meta.url);
const policyModule = require("../../electron/update-policy.js") as {
  AUTO_INSTALL_GRACE_MS: number;
  DEFAULT_POLICY: Record<string, unknown>;
  MIN_FREE_BYTES: number;
  decideAutoInstall: (input: { policy: Record<string, any> | null; expiresAt?: string; now: Date; postponedUntil?: string | null }) => { allowed: boolean; reason: string };
  evaluateInstallSafety: (facts: unknown, policy: Record<string, any> | null) => { safe: boolean; blockers: string[] };
  isInMaintenanceWindow: (window: Record<string, any>, now: Date) => boolean;
  parsePolicyDocument: (value: unknown) => { ok: true; document: Record<string, any> } | { ok: false; error: string };
  sanitizePolicy: (value: unknown) => Record<string, any> | null;
};
const { DesktopUpdateEngine } = require("../../electron/update-engine.js") as {
  DesktopUpdateEngine: new (options: Record<string, unknown>) => any;
};

const tehran = (iso: string) => new Date(iso); // all instants below are UTC; Tehran is UTC+03:30
const windowOf = (over: Record<string, unknown> = {}) =>
  ({ timezone: "Asia/Tehran", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "02:00", end: "05:00", ...over });

/**
 * A deterministic instant inside the fixture's window.
 *
 * `engineFixture` opens the window as 00:00–23:59, and `isInMaintenanceWindow`
 * tests `[start, end)` in whole minutes — so that window still excludes the
 * day's final minute. Driving a tick from `new Date()` therefore makes every
 * "expects scheduled" assertion fail when the suite happens to run between
 * 23:55 and 00:00 Tehran: the first tick is accepted, and `t0 + 4 min` (or the
 * grace period) lands on 23:59. That is not hypothetical — the unit job ran
 * 20:21–20:27Z on 2026-10-21, i.e. 23:51–23:57 Tehran, and failed here.
 *
 * Anchored at 12:00 Tehran on the current (or previous) day, so it is always
 * inside the window, hours away from either edge, and never ahead of the real
 * clock — the fixture's `expiresAt` is real-now + 1h, which must still cover it.
 */
function inWindowNow(): Date {
  const tehranOffsetMs = 3.5 * 3_600_000; // Iran has not observed DST since 2022.
  const dayMs = 86_400_000;
  const local = Date.now() + tehranOffsetMs;
  const noon = Math.floor(local / dayMs) * dayMs + 12 * 3_600_000;
  return new Date((noon > local ? noon - dayMs : noon) - tehranOffsetMs);
}

describe("server and device agree on the policy vocabulary", () => {
  it("the device defaults are the server defaults", () => {
    expect(policyModule.DEFAULT_POLICY).toEqual(PLATFORM_DEFAULT_POLICY);
  });
  it("every key the server can store, the device understands; every patch the server accepts, the device accepts", () => {
    const sample = validateDesktopUpdatePolicyPatch({
      automaticChecks: false, backgroundDownload: true, automaticInstall: "safe_window", channel: "beta",
      targetReleaseId: "11111111-1111-4111-8111-111111111111", hold: true,
      maintenance: { timezone: "Europe/Berlin", daysOfWeek: [1, 2], start: "22:00", end: "01:00" },
      deferUntil: "2026-12-01T00:00:00Z", deadlineAt: "2026-12-10T00:00:00Z", meteredNetworkDownload: true,
      minimumBatteryPercent: 30, allowCriticalOverride: true,
    });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    expect(Object.keys(sample.patch).sort()).toEqual([...POLICY_KEYS].sort());
    const device = policyModule.sanitizePolicy(sample.patch);
    expect(device).toMatchObject(sample.patch);
  });
  it("rejects values the server would have rejected, instead of half-applying", () => {
    expect(policyModule.sanitizePolicy({ automaticInstall: "always" })).toBeNull();
    expect(policyModule.sanitizePolicy({ maintenance: windowOf({ start: "03:00", end: "03:00" }) })).toBeNull();
    expect(policyModule.sanitizePolicy({ channel: "nightly" })).toBeNull();
  });
  it("ignores keys it does not know so a newer Central cannot brick an older desktop", () => {
    expect(policyModule.sanitizePolicy({ futureKey: 1, hold: true })).toMatchObject({ hold: true });
  });
});

describe("maintenance window", () => {
  it("is read in the window's own timezone", () => {
    // 22:45Z = 02:15 Tehran (inside), 21:45Z = 01:15 (before), 01:45Z = 05:15 (after).
    expect(policyModule.isInMaintenanceWindow(windowOf(), tehran("2026-10-16T22:45:00Z"))).toBe(true);
    expect(policyModule.isInMaintenanceWindow(windowOf(), tehran("2026-10-16T21:45:00Z"))).toBe(false);
    expect(policyModule.isInMaintenanceWindow(windowOf(), tehran("2026-10-17T01:45:00Z"))).toBe(false);
  });
  it("end is exclusive", () => {
    expect(policyModule.isInMaintenanceWindow(windowOf(), tehran("2026-10-17T01:30:00Z"))).toBe(false); // 05:00 Tehran
    expect(policyModule.isInMaintenanceWindow(windowOf(), tehran("2026-10-17T01:29:00Z"))).toBe(true);
  });
  it("a window across midnight belongs to the day it starts on", () => {
    const overnight = windowOf({ start: "23:00", end: "04:00", daysOfWeek: [5] }); // Friday night only
    // Friday 2026-10-16 23:30 Tehran = 20:00Z.
    expect(policyModule.isInMaintenanceWindow(overnight, tehran("2026-10-16T20:00:00Z"))).toBe(true);
    // Saturday 01:30 Tehran = Friday 22:00Z — still the Friday-night window.
    expect(policyModule.isInMaintenanceWindow(overnight, tehran("2026-10-16T22:00:00Z"))).toBe(true);
    // Saturday 23:30 Tehran is not (Saturday is not allowed); nor is Friday 01:30 Tehran.
    expect(policyModule.isInMaintenanceWindow(overnight, tehran("2026-10-17T20:00:00Z"))).toBe(false);
    expect(policyModule.isInMaintenanceWindow(overnight, tehran("2026-10-15T22:00:00Z"))).toBe(false);
  });
});

describe("decideAutoInstall", () => {
  const now = tehran("2026-10-16T23:00:00Z"); // 02:30 Tehran, in window
  const expiresAt = "2026-10-23T00:00:00.000Z";
  const policy = (over: Record<string, unknown> = {}) =>
    ({ ...PLATFORM_DEFAULT_POLICY, automaticInstall: "safe_window", ...over });

  it("allows only an explicit safe_window policy, unexpired, inside the window", () => {
    expect(policyModule.decideAutoInstall({ policy: policy(), expiresAt, now })).toEqual({ allowed: true, reason: "safe_window" });
  });
  it("default and 'off' never install unattended; no central policy never installs", () => {
    expect(policyModule.decideAutoInstall({ policy: { ...PLATFORM_DEFAULT_POLICY }, expiresAt, now }).reason).toBe("automatic_install_off");
    expect(policyModule.decideAutoInstall({ policy: null, now }).reason).toBe("no_central_policy");
  });
  it("an expired policy cannot start an install (Full Offline cannot be driven by a stale approval)", () => {
    expect(policyModule.decideAutoInstall({ policy: policy(), expiresAt: "2026-10-16T22:59:59.000Z", now }).reason).toBe("policy_expired");
  });
  it("hold, deferral, local postpone and the window each say no, with their reason", () => {
    expect(policyModule.decideAutoInstall({ policy: policy({ hold: true }), expiresAt, now }).reason).toBe("hold");
    expect(policyModule.decideAutoInstall({ policy: policy({ deferUntil: "2026-10-20T00:00:00Z" }), expiresAt, now }).reason).toBe("deferred");
    expect(policyModule.decideAutoInstall({ policy: policy(), expiresAt, now, postponedUntil: "2026-10-17T00:00:00Z" }).reason).toBe("postponed_locally");
    expect(policyModule.decideAutoInstall({ policy: policy(), expiresAt, now: tehran("2026-10-16T10:00:00Z") }).reason).toBe("outside_window");
  });
  it("the critical override waives deferral, postpone and window — only once the deadline has passed, only if allowed", () => {
    const outside = tehran("2026-10-16T10:00:00Z");
    const critical = policy({ allowCriticalOverride: true, deadlineAt: "2026-10-15T00:00:00Z", deferUntil: "2026-10-20T00:00:00Z" });
    expect(policyModule.decideAutoInstall({ policy: critical, expiresAt, now: outside, postponedUntil: "2026-10-17T00:00:00Z" }))
      .toEqual({ allowed: true, reason: "critical_deadline" });
    expect(policyModule.decideAutoInstall({ policy: { ...critical, allowCriticalOverride: false }, expiresAt, now: outside }).allowed).toBe(false);
    expect(policyModule.decideAutoInstall({ policy: { ...critical, deadlineAt: "2026-10-30T00:00:00Z" }, expiresAt, now: outside }).allowed).toBe(false);
  });
  it("the critical override never waives hold or turning unattended install off", () => {
    const critical = { allowCriticalOverride: true, deadlineAt: "2026-10-15T00:00:00Z" };
    expect(policyModule.decideAutoInstall({ policy: policy({ ...critical, hold: true }), expiresAt, now }).reason).toBe("hold");
    expect(policyModule.decideAutoInstall({ policy: policy({ ...critical, automaticInstall: "off" }), expiresAt, now }).reason).toBe("automatic_install_off");
  });
});

describe("evaluateInstallSafety", () => {
  const free = policyModule.MIN_FREE_BYTES + 1;
  const quiet = { openShifts: 0, openOrders: 0, pendingPrintJobs: 0, freeDiskBytes: free };

  it("is safe only when nothing is open and there is room", () => {
    expect(policyModule.evaluateInstallSafety(quiet, null)).toEqual({ safe: true, blockers: [] });
  });
  it("an open shift, an open order or a print in flight each block, and are all reported", () => {
    expect(policyModule.evaluateInstallSafety({ ...quiet, openShifts: 1, openOrders: 2, pendingPrintJobs: 1 }, null))
      .toEqual({ safe: false, blockers: ["open_shift", "open_order", "print_job_in_flight"] });
  });
  it("fails closed when a fact is missing or not a number — 'could not tell' is not 'nothing open'", () => {
    expect(policyModule.evaluateInstallSafety(null, null)).toEqual({ safe: false, blockers: ["safety_check_unavailable"] });
    expect(policyModule.evaluateInstallSafety({ ...quiet, openOrders: undefined }, null).blockers).toContain("safety_check_unavailable");
    expect(policyModule.evaluateInstallSafety({ ...quiet, openShifts: "0" }, null).safe).toBe(false);
    expect(policyModule.evaluateInstallSafety({ ...quiet, freeDiskBytes: undefined }, null).blockers).toContain("disk_space_unknown");
    expect(policyModule.evaluateInstallSafety({ ...quiet, freeDiskBytes: 1 }, null).blockers).toContain("disk_space_low");
  });
  it("battery gate applies on battery power only, and unknown charge counts as low", () => {
    const policy = { minimumBatteryPercent: 50 };
    expect(policyModule.evaluateInstallSafety({ ...quiet, onBatteryPower: false }, policy).safe).toBe(true);
    expect(policyModule.evaluateInstallSafety({ ...quiet, onBatteryPower: true }, policy).blockers).toEqual(["battery_low"]);
    expect(policyModule.evaluateInstallSafety({ ...quiet, onBatteryPower: true, batteryPercent: 80 }, policy).safe).toBe(true);
    expect(policyModule.evaluateInstallSafety({ ...quiet, onBatteryPower: true, batteryPercent: 20 }, policy).safe).toBe(false);
  });
});

describe("parsePolicyDocument", () => {
  const valid = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, policyVersion: 5, issuedAt: "2026-10-16T00:00:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z",
    businessId: "b", deviceId: "POS-1", reason: "x", actor: "platform", auditRef: "business:5",
    policy: { automaticInstall: "safe_window" }, ...over,
  });
  it("accepts a well-formed document and fills defaults for keys it omits", () => {
    const parsed = policyModule.parsePolicyDocument(valid());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.policy).toMatchObject({ automaticInstall: "safe_window", backgroundDownload: false });
  });
  it.each([
    [{ schemaVersion: 2 }, "policy_schema_unsupported"],
    [{ policyVersion: -1 }, "policy_version_invalid"],
    [{ policyVersion: 1.5 }, "policy_version_invalid"],
    [{ expiresAt: "2026-10-15T00:00:00.000Z" }, "policy_lifetime_invalid"],
    [{ expiresAt: "2027-12-31T00:00:00.000Z" }, "policy_lifetime_invalid"],
    [{ issuedAt: "soon" }, "policy_lifetime_invalid"],
    [{ businessId: "" }, "policy_identity_missing"],
    [{ policy: { hold: "yes" } }, "policy_values_invalid"],
  ])("rejects %j", (over, error) => {
    expect(policyModule.parsePolicyDocument(valid(over))).toEqual({ ok: false, error });
  });
});

// ---------------------------------------------------------------------------
// The engine: rollback guard, central-over-local, and the announced install.
// ---------------------------------------------------------------------------
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function engineFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "desktop-policy-engine-")); roots.push(root);
  const app = { getPath: () => root, getVersion: () => "1.0.0" };
  const logger = { warn: () => {}, info: () => {}, error: () => {} };
  const engine = new DesktopUpdateEngine({ app, logger, manifestPublicKey: "unused" });
  const document = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, policyVersion: 10, issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), businessId: "b", deviceId: "POS-1",
    policy: { automaticInstall: "safe_window", backgroundDownload: true, maintenance: windowOf({ start: "00:00", end: "23:59" }) },
    ...over,
  });
  const deliver = async (value: unknown) => { await writeFile(engine.policyPath, JSON.stringify(value)); return engine.applyPersistedPolicy(); };
  return { engine, document, deliver };
}

describe("DesktopUpdateEngine with a central policy", () => {
  it("holds no central policy and installs nothing unattended until one is delivered", async () => {
    const { engine } = await engineFixture();
    expect(engine.state.centralPolicy).toBeNull();
    engine.state.state = "ready_to_install";
    const outcome = await engine.autoInstallTick({ readSafety: async () => ({ openShifts: 0, openOrders: 0, pendingPrintJobs: 0 }) });
    expect(outcome).toEqual({ action: "blocked", reason: "no_central_policy" });
  });

  it("applies a delivered policy over local preferences and keeps local unattended install false", async () => {
    const { engine, document, deliver } = await engineFixture();
    expect(await deliver(document())).toBe(true);
    expect(engine.state.policy).toMatchObject({ automaticChecks: true, backgroundDownload: true, automaticInstall: false });
    // A local attempt to switch background download off does not outrank central policy.
    engine.setPolicy({ backgroundDownload: false, automaticChecks: false });
    expect(engine.state.policy).toMatchObject({ backgroundDownload: true, automaticChecks: true, automaticInstall: false });
  });

  it("refuses an older policy version (rollback) and a replay of the same issue time, but accepts a refresh", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document({ policyVersion: 10, policy: { hold: true } }));
    expect(await deliver(document({ policyVersion: 9, policy: { hold: false } }))).toBe(false);
    expect(engine.state.centralPolicy.policy.hold).toBe(true);
    expect(await deliver(document({ policyVersion: 10, issuedAt: engine.state.centralPolicy.issuedAt, policy: { hold: false } }))).toBe(false);
    expect(engine.state.centralPolicy.policy.hold).toBe(true);
    expect(await deliver(document({ policyVersion: 10, issuedAt: new Date().toISOString(), policy: { hold: true } }))).toBe(true);
    expect(await deliver(document({ policyVersion: 11, policy: { hold: false } }))).toBe(true);
    expect(engine.state.centralPolicy.policy.hold).toBe(false);
  });

  it("ignores a malformed document and keeps the previous one", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    expect(await deliver(document({ policyVersion: 99, policy: { automaticInstall: "root" } }))).toBe(false);
    expect(engine.state.centralPolicy.policyVersion).toBe(10);
  });

  it("announces before it installs: schedule → wait → install, and re-announces if safety lapses", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    engine.state.state = "ready_to_install";
    let safety = { openShifts: 0, openOrders: 0, pendingPrintJobs: 0 };
    const readSystem = async () => ({ freeDiskBytes: policyModule.MIN_FREE_BYTES + 1 });
    const tick = (now: Date) => engine.autoInstallTick({ now, readSafety: async () => safety, readSystem });

    const t0 = inWindowNow();
    expect(await tick(t0)).toEqual({ action: "scheduled" });
    expect(engine.state.autoInstall).toMatchObject({ allowed: true });
    expect(Date.parse(engine.state.autoInstall.scheduledFor) - t0.getTime()).toBe(policyModule.AUTO_INSTALL_GRACE_MS);
    expect(await tick(new Date(t0.getTime() + 60_000))).toEqual({ action: "waiting" });

    safety = { ...safety, openOrders: 1 }; // a table is opened during the grace period
    expect(await tick(new Date(t0.getTime() + 120_000))).toMatchObject({ action: "blocked", reason: "unsafe", blockers: ["open_order"] });
    expect(engine.state.autoInstall.scheduledFor).toBeNull();

    safety = { ...safety, openOrders: 0 };
    const t1 = new Date(t0.getTime() + 240_000);
    expect(await tick(t1)).toEqual({ action: "scheduled" }); // announced again, not installed at once
    const t2 = new Date(t1.getTime() + policyModule.AUTO_INSTALL_GRACE_MS + 1_000);
    expect(await tick(t2)).toEqual({ action: "install" });
  });

  it("an unreadable safety source blocks rather than installs", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    engine.state.state = "ready_to_install";
    const outcome = await engine.autoInstallTick({ readSafety: async () => { throw new Error("db down"); } });
    expect(outcome).toMatchObject({ action: "blocked", reason: "unsafe", blockers: ["safety_check_unavailable"] });
  });

  it("a stale schedule from before a restart is announced again instead of installing immediately", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    engine.state.state = "ready_to_install";
    const readSystem = async () => ({ freeDiskBytes: policyModule.MIN_FREE_BYTES + 1 });
    const now = inWindowNow();
    engine.state.autoInstall = { allowed: true, reason: "safe_window", scheduledFor: new Date(now.getTime() - 3_600_000).toISOString(), blockers: [], postponedUntil: null };
    const outcome = await engine.autoInstallTick({ now, readSafety: async () => ({ openShifts: 0, openOrders: 0, pendingPrintJobs: 0 }), readSystem });
    expect(outcome).toEqual({ action: "scheduled" });
  });

  it("executes a tenant-bound recheck command exactly once and records a durable receipt", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    const command = {
      schemaVersion: 1, id: "11111111-1111-4111-8111-111111111111", sequence: 7, command: "recheck",
      businessId: "b", deviceId: "POS-1", issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(engine.commandPath, JSON.stringify(command));
    expect(await engine.applyPersistedCommand()).toBe(true);
    expect(engine.state.lastCommandSequence).toBe(7);
    expect(engine.state.commandResults).toContainEqual(expect.objectContaining({ id: command.id, status: "executed" }));
    await writeFile(engine.commandPath, JSON.stringify(command));
    expect(await engine.applyPersistedCommand()).toBe(false);
    expect(engine.state.commandResults).toHaveLength(1);
  });

  it("rejects an expired or foreign command without executing it", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    const base = {
      schemaVersion: 1, id: "22222222-2222-4222-8222-222222222222", sequence: 8, command: "recheck",
      businessId: "another-business", deviceId: "POS-1", issuedAt: new Date(Date.now() - 2_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(engine.commandPath, JSON.stringify(base));
    expect(await engine.applyPersistedCommand()).toBe(false);
    expect(engine.state.lastCommandSequence).toBe(0);
    await writeFile(engine.commandPath, JSON.stringify({ ...base, businessId: "b", expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(await engine.applyPersistedCommand()).toBe(false);
    expect(engine.state.lastCommandSequence).toBe(0);
  });

  it("a local postpone is bounded to a day", async () => {
    const { engine, document, deliver } = await engineFixture();
    await deliver(document());
    engine.state.state = "ready_to_install";
    engine.postponeAutoInstall(500);
    const until = Date.parse(engine.state.autoInstall.postponedUntil);
    expect(until - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    expect(until - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const outcome = await engine.autoInstallTick({ readSafety: async () => ({}) });
    expect(outcome).toEqual({ action: "blocked", reason: "postponed_locally" });
  });
});
