/**
 * Issue #902 §9 item 3 — what a message costs and what the ledger says it cost.
 *
 * Two systems record every send: the wallet (what the business paid) and the
 * Billing rating (`what the platform booked as usage`). The margin report is the
 * subtraction of the two and the provider reconciliation is the comparison of
 * the second against `billing_vendor_cost_events`, so their agreement is not a
 * nicety — it is the control. Until this slice the rating also cited whatever
 * meter price version was current when the event landed, while the amount beside
 * it had been priced by the retail catalogue: "which price version produced this
 * line?" had a confident and false answer.
 *
 * This file proves, against a real database:
 *
 *   1. A drained send leaves the wallet once and rates exactly the same amount,
 *      citing the retail version that priced it — by id and by number — with the
 *      meter column empty, because they are different catalogues.
 *   2. When the provider refuses one row of a batch, the business is charged for
 *      the rows that went out and nothing for the one that did not: money out of
 *      the wallet equals the sum of the ratings, and the refused row has no
 *      rating at all. (This case is why the drain's accounting was fixed: it had
 *      counted each accepted send twice, and `min(actual, reserved)` then kept
 *      the whole reservation for any batch with one refusal.)
 *   3. An amount the caller computed itself (`explicit_amount`) cites nothing at
 *      all, even when a meter price version is published and current.
 *   4. A meter-rated event still cites the meter version, so that column is not
 *      simply abandoned.
 *
 * No network call is made: the drain is handed a scripted provider.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { MessageProvider } from "../src/lib/messaging/provider";
import { smsSegmentCount } from "../src/lib/messaging-billing-pure";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const START_BALANCE = 500_000;
/** The address the scripted provider refuses; every other send is accepted. */
const REFUSED_ADDRESS = "+989120000099";

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let outbox: typeof import("../src/lib/message-outbox-service");
let billing: typeof import("../src/lib/messaging-billing");
let runtime: typeof import("../src/lib/billing/runtime");

const alpha = { businessId: "", slug: "" };

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

/**
 * The transport, scripted. One address is refused permanently, which is the
 * shape §4's refund policy exists for: the provider never accepted the send, so
 * the tenant is not billed for it.
 */
function scriptedProvider(): MessageProvider {
  let index = 0;
  return {
    key: "scripted",
    channel: "sms",
    async send(message) {
      index += 1;
      if (message.to === REFUSED_ADDRESS) {
        return { ok: false, retryable: false, code: "kavenegar_411", message: "invalid receptor" };
      }
      return {
        ok: true,
        providerMessageId: `scripted-${index}`,
        segments: Math.max(1, smsSegmentCount(message.body)),
        providerCostRial: 500,
      };
    },
  };
}

async function seedBusiness(name: string): Promise<{ businessId: string; slug: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id, slug };
}

async function fundWallet(businessId: string, rial: number): Promise<void> {
  await db.query(
    `INSERT INTO business_wallets (business_id, balance_rial, total_topped_up_rial, total_spent_rial)
     VALUES ($1, $2, $2, 0)`,
    [businessId, rial],
  );
  await db.query(
    `INSERT INTO wallet_ledger (business_id, kind, direction, amount_rial, balance_after_rial, note)
     VALUES ($1, 'top_up', 'credit', $2, $2, 'seed top-up')`,
    [businessId, rial],
  );
}

async function balanceRial(businessId: string): Promise<number> {
  const { rows } = await db.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [businessId],
  );
  return Number(rows[0]!.balance_rial);
}

/** Queued sends, one per address, with the outbox row ids `appendUsageEvent` reuses. */
async function queueSends(businessId: string, addresses: string[]): Promise<string[]> {
  const { rows: campaignRows } = await db.query<{ id: string }>(
    `INSERT INTO message_campaigns (business_id, channel, name, status)
     VALUES ($1, 'sms', 'Campaign', 'completed') RETURNING id`,
    [businessId],
  );
  const campaignId = campaignRows[0]!.id;
  const outboxIds: string[] = [];
  for (const address of addresses) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO message_recipients (business_id, campaign_id, channel, address, body)
       VALUES ($1, $2, 'sms', $3, 'کد ورود شما: ۱۲۳۴') RETURNING id`,
      [businessId, campaignId, address],
    );
    const { rows: queued } = await db.query<{ id: string }>(
      `INSERT INTO message_outbox (business_id, recipient_id, campaign_id, status)
       VALUES ($1, $2, $3, 'queued') RETURNING id`,
      [businessId, rows[0]!.id, campaignId],
    );
    outboxIds.push(queued[0]!.id);
  }
  return outboxIds;
}

/** Publish a retail price version, closing whatever was open before it. */
async function publishRetailVersion(input: { version: number; markupBps: number }): Promise<string> {
  await db.query(
    `UPDATE kavenegar_retail_price_versions SET effective_until = now() WHERE effective_until IS NULL`,
  );
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO kavenegar_retail_price_versions (version, markup_bps, effective_from, note)
     VALUES ($1, $2, now() - interval '1 minute', 'integration') RETURNING id`,
    [input.version, input.markupBps],
  );
  return rows[0]!.id;
}

type RatingRow = {
  event_id: string;
  rated_amount_rial: string;
  price_basis: string | null;
  price_version_id: string | null;
  retail_price_version_id: string | null;
  retail_price_version: number | null;
};

async function ratingsFor(businessId: string): Promise<RatingRow[]> {
  const { rows } = await db.query<RatingRow>(
    `SELECT e.event_id, r.rated_amount_rial, r.price_basis, r.price_version_id,
            r.retail_price_version_id, r.retail_price_version
       FROM billing_usage_ratings r
       JOIN billing_usage_events e ON e.id = r.usage_event_id
      WHERE r.business_id = $1
      ORDER BY e.event_id`,
    [businessId],
  );
  return rows;
}

function sumRatings(ratings: RatingRow[]): number {
  return ratings.reduce((sum, rating) => sum + Number(rating.rated_amount_rial), 0);
}

beforeAll(async () => {
  databaseName = `pos_msg_rating_${randomUUID().replaceAll("-", "")}`;

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
  outbox = await import("../src/lib/message-outbox-service");
  billing = await import("../src/lib/messaging-billing");
  runtime = await import("../src/lib/billing/runtime");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  // The platform's own send switch, so `resolveMessageConfig` reports enabled
  // and a per-segment base rate the retail version applies its markup to.
  await db.query(
    `INSERT INTO platform_message_config (id, enabled, sms_provider, email_provider, sms_rial_per_segment)
     VALUES (true, true, 'noop', 'noop', 1200)
     ON CONFLICT (id) DO UPDATE
       SET sms_rial_per_segment = 1200, enabled = true, sms_provider = 'noop', email_provider = 'noop'`,
  );
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

beforeEach(async () => {
  await db.query("DELETE FROM message_outbox");
  await db.query("DELETE FROM message_recipients");
  await db.query("DELETE FROM message_campaigns");
  await db.query("DELETE FROM billing_usage_ratings");
  await db.query("DELETE FROM billing_usage_events");
  await db.query("DELETE FROM billing_vendor_cost_events");
  await db.query("DELETE FROM wallet_ledger");
  await db.query("DELETE FROM business_wallets");
  await db.query("DELETE FROM kavenegar_retail_price_versions");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  await fundWallet(alpha.businessId, START_BALANCE);
});

describe("a drained send charges once and rates the same amount", () => {
  it("books the wallet debit and the usage rating at one figure, citing the version that priced it", async () => {
    const versionId = await publishRetailVersion({ version: 7, markupBps: 1_250 });
    const [outboxId] = await queueSends(alpha.businessId, ["+989120000001"]);

    const config = await billing.resolveMessageConfig();
    // The scope the background tick enters (`runMessagingTick`), so the drain
    // runs under the tenant's RLS context exactly as it does in production.
    const result = await dbLib.withTenant(alpha.businessId, () =>
      outbox.runBusinessMessageDrain(alpha.businessId, config, { sms: scriptedProvider(), email: null }),
    );
    expect(result).toMatchObject({ attempted: 1, sent: 1, failed: 0, refundedRial: 0 });

    const ratings = await ratingsFor(alpha.businessId);
    expect(ratings).toHaveLength(1);
    const rating = ratings[0]!;
    expect(rating.event_id).toBe(outboxId);

    // What left the wallet is what was rated — the whole point of the slice.
    const spent = START_BALANCE - (await balanceRial(alpha.businessId));
    expect(spent).toBe(sumRatings(ratings));
    expect(spent).toBeGreaterThan(0);

    // And the rating says which price produced it.
    expect(rating.price_basis).toBe("retail_price_version");
    expect(rating.retail_price_version).toBe(7);
    expect(rating.retail_price_version_id).toBe(versionId);
    // The meter column stays empty: `billing_price_versions` is a different
    // catalogue, and a value there is the false provenance this replaces.
    expect(rating.price_version_id).toBeNull();
  });

  it("rates every row of one batch under the version it was priced with", async () => {
    await publishRetailVersion({ version: 9, markupBps: 500 });
    await queueSends(alpha.businessId, ["+989120000011", "+989120000012", "+989120000013"]);

    const config = await billing.resolveMessageConfig();
    const result = await dbLib.withTenant(alpha.businessId, () =>
      outbox.runBusinessMessageDrain(alpha.businessId, config, { sms: scriptedProvider(), email: null }),
    );
    expect(result).toMatchObject({ sent: 3, failed: 0 });

    const ratings = await ratingsFor(alpha.businessId);
    expect(ratings).toHaveLength(3);
    expect(new Set(ratings.map((rating) => rating.retail_price_version))).toEqual(new Set([9]));
    expect(new Set(ratings.map((rating) => rating.price_basis))).toEqual(new Set(["retail_price_version"]));

    // One reservation was taken for the batch and three ratings were written;
    // if the sums disagree the margin report compares two different things.
    const spent = START_BALANCE - (await balanceRial(alpha.businessId));
    expect(spent).toBe(sumRatings(ratings));
  });

  it("charges nothing and rates nothing for a row the provider refused", async () => {
    await publishRetailVersion({ version: 11, markupBps: 1_000 });
    const [acceptedOne, refused, acceptedTwo] = await queueSends(alpha.businessId, [
      "+989120000021",
      REFUSED_ADDRESS,
      "+989120000023",
    ]);

    const config = await billing.resolveMessageConfig();
    const result = await dbLib.withTenant(alpha.businessId, () =>
      outbox.runBusinessMessageDrain(alpha.businessId, config, { sms: scriptedProvider(), email: null }),
    );
    expect(result).toMatchObject({ attempted: 3, sent: 2, failed: 1 });
    // The unsent row's share of the reservation comes back (§4, `refund`).
    expect(result.refundedRial).toBeGreaterThan(0);

    const { rows: refusedRows } = await db.query<{ status: string }>(
      `SELECT status FROM message_outbox WHERE id = $1`,
      [refused],
    );
    expect(refusedRows[0]!.status).toBe("failed");

    const ratings = await ratingsFor(alpha.businessId);
    // No rating for a send the provider never accepted…
    expect(ratings.map((rating) => rating.event_id).sort()).toEqual([acceptedOne, acceptedTwo].sort());
    // …and no money kept for it: what left the wallet is exactly what was rated.
    const spent = START_BALANCE - (await balanceRial(alpha.businessId));
    expect(spent).toBe(sumRatings(ratings));
  });
});

describe("an amount the caller computed itself cites no price version", () => {
  it("records explicit_amount even though a meter price version is published", async () => {
    // A current meter price exists, which is exactly the trap: the old code
    // stamped its id on an amount it had not been used to compute. The version
    // is dated a minute back because `publishPriceVersion` defaults to `now()`
    // and the event is rated at the JS clock's `now()`, which can be a
    // millisecond behind the database's.
    await runtime.publishPriceVersion({
      targetType: "meter",
      targetKey: "media.storage_byte_hour",
      unit: "byte_hour",
      unitAmountRial: 4_200,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    });

    await dbLib.withTenant(alpha.businessId, () =>
      runtime.appendUsageEvent({
        eventId: `media-storage:${alpha.businessId}:2026-10-30`,
        businessId: alpha.businessId,
        meterKey: "media.storage_byte_hour",
        source: "media",
        quantity: 24 * 1_000,
        unit: "byte_hour",
        resource: "media_library",
        resourceId: alpha.businessId,
        ratedAmountRial: 12_345,
        dimensions: { walletBacked: true },
      }),
    );

    const ratings = await ratingsFor(alpha.businessId);
    expect(ratings).toHaveLength(1);
    expect(ratings[0]).toMatchObject({
      price_basis: "explicit_amount",
      price_version_id: null,
      retail_price_version_id: null,
      retail_price_version: null,
    });
    // The amount itself is untouched: this slice changes provenance, not money.
    expect(Number(ratings[0]!.rated_amount_rial)).toBe(12_345);
  });
});

describe("a meter-rated event still cites the meter version", () => {
  it("cites the published version when no explicit amount is supplied", async () => {
    await runtime.publishPriceVersion({
      targetType: "meter",
      targetKey: "messaging.email_send",
      unit: "send",
      unitAmountRial: 3_000,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    });

    const { rows: published } = await db.query<{ id: string }>(
      `SELECT id FROM billing_price_versions
        WHERE target_type = 'meter' AND target_key = 'messaging.email_send'
          AND effective_until IS NULL
        ORDER BY effective_from DESC LIMIT 1`,
    );
    expect(published).toHaveLength(1);

    await dbLib.withTenant(alpha.businessId, () =>
      runtime.appendUsageEvent({
        eventId: `metered:${alpha.businessId}:1`,
        businessId: alpha.businessId,
        meterKey: "messaging.email_send",
        source: "messaging",
        quantity: 2,
        unit: "send",
        resource: "message_outbox",
        resourceId: "metered",
        dimensions: { walletBacked: false },
      }),
    );

    const ratings = await ratingsFor(alpha.businessId);
    expect(ratings).toHaveLength(1);
    expect(ratings[0]).toMatchObject({
      price_basis: "meter_price_version",
      price_version_id: published[0]!.id,
      retail_price_version: null,
    });
  });
});
