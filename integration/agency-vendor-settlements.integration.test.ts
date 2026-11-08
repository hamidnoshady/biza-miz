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

  it("mirrors the original entry, restores 2140, and frees costs without editing their links", async () => {
    const a = await agency(); const c = await cost(a); const paid = await settle(a, [c.id]);
    const undone = await service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "2026-11-02" });
    expect(await balance(a, "2140")).toBe(5000000);
    expect(await balance(a, "1270")).toBe(-5000000);
    const loaded = await service.loadAgencyReimbursableCost(a.businessId, c.id);
    expect(loaded?.settled).toBe(false);
    expect(loaded?.settlementId).toBe(paid.id);
    const journal = await db.query(`SELECT project_id, reverses_entry_id FROM journal_entries WHERE id=$1`, [undone.reversalEntryId]);
    expect(journal.rows[0]).toMatchObject({ project_id: a.projectId, reverses_entry_id: paid.entryId });
    const original = await db.query(`SELECT account_id, debit::text, credit::text FROM journal_lines WHERE entry_id=$1 ORDER BY account_id`, [paid.entryId]);
    const reversal = await db.query(`SELECT account_id, credit::text AS debit, debit::text AS credit FROM journal_lines WHERE entry_id=$1 ORDER BY account_id`, [undone.reversalEntryId]);
    expect(reversal.rows).toEqual(original.rows);
    const event = await db.query(`SELECT entry_id FROM domain_events WHERE business_id=$1 AND source_type='agency_vendor_settlement_reversal' AND source_id=$2`, [a.businessId, paid.id]);
    expect(event.rows[0].entry_id).toBe(undone.reversalEntryId);
    await settle(a, [c.id]);
    expect(await balance(a, "2140")).toBe(0);
  });
  it("allows just one of two concurrent reversals and refuses subsequent reversals", async () => {
    const a = await agency(); const c = await cost(a); const paid = await settle(a, [c.id]);
    const results = await Promise.allSettled([1, 2].map(() => service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "2026-11-02" })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(a, "2140")).toBe(5000000);
    await expect(service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "2026-11-02" })).rejects.toThrow("settlement_already_reversed");
  });
  it("does not reverse a foreign tenant's payment or accept an invalid date", async () => {
    const a = await agency(); const b = await agency(); const c = await cost(a); const paid = await settle(a, [c.id]);
    await expect(service.reverseAgencyVendorSettlement(b.businessId, b.actor, paid.id, { reversedOn: "2026-11-02" })).rejects.toThrow("settlement_not_found");
    await expect(service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "1405-08-01" })).rejects.toThrow("invalid_date");
    expect(await balance(a, "2140")).toBe(0);
  });

  it("rolls back a reversal in a locked fiscal period without freeing the costs", async () => {
    const a = await agency(); const c = await cost(a); const paid = await settle(a, [c.id]);
    const year = await db.query(`INSERT INTO fiscal_years (business_id,label,starts_on,ends_on)
      VALUES ($1,'reversal-test','2027-01-01','2027-12-31') RETURNING id`, [a.businessId]);
    await db.query(`INSERT INTO fiscal_periods (business_id,fiscal_year_id,label,starts_on,ends_on,status)
      VALUES ($1,$2,'locked','2027-01-01','2027-01-31','locked')`, [a.businessId, year.rows[0].id]);
    await expect(service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "2027-01-02" })).rejects.toThrow();
    expect(await balance(a, "2140")).toBe(0);
    expect((await service.loadAgencyReimbursableCost(a.businessId, c.id))?.settled).toBe(true);
    const events = await db.query(`SELECT id FROM domain_events WHERE business_id=$1 AND event_type='agency.vendor_settlement_reversal'`, [a.businessId]);
    expect(events.rows).toHaveLength(0);
    const original = await db.query(`SELECT reversed_at FROM journal_entries WHERE id=$1`, [paid.entryId]);
    expect(original.rows[0].reversed_at).toBeNull();
  });

  async function supplier(a: Agency, name = "رسانه آفتاب") {
    const result = await db.query(`INSERT INTO parties (business_id,name,role,roles)
      VALUES ($1,$2,'supplier',ARRAY['customer','supplier']) RETURNING id`, [a.businessId, name]);
    return result.rows[0].id as string;
  }

  it("captures canonical supplier identity and ignores a conflicting caller-supplied name", async () => {
    const a = await agency(); const vendorId = await supplier(a);
    const c = await cost(a, { vendorPartyId: vendorId, vendorName: "نام جعلی" });
    expect(c.vendorPartyId).toBe(vendorId);
    expect(c.vendorName).toBe("رسانه آفتاب");
    const paid = await settle(a, [c.id]);
    const row = await db.query(`SELECT vendor_party_id FROM agency_vendor_settlements WHERE id=$1`, [paid.id]);
    expect(row.rows[0].vendor_party_id).toBe(vendorId);
    const legs = await db.query(`SELECT jl.party_id, jl.debit::text, jl.credit::text
      FROM journal_lines jl JOIN accounts ac ON ac.id=jl.account_id
      JOIN journal_entries je ON je.id=jl.entry_id
      WHERE je.business_id=$1 AND ac.code='2140' ORDER BY jl.debit`, [a.businessId]);
    expect(legs.rows).toHaveLength(2);
    expect(legs.rows.every(line => line.party_id === vendorId)).toBe(true);
  });
  it("never groups different supplier identities just because their names match", async () => {
    const a = await agency(); const x = await supplier(a); const y = await supplier(a);
    const c = await cost(a, { vendorPartyId: x }); const d = await cost(a, { vendorPartyId: y });
    await expect(settle(a, [c.id, d.id])).rejects.toThrow("costs_from_different_vendors");
    expect(await balance(a, "2140")).toBe(10000000);
  });
  it("groups one renamed supplier by ID and retains the original cost-name snapshot", async () => {
    const a = await agency(); const id = await supplier(a);
    const x = await cost(a, { vendorPartyId: id });
    await db.query(`UPDATE parties SET name='رسانه نو' WHERE id=$1`, [id]);
    const y = await cost(a, { vendorPartyId: id });
    expect(x.vendorName).not.toBe(y.vendorName);
    await settle(a, [x.id, y.id]);
    const loaded = await service.loadAgencyReimbursableCost(a.businessId, x.id);
    expect(loaded?.vendorName).toBe("رسانه آفتاب");
    expect(loaded?.vendorPartyName).toBe("رسانه نو");
    expect(await balance(a, "2140")).toBe(0);
  });
  it("keeps linked and text-only costs separate even with the same payee name", async () => {
    const a = await agency(); const id = await supplier(a);
    const x = await cost(a, { vendorPartyId: id }); const y = await cost(a);
    await expect(settle(a, [x.id, y.id])).rejects.toThrow("costs_from_different_vendors");
    expect(y.vendorPartyId).toBeNull();
  });
  it("refuses invalid, inactive, non-supplier and foreign vendor identities", async () => {
    const a = await agency(); const b = await agency(); const foreign = await supplier(b);
    const inactive = await supplier(a); await db.query(`UPDATE parties SET is_active=false WHERE id=$1`, [inactive]);
    for (const vendorPartyId of ["not-a-uuid", 42, a.clientId, foreign, inactive]) {
      await expect(cost(a, { vendorPartyId })).rejects.toThrow("invalid_vendor");
    }
    await expect(db.query(`INSERT INTO agency_reimbursable_costs
      (business_id,cost_number,party_id,description,amount_rial,spent_on,vendor_party_id)
      VALUES ($1,'RC-invalid-vendor',$2,'test',1000,'2026-10-05',$3)`, [a.businessId, a.clientId, foreign])).rejects.toThrow("active supplier party of this business");
    expect(await balance(a, "2140")).toBe(0);
  });
  it("freezes posted vendor attribution against PATCH and direct SQL changes", async () => {
    const a = await agency(); const x = await supplier(a); const y = await supplier(a);
    const c = await cost(a, { vendorPartyId: x });
    await expect(service.updateAgencyReimbursableCost(a.businessId, c.id, a.actor, { vendorPartyId: y })).rejects.toThrow("cost_posted");
    await expect(db.query(`UPDATE agency_reimbursable_costs SET vendor_party_id=$2 WHERE id=$1`, [c.id, y])).rejects.toThrow("audited party merge");
    await expect(db.query(`UPDATE agency_reimbursable_costs SET vendor_party_id=NULL WHERE id=$1`, [c.id])).rejects.toThrow("audited party merge");
  });
  it("moves both posted vendor references through a real audited merge without rewriting money", async () => {
    const a = await agency(); const winner = await supplier(a, "برنده"); const loser = await supplier(a, "تکراری");
    const c = await cost(a, { vendorPartyId: loser }); const paid = await settle(a, [c.id]);
    const crm = await import("../src/lib/crm-service");
    expect(await crm.mergeCustomers(a.businessId, winner, loser, { mergedByUserId: a.actor.userId })).not.toBeNull();
    const loaded = await service.loadAgencyReimbursableCost(a.businessId, c.id);
    expect(loaded?.vendorPartyId).toBe(winner); expect(loaded?.vendorName).toBe("تکراری");
    const payment = await db.query(`SELECT vendor_party_id, vendor_name FROM agency_vendor_settlements WHERE id=$1`, [paid.id]);
    expect(payment.rows[0]).toEqual({ vendor_party_id: winner, vendor_name: "تکراری" });
    expect(await balance(a, "2140")).toBe(0);
    const audits = await db.query(`SELECT id FROM crm_party_attribution_moves WHERE business_id=$1 AND old_party_id=$2 AND new_party_id=$3`, [a.businessId, loser, winner]);
    expect(audits.rows).toHaveLength(2);
  });

  it("keeps historical note edits and reversals usable after a supplier is archived", async () => {
    const a = await agency(); const id = await supplier(a);
    const c = await cost(a, { vendorPartyId: id }); const paid = await settle(a, [c.id]);
    await db.query(`UPDATE parties SET is_active=false WHERE id=$1`, [id]);
    await service.updateAgencyReimbursableCost(a.businessId, c.id, a.actor, { note: "پیگیری پس از بایگانی" });
    await service.reverseAgencyVendorSettlement(a.businessId, a.actor, paid.id, { reversedOn: "2026-11-02" });
    expect(await balance(a, "2140")).toBe(5000000);
    await expect(settle(a, [c.id])).rejects.toThrow("invalid_vendor");
  });

});
