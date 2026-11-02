/**
 * «Why can (or can't) this business use X?» — one read that lays every layer
 * of the answer side by side for the super-admin console.
 *
 * It explains; it never decides. The decision stays with `effectiveFeatureDetails`
 * (the request gate) and `resolveBusinessCapability` (the structured resolver),
 * which share `effective-access.ts`. This report adds the one thing neither can:
 * the plan's commercial key beside the gate key it relates to
 * (`feature-catalogue.ts`), so «access granted outside the plan» and «plan
 * includes it, gate keeps it off» show up as findings instead of surprises.
 */
import { withTenant } from "./db";
import { effectiveFeatureDetails, type EffectiveFeatureDetail } from "./features";
import { getBusinessEntitlements } from "./entitlement-service";
import {
  FEATURE_RELATIONS,
  assessRelation,
  type FeatureRelation,
  type RelationStatus,
} from "./feature-catalogue";

export interface RelationReport extends FeatureRelation {
  status: RelationStatus;
  gate: { enabled: boolean; flagSource: EffectiveFeatureDetail["flag"]["source"]; priced: boolean };
  commercial: { priced: boolean; entitled: boolean; source: string | null };
}

export interface BusinessAccessReport {
  businessId: string;
  planKey: string;
  subscriptionStatus: string | null;
  /** Keys the plan prices (`billing_plan_features`) for this business's plan. */
  planFeatureKeys: string[];
  /** Capabilities currently on or off because of an override, and which kind. */
  overrides: { key: string; enabled: boolean; source: "billing_override" | "business_override" }[];
  features: EffectiveFeatureDetail[];
  relations: RelationReport[];
}

export async function getBusinessAccessReport(businessId: string): Promise<BusinessAccessReport> {
  const [snapshot, features] = await Promise.all([
    withTenant(businessId, () => getBusinessEntitlements(businessId)),
    effectiveFeatureDetails(businessId),
  ]);
  const byKey = new Map(features.map((f) => [f.key, f]));

  const relations: RelationReport[] = FEATURE_RELATIONS.map((relation) => {
    const gate = byKey.get(relation.gateKey);
    const commercialAccess = snapshot.featureAccess.get(relation.commercialKey) ?? null;
    const gateEnabled = gate?.enabled ?? true;
    const commercialPriced = commercialAccess != null;
    const commercialEntitled = commercialAccess ? commercialAccess.entitled || commercialAccess.metered : false;
    return {
      ...relation,
      status: assessRelation({ gateEnabled, commercialPriced, commercialEntitled }),
      gate: {
        enabled: gateEnabled,
        flagSource: gate?.flag.source ?? "unregistered",
        priced: gate?.priced ?? false,
      },
      commercial: {
        priced: commercialPriced,
        entitled: commercialEntitled,
        source: commercialAccess?.source ?? null,
      },
    };
  });

  return {
    businessId,
    planKey: snapshot.planKey,
    subscriptionStatus: snapshot.subscriptionStatus,
    planFeatureKeys: [...snapshot.featureAccess.keys()].sort(),
    overrides: features
      .filter((f) => f.flag.source === "billing_override" || f.flag.source === "business_override")
      .map((f) => ({
        key: f.key,
        enabled: f.flag.enabled,
        source: f.flag.source as "billing_override" | "business_override",
      })),
    features,
    relations,
  };
}
