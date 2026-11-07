/**
 * #1128 §D vendor settlements: a real 2140 credit must meet one debit,
 * without a second expense, and concurrent payments must never clear it twice.
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
  databaseName = `agency_settle_${randomUUID().replaceAll("-", "")}`;

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

async function cost(a: Agency, over: Record<string, unknown> = {}) {
  return service.createAgencyReimbursableCost(a.businessId, a.actor, {
    partyId: a.clientId, projectId: a.projectId, description: "خرید رسانه",
    vendorName: "رسانه آفتاب", amountRial: 5000000, spentOn: "2026-10-05",
    presentation: "net", settledBy: "payable", ...over,
  });
}

async function settle(a: Agency, ids: string[]) {
  return service.settleAgencyVendorCosts(a.businessId, a.actor, {
    costIds: ids, method: "bank", paidOn: "2026-11-01", locationId: a.locationId,
  });
}

async function balance(a: Agency, code: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(jl.credit-jl.debit),0)::text AS balance
       FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
       JOIN accounts ac ON ac.id=jl.account_id AND ac.business_id=je.business_id
      WHERE je.business_id=$1 AND ac.code=$2`, [a.businessId, code]);
  return Number(rows[0].balance);
}

describe("agency vendor settlement", () => {
  it("clears 2140 without adding expense or revenue; marks and payment agree", async () => {
    const a = await agency(); const c = await cost(a);
    expect(await balance(a, "2140")).toBe(5000000);
    const paid = await settle(a, [c.id]);
    expect(paid.totalRial).toBe(5000000);
    expect(paid.entryId).toBeTruthy();
    expect(await balance(a, "2140")).toBe(0);
    expect(await balance(a, "1270")).toBe(-5000000);
    const loaded = await service.loadAgencyReimbursableCost(a.businessId, c.id);
    expect(loaded?.settled).toBe(true);
    expect(loaded?.settlementId).toBe(paid.id);
    expect(loaded?.settlementNumber).toBe("VS-001");
  });
  it("refuses paying a cost twice", async () => {
    const a = await agency(); const c = await cost(a);
    await settle(a, [c.id]);
    await expect(settle(a, [c.id])).rejects.toThrow("cost_already_settled");
    expect(await balance(a, "2140")).toBe(0);
  });
  it("serializes simultaneous payments of the same cost", async () => {
    const a = await agency(); const c = await cost(a);
    const results = await Promise.allSettled([settle(a, [c.id]), settle(a, [c.id])]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(a, "2140")).toBe(0);
  });
  it("refuses a cash-paid cost because it never credited 2140", async () => {
    const a = await agency(); const c = await cost(a, { settledBy: "cash" });
    await expect(settle(a, [c.id])).rejects.toThrow("cost_not_payable");
  });
  it("does not mix vendors or permit blank payees", async () => {
    const a = await agency(); const x = await cost(a);
    const y = await cost(a, { vendorName: "چاپخانه" });
    await expect(settle(a, [x.id, y.id])).rejects.toThrow("costs_from_different_vendors");
    const z = await cost(a, { vendorName: "" });
    await expect(settle(a, [z.id])).rejects.toThrow("costs_from_different_vendors");
  });
  it("collapses duplicate ids into one payment", async () => {
    const a = await agency(); const c = await cost(a);
    expect((await settle(a, [c.id, c.id])).totalRial).toBe(5000000);
  });
  it("refuses another tenant's cost and branch", async () => {
    const a = await agency(); const b = await agency(); const c = await cost(b);
    await expect(settle(a, [c.id])).rejects.toThrow("cost_not_found_for_settlement");
    const own = await cost(a);
    await expect(service.settleAgencyVendorCosts(a.businessId, a.actor, {
      costIds: [own.id], method: "bank", paidOn: "2026-11-01", locationId: b.locationId,
    })).rejects.toThrow("location_required");
  });
  it("freezes a posted payment and enforces references even outside the service", async () => {
    const a = await agency(); const b = await agency(); const c = await cost(a);
    const paid = await settle(a, [c.id]);
    await expect(db.query(`UPDATE agency_vendor_settlements SET amount_rial=1 WHERE id=$1`, [paid.id])).rejects.toThrow("frozen");
    await expect(db.query(`UPDATE agency_vendor_settlements SET entry_id=NULL WHERE id=$1`, [paid.id])).rejects.toThrow("immutable");
    await expect(db.query(`UPDATE agency_vendor_settlements SET business_id=$2 WHERE id=$1`, [paid.id, b.businessId])).rejects.toThrow("immutable");
  });

});
