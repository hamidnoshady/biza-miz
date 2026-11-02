/**
 * One effective-access answer: the request gate (`isFeatureEnabled`, the
 * function `withTenantScope` and every gated page call) and the structured
 * resolver (`resolveBusinessCapability`) must not be able to disagree.
 *
 * Before the two shared `effective-access.ts`, the gate read only the rollout
 * flag and the legacy business row. An audited billing capability override
 * therefore changed what the resolver said and nothing the gate enforced, and
 * a priced add-on nobody had bought, or a plan inclusion whose subscription had
 * lapsed, was refused by one and served by the other.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let features: typeof import("../src/lib/features");
let ent: typeof import("../src/lib/entitlement-service");
let plans: typeof import("../src/lib/billing-plans-service");
let subs: typeof import("../src/lib/subscription-service");

const BID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(BID, fn);
}

async function setBillingOverride(key: string, enabled: boolean, expiresAt: string | null = null) {
  await db.query(
    `INSERT INTO business_billing_overrides (business_id, kind, target, value_bool, reason, expires_at)
     VALUES ($1, 'capability', $2, $3, 'آزمون دسترسی', $4)
     ON CONFLICT (business_id, kind, target) DO UPDATE SET
       value_bool = EXCLUDED.value_bool, expires_at = EXCLUDED.expires_at, active = true`,
    [BID, key, enabled, expiresAt],
  );
}

async function setLegacyOverride(key: string, enabled: boolean) {
  await db.query(
    `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [BID, key, enabled],
  );
}

async function gateAndResolver(key: string) {
  const gate = await features.isFeatureEnabled(BID, key);
  const resolved = await scoped(() => ent.resolveBusinessCapability(BID, key));
  return { gate, resolved };
}

beforeAll(async () => {
  databaseName = `pos_effective_access_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  dbLib = await import("../src/lib/db");
  features = await import("../src/lib/features");
  ent = await import("../src/lib/entitlement-service");
  plans = await import("../src/lib/billing-plans-service");
  subs = await import("../src/lib/subscription-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  for (const [key, defaultEnabled] of [
    ["ea_free", true],
    ["ea_off", false],
    ["ea_included", true],
    ["ea_addon", true],
    ["ea_metered", true],
  ] as const) {
    await db.query(
      `INSERT INTO feature_flags (key, name, default_enabled) VALUES ($1, $1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, defaultEnabled],
    );
  }
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه دسترسی', 'access-cafe', 'free')`,
    [BID],
  );
  await scoped(async () => {
    await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "admin" });
    await plans.savePlanFeature({ planKey: "pro", featureKey: "ea_included", pricingModel: "included", priceRial: 0, sortOrder: 90 });
    await plans.savePlanFeature({ planKey: "pro", featureKey: "ea_addon", pricingModel: "addon", priceRial: 500_000, sortOrder: 91 });
    await plans.savePlanFeature({ planKey: "pro", featureKey: "ea_metered", pricingModel: "per_use", priceRial: 10_000, sortOrder: 92 });
  });
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("rollout layer: override precedence", () => {
  it("an unpriced capability is governed by the flag alone, and gate and resolver agree", async () => {
    const free = await gateAndResolver("ea_free");
    expect(free.gate).toBe(true);
    expect(free.resolved).toMatchObject({ allowed: true, source: "flag" });

    const off = await gateAndResolver("ea_off");
    expect(off.gate).toBe(false);
    expect(off.resolved).toMatchObject({ allowed: false, reason: "platform_unavailable" });
  });

  it("an audited billing capability override now reaches the request gate in both directions", async () => {
    await setBillingOverride("ea_off", true);
    const reEnabled = await gateAndResolver("ea_off");
    expect(reEnabled.gate).toBe(true);
    expect(reEnabled.resolved.allowed).toBe(true);

    await setBillingOverride("ea_free", false);
    const switchedOff = await gateAndResolver("ea_free");
    expect(switchedOff.gate).toBe(false);
    expect(switchedOff.resolved).toMatchObject({ allowed: false, reason: "platform_unavailable" });
  });

  it("the billing override outranks a legacy business row naming the same capability", async () => {
    await setLegacyOverride("ea_free", true); // legacy says on, audited override (above) says off
    const both = await gateAndResolver("ea_free");
    expect(both.gate).toBe(false);
    expect(both.resolved.allowed).toBe(false);

    // Removing the audited override hands the decision back to the legacy row.
    await db.query(`DELETE FROM business_billing_overrides WHERE business_id = $1 AND target = 'ea_free'`, [BID]);
    const legacyOnly = await gateAndResolver("ea_free");
    expect(legacyOnly.gate).toBe(true);
    expect(legacyOnly.resolved.allowed).toBe(true);
  });

  it("an expired billing override is ignored by both", async () => {
    await setBillingOverride("ea_off", true, new Date(Date.now() - 86_400_000).toISOString());
    const expired = await gateAndResolver("ea_off");
    expect(expired.gate).toBe(false);
    expect(expired.resolved).toMatchObject({ allowed: false, reason: "platform_unavailable" });
  });
});

describe("commercial layer: a priced capability is not served for free", () => {
  it("refuses an add-on nobody bought at the gate, exactly as the resolver does", async () => {
    const unbought = await gateAndResolver("ea_addon");
    expect(unbought.gate).toBe(false);
    expect(unbought.resolved).toMatchObject({ allowed: false, reason: "addon_required" });

    await plans.grantEntitlement({ businessId: BID, featureKey: "ea_addon", source: "addon" });
    const owned = await gateAndResolver("ea_addon");
    expect(owned.gate).toBe(true);
    expect(owned.resolved).toMatchObject({ allowed: true, source: "addon" });
  });

  it("serves an included plan feature, and stops serving it when the subscription lapses", async () => {
    const carried = await gateAndResolver("ea_included");
    expect(carried.gate).toBe(true);
    expect(carried.resolved.allowed).toBe(true);

    await db.query(`UPDATE business_subscriptions SET status = 'expired', auto_renew = false WHERE business_id = $1`, [BID]);
    const lapsed = await gateAndResolver("ea_included");
    expect(lapsed.gate).toBe(false);
    expect(lapsed.resolved).toMatchObject({ allowed: false, reason: "subscription_expired" });

    // An owned add-on and pay-as-you-go use are not rented from the plan.
    expect((await gateAndResolver("ea_addon")).gate).toBe(true);
    const metered = await gateAndResolver("ea_metered");
    expect(metered.gate).toBe(true);
    expect(metered.resolved.allowed).toBe(true);

    // An unpriced capability never depended on the subscription.
    expect((await gateAndResolver("ea_free")).gate).toBe(true);
  });

  it("effectiveFeatures reports the same answer the gate gives for every key", async () => {
    const all = await features.effectiveFeatures(BID);
    for (const key of ["ea_free", "ea_off", "ea_included", "ea_addon", "ea_metered"]) {
      expect(all[key]).toBe(await features.isFeatureEnabled(BID, key));
    }
  });
});

describe("access report: the look-alike key pairs, side by side", () => {
  it("shows access granted outside the plan and a plan inclusion the gate keeps off", async () => {
    const { getBusinessAccessReport } = await import("../src/lib/effective-access-report");
    await db.query(
      `UPDATE business_subscriptions
          SET status = 'active', auto_renew = true, current_period_end = now() + interval '20 days'
        WHERE business_id = $1`,
      [BID],
    );
    await setLegacyOverride("ai_assistant", true);

    const report = await getBusinessAccessReport(BID);
    expect(report.planKey).toBe("pro");
    expect(report.subscriptionStatus).toBe("active");
    expect(report.planFeatureKeys).toContain("accounting.ledger");

    const rel = (gateKey: string) => report.relations.find((r) => r.gateKey === gateKey)!;
    // The tenant shape in the review: assistant on through an override, no plan row.
    expect(rel("ai_assistant")).toMatchObject({
      status: "gate_on_without_plan_row",
      gate: { enabled: true, flagSource: "business_override" },
      commercial: { priced: false },
    });
    // The plan includes `integrations.api`, but `api_platform` ships default-off.
    expect(rel("api_platform")).toMatchObject({
      status: "plan_row_without_gate",
      gate: { enabled: false, flagSource: "catalogue_default" },
      commercial: { priced: true, entitled: true },
    });
    // A pair that agrees.
    expect(rel("ledger").status).toBe("consistent");
    expect(report.relations).toHaveLength(6);
    expect(report.overrides).toContainEqual({ key: "ai_assistant", enabled: true, source: "business_override" });
  });
});
