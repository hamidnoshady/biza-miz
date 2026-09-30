/**
 * Phase 45 — the cloud serves a paired branch its profile
 * (GET /api/server-sync/site-profile); the desktop applies it at most once
 * per sync interval. The branch row and the switches are the cloud's, so the desktop
 * overwrites its copy. App availability lands as this business's override,
 * so the desktop's global catalogue is never rewritten. Offline, the last
 * applied copy stays in force.
 */
import { effectiveAppAvailability } from "./app-availability-service";
import { getPool, query } from "./db";
import { effectiveFeatures } from "./features";
import type { ServerSyncConfig } from "./server-sync-config";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import {
  EMPTY_SITE_PROFILE_STATE,
  siteProfileFailed,
  siteProfileHash,
  siteProfileSucceeded,
  validateSiteProfile,
  type SiteProfile,
  type SiteProfileState,
} from "./site-profile";
import { attemptDue } from "./sync-backoff";

/** The cloud's side. Null when the branch is not this business's. */
export async function buildSiteProfile(businessId: string, locationId: string): Promise<SiteProfile | null> {
  const { rows } = await query<{
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
    business_day_start_minutes: number | null;
    is_active: boolean;
  }>(
    `SELECT id, name, address, phone, timezone, business_day_start_minutes, is_active
       FROM locations WHERE id = $1 AND business_id = $2`,
    [locationId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const [features, availability] = await Promise.all([effectiveFeatures(businessId), effectiveAppAvailability(businessId)]);
  return {
    schemaVersion: 1,
    location: {
      id: row.id,
      name: row.name,
      address: row.address,
      phone: row.phone,
      timezone: row.timezone,
      businessDayStartMinutes: row.business_day_start_minutes,
      isActive: row.is_active,
    },
    features,
    apps: Object.fromEntries(
      Object.values(availability).map((app) => [app.app, { state: app.state, note: app.note, availableFrom: app.availableFrom }]),
    ),
  };
}

/** The desktop's side, in one transaction. */
export async function applySiteProfile(businessId: string, locationId: string, profile: SiteProfile): Promise<void> {
  if (profile.location.id !== locationId) throw new Error("site_profile_location_mismatch");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE locations
          SET name = $3, address = $4, phone = $5, timezone = $6,
              business_day_start_minutes = $7, is_active = $8
        WHERE id = $1 AND business_id = $2`,
      [
        locationId,
        businessId,
        profile.location.name,
        profile.location.address,
        profile.location.phone,
        profile.location.timezone,
        profile.location.businessDayStartMinutes,
        profile.location.isActive,
      ],
    );
    const flags = Object.entries(profile.features);
    await client.query(
      `INSERT INTO business_features (business_id, flag_key, enabled)
       SELECT $1, input.key, input.enabled
         FROM unnest($2::text[], $3::boolean[]) AS input(key, enabled)
        WHERE EXISTS (SELECT 1 FROM feature_flags f WHERE f.key = input.key)
       ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [businessId, flags.map(([key]) => key), flags.map(([, enabled]) => enabled)],
    );
    const apps = Object.entries(profile.apps);
    await client.query(
      `INSERT INTO business_app_availability (business_id, app_key, state, note, available_from)
       SELECT $1, input.app, input.state, input.note, input.available_from::date
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS input(app, state, note, available_from)
       ON CONFLICT (business_id, app_key) DO UPDATE
         SET state = EXCLUDED.state, note = EXCLUDED.note, available_from = EXCLUDED.available_from, updated_at = now()`,
      [
        businessId,
        apps.map(([app]) => app),
        apps.map(([, record]) => record!.state),
        apps.map(([, record]) => record!.note),
        apps.map(([, record]) => record!.availableFrom),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * At most one attempt per sync interval. Ticks also run on a NOTIFY wake
 * (~1.5 s after each local commit); the profile is not urgent, and each fetch
 * spends the sync token's shared rate limit. `SERVER_SYNC_INTERVAL_MS` in
 * server-sync.ts — not imported, since server-sync imports this module.
 * ponytail: process-local, so a restart may attempt early once; that is fine.
 */
const SITE_PROFILE_INTERVAL_MS = 30_000;
const lastAttemptAt = new Map<string, number>();

/** Tests only: forget the per-business interval gate. */
export function resetSiteProfileGate(): void {
  lastAttemptAt.clear();
}

/** One desktop tick. Never throws for a cloud-side failure; it records it and backs off. */
export async function runSiteProfileSync(businessId: string, now: Date = new Date()): Promise<SiteProfileState> {
  const previous = (await getSetting<SiteProfileState>(businessId, SETTING_KEYS.siteProfileState)) ?? EMPTY_SITE_PROFILE_STATE;
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim() || !config.locationId) return previous;
  if (!attemptDue(previous.nextAttemptAt, now)) return previous;
  const last = lastAttemptAt.get(businessId);
  // A clock that went backwards (elapsed < 0) does not hold the next attempt hostage.
  if (last !== undefined && now.getTime() - last >= 0 && now.getTime() - last < SITE_PROFILE_INTERVAL_MS) return previous;
  lastAttemptAt.set(businessId, now.getTime());
  let next: SiteProfileState;
  try {
    const response = await fetch(`${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/site-profile`, {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`site_profile_rejected: HTTP ${response.status}`);
    const profile = validateSiteProfile(await response.json());
    if (!profile) throw new Error("invalid_site_profile");
    // Applied every time, not only on a new hash: the apply is idempotent, and
    // re-applying is what lands a flag an older desktop skipped once it is
    // updated, and what repairs a local edit to the cloud's copy.
    await applySiteProfile(businessId, config.locationId, profile);
    const hash = siteProfileHash(profile);
    const changed = hash !== previous.hash;
    // ponytail: nothing changed and nothing to clear — skip the settings write every 30 s.
    if (!changed && previous.lastError === null) return previous;
    next = siteProfileSucceeded(previous, hash, changed, now);
  } catch (error) {
    next = siteProfileFailed(previous, error instanceof Error ? error.message : String(error), now);
  }
  await setSetting(businessId, SETTING_KEYS.siteProfileState, next);
  return next;
}
