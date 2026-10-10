/**
 * Server-side helpers for the setup wizard: session/role guard for the
 * /api/setup/* routes and the aggregated wizard state used by the UI.
 */
import { NextResponse } from "next/server";
import { requirePermission, type Role, type SessionPayload } from "./auth";
import { PERMISSIONS, type Permission } from "./permissions";
import { query, withTenant, withoutTenantScope } from "./db";
import {
  accessibleLocationIds,
  isLocationScope,
  canAccessLocation,
  canSwitchBranches,
  defaultAccessibleLocationId,
  type LocationAccessContext,
} from "./location-access";
import { isLocalOnly } from "./deployment-mode";
import { getBusinessIndustry } from "./industry-guard";
import {
  getSetting,
  getWizardProgress,
  markStepDone,
  reconcileWizardSteps,
  SETTING_KEYS,
  type WizardProgress,
} from "./settings";
import type { Industry } from "./industries";
import { setupReadiness, type SetupReadiness } from "./setup-readiness";
export { setupReadiness, type SetupReadiness } from "./setup-readiness";
// Re-exported for this module's existing importers (the wizard step list
// used to live here) -- moved to wizard-steps.ts because it's also imported
// from client components (src/app/setup/steps.ts), which can't pull in this
// file's next/server and db imports.
export {
  OPTIONAL_STEPS,
  WIZARD_STEPS,
  wizardStepsForIndustry,
  requiredStepsForIndustry,
  catalogueHrefFor,
  type WizardStep,
} from "./wizard-steps";
import {
  requiredStepsForIndustry,
  wizardStepsForIndustry,
  type WizardStep,
} from "./wizard-steps";

export interface BusinessPrefs {
  currencyDisplay: "toman" | "rial";
  language: "fa";
  calendar: "jalali";
}

export interface CostingSetting {
  method: "fifo" | "lifo" | "weighted_average";
  /**
   * سیستم دائمی/ادواری. Absent on settings written before the periodic
   * system existed — treat as "perpetual" (the only behaviour back then).
   */
  system?: "perpetual" | "periodic";
  lockedAt: string | null;
}

export interface TaxSetting {
  /** percent, e.g. 10 */
  defaultRate: number;
}

/** Compatibility name for setup callers; authorization is capability-based. */
export async function requireManager(permission: Permission = PERMISSIONS.settingsManage) {
  return requirePermission(permission);
}

/**
 * Issue #808 §8 — refuses a wizard endpoint whose step this business's own
 * step list does not contain. `costing` and `menu` are F&B steps: their tables
 * (`inventory.costing`, `menu_categories`/`menu_items`) are not part of a
 * trade-goods or service business, whose wizard never shows them. The pages
 * already skip themselves for the wrong industry; this is the same rule on the
 * route, so a direct POST (or a stale tab) cannot write a chart of menu items
 * into a business whose menu module does not exist.
 *
 * Fails open only when the industry cannot be read at all — that means no row
 * was visible, and the caller's own tenancy guard is the thing that should
 * decide, not this check.
 */
export async function requireSetupStepForIndustry(
  businessId: string,
  step: WizardStep,
): Promise<NextResponse | null> {
  const industry = await getBusinessIndustry(businessId);
  if (!industry) return null;
  if (wizardStepsForIndustry(industry).includes(step)) return null;
  return NextResponse.json({ error: "step_not_in_industry" }, { status: 403 });
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

export interface SetupState {
  needsBootstrap: boolean;
  /** True on a standalone desktop install: no online platform, local-drive backup only. */
  localOnly: boolean;
  business: { id: string; name: string; industry: Industry } | null;
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
  } | null;
  prefs: BusinessPrefs | null;
  costing: (CostingSetting & { locked: boolean }) | null;
  tax: TaxSetting | null;
  progress: WizardProgress;
  counts: {
    accounts: number;
    users: number;
    categories: number;
    items: number;
    /** Active menu items — what the F&B menu step actually requires (issue #808 §3). */
    sellableItems: number;
    printers: number;
    inventoryItems: number;
  };
  hasStockMovements: boolean;
  hasOpeningEntry: boolean;
  /**
   * Required-prerequisite readiness, derived from persisted data — *not* from
   * `progress.steps`. `missingForCompletion` is `readiness.missing`, kept under
   * its existing name for the Finish page and the AI setup tool.
   */
  readiness: SetupReadiness;
  /** requirements still missing before the wizard can be completed */
  missingForCompletion: string[];
}

/**
 * The reconciliation a `progress.steps` map needs against derived readiness:
 * required markers the data supports but that are absent (a progress write
 * failed after the domain write committed) and required markers the data does
 * not support (an older, weaker completion rule — e.g. the menu step on a
 * category alone). Optional steps are never touched.
 */
export function wizardStepReconciliation(
  progressSteps: Record<string, string>,
  readiness: SetupReadiness,
): { done: string[]; undone: string[] } {
  const done: string[] = [];
  const undone: string[] = [];
  for (const [step, satisfied] of Object.entries(readiness.steps)) {
    const marked = Boolean(progressSteps[step]);
    if (satisfied && !marked) done.push(step);
    if (!satisfied && marked) undone.push(step);
  }
  return { done, undone };
}

/**
 * Whether this install has been claimed by anyone at all.
 *
 * Deliberately install-wide, not per-business: every caller is a first-run
 * guard asked before a tenant exists — the root page choosing between /login
 * and the wizard, and the two routes (`/api/setup/bootstrap`, `/api/setup/pair`)
 * that must refuse to run a second time. Scoping it is therefore impossible,
 * and leaving it unscoped is not enough either: under row-level security an
 * unscoped count matches no policy and reads 0 however many users exist, which
 * silently reopened bootstrap as an unauthenticated "create another business"
 * endpoint and pinned the root page to the wizard forever. Hence the bypass —
 * it returns one boolean about the install and never a row.
 */
export async function hasAnyUser(): Promise<boolean> {
  return withoutTenantScope(
    "first-run",
    async () => (await count("SELECT count(*) AS n FROM users", [])) > 0,
  );
}

/**
 * True once the wizard has been formally completed for this business — the
 * canonical lifecycle marker is `progress.completedAt` and nothing else.
 *
 * Issue #808 §1/§2: this used to also answer true when every *required* step
 * was satisfied, which ejected the owner from `/setup` the moment Accounts or
 * Menu went green — before Hardware, Backup, Opening and Finish were reached —
 * and let a business behave as complete while `completedAt` stayed null (so
 * the completion audit event never existed). Readiness ("are the domain
 * prerequisites present?") is `computeSetupState().readiness`; only the
 * deliberate Finish transition, pairing and explicit provisioning write the
 * marker.
 *
 * Runs under `withTenant(businessId)` rather than whatever ambient scope the
 * caller happens to have. Server components (`app/page.tsx`, `app/setup/*`)
 * only ever carry `getSession()`'s `enterWith()` scope, which a concurrent
 * background tick's `.run()` can clobber mid-request (see the `withTenantScope`
 * doc comment in src/lib/auth.ts). Under RLS the reads then come back empty,
 * so a finished business would be bounced back into the wizard on every login
 * even though every step is green. `.run()` — what `withTenant` uses — has no
 * such race.
 */
export async function isSetupComplete(businessId: string): Promise<boolean> {
  return withTenant(businessId, async () => {
    const progress = await getWizardProgress(businessId);
    return Boolean(progress.completedAt);
  });
}

export interface LocationRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  /** The branch's IANA time zone, used when a screen turns an instant into a local Jalali date. */
  timezone: string;
  /**
   * The branch's identifying colour (migration 0149). Carried on every
   * location read because the switcher in the shell header paints itself with
   * the *active* branch's colour, and that control renders before any
   * branch-management screen has been opened.
   */
  color: string;
}

/**
 * The first branch created for a business. Used by the setup wizard, which
 * necessarily runs before there is more than one branch to choose between,
 * and by `resolveActiveLocation` as the deterministic tie-breaker for a
 * fully-roaming member (see `location-access.ts`).
 */
export async function getPrimaryLocation(
  businessId: string,
): Promise<LocationRow | null> {
  const { rows } = await query<LocationRow>(
    `SELECT id, name, address, phone, timezone, color FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0] ?? null;
}

/** Every active branch of a business, oldest first — the stable order location-access.ts relies on. */
export async function businessLocations(
  businessId: string,
): Promise<LocationRow[]> {
  const { rows } = await query<LocationRow>(
    `SELECT id, name, address, phone, timezone, color FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at`,
    [businessId],
  );
  return rows;
}

/** A membership's role and branch restrictions, as location-access.ts needs them. */
async function locationAccessContext(
  userId: string,
): Promise<LocationAccessContext> {
  const [{ rows: userRows }, { rows: assignmentRows }] = await Promise.all([
    query<{ role: Role; location_id: string | null; location_scope: LocationAccessContext["locationScope"] }>(
      "SELECT role, location_id, location_scope FROM users WHERE id = $1",
      [userId],
    ),
    query<{ location_id: string }>(
      "SELECT location_id FROM user_locations WHERE user_id = $1",
      [userId],
    ),
  ]);
  return {
    role: userRows[0]?.role ?? "cashier",
    defaultLocationId: userRows[0]?.location_id ?? null,
    assignedLocationIds: assignmentRows.map((r) => r.location_id),
    // The stored policy, which is what makes the widening fallback in the old
    // resolution unreachable. A row that somehow holds an unrecognised value
    // degrades to the narrowest scope rather than to the widest.
    locationScope: isLocationScope(userRows[0]?.location_scope) ? userRows[0].location_scope : "home",
  };
}

/**
 * The branch a request should be scoped to: the session's active branch if
 * the caller can still reach it, otherwise their default accessible branch.
 *
 * This is the Phase 14 replacement for calling `getPrimaryLocation` from a
 * route handler. Role and branch assignment are re-read from the database
 * (not trusted from the session token), for the same reason `requirePermission`
 * does: a membership's assignment can change between login and this request,
 * and access should follow the change rather than the token's age.
 *
 * Deliberately returns the same thing `getPrimaryLocation` always did for a
 * single-location business with no assignments: fully roaming access resolves
 * to that one branch, so this is a no-op for every install that predates
 * Phase 14.
 */
export async function resolveActiveLocation(
  session: SessionPayload,
): Promise<LocationRow | null> {
  return resolveActiveLocationForUser(
    session.businessId,
    session.sub,
    session.activeLocationId ?? session.locationId ?? null,
  );
}

/**
 * The same resolution for a caller that has a member id rather than a session.
 *
 * The AI's read tools receive `businessId` and the acting user and no session
 * (issue #819); they must resolve the member's branch exactly as a route does
 * rather than falling back to the business's primary branch — which is what
 * `primaryLocationId` did, and meant a cashier asking the assistant about
 * «فروش امروز» was answered with whichever branch the business created first.
 *
 * `requestedLocationId` is the session's active branch when there is one; it is
 * honored only if the member can still reach it.
 */
export async function resolveActiveLocationForUser(
  businessId: string,
  userId: string,
  requestedLocationId: string | null = null,
): Promise<LocationRow | null> {
  const [locations, ctx] = await Promise.all([
    businessLocations(businessId),
    locationAccessContext(userId),
  ]);
  if (locations.length === 0) return null;

  const ids = locations.map((l) => l.id);
  const targetId =
    requestedLocationId && canAccessLocation(ctx, ids, requestedLocationId)
      ? requestedLocationId
      : defaultAccessibleLocationId(ctx, ids);

  return locations.find((l) => l.id === targetId) ?? null;
}

/** Every branch this session's member may switch to, for the branch switcher UI. */
export async function accessibleLocationsFor(session: SessionPayload): Promise<{
  locations: LocationRow[];
  canSwitch: boolean;
  businessLocationCount: number;
}> {
  const [locations, ctx] = await Promise.all([
    businessLocations(session.businessId),
    locationAccessContext(session.sub),
  ]);
  const ids = locations.map((l) => l.id);
  const accessible = new Set(accessibleLocationIds(ctx, ids));
  return {
    locations: locations.filter((l) => accessible.has(l.id)),
    canSwitch: canSwitchBranches(ctx, ids),
    /**
     * How many branches the *business* has, before this member's access is
     * applied. `locations` above is already filtered, so a cashier pinned to
     * one branch of a five-branch business is indistinguishable from a member
     * of a single-branch business by its length alone — and the two want
     * opposite things from the switcher: the first needs to be told which
     * branch they are in, the second has no such question and should not be
     * given a permanent header chip answering it.
     */
    businessLocationCount: locations.length,
  };
}

export async function costingLocked(businessId: string): Promise<boolean> {
  const costing = await getSetting<CostingSetting>(
    businessId,
    SETTING_KEYS.costing,
  );
  if (costing?.lockedAt) return true;
  const n = await count(
    `SELECT count(*) AS n FROM stock_movements sm
      JOIN locations l ON l.id = sm.location_id
     WHERE l.business_id = $1`,
    [businessId],
  );
  if (n > 0) return true;
  // A periodic (ادواری) business never writes stock_movements — its first
  // inventory transaction is a received purchase (journal-only) or a period
  // close, so those lock the choice on the same terms.
  const periodicActivity = await count(
    `SELECT (SELECT count(*) FROM purchases p JOIN locations l ON l.id = p.location_id
              WHERE l.business_id = $1 AND p.status = 'received')
          + (SELECT count(*) FROM periodic_closings WHERE business_id = $1) AS n`,
    [businessId],
  );
  return periodicActivity > 0;
}

/**
 * Self-scopes for the same reason `isSetupComplete` does: called from server
 * components whose ambient scope is only `enterWith()`-based and therefore
 * clobberable by a background tick. Wrapping here means every caller — the
 * `/api/setup/*` routes (already `.run()`-scoped) included — reads the same
 * reliable way.
 */
export async function computeSetupState(businessId: string): Promise<SetupState> {
  return withTenant(businessId, () => computeSetupStateInner(businessId));
}

async function computeSetupStateInner(
  businessId: string,
): Promise<SetupState> {
  const { rows: bizRows } = await query<{
    id: string;
    name: string;
    industry: Industry;
  }>("SELECT id, name, industry FROM businesses WHERE id = $1", [businessId]);
  const business = bizRows[0] ?? null;
  const industry = business?.industry ?? "food_service";
  const location = business ? await getPrimaryLocation(businessId) : null;

  const [prefs, costing, tax, progress, localOnly] = await Promise.all([
    getSetting<BusinessPrefs>(businessId, SETTING_KEYS.businessPrefs),
    getSetting<CostingSetting>(businessId, SETTING_KEYS.costing),
    getSetting<TaxSetting>(businessId, SETTING_KEYS.tax),
    getWizardProgress(businessId),
    isLocalOnly(businessId),
  ]);

  const [
    accounts,
    users,
    categories,
    items,
    sellableItems,
    printers,
    inventoryItems,
    stockMovements,
    openingEntries,
  ] = await Promise.all([
    count("SELECT count(*) AS n FROM accounts WHERE business_id = $1", [
      businessId,
    ]),
    count(
      "SELECT count(*) AS n FROM users WHERE business_id = $1 AND is_active",
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM menu_categories mc JOIN locations l ON l.id = mc.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM menu_items mi JOIN locations l ON l.id = mi.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM menu_items mi JOIN locations l ON l.id = mi.location_id
          WHERE l.business_id = $1 AND mi.is_active`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM printers p JOIN locations l ON l.id = p.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM inventory_items ii JOIN locations l ON l.id = ii.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM stock_movements sm JOIN locations l ON l.id = sm.location_id
          WHERE l.business_id = $1`,
      [businessId],
    ),
    count(
      `SELECT count(*) AS n FROM journal_entries
          WHERE business_id = $1 AND source_type = 'opening'`,
      [businessId],
    ),
  ]);

  const readiness = setupReadiness({
    industry,
    hasBusiness: business !== null,
    hasLocation: location !== null,
    hasPrefs: prefs !== null,
    hasCosting: costing !== null,
    hasTax: tax !== null,
    accounts,
    sellableMenuItems: sellableItems,
  });

  // Issue #808 §6/§9: keep the stored markers honest about the data above, in
  // one atomic statement. This is the self-healing half of the fix — a step
  // whose domain write committed but whose progress write failed becomes
  // marked here, a marker written by an older weaker rule (the menu step on a
  // category alone) is cleared here, and a step endpoint's own retry repairs
  // itself from this same derived truth. A formally completed business is left
  // exactly as it finished.
  let effectiveProgress = progress;
  if (!progress.completedAt) {
    const diff = wizardStepReconciliation(progress.steps, readiness);
    if (diff.done.length > 0 || diff.undone.length > 0) {
      effectiveProgress = await reconcileWizardSteps(businessId, diff);
    }
  }

  return {
    needsBootstrap: false,
    localOnly,
    business,
    location,
    prefs,
    costing: costing
      ? { ...costing, locked: Boolean(costing.lockedAt) || stockMovements > 0 }
      : null,
    tax,
    progress: effectiveProgress,
    counts: { accounts, users, categories, items, sellableItems, printers, inventoryItems },
    hasStockMovements: stockMovements > 0,
    hasOpeningEntry: openingEntries > 0,
    readiness,
    missingForCompletion: readiness.missing,
  };
}

/**
 * Active menu items at one branch — what the F&B menu step requires (issue
 * #808 §3). Private to this module: `computeSetupState` (business-wide) and
 * `syncMenuStepProgress` (one branch, at the moment of a menu write) are its
 * only callers, and keeping it unexported is what stops a second, divergent
 * "is the menu ready?" count growing elsewhere.
 */
async function countSellableMenuItems(locationId: string): Promise<number> {
  return count(
    "SELECT count(*) AS n FROM menu_items WHERE location_id = $1 AND is_active",
    [locationId],
  );
}

/**
 * The menu step's marker, derived from what is actually sellable at a branch
 * (issue #808 §3). Creating a category is no longer evidence of a usable menu;
 * at least one active item is. A marker left behind by the old rule is cleared
 * here, and the same derived rule runs business-wide in `computeSetupState`,
 * so the wizard's ordering and its Finish validation cannot disagree.
 */
export async function syncMenuStepProgress(
  businessId: string,
  locationId: string,
): Promise<WizardProgress> {
  const sellable = await countSellableMenuItems(locationId);
  if (sellable > 0) return markStepDone(businessId, "menu");
  return reconcileWizardSteps(businessId, { done: [], undone: ["menu"] });
}
