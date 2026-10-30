/**
 * The database half of app availability (`app-availability.ts` holds the rules
 * and the vocabulary; this reads and writes the two tables migration 0128 adds).
 *
 * Deliberately shaped like `features.ts` + the flag half of
 * `platform-service.ts`, because it is the same idea one axis over:
 *
 *   effectiveAppAvailability(businessId)  ~ effectiveFeatures(businessId)
 *   platformAppAvailability()             ~ listFeatureFlags()
 *   businessAppAvailability(businessId)   ~ businessFeatures(businessId)
 *   setPlatformAppAvailability / setBusinessAppAvailability ~ setBusinessFeature
 *
 * Tenant reads name their business and wrap the query in `withTenant(...)`
 * rather than trusting the ambient scope — the same load-bearing detail
 * `effectiveFeatures` documents at length: a server component's `enterWith()`
 * scope is lost the moment any concurrent `run()` interleaves, and
 * `business_app_availability` is RLS-protected, so an unscoped read would
 * silently lose every override and answer "available" for an app the operator
 * had switched off.
 */
import { query, withoutTenantScope, withTenant } from "./db";
import { APP_KEYS, type AppKey } from "./apps";
import {
  DEFAULT_APP_AVAILABILITY,
  isAppAvailabilityState,
  resolveAppAvailability,
  type AppAvailabilityMap,
  type AppAvailabilityRecord,
  type AppAvailabilityState,
  type ResolvedAppAvailability,
} from "./app-availability";

interface Row {
  [key: string]: unknown;
  app_key: string;
  state: string;
  note: string | null;
  available_from: Date | string | null;
  updated_at?: Date | string | null;
}

/** `date` columns come back as a Date (or a string); the wire is always ISO `YYYY-MM-DD`. */
function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // A Postgres `date` arrives as local midnight, so build the string from the
  // local parts rather than toISOString() (which would shift it a day west).
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function toRecord(row: Row | undefined): AppAvailabilityRecord | null {
  if (!row) return null;
  if (!isAppAvailabilityState(row.state)) return null;
  return { state: row.state, note: row.note, availableFrom: isoDate(row.available_from) };
}

function recordsByApp(rows: Row[]): Partial<Record<AppKey, AppAvailabilityRecord>> {
  const map: Partial<Record<AppKey, AppAvailabilityRecord>> = {};
  for (const row of rows) {
    // A row whose key is no longer in the registry (an app renamed in code) is
    // ignored rather than fatal — the registry is the source of truth for what
    // an app *is*, this table only says how it is doing.
    if (!(APP_KEYS as readonly string[]).includes(row.app_key)) continue;
    const record = toRecord(row);
    if (record) map[row.app_key as AppKey] = record;
  }
  return map;
}

/**
 * Every app's effective state for one business — the read the dashboard shell,
 * the page guards and the API guard all use.
 *
 * One round trip: the platform rows and this business's overrides in a single
 * query, resolved in `app-availability.ts` so the precedence rule lives in the
 * pure module that is unit-tested.
 */
export async function effectiveAppAvailability(businessId: string): Promise<AppAvailabilityMap> {
  const { rows } = await withTenant(businessId, () =>
    query<Row & { scope: string }>(
      `SELECT 'platform' AS scope, app_key, state, note, available_from
         FROM app_availability
        UNION ALL
       SELECT 'business' AS scope, app_key, state, note, available_from
         FROM business_app_availability
        WHERE business_id = $1`,
      [businessId],
    ),
  );
  const platform = recordsByApp(rows.filter((r) => r.scope === "platform"));
  const business = recordsByApp(rows.filter((r) => r.scope === "business"));
  return Object.fromEntries(
    APP_KEYS.map((app) => [app, resolveAppAvailability(app, platform[app], business[app])]),
  ) as AppAvailabilityMap;
}

/** Is this one app usable for this business right now? */
export async function isAppAvailable(businessId: string, app: AppKey): Promise<boolean> {
  const map = await effectiveAppAvailability(businessId);
  // Fails open on an app the map somehow lacks, for the same reason
  // `isFeatureEnabled` does: a gap in a registry map is a bug in the mapping,
  // not a business's entitlement to lose over one.
  return map[app]?.usable ?? true;
}

// ---------------------------------------------------------------------------
// The platform console's side
// ---------------------------------------------------------------------------

export interface PlatformAppAvailability extends ResolvedAppAvailability {
  /** How many businesses pin this app to something other than the platform row. */
  overrideCount: number;
  updatedAt: string | null;
}

/** The platform-wide state of every app in the registry, for the console. */
export async function platformAppAvailability(): Promise<PlatformAppAvailability[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<Row & { override_count: string }>(
      `SELECT a.app_key,
              a.state,
              a.note,
              a.available_from,
              a.updated_at,
              (SELECT count(*) FROM business_app_availability b WHERE b.app_key = a.app_key)
                AS override_count
         FROM app_availability a`,
    ),
  );
  const byKey = new Map(rows.map((r) => [r.app_key, r]));
  return APP_KEYS.map((app) => {
    const row = byKey.get(app);
    const resolved = resolveAppAvailability(app, toRecord(row) ?? DEFAULT_APP_AVAILABILITY);
    return {
      ...resolved,
      overrideCount: Number(row?.override_count ?? 0),
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

export interface BusinessAppAvailability extends ResolvedAppAvailability {
  /** The app's name, as the rail and the dashboard call it. */
  label: string;
  /** The platform-wide state this business would follow with no override. */
  platformState: AppAvailabilityState;
  /** True when this business pins the app itself rather than following the platform. */
  overridden: boolean;
}

/**
 * One business's apps as the console shows them: the platform state, the
 * override if any, and what is actually in force.
 *
 * Read through the console's deliberate tenant bypass (the operator is
 * administering a business they are not a member of) — the same
 * `withoutTenantScope("platform", …)` every other console read uses.
 */
export async function businessAppAvailability(
  businessId: string,
): Promise<Omit<BusinessAppAvailability, "label">[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<Row & { scope: string }>(
      `SELECT 'platform' AS scope, app_key, state, note, available_from
         FROM app_availability
        UNION ALL
       SELECT 'business' AS scope, app_key, state, note, available_from
         FROM business_app_availability
        WHERE business_id = $1`,
      [businessId],
    ),
  );
  const platform = recordsByApp(rows.filter((r) => r.scope === "platform"));
  const business = recordsByApp(rows.filter((r) => r.scope === "business"));
  return APP_KEYS.map((app) => {
    const override = business[app];
    const resolved = resolveAppAvailability(app, platform[app], override);
    return {
      ...resolved,
      platformState: platform[app]?.state ?? DEFAULT_APP_AVAILABILITY.state,
      overridden: Boolean(override),
    };
  });
}

export interface AppAvailabilityWrite {
  state: AppAvailabilityState;
  note?: string | null;
  /** ISO/Gregorian `YYYY-MM-DD`; the console collects it with `JalaliDatePicker`. */
  availableFrom?: string | null;
}

/**
 * Issue #902 §9 item 6 — the state the caller asked to write is not one this
 * deployment knows.
 *
 * The console route validated with `isAppAvailabilityState` and the MCP tool
 * did not (`write as never`), so an unknown state from a tool call reached the
 * column's CHECK and came back as a database error — a 500 for what is a client
 * mistake. Validating at the write, the one place every caller passes through,
 * makes the answer the same whoever asked.
 */
export class InvalidAppAvailabilityStateError extends Error {
  constructor(readonly value: unknown) {
    super("invalid_app_state");
    this.name = "InvalidAppAvailabilityStateError";
  }
}

/**
 * The guard both writers share.
 *
 * `write` is typed, but a typed parameter is not a check: the MCP bridge, a
 * JSON body and a local-activation bundle all arrive as `unknown` and are cast
 * on the way in. This is where the cast stops being trusted.
 */
function assertWritable(write: AppAvailabilityWrite): AppAvailabilityWrite {
  if (!isAppAvailabilityState(write?.state)) throw new InvalidAppAvailabilityStateError(write?.state);
  return write;
}

/** Set the platform-wide state of one app (`features.write`). */
export async function setPlatformAppAvailability(
  app: AppKey,
  writeInput: AppAvailabilityWrite,
  adminId: string | null,
): Promise<void> {
  const write = assertWritable(writeInput);
  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO app_availability (app_key, state, note, available_from, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (app_key) DO UPDATE
          SET state = EXCLUDED.state,
              note = EXCLUDED.note,
              available_from = EXCLUDED.available_from,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [app, write.state, write.note?.trim() || null, write.availableFrom || null, adminId],
    ),
  );
}

/**
 * Pin one business's state for an app, or clear the pin.
 *
 * `write: null` deletes the override so the business follows the platform row
 * again — the exact shape `setBusinessFeature(…, null)` has, so the console's
 * two switches behave identically.
 */
export async function setBusinessAppAvailability(
  businessId: string,
  app: AppKey,
  writeInput: AppAvailabilityWrite | null,
  adminId: string | null,
): Promise<void> {
  const write = writeInput ? assertWritable(writeInput) : null;
  await withoutTenantScope("platform", async () => {
    if (!write) {
      await query(`DELETE FROM business_app_availability WHERE business_id = $1 AND app_key = $2`, [
        businessId,
        app,
      ]);
      return;
    }
    await query(
      `INSERT INTO business_app_availability
         (business_id, app_key, state, note, available_from, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (business_id, app_key) DO UPDATE
          SET state = EXCLUDED.state,
              note = EXCLUDED.note,
              available_from = EXCLUDED.available_from,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [
        businessId,
        app,
        write.state,
        write.note?.trim() || null,
        write.availableFrom || null,
        adminId,
      ],
    );
  });
}
