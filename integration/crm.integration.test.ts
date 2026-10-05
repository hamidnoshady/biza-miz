/**
 * Phase 36 — the CRM against a real database.
 *
 * Four properties, each one chosen because it is a place the app could be
 * quietly wrong in a way no unit test would catch:
 *
 * 1. **A merge moves no money.** This is the one an accountant would ask about.
 *    Merging two customer records repoints who a sale is *attributed* to; it
 *    must not touch a journal line, a total, or a date. The test takes a full
 *    trial balance before and after and demands they be identical.
 * 2. **Consent is enforced in SQL, not in the UI.** A segment resolved for
 *    `purpose: "sms"` must never return a customer who has not agreed, however
 *    the definition is phrased — and `totalBeforeConsent` must still report the
 *    unfiltered population, because the gap is the useful fact.
 * 3. **The file and the segment agree.** A customer whose 360° file says «۳
 *    خرید» must be matched by a segment asking for «حداقل ۳ خرید». Two
 *    different SQL builders compute this; if they ever disagree, the app is
 *    lying on one of its screens and nobody can tell which.
 * 4. **RLS holds on every new table.** The CRM's six tables are new tenant
 *    surfaces; a business must not see another's deals, cases or notes.
 * 5. **The task list's saved-view vocabulary reaches SQL.** Every key a view can
 *    store — `q`, `kind`, `state`, `assignee` — must narrow the rows, and the
 *    date-bounded states must be judged against the *business* day rather than
 *    the browser's, because that is the date the rows are coloured by.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  activityViewListOptions,
  activityViewQuery,
  parseActivityViewFilters,
} from "../src/lib/crm-activity-views";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let crm: typeof import("../src/lib/crm-service");
let overview: typeof import("../src/lib/crm-overview");
let segmentsService: typeof import("../src/lib/crm-segments-service");
let timelineService: typeof import("../src/lib/customer-timeline-service");
let businessDay: typeof import("../src/lib/business-day-service");
let views: typeof import("../src/lib/crm-saved-views-service");
let audienceRequest: typeof import("../src/lib/crm-audience-request");

const biz = { id: "", locationId: "" };
const other = { id: "", locationId: "" };
const acct = { cash: "", revenue: "", receivable: "" };

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
  databaseName = `pos_crm_${randomUUID().replaceAll("-", "")}`;

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
  crm = await import("../src/lib/crm-service");
  overview = await import("../src/lib/crm-overview");
  segmentsService = await import("../src/lib/crm-segments-service");
  timelineService = await import("../src/lib/customer-timeline-service");
  audienceRequest = await import("../src/lib/crm-audience-request");

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
  // Children before parents: customer_points RESTRICTs customer deletion, and
  // every crm_* table references customers.
  await db.query("DELETE FROM crm_consent_events");
  await db.query("DELETE FROM crm_merges");
  await db.query("DELETE FROM crm_activities");
  await db.query("DELETE FROM crm_deals");
  await db.query("DELETE FROM crm_cases");
  await db.query("DELETE FROM customer_notes");
  await db.query("DELETE FROM customer_segments");
  await db.query("DELETE FROM customer_points");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('CRM Co', $1, 'food_service') RETURNING id",
    [`crm-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const otherRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Rival Co', $1, 'food_service') RETURNING id",
    [`rival-${randomUUID().slice(0, 8)}`],
  );
  other.id = otherRow.rows[0].id;
  const otherLoc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [other.id],
  );
  other.locationId = otherLoc.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '4100', 'Sales Revenue', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "1200") acct.receivable = row.id;
    if (row.code === "4100") acct.revenue = row.id;
  }
});

/** A customer, with only what the CRM needs. */
async function makeCustomer(
  businessId: string,
  name: string,
  overrides: {
    phone?: string | null;
    email?: string | null;
    smsConsent?: boolean;
    marketingConsent?: boolean;
    tags?: string[];
  } = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, phone, phone_e164, email, sms_consent, marketing_consent, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      businessId,
      name,
      overrides.phone ?? null,
      overrides.phone ?? null,
      overrides.email ?? null,
      overrides.smsConsent ?? false,
      overrides.marketingConsent ?? false,
      overrides.tags ?? [],
    ],
  );
  return rows[0].id;
}

/**
 * A completed, settled sale with its journal entry — the real thing, so the
 * trial balance below has something to be identical about.
 */
async function makeSale(
  locationId: string,
  businessId: string,
  customerId: string,
  total: number,
  daysAgo: number,
): Promise<string> {
  const closedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
     VALUES ($1, $2, 'completed', $3, $3, $4, $5) RETURNING id`,
    [locationId, customerId, total, closedAt, Math.floor(Math.random() * 1_000_000)],
  );
  const orderId = rows[0].id;

  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
     VALUES ($1, $2, $3::date, 'sale', 'order', $4) RETURNING id`,
    [businessId, locationId, closedAt.slice(0, 10), orderId],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entry.rows[0].id, acct.cash, total, acct.revenue],
  );
  return orderId;
}

/** The trial balance, as an accountant would read it: per account, debit and credit totals. */
async function trialBalance(businessId: string) {
  const { rows } = await db.query(
    `SELECT a.code, sum(jl.debit)::text AS debit, sum(jl.credit)::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code
      ORDER BY a.code`,
    [businessId],
  );
  return rows;
}

describe("merging two customer records", () => {
  it("moves the relationship and leaves the ledger untouched", async () => {
    const keep = await makeCustomer(biz.id, "مریم رضایی", {
      phone: "+989121112233",
      smsConsent: true,
      marketingConsent: true,
      tags: ["وی‌آی‌پی"],
    });
    // The same person, entered again at the counter with no email and no
    // marketing permission — the ordinary way a duplicate is born.
    const dupe = await makeCustomer(biz.id, "مریم رضائی", {
      phone: "+989121112233",
      email: "maryam@example.com",
      smsConsent: true,
      marketingConsent: false,
      tags: ["تولد اسفند"],
    });

    await makeSale(biz.locationId, biz.id, keep, 400_000, 10);
    await makeSale(biz.locationId, biz.id, dupe, 250_000, 5);
    await makeSale(biz.locationId, biz.id, dupe, 150_000, 2);

    const before = await trialBalance(biz.id);

    const result = await crm.mergeCustomers(biz.id, keep, dupe, { mergedBy: "آزمون" });
    expect(result).not.toBeNull();
    expect(result!.moved.orders).toBe(2);

    // ---- The property this whole test exists for -------------------------
    // Not "roughly the same", not "still balances" — byte-identical. A merge
    // that adjusted, reversed or re-dated so much as one line would show here.
    expect(await trialBalance(biz.id)).toEqual(before);

    // The orders themselves are untouched apart from who they belong to: same
    // totals, same dates, same journal entries pointing at the same ids.
    const orphaned = await db.query(
      `SELECT count(*)::int AS n FROM journal_entries je
        WHERE je.business_id = $1 AND je.source_type = 'order'
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = je.source_id)`,
      [biz.id],
    );
    expect(orphaned.rows[0].n).toBe(0);

    // ---- And the CRM half did happen -------------------------------------
    const file = await crm.getCustomerFile(biz.id, keep);
    expect(file!.stats.orderCount).toBe(3);
    expect(file!.stats.totalSpentRial).toBe(800_000);
    // A blank field on the winner is filled from the loser rather than lost.
    expect(file!.email).toBe("maryam@example.com");
    // Tags union…
    expect([...file!.tags].sort()).toEqual(["تولد اسفند", "وی‌آی‌پی"].sort());
    // …but consent INTERSECTS. The loser never agreed to marketing email, so
    // the merged record has not agreed either. A merge must never manufacture a
    // permission neither record held.
    expect(file!.smsConsent).toBe(true);
    expect(file!.marketingConsent).toBe(false);

    // The loser is archived, not deleted, so old links still resolve.
    const loserFile = await crm.getCustomerFile(biz.id, dupe);
    expect(loserFile!.isActive).toBe(false);
    expect(loserFile!.mergedIntoId).toBe(keep);

    // And the merge itself is on the record.
    const merges = await db.query(`SELECT winner_id, loser_id FROM crm_merges WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(merges.rows).toHaveLength(1);
    expect(merges.rows[0].winner_id).toBe(keep);
  });

  it("refuses to merge a record into itself", async () => {
    const one = await makeCustomer(biz.id, "علی");
    expect(await crm.mergeCustomers(biz.id, one, one)).toBeNull();
  });
});

describe("the CRM overview", () => {
  it("counts only active customer parties and computes pipeline values from each deal", async () => {
    const customer = await makeCustomer(biz.id, "مشتری فعال", { phone: "+989121234567" });
    const inactive = await makeCustomer(biz.id, "مشتری بایگانی", { phone: "+989121234568" });
    await db.query("UPDATE parties SET is_active = false WHERE id = $1", [inactive]);
    const supplier = (
      await db.query<{ id: string }>(
        "INSERT INTO parties (business_id, name, role) VALUES ($1, 'تأمین‌کننده', 'supplier') RETURNING id",
        [biz.id],
      )
    ).rows[0].id;

    await makeSale(biz.locationId, biz.id, customer, 400_000, 2);
    // These sales must not leak into active-customer totals, even though they
    // belong to this tenant and point at a valid party.
    await makeSale(biz.locationId, biz.id, inactive, 900_000, 2);
    await makeSale(biz.locationId, biz.id, supplier, 800_000, 2);

    await db.query(
      `INSERT INTO crm_deals (business_id, customer_id, title, stage, value_rial, probability)
       VALUES ($1, $2, 'سرنخ اول', 'lead', 1000000, 50),
              ($1, $2, 'سرنخ دوم', 'lead', 1000000, 10),
              ($1, $2, 'واجد شرایط', 'qualified', 2000000, NULL),
              ($1, $2, 'فروش موفق', 'won', 1000000, NULL),
              ($1, $2, 'فروش از دست رفته', 'lost', 3000000, NULL)`,
      [biz.id, customer],
    );
    await db.query(
      "INSERT INTO customer_segments (business_id, name, definition) VALUES ($1, 'مشتریان فعال', '{}'::jsonb)",
      [biz.id],
    );

    const result = await dbLib.withTenant(biz.id, () => overview.crmOverview(biz.id));

    expect(result.customers.total).toBe(1);
    expect(result.customers.active).toBe(1);
    expect(result.customers.neverPurchased).toBe(0);
    expect(result.value.totalHistoricRial).toBe("400000");
    expect(result.value.averageCustomerRial).toBe("400000");
    expect(result.topCustomers[0]).toMatchObject({
      id: customer,
      totalSpentRial: "400000",
      orderCount: 1,
    });
    expect(result.pipeline.openCount).toBe(3);
    expect(result.pipeline.openValueRial).toBe("4000000");
    // 500k + 100k + the default 30% of 2m = 1.2m. Won/lost are terminal and
    // do not contribute to the open weighted forecast.
    expect(result.pipeline.weightedValueRial).toBe("1200000");
    expect(result.pipeline.winRatePercent).toBe(50);
    expect(result.pipeline.byStage).toEqual([
      { stage: "lead", count: 2, valueRial: "2000000" },
      { stage: "qualified", count: 1, valueRial: "2000000" },
    ]);
    expect(result.segments).toEqual({ total: 1, names: ["مشتریان فعال"] });
  });
});

describe("segments", () => {
  it("filters by consent in SQL, and still reports the unfiltered population", async () => {
    // Four loyal customers; only one has agreed to be texted on a mobile line.
    const willing = await makeCustomer(biz.id, "زهرا", { phone: "+989120000001", smsConsent: true });
    const unwilling = await makeCustomer(biz.id, "حسن", { phone: "+989120000002", smsConsent: false });
    // Agreed to be texted, but there is no number to text — granted is not the
    // same as reachable, and a send must use the second.
    const unreachable = await makeCustomer(biz.id, "نگار", { phone: null, smsConsent: true });
    // A landline can parse as an Iranian number, but it cannot receive the SMS
    // campaign; the segment predicate must use the mobile reachability rule.
    const landline = await makeCustomer(biz.id, "دفتر", { phone: "+982112345678", smsConsent: true });

    for (const id of [willing, unwilling, unreachable, landline]) {
      await makeSale(biz.locationId, biz.id, id, 300_000, 3);
      await makeSale(biz.locationId, biz.id, id, 300_000, 6);
    }

    const definition = {
      all: [{ field: "orderCount" as const, op: "gte" as const, value: 2 }],
    };

    const view = await segmentsService.previewSegment(biz.id, definition, { purpose: "view" });
    expect(view.count).toBe(4);

    const sms = await segmentsService.previewSegment(biz.id, definition, { purpose: "sms" });
    // Only the one who agreed AND can be reached on a mobile number.
    expect(sms.count).toBe(1);
    // The gap is reported rather than hidden: «۴ نفر همخوانی دارند، ۱ نفر
    // اجازه داده» is the fact an owner needs, and a silently smaller number is
    // the thing that makes people distrust the tool.
    expect(sms.totalBeforeConsent).toBe(4);

    const audience = await segmentsService.resolveDefinition(biz.id, definition, { purpose: "sms" });
    expect(audience.map((row) => row.id)).toEqual([willing]);
    expect(audience.map((row) => row.id)).not.toContain(unwilling);
    expect(audience.map((row) => row.id)).not.toContain(unreachable);
    expect(audience.map((row) => row.id)).not.toContain(landline);
  });

  it("keeps suppliers and personnel out of customer segments unless they are also customers", async () => {
    const customer = await makeCustomer(biz.id, "خریدار");
    const supplier = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role, roles)
       VALUES ($1, 'تأمین‌کننده', 'supplier', ARRAY['supplier']::text[]) RETURNING id`,
      [biz.id],
    );

    const preview = await segmentsService.previewSegment(biz.id, {});
    expect(preview.count).toBe(1);
    expect(preview.sample.map((row) => row.id)).toContain(customer);
    expect(preview.sample.map((row) => row.id)).not.toContain(supplier.rows[0].id);
  });

  it("excludes a merged-away record, so a person is never counted twice", async () => {
    const keep = await makeCustomer(biz.id, "پرویز", { phone: "+989123334455" });
    const dupe = await makeCustomer(biz.id, "پرویز ن", { phone: "+989123334455" });
    await makeSale(biz.locationId, biz.id, keep, 200_000, 4);
    await makeSale(biz.locationId, biz.id, dupe, 200_000, 3);

    const definition = {
      all: [{ field: "orderCount" as const, op: "gte" as const, value: 1 }],
    };
    expect((await segmentsService.previewSegment(biz.id, definition)).count).toBe(2);

    await crm.mergeCustomers(biz.id, keep, dupe);

    const after = await segmentsService.previewSegment(biz.id, definition);
    expect(after.count).toBe(1);
    // …and the survivor carries both purchases, so nothing was lost either.
    const file = await crm.getCustomerFile(biz.id, keep);
    expect(file!.stats.orderCount).toBe(2);
  });

  it("agrees with the customer's own file about how many purchases they made", async () => {
    // Two independent SQL builders compute this — `crm-segments-service` and
    // `getCustomerFile`. If they disagree, one of the app's screens is lying
    // and an owner has no way to know which.
    const customer = await makeCustomer(biz.id, "سمیرا");
    for (const daysAgo of [2, 9, 20]) {
      await makeSale(biz.locationId, biz.id, customer, 100_000, daysAgo);
    }
    // A voided order is not a purchase on either side of that comparison.
    await db.query(
      `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
       VALUES ($1, $2, 'voided', 500000, 500000, now(), $3)`,
      [biz.locationId, customer, Math.floor(Math.random() * 1_000_000)],
    );

    const file = await crm.getCustomerFile(biz.id, customer);
    expect(file!.stats.orderCount).toBe(3);
    expect(file!.stats.totalSpentRial).toBe(300_000);

    const matched = await segmentsService.resolveDefinition(
      biz.id,
      { all: [{ field: "orderCount", op: "gte", value: 3 }] },
      { purpose: "view" },
    );
    expect(matched.map((row) => row.id)).toContain(customer);
    expect(matched.find((row) => row.id === customer)!.orderCount).toBe(file!.stats.orderCount);
  });

  it("a spoken audience resolves the people the written document names", async () => {
    // The spoken and the written document are asserted to be *the same
    // document*, so the rows below come from the builder's own SQL path — there
    // is no second query hiding behind the sentence box.
    const lapsed = await makeCustomer(biz.id, "سمیرا", { smsConsent: true });
    const recent = await makeCustomer(biz.id, "کیوان", { smsConsent: true });
    await makeSale(biz.locationId, biz.id, lapsed, 500_000, 100);
    await makeSale(biz.locationId, biz.id, recent, 500_000, 5);

    const interpretation = audienceRequest.interpretAudienceRequest(
      "۹۰ روز است خرید نکرده‌اند و رضایت پیامک دارند",
    );
    expect(interpretation.unread).toEqual([]);
    expect(interpretation.ok).toBe(true);

    const written = {
      all: [
        { field: "lastPurchaseAt" as const, op: "before" as const, days: 90 },
        { field: "smsConsent" as const, op: "is" as const, value: true },
      ],
    };
    expect(interpretation.definition).toEqual(written);

    const audience = await segmentsService.resolveDefinition(
      biz.id,
      interpretation.definition,
      { purpose: "view" },
    );
    const ids = audience.map((row) => row.id);
    // Other fixtures in this file have older purchases, so containment is the
    // claim: the lapsed buyer is in, the one who bought this week is not.
    expect(ids).toContain(lapsed);
    expect(ids).not.toContain(recent);
    expect(ids).toEqual(
      (
        await segmentsService.resolveDefinition(biz.id, written, { purpose: "view" })
      ).map((row) => row.id),
    );
  });
});

describe("the consent register", () => {
  it("records every change append-only, and reports granted separately from reachable", async () => {
    const withPhone = await makeCustomer(biz.id, "کاوه", { phone: "+989127778899" });
    const withoutPhone = await makeCustomer(biz.id, "لیلا", { phone: null });

    await crm.setConsent(biz.id, withPhone, {
      channel: "sms",
      granted: true,
      source: "staff",
      note: "در فروشگاه پرسیده شد",
      changedBy: "آزمون",
    });
    await crm.setConsent(biz.id, withoutPhone, {
      channel: "sms",
      granted: true,
      source: "staff",
      changedBy: "آزمون",
    });
    // …and then changed their mind. Both facts survive; the second does not
    // erase the first, which is the whole point of an audit trail.
    await crm.setConsent(biz.id, withPhone, {
      channel: "sms",
      granted: false,
      source: "customer_request",
      changedBy: "آزمون",
    });

    const events = await crm.listConsentEvents(biz.id, { limit: 50 });
    expect(events).toHaveLength(3);
    expect(events[0].granted).toBe(false);
    expect(events[0].source).toBe("customer_request");
    // The earlier grant is still there, unmodified.
    expect(events.filter((row) => row.granted)).toHaveLength(2);

    const coverage = await crm.consentCoverage(biz.id);
    // One person still permits SMS…
    expect(coverage.smsGranted).toBe(1);
    // …but has no number, so nothing can actually be sent. Reporting only the
    // first number would promise an audience that cannot be delivered to.
    expect(coverage.smsReachable).toBe(0);
  });
});

describe("segment member counts", () => {
  it("counts the same batched on the list page as one at a time", async () => {
    // The list page evaluates every segment in a single pass over the customer
    // base, instead of re-scanning the whole order history once per segment.
    // That is an execution-strategy change, so the only thing that matters is
    // that it did not become a *semantics* change: each segment must still get
    // exactly the count it gets on its own.
    const quiet = await makeCustomer(biz.id, "کم‌خرید", { phone: "+989120000101" });
    const busy = await makeCustomer(biz.id, "پرخرید", { phone: "+989120000102" });
    await makeSale(biz.locationId, biz.id, quiet, 100_000, 5);
    for (let i = 0; i < 4; i += 1) {
      await makeSale(biz.locationId, biz.id, busy, 300_000, 3 + i);
    }

    const definitions: Record<string, Parameters<typeof segmentsService.previewSegment>[1]> = {
      "همهٔ مشتریان": {},
      "حداقل ۳ خرید": { all: [{ field: "orderCount", op: "gte", value: 3 }] },
      "حداقل ۱ خرید": { all: [{ field: "orderCount", op: "gte", value: 1 }] },
      "پرخرج": { all: [{ field: "totalSpentRial", op: "gte", value: 500_000 }] },
    };

    for (const [name, definition] of Object.entries(definitions)) {
      await segmentsService.createSegment(biz.id, { name, definition: definition! });
    }

    const batched = await segmentsService.listSegmentsWithCounts(biz.id);
    expect(batched.length).toBeGreaterThanOrEqual(Object.keys(definitions).length);

    for (const segment of batched) {
      const alone = await segmentsService.countSegment(biz.id, segment.id);
      expect(
        segment.memberCount,
        `«${segment.name}» counted ${segment.memberCount} on the list page but ${alone} on its own`,
      ).toBe(alone);
    }

    // And the counts are real, not uniformly zero — a batched query that
    // returned nothing at all would otherwise satisfy the equality above.
    const atLeastOne = batched.find((segment) => segment.name === "حداقل ۱ خرید");
    expect(atLeastOne?.memberCount).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("survives one unparsable definition without losing the other counts", async () => {
    // A definition stored by an older version can reference a field that no
    // longer exists. That segment must degrade to an unknown count on its own,
    // not take the list page — or the other segments' counts — down with it.
    const buyer = await makeCustomer(biz.id, "خریدار سالم", { phone: "+989120000103" });
    await makeSale(biz.locationId, biz.id, buyer, 150_000, 2);

    const healthy = await segmentsService.createSegment(biz.id, {
      name: "سالم",
      definition: { all: [{ field: "orderCount", op: "gte", value: 1 }] },
    });
    const broken = await segmentsService.createSegment(biz.id, {
      name: "خراب",
      definition: { all: [{ field: "orderCount", op: "gte", value: 1 }] },
    });
    // Write the unparsable definition straight to the column, because the
    // service's validation exists precisely to stop this being creatable now.
    await db.query(
      `UPDATE customer_segments
          SET definition = '{"all":[{"field":"fieldThatWasRemoved","op":"gte","value":1}]}'::jsonb
        WHERE business_id = $1 AND id = $2`,
      [biz.id, broken!.id],
    );

    const counts = await segmentsService.listSegmentsWithCounts(biz.id);
    const healthyRow = counts.find((segment) => segment.id === healthy!.id);
    const brokenRow = counts.find((segment) => segment.id === broken!.id);

    expect(brokenRow?.memberCount).toBe(0);
    expect(healthyRow?.memberCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("tenant isolation", () => {
  it("keeps one business's CRM entirely invisible to another", async () => {
    const mine = await makeCustomer(biz.id, "مشتری من");
    const theirs = await makeCustomer(other.id, "مشتری رقیب");

    await crm.addCustomerNote(biz.id, mine, { body: "یادداشت محرمانه", createdBy: "من" });
    await crm.upsertDeal(biz.id, { title: "قرارداد بزرگ", customerId: mine, valueRial: 9_000_000 });
    await crm.upsertCase(biz.id, { subject: "شکایت", customerId: mine });
    await crm.createActivity(biz.id, { kind: "call", subject: "تماس پیگیری", customerId: mine });

    // The rival business sees none of it, through the service layer…
    expect(await crm.listCustomerNotes(other.id, mine)).toEqual([]);
    expect(await crm.listDeals(other.id)).toEqual([]);
    expect(await crm.listCases(other.id)).toEqual([]);
    expect(await crm.listActivities(other.id)).toEqual([]);
    expect(await crm.getCustomerFile(other.id, mine)).toBeNull();

    // …and cannot reach my customer by id from their own side either.
    expect(await crm.getCustomerFile(biz.id, theirs)).toBeNull();

    // Nor can a duplicate scan or a merge cross the boundary.
    expect(await crm.previewMerge(other.id, theirs, mine)).toBeNull();
    expect(await crm.mergeCustomers(other.id, theirs, mine)).toBeNull();

    // My own side still sees everything, so the isolation is real rather than
    // a query that returns nothing for everyone.
    expect(await crm.listCustomerNotes(biz.id, mine)).toHaveLength(1);
    expect(await crm.listDeals(biz.id)).toHaveLength(1);
  });
});

describe("the customer timeline", () => {
  it("maps the sources that exist rather than copying events into a table", async () => {
    const customer = await makeCustomer(biz.id, "بهرام", { phone: "+989125556677" });
    await makeSale(biz.locationId, biz.id, customer, 750_000, 1);
    await crm.addCustomerNote(biz.id, customer, { body: "از کیفیت راضی بود", createdBy: "من" });
    await crm.setConsent(biz.id, customer, {
      channel: "sms",
      granted: true,
      source: "staff",
      changedBy: "من",
    });

    const events = await timelineService.customerTimeline(biz.id, customer, { limit: 50 });
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("order");
    expect(kinds).toContain("note");
    expect(kinds).toContain("consent");

    // Newest first, always — the file is read top-down.
    const times = events.map((event) => new Date(event.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // The order event carries the money, and it is the sale's real total.
    // `amount` is pre-formatted at the service edge — Rial for arithmetic,
    // Toman with Persian digits for display — so no screen has to re-derive the
    // currency conversion and none of them can disagree about it.
    expect(events.find((event) => event.kind === "order")?.amount).toMatchObject({
      rial: 750_000,
      toman: 75_000,
    });

    // A kind filter narrows it without changing the ordering rule.
    const onlyOrders = await timelineService.customerTimeline(biz.id, customer, { kinds: ["order"] });
    expect(onlyOrders.every((event) => event.kind === "order")).toBe(true);
  });
});

describe("cross-app bridges", () => {
  /**
   * Phase 36d — the accounting bridge.
   *
   * The CRM shows a customer's outstanding balance and lets a segment target
   * (or exclude) debtors. Both numbers are reconstructed from the A/R control
   * account, and there are now *three* independent readers of that ledger:
   * `ar-service` (accounting's own), `getCustomerFile` (the CRM's 360 view) and
   * the segment compiler's `ar_stats` CTE. If any two of them ever disagree,
   * one of the app's screens is lying about a debt and the owner has no way to
   * tell which. So the test asserts they are equal, not merely plausible.
   */
  it("agrees with the ledger about who owes money, on every surface that reports it", async () => {
    const debtor = await makeCustomer(biz.id, "بدهکار", {
      phone: "+989120000010",
      smsConsent: true,
    });
    const settled = await makeCustomer(biz.id, "تسویه‌شده", {
      phone: "+989120000011",
      smsConsent: true,
    });

    // A credit sale: revenue earned, cash not received. This is what makes a
    // debtor — not an unpaid order flag, but a debit sitting in A/R.
    const closedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, customer_id, status, subtotal, total, closed_at, order_number)
       VALUES ($1, $2, 'completed', $3, $3, $4, $5) RETURNING id`,
      [biz.locationId, debtor, 3_000_000, closedAt, 77_001],
    );
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
       VALUES ($1, $2, $3::date, 'credit sale', 'order', $4) RETURNING id`,
      [biz.id, biz.locationId, closedAt.slice(0, 10), order.rows[0].id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 3000000, 0), ($1, $3, 0, 3000000)`,
      [entry.rows[0].id, acct.receivable, acct.revenue],
    );

    // A cash sale for the other customer: same revenue, nothing in A/R.
    await makeSale(biz.locationId, biz.id, settled, 1_000_000, 2);

    await dbLib.withTenant(biz.id, async () => {
      const arService = await import("../src/lib/ar-service");
      const balances = await arService.listCustomerBalances(biz.id);
      const fromLedger = balances.find((b) => b.customerId === debtor)?.balance ?? 0;
      expect(fromLedger).toBe(3_000_000);

      // Reader 2: the customer file.
      const debtorFile = await crm.getCustomerFile(biz.id, debtor);
      expect(debtorFile?.accounting.receivableRial).toBe(fromLedger);
      expect(debtorFile?.accounting.hasLedger).toBe(true);

      // A cash customer owes nothing — and that is different from having no
      // ledger at all, which is why hasLedger is a separate flag.
      const settledFile = await crm.getCustomerFile(biz.id, settled);
      expect(settledFile?.accounting.receivableRial).toBe(0);

      // Reader 3: the segment compiler, through its own CTE.
      const owing = await segmentsService.resolveDefinition(
        biz.id,
        { all: [{ field: "receivableRial", op: "gte", value: 1_000_000 }] },
        { purpose: "view" },
      );
      expect(owing.map((m) => m.id)).toEqual([debtor]);

      // The inverse — "everyone who does not owe us" — is the rule that keeps a
      // discount campaign away from people with an unpaid invoice.
      const clear = await segmentsService.resolveDefinition(
        biz.id,
        { all: [{ field: "receivableRial", op: "lte", value: 0 }] },
        { purpose: "view" },
      );
      expect(clear.map((m) => m.id)).toContain(settled);
      expect(clear.map((m) => m.id)).not.toContain(debtor);
    });
  });

  /**
   * Phase 36d — the Growth bridge. A campaign audience must never include
   * somebody who refused the channel, and the caller must be told how many were
   * dropped, because a silently smaller number is indistinguishable from a bug.
   */
  it("hands Growth an audience with consent already applied, and says how many it removed", async () => {
    const willing = await makeCustomer(biz.id, "موافق", {
      phone: "+989120000020",
      smsConsent: true,
    });
    await makeCustomer(biz.id, "مخالف", {
      phone: "+989120000021",
      smsConsent: false,
    });

    await dbLib.withTenant(biz.id, async () => {
      const bridge = await import("../src/lib/campaign-audience");
      // An empty document means "everyone" by design, which makes it the
      // sharpest test of the consent filter: nothing else is narrowing.
      const audience = await bridge.audienceForDefinition(biz.id, {}, "sms");

      expect(audience.matched).toBeGreaterThanOrEqual(2);
      expect(audience.members.map((m) => m.id)).toContain(willing);
      expect(audience.members.every((m) => m.smsConsent)).toBe(true);
      expect(audience.excludedByConsent).toBe(audience.matched - audience.reachable);
      expect(audience.excludedByConsent).toBeGreaterThan(0);
    });
  });
});

/**
 * The task list's filter, against a real database.
 *
 * The screen used to narrow `q` in the browser over the rows it had already
 * loaded and hardcode `open`/`mine`/`due` from five preset buttons, so a saved
 * view could carry keys nothing read. This block runs the *route's* own path —
 * parse with the screen's module, derive the date bounds from the business day,
 * hand the result to `listActivities` — and asks whether each key really
 * narrows.
 */
describe("the task list's filter", () => {
  /** A business of its own: the file's shared one holds other tests' rows. */
  async function ownBusiness(prefix: string) {
    const created = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug, industry)
       VALUES ('کارهای تست', $1, 'food_service') RETURNING id`,
      [`${prefix}-${randomUUID().slice(0, 8)}`],
    );
    const location = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
      [created.rows[0].id],
    );
    return { businessId: created.rows[0].id, locationId: location.rows[0].id };
  }

  async function makeMember(businessId: string, name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, email, password_hash)
       VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
      [businessId, name, `tasks-${randomUUID().slice(0, 8)}@example.test`],
    );
    return rows[0].id;
  }

  it("narrows on every key, and judges the states against the business day", async () => {
    const own = await ownBusiness("ros-task-views");
    const viewerId = await makeMember(own.businessId, "زهرا کریمی");
    const customerId = await makeCustomer(own.businessId, "مشتری پیگیری‌ها");

    // The shop's own today, which is what the route bounds the states by.
    businessDay = await import("../src/lib/business-day-service");
    const today = await businessDay.businessToday(own.businessId);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);

    const make = async (input: Parameters<typeof crm.createActivity>[1]) =>
      crm.createActivity(own.businessId, { createdBy: "مدیر", ...input });

    const overdueCall = await make({
      kind: "call",
      subject: "تماس عقب‌افتاده",
      body: "دربارهٔ یخچال",
      dueAt: `${yesterday}T09:00:00Z`,
      assigneeUserId: viewerId,
      customerId,
    });
    const dueToday = await make({
      kind: "call",
      subject: "تماس امروز",
      dueAt: `${today}T09:00:00Z`,
    });
    const planned = await make({
      kind: "visit",
      subject: "مراجعهٔ هفتهٔ بعد",
      dueAt: `${tomorrow}T09:00:00Z`,
      customerId,
    });
    const noDueDate = await make({ kind: "note", subject: "یادداشت بدون تاریخ" });
    const done = await make({ kind: "task", subject: "کار انجام‌شده", completed: true });
    // Two calls that were made — one late, one on time. Finished work is
    // «انجام‌شده» however old its due date is (`activityState` answers that
    // before it looks at the date at all), so neither may appear under
    // «عقب‌افتاده» or «امروز». The queues agree: their SQL has always required
    // `completed_at IS NULL`, and a «دیدن همه» link that listed them would show
    // rows the card above it did not count.
    const doneLate = await make({
      kind: "call",
      subject: "تماس دیروزِ انجام‌شده",
      dueAt: `${yesterday}T09:00:00Z`,
      completed: true,
    });
    const doneToday = await make({
      kind: "call",
      subject: "تماس امروزِ انجام‌شده",
      dueAt: `${today}T09:00:00Z`,
      completed: true,
    });

    // The route's own translation, called rather than re-written: the same
    // function the API route uses turns the parsed document into the query, so
    // this block tests the translation the app ships instead of a copy of it.
    const run = async (query: Record<string, string>) => {
      const parsed = parseActivityViewFilters({ get: (key) => query[key] ?? null });
      expect(parsed.error).toBeNull();
      const options = activityViewListOptions(parsed.filters, { viewerId, today });
      const rows = await crm.listActivities(own.businessId, options);
      return rows.map((row) => row.id).sort();
    };
    const sorted = (...ids: string[]) => [...ids].sort();

    // Every key on its own.
    expect(await run({ q: "عقب‌افتاده" })).toEqual(sorted(overdueCall.id));
    // The body is searched, too — people type what the task is about.
    expect(await run({ q: "یخچال" })).toEqual(sorted(overdueCall.id));
    // …and so is the customer's name, which is how a shop looks for «what did
    // we promise this person».
    expect(await run({ q: "مشتری پیگیری‌ها" })).toEqual(sorted(overdueCall.id, planned.id));
    expect(await run({ kind: "call" })).toEqual(
      sorted(overdueCall.id, dueToday.id, doneLate.id, doneToday.id),
    );
    expect(await run({ kind: "note" })).toEqual(sorted(noDueDate.id));
    expect(await run({ assignee: "mine" })).toEqual(sorted(overdueCall.id));
    expect(await run({ assignee: "none" })).toEqual(
      sorted(dueToday.id, planned.id, noDueDate.id, done.id, doneLate.id, doneToday.id),
    );
    expect(await run({ assignee: viewerId })).toEqual(sorted(overdueCall.id));

    // The states. `due` is «today or already late» — the label the screen has
    // always used — while `overdue` is strictly before the shop's today, and
    // `planned` is a due date still in the future. None of the three can be
    // answered from the browser's clock: a business day that starts at 18:00
    // would put «امروز» on a different date here.
    expect(await run({ state: "open" })).toEqual(
      sorted(overdueCall.id, dueToday.id, planned.id, noDueDate.id),
    );
    expect(await run({ state: "done" })).toEqual(sorted(done.id, doneLate.id, doneToday.id));
    expect(await run({ state: "due" })).toEqual(sorted(overdueCall.id, dueToday.id));
    // The two that were finished are absent from both: the date-bounded states
    // are the row badges' words, and a badge calls them «انجام‌شده».
    expect(await run({ state: "overdue" })).toEqual(sorted(overdueCall.id));
    expect(await run({ state: "today" })).toEqual(sorted(dueToday.id));
    expect(await run({ state: "planned" })).toEqual(sorted(planned.id));

    // The legacy key, read for links and views already in the wild.
    expect(await run({ due: "1" })).toEqual(sorted(overdueCall.id, dueToday.id));

    // And the keys compose, which is what a saved view is.
    expect(
      await run({ kind: "call", state: "overdue", assignee: "mine" }),
    ).toEqual(sorted(overdueCall.id));
    expect(await run({ kind: "visit", state: "overdue" })).toEqual([]);
  });

  it("round-trips a view saved through the service into the request the list sends", async () => {
    const business = await ownBusiness("ros-task-view-save");
    views = await import("../src/lib/crm-saved-views-service");

    const saved = await views.saveView(
      business.businessId,
      {
        entity: "activities",
        name: "تماس‌های عقب‌افتادهٔ من",
        filters: { kind: "call", state: "overdue", assignee: "mine" },
        shared: true,
      },
      { name: "مدیر", userId: null },
    );
    expect(saved.ok).toBe(true);
    const document = saved.ok ? saved.view.filters : {};

    // The screen serialises the stored document into a query and the server
    // parses that query with the same module: one interpretation.
    const query = activityViewQuery({
      q: "",
      kind: document.kind,
      state: document.state,
      assignee: document.assignee,
    });
    expect(query).toEqual({ kind: "call", state: "overdue", assignee: "mine" });
    expect(parseActivityViewFilters({ get: (key) => query[key] ?? null }).filters).toEqual({
      q: "",
      kind: "call",
      state: "overdue",
      assignee: "mine",
    });

    // A key the vocabulary does not carry is dropped rather than stored — the
    // preset buttons' own `mine`/`open` are exactly that case.
    const legacy = await views.saveView(
      business.businessId,
      {
        entity: "activities",
        name: "با کلیدهای قدیمی",
        filters: { mine: "1", open: "1", kind: "call" },
        shared: true,
      },
      { name: "مدیر", userId: null },
    );
    expect(legacy.ok && legacy.view.filters).toEqual({ kind: "call" });

    // A *new* state joins the vocabulary without a migration: «امروز» is the
    // word the row badge and the «کارهای امروز» queue already use, so a view may
    // store it. This is the same key the wave-13 witness used as its example of
    // an impossible value.
    const todayView = await views.saveView(
      business.businessId,
      {
        entity: "activities",
        name: "کارهای امروز",
        filters: { state: "today" },
        shared: true,
      },
      { name: "مدیر", userId: null },
    );
    expect(todayView.ok).toBe(true);
    expect(todayView.ok && todayView.view.filters).toEqual({ state: "today" });

    // An impossible value inside the vocabulary is refused *and named*, so the
    // screen can point at the control instead of showing a mystery.
    const bad = await views.saveView(
      business.businessId,
      {
        entity: "activities",
        name: "با وضعیت نامعتبر",
        filters: { state: "paused" },
        shared: true,
      },
      { name: "مدیر", userId: null },
    );
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toBe("invalid_filters");
    expect(bad.ok === false && bad.field).toBe("state");
  });
});
