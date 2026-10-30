/**
 * Issue #903 §3 — "safe local defaults, cached policies … and policy
 * reconciliation" on an on-device worker.
 *
 * A site install (desktop, café laptop, a shop that is offline for a week) must
 * keep protecting itself when it cannot reach the platform. Before this module
 * the fallback was a hard-coded window (24 h / 30 days), which is a *guess*: an
 * operator who had deliberately set that business to 6 h and 90 days got a
 * silently different protection level the moment the fleet row stopped being
 * readable.
 *
 * So: every successful resolution of the managed policy is cached beside the
 * device's own backup state, and a resolution that cannot reach the platform
 * falls back to that cache before the hard-coded defaults. Four properties keep
 * this honest:
 *
 *  1. **Only a real answer is cached.** A cache is written only when the fleet
 *     row was actually read (`source: "managed"`), never from defaults —
 *     otherwise the guess would entrench itself as "the platform's policy".
 *  2. **It is per business.** The fleet row is shared, but an override is not, so
 *     one file holds a small map keyed by business id (`*` for the fleet-level
 *     answer). A device that serves two businesses can therefore never hand one
 *     business the other's retention.
 *  3. **It decays.** An entry older than `POLICY_CACHE_MAX_AGE_MS` is ignored, so
 *     a device offline for months does not claim to follow a policy nobody has
 *     confirmed since.
 *  4. **Reconciliation is a rewrite.** When the platform answers again the fresh
 *     policy replaces the entry and the next resolution reports
 *     `source: "managed"` — there is no merge rule to get wrong, because the
 *     platform is authoritative whenever it is reachable.
 *
 * Every file operation is best-effort: a read-only disk must not stop a backup,
 * and a corrupt cache is the same as no cache. Nothing secret is stored — these
 * are the same four numbers the console already shows the Owner.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { TenantBackupPolicy, TenantBackupPolicySource } from "./tenant-backup-storage";

/** A week offline is ordinary; a month is a decision nobody has confirmed. */
export const POLICY_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The fleet-level answer (no business in the key) is stored under this key. */
const FLEET_KEY = "*";

/** How many businesses one device remembers before the oldest entry is dropped. */
const MAX_ENTRIES = 50;

interface CachedEntry {
  cachedAt: string;
  intervalHours: number;
  retentionDays: number;
  keepCount: number;
  protectedCopies: number;
  maxParallelUploads: number;
}

interface CacheFile {
  version: 2;
  entries: Record<string, CachedEntry>;
}

/**
 * Where the cache lives. Beside the backup state (not in a temp directory) so it
 * survives a reboot, and overridable for a deployment that runs read-only.
 */
export function policyCachePath(): string {
  const configured = process.env.TENANT_BACKUP_POLICY_CACHE_FILE?.trim();
  if (configured) return configured;
  return path.join(process.cwd(), "backups", "tenant-backup-policy-cache.json");
}

function validRange(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.trunc(parsed);
}

async function readFile(file: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<CacheFile>;
    if (parsed.version !== 2 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 2, entries: {} };
    }
    return { version: 2, entries: parsed.entries };
  } catch {
    return { version: 2, entries: {} };
  }
}

function businessKey(businessId?: string | null): string {
  return businessId?.trim() ? businessId.trim() : FLEET_KEY;
}

/**
 * The last policy the platform actually gave this device for this business, or
 * `null` when there is none, it is unreadable, it is stale, or it is corrupt.
 */
export async function readCachedPolicy(
  businessId?: string | null,
  now: Date = new Date(),
  file: string = policyCachePath(),
): Promise<(TenantBackupPolicy & { cachedAt: string }) | null> {
  const entry = (await readFile(file)).entries[businessKey(businessId)];
  if (!entry || typeof entry.cachedAt !== "string") return null;

  const cachedAt = Date.parse(entry.cachedAt);
  if (!Number.isFinite(cachedAt) || now.getTime() - cachedAt > POLICY_CACHE_MAX_AGE_MS) return null;

  const intervalHours = validRange(entry.intervalHours, 1, 24);
  const retentionDays = validRange(entry.retentionDays, 1, 3650);
  if (intervalHours === null || retentionDays === null) return null;

  return {
    intervalHours,
    retentionDays,
    maxRetentionDays: 3650,
    keepCount: validRange(entry.keepCount, 1, 500) ?? 30,
    protectedCopies: validRange(entry.protectedCopies, 0, 10) ?? 1,
    maxParallelUploads: validRange(entry.maxParallelUploads, 1, 16) ?? 2,
    // A device that cannot reach the fleet row cannot prove a managed
    // destination is configured; `managedCloud` stays false and the caller
    // treats it as "no cloud right now", which is the honest report.
    managedCloud: false,
    source: "cached" satisfies TenantBackupPolicySource,
    override: false,
    requireRestoreApproval: false,
    cachedAt: entry.cachedAt,
  };
}

/** Cache a policy the platform actually answered with. Best-effort. */
export async function writeCachedPolicy(
  policy: TenantBackupPolicy,
  options: { businessId?: string | null; now?: Date; file?: string } = {},
): Promise<boolean> {
  if (policy.source !== "managed") return false;
  const file = options.file ?? policyCachePath();
  const now = options.now ?? new Date();
  const cache = await readFile(file);
  const key = businessKey(options.businessId);

  cache.entries[key] = {
    cachedAt: now.toISOString(),
    intervalHours: policy.intervalHours,
    retentionDays: policy.retentionDays,
    keepCount: policy.keepCount,
    protectedCopies: policy.protectedCopies,
    maxParallelUploads: policy.maxParallelUploads,
  };

  const keys = Object.keys(cache.entries);
  if (keys.length > MAX_ENTRIES) {
    // Oldest first — a device that has served fifty businesses is not going to
    // miss the entry it has not resolved in the longest time.
    keys
      .sort((a, b) => Date.parse(cache.entries[a].cachedAt) - Date.parse(cache.entries[b].cachedAt))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((stale) => delete cache.entries[stale]);
  }

  const temporary = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a half-written cache is worse than none, because it
    // would be trusted on the next offline boot.
    await fs.writeFile(temporary, JSON.stringify(cache), "utf8");
    await fs.rename(temporary, file);
    return true;
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    return false;
  }
}

/** Forget one business's cache (or the whole file) — used by tests and device rotation. */
export async function clearCachedPolicy(
  businessId?: string | null,
  file: string = policyCachePath(),
): Promise<void> {
  try {
    if (businessId === undefined) {
      await fs.rm(file, { force: true });
      return;
    }
    const cache = await readFile(file);
    delete cache.entries[businessKey(businessId)];
    await fs.writeFile(file, JSON.stringify(cache), "utf8");
  } catch {
    // Best-effort, as everywhere else in this module.
  }
}
