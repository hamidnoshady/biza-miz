/**
 * Issue #764 — the Growth-wide settings are read by real reports.
 *
 * 1. The attribution window bounds which sales a message campaign's ROI
 *    counts: a sale using the campaign's promotion 35 days after launch is
 *    in with no window and out with a 30-day one — whether the window is
 *    passed explicitly or read from the business's saved settings.
 * 2. A business that never saved settings reads the code defaults (no
 *    window, no budget), so nothing changes for it.
 * 3. The 30-day discount budget reaches the Growth dashboard.
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
let settingsService: typeof import("../src/lib/growth-settings-service");
let campaigns: typeof import("../src/lib/message-campaigns-service");
let growthOverview: typeof import("../src/lib/growth-overview")["growthOverview"];

const biz = { id: "", locationId: "", userId: "" };

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
  databaseName = `pos_growth_settings_${randomUUID().replaceAll("-", "")}`;
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
  settingsService = await import("../src/lib/growth-settings-service");
  campaigns = await import("../src/lib/message-campaigns-service");
  growthOverview = (await import("../src/lib/growth-overview")).growthOverview;

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
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Growth Settings Co', $1, 'accessories') RETURNING id",
    [`gs-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = loc.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, email, full_name, role, password_hash)
     VALUES ($1, $2, 'Owner', 'owner', 'x') RETURNING id`,
    [biz.id, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  biz.userId = user.rows[0].id;
});

/** A message campaign started 40 days ago, owning one dedicated promotion. */
async function campaignWithTwoSales() {
  const promo = await db.query<{ id: string }>(
    `INSERT INTO promotions (business_id, name, kind, value) VALUES ($1, 'SMS-only 10%', 'percent', 10) RETURNING id`,
    [biz.id],
  );
  const campaign = await db.query<{ id: string }>(
    `INSERT INTO message_campaigns (business_id, channel, name, status, promotion_id, started_at, sent_count)
     VALUES ($1, 'sms', 'Come back', 'completed', $2, now() - interval '40 days', 50) RETURNING id`,
    [biz.id, promo.rows[0].id],
  );
  // One sale 5 days after launch, one 35 days after.
  for (const [orderNumber, daysAfterLaunch, total] of [[1, 5, 500_000], [2, 35, 800_000]] as const) {
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, total, opened_at, closed_at)
       VALUES ($1, $2, 'completed', $3, now() - make_interval(days => 40 - $4), now() - make_interval(days => 40 - $4))
       RETURNING id`,
      [biz.locationId, orderNumber, total, daysAfterLaunch],
    );
    await db.query(
      `INSERT INTO promotion_applications (business_id, location_id, promotion_id, source_type, source_id, discount_rial, created_at)
       VALUES ($1, $2, $3, 'order', $4, 10000, now() - make_interval(days => 40 - $5))`,
      [biz.id, biz.locationId, promo.rows[0].id, order.rows[0].id, daysAfterLaunch],
    );
  }
  return campaign.rows[0].id;
}

describe("growth settings", () => {
  it("reads the code defaults for a business that never saved any", async () => {
    const settings = await dbLib.withTenant(biz.id, () => settingsService.getGrowthSettings(biz.id));
    expect(settings).toEqual({ attributionWindowDays: null, discountBudgetRial: null, giftCardValidityMonths: null });
  });

  it("saves a partial update without clearing the other setting", async () => {
    await dbLib.withTenant(biz.id, () =>
      settingsService.updateGrowthSettings(biz.id, { discountBudgetRial: 2_000_000 }, biz.userId),
    );
    const next = await dbLib.withTenant(biz.id, () =>
      settingsService.updateGrowthSettings(biz.id, { attributionWindowDays: 14 }, biz.userId),
    );
    expect(next).toEqual({ attributionWindowDays: 14, discountBudgetRial: 2_000_000, giftCardValidityMonths: null });
  });

  it("bounds message-campaign ROI by the attribution window", async () => {
    const campaignId = await campaignWithTwoSales();
    const row = async (options?: { attributionWindowDays?: number | null }) =>
      (await dbLib.withTenant(biz.id, () => campaigns.listMessageCampaignRoiReport(biz.id, options))).find(
        (r) => r.campaignId === campaignId,
      )!;

    // No window — the previous behaviour — counts both sales.
    expect((await row({ attributionWindowDays: null })).attributableSales).toBe(2);
    expect((await row({ attributionWindowDays: null })).attributableRevenueRial).toBe(1_300_000);
    // A 30-day window keeps only the sale five days after launch.
    expect((await row({ attributionWindowDays: 30 })).attributableSales).toBe(1);
    expect((await row({ attributionWindowDays: 30 })).attributableRevenueRial).toBe(500_000);

    // Without an explicit option the report reads the saved setting.
    expect((await row()).attributableSales).toBe(2);
    await dbLib.withTenant(biz.id, () =>
      settingsService.updateGrowthSettings(biz.id, { attributionWindowDays: 30 }, biz.userId),
    );
    expect((await row()).attributableSales).toBe(1);
  });

  it("puts the discount budget on the Growth dashboard", async () => {
    await dbLib.withTenant(biz.id, () =>
      settingsService.updateGrowthSettings(biz.id, { discountBudgetRial: 3_000_000 }, biz.userId),
    );
    const today = new Date().toISOString().slice(0, 10);
    const overview = await dbLib.withTenant(biz.id, () => growthOverview(biz.id, { locationId: null, today }));
    expect(overview.campaigns.discountBudgetRial).toBe(3_000_000);
  });
});
