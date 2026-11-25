/**
 * ESH-193 / #1378 — the canonical resolver against a real database.
 *
 * The pure matrix is in `src/lib/billing/resolver/resolver.test.ts`. This file
 * proves the database facts the resolver depends on:
 *
 *   - a policy version is opt-in; a legacy tenant keeps its published tariff
 *     until an explicit enrolment;
 *   - an approved plan inclusion is applied to setup, and an unapproved or
 *     newer-policy row is not;
 *   - metered usage prices only the overage against the plan allowance;
 *   - a purchased prepaid service term debits exactly once, refuses a replay,
 *     and suppresses enabled-time rental while it covers the segment;
 *   - a tenant cannot read another tenant's terms;
 *   - the availability projection keeps access, activation and restriction
 *     separate.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: typeof import("../src/lib/db");
let resolver: typeof import("../src/lib/billing/resolver/service");
let access: typeof import("../src/lib/billing/resolver/access");
let activation: typeof import("../src/lib/service-activation/activation-service");
let pricing: typeof import("../src/lib/service-activation/pricing-service");
let wallet: typeof import("../src/lib/wallet-service");
let transitions: typeof import("../src/lib/billing/resolver/transition-service");

const planKey = `resolver-${randomUUID().slice(0, 8)}`;
const targetPlanKey = `resolver-target-${randomUUID().slice(0, 8)}`;
let platformUserId: string;
let legacyBusinessId: string;
let enrolledBusinessId: string;
let otherBusinessId: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function grant(businessId: string, amountRial: number) {
  await db.withTenant(businessId, () =>
    wallet.grantCredits({ businessId, amountRial, note: "شارژ آزمون" }),
  );
}

async function ledger(businessId: string) {
  return db.withTenant(businessId, () => wallet.listLedger(businessId, 100));
}

beforeAll(async () => {
  databaseName = `pos_resolver_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  delete (globalThis as { pgPool?: unknown }).pgPool;
  db = await import("../src/lib/db");
  resolver = await import("../src/lib/billing/resolver/service");
  access = await import("../src/lib/billing/resolver/access");
  activation = await import("../src/lib/service-activation/activation-service");
  pricing = await import("../src/lib/service-activation/pricing-service");
  wallet = await import("../src/lib/wallet-service");
  transitions = await import("../src/lib/billing/resolver/transition-service");

  platformUserId = randomUUID();
  legacyBusinessId = randomUUID();
  enrolledBusinessId = randomUUID();
  otherBusinessId = randomUUID();

  await db.withoutTenantScope("platform", async () => {
    await db.query(
      `INSERT INTO platform_users (id, email, password_hash, full_name)
       VALUES ($1, $2, 'hash', 'مدیر تجاری')`,
      [platformUserId, `resolver-${platformUserId.slice(0, 8)}@example.com`],
    );
    await db.query(
      `INSERT INTO billing_plans (key, name, monthly_price_rial, monthly_ai_credit_rial, status, sort_order)
       VALUES ($1, 'پلن آزمون', 1000000, 5000000, 'active', 1)`,
      [planKey],
    );
    // A second purchasable plan for the read-only transition quote.
    await db.query(
      `INSERT INTO billing_plans (key, name, monthly_price_rial, status, sort_order)
       VALUES ($1, 'پلن مقصد', 1500000, 'active', 2)`,
      [targetPlanKey],
    );
    await db.query(
      `INSERT INTO billing_price_versions
         (target_type, target_key, unit, unit_amount_rial, version, effective_from)
       VALUES ('plan', $1, 'month', 1500000, 1, now() - interval '1 day')`,
      [targetPlanKey],
    );
    for (const [id, name] of [
      [legacyBusinessId, "کسب‌وکار قدیمی"],
      [enrolledBusinessId, "کسب‌وکار تازه"],
      [otherBusinessId, "کسب‌وکار دیگر"],
    ] as const) {
      await db.query(
        `INSERT INTO businesses (id, name, slug, subdomain, plan)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, name, `res-${id.slice(0, 8)}`, `res-${id.slice(0, 8)}`, planKey],
      );
      await db.query(
        `INSERT INTO business_subscriptions
           (business_id, plan_key, status, current_period_end, auto_renew)
         VALUES ($1, $2, 'active', now() + interval '30 days', true)`,
        [id, planKey],
      );
    }
    // Issue #1110 — `otherBusinessId` activates My Workspace below, so it must
    // be a project-based trade; the default fixture industry is food_service.
    await db.query(
      `UPDATE businesses SET industry = 'architecture_construction' WHERE id = $1`,
      [otherBusinessId],
    );
    await db.query(
      `INSERT INTO billing_plan_meter_allowances
         (plan_key, meter_key, included_quantity, overage_enabled, reset_period)
       VALUES ($1, 'messaging.sms_segment', 100, true, 'month')`,
      [planKey],
    );
    await db.query(
      `INSERT INTO billing_policy_versions (version, status, note)
       VALUES (1, 'active', 'سیاست آزمون')`,
    );
    // The published service tariff for the app the tests activate.
    await db.query(
      `INSERT INTO service_price_schedules
         (service_kind, service_key, version, setup_mode, setup_fixed_rial,
          hourly_rate_rial, published, effective_from)
       VALUES ('app', 'accounting', 1, 'fixed', 500000, 100000, true, now() - interval '1 day')`,
    );
    // A published free-setup app for the prepaid-term flow.
    await db.query(
      `INSERT INTO service_price_schedules
         (service_kind, service_key, version, setup_mode, setup_fixed_rial,
          hourly_rate_rial, published, effective_from)
       VALUES ('app', 'crm', 1, 'fixed', 0, 100000, true, now() - interval '1 day')`,
    );
  });

  await grant(legacyBusinessId, 20_000_000);
  await grant(enrolledBusinessId, 20_000_000);
  await grant(otherBusinessId, 1_000_000);
}, 240_000);

afterAll(async () => {
  await db?.getPool().end().catch(() => {});
  delete (globalThis as { pgPool?: unknown }).pgPool;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("policy versions are opt-in", () => {
  it("keeps a legacy tenant on the published tariff, then applies an approved inclusion only after enrolment", async () => {
    await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO billing_plan_benefits
           (plan_key, benefit_id, benefit_kind, capability_key, service_kind, service_key,
            inclusion, approved, policy_version)
         VALUES ($1, 'service:app:accounting/setup_once@services.activation',
                 'setup_once', 'services.activation', 'app', 'accounting',
                 'included', true, 1)`,
        [planKey],
      );
    });

    const identity = { kind: "app" as const, key: "accounting", runtimeInstanceId: "" };
    const legacy = await resolver.resolveServiceSetupCharge({
      businessId: legacyBusinessId,
      identity,
    });
    expect(legacy.context.policyVersion).toBe(0);
    expect(legacy.charge.ok).toBe(true);
    expect(legacy.charge.totals.netRial).toBe(500_000);
    expect(legacy.charge.lines[0]!.explanation.code).toBe("published_tariff");

    const enrolled = await resolver.enrollCommercialPolicy({
      businessId: enrolledBusinessId,
      policyVersion: 1,
      platformUserId,
      note: "آزمون ثبت‌نام",
    });
    expect(enrolled).toMatchObject({ policyVersion: 1, enrolled: true, source: "enrolled" });

    const after = await resolver.resolveServiceSetupCharge({
      businessId: enrolledBusinessId,
      identity,
    });
    expect(after.context.policyVersion).toBe(1);
    expect(after.charge.totals.netRial).toBe(0);
    expect(after.charge.lines[0]!.explanation.code).toBe("plan_included");
  });

  it("never applies an unapproved inclusion", async () => {
    await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO billing_plan_benefits
           (plan_key, benefit_id, benefit_kind, capability_key, meter_key,
            inclusion, approved, policy_version)
         VALUES ($1, 'meter:messaging.sms_segment/metered_usage@growth.messaging.sms',
                 'metered_usage', 'growth.messaging.sms', 'messaging.sms_segment',
                 'included', false, 0)`,
        [planKey],
      );
    });
    const resolved = await resolver.resolveMeterCharge({
      businessId: legacyBusinessId,
      meterKey: "messaging.sms_segment",
      quantity: 10,
    });
    // The unapproved row is invisible; the published meter price applies (none
    // published here, so the resolver refuses instead of charging zero).
    expect(resolved.context.benefit).toBeNull();
    expect(resolved.charge.ok).toBe(false);
    expect(resolved.charge.refusals[0]!.code).toBe("no_published_price");
  });
});

describe("metered usage and allowances", () => {
  beforeAll(async () => {
    await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO billing_price_versions
           (target_type, target_key, unit, unit_amount_rial, unit_size, version, effective_from)
         VALUES ('meter', 'messaging.sms_segment', 'segment', 2000, 1, 1, now() - interval '1 day')`,
      );
    });
  });

  it("prices only the quantity beyond the plan allowance", async () => {
    const resolved = await resolver.resolveMeterCharge({
      businessId: legacyBusinessId,
      meterKey: "messaging.sms_segment",
      quantity: 150,
    });
    expect(resolved.charge.ok).toBe(true);
    expect(resolved.charge.lines[0]!.includedQuantity).toBe(100);
    expect(resolved.charge.lines[0]!.chargeableQuantity).toBe(50);
    expect(resolved.charge.totals.netRial).toBe(100_000);
    expect(resolved.charge.lines[0]!.priceVersion?.version).toBe(1);
  });

  it("records the meter's capability identity, not a label", async () => {
    const resolved = await resolver.resolveMeterCharge({
      businessId: legacyBusinessId,
      meterKey: "messaging.sms_segment",
      quantity: 1,
    });
    expect(resolved.charge.lines[0]!.benefitId).toBe(
      "meter:messaging.sms_segment/metered_usage@growth.messaging.sms",
    );
    expect(resolved.charge.lines[0]!.activatesService).toBe(false);
    // No approved provider-cost row yet: the existing metering behaviour stands.
    expect(resolved.context.providerCostPolicy).toBeNull();
  });

  it("reads the approved provider-cost policy for a meter", async () => {
    await db.withoutTenantScope("platform", () =>
      db.query(
        `INSERT INTO billing_plan_benefits
           (plan_key, benefit_id, benefit_kind, capability_key, meter_key,
            inclusion, provider_cost_policy, approved, policy_version)
         VALUES ($1, 'meter:messaging.sms_segment/provider_cost@growth.messaging.sms',
                 'provider_cost', 'growth.messaging.sms', 'messaging.sms_segment',
                 'uncovered', 'absorbed', true, 0)`,
        [planKey],
      ),
    );
    const resolved = await resolver.resolveMeterCharge({
      businessId: legacyBusinessId,
      meterKey: "messaging.sms_segment",
      quantity: 1,
    });
    expect(resolved.context.providerCostPolicy).toBe("absorbed");
  });
});

describe("service activation charges the canonical setup only", () => {
  it("charges the published setup for a legacy tenant", async () => {
    const result = await activation.activateService({
      businessId: legacyBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(result.status).toBe("activated");
    if (result.status !== "activated") throw new Error("activation failed");
    expect(result.chargedSetupRial).toBe(500_000);
    const entry = await db.withTenant(legacyBusinessId, () =>
      db.query<{ kind: string; amount_rial: string; metadata: Record<string, unknown> }>(
        `SELECT kind, amount_rial, metadata FROM wallet_ledger
          WHERE business_id = $1 AND kind = 'service_setup'
          ORDER BY created_at DESC LIMIT 1`,
        [legacyBusinessId],
      ),
    );
    expect(entry.rows[0]!.amount_rial).toBe("500000");
    expect(entry.rows[0]!.metadata.priceVersion).toBe(1);

    // Exactly one setup debit even if activation is repeated.
    const again = await activation.activateService({
      businessId: legacyBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(again.status).toBe("already_active");
    const count = await db.withTenant(legacyBusinessId, () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM wallet_ledger
          WHERE business_id = $1 AND kind = 'service_setup'`,
        [legacyBusinessId],
      ),
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("waives the setup for an enrolled tenant with an approved inclusion", async () => {
    const result = await activation.activateService({
      businessId: enrolledBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(result.status).toBe("activated");
    if (result.status !== "activated") throw new Error("activation failed");
    expect(result.chargedSetupRial).toBe(0);
    expect(result.quote.setupWaivedReason).toBe("plan_included");
    const count = await db.withTenant(enrolledBusinessId, () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM wallet_ledger
          WHERE business_id = $1 AND kind = 'service_setup'`,
        [enrolledBusinessId],
      ),
    );
    expect(count.rows[0]!.count).toBe("0");
  });
});

describe("prepaid service terms", () => {
  const identity = { kind: "app" as const, key: "crm", runtimeInstanceId: "" };
  let offerId: string;

  beforeAll(async () => {
    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ id: string }>(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('app', 'crm', 1, 1, 2000000, true, now() - interval '1 day')
         RETURNING id`,
      ),
    );
    offerId = rows[0]!.id;
  });

  it("refuses a term for a service that was never activated", async () => {
    const quote = await resolver.quoteServiceTerm({
      businessId: legacyBusinessId,
      identity,
      termMonths: 1,
    });
    expect(quote.ok).toBe(false);
    expect(quote.refusal).toBe("no_activation");
  });

  it("quotes and purchases exactly one published term, then refuses a replay", async () => {
    const activated = await activation.activateService({
      businessId: legacyBusinessId,
      identity,
    });
    expect(activated.status).toBe("activated");
    if (activated.status !== "activated") throw new Error("activation failed");
    // setup is 0 for crm, so the wallet only loses the term price below.

    const quote = await resolver.quoteServiceTerm({
      businessId: legacyBusinessId,
      identity,
      termMonths: 1,
    });
    expect(quote.ok).toBe(true);
    expect(quote.refusal).toBeNull();
    expect(quote.offer?.id).toBe(offerId);
    expect(quote.totals.netRial).toBe(2_000_000);
    expect(quote.allowancePeriods).toBeGreaterThanOrEqual(1);
    expect(quote.term?.lines[0]!.explanation.code).toBe("prepaid_term_purchase");

    const before = await db.withTenant(legacyBusinessId, () => wallet.getWalletBalanceRial(legacyBusinessId));
    const purchased = await resolver.purchaseServiceTerm({
      businessId: legacyBusinessId,
      identity,
      termMonths: 1,
      expectedOfferId: offerId,
      expectedNetRial: 2_000_000,
      actorPlatformUserId: platformUserId,
    });
    expect(purchased.status).toBe("purchased");
    if (purchased.status !== "purchased") throw new Error("purchase failed");
    expect(purchased.chargedRial).toBe(2_000_000);
    expect(purchased.balanceRial).toBe(before - 2_000_000);

    // Replay: the same interval cannot be bought twice.
    const replay = await resolver.purchaseServiceTerm({
      businessId: legacyBusinessId,
      identity,
      termMonths: 1,
      expectedOfferId: offerId,
      expectedNetRial: 2_000_000,
      actorPlatformUserId: platformUserId,
    });
    expect(replay.status).toBe("refused");
    expect(replay.status === "refused" && replay.reason).toBe("term_overlap");
    const after = await db.withTenant(legacyBusinessId, () => wallet.getWalletBalanceRial(legacyBusinessId));
    expect(after).toBe(before - 2_000_000);

    const entries = (await ledger(legacyBusinessId)).filter((entry) => entry.kind === "service_term");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountRial).toBe(2_000_000);
  });

  it("suppresses enabled-time rental inside the prepaid term", async () => {
    const term = await db.withTenant(legacyBusinessId, () =>
      db.query<{ period_start: Date; period_end: Date; activation_id: string }>(
        `SELECT period_start, period_end, activation_id FROM business_service_terms
          WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [legacyBusinessId],
      ),
    );
    const row = term.rows[0]!;
    // Make the interval exactly the first paid hour, already settled to the
    // term start, then settle an hour forward: every second is covered.
    await db.withTenant(legacyBusinessId, async () => {
      await db.query(
        `UPDATE service_activation_intervals
            SET started_at = $2, last_settled_at = $2, ended_at = NULL
          WHERE activation_id = $1 AND ended_at IS NULL`,
        [row.activation_id, row.period_start],
      );
    });
    const balanceBefore = await db.withTenant(legacyBusinessId, () =>
      wallet.getWalletBalanceRial(legacyBusinessId),
    );
    const settlement = await activation.settleServiceRuntime({
      businessId: legacyBusinessId,
      identity,
      now: new Date(new Date(row.period_start).getTime() + 3_600_000),
    });
    expect(settlement.status).toBe("settled");
    expect(settlement.amountRial).toBe(0);
    const balanceAfter = await db.withTenant(legacyBusinessId, () =>
      wallet.getWalletBalanceRial(legacyBusinessId),
    );
    expect(balanceAfter).toBe(balanceBefore);

    const charge = await db.withTenant(legacyBusinessId, () =>
      db.query<{ amount_rial: string; billed_seconds: number; metadata: Record<string, unknown> }>(
        `SELECT amount_rial, billed_seconds, metadata FROM service_runtime_charges
          WHERE business_id = $1 ORDER BY settled_at DESC LIMIT 1`,
        [legacyBusinessId],
      ),
    );
    expect(charge.rows[0]!.amount_rial).toBe("0");
    expect(Number(charge.rows[0]!.billed_seconds)).toBe(3_600);
    expect(Number(charge.rows[0]!.metadata.coveredSeconds)).toBe(3_600);
  });

  it("refuses a quote whose published offer version changed", async () => {
    // A 3-month offer for a service with no active prepaid term, so the quote
    // is a genuine offer rather than the correct `term_overlap` refusal.
    const accounting = { kind: "app" as const, key: "accounting", runtimeInstanceId: "" };
    const { rows } = await db.withoutTenantScope("platform", () =>
      db.query<{ id: string }>(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('app', 'accounting', 3, 1, 5000000, true, now() - interval '1 day')
         RETURNING id`,
      ),
    );
    const threeMonthOfferId = rows[0]!.id;

    const quote = await resolver.quoteServiceTerm({
      businessId: enrolledBusinessId,
      identity: accounting,
      termMonths: 3,
    });
    expect(quote.ok).toBe(true);

    await db.withoutTenantScope("platform", async () => {
      // Both windows are moved an hour into the past deliberately: the database
      // clock can run ahead of the test process's `new Date()`, and a boundary
      // sitting exactly on "now" would let the old offer look effective for the
      // purchase's own timestamp (the same clock-skew trap quoted in
      // quote-store.integration.test.ts).
      await db.query(
        `UPDATE service_term_offers SET effective_until = now() - interval '1 hour'
          WHERE service_kind = 'app' AND service_key = 'accounting' AND term_months = 3`,
      );
      await db.query(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('app', 'accounting', 3, 2, 6500000, true, now() - interval '1 hour')`,
      );
    });
    const stale = await resolver.purchaseServiceTerm({
      businessId: enrolledBusinessId,
      identity: accounting,
      termMonths: 3,
      expectedOfferId: threeMonthOfferId,
      expectedNetRial: 5_000_000,
      actorPlatformUserId: platformUserId,
    });
    expect(stale.status).toBe("refused");
    expect(stale.status === "refused" && stale.reason).toBe("term_stale");
  });
});

describe("prepaid term auto-renewal", () => {
  const identity = { kind: "app" as const, key: "growth", runtimeInstanceId: "" };
  let offerId: string;

  beforeAll(async () => {
    const offer = await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO service_price_schedules
           (service_kind, service_key, version, setup_mode, setup_fixed_rial,
            hourly_rate_rial, published, effective_from)
         VALUES ('app', 'growth', 1, 'fixed', 0, 100000, true, now() - interval '1 day')`,
      );
      return db.query<{ id: string }>(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('app', 'growth', 1, 1, 1500000, true, now() - interval '1 day')
         RETURNING id`,
      );
    });
    offerId = offer.rows[0]!.id;

    const activated = await activation.activateService({
      businessId: legacyBusinessId,
      identity,
    });
    expect(activated.status).toBe("activated");

    // A prepaid term that has already ended and explicitly opted in.
    await db.withTenant(legacyBusinessId, () =>
      db.query(
        `INSERT INTO business_service_terms
           (business_id, activation_id, service_kind, service_key, term_months,
            offer_id, price_rial, price_version, period_start, period_end,
            status, auto_renew)
         SELECT $1, a.id, 'app', 'growth', 1, $2, 1500000, 1,
                now() - interval '2 months', now() - interval '1 minute',
                'active', true
           FROM business_service_activations a
          WHERE a.business_id = $1 AND a.service_kind = 'app'
            AND a.service_key = 'growth' AND a.runtime_instance_id = ''`,
        [legacyBusinessId, offerId],
      ),
    );
  });

  it("renews the opted-in term once, at the same term, and never on a replay", async () => {
    const before = await db.withTenant(legacyBusinessId, () =>
      wallet.getWalletBalanceRial(legacyBusinessId),
    );
    const first = await resolver.renewDueServiceTerms();
    expect(first.renewed).toBe(1);
    expect(first.skippedInsufficientCredit).toBe(0);

    const after = await db.withTenant(legacyBusinessId, () =>
      wallet.getWalletBalanceRial(legacyBusinessId),
    );
    expect(after).toBe(before - 1_500_000);

    const terms = await db.withTenant(legacyBusinessId, () =>
      db.query<{ term_months: number; auto_renew: boolean; period_start: Date }>(
        `SELECT term_months, auto_renew, period_start FROM business_service_terms
          WHERE business_id = $1 AND service_key = 'growth'
          ORDER BY period_start DESC`,
        [legacyBusinessId],
      ),
    );
    expect(terms.rows).toHaveLength(2);
    expect(Number(terms.rows[0]!.term_months)).toBe(1);
    expect(terms.rows[0]!.auto_renew).toBe(true);

    const replay = await resolver.renewDueServiceTerms();
    expect(replay.renewed).toBe(0);
    const afterReplay = await db.withTenant(legacyBusinessId, () =>
      wallet.getWalletBalanceRial(legacyBusinessId),
    );
    expect(afterReplay).toBe(after);
  });
});

describe("prepaid long terms and expiry", () => {
  const identity = { kind: "app" as const, key: "website", runtimeInstanceId: "" };
  let offerId: string;

  beforeAll(async () => {
    const offer = await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO service_price_schedules
           (service_kind, service_key, version, setup_mode, setup_fixed_rial,
            hourly_rate_rial, published, effective_from)
         VALUES ('app', 'website', 1, 'fixed', 0, 50000, true, now() - interval '1 day')`,
      );
      return db.query<{ id: string }>(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('app', 'website', 12, 1, 4000000, true, now() - interval '1 day')
         RETURNING id`,
      );
    });
    offerId = offer.rows[0]!.id;
    const activated = await activation.activateService({
      businessId: enrolledBusinessId,
      identity,
    });
    expect(activated.status).toBe("activated");
  });

  it("quotes a 12-month term in calendar months with monthly allowance windows", async () => {
    const quote = await resolver.quoteServiceTerm({
      businessId: enrolledBusinessId,
      identity,
      termMonths: 12,
    });
    expect(quote.ok).toBe(true);
    expect(quote.offer?.id).toBe(offerId);
    expect(quote.totals.netRial).toBe(4_000_000);
    // Mid-month start touches 13 calendar months; a year of allowance is never
    // granted up front.
    expect(quote.allowancePeriods).toBeGreaterThanOrEqual(12);
    const start = new Date(quote.offer!.periodStart);
    const end = new Date(quote.offer!.periodEnd);
    expect(end.getUTCFullYear()).toBe(start.getUTCFullYear() + 1);
    expect(end.getUTCMonth()).toBe(start.getUTCMonth());

    const purchased = await resolver.purchaseServiceTerm({
      businessId: enrolledBusinessId,
      identity,
      termMonths: 12,
      expectedOfferId: offerId,
      expectedNetRial: 4_000_000,
      actorPlatformUserId: platformUserId,
    });
    expect(purchased.status).toBe("purchased");
    const count = await db.withTenant(enrolledBusinessId, () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM business_service_terms
          WHERE business_id = $1 AND service_key = 'website'`,
        [enrolledBusinessId],
      ),
    );
    expect(count.rows[0]!.count).toBe("1");
  });

  it("returns to hourly rental the moment the paid term ends", async () => {
    const term = await db.withTenant(enrolledBusinessId, () =>
      db.query<{ period_end: Date; activation_id: string }>(
        `SELECT period_end, activation_id FROM business_service_terms
          WHERE business_id = $1 AND service_key = 'website'
          ORDER BY created_at DESC LIMIT 1`,
        [enrolledBusinessId],
      ),
    );
    const row = term.rows[0]!;
    const end = new Date(row.period_end).getTime();
    const from = new Date(end - 30 * 60_000).toISOString();
    const to = new Date(end + 30 * 60_000).toISOString();
    await db.withTenant(enrolledBusinessId, () =>
      db.query(
        `UPDATE service_activation_intervals
            SET started_at = $2, last_settled_at = $2, ended_at = NULL
          WHERE activation_id = $1 AND ended_at IS NULL`,
        [row.activation_id, from],
      ),
    );

    const settlement = await activation.settleServiceRuntime({
      businessId: enrolledBusinessId,
      identity,
      now: new Date(to),
    });
    expect(settlement.status).toBe("settled");
    // Half of the hour is covered by the term, half is ordinary rental at
    // 50,000 Rial/hour — 25,000, not 50,000.
    expect(settlement.amountRial).toBe(25_000);
    expect(settlement.billedSeconds).toBe(3_600);
  });
});

describe("prepaid renewal with an empty wallet", () => {
  const identity = { kind: "workspace" as const, key: "projects", runtimeInstanceId: "" };
  let offerId: string;

  beforeAll(async () => {
    const offer = await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO service_price_schedules
           (service_kind, service_key, version, setup_mode, setup_fixed_rial,
            hourly_rate_rial, published, effective_from)
         VALUES ('workspace', 'projects', 1, 'fixed', 0, 0, true, now() - interval '1 day')`,
      );
      return db.query<{ id: string }>(
        `INSERT INTO service_term_offers
           (service_kind, service_key, term_months, version, price_rial, published, effective_from)
         VALUES ('workspace', 'projects', 1, 1, 1000000, true, now() - interval '1 day')
         RETURNING id`,
      );
    });
    offerId = offer.rows[0]!.id;

    const activated = await activation.activateService({
      businessId: otherBusinessId,
      identity,
    });
    expect(activated.status).toBe("activated");

    // An opted-in term that ended yesterday, and an empty wallet.
    await db.withTenant(otherBusinessId, async () => {
      await db.query(
        `INSERT INTO business_service_terms
           (business_id, activation_id, service_kind, service_key, term_months,
            offer_id, price_rial, price_version, period_start, period_end,
            status, auto_renew)
         SELECT $1, a.id, 'workspace', 'projects', 1, $2, 1000000, 1,
                now() - interval '2 months', now() - interval '1 day',
                'active', true
           FROM business_service_activations a
          WHERE a.business_id = $1 AND a.service_kind = 'workspace'
            AND a.service_key = 'projects' AND a.runtime_instance_id = ''`,
        [otherBusinessId, offerId],
      );
      await db.query(`UPDATE business_wallets SET balance_rial = 0 WHERE business_id = $1`, [
        otherBusinessId,
      ]);
    });
  });

  it("skips the renewal without a debit, a shorter term or a partial charge", async () => {
    const before = await db.withTenant(otherBusinessId, () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM business_service_terms
          WHERE business_id = $1 AND service_key = 'projects'`,
        [otherBusinessId],
      ),
    );
    const run = await resolver.renewDueServiceTerms();
    expect(run.renewed).toBe(0);
    expect(run.skippedInsufficientCredit).toBeGreaterThanOrEqual(1);

    const after = await db.withTenant(otherBusinessId, () =>
      db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM business_service_terms
          WHERE business_id = $1 AND service_key = 'projects'`,
        [otherBusinessId],
      ),
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    const balance = await db.withTenant(otherBusinessId, () =>
      wallet.getWalletBalanceRial(otherBusinessId),
    );
    expect(balance).toBe(0);
  });
});

describe("policy change is stale at the charge boundary", () => {
  it("reports a policy change between a term quote and purchase, then prices the inclusion", async () => {
    const identity = { kind: "app" as const, key: "accounting", runtimeInstanceId: "" };
    const quote = await resolver.quoteServiceTerm({
      businessId: enrolledBusinessId,
      identity,
      termMonths: 3,
    });
    expect(quote.ok).toBe(true);
    expect(quote.totals.netRial).toBeGreaterThan(0);

    await db.withoutTenantScope("platform", async () => {
      await db.query(
        `INSERT INTO billing_policy_versions (version, status, note)
         VALUES (2, 'active', 'سیاست دوم آزمون')
         ON CONFLICT (version) DO NOTHING`,
      );
      await db.query(
        `INSERT INTO billing_plan_benefits
           (plan_key, benefit_id, benefit_kind, capability_key, service_kind, service_key,
            meter_key, inclusion, discount_basis_points, charges_tariff_when_included,
            provider_cost_policy, approved, policy_version)
         VALUES ($1, 'service:app:accounting/enabled_time@services.activation',
                 'enabled_time', 'services.activation', 'app', 'accounting',
                 NULL, 'included', 0, false, NULL, true, 2)`,
        [planKey],
      );
    });
    await resolver.enrollCommercialPolicy({
      businessId: enrolledBusinessId,
      policyVersion: 2,
      platformUserId,
      note: "ارتقای سیاست آزمون",
    });

    const staleness = await resolver.serviceTermQuoteStaleness({
      businessId: enrolledBusinessId,
      identity,
      quote,
    });
    expect(staleness).toBe("policy_changed");

    const fresh = await resolver.quoteServiceTerm({
      businessId: enrolledBusinessId,
      identity,
      termMonths: 3,
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.totals.netRial).toBe(0);
  });
});

describe("read-only plan transition quote", () => {
  it("quotes a boundary change under the neutral policy, labelled as a list-price basis", async () => {
    const result = await transitions.readPlanTransitionQuote({
      businessId: otherBusinessId,
      targetPlanKey,
    });
    expect(result.ok).toBe(true);
    expect(result.prorationPolicy).toBe("none");
    expect(result.quote?.explanation).toBe("at_period_end");
    expect(result.quote?.newPeriod.start).toBe(result.current?.periodEnd);
    expect(result.current?.creditBasis).toBe("published_price");
    expect(result.target?.monthlyPriceRial).toBe(1_500_000);
    expect(result.target?.priceVersion?.version).toBe(1);
  });

  it("uses the configured daily policy for an immediate prorated quote, then restores it", async () => {
    await db.withoutTenantScope("platform", () =>
      db.query(`UPDATE billing_commercial_settings SET proration_policy = 'daily'`),
    );
    try {
      const result = await transitions.readPlanTransitionQuote({
        businessId: otherBusinessId,
        targetPlanKey,
      });
      expect(result.ok).toBe(true);
      expect(result.prorationPolicy).toBe("daily");
      expect(result.quote?.explanation).toBe("immediate_prorated");
      expect(result.quote?.creditRial).toBeGreaterThan(0);
      expect(result.quote?.netRial).toBeGreaterThan(0);
    } finally {
      await db.withoutTenantScope("platform", () =>
        db.query(`UPDATE billing_commercial_settings SET proration_policy = 'none'`),
      );
    }
  });

  it("refuses the plan the business is already on", async () => {
    const result = await transitions.readPlanTransitionQuote({
      businessId: otherBusinessId,
      targetPlanKey: planKey,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe("same_plan");
  });
});

describe("tenant isolation", () => {
  it("scopes term reads to the acting business", async () => {
    const at = new Date().toISOString();
    const identity = { kind: "app" as const, key: "crm", runtimeInstanceId: "" };
    const own = await resolver.readActiveServiceTerm({
      businessId: legacyBusinessId,
      identity,
      at,
    });
    // The 1-month term was bought at "now", so it is active for this business.
    expect(own).not.toBeNull();

    const other = await resolver.readActiveServiceTerm({
      businessId: otherBusinessId,
      identity,
      at,
    });
    expect(other).toBeNull();
  });
});

describe("commercial availability keeps the axes separate", () => {
  it("marks a legacy tenant as grandfathered and unrestricted", async () => {
    const projection = await access.resolveCommercialAvailability({
      businessId: legacyBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(projection.legacyAccess).toBe(true);
    expect(projection.restricted).toBe(false);
    expect(projection.activationState).toBe("active");
    expect(projection.activationRequired).toBe(false);
    expect(projection.purchasable).toBe(true);
    expect(projection.safePreviewAllowed).toBe(true);
    expect(projection.industryEligible).toBe(true);
    expect(projection.deploymentEligible).toBe(true);
    expect(projection.planEntitlement.included).toBe(false);
  });

  it("keeps retention readable while a service is suspended", async () => {
    await db.withTenant(enrolledBusinessId, async () => {
      await db.query(
        `UPDATE business_service_activations
            SET state = 'suspended_insufficient_credit', suspended_at = now(),
                suspension_reason = 'insufficient_credit'
          WHERE business_id = $1 AND service_kind = 'app' AND service_key = 'accounting'`,
        [enrolledBusinessId],
      );
    });
    const projection = await access.resolveCommercialAvailability({
      businessId: enrolledBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(projection.activationState).toBe("suspended");
    expect(projection.suspended).toBe(true);
    expect(projection.retentionReadable).toBe(true);
    // Enrolled + pending/suspended + a real price = the only restricted case.
    expect(projection.restricted).toBe(true);
    expect(projection.restrictionReason).toBe("unpaid_service");

    const denial = await access.enforceCommercialServiceAccess({
      businessId: enrolledBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
      intent: "use",
    });
    expect(denial.allowed).toBe(false);
    expect(denial.allowed === false && denial.reason).toBe("unpaid_service");
  });

  it("does not restrict a legacy tenant whose service is suspended", async () => {
    await db.withTenant(legacyBusinessId, async () => {
      await db.query(
        `UPDATE business_service_activations
            SET state = 'suspended_insufficient_credit', suspended_at = now(),
                suspension_reason = 'insufficient_credit'
          WHERE business_id = $1 AND service_kind = 'app' AND service_key = 'accounting'`,
        [legacyBusinessId],
      );
    });
    const projection = await access.resolveCommercialAvailability({
      businessId: legacyBusinessId,
      identity: { kind: "app", key: "accounting", runtimeInstanceId: "" },
    });
    expect(projection.legacyAccess).toBe(true);
    expect(projection.restricted).toBe(false);
  });
});
