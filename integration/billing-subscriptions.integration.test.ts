/**
 * Migration 0176 — the subscription lifecycle, the invoice domain and the
 * central entitlement resolver, run against a real migrated database:
 *
 *   • plan lifecycle      — draft/active/retired, explicit limits, no
 *                           hard-delete of a plan in use,
 *   • changeBusinessPlan  — the ONE plan-transition path (created / changed /
 *                           unchanged, draft/retired refusals),
 *   • renewal             — idempotent (invoice claim), wallet-debited inside
 *                           the same transaction, past_due → expired grace
 *                           walk, free plans renew silently,
 *   • invoices            — sequential numbers, snapshotted line items that
 *                           never re-price,
 *   • entitlements        — resolveBusinessCapability's structured denial
 *                           reasons (subscription_expired, addon_required,
 *                           insufficient_credit) and the override-aware
 *                           limit ceiling the creation paths enforce.
 *
 * Everything runs inside `withTenant` (the RLS scope the API routes
 * establish) because the business-owned tables are FORCE-RLS protected.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { addCalendarMonths } from "../src/lib/billing/quote/plan-quote";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;

let subs: typeof import("../src/lib/subscription-service");
let plans: typeof import("../src/lib/billing-plans-service");
let wallet: typeof import("../src/lib/wallet-service");
let ent: typeof import("../src/lib/entitlement-service");
let dbLib: typeof import("../src/lib/db");

const BID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_subscriptions_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  subs = await import("../src/lib/subscription-service");
  plans = await import("../src/lib/billing-plans-service");
  wallet = await import("../src/lib/wallet-service");
  ent = await import("../src/lib/entitlement-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  // The features this suite prices must exist in the shared feature_flags
  // catalogue first — billing_plan_features.feature_key FKs into it.
  // (`reporting` ships with the migrations; these three are test-local.)
  for (const [key, name] of [
    ["ai_agent", "دستیار هوشمند"],
    ["crm", "مدیریت مشتریان"],
    ["insights", "داشبورد تحلیل"],
  ]) {
    await db.query(
      `INSERT INTO feature_flags (key, name, default_enabled) VALUES ($1, $2, true)
       ON CONFLICT (key) DO NOTHING`,
      [key, name],
    );
  }
  // Inserted AFTER the migrations ran, so 0176's subscription backfill did
  // not touch this business: it starts with no subscription row, exactly the
  // «created» path changeBusinessPlan must handle.
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه اشتراک', 'subscription-cafe', 'free')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

/** Run every service call in the same scope the API routes establish. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(BID, fn);
}

/**
 * The exact period end the first renewal was billed for — the idempotency
 * test rewinds to THIS value (not a fresh now()-1day) so the reference
 * `subscription-renewal:<end>` is the already-claimed one.
 */
let billedPeriodEnd: string | null = null;

const UNLIMITED = { unlimited: true } as const;

// ---------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------

describe("billing plan lifecycle", () => {
  it("requires an explicit limits choice when creating a plan", async () => {
    await scoped(async () => {
      await expect(
        plans.saveBillingPlan({ key: "no-limits", name: "بدون سقف", sortOrder: 1 }),
      ).rejects.toThrow("limits_required");
    });
  });

  it("creates, updates and keeps absent limits on update", async () => {
    await scoped(async () => {
      const created = await plans.saveBillingPlan({
        key: "starter",
        name: "استارتر",
        monthlyPriceRial: 1_000_000,
        status: "draft",
        sortOrder: 5,
        trialDays: 14,
        graceDays: 3,
        limits: { branches: { unlimited: false, value: 2 }, members: UNLIMITED, monthlyOrders: { unlimited: false, value: 500 } },
      });
      expect(created.status).toBe("draft");
      expect(created.branchLimit).toBe(2);
      expect(created.memberLimit).toBeNull(); // unlimited is stored as NULL
      expect(created.monthlyOrderLimit).toBe(500);
      expect(created.trialDays).toBe(14);
      expect(created.graceDays).toBe(3);

      // An update without a limits object keeps the stored ceilings.
      const updated = await plans.saveBillingPlan({ key: "starter", name: "استارتر ۲", sortOrder: 5 });
      expect(updated.name).toBe("استارتر ۲");
      expect(updated.branchLimit).toBe(2);
      expect(updated.monthlyOrderLimit).toBe(500);
    });
  });

  it("draft → active → retired, and a retired plan never reactivates", async () => {
    await scoped(async () => {
      const active = await plans.activatePlan("starter");
      expect(active.status).toBe("active");
      expect(active.isActive).toBe(true);

      const retired = await plans.retirePlan("starter");
      expect(retired.status).toBe("retired");
      await expect(plans.activatePlan("starter")).rejects.toThrow("plan_retired");
    });
  });

  it("refuses to hard-delete anything but an unused draft", async () => {
    await scoped(async () => {
      // starter is retired now — not a draft.
      await expect(plans.deleteDraftPlan("starter")).rejects.toThrow("plan_not_draft");

      await plans.saveBillingPlan({
        key: "scratch",
        name: "پیش‌نویس آزمایشی",
        status: "draft",
        sortOrder: 99,
        limits: { branches: UNLIMITED, members: UNLIMITED, monthlyOrders: UNLIMITED },
      });
      await plans.deleteDraftPlan("scratch");
      expect(await plans.getBillingPlan("scratch")).toBeNull();

      // A plan a business sits on can never be hard-deleted, even as a draft:
      // `pro` is active and seeded — point a business at it first.
      await expect(plans.deleteDraftPlan("pro")).rejects.toThrow("plan_not_draft");
    });
  });

  it("prices features per plan and refuses edits on a retired plan", async () => {
    await scoped(async () => {
      await plans.saveBillingPlan({
        key: "growing",
        name: "روبه‌رشد",
        monthlyPriceRial: 2_000_000,
        sortOrder: 15,
        limits: { branches: { unlimited: false, value: 3 }, members: UNLIMITED, monthlyOrders: UNLIMITED },
      });
      await plans.savePlanFeature({ planKey: "growing", featureKey: "reporting", pricingModel: "included", priceRial: 0, sortOrder: 1 });
      await plans.savePlanFeature({ planKey: "growing", featureKey: "ai_agent", pricingModel: "per_use", priceRial: 50_000, sortOrder: 2 });
      await plans.savePlanFeature({ planKey: "growing", featureKey: "crm", pricingModel: "addon", priceRial: 800_000, sortOrder: 3 });

      const features = await plans.listPlanFeatures("growing");
      expect(features.map((f) => f.featureKey).sort()).toEqual(["ai_agent", "crm", "reporting"]);

      await plans.retirePlan("growing");
      await expect(
        plans.savePlanFeature({ planKey: "growing", featureKey: "crm", pricingModel: "addon", priceRial: 1, sortOrder: 3 }),
      ).rejects.toThrow("plan_retired");
    });
  });
});

// ---------------------------------------------------------------------------
// changeBusinessPlan — the one transition path
// ---------------------------------------------------------------------------

describe("changeBusinessPlan", () => {
  it("creates, is idempotent, and changes through the one path", async () => {
    await scoped(async () => {
      const created = await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "admin" });
      expect(created.outcome).toBe("created");
      expect(created.subscription.status).toBe("active");
      expect(created.subscription.planKey).toBe("pro");

      const { rows } = await db.query(`SELECT plan FROM businesses WHERE id = $1`, [BID]);
      expect(rows[0].plan).toBe("pro");

      const again = await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "admin" });
      expect(again.outcome).toBe("unchanged");

      // A mid-period change keeps the running paid period.
      const before = created.subscription.currentPeriodEnd;
      const changed = await subs.changeBusinessPlan({ businessId: BID, planKey: "business", source: "admin" });
      expect(changed.outcome).toBe("changed");
      expect(changed.subscription.planKey).toBe("business");
      expect(changed.subscription.currentPeriodEnd).toBe(before);

      const after = await db.query(`SELECT plan FROM businesses WHERE id = $1`, [BID]);
      expect(after.rows[0].plan).toBe("business");
    });
  });

  it("refuses drafts (not purchasable) and retired plans (closed to new customers)", async () => {
    await scoped(async () => {
      await plans.saveBillingPlan({
        key: "secret-draft",
        name: "پیش‌نویس محرمانه",
        status: "draft",
        sortOrder: 98,
        limits: { branches: UNLIMITED, members: UNLIMITED, monthlyOrders: UNLIMITED },
      });
      await expect(
        subs.changeBusinessPlan({ businessId: BID, planKey: "secret-draft", source: "admin" }),
      ).rejects.toMatchObject({ message: "plan_not_active" });

      // `growing` was retired in the plan-lifecycle suite; the business is on
      // `business`, so moving onto a retired plan must refuse.
      await expect(
        subs.changeBusinessPlan({ businessId: BID, planKey: "growing", source: "admin" }),
      ).rejects.toMatchObject({ message: "plan_retired" });

      // A business whose subscription already sits on a retired plan keeps it
      // (a retired key stays a valid FK target for existing rows).
      const other = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      await db.query(
        `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه بازنشسته', 'retired-cafe', 'growing')`,
        [other],
      );
      await db.query(
        `INSERT INTO business_subscriptions (business_id, plan_key, status)
         VALUES ($1, 'growing', 'active')`,
        [other],
      );
      const stays = await dbLib.withTenant(other, () =>
        subs.changeBusinessPlan({ businessId: other, planKey: "growing", source: "admin" }),
      );
      expect(stays.outcome).toBe("unchanged");
      expect(stays.subscription.planKey).toBe("growing");
    });
  });

  it("stamps the plan's included/monthly features but leaves owned add-ons alone", async () => {
    await scoped(async () => {
      // Price `reporting` as an included pro feature first — the stamping
      // pass walks the plan's feature rows.
      await plans.savePlanFeature({ planKey: "pro", featureKey: "reporting", pricingModel: "included", priceRial: 0, sortOrder: 1 });
      await subs.changeBusinessPlan({ businessId: BID, planKey: "pro", source: "admin" });
      const entitlements = await plans.listEntitlements(BID);
      expect(entitlements.some((e) => e.featureKey === "reporting" && e.source === "plan")).toBe(true);
    });
  });

  it("schedules a paid cross-plan purchase to the boundary, applies it once, and never charges twice", async () => {
    const scheduledBusiness = "abababab-abab-4bab-8bab-abababababab";
    await db.query(
      `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه زمان‌بندی', 'scheduled-cafe', 'pro')`,
      [scheduledBusiness],
    );
    const periodEnd = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await db.query(
      `INSERT INTO business_subscriptions
         (business_id, plan_key, status, current_period_start, current_period_end, auto_renew)
       VALUES ($1, 'pro', 'active', now(), $2::timestamptz, true)`,
      [scheduledBusiness, periodEnd],
    );

    const scheduled = await dbLib.withTenant(scheduledBusiness, () =>
      subs.changeBusinessPlan({ businessId: scheduledBusiness, planKey: "business", source: "purchase" }),
    );
    expect(scheduled.outcome).toBe("scheduled");
    expect(scheduled.scheduledFor).toBe(periodEnd);
    expect(scheduled.subscription.planKey).toBe("pro");
    expect(scheduled.subscription.currentPeriodEnd).toBe(periodEnd);
    expect(scheduled.subscription.pendingPlanKey).toBe("business");
    expect(scheduled.subscription.pendingTermMonths).toBe(1);
    // The plan the business actually runs on does not move before the boundary.
    const before = await db.query<{ plan: string }>(`SELECT plan FROM businesses WHERE id = $1`, [scheduledBusiness]);
    expect(before.rows[0]!.plan).toBe("pro");

    // A second pending target is refused: resolving it would need a refund or
    // credit decision, which this path deliberately does not invent.
    await expect(
      dbLib.withTenant(scheduledBusiness, () =>
        subs.changeBusinessPlan({ businessId: scheduledBusiness, planKey: "business", source: "purchase" }),
      ),
    ).rejects.toMatchObject({ message: "plan_change_pending" });

    // Before the boundary nothing is due.
    const early = await dbLib.withTenant(scheduledBusiness, () =>
      subs.renewBusinessSubscription(scheduledBusiness, new Date()),
    );
    expect(early.status).toBe("nothing_due");

    // At the boundary the pending plan applies with no invoice and no debit.
    const applied = await dbLib.withTenant(scheduledBusiness, () =>
      subs.renewBusinessSubscription(scheduledBusiness, new Date(periodEnd)),
    );
    expect(applied.status).toBe("pending_applied");
    const after = await dbLib.withTenant(scheduledBusiness, () =>
      subs.getBusinessSubscription(scheduledBusiness),
    );
    expect(after?.planKey).toBe("business");
    expect(after?.pendingPlanKey).toBeNull();
    expect(after?.currentPeriodStart).toBe(periodEnd);
    expect(after?.currentPeriodEnd).toBe(addCalendarMonths(periodEnd, 1));
    const invoices = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM billing_invoices WHERE business_id = $1`,
      [scheduledBusiness],
    );
    expect(invoices.rows[0]!.count).toBe("0");

    // A replayed boundary tick finds nothing pending and bills nothing.
    const replay = await dbLib.withTenant(scheduledBusiness, () =>
      subs.renewBusinessSubscription(scheduledBusiness, new Date(periodEnd)),
    );
    expect(["nothing_due", "pending_applied"]).toContain(replay.status);
    const again = await dbLib.withTenant(scheduledBusiness, () =>
      subs.getBusinessSubscription(scheduledBusiness),
    );
    expect(again?.currentPeriodEnd).toBe(addCalendarMonths(periodEnd, 1));
  });
});

// ---------------------------------------------------------------------------
// cancel / reactivate / auto-renew
// ---------------------------------------------------------------------------

describe("subscription lifecycle actions", () => {
  it("cancels at period end, immediately, and reactivates", async () => {
    await scoped(async () => {
      const atEnd = await subs.cancelBusinessSubscription(BID, { atPeriodEnd: true });
      expect(atEnd.cancelAtPeriodEnd).toBe(true);
      expect(atEnd.status).toBe("active"); // still served to the paid boundary
      expect(atEnd.autoRenew).toBe(false);

      const revived = await subs.reactivateBusinessSubscription(BID);
      expect(revived.status).toBe("active");
      expect(revived.cancelAtPeriodEnd).toBe(false);

      const immediate = await subs.cancelBusinessSubscription(BID, { atPeriodEnd: false });
      expect(immediate.status).toBe("cancelled");
      expect(immediate.cancelledAt).toBeTruthy();

      const back = await subs.reactivateBusinessSubscription(BID);
      expect(back.status).toBe("active");

      const auto = await subs.setAutoRenew(BID, true);
      expect(auto.autoRenew).toBe(true);
    });
  });

  it("honours the plan's trial days on a fresh subscription", async () => {
    // A trial is a fresh-subscription concept: the row's INSERT path stamps
    // trial_end from the plan's trialDays. (A mid-period plan change keeps
    // the paid period and carries no trial.)
    const fresh = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await db.query(
      `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه تازه', 'fresh-cafe', 'free')`,
      [fresh],
    );
    await dbLib.withTenant(fresh, async () => {
      await plans.saveBillingPlan({
        key: "trially",
        name: "دورهٔ آزمایشی‌دار",
        status: "active",
        sortOrder: 96,
        trialDays: 7,
        limits: { branches: UNLIMITED, members: UNLIMITED, monthlyOrders: UNLIMITED },
      });
      const result = await subs.changeBusinessPlan({ businessId: fresh, planKey: "trially", source: "trial" });
      expect(result.outcome).toBe("created");
      expect(result.subscription.trialEnd).not.toBeNull();
      const days = Math.round(
        (new Date(result.subscription.trialEnd!).getTime() - new Date(result.subscription.startedAt).getTime()) / 86_400_000,
      );
      expect(days).toBe(7);
    });
  });
});

// ---------------------------------------------------------------------------
// Renewal: idempotent, transactional, graceful
// ---------------------------------------------------------------------------

describe("renewal", () => {
  it("renews a due paid subscription once — invoice claimed, wallet debited, period advanced", async () => {
    await scoped(async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 100_000_000, note: "شارژ تمدید" });
      await subs.setAutoRenew(BID, true);
      expect((await subs.getBusinessSubscription(BID))!.autoRenew).toBe(true);

      // Force the period into the past (the tick's `current_period_end <= now`).
      await db.query(
        `UPDATE business_subscriptions SET current_period_end = now() - interval '1 day' WHERE business_id = $1`,
        [BID],
      );
      const due = (await subs.getBusinessSubscription(BID))!;
      billedPeriodEnd = due.currentPeriodEnd;

      const outcome = await subs.renewBusinessSubscription(BID);
      expect(outcome.status).toBe("renewed");

      const after = (await subs.getBusinessSubscription(BID))!;
      expect(after.status).toBe("active");
      expect(after.lastRenewalAt).toBeTruthy();
      expect(new Date(after.currentPeriodStart).getTime()).toBe(new Date(due.currentPeriodEnd).getTime());

      // The wallet paid the plan's base fee — pro is 30,000,000 Rial.
      const w = await wallet.getWallet(BID);
      expect(w.totalSpentRial).toBe(30_000_000);

      // The invoice exists, is paid, carries the sequential number format and
      // snapshotted lines.
      const invoices = await subs.listInvoices({ businessId: BID });
      expect(invoices.length).toBe(1);
      expect(invoices[0].status).toBe("paid");
      expect(invoices[0].paidRial).toBe(30_000_000);
      expect(invoices[0].invoiceNumber).toMatch(/^INV-\d{6}-\d{4}$/);
      const withLines = await subs.getInvoice(invoices[0].id, true);
      expect(withLines?.lines?.length).toBe(1);
      expect(withLines?.lines?.[0].kind).toBe("plan");
      expect(withLines?.lines?.[0].amountRial).toBe(30_000_000);
    });
  });

  it("is idempotent: a retried tick never bills the same period twice", async () => {
    await scoped(async () => {
      expect(billedPeriodEnd).toBeTruthy();
      const walletBefore = await wallet.getWallet(BID);
      const invoicesBefore = await subs.listInvoices({ businessId: BID });

      // Rewind to the EXACT period end that was already billed: the UNIQUE
      // (business_id, reference) index is the idempotency backstop — a fresh
      // now()-1day would be a different, genuinely new period.
      await db.query(
        `UPDATE business_subscriptions SET current_period_end = $2 WHERE business_id = $1`,
        [BID, billedPeriodEnd],
      );
      const outcome = await subs.renewBusinessSubscription(BID);
      expect(outcome.status).toBe("duplicate");

      const walletAfter = await wallet.getWallet(BID);
      expect(walletAfter.totalSpentRial).toBe(walletBefore.totalSpentRial);
      const invoicesAfter = await subs.listInvoices({ businessId: BID });
      expect(invoicesAfter.length).toBe(invoicesBefore.length);
    });
  });

  it("goes past_due with a grace window when the wallet cannot pay", async () => {
    await scoped(async () => {
      // Drain the wallet to zero, then make the (unadvanced) period due again.
      const w = await wallet.getWallet(BID);
      if (w.balanceRial > 0) {
        await wallet.deductCredits({ businessId: BID, amountRial: w.balanceRial, note: "تخلیه برای آزمون" });
      }
      await db.query(
        `UPDATE business_subscriptions SET current_period_end = now() - interval '1 day' WHERE business_id = $1`,
        [BID],
      );

      const outcome = await subs.renewBusinessSubscription(BID);
      expect(outcome.status).toBe("past_due");
      const after = (await subs.getBusinessSubscription(BID))!;
      expect(after.status).toBe("past_due");
      expect(after.graceEnd).not.toBeNull();

      // Grace elapsed → the same renewal path expires it.
      await db.query(
        `UPDATE business_subscriptions SET grace_end = now() - interval '1 minute' WHERE business_id = $1`,
        [BID],
      );
      const expired = await subs.renewBusinessSubscription(BID);
      expect(expired.status).toBe("expired");
      expect((await subs.getBusinessSubscription(BID))!.status).toBe("expired");
    });
  });

  it("renews a free plan silently — no invoice, no charge", async () => {
    await scoped(async () => {
      const freeBiz = "dddddddd-dddd-dddd-dddd-dddddddddddd";
      await db.query(
        `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه رایگان', 'free-cafe', 'free')`,
        [freeBiz],
      );
      await dbLib.withTenant(freeBiz, async () => {
        await subs.changeBusinessPlan({ businessId: freeBiz, planKey: "free", source: "admin" });
        await subs.setAutoRenew(freeBiz, true);
        await db.query(
          `UPDATE business_subscriptions SET current_period_end = now() - interval '1 day' WHERE business_id = $1`,
          [freeBiz],
        );
        const outcome = await subs.renewBusinessSubscription(freeBiz);
        expect(outcome.status).toBe("free");
        const invoices = await subs.listInvoices({ businessId: freeBiz });
        expect(invoices.length).toBe(0);
      });
    });
  });

  it("calculateSubscriptionTotal is the one recurring-total computation (base + monthly addons)", async () => {
    await scoped(async () => {
      // Business is on `pro` (30,000,000). Add a monthly add-on to pro.
      await plans.savePlanFeature({ planKey: "pro", featureKey: "crm", pricingModel: "monthly", priceRial: 4_000_000, sortOrder: 10 });
      const total = await subs.calculateSubscriptionTotal(BID);
      expect(total.baseRial).toBe(30_000_000);
      expect(total.addonsRial).toBe(4_000_000);
      expect(total.totalRial).toBe(34_000_000);
      expect(total.lines.map((l) => l.kind)).toEqual(["plan", "addon"]);

      // A per-use price must NOT ride into the recurring total.
      await plans.savePlanFeature({ planKey: "pro", featureKey: "ai_agent", pricingModel: "per_use", priceRial: 25_000, sortOrder: 11 });
      const total2 = await subs.calculateSubscriptionTotal(BID);
      expect(total2.totalRial).toBe(34_000_000);
    });
  });
});

// ---------------------------------------------------------------------------
// The entitlement resolver
// ---------------------------------------------------------------------------

describe("the entitlement resolver", () => {
  it("answers with structured reasons: addon_required and metered pay-as-you-go", async () => {
    await scoped(async () => {
      // pro prices `crm` as a monthly add-on (granted by changeBusinessPlan);
      // an addon-model row nobody purchased denies with addon_required.
      await plans.savePlanFeature({ planKey: "pro", featureKey: "insights", pricingModel: "addon", priceRial: 900_000, sortOrder: 12 });
      const addon = await ent.resolveBusinessCapability(BID, "insights");
      expect(addon.allowed).toBe(false);
      expect(addon.reason).toBe("addon_required");

      // per_use is reachable pay-as-you-go and carries the live price.
      const metered = await ent.resolveBusinessCapability(BID, "ai_agent");
      expect(metered.allowed).toBe(true);
      expect(metered.perUsePriceRial).toBe(25_000);

      // The wallet guard turns a metered use into insufficient_credit.
      const w = await wallet.getWallet(BID);
      if (w.balanceRial > 0) {
        await wallet.deductCredits({ businessId: BID, amountRial: w.balanceRial, note: "تخلیه برای آزمون اعتبار" });
      }
      const broke = await ent.resolveBusinessCapability(BID, "ai_agent", { walletCheck: true });
      expect(broke.allowed).toBe(false);
      expect(broke.reason).toBe("insufficient_credit");
    });
  });

  it("denies plan-carried capabilities with subscription_expired once the subscription lapses", async () => {
    await scoped(async () => {
      // The subscription is `expired` from the renewal suite; `reporting` is
      // an included plan feature.
      const denied = await ent.resolveBusinessCapability(BID, "reporting");
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe("subscription_expired");

      // An owned add-on is not rented from the plan and survives it.
      await plans.grantEntitlement({ businessId: BID, featureKey: "insights", source: "addon" });
      const owned = await ent.resolveBusinessCapability(BID, "insights");
      expect(owned.allowed).toBe(true);

      // A metered feature also survives (the wallet pays per use).
      const metered = await ent.resolveBusinessCapability(BID, "ai_agent");
      expect(metered.allowed).toBe(true);
    });
  });

  it("resolves limit ceilings with the override layer the creation paths enforce", async () => {
    await scoped(async () => {
      // The seeded pro tier carries branch_limit = 5 (inherited from the 0034
      // limits catalogue by migration 0176).
      const planCeiling = await ent.resolveLimitCeiling(BID, "branch_limit");
      expect(planCeiling.limit).toBe(5);
      expect(planCeiling.overriddenBy).toBeNull();

      // An active override raises the ceiling…
      await db.query(
        `INSERT INTO business_billing_overrides
           (business_id, kind, target, value_int, reason, created_by, active)
         VALUES ($1, 'limit', 'branch_limit', 9, 'قرارداد سازمانی', NULL, true)`,
        [BID],
      );
      const overridden = await ent.resolveLimitCeiling(BID, "branch_limit");
      expect(overridden.limit).toBe(9);
      expect(overridden.overriddenBy).toBe("business_billing_overrides");

      const resolution = await ent.resolveBusinessLimit(BID, "branch_limit", 9);
      expect(resolution.reached).toBe(true);
      const notYet = await ent.resolveBusinessLimit(BID, "branch_limit", 8);
      expect(notYet.reached).toBe(false);

      // …and an expired override is ignored, falling back to the plan.
      await db.query(
        `UPDATE business_billing_overrides
            SET expires_at = now() - interval '1 day'
          WHERE business_id = $1 AND target = 'branch_limit'`,
        [BID],
      );
      const expired = await ent.resolveLimitCeiling(BID, "branch_limit");
      expect(expired.limit).toBe(5);
      expect(expired.overriddenBy).toBeNull();
    });
  });

  it("a globally-off flag denies with platform_unavailable unless the business holds an override", async () => {
    await scoped(async () => {
      await db.query(
        `UPDATE feature_flags SET default_enabled = false WHERE key = 'insights'`,
      );
      const off = await ent.resolveBusinessCapability(BID, "insights");
      expect(off.allowed).toBe(false);
      expect(off.reason).toBe("platform_unavailable");

      // The rollout exception: a business-level capability override.
      await db.query(
        `INSERT INTO business_billing_overrides
           (business_id, kind, target, value_bool, reason, created_by, active)
         VALUES ($1, 'capability', 'insights', true, 'استثنای توپچی', NULL, true)`,
        [BID],
      );
      const exception = await ent.resolveBusinessCapability(BID, "insights");
      expect(exception.allowed).toBe(true);
    });
  });
});
