/**
 * Issue #903 §2 — the tenant-facing artifact inventory, as pure policy.
 *
 * The tenant's backup page used to be a run log: "a local run succeeded at
 * 03:30". That answers the wrong question. A business wants to know *which
 * backups exist right now*, where each one lives, whether it is verified, when
 * it expires, and whether it can actually be restored — and it must never see a
 * storage provider, an object key or a path to answer that.
 *
 * This module turns rows (one per artifact **per destination**) into logical
 * backup entries:
 *
 *  • **A mirror is one backup, not two.** Hybrid writes the same logical
 *    operation to local disk and managed cloud; both rows share an artifact id
 *    and collapse into one entry with two destination views, so storage usage
 *    is not double-counted and the list does not show duplicates.
 *  • **The deployment profile decides what can be shown.** A Local-only tenant
 *    never sees a cloud row, even a historical one, and a queue that has not
 *    uploaded yet is labelled `uploading` — never "ready in the cloud".
 *  • **States are honest.** `ready` requires a recorded integrity check; a run
 *    that finished writing but was never verified is `verifying`; an artifact
 *    whose retention ended is `expired`, not silently hidden.
 *
 * Provider-neutral by construction: entries carry opaque refs, byte counts and
 * labels, never keys, endpoints, buckets, prefixes or internal errors. Pure, so
 * the rules are unit-testable without a database.
 */
import type { DeploymentProfile } from "./deployment-mode";
import { tenantBackupArtifactRef } from "./tenant-backup-artifact-ref";

export type ArtifactDestination = "local" | "cloud";
export type ArtifactFormat = "physical_dump" | "logical_snapshot";
export type ArtifactOrigin = "scheduled" | "manual" | "uploaded";

/** Persisted lifecycle of one destination row. */
export type ArtifactRowState =
  | "pending_upload"
  | "uploading"
  | "verifying"
  | "ready"
  | "failed"
  | "expired"
  /** Replaced by a managed-custody copy of the same backup (issue #903 §8). */
  | "superseded";

export interface TenantArtifactRow {
  /** Manifest artifact id: the *logical* backup, shared by its destinations. */
  artifactId: string;
  businessId: string;
  destination: ArtifactDestination;
  format: ArtifactFormat;
  origin: ArtifactOrigin;
  state: ArtifactRowState;
  /** Bytes of the payload once (identical for both destinations of a mirror). */
  payloadBytes: number | null;
  /** Bytes stored at this destination (ciphertext). */
  storedBytes: number | null;
  capturedAt: string;
  verifiedAt: string | null;
  retentionUntil: string | null;
  lastRestoreAt: string | null;
  completeness: "complete" | "partial";
  encryption: "managed_envelope_v1" | "legacy_passphrase_v1";
  /** Custody generation that opens this artifact; null for a legacy passphrase. */
  keyVersion: number | null;
  /** Server-only storage reference; never serialized. Used for the opaque ref. */
  storageRef: string;
  /** Provider/internal failure code, already mapped to a safe public value. */
  failureCode: string | null;
}

export type ArtifactViewState =
  | "ready"
  | "superseded"
  | "uploading"
  | "verifying"
  | "failed"
  | "expired"
  | "unavailable_offline";

export interface DestinationView {
  destination: ArtifactDestination;
  state: ArtifactViewState;
  storedBytes: number | null;
  available: boolean;
  verified: boolean;
}

export interface BackupArtifactEntry {
  /** Opaque, business-bound reference — the only id the browser handles. */
  ref: string;
  capturedAt: string;
  origin: ArtifactOrigin;
  format: ArtifactFormat;
  /** One logical backup may live at one or both destinations. */
  destinations: DestinationView[];
  payloadBytes: number | null;
  storedBytes: number;
  state: ArtifactViewState;
  integrity: "verified" | "unverified" | "failed";
  completeness: "complete" | "partial";
  encryption: "managed" | "legacy_passphrase";
  retentionUntil: string | null;
  lastRestoreAt: string | null;
  available: boolean;
  downloadable: boolean;
  restorable: boolean;
}

/** Persian copy lives here, once, so every surface names a state identically. */
export const ARTIFACT_STATE_LABELS: Record<ArtifactViewState, string> = {
  ready: "آماده",
  uploading: "در حال بارگذاری",
  verifying: "در حال بررسی",
  failed: "ناموفق",
  superseded: "جایگزین‌شده",
  expired: "منقضی",
  unavailable_offline: "در دسترس نیست (آفلاین)",
};

export const ARTIFACT_FORMAT_LABELS: Record<ArtifactFormat, string> = {
  logical_snapshot: "داده‌های کسب‌وکار (نسخهٔ منطقی)",
  physical_dump: "تصویر کامل پایگاه‌دادهٔ نصب",
};

export const ARTIFACT_ORIGIN_LABELS: Record<ArtifactOrigin, string> = {
  scheduled: "زمان‌بندی‌شده",
  manual: "دستی",
  uploaded: "بارگذاری‌شده",
};

export const ARTIFACT_COMPLETENESS_LABELS: Record<"complete" | "partial", string> = {
  complete: "کامل",
  partial: "ناقص (بخش‌هایی پشتیبان‌گیری نشده)",
};

export interface InventoryContext {
  profile: DeploymentProfile;
  /** Connectivity of a Local/Hybrid installation; cloud profile is always online. */
  connectivity: "online" | "offline" | "unknown";
  now?: Date;
}

function isPastRetention(row: TenantArtifactRow, now: Date): boolean {
  if (!row.retentionUntil) return false;
  const until = Date.parse(row.retentionUntil);
  return Number.isFinite(until) && until <= now.getTime();
}

function viewStateOf(row: TenantArtifactRow, context: InventoryContext, now: Date): ArtifactViewState {
  if (row.state === "failed") return "failed";
  // A superseded row is not restorable and not expired: it is the older copy of
  // a backup that now has a managed-custody successor.
  if (row.state === "superseded") return "superseded";
  if (row.state === "pending_upload" || row.state === "uploading") return "uploading";
  if (row.state === "verifying") return "verifying";
  if (row.state === "expired") return "expired";
  if (isPastRetention(row, now)) return "expired";
  if (row.destination === "local" && context.profile !== "cloud" && context.connectivity === "offline") {
    // The bytes are on a machine the platform cannot reach right now. Saying
    // "ready" would promise a download that will fail.
    return "unavailable_offline";
  }
  return "ready";
}

const STATE_PRECEDENCE: ArtifactViewState[] = [
  "failed",
  "expired",
  "superseded",
  "uploading",
  "verifying",
  "unavailable_offline",
  "ready",
];

function worstState(states: ArtifactViewState[]): ArtifactViewState {
  for (const state of STATE_PRECEDENCE) if (states.includes(state)) return state;
  return "ready";
}

/**
 * Build the tenant inventory. Rows for a business the caller does not own are
 * dropped rather than rendered — defence in depth behind RLS, and the reason the
 * function requires the business id explicitly instead of trusting the rows.
 */
export function buildTenantInventory(
  rows: TenantArtifactRow[],
  businessId: string,
  context: InventoryContext,
): BackupArtifactEntry[] {
  const now = context.now ?? new Date();
  const owned = rows.filter(
    (row) => row.businessId === businessId && (context.profile !== "local" || row.destination === "local"),
  );

  const grouped = new Map<string, TenantArtifactRow[]>();
  for (const row of owned) {
    const group = grouped.get(row.artifactId) ?? [];
    group.push(row);
    grouped.set(row.artifactId, group);
  }

  const entries: BackupArtifactEntry[] = [];
  for (const [artifactId, group] of grouped) {
    const ordered = [...group].sort((a, b) => a.destination.localeCompare(b.destination));
    const destinations: DestinationView[] = ordered.map((row) => {
      const state = viewStateOf(row, context, now);
      return {
        destination: row.destination,
        state,
        storedBytes: row.storedBytes,
        available: state === "ready",
        verified: Boolean(row.verifiedAt) && state === "ready",
      };
    });

    const state = worstState(destinations.map((destination) => destination.state));
    const primary = ordered[0];
    const payloadBytes = ordered.reduce<number | null>((best, row) => {
      if (row.payloadBytes === null) return best;
      return best === null ? row.payloadBytes : Math.max(best, row.payloadBytes);
    }, null);
    // A mirror's stored bytes are the two copies, not double payload; report the
    // largest stored copy for "size" and keep per-destination sizes above.
    const storedBytes = ordered.reduce((total, row) => total + Math.max(0, row.storedBytes ?? 0), 0);
    const verified = destinations.some((destination) => destination.verified);
    const available = destinations.some((destination) => destination.available);
    const isUploaded = primary.origin === "uploaded";
    // An upload is a recovery *source*, not a verified backup, until it has
    // passed verification — the epic's "never masquerade as restorable" rule.
    const restorable = available && verified && state === "ready";

    entries.push({
      ref: tenantBackupArtifactRef(businessId, primary.destination, primary.storageRef),
      capturedAt: primary.capturedAt,
      origin: primary.origin,
      format: primary.format,
      destinations,
      payloadBytes,
      storedBytes,
      state,
      integrity: destinations.some((destination) => destination.state === "failed")
        ? "failed"
        : verified
          ? "verified"
          : "unverified",
      completeness: ordered.every((row) => row.completeness === "complete") ? "complete" : "partial",
      encryption: primary.encryption === "managed_envelope_v1" ? "managed" : "legacy_passphrase",
      retentionUntil: primary.retentionUntil,
      lastRestoreAt: primary.lastRestoreAt,
      available,
      downloadable: state === "ready" && available && (!isUploaded || verified),
      restorable,
    });
  }

  return entries.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
}

export interface InventoryQuery {
  search?: string;
  state?: ArtifactViewState | "all";
  origin?: ArtifactOrigin | "all";
  sort?: "newest" | "oldest";
  page?: number;
  pageSize?: number;
}

export const INVENTORY_MAX_PAGE_SIZE = 50;

/** Search/filter/sort/paginate, server-side, over already-scoped entries. */
export function queryInventory(
  entries: BackupArtifactEntry[],
  query: InventoryQuery = {},
): { items: BackupArtifactEntry[]; total: number; page: number; pageSize: number; pages: number } {
  const search = query.search?.trim().toLowerCase() ?? "";
  const filtered = entries.filter((entry) => {
    if (query.state && query.state !== "all" && entry.state !== query.state) return false;
    if (query.origin && query.origin !== "all" && entry.origin !== query.origin) return false;
    if (!search) return true;
    const haystack = [
      entry.ref,
      entry.format,
      entry.origin,
      entry.state,
      ARTIFACT_FORMAT_LABELS[entry.format],
      ARTIFACT_STATE_LABELS[entry.state],
      ARTIFACT_ORIGIN_LABELS[entry.origin],
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });

  const sorted = [...filtered].sort((a, b) => {
    const delta = Date.parse(a.capturedAt) - Date.parse(b.capturedAt);
    return query.sort === "oldest" ? delta : -delta;
  });

  const pageSize = Math.min(
    INVENTORY_MAX_PAGE_SIZE,
    Math.max(1, Math.floor(query.pageSize ?? 20)),
  );
  const total = sorted.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(query.page ?? 1)));
  return {
    items: sorted.slice((page - 1) * pageSize, page * pageSize),
    total,
    page,
    pageSize,
    pages,
  };
}

export interface InventorySummary {
  latestCompletedAt: string | null;
  latestVerifiedAt: string | null;
  readyCount: number;
  partialCount: number;
  failedCount: number;
  expiredCount: number;
  pendingCount: number;
  /** Managed cloud bytes only: local copies never count against cloud allowance. */
  cloudBytes: number;
  includedBytes: number;
  overageBytes: number;
  usagePercent: number;
}

export function summarizeInventory(
  entries: BackupArtifactEntry[],
  allowance: { includedBytes: number },
): InventorySummary {
  const cloudBytes = entries.reduce(
    (total, entry) =>
      total +
      entry.destinations
        // A queued upload has not stored its bytes yet, so charging the
        // allowance for it would bill storage the business does not have.
        .filter((destination) => destination.destination === "cloud" && destination.state !== "uploading")
        .reduce((inner, destination) => inner + Math.max(0, destination.storedBytes ?? 0), 0),
    0,
  );
  const latestCompleted = entries
    .filter((entry) => entry.state === "ready")
    .map((entry) => entry.capturedAt)
    .sort()
    .at(-1) ?? null;
  const latestVerified = entries
    .filter((entry) => entry.integrity === "verified")
    .map((entry) => entry.capturedAt)
    .sort()
    .at(-1) ?? null;
  const includedBytes = Math.max(0, allowance.includedBytes);
  return {
    latestCompletedAt: latestCompleted,
    latestVerifiedAt: latestVerified,
    readyCount: entries.filter((entry) => entry.state === "ready").length,
    partialCount: entries.filter((entry) => entry.completeness === "partial").length,
    failedCount: entries.filter((entry) => entry.state === "failed").length,
    expiredCount: entries.filter((entry) => entry.state === "expired").length,
    pendingCount: entries.filter((entry) => entry.state === "uploading" || entry.state === "verifying").length,
    cloudBytes,
    includedBytes,
    overageBytes: Math.max(0, cloudBytes - includedBytes),
    usagePercent: includedBytes === 0 ? 0 : Math.min(100, Math.round((cloudBytes / includedBytes) * 100)),
  };
}
