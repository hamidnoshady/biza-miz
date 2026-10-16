/**
 * Desktop update policy: the typed, versioned, server-stored authority that
 * decides how a paired desktop checks for, downloads and (opt-in) installs a
 * release. Framework-free and database-free on purpose so the console, the
 * service and the Electron-side parity test share one vocabulary.
 *
 * Precedence is platform defaults → platform → business → location → device;
 * the most specific explicit value wins, field by field. A layer stores only
 * the keys it explicitly overrides, so "inherited" and "overridden" stay
 * distinguishable on screen.
 *
 * A policy can never carry an installer URL, an origin, a downgrade or a way
 * around signature/hash/publisher/backup checks: those are not policy fields,
 * and `validateDesktopUpdatePolicyPatch` refuses any key it does not know.
 */
import { DESKTOP_RELEASE_CHANNELS, type DesktopReleaseChannel } from "./desktop-release";
import { isUuid } from "./uuid";

export const AUTOMATIC_INSTALL_MODES = ["off", "safe_window"] as const;
export type AutomaticInstallMode = (typeof AUTOMATIC_INSTALL_MODES)[number];

export const POLICY_SCOPES = ["platform", "business", "location", "device"] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export interface MaintenanceWindow {
  /** IANA zone the window is read in, e.g. "Asia/Tehran". */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday (JavaScript's own numbering). */
  daysOfWeek: number[];
  /** "HH:MM", 24h. A start later than the end means the window crosses midnight. */
  start: string;
  end: string;
}

export interface DesktopUpdatePolicy {
  automaticChecks: boolean;
  backgroundDownload: boolean;
  /** "off" is the default everywhere: no unattended executable install. */
  automaticInstall: AutomaticInstallMode;
  /** null = the channel the install itself reports (today's behaviour). */
  channel: DesktopReleaseChannel | null;
  /** A pinned release this scope is approved for (canary), or null. */
  targetReleaseId: string | null;
  /** Emergency hold: Central hands this scope no target and no install. */
  hold: boolean;
  maintenance: MaintenanceWindow;
  /** No install before this instant (ISO), unless the critical override applies. */
  deferUntil: string | null;
  /** After this instant the deferral and the window may be waived (never a safety gate). */
  deadlineAt: string | null;
  meteredNetworkDownload: boolean;
  minimumBatteryPercent: number | null;
  allowCriticalOverride: boolean;
}

export type DesktopUpdatePolicyPatch = Partial<DesktopUpdatePolicy>;
export const POLICY_KEYS = [
  "automaticChecks", "backgroundDownload", "automaticInstall", "channel", "targetReleaseId",
  "hold", "maintenance", "deferUntil", "deadlineAt", "meteredNetworkDownload",
  "minimumBatteryPercent", "allowCriticalOverride",
] as const satisfies readonly (keyof DesktopUpdatePolicy)[];
export type PolicyKey = (typeof POLICY_KEYS)[number];

/** Conservative: identical to what an install does with no central policy at all. */
export const PLATFORM_DEFAULT_POLICY: DesktopUpdatePolicy = {
  automaticChecks: true,
  backgroundDownload: false,
  automaticInstall: "off",
  channel: null,
  targetReleaseId: null,
  hold: false,
  maintenance: { timezone: "Asia/Tehran", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "02:00", end: "05:00" },
  deferUntil: null,
  deadlineAt: null,
  meteredNetworkDownload: false,
  minimumBatteryPercent: null,
  allowCriticalOverride: false,
};

/** How long a delivered policy stays authoritative on a device that cannot reach Central. */
export const POLICY_TTL_HOURS = 168;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isoInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export type PolicyValidation =
  | { ok: true; patch: DesktopUpdatePolicyPatch }
  | { ok: false; error: string; key?: string };

/** Validates a partial policy. Unknown keys are refused rather than ignored. */
export function validateDesktopUpdatePolicyPatch(value: unknown): PolicyValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "bad_policy" };
  const input = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (entry === undefined) continue;
    switch (key) {
      case "automaticChecks":
      case "backgroundDownload":
      case "hold":
      case "meteredNetworkDownload":
      case "allowCriticalOverride":
        if (typeof entry !== "boolean") return { ok: false, error: "invalid_policy_value", key };
        patch[key] = entry;
        break;
      case "automaticInstall":
        if (!(AUTOMATIC_INSTALL_MODES as readonly unknown[]).includes(entry)) return { ok: false, error: "invalid_policy_value", key };
        patch[key] = entry;
        break;
      case "channel":
        if (entry !== null && !(DESKTOP_RELEASE_CHANNELS as readonly unknown[]).includes(entry)) {
          return { ok: false, error: "invalid_policy_value", key };
        }
        patch[key] = entry;
        break;
      case "targetReleaseId":
        if (entry !== null && !(typeof entry === "string" && isUuid(entry))) return { ok: false, error: "invalid_policy_value", key };
        patch[key] = entry;
        break;
      case "deferUntil":
      case "deadlineAt": {
        const instant = isoInstant(entry);
        if (instant === undefined) return { ok: false, error: "invalid_policy_value", key };
        patch[key] = instant;
        break;
      }
      case "minimumBatteryPercent":
        if (entry !== null && !(typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 100)) {
          return { ok: false, error: "invalid_policy_value", key };
        }
        patch[key] = entry;
        break;
      case "maintenance": {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "invalid_policy_value", key };
        const window = entry as Record<string, unknown>;
        const days = window.daysOfWeek;
        if (
          typeof window.timezone !== "string" || !validTimezone(window.timezone) ||
          !Array.isArray(days) || days.length === 0 || days.length > 7 ||
          !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
          typeof window.start !== "string" || !HHMM.test(window.start) ||
          typeof window.end !== "string" || !HHMM.test(window.end) || window.start === window.end
        ) return { ok: false, error: "invalid_policy_value", key };
        patch.maintenance = {
          timezone: window.timezone,
          daysOfWeek: [...new Set(days as number[])].sort((a, b) => a - b),
          start: window.start,
          end: window.end,
        };
        break;
      }
      default:
        return { ok: false, error: "unknown_policy_key", key };
    }
  }
  return { ok: true, patch: patch as DesktopUpdatePolicyPatch };
}

export interface PolicyLayer {
  scope: PolicyScope;
  patch: DesktopUpdatePolicyPatch;
  /** Draws from one global sequence, so it only ever grows. */
  version: number;
  reason: string | null;
  updatedAt: string | null;
}

export type PolicySource = "default" | PolicyScope;

export interface ResolvedPolicy {
  policy: DesktopUpdatePolicy;
  /** For every key, the layer that supplied its value. */
  sources: Record<PolicyKey, PolicySource>;
  /** The highest layer version; any write to any applicable layer raises it. */
  policyVersion: number;
  /** The layer written last, i.e. the one that explains the current version. */
  latest: { scope: PolicyScope; version: number; reason: string | null; updatedAt: string | null } | null;
}

const SCOPE_ORDER: Record<PolicyScope, number> = { platform: 0, business: 1, location: 2, device: 3 };

/** Layers are applied in precedence order regardless of the order given. */
export function resolveDesktopUpdatePolicy(layers: PolicyLayer[]): ResolvedPolicy {
  const policy: DesktopUpdatePolicy = structuredClone(PLATFORM_DEFAULT_POLICY);
  const sources = Object.fromEntries(POLICY_KEYS.map((key) => [key, "default"])) as Record<PolicyKey, PolicySource>;
  const ordered = [...layers].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  let latest: ResolvedPolicy["latest"] = null;
  for (const layer of ordered) {
    for (const key of POLICY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(layer.patch, key) && layer.patch[key] !== undefined) {
        (policy as unknown as Record<string, unknown>)[key] = structuredClone(layer.patch[key]);
        sources[key] = layer.scope;
      }
    }
    if (!latest || layer.version > latest.version) {
      latest = { scope: layer.scope, version: layer.version, reason: layer.reason, updatedAt: layer.updatedAt };
    }
  }
  return { policy, sources, policyVersion: latest?.version ?? 0, latest };
}

/**
 * A pin names a release, and a release has exactly one channel; the channel a
 * pinned device is held to is therefore the pinned release's, not a second knob.
 */
export function effectivePolicyChannel(
  policy: Pick<DesktopUpdatePolicy, "channel">,
  pinnedReleaseChannel: DesktopReleaseChannel | null,
  reportedChannel: DesktopReleaseChannel,
): DesktopReleaseChannel {
  return policy.channel ?? pinnedReleaseChannel ?? reportedChannel;
}

/** What a device receives. Authenticity rides the authenticated, device-bound channel. */
export interface DesktopUpdatePolicyDocument {
  schemaVersion: 1;
  policyVersion: number;
  issuedAt: string;
  expiresAt: string;
  businessId: string;
  /** The device's public id, never an internal row id. */
  deviceId: string;
  reason: string | null;
  /** Always "platform": the console operator's identity is not shared with tenants. */
  actor: "platform";
  /** `${scope}:${version}` of the layer that produced this version. */
  auditRef: string;
  policy: DesktopUpdatePolicy;
}

export function buildPolicyDocument(input: {
  resolved: ResolvedPolicy;
  businessId: string;
  deviceId: string;
  /** Channel after a pinned release has been taken into account. */
  channel: DesktopReleaseChannel | null;
  now: Date;
}): DesktopUpdatePolicyDocument {
  const { resolved } = input;
  return {
    schemaVersion: 1,
    policyVersion: resolved.policyVersion,
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + POLICY_TTL_HOURS * 3_600_000).toISOString(),
    businessId: input.businessId,
    deviceId: input.deviceId,
    reason: resolved.latest?.reason ?? null,
    actor: "platform",
    auditRef: resolved.latest ? `${resolved.latest.scope}:${resolved.latest.version}` : "default:0",
    policy: { ...resolved.policy, channel: input.channel },
  };
}
