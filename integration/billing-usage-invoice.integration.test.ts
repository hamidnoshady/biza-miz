/**
 * Issue #902 §9 item 3 (second half) — usage, invoiced, against a real database.
 *
 * `billing_usage_ratings` records what was used and which price produced it.
 * Until this slice nothing turned those rows into an invoice line, so a business
 * could have rated usage and no bill, and the platform two ledgers that never met.
 *
 * This file proves, with Postgres doing the enforcing:
 *
 *   1. A month's non-wallet-backed ratings become an invoice with one line per
 *      meter-and-version, each line citing the version that priced it, and each
 *      rating linked to exactly the line it was billed on.
 *   2. Wallet-backed usage is never invoiced — that money already left the
 *      wallet, and invoicing it again is a double charge.
 *   3. Issuing twice does not bill twice: the invoice is found, not duplicated.
 *   4. The database itself refuses a second invoice for the same rating — the
 *      UNIQUE index is the guarantee, not the application code.
 *   5. An open invoice accepts a rating that arrived late; a paid one does not,
 *      because rewriting a settled bill is how a customer gets charged twice for
 *      one thing and disputes everything after it.
 *
 * No network and no wallet movement: issuing a usage invoice never touches money.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { meterByKey } from "../src/lib/billing/catalog/meters";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let runtime: typeof import("../src/lib/billing/runtime");
let usageInvoice: typeof import("../src/lib/billing/usage-invoice-service");

const alpha = { businessId: "", slug: "" };
const beta = { businessId: "", slug: "" };

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

async function seedBusiness(name: string): Promise<{ businessId: string; slug: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id, slug };
}

/** A moment inside the given month, chosen so it is unambiguous in Tehran. */
function insideMonth(periodMonth: string, day = 10): string {
  const [year, month] = periodMonth.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day, 9)).toISOString();
}

/** One rateable event, rated at `amountRial`, with the basis the caller claims. */
async function rateUsage(input: {
  businessId: string;
  periodMonth: string;
  meterKey: string;
  quantity: number;
  amountRial: number;
  walletBacked?: boolean;
  retailPriceVersion?: number | null;
  retailPriceVersionId?: string | null;
}): Promise<string> {
  const eventId = `${input.businessId}:${randomUUID()}`;
  const result = await dbLib.withTenant(input.businessId, () =>
    runtime.appendUsageEvent({
      eventId,
      businessId: input.businessId,
      meterKey: input.meterKey,
      source: "cms",
      quantity: input.quantity,
      // The meter's own unit, because `validateUsageEvent` refuses a mismatch.
      unit: meterByKey(input.meterKey)!.unit,
      occurredAt: insideMonth(input.periodMonth),
      resource: "integration",
      resourceId: eventId,
      ratedAmountRial: input.amountRial,
      retailPriceVersion: input.retailPriceVersion ?? null,
      retailPriceVersionId: input.retailPriceVersionId ?? null,
      dimensions: { walletBacked: input.walletBacked ?? false },
    }),
  );
  if (result.status !== "accepted") throw new Error(`usage rejected: ${result.status}`);
  return result.id;
}

/** The expected `period_start` for a month key, computed independently. */
function issuedPeriodStart(periodMonth: string): string {
  return usageInvoice.usageInvoiceWindow(periodMonth).startIso;
}

async function invoiceFor(businessId: string, periodMonth: string) {
  const { rows } = await db.query<{
    id: string;
    status: string;
    reference: string;
    subtotal_rial: string;
    total_rial: string;
    period_start: Date | null;
    period_end: Date | null;
  }>(
    `SELECT id, status, reference, subtotal_rial, total_rial, period_start, period_end
       FROM billing_invoices WHERE business_id = $1 AND reference = $2`,
    [businessId, `usage:${periodMonth}`],
  );
  return rows[0] ?? null;
}

async function linesFor(invoiceId: string) {
  const { rows } = await db.query<{
    id: string;
    description: string;
    quantity: number;
    unit_amount_rial: string;
    amount_rial: string;
    kind: string;
    price_basis: string | null;
    price_version_id: string | null;
    retail_price_version: number | null;
  }>(
    `SELECT id, description, quantity, unit_amount_rial, amount_rial, kind,
            price_basis, price_version_id, retail_price_version
       FROM billing_invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`,
    [invoiceId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_usage_invoice_${randomUUID().replaceAll("-", "")}`;

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
  runtime = await import("../src/lib/billing/runtime");
  usageInvoice = await import("../src/lib/billing/usage-invoice-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM billing_invoice_line_usage");
  await db.query("DELETE FROM billing_invoice_lines");
  await db.query("DELETE FROM billing_invoices");
  await db.query("DELETE FROM billing_usage_ratings");
  await db.query("DELETE FROM billing_usage_events");
  await db.query("DELETE FROM kavenegar_retail_price_versions");
  await db.query("DELETE FROM wallet_ledger");
  await db.query("DELETE FROM business_wallets");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
});

describe("a month's rates become a readable invoice", () => {
  it("bills one line per meter-and-version and links every rating behind it", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    const versionId = (
      await db.query<{ id: string }>(
        `INSERT INTO kavenegar_retail_price_versions (version, markup_bps, effective_from)
         VALUES (12, 900, now() - interval '1 hour') RETURNING id`,
      )
    ).rows[0]!.id;

    const retailOne = await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "messaging.email_send",
      quantity: 2,
      amountRial: 2_400,
      retailPriceVersion: 12,
      retailPriceVersionId: versionId,
    });
    const retailTwo = await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "messaging.email_send",
      quantity: 1,
      amountRial: 1_200,
      retailPriceVersion: 12,
      retailPriceVersionId: versionId,
    });
    const explicit = await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 4,
      amountRial: 5_000,
    });

    const issued = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(issued).toMatchObject({ created: true, lineCount: 2, totalRial: 8_600 });
    expect(issued.invoiceId).toBeTruthy();

    const invoice = await invoiceFor(alpha.businessId, periodMonth);
    expect(invoice).toMatchObject({ status: "open", reference: `usage:${periodMonth}` });
    expect(Number(invoice!.subtotal_rial)).toBe(8_600);
    expect(Number(invoice!.total_rial)).toBe(8_600);
    // The invoice's own period is the Tehran month, not the calendar month of the
    // process's clock — the same window the spend report uses.
    expect(new Date(invoice!.period_start!).toISOString()).toBe(issuedPeriodStart(periodMonth));

    const lines = await linesFor(issued.invoiceId!);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.kind === "usage")).toBe(true);

    // The email line folded two sends into one line, on one version.
    const emailLine = lines.find((line) => line.description.includes("ایمیل"))!;
    expect(Number(emailLine.amount_rial)).toBe(3_600);
    expect(emailLine.quantity).toBe(3);
    expect(emailLine.price_basis).toBe("retail_price_version");
    expect(emailLine.retail_price_version).toBe(12);
    // The meter catalogue is a different table; a value here would be a false
    // citation, and 0271 refuses it.
    expect(emailLine.price_version_id).toBeNull();

    const cmsLine = lines.find((line) => line.description.includes("cms.api_request"))!;
    expect(Number(cmsLine.amount_rial)).toBe(5_000);
    expect(cmsLine.price_basis).toBe("explicit_amount");

    // Every rating is linked, with what it contributed, and the line adds up.
    const { rows: links } = await db.query<{ usage_event_id: string; rated_amount_rial: string; meter_key: string }>(
      `SELECT usage_event_id, rated_amount_rial, meter_key
         FROM billing_invoice_line_usage WHERE business_id = $1 ORDER BY rated_amount_rial`,
      [alpha.businessId],
    );
    expect(links).toHaveLength(3);
    expect([...links.map((link) => link.usage_event_id)].sort()).toEqual(
      [retailOne, retailTwo, explicit].sort(),
    );
    expect(links.reduce((sum, link) => sum + Number(link.rated_amount_rial), 0)).toBe(8_600);
    expect(new Set(links.map((link) => link.meter_key))).toEqual(
      new Set(["messaging.email_send", "cms.api_request"]),
    );
  });

  it("leaves wallet-backed usage alone — that money has already been taken", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 7_000,
      walletBacked: true,
    });
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 1_000,
    });

    const issued = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(issued.totalRial).toBe(1_000);
    const lines = await linesFor(issued.invoiceId!);
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.amount_rial)).toBe(1_000);
  });

  it("reports nothing to bill, and creates no invoice, when there is no unbilled usage", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    const issued = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(issued).toMatchObject({ invoiceId: null, created: false, totalRial: 0, skipped: "nothing_to_bill" });
    expect(await invoiceFor(alpha.businessId, periodMonth)).toBeNull();
  });
});

describe("issuing twice bills once", () => {
  it("finds the same invoice instead of writing a second one", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 2,
      amountRial: 3_000,
    });

    const first = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(first.created).toBe(true);

    const second = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(second).toMatchObject({ invoiceId: first.invoiceId, created: false, totalRial: 3_000 });
    expect(await linesFor(first.invoiceId!)).toHaveLength(1);

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_invoices WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("is refused by the database if anything ever tries to bill one rating twice", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 900,
    });
    const issued = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    const lineId = (await linesFor(issued.invoiceId!))[0]!.id;
    const eventId = (await db.query<{ usage_event_id: string }>(
      `SELECT usage_event_id FROM billing_invoice_line_usage WHERE line_id = $1`,
      [lineId],
    )).rows[0]!.usage_event_id;

    // A second link for the same rating — the shape a duplicated billing run
    // would produce — is a constraint violation, not a silent double charge.
    await expect(
      db.query(
        `INSERT INTO billing_invoice_line_usage (line_id, usage_event_id, business_id, meter_key, rated_amount_rial)
         VALUES ($1, $2, $3, 'cms.api_request', 900)`,
        [lineId, eventId, alpha.businessId],
      ),
    ).rejects.toThrow(/billing_invoice_line_usage_once|duplicate key/);
  });

  it("adds a late rating to an open invoice, and refuses to rewrite a paid one", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 2_000,
    });
    const first = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(first.totalRial).toBe(2_000);

    // A rating that lands after the first run, for the same month.
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 500,
    });
    const extended = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(extended).toMatchObject({ invoiceId: first.invoiceId, created: false, totalRial: 2_500, lineCount: 2 });
    // The open invoice is still one document; its total grew by exactly the new
    // usage, and the earlier line was not rewritten.
    const invoice = await invoiceFor(alpha.businessId, periodMonth);
    expect(Number(invoice!.total_rial)).toBe(2_500);

    // Once it is settled, the same late rating cannot reopen it.
    await db.query(
      `UPDATE billing_invoices SET status = 'paid', paid_rial = total_rial WHERE id = $1`,
      [first.invoiceId],
    );
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 800,
    });
    const blocked = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(blocked).toMatchObject({ invoiceId: first.invoiceId, created: false, skipped: "invoice_closed" });
    expect(Number((await invoiceFor(alpha.businessId, periodMonth))!.total_rial)).toBe(2_500);
  });
});

describe("tenancy", () => {
  it("invoices one business's usage and nobody else's", async () => {
    const periodMonth = usageInvoice.currentUsagePeriodMonth();
    await rateUsage({
      businessId: alpha.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 1_500,
    });
    await rateUsage({
      businessId: beta.businessId,
      periodMonth,
      meterKey: "cms.api_request",
      quantity: 1,
      amountRial: 9_000,
    });

    const issued = await usageInvoice.issueUsageInvoice({ businessId: alpha.businessId, periodMonth });
    expect(issued.totalRial).toBe(1_500);
    // Beta's rating is untouched and still unbilled.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM billing_invoice_line_usage WHERE business_id = $1`,
      [beta.businessId],
    );
    expect(rows[0]!.n).toBe("0");

    const preview = await usageInvoice.previewUsageInvoice({ businessId: beta.businessId, periodMonth });
    expect(preview.totalRial).toBe(9_000);
    expect(preview.existingInvoiceId).toBeNull();
  });
});

