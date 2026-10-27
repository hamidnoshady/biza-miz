/**
 * Issue #901, first slice — the campaign builder's storage and dry run.
 *
 * 1. A campaign is created with a validated, hashed first version, and the
 *    creation is audited; an invalid document is refused with its problems.
 * 2. Another business's branch cannot be named, and another business cannot
 *    read the campaign (RLS).
 * 3. A draft is edited in place; a locked version is immutable in the database
 *    itself, so an edit after the lock becomes the next version.
 * 4. The simulation reads real orders and payments — settled net paid, with
 *    refunds netted and the on-account tender left out — and writes nothing:
 *    no journal entry, no domain event.
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
let service: typeof import("../src/lib/campaign-builder-service");

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
  databaseName = `pos_campaign_builder_${randomUUID().replaceAll("-", "")}`;
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
  service = await import("../src/lib/campaign-builder-service");

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

async function createBusiness(label: string) {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'accessories') RETURNING id",
    [`${label} Co`, `cb-${randomUUID().slice(0, 8)}`],
  );
  const id = bizRow.rows[0].id;
  const loc = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [id]);
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, email, full_name, role, password_hash)
     VALUES ($1, $2, 'Owner', 'owner', 'x') RETURNING id`,
    [id, `owner-${randomUUID().slice(0, 8)}@example.com`],
  );
  return { id, locationId: loc.rows[0].id, userId: user.rows[0].id };
}

beforeEach(async () => {
  Object.assign(biz, await createBusiness("Campaign Builder"));
});

function definition(patch: { trigger?: object; reward?: object; limits?: object } = {}) {
  return {
    trigger: { type: "pos_sale_settled", minNetPaidRial: 1_000_000, locationIds: null, ...patch.trigger },
    reward: { type: "cashback", mode: "percent", percentBps: 500, basis: "net_paid", maxPerOrderRial: 100_000, holdDays: 7, ...patch.reward },
    limits: { totalBudgetRial: 1_000_000, perCustomerCapRial: null, ...patch.limits },
  };
}

const asBiz = <T>(fn: () => Promise<T>, businessId = biz.id) => dbLib.withTenant(businessId, fn);

async function party(businessId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles) VALUES ($1, 'Customer', 'customer', ARRAY['customer']::text[]) RETURNING id`,
    [businessId],
  );
  return rows[0].id;
}

let orderSeq = 0;
/** A closed order with its payment rows; `payments` are signed (a refund is negative). */
async function sale(opts: {
  locationId?: string;
  customerId: string | null;
  total: number;
  status?: "completed" | "voided";
  daysAgo?: number;
  payments: Array<{ method: "cash" | "card" | "credit"; amount: number }>;
}): Promise<string> {
  orderSeq += 1;
  const locationId = opts.locationId ?? biz.locationId;
  const order = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, tax, opened_at, closed_at)
     VALUES ($1, $2, $3, $4, $5, 0, now() - make_interval(days => $6), now() - make_interval(days => $6))
     RETURNING id`,
    [locationId, orderSeq, opts.status ?? "completed", opts.customerId, opts.total, opts.daysAgo ?? 1],
  );
  for (const payment of opts.payments) {
    await db.query(`INSERT INTO payments (location_id, order_id, method, amount) VALUES ($1, $2, $3, $4)`, [
      locationId,
      order.rows[0].id,
      payment.method,
      payment.amount,
    ]);
  }
  return order.rows[0].id;
}

describe("creating and reading campaigns", () => {
  it("stores a validated draft with a hashed first version and audits the creation", async () => {
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "  کش‌بک بهار  ", definition: definition() }));
    expect(created).toMatchObject({ name: "کش‌بک بهار", status: "draft", version: { number: 1, locked: false } });
    expect(created.version.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.version.definitionHash).toBe(service.hashCampaignDefinition(created.version.definition));

    const listed = await asBiz(() => service.listCampaigns(biz.id));
    expect(listed.map((c) => c.id)).toEqual([created.id]);

    const audit = await db.query(`SELECT action, user_id FROM audit_log WHERE entity = 'growth_campaign' AND entity_id = $1`, [created.id]);
    expect(audit.rows).toEqual([{ action: "growth.campaign_created", user_id: biz.userId }]);
  });

  it("refuses an invalid document with its problems and stores nothing", async () => {
    await expect(
      asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "x", definition: definition({ limits: { totalBudgetRial: 0 } }) })),
    ).rejects.toMatchObject({ code: "campaign_definition_invalid", status: 400, problems: [{ path: "limits.totalBudgetRial" }] });
    await expect(asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "   ", definition: definition() }))).rejects.toMatchObject({
      code: "campaign_name_invalid",
    });
    expect(await asBiz(() => service.listCampaigns(biz.id))).toEqual([]);
  });

  it("only accepts this business's own branches", async () => {
    const other = await createBusiness("Other");
    const own = await asBiz(() =>
      service.createCampaign(biz.id, biz.userId, { name: "own", definition: definition({ trigger: { locationIds: [biz.locationId] } }) }),
    );
    expect(own.version.definition.trigger.locationIds).toEqual([biz.locationId]);

    await expect(
      asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "x", definition: definition({ trigger: { locationIds: [other.locationId] } }) })),
    ).rejects.toMatchObject({ code: "branch_not_found" });
    await expect(
      asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "x", definition: definition({ trigger: { locationIds: ["not-a-uuid"] } }) })),
    ).rejects.toMatchObject({ code: "branch_not_found" });
  });

  it("hides a campaign from another business", async () => {
    const other = await createBusiness("Other");
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "mine", definition: definition() }));
    expect(await asBiz(() => service.getCampaign(other.id, created.id), other.id)).toBeNull();
    expect(await asBiz(() => service.listCampaigns(other.id), other.id)).toEqual([]);
    await expect(asBiz(() => service.saveCampaignDraft(other.id, other.userId, created.id, { name: "taken" }), other.id)).rejects.toMatchObject({
      code: "campaign_not_found",
    });
  });
});

describe("editing a draft", () => {
  it("edits the unlocked version in place and keeps unnamed fields", async () => {
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "a", definition: definition() }));
    const renamed = await asBiz(() => service.saveCampaignDraft(biz.id, biz.userId, created.id, { name: "b" }));
    expect(renamed.name).toBe("b");
    expect(renamed.version.definitionHash).toBe(created.version.definitionHash);

    const changed = await asBiz(() =>
      service.saveCampaignDraft(biz.id, biz.userId, created.id, { definition: definition({ reward: { percentBps: 700 } }) }),
    );
    expect(changed.version.number).toBe(1);
    expect(changed.version.definitionHash).not.toBe(created.version.definitionHash);
    expect(changed.name).toBe("b");

    const versions = await db.query(`SELECT count(*)::int AS n FROM growth_campaign_versions WHERE campaign_id = $1`, [created.id]);
    expect(versions.rows[0].n).toBe(1);
    await expect(asBiz(() => service.saveCampaignDraft(biz.id, biz.userId, created.id, {}))).rejects.toMatchObject({ code: "nothing_to_update" });
  });

  it("makes a change after the lock the next version, and the database refuses to rewrite the locked one", async () => {
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "a", definition: definition() }));
    await db.query(`UPDATE growth_campaign_versions SET locked_at = now() WHERE campaign_id = $1`, [created.id]);

    await expect(
      db.query(`UPDATE growth_campaign_versions SET definition = '{}'::jsonb WHERE campaign_id = $1`, [created.id]),
    ).rejects.toThrow(/growth_campaign_version_locked/);
    await expect(db.query(`UPDATE growth_campaign_versions SET locked_at = NULL WHERE campaign_id = $1`, [created.id])).rejects.toThrow(
      /growth_campaign_version_locked/,
    );
    await expect(db.query(`DELETE FROM growth_campaign_versions WHERE campaign_id = $1`, [created.id])).rejects.toThrow(
      /growth_campaign_version_locked/,
    );

    const next = await asBiz(() =>
      service.saveCampaignDraft(biz.id, biz.userId, created.id, { definition: definition({ reward: { percentBps: 800 } }) }),
    );
    expect(next.version).toMatchObject({ number: 2, locked: false });

    const rows = await db.query(`SELECT version_number, locked_at IS NOT NULL AS locked FROM growth_campaign_versions WHERE campaign_id = $1 ORDER BY 1`, [
      created.id,
    ]);
    expect(rows.rows).toEqual([
      { version_number: 1, locked: true },
      { version_number: 2, locked: false },
    ]);
  });

  it("removes a business's locked campaigns with the business, not before", async () => {
    const doomed = await createBusiness("Doomed");
    const created = await asBiz(() => service.createCampaign(doomed.id, doomed.userId, { name: "a", definition: definition() }), doomed.id);
    await db.query(`UPDATE growth_campaign_versions SET locked_at = now() WHERE campaign_id = $1`, [created.id]);
    await expect(db.query(`DELETE FROM growth_campaigns WHERE id = $1`, [created.id])).resolves.toBeDefined();
    const gone = await db.query(`SELECT count(*)::int AS n FROM growth_campaign_versions WHERE campaign_id = $1`, [created.id]);
    expect(gone.rows[0].n).toBe(0);

    const second = await asBiz(() => service.createCampaign(doomed.id, doomed.userId, { name: "b", definition: definition() }), doomed.id);
    await db.query(`UPDATE growth_campaign_versions SET locked_at = now() WHERE campaign_id = $1`, [second.id]);
    await db.query(`DELETE FROM users WHERE business_id = $1`, [doomed.id]);
    await expect(db.query(`DELETE FROM businesses WHERE id = $1`, [doomed.id])).resolves.toBeDefined();
  });

  it("archives once, refuses edits afterwards, and treats a second archive as a no-op", async () => {
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "a", definition: definition() }));
    const archived = await asBiz(() => service.archiveCampaign(biz.id, biz.userId, created.id));
    expect(archived.status).toBe("archived");
    await asBiz(() => service.archiveCampaign(biz.id, biz.userId, created.id));
    await expect(asBiz(() => service.saveCampaignDraft(biz.id, biz.userId, created.id, { name: "b" }))).rejects.toMatchObject({
      code: "campaign_not_editable",
      status: 409,
    });
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'growth.campaign_archived'`, [created.id]);
    expect(audit.rows[0].n).toBe(1);

    await db.query(`UPDATE growth_campaigns SET status = 'live', archived_at = NULL WHERE id = $1`, [created.id]);
    await expect(asBiz(() => service.archiveCampaign(biz.id, biz.userId, created.id))).rejects.toMatchObject({ code: "campaign_live" });
  });
});

describe("the dry run", () => {
  it("counts settled net paid only, replays refunds and leaves the books untouched", async () => {
    const alice = await party(biz.id);
    const bob = await party(biz.id);
    const other = await createBusiness("Other");
    const stranger = await party(other.id);

    await sale({ customerId: alice, total: 4_000_000, payments: [{ method: "card", amount: 4_000_000 }] }); // 5 % = 200 000, capped 100 000
    await sale({ customerId: bob, total: 1_500_000, payments: [{ method: "cash", amount: 1_500_000 }] }); // 75 000
    await sale({ customerId: bob, total: 3_000_000, payments: [{ method: "card", amount: 3_000_000 }, { method: "card", amount: -2_500_000 }] }); // net 500 000 → below min
    await sale({ customerId: alice, total: 5_000_000, payments: [{ method: "credit", amount: 5_000_000 }] }); // on account — not money
    await sale({ customerId: alice, total: 2_000_000, status: "voided", payments: [] });
    await sale({ customerId: null, total: 2_000_000, payments: [{ method: "cash", amount: 2_000_000 }] });
    await sale({ customerId: alice, total: 2_000_000, daysAgo: 60, payments: [{ method: "cash", amount: 2_000_000 }] }); // outside 30 days
    await sale({ locationId: other.locationId, customerId: stranger, total: 9_000_000, payments: [{ method: "cash", amount: 9_000_000 }] });

    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "sim", definition: definition() }));

    const journalBefore = await db.query(`SELECT (SELECT count(*) FROM journal_entries)::int AS j, (SELECT count(*) FROM domain_events)::int AS e`);
    const run = await asBiz(() => service.simulateSavedCampaign(biz.id, created.id));
    const journalAfter = await db.query(`SELECT (SELECT count(*) FROM journal_entries)::int AS j, (SELECT count(*) FROM domain_events)::int AS e`);
    expect(journalAfter.rows[0]).toEqual(journalBefore.rows[0]);

    expect(run).toMatchObject({ campaignId: created.id, version: 1, definitionHash: created.version.definitionHash, truncated: false });
    expect(run.result).toMatchObject({
      dryRun: true,
      ledgerEffect: "none",
      salesConsidered: 6,
      rewardedSales: 2,
      rewardedCustomers: 2,
      exposureRial: 175_000,
      budgetRemainingRial: 825_000,
    });
    expect(run.result.excluded).toMatchObject({ voided: 1, no_customer: 1, not_settled: 1, below_minimum: 1 });
    // Customers never leave the replay.
    expect(JSON.stringify(run)).not.toContain(alice);
    expect(JSON.stringify(run)).not.toContain(bob);
  });

  it("leaves website-imported orders out of the POS-trigger replay", async () => {
    const customer = await party(biz.id);
    await sale({ customerId: customer, total: 2_000_000, payments: [{ method: "cash", amount: 2_000_000 }] });
    const online = await sale({ customerId: customer, total: 3_000_000, payments: [{ method: "card", amount: 3_000_000 }] });
    await db.query(
      `INSERT INTO online_order_documents
         (order_id, location_id, source_type, remote_id, occurred_at, occurred_at_source, total_rial, lines_subtotal_rial, breakdown_status)
       VALUES ($1, $2, 'woocommerce_order', 'wc-1', now(), 'import', 3000000, 3000000, 'reconciled')`,
      [online, biz.locationId],
    );

    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "pos only", definition: definition() }));
    const run = await asBiz(() => service.simulateSavedCampaign(biz.id, created.id));
    expect(run.result.salesConsidered).toBe(1);
    expect(run.result.exposureRial).toBe(100_000);
    expect(run.result.outcomes.map((o) => o.orderId)).not.toContain(online);
  });

  it("limits the replay to the campaign's branches", async () => {
    const second = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id", [biz.id]);
    const customer = await party(biz.id);
    await sale({ customerId: customer, total: 2_000_000, payments: [{ method: "cash", amount: 2_000_000 }] });
    await sale({ locationId: second.rows[0].id, customerId: customer, total: 2_000_000, payments: [{ method: "cash", amount: 2_000_000 }] });

    const created = await asBiz(() =>
      service.createCampaign(biz.id, biz.userId, { name: "scoped", definition: definition({ trigger: { locationIds: [second.rows[0].id] } }) }),
    );
    const run = await asBiz(() => service.simulateSavedCampaign(biz.id, created.id));
    expect(run.result.salesConsidered).toBe(1);
    expect(run.result.rewardedSales).toBe(1);
  });

  it("validates the window and the campaign", async () => {
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "w", definition: definition() }));
    for (const windowDays of [0, 91, 1.5, -3]) {
      await expect(asBiz(() => service.simulateSavedCampaign(biz.id, created.id, { windowDays }))).rejects.toMatchObject({ code: "window_invalid" });
    }
    await expect(asBiz(() => service.simulateSavedCampaign(biz.id, randomUUID()))).rejects.toMatchObject({ code: "campaign_not_found", status: 404 });
  });

  it("is isolated per tenant: another business's sales never reach the replay", async () => {
    const other = await createBusiness("Other");
    const stranger = await party(other.id);
    await sale({ locationId: other.locationId, customerId: stranger, total: 9_000_000, payments: [{ method: "cash", amount: 9_000_000 }] });
    const created = await asBiz(() => service.createCampaign(biz.id, biz.userId, { name: "iso", definition: definition() }));
    const run = await asBiz(() => service.simulateSavedCampaign(biz.id, created.id));
    expect(run.result.salesConsidered).toBe(0);
  });
});
