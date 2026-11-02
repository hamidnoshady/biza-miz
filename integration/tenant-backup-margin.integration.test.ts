/**
 * Issue #903 §3/§8 — the margin report against a real database.
 *
 * The pure arithmetic (`computeBackupMargin`) is covered by unit tests, and the
 * route by its own. What neither can prove is the **query**: which table holds a
 * quantity, where the money actually lives, and whether an event that was never
 * rated is distinguishable from one rated at zero. That distinction is the whole
 * honesty of the report — "not priced" must never read as "pure profit" — and it
 * only exists in SQL.
 *
 * The shape asserted here is the billing runtime's: `billing_usage_events` is
 * append-only and carries `quantity`, while `billing_usage_ratings` holds one
 * `rated_amount_rial` per event. A business is billed through the rating, not
 * through the event, so a report that sums an `amount` column on the event is
 * reading a column that does not exist — which is exactly what this suite is
 * here to catch.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let owner: Client;
let billing: typeof import("../src/lib/tenant-backup-billing-jobs");

const businessA = { id: "", name: "فروشگاه الف" };
const businessB = { id: "", name: "Store B" };
const businessC = { id: "", name: "Store C" };

const window = { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-10-01T00:00:00.000Z") };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function makeBusiness(name: string, slug: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id",
    [name, `${slug}-${randomUUID().slice(0, 8)}`],
  );
  return rows[0].id;
}

/**
 * One metered event, optionally rated. `ratedRial === null` is the case that
 * matters: the meter recorded usage the platform never priced.
 */
async function meterEvent(
  businessId: string,
  quantity: number,
  occurredAt: string,
  ratedRial: number | null,
): Promise<void> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO billing_usage_events
       (id, event_id, business_id, meter_key, source, quantity, unit, occurred_at)
     VALUES ($1,$2,$3,'backup.storage_byte_day','backup_billing',$4,'byte_day',$5)`,
    [id, id, businessId, quantity, occurredAt],
  );
  if (ratedRial === null) return;
  await owner.query(
    `INSERT INTO billing_usage_ratings (usage_event_id, business_id, rated_amount_rial)
     VALUES ($1,$2,$3)`,
    [id, businessId, ratedRial],
  );
}

beforeAll(async () => {
  databaseName = `pos_backup_margin_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();

  businessA.id = await makeBusiness(businessA.name, "alpha");
  businessB.id = await makeBusiness(businessB.name, "beta");
  businessC.id = await makeBusiness(businessC.name, "gamma");

  // A: one priced event and one the platform never priced — the partly-rated
  // line. B: fully priced. C: never priced at all.
  await meterEvent(businessA.id, 100, "2026-09-05T00:00:00.000Z", 5_000);
  await meterEvent(businessA.id, 250, "2026-09-06T00:00:00.000Z", null);
  await meterEvent(businessB.id, 40, "2026-09-07T00:00:00.000Z", 900);
  await meterEvent(businessC.id, 70, "2026-09-08T00:00:00.000Z", null);
  // Outside the window: must not appear anywhere in the report.
  await meterEvent(businessA.id, 9_999, "2026-10-02T00:00:00.000Z", 777_777);

  // The report runs under a documented platform bypass, so the pool is the
  // install's own connection — the same one the console route uses.
  process.env.DATABASE_URL = urlFor(databaseName);
  billing = await import("../src/lib/tenant-backup-billing-jobs");
}, 240_000);

afterAll(async () => {
  await owner?.end().catch(() => undefined);
  process.env.DATABASE_URL = rootDatabaseUrl;
});

describe("backupMarginReport", () => {
  it("reads quantity from the event and money from the rating", async () => {
    const report = await billing.backupMarginReport({ ...window, providerCostRialPerGbMonth: 0 });
    const a = report.lines.find((line) => line.businessId === businessA.id);
    expect(a).toBeTruthy();
    // 100 priced + 250 unpriced byte-days, and only the rated 5 000 Rial.
    expect(a!.byteDays).toBe(350);
    expect(a!.revenueRial).toBe(5_000);
    expect(a!.businessName).toBe(businessA.name);
  });

  it("states how much of a partly rated line the revenue does not cover", async () => {
    const report = await billing.backupMarginReport({ ...window, providerCostRialPerGbMonth: 0 });
    const a = report.lines.find((line) => line.businessId === businessA.id)!;
    // It has revenue, so it is not "not priced" — but it is not complete either.
    expect(a.notPriced).toBe(false);
    expect(a.unpricedByteDays).toBe(250);
    const b = report.lines.find((line) => line.businessId === businessB.id)!;
    expect(b.unpricedByteDays).toBe(0);
  });

  it("marks a business the platform never priced instead of counting it as pure margin", async () => {
    const report = await billing.backupMarginReport({ ...window, providerCostRialPerGbMonth: 0 });
    const c = report.lines.find((line) => line.businessId === businessC.id)!;
    // `notPriced` is the flag that carries the meaning; the reported revenue is
    // zero because nothing was billed, and a screen that printed only the number
    // would read it as "free" rather than "unknown".
    expect(c.notPriced).toBe(true);
    expect(c.revenueRial).toBe(0);
    expect(c.marginPercent).toBeNull();
    expect(c.unpricedByteDays).toBe(70);
    expect(report.assumptions.priced).toBe(false);
  });

  it("stays inside the window it was given", async () => {
    const report = await billing.backupMarginReport({ ...window, providerCostRialPerGbMonth: 0 });
    // The 9 999-byte-day event on 2 October is outside September: if it leaked in,
    // the quantity and the revenue would both jump.
    const a = report.lines.find((line) => line.businessId === businessA.id)!;
    expect(a.byteDays).toBe(350);
    expect(report.totals.byteDays).toBe(460);
    expect(report.totals.revenueRial).toBe(5_900);
  });

  it("carries the stated provider cost into the assumption it reports", async () => {
    // The cost is an assumption the caller states, never a stored constant: the
    // report must echo exactly what it was given so the screen can label it.
    const report = await billing.backupMarginReport({ ...window, providerCostRialPerGbMonth: 300_000 });
    expect(report.assumptions.providerCostRialPerGbMonth).toBe(300_000);
    expect(report.totals.costRial).toBe(0);
  });
});
