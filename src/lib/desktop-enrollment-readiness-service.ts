/**
 * Gathers the persisted facts `evaluateEnrollmentReadiness` decides from
 * (issue #1115 §A.2). Read-only; the rules live in the pure module.
 *
 * Reuses `computeSetupState` — the one place the wizard's required
 * prerequisites are derived — instead of counting accounts, tax or menu items a
 * second time, so the desktop's gate and the wizard's Finish page cannot
 * disagree about what "set up" means. (That call also heals stale wizard
 * markers, which is idempotent and what every wizard page already does.)
 *
 * DB-touching, so no direct unit test per repo convention; the decision is the
 * pure module's and is unit-tested, the gathering is covered by
 * `integration/desktop-enrollment-readiness.integration.test.ts`.
 */
import { query, withTenant } from "./db";
import {
  evaluateEnrollmentReadiness,
  type EnrollmentFacts,
  type EnrollmentReadiness,
} from "./desktop-enrollment-readiness";
import { isFeatureEnabled } from "./features";
import { businessLocations, computeSetupState } from "./setup-state";
import { wizardStepsForIndustry } from "./wizard-steps";

export interface EnrollmentReadinessRequest {
  businessId: string;
  /** The branch the desktop asked for; absent means "the only active one". */
  locationId?: string | null;
  /** The newest pairing snapshot version the client can read, when it said. */
  clientMaxSnapshotVersion?: number | null;
}

export async function readEnrollmentFacts(request: EnrollmentReadinessRequest): Promise<EnrollmentFacts> {
  const { businessId } = request;
  return withTenant(businessId, async () => {
    const [{ rows: businessRows }, setup, locations, owners, paymentWays, entitled] = await Promise.all([
      query<{ status: "active" | "suspended" | "archived" }>(
        "SELECT status FROM businesses WHERE id = $1",
        [businessId],
      ),
      computeSetupState(businessId),
      businessLocations(businessId),
      query<{ n: string }>(
        "SELECT count(*) AS n FROM users WHERE business_id = $1 AND role = 'owner' AND is_active",
        [businessId],
      ),
      query<{ n: string }>(
        "SELECT count(*) AS n FROM payment_methods WHERE business_id = $1 AND is_active",
        [businessId],
      ),
      isFeatureEnabled(businessId, "site_cloud_sync"),
    ]);
    const business = businessRows[0] ?? null;
    const industry = setup.business?.industry ?? null;
    const hasMenuStep = industry !== null && wizardStepsForIndustry(industry).includes("menu");

    let sellableMenuItemsByLocation: Record<string, number> | null = null;
    if (hasMenuStep) {
      const { rows } = await query<{ location_id: string; n: string }>(
        `SELECT mi.location_id, count(*) AS n
           FROM menu_items mi JOIN locations l ON l.id = mi.location_id
          WHERE l.business_id = $1 AND l.is_active AND mi.is_active
          GROUP BY mi.location_id`,
        [businessId],
      );
      sellableMenuItemsByLocation = Object.fromEntries(rows.map((row) => [row.location_id, Number(row.n)]));
    }

    return {
      business: { exists: business !== null, status: business?.status ?? null },
      setup: setup.readiness,
      setupCompletedAt: setup.progress.completedAt ?? null,
      activeOwners: Number(owners.rows[0]?.n ?? 0),
      activeLocations: locations.map((location) => ({ id: location.id, name: location.name })),
      requestedLocationId: request.locationId ?? null,
      sellableMenuItemsByLocation,
      activePaymentWays: Number(paymentWays.rows[0]?.n ?? 0),
      siteCloudSyncEntitled: entitled,
      clientMaxSnapshotVersion: request.clientMaxSnapshotVersion ?? null,
    };
  });
}

export async function readEnrollmentReadiness(request: EnrollmentReadinessRequest): Promise<EnrollmentReadiness> {
  return evaluateEnrollmentReadiness(await readEnrollmentFacts(request));
}
