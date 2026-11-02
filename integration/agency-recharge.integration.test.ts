/**
 * §D's recharge, against a real database (issue #1128, migration 0284).
 *
 * The headline assertion is the second one: that recording a client's media buy and
 * then billing it back leaves account **1270 at zero**. That is what "clearing account"
 * means, and it is the thing neither half could prove alone — 0280's suite showed the
 * debit landing and this one shows the credit meeting it.
 *
 * The rest is what only a database can show: that the recharge recognises no revenue
 * and no VAT, that a cost cannot be billed twice, that voiding the invoice makes it
 * billable again *without anybody updating a flag* (the state is derived from the
 * order), and that the invoice and the marks on the cost rows commit together.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let service: typeof import("../src/lib/agency-reimbursable-cost-service");
let costPure: typeof import("../src/lib/agency-reimbursable-cost");

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
  databaseName = `agency_recharge_${randomUUID().replaceAll("-", "")}`;

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
  provisioning = await import("../src/lib/business-provisioning");
  service = await import("../src/lib/agency-reimbursable-cost-service");
  costPure = await import("../src/lib/agency-reimbursable-cost");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 240_000);

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

/* ------------------------------------------------------------------ fixtures */

let seq = 0;

interface Agency {
  businessId: string;
  locationId: string;
  clientId: string;
  projectId: string;
  actor: { userId: string; name: string };
}

async function agency(label = ""): Promise<Agency> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس بازپرداخت ${seq} ${label}`,
    ownerName: "حسابدار",
    // A real member, not a placeholder: `domain_events.created_by` and
    // `orders.opened_by` are foreign keys, so a posted document is attributed.
    email: `agency-recharge-${seq}-${randomUUID().slice(0, 6)}@example.test`,
    password: "correct-horse",
    subdomain: `agrech${seq}${randomUUID().slice(0, 4)}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  const actor = { userId: result.userId, name: "حسابدار" };
  const clientId = (
    await db.query(`INSERT INTO parties (business_id, name) VALUES ($1,'کارفرما') RETURNING id`, [
      result.businessId,
    ])
  ).rows[0].id;
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1,'پروژهٔ کمپین',$2) RETURNING id`,
      [result.businessId, actor.userId],
    )
  ).rows[0].id;
  return { businessId: result.businessId, locationId: result.locationId, clientId, projectId, actor };
}

/** One posted cost, which is the only kind that can be recharged. */
async function cost(a: Agency, over: Record<string, unknown> = {}) {
  const created = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
    partyId: a.clientId,
    projectId: a.projectId,
    description: "خرید فضای تبلیغاتی",
    amountRial: 5_000_000,
    spentOn: "2026-11-01",
    presentation: "net",
    settledBy: "payable",
    ...over,
  });
  expect(created.posted, "a cost posts in the transaction that creates it").toBe(true);
  return created;
}

/** One account's balance for a tenant, from the ledger rather than the register. */
async function balance(businessId: string, code: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS net
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.business_id = $1 AND a.code = $2`,
    [businessId, code],
  );
  return Number(rows[0].net);
}

/** The entries an invoice produced, found through the domain events it emitted.
 *  `journal_entries.source_id` is a fresh identity per *line* (several service lines
 *  on one invoice post the same kind against the same order), so the order id is on
 *  the event rather than on the entry. */
async function entryIdsForOrder(orderId: string, businessId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT entry_id FROM domain_events
      WHERE business_id = $1 AND source_id = $2 AND entry_id IS NOT NULL`,
    [businessId, orderId],
  );
  return rows.map((row) => row.entry_id);
}

async function entryLines(entryId: string) {
  const { rows } = await db.query(
    `SELECT a.code, a.type, l.debit::text AS debit, l.credit::text AS credit, e.memo, e.project_id
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id AND a.business_id = e.business_id
      WHERE e.id = $1
      ORDER BY a.code`,
    [entryId],
  );
  return rows as { code: string; type: string; debit: string; credit: string; memo: string; project_id: string | null }[];
}

async function refuse(thunk: () => Promise<unknown>): Promise<string> {
  try {
    await thunk();
    return "succeeded";
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return `${err.code ?? ""}:${err.message ?? ""}`;
  }
}

/* --------------------------------------------------------------------- tests */

describe("recharging a reimbursable client cost (issue #1128 §D, migration 0284)", () => {
  it("credits 1270 and recognises no revenue and no VAT", async () => {
    const a = await agency();
    const one = await cost(a, { amountRial: 5_000_000 });

    expect(await balance(a.businessId, "1270")).toBe(5_000_000);

    const recharge = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id],
      locationId: a.locationId,
    });

    expect(recharge.rechargedCostIds).toEqual([one.id]);
    expect(recharge.totalRial).toBe(5_000_000);

    // The invoice's own entry: the client owes it, and 1270 gives it up.
    const entryIds = await entryIdsForOrder(recharge.orderId, a.businessId);
    expect(entryIds.length).toBeGreaterThan(0);
    const lines = await entryLines(entryIds[0]);
    const credits = lines.filter((line) => Number(line.credit) > 0).map((line) => line.code);
    expect(credits).toContain("1270");
    // None of the agency's four service revenues, and no VAT: recovering a client's
    // own money is not a supply, and a VAT line here would be a liability owed to
    // nobody.
    for (const revenue of ["4640", "4650", "4660", "4670"]) {
      expect(credits, `${revenue} must not be credited`).not.toContain(revenue);
    }
    expect(lines.find((line) => Number(line.credit) > 0)?.type).toBe("asset");
    expect(lines.some((line) => line.memo.includes("بازدریافت"))).toBe(true);
  }, 180_000);

  it("leaves 1270 at zero — the account clears rather than accumulates", async () => {
    const a = await agency();
    const one = await cost(a, { amountRial: 3_000_000 });
    const two = await cost(a, { amountRial: 2_000_000, description: "چاپ بنر" });

    expect(await balance(a.businessId, "1270")).toBe(5_000_000);

    const recharge = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id, two.id],
      locationId: a.locationId,
    });

    // One invoice, one line per cost, and the whole claim gone from the asset account.
    expect(recharge.totalRial).toBe(5_000_000);
    expect(await balance(a.businessId, "1270")).toBe(0);

    const { rows } = await db.query(
      `SELECT retail_snapshot AS snapshot FROM order_items WHERE order_id = $1
        ORDER BY retail_snapshot->>'revenueCode'`,
      [recharge.orderId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The snapshot says which account the line credited, and the discriminator says
      // it was not revenue — a reprint and any future report read both.
      expect(row.snapshot.revenueCode).toBe("1270");
      expect(row.snapshot.passThrough).toBe(true);
    }
  }, 180_000);

  it("marks every cost with the invoice, and reads as recharged", async () => {
    const a = await agency();
    const one = await cost(a);
    const recharge = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id],
      locationId: a.locationId,
    });

    const row = (
      await db.query(
        `SELECT c.recharged_order_id, c.recharged_by, c.recharged_by_name, o.status, o.customer_id
           FROM agency_reimbursable_costs c JOIN orders o ON o.id = c.recharged_order_id
          WHERE c.id = $1`,
        [one.id],
      )
    ).rows[0];
    expect(row.recharged_order_id).toBe(recharge.orderId);
    expect(row.recharged_by).toBe(a.actor.userId);
    expect(row.recharged_by_name).toBe("حسابدار");
    // `orders.customer_id` references `parties`, so the cost's client *is* the
    // invoice's customer and no mapping was needed or wanted.
    expect(row.customer_id).toBe(a.clientId);
    expect(
      costPure.isCostRecharged({ rechargedOrderId: row.recharged_order_id, orderStatus: row.status }),
    ).toBe(true);

    // The list reports it too, which is what a member actually looks at.
    const listed = await service.listAgencyReimbursableCosts(a.businessId, { partyId: a.clientId });
    expect(listed[0].rechargedOrderId).toBe(recharge.orderId);
    expect(listed[0].recharged).toBe(true);
  }, 180_000);

  it("refuses to bill a client twice for the same media buy", async () => {
    const a = await agency();
    const one = await cost(a);
    await service.rechargeAgencyCosts(a.businessId, a.actor, { costIds: [one.id], locationId: a.locationId });

    expect(
      await refuse(() =>
        service.rechargeAgencyCosts(a.businessId, a.actor, { costIds: [one.id], locationId: a.locationId }),
      ),
    ).toContain("cost_already_recharged");

    // And 1270 did not go negative, which is what a double recharge would have done.
    expect(await balance(a.businessId, "1270")).toBe(0);
  }, 180_000);

  it("refuses a cost whose own entry has not landed, because there is nothing to clear", async () => {
    const a = await agency();
    // Written raw, because the service posts in the transaction it creates in: an
    // unposted row is what a locked fiscal period leaves behind.
    const id = (
      await db.query(
        `INSERT INTO agency_reimbursable_costs
           (business_id, cost_number, party_id, description, amount_rial, spent_on)
         VALUES ($1,'RC-6001',$2,'در صف تأیید',1000,'2026-11-02') RETURNING id`,
        [a.businessId, a.clientId],
      )
    ).rows[0].id;

    expect(
      await refuse(() => service.rechargeAgencyCosts(a.businessId, a.actor, { costIds: [id], locationId: a.locationId })),
    ).toContain("cost_not_posted");
    expect(await balance(a.businessId, "1270")).toBe(0);
  }, 180_000);

  it("refuses one invoice for two clients, and says nothing else about the request", async () => {
    const a = await agency();
    const second = (
      await db.query(`INSERT INTO parties (business_id, name) VALUES ($1,'کارفرمای دوم') RETURNING id`, [
        a.businessId,
      ])
    ).rows[0].id;
    const one = await cost(a);
    const two = await cost(a, { partyId: second, description: "هزینهٔ کارفرمای دوم" });

    expect(
      await refuse(() =>
        service.rechargeAgencyCosts(a.businessId, a.actor, {
          costIds: [one.id, two.id],
          locationId: a.locationId,
        }),
      ),
    ).toContain("costs_from_different_clients");

    // Nothing was written for either of them.
    expect(await balance(a.businessId, "1270")).toBe(10_000_000);
  }, 180_000);

  it("refuses the unusable before touching the ledger", async () => {
    const a = await agency();
    const one = await cost(a);

    expect(await refuse(() => service.rechargeAgencyCosts(a.businessId, a.actor, { costIds: [] }))).toContain("recharge_empty");
    expect(await refuse(() => service.rechargeAgencyCosts(a.businessId, a.actor, { costIds: [randomUUID()] }))).toContain(
      "cost_not_found_for_recharge",
    );
    // A duplicate of a real id is one recharge rather than an error worth a round trip.
    const dupes = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id, one.id],
      locationId: a.locationId,
    });
    expect(dupes.rechargedCostIds).toEqual([one.id]);
    expect(await balance(a.businessId, "1270")).toBe(0);
  }, 180_000);

  it("tags the invoice with the project when every cost agrees, and not when they do not", async () => {
    const a = await agency();
    const other = (
      await db.query(
        `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1,'پروژهٔ دیگر',$2) RETURNING id`,
        [a.businessId, a.actor.userId],
      )
    ).rows[0].id;

    const same1 = await cost(a);
    const same2 = await cost(a, { description: "تولید محتوا" });
    const tagged = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [same1.id, same2.id],
      locationId: a.locationId,
    });
    let projectOf = await db.query(
      `SELECT project_id FROM journal_entries WHERE id = ANY($1::uuid[])`,
      [await entryIdsForOrder(tagged.orderId, a.businessId)],
    );
    expect(projectOf.rows.length).toBeGreaterThan(0);
    expect(projectOf.rows.every((row: { project_id: string | null }) => row.project_id === a.projectId)).toBe(true);

    const mixed1 = await cost(a, { projectId: other, description: "پروژهٔ دیگر الف" });
    const mixed2 = await cost(a, { description: "پروژهٔ دیگر ب" });
    const untagged = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [mixed1.id, mixed2.id],
      locationId: a.locationId,
    });
    projectOf = await db.query(
      `SELECT project_id FROM journal_entries WHERE id = ANY($1::uuid[])`,
      [await entryIdsForOrder(untagged.orderId, a.businessId)],
    );
    expect(projectOf.rows.length).toBeGreaterThan(0);
    // Guessing one of two projects would put the whole recharge in a single project's
    // P&L and quietly take it out of the other's.
    expect(projectOf.rows[0].project_id).toBeNull();
  }, 180_000);

  it("makes a cost rechargeable again when the invoice is voided, with nobody updating a flag", async () => {
    const a = await agency();
    const one = await cost(a, { amountRial: 4_000_000 });
    const first = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id],
      locationId: a.locationId,
    });
    expect(await balance(a.businessId, "1270")).toBe(0);

    // Exactly what `retail-invoice-void-service.ts` does: flip the status and leave
    // the row. No hook into this register, and no stored flag to fall out of step.
    await db.query(`UPDATE orders SET status = 'voided' WHERE id = $1`, [first.orderId]);

    const after = await service.loadAgencyReimbursableCost(a.businessId, one.id);
    expect(after?.rechargedOrderId).toBe(first.orderId);
    expect(after?.recharged).toBe(false);

    const second = await service.rechargeAgencyCosts(a.businessId, a.actor, {
      costIds: [one.id],
      locationId: a.locationId,
    });
    expect(second.orderId).not.toBe(first.orderId);
    expect(await balance(a.businessId, "1270")).toBe(-4_000_000);
    // Negative, and correctly so: the void reversed nothing in the ledger here because
    // this test flipped the status by hand instead of running the void service, which
    // writes the reversing entry. The assertion is that the *derived* flag let the
    // recharge happen — the ledger's own reversal is the void service's job.
  }, 180_000);

  it("keeps one tenant's costs out of another's recharge", async () => {
    const a = await agency();
    const b = await agency("دوم");
    const one = await cost(a);

    expect(
      await refuse(() => service.rechargeAgencyCosts(b.businessId, b.actor, { costIds: [one.id], locationId: b.locationId })),
    ).toContain("cost_not_found_for_recharge");
    // Nothing moved in either tenant's books.
    expect(await balance(a.businessId, "1270")).toBe(5_000_000);
    expect(await balance(b.businessId, "1270")).toBe(0);
  }, 180_000);

  it("refuses a trade that has no reimbursable client cost", async () => {
    seq += 1;
    const cafe = await provisioning.provisionBusiness({
      businessName: `کافه ${seq}`,
      ownerName: "مالک",
      email: `cafe-recharge-${seq}@example.test`,
      password: "correct-horse",
      subdomain: `caferech${seq}`,
      industry: "food_service",
      seedChartOfAccounts: true,
    });
    expect(
      await refuse(() =>
        service.rechargeAgencyCosts(cafe.businessId, { userId: cafe.userId, name: "مالک" }, {
          costIds: [randomUUID()],
          locationId: cafe.locationId,
        }),
      ),
    ).toContain("not_agency");
  }, 180_000);
});
