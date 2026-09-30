/**
 * Phase 45 — what a Hybrid desktop reads from the cloud and does not own: the
 * branch's own settings (the business-day start that decides which day a
 * night's bills belong to) and the switches the super-admin console flips
 * (features, app availability). Pairing copied these once; this keeps them
 * current. Pure: shape validation, a stable hash, and the state transitions.
 */
import { createHash } from "node:crypto";
import { isAppAvailabilityState, type AppAvailabilityRecord } from "./app-availability";
import { APP_KEYS, type AppKey } from "./apps";
import { nextAttemptAt } from "./sync-backoff";
import { isUuid } from "./uuid";

export interface SiteProfileLocation {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  businessDayStartMinutes: number | null;
  isActive: boolean;
}

export interface SiteProfile {
  schemaVersion: 1;
  location: SiteProfileLocation;
  features: Record<string, boolean>;
  apps: Partial<Record<AppKey, AppAvailabilityRecord>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function validLocation(raw: unknown): SiteProfileLocation | null {
  if (!isRecord(raw)) return null;
  const start = raw.businessDayStartMinutes;
  if (
    !isUuid(raw.id) ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    !nullableText(raw.address) ||
    !nullableText(raw.phone) ||
    typeof raw.timezone !== "string" ||
    !raw.timezone.trim() ||
    !(start === null || (Number.isInteger(start) && (start as number) >= 0 && (start as number) < 1440)) ||
    typeof raw.isActive !== "boolean"
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    address: raw.address,
    phone: raw.phone,
    timezone: raw.timezone,
    businessDayStartMinutes: start as number | null,
    isActive: raw.isActive,
  };
}

export function validateSiteProfile(raw: unknown): SiteProfile | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1) return null;
  const location = validLocation(raw.location);
  if (!location || !isRecord(raw.features) || !isRecord(raw.apps)) return null;
  const features: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(raw.features)) {
    if (typeof enabled !== "boolean") return null;
    features[key] = enabled;
  }
  const apps: Partial<Record<AppKey, AppAvailabilityRecord>> = {};
  for (const [key, record] of Object.entries(raw.apps)) {
    if (!(APP_KEYS as readonly string[]).includes(key) || !isRecord(record)) return null;
    if (!isAppAvailabilityState(record.state) || !nullableText(record.note)) return null;
    const from = record.availableFrom;
    if (!(from === null || (typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from) && from.startsWith("20")))) return null;
    apps[key as AppKey] = { state: record.state, note: record.note, availableFrom: from };
  }
  return { schemaVersion: 1, location, features, apps };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function siteProfileHash(profile: SiteProfile): string {
  return createHash("sha256").update(JSON.stringify(canonical(profile))).digest("hex");
}

export interface SiteProfileState {
  /** Hash of the last profile applied; unchanged profiles are not re-applied. */
  hash: string | null;
  appliedAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
  failures: number;
  nextAttemptAt: string | null;
}

export const EMPTY_SITE_PROFILE_STATE: SiteProfileState = {
  hash: null,
  appliedAt: null,
  checkedAt: null,
  lastError: null,
  failures: 0,
  nextAttemptAt: null,
};

export function siteProfileSucceeded(previous: SiteProfileState, hash: string, applied: boolean, now: Date): SiteProfileState {
  return {
    hash,
    appliedAt: applied ? now.toISOString() : previous.appliedAt,
    checkedAt: now.toISOString(),
    lastError: null,
    failures: 0,
    nextAttemptAt: null,
  };
}

/** The last applied copy stays in force; only the error and the backoff move. */
export function siteProfileFailed(
  previous: SiteProfileState,
  error: string,
  now: Date,
  random: () => number = Math.random,
): SiteProfileState {
  const failures = previous.failures + 1;
  return {
    ...previous,
    checkedAt: now.toISOString(),
    lastError: error.slice(0, 300),
    failures,
    nextAttemptAt: nextAttemptAt(failures, now, random),
  };
}
