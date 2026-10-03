/**
 * Phase 36b — the Growth app's dashboard is a *view* over engines that keep
 * their own books. These tests pin the two properties that make it trustworthy:
 *
 * 1. **The bridge is the ledger.** A gift card issued and partly redeemed
 *    through the real service must appear on the dashboard with exactly the
 *    liability the posting rule left in `journal_lines` — not a parallel
 *    number the dashboard computed for itself.
 * 2. **Campaign states read the date window the way the engine does** —
 *    inclusive bounds, and a paused campaign is «متوقف» even mid-window.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let growthOverview: typeof import("../src/lib/growth-overview")["growthOverview"];
let promotionsService: typeof import("../src/lib/promotions-service");

const biz = { id: "", locationId: "" };
const acct = { cash: "", giftCardPayable: "" };

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
  databaseName = `pos_growth_${randomUUID().replaceAll("-", "")}`;

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
  const growth = await import("../src/lib/growth-overview");
  growthOverview = growth.growthOverview;
  promotionsService = (await import("../src/lib/promotions-service")) as never;

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

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

beforeEach(async () => {
  // Children before parents: customer_points RESTRICTs customer deletion and
  // commission_accruals reference users, so both go before their parents.
  await db.query("DELETE FROM promotion_applications");
  await db.query("DELETE FROM customer_points");
  await db.query("DELETE FROM commission_accruals");
  await db.query("DELETE FROM gift_cards");
  await db.query("DELETE FROM promotions");
  await db.query("DELETE FROM loyalty_programs");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Growth Co', $1, 'accessories') RETURNING id",
    [`growth-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '2420', 'Gift Card Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "2420") acct.giftCardPayable = row.id;
  }
});

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe("the growth dashboard", () => {
  it("reports the gift-card liability the posting rule actually booked, not a number of its own", async () => {
    await withClient((client) =>
      promotionsService.issueGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code: "GC-1",
        initialValue: 500_000,
      }),
    );
    await withClient((client) =>
      promotionsService.redeemGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code: "GC-1",
        amount: 200_000,
      }),
    );

    const overview = await growthOverview(biz.id, { locationId: biz.locationId, today: isoDate(0) });

    // The ledger's own 2420 balance: 500,000 credited on issue, 200,000
    // debited on redemption → 300,000 owed to card holders.
    expect(overview.giftCards.outstandingRial).toBe(300_000);
    expect(overview.bridge.find((row) => row.code === "2420")?.balance).toBe(300_000);
    // Issued-in-window comes from gift_cards itself, and the card's issuance
    // is the newest activity the feed shows.
    expect(overview.giftCards.issued30d).toBe(1);
    expect(overview.giftCards.issuedValue30d).toBe(500_000);
    expect(overview.activity.some((row) => row.kind === "gift_card" && row.subject === "GC-1")).toBe(true);

    // And the journal really carries both legs — the dashboard has no other
    // source for the number above.
    const { rows: lines } = await db.query<{ debit: string; credit: string }>(
      "SELECT debit, credit FROM journal_lines WHERE account_id = $1 ORDER BY credit DESC",
      [acct.giftCardPayable],
    );
    expect(lines).toEqual([
      { debit: "0", credit: "500000" },
      { debit: "200000", credit: "0" },
    ]);
  });

  it("classifies campaigns with the engine's inclusive bounds, paused above all", async () => {
    await db.query(
      `INSERT INTO promotions (business_id, name, kind, value, active_from, active_to, is_active)
       VALUES
         ($1, 'Live today', 'percent', 10, $2::date, $2::date, true),
         ($1, 'Starts tomorrow', 'percent', 10, $3::date, NULL, true),
         ($1, 'Ended yesterday', 'percent', 10, NULL, $4::date, true),
         ($1, 'Paused mid-window', 'percent', 10, $2::date, $3::date, false)`,
      [biz.id, isoDate(0), isoDate(1), isoDate(-1)],
    );

    const overview = await growthOverview(biz.id, { locationId: null, today: isoDate(0) });
    expect(overview.campaigns.counts).toEqual({ live: 1, scheduled: 1, ended: 1, paused: 1 });
    // What is running first, what is next, history last.
    expect(overview.campaigns.list.map((c) => c.name)).toEqual([
      "Live today",
      "Starts tomorrow",
      "Paused mid-window",
      "Ended yesterday",
    ]);
  });

  it("aggregates campaign spend, points and commission over the rolling window", async () => {
    const promo = await db.query<{ id: string }>(
      `INSERT INTO promotions (business_id, name, kind, value) VALUES ($1, 'Happy hour', 'percent', 20) RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO promotion_applications (business_id, location_id, promotion_id, source_type, source_id, discount_rial)
       VALUES ($1, $2, $3, 'order', gen_random_uuid(), 60000),
              ($1, $2, $3, 'order', gen_random_uuid(), 40000)`,
      [biz.id, biz.locationId, promo.rows[0].id],
    );

    const customer = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name) VALUES ($1, 'Sara') RETURNING id",
      [biz.id],
    );
    await db.query(
      `INSERT INTO customer_points (business_id, customer_id, points, source_type) VALUES
         ($1, $2, 100, 'retail_invoice'), ($1, $2, -30, 'redeem')`,
      [biz.id, customer.rows[0].id],
    );
    await db.query(
      `INSERT INTO loyalty_programs (business_id, name, earn_points_per_100000, point_value_rial, is_active, is_default)
       VALUES ($1, 'Club', 1, 5000, true, true)`,
      [biz.id],
    );

    const seller = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, email, password_hash, role, full_name) VALUES ($1, $2, $3, 'cashier', 'Akbar') RETURNING id",
      [biz.id, `seller-${randomUUID().slice(0, 8)}@example.com`, "x"],
    );
    await db.query(
      `INSERT INTO commission_accruals (business_id, employee_id, source_type, amount, basis_amount)
       VALUES ($1, $2, 'retail_invoice', 25000, 500000)`,
      [biz.id, seller.rows[0].id],
    );

    const overview = await growthOverview(biz.id, { locationId: biz.locationId, today: isoDate(0) });

    expect(overview.campaigns.applications).toBe(2);
    expect(overview.campaigns.discountRial).toBe(100_000);
    expect(overview.campaigns.top[0]).toMatchObject({ promotionName: "Happy hour", applications: 2 });

    expect(overview.loyalty.pointsOutstanding).toBe(70); // 100 − 30
    expect(overview.loyalty.earned30d).toBe(100);
    expect(overview.loyalty.redeemed30d).toBe(30);
    expect(overview.loyalty.pointsValueEstimate).toBe(70 * 5_000); // at the default program's rate
    expect(overview.loyalty.customersWithPoints).toBe(1);
    // One customer party, and only that one: `parties` also holds employees and
    // suppliers since 0137, so a bare COUNT(*) would compare point-holders with
    // the whole counterparty book.
    expect(overview.loyalty.customersTotal).toBe(1);

    expect(overview.commission?.accrued30d).toBe(25_000);
    expect(overview.commission?.top[0]).toMatchObject({ employeeName: "Akbar", amount: 25_000 });

    // The merged feed carries every engine that produced an event, newest first.
    const kinds = overview.activity.map((row) => row.kind).sort();
    expect(kinds).toEqual(["campaign", "campaign", "commission", "points", "points"]);
    expect(overview.activity.length).toBeGreaterThan(0);
    const times = overview.activity.map((row) => row.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("counts point *holders*, not everyone who ever earned a point", async () => {
    // A customer who has spent every point they earned is not a point-holder,
    // and a supplier/employee party is not a customer at all. The dashboard
    // used to count both, so «۳ مشتری از ۴» could sit above zero outstanding
    // points.
    const spent = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'Spent it all', 'customer') RETURNING id",
      [biz.id],
    );
    const holder = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'Still has some', 'customer') RETURNING id",
      [biz.id],
    );
    await db.query("INSERT INTO parties (business_id, name, role) VALUES ($1, 'A supplier', 'supplier')", [biz.id]);
    await db.query("INSERT INTO parties (business_id, name, role, is_active) VALUES ($1, 'Archived', 'customer', false)", [
      biz.id,
    ]);
    await db.query(
      `INSERT INTO customer_points (business_id, customer_id, points, source_type) VALUES
         ($1, $2, 40, 'retail_invoice'), ($1, $2, -40, 'redeem'),
         ($1, $3, 40, 'retail_invoice'), ($1, $3, -10, 'redeem')`,
      [biz.id, spent.rows[0].id, holder.rows[0].id],
    );

    const overview = await growthOverview(biz.id, { locationId: null, today: isoDate(0) });
    expect(overview.loyalty.pointsOutstanding).toBe(30);
    expect(overview.loyalty.customersWithPoints).toBe(1); // only the holder
    expect(overview.loyalty.customersTotal).toBe(2); // active customers only
  });

  it("says whether a branch was in context, so a missing prediction is not a confident zero", async () => {
    const withBranch = await growthOverview(biz.id, { locationId: biz.locationId, today: isoDate(0) });
    expect(withBranch.hasLocation).toBe(true);

    const withoutBranch = await growthOverview(biz.id, { locationId: null, today: isoDate(0) });
    expect(withoutBranch.hasLocation).toBe(false);
    expect(withoutBranch.repurchase.due).toBe(0);
  });

  it("answers an empty business with zeros, not errors", async () => {
    const overview = await growthOverview(biz.id, { locationId: null, today: isoDate(0) });
    expect(overview.campaigns.counts).toEqual({ live: 0, scheduled: 0, ended: 0, paused: 0 });
    expect(overview.campaigns.discountRial).toBe(0);
    expect(overview.loyalty.pointsOutstanding).toBe(0);
    expect(overview.commission?.accrued30d).toBe(0);
    expect(overview.repurchase.due).toBe(0);
    expect(overview.activity).toEqual([]);
    // The bridge still lists the four accounts (present here only as 2420 in
    // this fixture) with their — zero — balances.
    expect(overview.bridge.map((row) => row.code)).toEqual(["2420"]);
    expect(overview.bridge[0].balance).toBe(0);
  });
});
