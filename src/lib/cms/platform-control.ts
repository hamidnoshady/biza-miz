/**
 * The operator's side of the CMS control plane — the pure half.
 *
 * Migration 0122 connected one business to its own site. This module is the
 * *platform* relationship: the address of the eshobe-cms deployment, the
 * `role: "platform"` credential that administers all of it, and the shapes the
 * super-admin console's «سایت‌ساز» section renders. Everything here is
 * framework-free and unit-tested in `platform-control.test.ts`; the DB-touching
 * store is `platform-control-service.ts` and the HTTP client is
 * `platform-client.ts`.
 *
 * Three rules this file exists to hold:
 *
 *  - **An empty credential submission means "unchanged", never "delete".** The
 *    console renders the key masked (it is never returned), so every save posts it
 *    empty — treating that as deletion would wipe the platform's root credential
 *    for its own website platform the moment somebody fixed a typo in the label.
 *    `clearApiKey: true` is the explicit door, exactly as the CMS's own gateway
 *    and storage credentials work.
 *  - **The address is normalized before it is stored, not when it is used.** A
 *    base URL with credentials in it, a query string, or a fragment is a paste of
 *    the wrong field; `http://` is legitimate for a CMS on the same private
 *    network and a mistake over the public internet, so it needs the operator to
 *    say which — the same distinction `normalizePeerBaseUrl` draws for a backup
 *    peer's address.
 *  - **`verified_at` is derived, never submitted.** It is reset by whatever edit
 *    makes the stored proof false, and `cmsConfigSetClause` guarantees the whole
 *    save still says each column exactly once (Postgres refuses a duplicate
 *    `SET` target outright).
 */

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

export type CmsUrlResult =
  | { ok: true; secure: boolean; url: string }
  | { error: "credentials_in_url" | "https_required" | "invalid_url" | "too_long"; ok: false };

/**
 * Normalize the CMS control-plane origin an operator pastes.
 *
 * Accepted: `https://cms.eshobe.com`, `http://web:3000` (with `allowInsecure`), a
 * base carrying a path prefix. Rejected: embedded credentials, a query, a
 * fragment, any scheme but http/https, and plain http unless it was allowed.
 * The result has no trailing slash, so `${baseUrl}/api/...` never doubles a
 * separator.
 */
export function normalizeCmsControlUrl(
  raw: unknown,
  opts: { allowInsecure?: boolean } = {},
): CmsUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { error: "invalid_url", ok: false };
  if (value.length > 512) return { error: "too_long", ok: false };
  if (/[\s\0\u200b-\u200f]/.test(value)) return { error: "invalid_url", ok: false };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "invalid_url", ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "invalid_url", ok: false };
  if (!url.hostname) return { error: "invalid_url", ok: false };
  // A "CMS address" that carries a password is either a paste error or a trick.
  if (url.username || url.password) return { error: "credentials_in_url", ok: false };
  if (url.hash || url.search) return { error: "invalid_url", ok: false };

  const secure = url.protocol === "https:";
  if (!secure && !opts.allowInsecure) return { error: "https_required", ok: false };

  const path = url.pathname.replace(/\/+$/, "");
  if (/\/\/|\.\.\/|%2e/i.test(path)) return { error: "invalid_url", ok: false };

  return { ok: true, secure, url: `${url.protocol}//${url.host}${path}` };
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

/** The CMS mints `eshobe_live_…` (see its `src/lib/api-keys.ts`). */
const KEY_SHAPE = /^[A-Za-z0-9_.-]{16,200}$/;

export type CmsKeyResult = { key: string; ok: true } | { ok: false; reason: "invalid_shape" };

export function normalizeCmsPlatformKey(raw: unknown): CmsKeyResult {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!KEY_SHAPE.test(key)) return { ok: false, reason: "invalid_shape" };
  return { key, ok: true };
}

/**
 * The last four characters, so the console can say *which* key is stored.
 *
 * Four is not enough to authenticate with and is enough to tell one rotation from
 * the next — the same trade-off `peerTokenHint` makes for a backup peer's token.
 */
export function cmsKeyHint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? "" : `…${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// The stored configuration, as the console sees it
// ---------------------------------------------------------------------------

export interface CmsControlConfig {
  allowInsecure: boolean;
  baseUrl: string;
  eventsCursor: null | string;
  eventsShipped: number;
  storeOrderIngestCursor: null | string;
  label: string;
  lastEventsAt: null | string;
  lastEventsError: null | string;
  lastMirrorAt: null | string;
  lastMirrorError: null | string;
  logShippingEnabled: boolean;
  mirrorEnabled: boolean;
  mirrorIntervalMinutes: number;
  updatedAt: null | string;
  verifiedAt: null | string;
  verifyError: null | string;
}

/**
 * What the console is allowed to see: the config plus a *hint* of the key, and
 * two derived booleans it would otherwise have to infer.
 *
 * `apiKeyHint` is the only trace of the credential that ever leaves the server.
 */
export interface MaskedCmsControlConfig extends CmsControlConfig {
  apiKeyHint: string;
  billingEntitlementKeyId: string;
  billingEntitlementSecretHint: string;
  /** A key is stored (it may still be wrong — see `verifiedAt`). */
  configured: boolean;
  /** Address *and* key are present, so a call can at least be attempted. */
  usable: boolean;
}

export function maskCmsControlConfig(
  config: CmsControlConfig,
  stored: {
    apiKeyHint: string;
    hasApiKey: boolean;
    billingEntitlementKeyId?: string;
    billingEntitlementSecretHint?: string;
  },
): MaskedCmsControlConfig {
  return {
    ...config,
    apiKeyHint: stored.apiKeyHint,
    billingEntitlementKeyId: stored.billingEntitlementKeyId ?? "",
    billingEntitlementSecretHint: stored.billingEntitlementSecretHint ?? "",
    configured: stored.hasApiKey,
    usable: Boolean(config.baseUrl) && stored.hasApiKey,
  };
}

export type CmsConfigPatch = {
  allowInsecure?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  billingEntitlementKeyId?: unknown;
  billingEntitlementSecret?: unknown;
  clearApiKey?: unknown;
  clearBillingEntitlementSecret?: unknown;
  label?: unknown;
  logShippingEnabled?: unknown;
  mirrorEnabled?: unknown;
  mirrorIntervalMinutes?: unknown;
};

export type CmsConfigPatchResult =
  | { changes: ValidatedCmsPatch; ok: true }
  | { errors: string[]; ok: false };

export interface ValidatedCmsPatch {
  allowInsecure?: boolean;
  /** Present only when a new key was submitted. Absent means "leave it alone". */
  apiKey?: string;
  billingEntitlementKeyId?: string;
  billingEntitlementSecret?: string;
  baseUrl?: string;
  clearApiKey?: true;
  clearBillingEntitlementSecret?: true;
  label?: string;
  logShippingEnabled?: boolean;
  mirrorEnabled?: boolean;
  mirrorIntervalMinutes?: number;
}

export const MIRROR_INTERVAL_MIN = 5;
export const MIRROR_INTERVAL_MAX = 1440;

/**
 * Validate one console save. Field order matters in exactly one place:
 * `allowInsecure` is read before `baseUrl`, because it decides whether an
 * `http://` address in the *same* submission is acceptable.
 */
export function parseCmsConfigPatch(
  body: CmsConfigPatch,
  current: { allowInsecure: boolean },
): CmsConfigPatchResult {
  const errors: string[] = [];
  const changes: ValidatedCmsPatch = {};

  const allowInsecure =
    body.allowInsecure === undefined ? current.allowInsecure : body.allowInsecure === true;
  if (body.allowInsecure !== undefined) changes.allowInsecure = allowInsecure;

  if (body.baseUrl !== undefined) {
    const result = normalizeCmsControlUrl(body.baseUrl, { allowInsecure });
    if (!result.ok) errors.push(result.error);
    else changes.baseUrl = result.url;
  }

  if (body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label.length > 120) errors.push("label_too_long");
    else changes.label = label;
  }

  if (body.clearApiKey === true) {
    changes.clearApiKey = true;
  } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    // Only a *non-empty* submission touches the credential. An empty one is the
    // masked form being saved back, not a request to delete the key.
    const key = normalizeCmsPlatformKey(body.apiKey);
    if (!key.ok) errors.push("invalid_api_key");
    else changes.apiKey = key.key;
  }

  if (body.mirrorEnabled !== undefined) changes.mirrorEnabled = body.mirrorEnabled === true;
  if (body.logShippingEnabled !== undefined) {
    changes.logShippingEnabled = body.logShippingEnabled === true;
  }

  if (body.mirrorIntervalMinutes !== undefined) {
    const minutes = Number(body.mirrorIntervalMinutes);
    if (
      !Number.isInteger(minutes) ||
      minutes < MIRROR_INTERVAL_MIN ||
      minutes > MIRROR_INTERVAL_MAX
    ) {
      errors.push("invalid_interval");
    } else changes.mirrorIntervalMinutes = minutes;
  }

  if (body.clearBillingEntitlementSecret === true) {
    changes.clearBillingEntitlementSecret = true;
  } else if (typeof body.billingEntitlementSecret === "string" && body.billingEntitlementSecret.trim()) {
    const key = normalizeCmsPlatformKey(body.billingEntitlementSecret);
    if (!key.ok) errors.push("invalid_billing_entitlement_secret");
    else changes.billingEntitlementSecret = key.key;
  }
  if (typeof body.billingEntitlementKeyId === "string" && body.billingEntitlementKeyId.trim()) {
    const keyId = body.billingEntitlementKeyId.trim();
    if (keyId.length > 120) errors.push("billing_entitlement_key_id_too_long");
    else changes.billingEntitlementKeyId = keyId;
  }

  if (errors.length) return { errors, ok: false };
  if (Object.keys(changes).length === 0) return { errors: ["nothing_to_change"], ok: false };
  return { changes, ok: true };
}

// ---------------------------------------------------------------------------
// The write: a validated patch → one UPDATE's SET list
// ---------------------------------------------------------------------------

/**
 * One intended assignment to `platform_cms_config`.
 *
 * `value` is bound as a parameter; `literal` is server-side SQL for the cases
 * where the value is not data (`NULL`, `''`, `now()`).
 */
export type CmsConfigAssignment =
  | { column: string; literal: string }
  | { column: string; value: unknown };

/** The service-only half of writing the config, injected so this stays pure. */
export interface CmsConfigWriteContext {
  /** Who saved it — `null` when no admin is attached to the write. */
  adminId: null | string;
  /** AES-256-GCM at rest; the key material lives in the service, not here. */
  encryptApiKey: (apiKey: string) => string;
}

/**
 * Which columns one console save touches.
 *
 * `platform_cms_config` is a single row with two kinds of column, and the
 * distinction is the whole function: an *edited* column takes the submitted
 * value, and a *derived* column (`verified_at`, `verify_error`) is reset by every
 * edit that makes the stored proof meaningless — a new address, a new credential,
 * a cleared one. The proof was made against a different server, so keeping it
 * beside the new value would show an operator a verification that is not about
 * what is now on screen.
 *
 * An untouched field is absent from `changes` and therefore absent from the
 * result: the form posts the whole (masked) config on every save, and the
 * credential in particular must never be inferred from an empty field.
 */
export function cmsConfigUpdateAssignments(
  changes: ValidatedCmsPatch,
  context: CmsConfigWriteContext,
): CmsConfigAssignment[] {
  const bind = (column: string, value: unknown): CmsConfigAssignment => ({ column, value });
  const raw = (column: string, literal: string): CmsConfigAssignment => ({ column, literal });
  /** The address or the credential moved, so the last verification is about neither. */
  const invalidated = (): CmsConfigAssignment[] => [
    raw("verified_at", "NULL"),
    raw("verify_error", "NULL"),
  ];

  const assignments: CmsConfigAssignment[] = [];

  if (changes.baseUrl !== undefined) {
    assignments.push(bind("base_url", changes.baseUrl), ...invalidated());
  }
  if (changes.label !== undefined) assignments.push(bind("label", changes.label));
  if (changes.allowInsecure !== undefined) {
    assignments.push(bind("allow_insecure", changes.allowInsecure));
  }
  if (changes.mirrorEnabled !== undefined) {
    assignments.push(bind("mirror_enabled", changes.mirrorEnabled));
  }
  if (changes.mirrorIntervalMinutes !== undefined) {
    assignments.push(bind("mirror_interval_minutes", changes.mirrorIntervalMinutes));
  }
  if (changes.logShippingEnabled !== undefined) {
    assignments.push(bind("log_shipping_enabled", changes.logShippingEnabled));
  }

  if (changes.clearApiKey) {
    assignments.push(
      raw("api_key_ciphertext", "NULL"),
      raw("api_key_hint", "''"),
      ...invalidated(),
    );
  } else if (changes.apiKey) {
    // A stored-but-unverified key is the state «اتصال» exists to surface, so the
    // error that came with the old key is dropped with the old key's proof.
    assignments.push(
      bind("api_key_ciphertext", context.encryptApiKey(changes.apiKey)),
      bind("api_key_hint", cmsKeyHint(changes.apiKey)),
      ...invalidated(),
    );
  }

  if (changes.clearBillingEntitlementSecret) {
    assignments.push(
      raw("billing_entitlement_secret_ciphertext", "NULL"),
      raw("billing_entitlement_secret_hint", "''"),
    );
  } else if (changes.billingEntitlementSecret) {
    assignments.push(
      bind("billing_entitlement_secret_ciphertext", context.encryptApiKey(changes.billingEntitlementSecret)),
      bind("billing_entitlement_secret_hint", cmsKeyHint(changes.billingEntitlementSecret)),
    );
  }
  if (changes.billingEntitlementKeyId !== undefined) {
    assignments.push(bind("billing_entitlement_key_id", changes.billingEntitlementKeyId));
  }

  assignments.push(bind("updated_by", context.adminId), raw("updated_at", "now()"));
  return assignments;
}

/**
 * Fold intended assignments into the `SET` list of a single UPDATE.
 *
 * The fold is the point. Several rules above land on the same column routinely —
 * a changed address and a rotated credential each clear the last verification, and
 * the console posts both in one save — and Postgres does not merge a column named
 * twice in one `UPDATE`: it refuses the statement with
 * `42601 multiple assignments to same column "verified_at"`. That is exactly how
 * every save that touched the key came back as a 500 instead of a saved form.
 *
 * So: one assignment per column, the last one wins (the rules are ordered, and
 * the credential's is the more specific), and the `$n` placeholders are numbered
 * *after* the fold — a value dropped by a later rule must not stay in the
 * parameter list and shift every value after it onto the wrong column.
 */
export function cmsConfigSetClause(assignments: readonly CmsConfigAssignment[]): {
  sets: string[];
  values: unknown[];
} {
  const byColumn = new Map<string, CmsConfigAssignment>();
  for (const assignment of assignments) byColumn.set(assignment.column, assignment);

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const assignment of byColumn.values()) {
    if ("literal" in assignment) {
      sets.push(`${assignment.column} = ${assignment.literal}`);
      continue;
    }
    values.push(assignment.value);
    sets.push(`${assignment.column} = $${values.length}`);
  }
  return { sets, values };
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

/** One CMS site as the control API reports it (the POS-side view of `SiteReport`). */
export interface CmsSiteRow {
  aliases: { hostname: string; verified: boolean }[];
  availableLocales: string[];
  currency: null | string;
  defaultLocale: null | string;
  domain: string;
  domainVerified: boolean;
  gateways: { enabled: boolean; gateway: string; selfTest: null | string }[];
  id: string;
  name: string;
  status: string;
  totals: Record<string, number>;
  type: string;
  updatedAt: null | string;
}

/** A mirrored row read back out of `platform_cms_sites`, plus who owns it here. */
export interface MirroredCmsSite extends CmsSiteRow {
  businessId: null | string;
  businessName?: null | string;
  mirroredAt: string;
}

/**
 * Is a mirrored figure old enough that the console should say so?
 *
 * Two intervals rather than one: a mirror that ran an hour ago on a 30-minute
 * schedule has *missed* a run, and that is a different statement from "this is
 * not live data".
 */
export function mirrorIsStale(
  mirroredAt: null | string,
  intervalMinutes: number,
  now = Date.now(),
): boolean {
  if (!mirroredAt) return true;
  const at = new Date(mirroredAt).getTime();
  if (!Number.isFinite(at)) return true;
  return now - at > intervalMinutes * 2 * 60_000;
}

/**
 * Findings the console shows as a row of warnings above the table.
 *
 * Deliberately computed here rather than in the page: it is the one place both
 * the report screen and (later) an alert could agree on what "wrong" means, and
 * it is assertable without a browser.
 */
export interface CmsFleetFinding {
  count: number;
  detail: string;
  kind: "gateway_failing" | "no_business" | "suspended" | "unverified_domain";
  severity: "info" | "warn";
}

export function cmsFleetFindings(sites: readonly MirroredCmsSite[]): CmsFleetFinding[] {
  const findings: CmsFleetFinding[] = [];

  const unverified = sites.filter((site) => !site.domainVerified);
  if (unverified.length) {
    findings.push({
      count: unverified.length,
      detail: unverified
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "unverified_domain",
      severity: "warn",
    });
  }

  const suspended = sites.filter((site) => site.status !== "active");
  if (suspended.length) {
    findings.push({
      count: suspended.length,
      detail: suspended
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "suspended",
      severity: "warn",
    });
  }

  const failing = sites.filter((site) => site.gateways.some((row) => row.selfTest === "failed"));
  if (failing.length) {
    findings.push({
      count: failing.length,
      detail: failing
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "gateway_failing",
      severity: "warn",
    });
  }

  // A site on the CMS that no business here is billed for is not an error — an
  // operator may have provisioned it by hand — but it is the shape of a site that
  // was provisioned and then never connected, so it is worth naming.
  const orphans = sites.filter((site) => !site.businessId);
  if (orphans.length) {
    findings.push({
      count: orphans.length,
      detail: orphans
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "no_business",
      severity: "info",
    });
  }

  return findings;
}

/** Persian for a finding, for the console and for a notification later. */
export const CMS_FINDING_LABELS: Record<CmsFleetFinding["kind"], string> = {
  gateway_failing: "درگاه پرداخت با خطای خودآزمایی",
  no_business: "سایت بدون کسب‌وکار متصل",
  suspended: "سایت غیرفعال یا معلق",
  unverified_domain: "دامنهٔ تأییدنشده",
};

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export const SYNC_KINDS = ["mirror", "events", "pull", "push"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_KIND_LABELS: Record<SyncKind, string> = {
  events: "دریافت رویدادها",
  mirror: "به‌روزرسانی آینهٔ سایت‌ها",
  pull: "دریافت محتوا از سایت‌ساز",
  push: "ارسال محتوا به سایت‌ساز",
};

export interface SyncRunRow {
  created: number;
  createdAt: string;
  detail: Record<string, unknown>;
  dryRun: boolean;
  durationMs: number;
  error: null | string;
  id: string;
  items: number;
  kind: SyncKind;
  siteId: null | string;
  skipped: number;
  status: "failed" | "ok" | "partial";
  trigger: "manual" | "scheduled";
  updated: number;
}

export function isSyncKind(value: unknown): value is SyncKind {
  return typeof value === "string" && (SYNC_KINDS as readonly string[]).includes(value);
}

/**
 * Is a scheduled mirror due?
 *
 * Read per call from the stored interval rather than captured at module load, for
 * the reason the CMS's own env-tunable limits are: a constant frozen at import
 * time cannot be changed by an operator and cannot be tested.
 */
export function mirrorIsDue(
  config: { lastMirrorAt: null | string; mirrorEnabled: boolean; mirrorIntervalMinutes: number },
  now = Date.now(),
): boolean {
  if (!config.mirrorEnabled) return false;
  if (!config.lastMirrorAt) return true;
  const last = new Date(config.lastMirrorAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= config.mirrorIntervalMinutes * 60_000;
}
