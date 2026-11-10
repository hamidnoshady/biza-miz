/**
 * §D's project P&L — pass-through and hours (issue #1128, wave 13).
 *
 * Wave 3 built the booked/posted spine and the ledger read behind it. This file tests
 * the two things wave 13 added, and the headline is the second one:
 *
 *   that a client's media money shows up **beside** the margin and never **inside** it.
 *
 * That is the whole of §D's net presentation arriving in a report. Account 1270 is an
 * asset, so the type-based revenue and cost sums both skip it — which made wave 3's P&L
 * *correct* and silent: an agency that buys media in a client's name had a margin that
 * ignored the media entirely, and nothing on the project said how much client money it
 * had handled. Counting it as an expense would destroy that agency's margin; counting
 * its recovery as revenue would inflate it. The same error in both directions at once.
 *
 * The mirror case is tested too: a **gross**-presentation cost debits 5197, an expense
 * account, and must land in `actualCostRial` and not in `passThrough`. The two figures
 * are disjoint by construction, and together they are the two halves §D's first sentence
 * asks to be tracked separately.
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
let commercial: typeof import("../src/lib/agency-commercial-service");
let costs: typeof import("../src/lib/agency-reimbursable-cost-service");
let invoicing: typeof import("../src/lib/retail-invoice-service");

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
  databaseName = `agency_pnl_${randomUUID().replaceAll("-", "")}`;

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
  commercial = await import("../src/lib/agency-commercial-service");
  costs = await import("../src/lib/agency-reimbursable-cost-service");
  invoicing = await import("../src/lib/retail-invoice-service");

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

type Owner = { businessId: string; actorUserId: string; actorName: string };

let seq = 0;

interface Fixture {
  businessId: string;
  locationId: string;
  owner: Owner;
  projectId: string;
  clientId: string;
}

/**
 * A real agency tenant through the product's own provisioning path, so its chart is the
 * trade's real one — 1270 for a client's reimbursable cost, 5197 for the agency's own
 * media cost, 4640–4670 for revenue. A hand-seeded chart would let this file and the
 * ledger drift apart and still pass.
 */
async function fixture(contractRial: number | null = 20_000_000): Promise<Fixture> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس سودآوری ${seq}`,
    ownerName: "مالک آژانس",
    email: `agency-pnl-${seq}-${randomUUID().slice(0, 6)}@example.test`,
    password: "correct-horse",
    subdomain: `agpnl${seq}${randomUUID().slice(0, 4)}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  const owner: Owner = {
    businessId: result.businessId,
    actorUserId: result.userId,
    actorName: "مالک آژانس",
  };

  // `owner_user_id` makes migration 0194's trigger add this member to
  // `workspace_members` as 'owner', which is what `requireProjectCapability` reads.
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
       VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
      [result.businessId, `کمپین نوروزی ${seq}`, result.userId],
    )
  ).rows[0].id;

  const clientId = (
    await db.query(
      `INSERT INTO parties (business_id, name, role, roles)
       VALUES ($1, $2, 'customer', ARRAY['customer']::text[]) RETURNING id`,
      [result.businessId, "کارفرما"],
    )
  ).rows[0].id;

  if (contractRial !== null) {
    // `contract_type = 'service'`: the loader excludes the four execution-side types,
    // because §D's contracted value is what the *client* agreed to pay.
    await db.query(
      `INSERT INTO workspace_contracts
         (business_id, project_id, party_id, title, contract_type, value_rial,
          start_date, end_date, status, created_by)
       VALUES ($1,$2,$3,'قرارداد کمپین','service',$4,'2026-03-21','2027-03-20','active',$5)`,
      [result.businessId, projectId, clientId, contractRial, result.userId],
    );
  }

  return { businessId: result.businessId, locationId: result.locationId, owner, projectId, clientId };
}

function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/**
 * Posted service revenue tagged to the project — what a milestone invoice produces.
 *
 * Through `withTenantTransaction` rather than a bare pool client, because
 * `createRetailInvoice` writes an order, its items, a balanced journal entry and a
 * domain event that must all commit together, and because RLS is fail-closed without
 * the tenant scope the wrapper establishes.
 */
async function billServiceRevenue(f: Fixture, amountRial: number): Promise<string> {
  const invoice = await dbLib.withTenantTransaction(f.businessId, (client) =>
    invoicing.createRetailInvoice(client, {
      businessId: f.businessId,
      locationId: f.locationId,
      industry: "advertising_agency",
      lines: [
        {
          kind: "service",
          description: "حق‌الزحمهٔ مدیریت کمپین",
          quantity: "1",
          unitPrice: amountRial,
          vatPercent: 0,
        },
      ],
      tenders: [{ method: "credit" }],
      customerId: f.clientId,
      businessDate: "2026-11-01",
      createdBy: f.owner.actorUserId,
      // What puts this invoice's entry on the project's P&L at all.
      projectId: f.projectId,
    }),
  );
  return invoice.orderId;
}

async function recordCost(f: Fixture, over: Record<string, unknown> = {}) {
  return withTenant(f.businessId, () =>
    costs.createAgencyReimbursableCost(
      f.businessId,
      { userId: f.owner.actorUserId, name: f.owner.actorName },
      {
        partyId: f.clientId,
        projectId: f.projectId,
        description: "خرید فضای تبلیغاتی",
        amountRial: 5_000_000,
        spentOn: "2026-11-01",
        settledBy: "payable",
        ...over,
      },
    ),
  );
}

async function pnl(f: Fixture) {
  const summary = await withTenant(f.businessId, () =>
    commercial.loadAgencyCommercial(f.owner, f.projectId),
  );
  return summary.report;
}

/** Seed state-valid purchase documents at scale; booking still uses the real engine. */
async function purchaseBatch(f: Fixture, count: number, amount: string, status = "approved") {
  const vendor = (await db.query(`INSERT INTO parties (business_id,name,role) VALUES ($1,'رسانه','supplier') RETURNING id`,[f.businessId])).rows[0].id;
  const prefix = randomUUID().slice(0,8);
  const rows = (await db.query<{id:string}>(`INSERT INTO agency_vendor_purchases
    (business_id,project_id,party_id,vendor_party_id,purchase_number,quote_reference,description,amount_rial,quoted_on,created_by)
    SELECT $1,$2,$3,$4,'VP-' || $7 || '-' || g,'Q-' || g,'رسانه',$5,'2026-10-01',$6
      FROM generate_series(1,$8::int) g RETURNING id`,
    [f.businessId,f.projectId,f.clientId,vendor,amount,f.owner.actorUserId,prefix,count])).rows;
  const ids=rows.map(r=>r.id);
  if(status !== "draft") {
    await db.query(`UPDATE agency_vendor_purchases SET status='submitted' WHERE id=ANY($1::uuid[])`,[ids]);
    const reviewer=(await db.query(`INSERT INTO users (business_id,role,full_name,email,password_hash)
      VALUES ($1,'manager','بازبین',$2,'x') RETURNING id`,[f.businessId,`${randomUUID()}@example.test`])).rows[0].id;
    await db.query(`INSERT INTO workspace_approvals (business_id,project_id,subject_type,subject_id,title,status,requested_by,decided_by,decided_at)
      SELECT $1,$2,'vendor_purchase',id,'خرید',$4,$3,$5,now() FROM agency_vendor_purchases WHERE id=ANY($6::uuid[])`,
      [f.businessId,f.projectId,f.owner.actorUserId,status === "submitted" ? "pending" : status,reviewer,ids]);
    if(status !== "submitted") await db.query(`UPDATE agency_vendor_purchases SET status=$2 WHERE id=ANY($1::uuid[])`,[ids,status]);
  }
  return ids;
}

/** A milestone carrying contracted hours, the only hours this product records. */
async function addMilestone(f: Fixture, title: string, hours: number | null, amountRial: number) {
  const n = (
    await db.query(
      `SELECT count(*)::int AS c FROM agency_billing_milestones WHERE business_id = $1`,
      [f.businessId],
    )
  ).rows[0].c;
  await db.query(
    `INSERT INTO agency_billing_milestones
       (business_id, project_id, milestone_number, kind, title, amount_rial, hours, status, created_by, created_by_name)
     VALUES ($1,$2,$3,'deliverable',$4,$5,$6,'draft',$7,$8)`,
    [
      f.businessId,
      f.projectId,
      `MS-${String(n + 1).padStart(3, "0")}`,
      title,
      amountRial,
      hours,
      f.owner.actorUserId,
      f.owner.actorName,
    ],
  );
}

/* --------------------------------------------------------------------- tests */

describe("§D's project P&L (issue #1128, wave 13)", () => {
  it("reports an untouched project as unknown rather than as a row of zeros", async () => {
    const f = await fixture();
    const report = await pnl(f);

    // The booked half is real immediately: a contract was signed.
    expect(report.booked.contractedRial).toBe(20_000_000);
    // The posted half is unknown, not zero — "nothing has posted" and "this project
    // earned nothing" are different claims, and only one of them is a fact here.
    expect(report.posted).toEqual({
      revenueRial: null,
      collectedRial: null,
      receivableRial: null,
      actualCostRial: null,
    });
    expect(report.commitments).toEqual({approvedVendorPurchaseRial:"0",approvedVendorPurchaseCount:0});
    expect(report.grossMarginRial).toBeNull();
    expect(report.grossMarginPercent).toBeNull();
    expect(report.passThrough).toEqual({ spentRial: null, rechargedRial: null, unrechargedRial: null });
    // No milestone states hours, which is not the same as a schedule estimated at zero.
    expect(report.hours.contractedHours).toBeNull();
    expect(report.hours.actualHours).toBeNull();
    expect(report.hours.revenuePerContractedHourRial).toBeNull();
  }, 180_000);

  it("keeps a client's media money beside the margin and never inside it", async () => {
    const f = await fixture();
    await billServiceRevenue(f, 10_000_000);

    const before = await pnl(f);
    expect(before.posted.revenueRial).toBe(10_000_000);
    expect(before.posted.actualCostRial).toBe(0);
    expect(before.grossMarginRial).toBe(10_000_000);

    // A net-presentation cost: the client's money, handled. It debits 1270, an asset.
    const cost = await recordCost(f, { presentation: "net", amountRial: 5_000_000 });
    expect(cost.accounts.debitCode).toBe("1270");

    const spent = await pnl(f);
    expect(spent.passThrough.spentRial).toBe(5_000_000);
    expect(spent.passThrough.unrechargedRial).toBe(5_000_000);
    // The assertion this wave exists for: the margin did not move, and the cost is not
    // in it. An agency buying media in a client's name earns a fee, not a loss.
    expect(spent.posted.actualCostRial).toBe(0);
    expect(spent.grossMarginRial).toBe(10_000_000);
    expect(spent.grossMarginPercent).toBe(100);

    // Billing it back credits 1270 — also not revenue, also not a change to margin.
    await withTenant(f.businessId, () =>
      costs.rechargeAgencyCosts(
        f.businessId,
        { userId: f.owner.actorUserId, name: f.owner.actorName },
        { costIds: [cost.id], locationId: f.locationId },
      ),
    );

    const after = await pnl(f);
    expect(after.passThrough.spentRial).toBe(5_000_000);
    expect(after.passThrough.rechargedRial).toBe(5_000_000);
    expect(after.passThrough.unrechargedRial).toBe(0);
    // Recovering a client's own money is not a sale, so revenue and margin are unmoved
    // by the recharge too — the same rule on the other side of the account.
    expect(after.posted.revenueRial).toBe(10_000_000);
    expect(after.grossMarginRial).toBe(10_000_000);
    expect(after.grossMarginPercent).toBe(100);
  }, 180_000);

  it("counts a gross-presentation cost as the agency's own, and not as pass-through", async () => {
    const f = await fixture();
    await billServiceRevenue(f, 10_000_000);

    const cost = await recordCost(f, { presentation: "gross", amountRial: 2_000_000 });
    expect(cost.accounts.debitCode).toBe("5197");

    const report = await pnl(f);
    // Inside the margin, because under gross this *is* the agency's cost of sale.
    expect(report.posted.actualCostRial).toBe(2_000_000);
    expect(report.grossMarginRial).toBe(8_000_000);
    expect(report.grossMarginPercent).toBe(80);
    // And not in pass-through: the two figures are disjoint, so a reader adding them
    // gets the project's whole outlay without counting any money twice.
    expect(report.passThrough.spentRial).toBe(0);
    expect(report.passThrough.unrechargedRial).toBe(0);
  }, 180_000);

  it("separates the two treatments on one project, which is §D's first sentence", async () => {
    const f = await fixture();
    await billServiceRevenue(f, 10_000_000);
    await recordCost(f, { presentation: "net", amountRial: 5_000_000, description: "رسانهٔ کارفرما" });
    await recordCost(f, { presentation: "gross", amountRial: 2_000_000, description: "تولید خود آژانس" });

    const report = await pnl(f);
    // Media spend and the agency's own production cost, tracked separately — and the
    // margin is computed on the agency's own money only.
    expect(report.passThrough.spentRial).toBe(5_000_000);
    expect(report.posted.actualCostRial).toBe(2_000_000);
    expect(report.grossMarginRial).toBe(8_000_000);
  }, 180_000);

  it("follows the invoice when a recharge is voided, rather than a stored flag", async () => {
    const f = await fixture();
    await billServiceRevenue(f, 10_000_000);
    const cost = await recordCost(f, { presentation: "net", amountRial: 3_000_000 });
    const recharge = await withTenant(f.businessId, () =>
      costs.rechargeAgencyCosts(
        f.businessId,
        { userId: f.owner.actorUserId, name: f.owner.actorName },
        { costIds: [cost.id], locationId: f.locationId },
      ),
    );
    expect((await pnl(f)).passThrough.unrechargedRial).toBe(0);

    // What `retail-invoice-void-service.ts` does to the order: flip the status and keep
    // the row. Its reversing entry is its own work and is tested there; what this wave
    // owes is that the P&L and the register both follow the order rather than a flag.
    await db.query(`UPDATE orders SET status = 'voided' WHERE id = $1`, [recharge.orderId]);

    // The cost is billable again, derived from the invoice's live status with nothing
    // written to the register — wave 11's decision 65, seen from the P&L's side.
    const reloaded = await costs.loadAgencyReimbursableCost(f.businessId, cost.id);
    expect(reloaded?.recharged).toBe(false);

    // And the project's outstanding pass-through is still the honest figure: the 1270
    // credit the recharge made is still in the ledger, so `rechargedRial` does not
    // change until something reverses it. Asserting what the ledger *says* rather than
    // what we wish it said is the point of reading it.
    const after = await pnl(f);
    expect(after.passThrough.spentRial).toBe(3_000_000);
    expect(after.passThrough.rechargedRial).toBe(3_000_000);
    expect(after.passThrough.unrechargedRial).toBe(0);
  }, 180_000);

  it("reports contracted hours and refuses to invent worked ones", async () => {
    const f = await fixture();
    await addMilestone(f, "طراحی هویت بصری", 40, 8_000_000);
    await addMilestone(f, "مدیریت کمپین", 20.5, 4_000_000);
    // A fixed-price milestone states no hours and must not read as zero hours.
    await addMilestone(f, "تحویل نهایی", null, 8_000_000);

    const report = await pnl(f);
    expect(report.hours.contractedHours).toBe(60.5);
    // Typed `null`, not 0: nothing in this product records hours worked, and a screen
    // must render «ثبت نشده» rather than a measurement nobody took.
    expect(report.hours.actualHours).toBeNull();

    // No revenue yet, so the ratio is unknown rather than zero.
    expect(report.hours.revenuePerContractedHourRial).toBeNull();

    await billServiceRevenue(f, 12_100_000);
    const earned = await pnl(f);
    expect(earned.hours.revenuePerContractedHourRial).toBe(200_000);
  }, 180_000);

  it("keeps one project's P&L out of another's", async () => {
    const f = await fixture();
    const other = await fixture();
    await billServiceRevenue(f, 10_000_000);
    await recordCost(f, { presentation: "net", amountRial: 5_000_000 });

    const mine = await pnl(f);
    const theirs = await pnl(other);
    expect(mine.posted.revenueRial).toBe(10_000_000);
    expect(mine.passThrough.spentRial).toBe(5_000_000);
    // The other project has its own contract and none of this project's money.
    expect(theirs.posted.revenueRial).toBeNull();
    expect(theirs.passThrough).toEqual({ spentRial: null, rechargedRial: null, unrechargedRial: null });
  }, 180_000);
});

describe("whole-project vendor commitments", () => {
  it("aggregates beyond the 200-row register without multiplying ledger facts or including unapproved quotes", async () => {
    const f=await fixture();
    await purchaseBatch(f,201,"11");
    for(const status of ["draft","submitted","rejected"]) await purchaseBatch(f,1,"999999",status);
    await billServiceRevenue(f,10000000);
    await recordCost(f,{presentation:"net"});
    await recordCost(f,{presentation:"gross",amountRial:2000000});
    const report=await pnl(f);
    expect(report.commitments).toEqual({approvedVendorPurchaseRial:"2211",approvedVendorPurchaseCount:201});
    expect(report.posted.revenueRial).toBe(10000000);
    expect(report.posted.actualCostRial).toBe(2000000);
    expect(report.passThrough.spentRial).toBe(5000000);
    expect(report.grossMarginRial).toBe(8000000);
    const purchases=await import("../src/lib/agency-vendor-purchase-service");
    expect(await purchases.listVendorPurchases(f.owner,f.projectId)).toHaveLength(200);
  },180000);
  it("moves a booked net purchase out of commitments and into pass-through, never margin", async () => {
    const f=await fixture();const [id]=await purchaseBatch(f,1,"5000000");
    const before=await pnl(f);
    expect(before.commitments.approvedVendorPurchaseRial).toBe("5000000");
    expect(before.posted.actualCostRial).toBeNull();expect(before.grossMarginRial).toBeNull();
    const purchases=await import("../src/lib/agency-vendor-purchase-service");
    await purchases.bookVendorPurchase(f.owner,id,"2026-11-01");
    const after=await pnl(f);
    expect(after.commitments).toEqual({approvedVendorPurchaseRial:"0",approvedVendorPurchaseCount:0});
    expect(after.passThrough.spentRial).toBe(5000000);expect(after.posted.actualCostRial).toBe(0);
    expect(after.grossMarginRial).toBe(0);
  },180000);
  it("moves a gross purchase into actual expense once while leaving other commitments outside margin", async () => {
    const f=await fixture();const [id]=await purchaseBatch(f,1,"5000000");
    await purchaseBatch(f,1,"2000000");await billServiceRevenue(f,10000000);
    await costs.saveAgencyCostPolicy({businessId:f.businessId,locationId:f.locationId,userId:f.owner.actorUserId},{presentation:"gross"});
    const purchases=await import("../src/lib/agency-vendor-purchase-service");
    await purchases.bookVendorPurchase(f.owner,id,"2026-11-01");
    const report=await pnl(f);
    expect(report.commitments).toEqual({approvedVendorPurchaseRial:"2000000",approvedVendorPurchaseCount:1});
    expect(report.posted.actualCostRial).toBe(5000000);expect(report.passThrough.spentRial).toBe(0);
    expect(report.grossMarginRial).toBe(5000000);
  },180000);
  it("sees the old commitment before a booking commits and posted cost after it, never a half-booked state", async () => {
    const f=await fixture();const [id]=await purchaseBatch(f,1,"5000000");
    await costs.saveAgencyCostPolicy({businessId:f.businessId,locationId:f.locationId,userId:f.owner.actorUserId},{presentation:"gross"});
    const purchases=await import("../src/lib/agency-vendor-purchase-service");
    let ready!:()=>void,release!:()=>void;
    const reached=new Promise<void>(resolve=>{ready=resolve;});
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const transaction=dbLib.withTenantTransaction(f.businessId,async()=>{
      await purchases.bookVendorPurchase(f.owner,id,"2026-11-01");ready();await hold;
    });
    await Promise.race([reached,transaction]);
    try {
      const before=await pnl(f);
      expect(before.commitments.approvedVendorPurchaseRial).toBe("5000000");
      expect(before.posted.actualCostRial).toBeNull();
    } finally { release(); }
    await transaction;
    const after=await pnl(f);
    expect(after.commitments.approvedVendorPurchaseRial).toBe("0");
    expect(after.posted.actualCostRial).toBe(5000000);
  },180000);
  it("keeps an aggregate above safe JavaScript integers exact as decimal rial text", async () => {
    const f=await fixture();await purchaseBatch(f,1,"9000000000000000");await purchaseBatch(f,1,"8999999999999999");
    expect((await pnl(f)).commitments).toEqual({approvedVendorPurchaseRial:"17999999999999999",approvedVendorPurchaseCount:2});
  },180000);
  it("separates projects/clients in one tenant, foreign tenants and non-members", async () => {
    const f=await fixture(),foreign=await fixture();
    const projectId=(await db.query(`INSERT INTO ai_projects (business_id,name,created_by,owner_user_id)
      VALUES ($1,'کارفرمای دیگر',$2::text,$2::uuid) RETURNING id`,[f.businessId,f.owner.actorUserId])).rows[0].id;
    const clientId=(await db.query(`INSERT INTO parties (business_id,name,role) VALUES ($1,'مشتری دیگر','customer') RETURNING id`,[f.businessId])).rows[0].id;
    const other={...f,projectId,clientId};
    await purchaseBatch(f,1,"1000");await purchaseBatch(other,1,"2000");await purchaseBatch(foreign,1,"3000");
    expect((await pnl(f)).commitments.approvedVendorPurchaseRial).toBe("1000");
    expect((await pnl(other)).commitments.approvedVendorPurchaseRial).toBe("2000");
    expect((await pnl(foreign)).commitments.approvedVendorPurchaseRial).toBe("3000");
    await expect(commercial.loadAgencyCommercial(foreign.owner,f.projectId)).rejects.toThrow("project_not_found");
    await expect(commercial.loadAgencyCommercial({...f.owner,actorUserId:foreign.owner.actorUserId},f.projectId)).rejects.toThrow("project_not_found");
  },180000);
});
