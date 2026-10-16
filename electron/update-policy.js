// Device-side half of the central Desktop update policy (issue #981).
//
// Central resolves platform → business → location → device and hands one
// document over an authenticated, device-bound channel (src/lib/
// desktop-update-policy.ts is the server half and the source of the key list).
// Nothing here widens trust: a document only ever narrows or schedules what the
// engine already does. It cannot name an installer URL, an origin, a downgrade,
// or switch off signature / SHA-256 / publisher / backup verification — those
// are not policy fields, and the engine would still enforce them.
//
// Pure and dependency-free so it is unit-tested without Electron.
"use strict";

const AUTOMATIC_INSTALL_MODES = new Set(["off", "safe_window"]);
const CHANNELS = new Set(["stable", "beta", "internal"]);
const MAX_POLICY_LIFETIME_MS = 31 * 24 * 3_600_000;
/** Cushion before an unattended install starts, so a user at the till can see it coming. */
const AUTO_INSTALL_GRACE_MS = 5 * 60_000;
/** A local postpone is a courtesy, not a way to hold an update back indefinitely. */
const MAX_LOCAL_POSTPONE_MS = 24 * 3_600_000;
const MIN_FREE_BYTES = 2 * 1024 ** 3;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_POLICY = Object.freeze({
  automaticChecks: true,
  backgroundDownload: false,
  automaticInstall: "off",
  channel: null,
  targetReleaseId: null,
  hold: false,
  maintenance: Object.freeze({ timezone: "Asia/Tehran", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "02:00", end: "05:00" }),
  deferUntil: null,
  deadlineAt: null,
  meteredNetworkDownload: false,
  minimumBatteryPercent: null,
  allowCriticalOverride: false,
});

function validTimezone(value) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}

function isoOrNull(value) {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Strict about the keys it knows (a malformed value rejects the whole document
 * rather than half-applying it) and blind to keys it does not, so a newer
 * Central can add a field without older desktops refusing the document.
 */
function sanitizePolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = { ...DEFAULT_POLICY, maintenance: { ...DEFAULT_POLICY.maintenance, daysOfWeek: [...DEFAULT_POLICY.maintenance.daysOfWeek] } };
  for (const key of ["automaticChecks", "backgroundDownload", "hold", "meteredNetworkDownload", "allowCriticalOverride"]) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") return null;
    out[key] = raw[key];
  }
  if (raw.automaticInstall !== undefined) {
    if (!AUTOMATIC_INSTALL_MODES.has(raw.automaticInstall)) return null;
    out.automaticInstall = raw.automaticInstall;
  }
  if (raw.channel !== undefined) {
    if (raw.channel !== null && !CHANNELS.has(raw.channel)) return null;
    out.channel = raw.channel;
  }
  if (raw.targetReleaseId !== undefined) {
    if (raw.targetReleaseId !== null && typeof raw.targetReleaseId !== "string") return null;
    out.targetReleaseId = raw.targetReleaseId;
  }
  for (const key of ["deferUntil", "deadlineAt"]) {
    if (raw[key] === undefined) continue;
    const instant = isoOrNull(raw[key]);
    if (instant === undefined) return null;
    out[key] = instant;
  }
  if (raw.minimumBatteryPercent !== undefined) {
    const value = raw.minimumBatteryPercent;
    if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 100)) return null;
    out.minimumBatteryPercent = value;
  }
  if (raw.maintenance !== undefined) {
    const window = raw.maintenance;
    if (
      !window || typeof window !== "object" || typeof window.timezone !== "string" || !validTimezone(window.timezone) ||
      !Array.isArray(window.daysOfWeek) || window.daysOfWeek.length === 0 || window.daysOfWeek.length > 7 ||
      !window.daysOfWeek.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
      typeof window.start !== "string" || !HHMM.test(window.start) ||
      typeof window.end !== "string" || !HHMM.test(window.end) || window.start === window.end
    ) return null;
    out.maintenance = { timezone: window.timezone, daysOfWeek: [...new Set(window.daysOfWeek)].sort((a, b) => a - b), start: window.start, end: window.end };
  }
  return out;
}

/** @returns {{ok:true, document:object}|{ok:false, error:string}} */
function parsePolicyDocument(value) {
  if (!value || typeof value !== "object") return { ok: false, error: "policy_document_invalid" };
  if (value.schemaVersion !== 1) return { ok: false, error: "policy_schema_unsupported" };
  if (!Number.isSafeInteger(value.policyVersion) || value.policyVersion < 0) return { ok: false, error: "policy_version_invalid" };
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_POLICY_LIFETIME_MS) {
    return { ok: false, error: "policy_lifetime_invalid" };
  }
  if (typeof value.businessId !== "string" || !value.businessId || typeof value.deviceId !== "string" || !value.deviceId) {
    return { ok: false, error: "policy_identity_missing" };
  }
  const policy = sanitizePolicy(value.policy);
  if (!policy) return { ok: false, error: "policy_values_invalid" };
  return {
    ok: true,
    document: {
      policyVersion: value.policyVersion,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      businessId: value.businessId,
      deviceId: value.deviceId,
      auditRef: typeof value.auditRef === "string" ? value.auditRef.slice(0, 80) : null,
      reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : null,
      policy,
    },
  };
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localClock(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return { day: WEEKDAYS[get("weekday")], minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** A window that crosses midnight belongs to the day it STARTS on. */
function isInMaintenanceWindow(window, now) {
  let clock;
  try { clock = localClock(now, window.timezone); } catch { return false; }
  if (clock.day === undefined || !Number.isFinite(clock.minutes)) return false;
  const [startHour, startMinute] = window.start.split(":").map(Number);
  const [endHour, endMinute] = window.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (start < end) return window.daysOfWeek.includes(clock.day) && clock.minutes >= start && clock.minutes < end;
  const previousDay = (clock.day + 6) % 7;
  return (window.daysOfWeek.includes(clock.day) && clock.minutes >= start) ||
    (window.daysOfWeek.includes(previousDay) && clock.minutes < end);
}

/**
 * May an unattended install start now, by policy alone? Safety gates are a
 * separate question (evaluateInstallSafety) and are never waived here: the
 * critical override waives only the deferral and the window.
 */
function decideAutoInstall({ policy, expiresAt, now, postponedUntil }) {
  if (!policy) return { allowed: false, reason: "no_central_policy" };
  if (!(Date.parse(expiresAt) > now.getTime())) return { allowed: false, reason: "policy_expired" };
  if (policy.automaticInstall !== "safe_window") return { allowed: false, reason: "automatic_install_off" };
  if (policy.hold) return { allowed: false, reason: "hold" };
  const critical = Boolean(policy.allowCriticalOverride && policy.deadlineAt && Date.parse(policy.deadlineAt) <= now.getTime());
  if (!critical && policy.deferUntil && Date.parse(policy.deferUntil) > now.getTime()) return { allowed: false, reason: "deferred" };
  if (!critical && postponedUntil && Date.parse(postponedUntil) > now.getTime()) return { allowed: false, reason: "postponed_locally" };
  if (!critical && !isInMaintenanceWindow(policy.maintenance, now)) return { allowed: false, reason: "outside_window" };
  return { allowed: true, reason: critical ? "critical_deadline" : "safe_window" };
}

/**
 * Fails closed: a fact that is missing or not a number blocks the install,
 * because "could not tell" must never read as "nothing is open".
 * @param facts {openShifts, openOrders, pendingPrintJobs, freeDiskBytes, onBatteryPower, batteryPercent}
 */
function evaluateInstallSafety(facts, policy) {
  const blockers = [];
  const count = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  if (!facts || typeof facts !== "object") return { safe: false, blockers: ["safety_check_unavailable"] };
  for (const [key, blocker] of [["openShifts", "open_shift"], ["openOrders", "open_order"], ["pendingPrintJobs", "print_job_in_flight"]]) {
    const value = count(facts[key]);
    if (value === null) blockers.push("safety_check_unavailable");
    else if (value > 0) blockers.push(blocker);
  }
  const free = count(facts.freeDiskBytes);
  if (free === null) blockers.push("disk_space_unknown");
  else if (free < MIN_FREE_BYTES) blockers.push("disk_space_low");
  if (policy && policy.minimumBatteryPercent !== null && facts.onBatteryPower === true) {
    const percent = count(facts.batteryPercent);
    if (percent === null || percent < policy.minimumBatteryPercent) blockers.push("battery_low");
  }
  return { safe: blockers.length === 0, blockers: [...new Set(blockers)] };
}

module.exports = {
  AUTO_INSTALL_GRACE_MS,
  DEFAULT_POLICY,
  MAX_LOCAL_POSTPONE_MS,
  MIN_FREE_BYTES,
  decideAutoInstall,
  evaluateInstallSafety,
  isInMaintenanceWindow,
  parsePolicyDocument,
  sanitizePolicy,
};
