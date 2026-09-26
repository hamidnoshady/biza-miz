/**
 * Phase 27 Wave 6 — a gift card is a liability, never a balance column.
 *
 * Issuing one debits Cash and credits «کارت هدیه» (2420); redeeming it debits
 * that liability. Neither rule touches a revenue account, so a gift card can
 * never book revenue twice.
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
  databaseName = `pos_promotions_${randomUUID().replaceAll("-", "")}`;

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
  promotionsService = await import("../src/lib/promotions-service");

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
  await db.query("DELETE FROM gift_cards");
  await db.query("DELETE FROM promotions");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Promo Co', $1, 'accessories') RETURNING id",
    [`promo-${randomUUID().slice(0, 8)}`],
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
            ($1, '2420', 'Gift Card Payable', 'liability'),
            ($1, '4560', 'Accessory Sales Revenue', 'revenue')
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

describe("gift cards", () => {
  it("posts a liability when issued and debits it when redeemed, never touching revenue", async () => {
    const code = "GC-1001";
    await withClient((client) =>
      promotionsService.issueGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code,
        initialValue: 500_000,
      }),
    );

    expect(await promotionsService.giftCardBalance(biz.id, code)).toBe(500_000);

    const issuedEntry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'promotions.gift_card_issued'",
    );
    const { rows: issuedLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [issuedEntry.rows[0].entry_id],
    );
    expect(issuedLines).toEqual([
      { account_id: acct.cash, debit: "500000", credit: "0" },
      { account_id: acct.giftCardPayable, debit: "0", credit: "500000" },
    ]);

    await withClient((client) =>
      promotionsService.redeemGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code,
        amount: 200_000,
      }),
    );

    expect(await promotionsService.giftCardBalance(biz.id, code)).toBe(300_000);

    const redeemedEntry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'promotions.gift_card_redeemed'",
    );
    const { rows: redeemedLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [redeemedEntry.rows[0].entry_id],
    );
    expect(redeemedLines).toEqual([
      { account_id: acct.giftCardPayable, debit: "200000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "200000" },
    ]);

    // Neither posting touched the revenue account seeded above.
    const revenueTouches = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines WHERE account_id = $1`,
      [acct.giftCardPayable],
    );
    expect(Number(revenueTouches.rows[0].n)).toBe(2); // the two liability legs only
  });

  it("redeems the same card twice, in two separate transactions, without a duplicate-key crash", async () => {
    // Regression test: redeemGiftCard used to post its debit-the-liability
    // entry with a fixed `sourceId: card.id`. journal_entries has a unique
    // index on (business_id, source_type, source_id, posting_kind), so only
    // the *first* redemption of any gift card could ever post — every later
    // partial redemption of the same card (the whole point of a gift card)
    // threw a raw duplicate-key unique-constraint violation.
    const code = "GC-3001";
    await withClient((client) =>
      promotionsService.issueGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code,
        initialValue: 900_000,
      }),
    );

    const first = await withClient((client) =>
      promotionsService.redeemGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code,
        amount: 300_000,
      }),
    );
    expect(first.balance).toBe(600_000);

    const second = await withClient((client) =>
      promotionsService.redeemGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code,
        amount: 250_000,
      }),
    );
    expect(second.balance).toBe(350_000);
    expect(await promotionsService.giftCardBalance(biz.id, code)).toBe(350_000);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM journal_entries WHERE business_id = $1 AND source_type = 'gift_card'`,
      [biz.id],
    );
    // 1 issue + 2 redemptions.
    expect(rows[0].count).toBe("3");
  });

  it("refuses to redeem more than the card's remaining value", async () => {
    await withClient((client) =>
      promotionsService.issueGiftCard(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        code: "GC-2",
        initialValue: 100_000,
      }),
    );
    await expect(
      withClient((client) =>
        promotionsService.redeemGiftCard(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          code: "GC-2",
          amount: 200_000,
        }),
      ),
    ).rejects.toThrow(/کارت هدیه/);
  });
});
