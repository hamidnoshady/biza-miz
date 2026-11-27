/**
 * Issue #901 — the campaign cashback engine, against real Postgres.
 *
 * The claims this file exists to prove, one per test:
 *
 *  - a settled POS sale grants exactly one reward, and a replay grants none;
 *  - two sweeps running at once still grant once (the campaign lock + the
 *    campaign/order unique key);
 *  - the campaign budget is a hard ceiling — a reward that does not fit is
 *    refused, not paid part-way;
 *  - a held reward cannot be redeemed; once the hold ends it can, and the
 *    payout posts against 2445, not store credit;
 *  - a repeated redemption request key pays once;
 *  - a partial refund takes back only the unspent remainder;
 *  - an expired reward leaves the liability.
 *
 * Every journal assertion reads the lines that were actually posted, so a rule
 * that posted nothing (or the wrong account) fails rather than passing on the
 * campaign numbers alone.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let builder: typeof import("../src/lib/campaign-builder-service");
let rewards: typeof import("../src/lib/campaign-reward-service");

const biz = { id: "", locationId: "" };

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

beforeAll(async () => {
  databaseName = `pos_growth_rewards_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  builder = await import("../src/lib/campaign-builder-service");
  rewards = await import("../src/lib/campaign-reward-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

const SEED_ACCOUNTS: [string, string, string][] = [
  ["1100", "صندوق", "asset"],
  ["1110", "بانک", "asset"],
  ["5600", "بازاریابی و تبلیغات", "expense"],
  ["2445", "بازگشت وجه تبلیغاتی", "liability"],
];

beforeEach(async () => {
  // The reward ledger is append-only; its rows leave only with their position
  // (the cascade the migration guards), never on their own. The position goes
  // first, and it takes its events — and their redemption references — with it.
  await db.query("DELETE FROM growth_reward_entitlements");
  await db.query("DELETE FROM growth_campaign_budget_reservations");
  await db.query("DELETE FROM growth_reward_redemptions");
  // Campaigns go with their locked versions; the version guard permits the
  // cascade (the parent is already gone) and still refuses an edit.
  await db.query("DELETE FROM growth_campaigns");
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Campaign Co', $1, 'food_service') RETURNING id",
    [`campaign-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  for (const [code, name, type] of SEED_ACCOUNTS) {
    await db.query("INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, $4)", [
      biz.id,
      code,
      name,
      type,
    ]);
  }
}, 60_000);

const definition = (overrides: { percentBps?: number; holdDays?: number; budgetRial?: number; capRial?: number } = {}) => ({
  trigger: { type: "pos_sale_settled", minNetPaidRial: 0, locationIds: null },
  reward: {
    type: "cashback",
    mode: "percent",
    percentBps: overrides.percentBps ?? 1000,
    basis: "net_paid",
    maxPerOrderRial: null,
    holdDays: overrides.holdDays ?? 0,
  },
  limits: { totalBudgetRial: overrides.budgetRial ?? 1_000_000, perCustomerCapRial: overrides.capRial ?? null },
});

async function activeCampaign(overrides: Parameters<typeof definition>[0] = {}) {
  const created = await builder.createCampaign(biz.id, null, { name: "کمپین بازگشت وجه", definition: definition(overrides) });
  await builder.transitionCampaign(biz.id, null, created.id, "submit");
  // The approver is a different trust from the composer in production; this
  // test exercises the service, so it calls the transitions directly.
  await builder.transitionCampaign(biz.id, null, created.id, "approve");
  return builder.transitionCampaign(biz.id, null, created.id, "activate");
}

async function customer(name = "مشتری"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, $2) RETURNING id",
    [biz.id, name],
  );
  return rows[0].id;
}

async function settledOrder(customerId: string, amountRial: number, closedAt = new Date()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, subtotal, tax, total, closed_at, opened_at)
     VALUES ($1, (SELECT COALESCE(MAX(order_number), 0) + 1 FROM orders WHERE location_id = $1),
             'completed', $2, $3, 0, $3, $4, $4)
     RETURNING id`,
    [biz.locationId, customerId, amountRial, closedAt.toISOString()],
  );
  await db.query(
    "INSERT INTO payments (location_id, order_id, method, amount) VALUES ($1, $2, 'cash', $3)",
    [biz.locationId, rows[0].id, amountRial],
  );
  return rows[0].id;
}

async function postedLines(sourceType: string) {
  const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1 AND je.source_type = $2
      ORDER BY a.code`,
    [biz.id, sourceType],
  );
  return rows;
}

describe("granting a reward", () => {
  it("grants once for a settled sale and never again on replay", async () => {
    const campaign = await activeCampaign();
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);

    const first = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(first.granted).toBe(1);
    expect(first.grantedRial).toBe(100_000);

    const second = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(second.granted).toBe(0);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM growth_reward_entitlements WHERE campaign_id = $1",
      [campaign.id],
    );
    expect(rows[0].n).toBe("1");

    const lines = await postedLines("growth_campaign_reward");
    expect(lines).toEqual([
      { code: "2445", debit: "0", credit: "100000" },
      { code: "5600", debit: "100000", credit: "0" },
    ]);
  });

  it("grants once when two sweeps race", async () => {
    const campaign = await activeCampaign();
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);

    const results = await Promise.all([
      rewards.sweepCampaignRewards(biz.id, campaign.id),
      rewards.sweepCampaignRewards(biz.id, campaign.id),
    ]);
    expect(results.reduce((total, result) => total + result.granted, 0)).toBe(1);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM growth_reward_entitlements WHERE campaign_id = $1",
      [campaign.id],
    );
    expect(rows[0].n).toBe("1");
  });

  it("refuses a reward that does not fit the remaining budget", async () => {
    const campaign = await activeCampaign({ budgetRial: 50_000 });
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);

    const result = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(result.granted).toBe(0);
    expect(result.skipped.budget_exhausted).toBe(1);

    const lines = await postedLines("growth_campaign_reward");
    expect(lines).toEqual([]);
  });

  it("does not pay for a sale that happened before activation", async () => {
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000, new Date(Date.now() - 3 * 86_400_000));
    const campaign = await activeCampaign();

    const result = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(result.granted).toBe(0);
  });
});

describe("hold, redemption and replay", () => {
  it("keeps a held reward unspendable, then pays it out once", async () => {
    const campaign = await activeCampaign({ holdDays: 7 });
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);
    await rewards.sweepCampaignRewards(biz.id, campaign.id);

    await expect(
      rewards.redeemCampaignReward(biz.id, {
        customerId,
        amountRial: 100_000,
        payoutMethod: "cash",
        requestKey: randomUUID(),
        actorId: null,
        businessDate: new Date().toISOString().slice(0, 10),
        locationId: biz.locationId,
      }),
    ).rejects.toMatchObject({ code: "reward_balance_insufficient", status: 409 });

    // Eight days later the return hold has ended.
    const later = new Date(Date.now() + 8 * 86_400_000);
    await rewards.sweepCampaignRewards(biz.id, campaign.id, { now: later });

    const requestKey = randomUUID();
    const paid = await rewards.redeemCampaignReward(biz.id, {
      customerId,
      amountRial: 100_000,
      payoutMethod: "cash",
      requestKey,
      actorId: null,
      businessDate: new Date().toISOString().slice(0, 10),
      locationId: biz.locationId,
      now: later,
    });
    expect(paid.replayed).toBe(false);
    expect(paid.entryId).not.toBeNull();

    const replayed = await rewards.redeemCampaignReward(biz.id, {
      customerId,
      amountRial: 100_000,
      payoutMethod: "cash",
      requestKey,
      actorId: null,
      businessDate: new Date().toISOString().slice(0, 10),
      locationId: biz.locationId,
      now: later,
    });
    expect(replayed.replayed).toBe(true);
    expect(replayed.amountRial).toBe(100_000);

    const lines = await postedLines("growth_cashback_redemption");
    expect(lines).toEqual([
      { code: "1100", debit: "0", credit: "100000" },
      { code: "2445", debit: "100000", credit: "0" },
    ]);
  });
});

describe("refund and expiry", () => {
  it("takes back only the unspent remainder of a partially refunded sale", async () => {
    const campaign = await activeCampaign();
    const customerId = await customer();
    const orderId = await settledOrder(customerId, 1_000_000);
    await rewards.sweepCampaignRewards(biz.id, campaign.id);

    // Spend 40 000 of the 100 000 first.
    await rewards.redeemCampaignReward(biz.id, {
      customerId,
      amountRial: 40_000,
      payoutMethod: "cash",
      requestKey: randomUUID(),
      actorId: null,
      businessDate: new Date().toISOString().slice(0, 10),
      locationId: biz.locationId,
    });

    // A 20 000 refund leaves 980 000 net paid → the reward should be 98 000.
    await db.query(
      "INSERT INTO payments (location_id, order_id, method, amount) VALUES ($1, $2, 'cash', -20000)",
      [biz.locationId, orderId],
    );
    const result = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(result.reversedRial).toBe(2_000);

    const { rows } = await db.query<{ earned: string; redeemed: string; reversed: string; status: string }>(
      `SELECT earned_rial::text AS earned, redeemed_rial::text AS redeemed,
              reversed_rial::text AS reversed, status
         FROM growth_reward_entitlements WHERE campaign_id = $1`,
      [campaign.id],
    );
    expect(rows[0]).toEqual({ earned: "100000", redeemed: "40000", reversed: "2000", status: "partially_redeemed" });

    const wallet = await rewards.campaignRewardWallet(biz.id, customerId);
    expect(wallet.spendableRial).toBe(58_000);
  });

  it("expires what is left and removes it from the liability", async () => {
    const campaign = await activeCampaign();
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);
    await rewards.sweepCampaignRewards(biz.id, campaign.id);

    await rewards.sweepCampaignRewards(biz.id, campaign.id, {
      now: new Date(Date.now() + 400 * 86_400_000),
    });

    const { rows } = await db.query<{ expired: string }>(
      "SELECT expired_rial::text AS expired FROM growth_reward_entitlements WHERE campaign_id = $1",
      [campaign.id],
    );
    expect(rows[0].expired).toBe("100000");

    const liability = await rewards.cashbackLiabilitySummary(biz.id);
    expect(liability.outstandingRial).toBe(0);
  });
});

describe("campaign lifecycle", () => {
  it("refuses to activate a campaign that has not been approved", async () => {
    const created = await builder.createCampaign(biz.id, null, { name: "پیش‌نویس", definition: definition() });
    await expect(builder.transitionCampaign(biz.id, null, created.id, "activate")).rejects.toMatchObject({
      code: "campaign_not_approved",
      status: 409,
    });
  });

  it("locks the rules on submit and refuses later draft edits", async () => {
    const created = await builder.createCampaign(biz.id, null, { name: "قفل", definition: definition() });
    await builder.transitionCampaign(biz.id, null, created.id, "submit");
    await expect(
      builder.saveCampaignDraft(biz.id, null, created.id, { name: "تغییر" }),
    ).rejects.toMatchObject({ code: "campaign_not_editable", status: 409 });
  });

  it("pauses a running campaign so it stops granting", async () => {
    const campaign = await activeCampaign();
    const customerId = await customer();
    await settledOrder(customerId, 1_000_000);
    await builder.transitionCampaign(biz.id, null, campaign.id, "pause");

    const result = await rewards.sweepCampaignRewards(biz.id, campaign.id);
    expect(result.granted).toBe(0);
  });
});
