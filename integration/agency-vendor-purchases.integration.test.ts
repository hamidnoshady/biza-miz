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
  databaseName = `agency_purchase_${randomUUID().replaceAll("-", "")}`;

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
      `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id) VALUES ($1,'پروژهٔ کمپین',$2,$3) RETURNING id`,
      [result.businessId, actor.userId, actor.userId],
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


let purchases: typeof import("../src/lib/agency-vendor-purchase-service");
beforeAll(async () => { purchases = await import("../src/lib/agency-vendor-purchase-service"); });
const owner = (a: Agency) => ({ businessId: a.businessId, actorUserId: a.actor.userId, actorName: a.actor.name });
async function quote(a: Agency) {
  const v = (await db.query(`INSERT INTO parties (business_id,name,role) VALUES ($1,'فروشنده','supplier') RETURNING id`, [a.businessId])).rows[0].id;
  return purchases.createVendorPurchase(owner(a), { projectId: a.projectId, partyId: a.clientId, vendorPartyId: v,
    quoteReference: "Q-123", description: "خرید رسانه", amountRial: 5000000, quotedOn: "2026-10-05" });
}
async function reviewer(a: Agency, role = "manager") {
  const u = (await db.query(`INSERT INTO users (business_id,role,full_name,email,password_hash)
    VALUES ($1,'manager','تصویب‌کننده',$2,'x') RETURNING id`, [a.businessId, `${randomUUID()}@example.test`])).rows[0].id;
  await db.query(`INSERT INTO workspace_members (project_id,user_id,role,added_by) VALUES ($1,$2,$3,'test')`, [a.projectId,u,role]);
  return { businessId: a.businessId, actorUserId: u, actorName: "تصویب‌کننده" };
}
async function approval(a: Agency, id: string) {
  return (await db.query(`SELECT id FROM workspace_approvals WHERE business_id=$1 AND subject_type='vendor_purchase' AND subject_id=$2 AND status='pending'`, [a.businessId,id])).rows[0].id as string;
}
async function approve(a: Agency, id: string) {
  await purchases.submitVendorPurchase(owner(a), id);
  await purchases.decideVendorPurchaseApproval(await reviewer(a), await approval(a,id), "approved");
}

describe("agency vendor purchase chain", () => {
  it("keeps quote and approved commitment out of the ledger until explicit booking, then settles once", async () => {
    const a = await agency(); const q = await quote(a);
    expect(q.status).toBe("draft"); expect(q.purchase_number).toBe("VP-001");
    await approve(a,q.id);
    expect(await balance(a,"2140")).toBe(0);
    const results = await Promise.all([1,2].map(() => purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06")));
    expect(results[0].costId).toBe(results[1].costId);
    expect(await balance(a,"2140")).toBe(5000000);
    const c = await service.loadAgencyReimbursableCost(a.businessId,results[0].costId);
    expect(c).toMatchObject({ vendorPartyId:q.vendor_party_id, partyId:a.clientId, projectId:a.projectId, settledBy:"payable", posted:true });
    await settle(a,[results[0].costId]); expect(await balance(a,"2140")).toBe(0);
  });
  it("rejects self-approval, a viewer's decision, and booking before approval", async () => {
    const a=await agency();const q=await quote(a);await purchases.submitVendorPurchase(owner(a),q.id);
    const id=await approval(a,q.id);
    await expect(purchases.decideVendorPurchaseApproval(owner(a),id,"approved")).rejects.toThrow("self_approval_forbidden");
    await expect(purchases.decideVendorPurchaseApproval(await reviewer(a,"viewer"),id,"approved")).rejects.toThrow("insufficient_project_role");
    await expect(purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06")).rejects.toThrow("invalid_purchase_state");
    expect(await balance(a,"2140")).toBe(0);
  });
  it("protects the quote from mutation after submission and requires a shared-queue decision", async () => {
    const a=await agency();const q=await quote(a);await purchases.submitVendorPurchase(owner(a),q.id);
    await expect(db.query(`UPDATE agency_vendor_purchases SET amount_rial=1 WHERE id=$1`,[q.id])).rejects.toThrow("frozen");
    await expect(db.query(`UPDATE agency_vendor_purchases SET status='approved' WHERE id=$1`,[q.id])).rejects.toThrow("shared-queue approval");
  });
  it("refuses foreign projects and non-member reads/writes", async () => {
    const a=await agency(),b=await agency();const q=await quote(a);
    await expect(purchases.bookVendorPurchase(owner(b),q.id,"2026-10-06")).rejects.toThrow("purchase_not_found");
    await expect(purchases.listVendorPurchases(owner(b),a.projectId)).rejects.toThrow("project_not_found");
    const outsider=await reviewer(b);
    await expect(purchases.listVendorPurchases({ ...outsider,businessId:a.businessId },a.projectId)).rejects.toThrow("project_not_found");
  });
  it("routes the generic approval/AI service through the purchase register and forbids detached requests", async () => {
    const a=await agency();const q=await quote(a);
    const workspace=await import("../src/lib/workspace");
    await expect(workspace.requestApproval(owner(a),{subjectType:"vendor_purchase",subjectId:q.id,title:"detached"})).rejects.toThrow("invalid_approval_subject");
    await purchases.submitVendorPurchase(owner(a),q.id);
    const result=await workspace.decideApproval(await reviewer(a),await approval(a,q.id),"approved");
    expect(result?.status).toBe("approved");
    expect((await purchases.listVendorPurchases(owner(a),a.projectId))[0].status).toBe("approved");
    expect(await balance(a,"2140")).toBe(0);
  });
  it("rolls back the expense, domain event and link when the posting engine refuses; retry succeeds once", async () => {
    const a=await agency();const q=await quote(a);await approve(a,q.id);
    await db.query(`UPDATE accounts SET is_active=false WHERE business_id=$1 AND code='2140'`,[a.businessId]);
    await expect(purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06")).rejects.toThrow();
    expect((await db.query(`SELECT count(*)::int AS n FROM agency_reimbursable_costs WHERE business_id=$1`,[a.businessId])).rows[0].n).toBe(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM domain_events WHERE business_id=$1 AND source_type='agency_reimbursable_cost'`,[a.businessId])).rows[0].n).toBe(0);
    expect((await purchases.listVendorPurchases(owner(a),a.projectId))[0]).toMatchObject({status:"approved",cost_id:null});
    await db.query(`UPDATE accounts SET is_active=true WHERE business_id=$1 AND code='2140'`,[a.businessId]);
    await purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06");
    expect(await balance(a,"2140")).toBe(5000000);
  });
  it("refuses an archived supplier at booking without changing the approved purchase", async () => {
    const a=await agency();const q=await quote(a);await approve(a,q.id);
    await db.query(`UPDATE parties SET is_active=false WHERE id=$1`,[q.vendor_party_id]);
    await expect(purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06")).rejects.toThrow("invalid_vendor");
    expect((await purchases.listVendorPurchases(owner(a),a.projectId))[0]).toMatchObject({status:"approved",cost_id:null});
    expect(await balance(a,"2140")).toBe(0);
  });
  it("moves a booked purchase's client through the existing audited CRM merge without rewriting cost facts", async () => {
    const a=await agency();const q=await quote(a);await approve(a,q.id);
    const booked=await purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06");
    const winner=(await db.query(`INSERT INTO parties (business_id,name,role) VALUES ($1,'کارفرمای یکپارچه','customer') RETURNING id`,[a.businessId])).rows[0].id;
    const crm=await import("../src/lib/crm-service");
    await crm.mergeCustomers(a.businessId,winner,a.clientId,{mergedBy:"مالک",mergedByUserId:a.actor.userId});
    const moved=(await purchases.listVendorPurchases(owner(a),a.projectId))[0];
    expect(moved).toMatchObject({party_id:winner,cost_id:booked.costId,status:"booked",amount_rial:"5000000"});
    expect((await service.loadAgencyReimbursableCost(a.businessId,booked.costId))?.partyId).toBe(winner);
    expect((await db.query(`SELECT row_id FROM crm_party_attribution_moves WHERE business_id=$1 AND table_name='agency_vendor_purchases'`,[a.businessId])).rows.map(r=>r.row_id)).toContain(q.id);
    expect(await balance(a,"2140")).toBe(5000000);
  });
  it("adopts the saved gross policy at booking, rather than inferring treatment from quoted spend", async () => {
    const a=await agency();const q=await quote(a);await approve(a,q.id);
    await service.saveAgencyCostPolicy({businessId:a.businessId,locationId:a.locationId,userId:a.actor.userId},{presentation:"gross"});
    const booked=await purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06");
    expect((await service.loadAgencyReimbursableCost(a.businessId,booked.costId))?.presentation).toBe("gross");
    expect(await balance(a,"1270")).toBe(0);
    expect(await balance(a,"5197")).toBe(-5000000);
    expect(await balance(a,"2140")).toBe(5000000);
  });
  it("enforces table RLS with a real non-bypass role, independently of application tenant predicates", async () => {
    const a=await agency(),b=await agency();const qa=await quote(a),qb=await quote(b);
    const role=`purchase_rls_${randomUUID().replaceAll("-","")}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT,UPDATE ON agency_vendor_purchases TO "${role}"`);
      await db.query(`SET ROLE "${role}"`);
      await db.query(`SELECT set_config('app.rls_bypass','',false),set_config('app.business_id',$1,false)`,[a.businessId]);
      expect((await db.query(`SELECT id FROM agency_vendor_purchases`)).rows.map(r=>r.id)).toEqual([qa.id]);
      expect((await db.query(`UPDATE agency_vendor_purchases SET quote_reference='tamper' WHERE id=$1`,[qb.id])).rowCount).toBe(0);
      await db.query(`SELECT set_config('app.business_id','',false)`);
      expect((await db.query(`SELECT id FROM agency_vendor_purchases`)).rows).toEqual([]);
    } finally {
      await db.query(`RESET ROLE`);
      await db.query(`SELECT set_config('app.business_id','',false)`);
      await db.query(`REVOKE ALL ON agency_vendor_purchases FROM "${role}"`);
      await db.query(`DROP ROLE "${role}"`);
    }
  });
  it("withdraws through the shared queue without leaving an approved or posted commitment", async () => {
    const a=await agency();const q=await quote(a);await purchases.submitVendorPurchase(owner(a),q.id);
    await purchases.decideVendorPurchaseApproval(owner(a),await approval(a,q.id),"cancelled");
    expect((await purchases.listVendorPurchases(owner(a),a.projectId))[0].status).toBe("draft");
    await purchases.submitVendorPurchase(owner(a),q.id);
    await purchases.decideVendorPurchaseApproval(await reviewer(a),await approval(a,q.id),"rejected");
    await expect(purchases.bookVendorPurchase(owner(a),q.id,"2026-10-06")).rejects.toThrow("invalid_purchase_state");
  });
});
