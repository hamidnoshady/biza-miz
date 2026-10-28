/**
 * §D's billing documents against a real database (issue #1128).
 *
 * The pure half of this feature — the two status chains, the act catalogue, the
 * schedule splits, the percentage arithmetic — is pinned by
 * `src/lib/agency-commercial.test.ts`, which needs no database. What is here is
 * only what a database can prove:
 *
 *   1. A schedule is laid out from an engagement's base and numbered per
 *      project, and a second schedule over a live one is refused. Hourly work
 *      lays out nothing, because there is nothing to lay out before the time is
 *      tracked.
 *   2. A percentage is resolved at *invoice* time against the engagement's
 *      revised value, and never at rest: the row keeps `percent`, the contract
 *      keeps the value the client signed, and the only thing an approved change
 *      request moves is the revised value the next percentage is taken of.
 *   3. Invoicing a milestone goes through the invoice engine — an `orders` row,
 *      a `payments` row, one balanced journal entry credited to the revenue
 *      account the milestone named — and that entry carries the project's own
 *      dimension, which is what makes §D's project P&L one read rather than a
 *      reconciliation.
 *   4. Approving is not billing. An approver says the milestone may be billed;
 *      the invoice is a separate act, so approving alone leaves the ledger and
 *      the order book untouched.
 *   5. The register files a real queue row on the shared approval engine, and
 *      the engine's own rule holds: whoever sent a request may not decide it.
 *      `submit` is an ordinary edit precisely because that rule is what stops it
 *      being an approval.
 *   6. Migration 0260's guards are database facts, not service-side courtesies:
 *      a submitted row is frozen, a percentage and an amount cannot coexist, a
 *      revenue code the tenant's chart does not have is refused, and only a
 *      draft can be deleted.
 *   7. Another industry is refused rather than served an agency default.
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
let workspaceLib: typeof import("../src/lib/workspace");

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
  databaseName = `agency_commercial_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Imported after the environment points at the throwaway database, so every
  // module below binds its pool to it and not to the runner's default.
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  commercial = await import("../src/lib/agency-commercial-service");
  workspaceLib = await import("../src/lib/workspace");

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

let seq = 0;

type Owner = { businessId: string; actorUserId: string; actorName: string };

/**
 * A real agency tenant: provisioned through the product's own path, so its chart
 * of accounts is the trade's real one (4640–4670 on the revenue side, 1200 for
 * the receivable an on-account invoice raises) rather than a list this file
 * happens to seed. A hand-seeded chart would let the two drift apart and the
 * test would still pass.
 */
async function provisionAgency(): Promise<{
  businessId: string;
  locationId: string;
  owner: Owner;
}> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس تبلیغاتی ${seq}`,
    ownerName: "مالک آژانس",
    email: `agency-owner-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agency${seq}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    owner: {
      businessId: result.businessId,
      actorUserId: result.userId,
      actorName: "مالک آژانس",
    },
  };
}

/** The tenant scope every service call runs in — RLS is fail-closed without it. */
function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

async function createProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

/** The client, on the one identity table (`parties`, formerly `customers`). */
async function createClient(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, 'customer', ARRAY['customer']::text[]) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/**
 * The engagement a schedule bills against.
 *
 * `contract_type` is `'service'` on purpose: the loader excludes the four
 * execution-side types (contractor, supplier, vendor, subcontractor), because
 * §D's contracted value is what the *client* agreed to pay. A subcontract in
 * this column would report the agency's own payable as its revenue.
 */
async function createEngagement(
  businessId: string,
  projectId: string,
  clientId: string,
  title: string,
  valueRial: number,
  createdBy: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workspace_contracts
       (business_id, project_id, party_id, title, contract_type, value_rial,
        start_date, end_date, status, created_by)
     VALUES ($1, $2, $3, $4, 'service', $5, '2026-03-21', '2027-03-20', 'active', $6)
     RETURNING id`,
    [businessId, projectId, clientId, title, valueRial, createdBy],
  );
  return rows[0].id;
}

/**
 * A second actor on the project.
 *
 * The approval engine refuses a self-approval, so every test that decides a
 * request needs somebody other than the person who sent it — which is also the
 * shape the feature is for: the project manager lays a schedule out and sends
 * it, and somebody else agrees it.
 */
async function addProjectManager(
  businessId: string,
  projectId: string,
  name: string,
  role: "manager" | "viewer" = "manager",
): Promise<Owner> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
    [businessId, name, `${name}-${randomUUID().slice(0, 8)}@example.test`],
  );
  const userId = rows[0].id;
  await db.query(
    `INSERT INTO workspace_members (project_id, user_id, role, added_by)
     VALUES ($1, $2, $3, 'test')`,
    [projectId, userId, role],
  );
  return { businessId, actorUserId: userId, actorName: name };
}

/** debit − credit per account code, over the whole live ledger of a business. */
async function balances(businessId: string): Promise<Record<string, bigint>> {
  const { rows } = await db.query<{ code: string; net: string }>(
    `SELECT a.code, SUM(jl.debit - jl.credit)::text AS net
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
      GROUP BY a.code`,
    [businessId],
  );
  return Object.fromEntries(rows.map((r) => [r.code, BigInt(r.net)]));
}

/** The one pending queue row a subject filed, if it filed one. */
async function pendingApprovalId(
  businessId: string,
  subjectType: string,
  subjectId: string,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workspace_approvals
      WHERE business_id = $1 AND subject_type = $2 AND subject_id = $3 AND status = 'pending'`,
    [businessId, subjectType, subjectId],
  );
  return rows[0]?.id ?? null;
}

/** The signed value, read straight from the contract row. */
async function signedContractValue(businessId: string, contractId: string): Promise<bigint> {
  const { rows } = await db.query<{ value_rial: string }>(
    "SELECT value_rial::text FROM workspace_contracts WHERE business_id = $1 AND id = $2",
    [businessId, contractId],
  );
  return BigInt(rows[0].value_rial);
}

/** One agency, one project, one signed client engagement, two people on it. */
async function agencyWithEngagement(valueRial = 100_000_000) {
  const { businessId, locationId, owner } = await provisionAgency();
  const projectId = await createProject(businessId, owner.actorUserId, "کمپین نوروزی ۱۴۰۵");
  const clientId = await createClient(businessId, "شرکت پدیده");
  const contractId = await createEngagement(
    businessId,
    projectId,
    clientId,
    "قرارداد مدیریت کمپین",
    valueRial,
    owner.actorUserId,
  );
  // The provisioned owner is the business's owner but not automatically a member
  // of this project: membership is what `requireProjectCapability` reads, and
  // seeding it is what makes the gate under test a real gate.
  await db.query(
    `INSERT INTO workspace_members (project_id, user_id, role, added_by)
     VALUES ($1, $2, 'manager', 'test')`,
    [projectId, owner.actorUserId],
  );
  const approver = await addProjectManager(businessId, projectId, "مدیر اجرایی");
  return { businessId, locationId, owner, approver, projectId, clientId, contractId };
}

/** A single deliverable milestone, due on a date, ready to be sent. */
async function addMilestone(
  owner: Owner,
  projectId: string,
  input: { title?: string; percent?: number; amountRial?: number; revenueCode?: string } = {},
) {
  return withTenant(owner.businessId, () =>
    commercial.createAgencyMilestone(owner, projectId, {
      title: input.title ?? "مرحلهٔ تحویل اول",
      kind: "deliverable",
      percent: input.percent,
      amountRial: input.amountRial,
      revenueCode: input.revenueCode,
      dueDate: "2026-06-01",
    }),
  );
}

/** Sends a milestone and hands back the queue row it filed. */
async function submitMilestone(owner: Owner, milestoneId: string): Promise<string> {
  await withTenant(owner.businessId, () =>
    commercial.applyMilestoneAction(owner, milestoneId, "submit", {}),
  );
  const approvalId = await pendingApprovalId(owner.businessId, "billing_milestone", milestoneId);
  if (!approvalId) throw new Error("submitting a milestone filed no approval row");
  return approvalId;
}

describe("an agency's billing schedule", () => {
  it("lays a fixed-price engagement out as a deposit and a final settlement, numbered per project", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const summary = await withTenant(fixture.businessId, () =>
      commercial.createAgencySchedule(fixture.owner, fixture.projectId, {
        base: "fixed_price",
        depositPercent: 30,
      }),
    );

    expect(summary.milestones.map((m) => m.milestoneNumber)).toEqual(["MS-001", "MS-002"]);
    expect(summary.milestones.map((m) => m.kind)).toEqual(["deposit", "final"]);
    expect(summary.milestones.map((m) => m.percent)).toEqual([30, 70]);
    expect(summary.milestones.every((m) => m.status === "draft")).toBe(true);
    // Resolved against the signed value, but not written down: the rows still
    // hold percentages, and these figures are what they mean today.
    expect(summary.milestones.map((m) => m.billableAmountRial)).toEqual([30_000_000, 70_000_000]);
    expect(summary.schedule.count).toBe(2);
    expect(summary.schedule.unallocatedPercent).toBe(0);
    expect(summary.report.booked.contractedRial).toBe(100_000_000);
    expect(summary.report.booked.scheduledRial).toBe(100_000_000);
    expect(summary.report.booked.unscheduledRial).toBe(0);
  });

  it("refuses a second schedule over a live one, and lays none out for hourly work", async () => {
    const fixture = await agencyWithEngagement();
    await withTenant(fixture.businessId, () =>
      commercial.createAgencySchedule(fixture.owner, fixture.projectId, { base: "fixed_price" }),
    );

    await expect(
      withTenant(fixture.businessId, () =>
        commercial.createAgencySchedule(fixture.owner, fixture.projectId, { base: "milestone" }),
      ),
    ).rejects.toMatchObject({ code: "schedule_exists" });

    // An hourly engagement has nothing to lay out in advance: it bills a period
    // once that period's hours and pass-through cost are known. Twelve empty
    // rows would be twelve booked figures with nothing behind them.
    const hourly = await agencyWithEngagement();
    await expect(
      withTenant(hourly.businessId, () =>
        commercial.createAgencySchedule(hourly.owner, hourly.projectId, { base: "hourly" }),
      ),
    ).rejects.toMatchObject({ code: "schedule_empty" });
  });

  it("numbers each project's series from MS-001, because the register is the project's", async () => {
    const fixture = await agencyWithEngagement();
    await withTenant(fixture.businessId, () =>
      commercial.createAgencySchedule(fixture.owner, fixture.projectId, {
        base: "fixed_price",
        depositPercent: 30,
      }),
    );

    const secondProject = await createProject(
      fixture.businessId,
      fixture.owner.actorUserId,
      "کمپین پاییزه",
    );
    await db.query(
      `INSERT INTO workspace_members (project_id, user_id, role, added_by)
       VALUES ($1, $2, 'manager', 'test')`,
      [secondProject, fixture.owner.actorUserId],
    );
    const summary = await withTenant(fixture.businessId, () =>
      commercial.createAgencySchedule(fixture.owner, secondProject, { base: "fixed_price" }),
    );
    expect(summary.milestones.map((m) => m.milestoneNumber)).toEqual(["MS-001"]);
  });

  it("refuses another industry rather than serving it an agency default", async () => {
    seq += 1;
    const other = await provisioning.provisionBusiness({
      businessName: `کافه ${seq}`,
      ownerName: "مالک کافه",
      email: `cafe-owner-${seq}@example.test`,
      password: "correct-horse",
      subdomain: `cafe${seq}`,
      industry: "food_service",
      seedChartOfAccounts: true,
    });
    const owner: Owner = {
      businessId: other.businessId,
      actorUserId: other.userId,
      actorName: "مالک کافه",
    };
    await expect(
      withTenant(other.businessId, () =>
        commercial.createAgencySchedule(owner, randomUUID(), { base: "fixed_price" }),
      ),
    ).rejects.toMatchObject({ code: "industry_mismatch" });
  });
});

describe("a percentage milestone", () => {
  it("is resolved at invoice time against the revised value, and is never written down at rest", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const milestone = await addMilestone(fixture.owner, fixture.projectId, {
      title: "تولید ویدیو تیزر",
      percent: 30,
      revenueCode: "4650",
    });
    expect(milestone.billableAmountRial).toBe(30_000_000);

    // A change the client approves: more money, and a schedule that moves.
    const changeRequest = await withTenant(fixture.businessId, () =>
      commercial.createAgencyChangeRequest(fixture.owner, fixture.projectId, {
        title: "افزودن یک تیزر ۱۵ ثانیه‌ای",
        description: "یک تیزر additional برای پخش در تلویزیون",
        reason: "کارفرما پس از دیدن اتود اول خواستار نسخهٔ دوم شد",
        amountRial: 20_000_000,
        scheduleImpactDays: 5,
      }),
    );
    await withTenant(fixture.businessId, () =>
      commercial.applyChangeRequestAction(fixture.owner, changeRequest.id, "price", {
        amountRial: 20_000_000,
      }),
    );
    await withTenant(fixture.businessId, () =>
      commercial.applyChangeRequestAction(fixture.owner, changeRequest.id, "submit", {}),
    );
    const approvalId = await pendingApprovalId(
      fixture.businessId,
      "change_request",
      changeRequest.id,
    );
    expect(approvalId).not.toBeNull();
    const decided = await withTenant(fixture.businessId, () =>
      commercial.decideChangeRequestApproval(fixture.approver, approvalId!, "approved"),
    );
    expect(decided.applied).toBe(true);

    const after = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyCommercial(fixture.owner, fixture.projectId),
    );
    const reloaded = after.milestones.find((m) => m.id === milestone.id)!;
    // The percentage is still a percentage, and it now means more money.
    expect(reloaded.percent).toBe(30);
    expect(reloaded.billableAmountRial).toBe(36_000_000);
    expect(after.engagement.contractedRial).toBe(100_000_000);
    expect(after.engagement.approvedChangeRial).toBe(20_000_000);
    expect(after.engagement.revisedRial).toBe(120_000_000);
    expect(after.report.booked.revisedContractRial).toBe(120_000_000);
    // What the client signed is a fact about a document, and nothing here
    // rewrites it — the revised value is a second, separate figure.
    expect(await signedContractValue(fixture.businessId, fixture.contractId)).toBe(100_000_000n);
    // Only an approved or implemented change counts; the row says which it is.
    const cr = after.changeRequests.find((c) => c.id === changeRequest.id)!;
    expect(cr.countedInValue).toBe(true);
    expect(cr.approvedAmountRial).toBe(20_000_000);
  });

  it("refuses a change request with no amount, and takes a descope as a negative figure", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const draft = await withTenant(fixture.businessId, () =>
      commercial.createAgencyChangeRequest(fixture.owner, fixture.projectId, {
        title: "حذف یک تحویل‌شدنی",
        description: "کارفرما یکی از اقلام را از دامنه بیرون برد",
        reason: "تغییر در بودجهٔ کارفرما",
      }),
    );
    await expect(
      withTenant(fixture.businessId, () =>
        commercial.applyChangeRequestAction(fixture.owner, draft.id, "price", {}),
      ),
    ).rejects.toMatchObject({ code: "change_request_amount_required" });

    // A descope is a negative amount rather than a second column, so the
    // register cannot hold two figures that have to be kept equal by hand.
    await withTenant(fixture.businessId, () =>
      commercial.applyChangeRequestAction(fixture.owner, draft.id, "price", {
        amountRial: -15_000_000,
      }),
    );
    await withTenant(fixture.businessId, () =>
      commercial.applyChangeRequestAction(fixture.owner, draft.id, "submit", {}),
    );
    const approvalId = await pendingApprovalId(fixture.businessId, "change_request", draft.id);
    await withTenant(fixture.businessId, () =>
      commercial.decideChangeRequestApproval(fixture.approver, approvalId!, "approved"),
    );
    const after = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyCommercial(fixture.owner, fixture.projectId),
    );
    expect(after.engagement.revisedRial).toBe(85_000_000);
    expect(await signedContractValue(fixture.businessId, fixture.contractId)).toBe(100_000_000n);
  });
});

describe("a milestone's journey to an invoice", () => {
  it("approving does not bill: an approver who may not take payments cannot take them by approving", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    const approvalId = await submitMilestone(fixture.owner, milestone.id);

    const decided = await withTenant(fixture.businessId, () =>
      commercial.decideMilestoneApproval(fixture.approver, approvalId, "approved"),
    );
    expect(decided.applied).toBe(true);
    expect(decided.milestoneId).toBe(milestone.id);

    const after = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyMilestone(fixture.owner, milestone.id),
    );
    expect(after.status).toBe("approved");
    expect(after.invoiceOrderId).toBeNull();

    // Nothing was sold, nothing was posted: the approval said "this may be
    // billed", and billing is its own act with its own permissions.
    const { rows: orders } = await db.query(
      "SELECT id FROM orders WHERE business_id = $1",
      [fixture.businessId],
    );
    expect(orders).toHaveLength(0);
    const { rows: entries } = await db.query(
      "SELECT id FROM journal_entries WHERE business_id = $1 AND project_id = $2",
      [fixture.businessId, fixture.projectId],
    );
    expect(entries).toHaveLength(0);
    const summary = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyCommercial(fixture.owner, fixture.projectId),
    );
    expect(summary.report.booked.invoicedRial).toBe(0);
    expect(summary.report.booked.scheduledRial).toBe(30_000_000);
    expect(summary.report.posted.revenueRial).toBe(0);
  });

  it("bills through the invoice engine, and the entry carries the project's own dimension", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const milestone = await addMilestone(fixture.owner, fixture.projectId, {
      title: "رتینر مدیریت کمپین — خرداد",
      percent: 30,
      revenueCode: "4640",
    });
    const approvalId = await submitMilestone(fixture.owner, milestone.id);
    await withTenant(fixture.businessId, () =>
      commercial.decideMilestoneApproval(fixture.approver, approvalId, "approved"),
    );

    const invoiced = await withTenant(fixture.businessId, () =>
      commercial.applyMilestoneAction(fixture.owner, milestone.id, "invoice", {
        locationId: fixture.locationId,
      }),
    );
    expect(invoiced.status).toBe("invoiced");
    expect(invoiced.invoiceOrderId).not.toBeNull();
    // The invoice's own figure, not today's reading of the percentage: a
    // percentage resolved now is not what was billed then.
    expect(invoiced.billedAmountRial).toBe(30_000_000);
    expect(invoiced.billableAmountRial).toBeNull();

    // An ordinary service invoice: one `orders` row, on account with the client.
    const { rows: orders } = await db.query<{ id: string; total: string; tax: string }>(
      "SELECT id, total::text, tax::text FROM orders WHERE business_id = $1",
      [fixture.businessId],
    );
    expect(orders).toHaveLength(1);
    expect(BigInt(orders[0].total)).toBe(30_000_000n);
    expect(BigInt(orders[0].tax)).toBe(0n);
    const { rows: payments } = await db.query<{ method: string; amount: string }>(
      "SELECT method, amount::text FROM payments WHERE order_id = $1",
      [orders[0].id],
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].method).toBe("credit");
    expect(BigInt(payments[0].amount)).toBe(30_000_000n);

    // One balanced entry, credited to the account the milestone named, and —
    // the point of §D's project P&L — tagged with the project.
    const { rows: entries } = await db.query<{ id: string; posting_kind: string; project_id: string }>(
      "SELECT id, posting_kind, project_id::text FROM journal_entries WHERE business_id = $1",
      [fixture.businessId],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].project_id).toBe(fixture.projectId);
    expect(entries[0].posting_kind).toBe("service_sale_revenue");

    const books = await balances(fixture.businessId);
    expect(books["1200"]).toBe(30_000_000n); // the receivable an agency invoice raises
    expect(books["4640"]).toBe(-30_000_000n); // campaign management revenue
    expect(Object.values(books).reduce((a, b) => a + b, 0n)).toBe(0n);

    // Booked and posted stay two different readings of the same project.
    const summary = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyCommercial(fixture.owner, fixture.projectId),
    );
    expect(summary.report.booked.invoicedRial).toBe(30_000_000);
    expect(summary.report.booked.scheduledRial).toBe(0);
    expect(summary.report.posted.revenueRial).toBe(30_000_000);
    // On account, so it is owed and not collected: §D's client receivables.
    expect(summary.report.posted.receivableRial).toBe(30_000_000);
    expect(summary.report.posted.collectedRial).toBe(0);
    expect(summary.report.posted.actualCostRial).toBe(0);
    expect(summary.report.grossMarginRial).toBe(30_000_000);
    expect(summary.report.grossMarginPercent).toBe(100);
  });

  it("refuses to bill a milestone whose engagement has no client to bill", async () => {
    const { businessId, locationId, owner } = await provisionAgency();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژه بدون کارفرما");
    await db.query(
      `INSERT INTO workspace_members (project_id, user_id, role, added_by)
       VALUES ($1, $2, 'manager', 'test')`,
      [projectId, owner.actorUserId],
    );
    // No contract at all: a percentage then has no value to be taken of, and an
    // invoice then has nobody to be raised against.
    const milestone = await withTenant(businessId, () =>
      commercial.createAgencyMilestone(owner, projectId, {
        title: "مرحلهٔ اول",
        kind: "deliverable",
        amountRial: 10_000_000,
        dueDate: "2026-06-01",
      }),
    );
    const approver = await addProjectManager(businessId, projectId, "مدیر اجرایی");
    const approvalId = await submitMilestone(owner, milestone.id);
    await withTenant(businessId, () =>
      commercial.decideMilestoneApproval(approver, approvalId, "approved"),
    );
    await expect(
      withTenant(businessId, () =>
        commercial.applyMilestoneAction(owner, milestone.id, "invoice", { locationId }),
      ),
    ).rejects.toMatchObject({ code: "customer_required" });
  });
});

describe("the queue row a register files", () => {
  it("refuses the person who sent a request deciding it themselves", async () => {
    const fixture = await agencyWithEngagement();
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    const approvalId = await submitMilestone(fixture.owner, milestone.id);

    // `submit` is an ordinary edit — the author's own act — and that is only
    // safe because this holds. An approval you can grant yourself is
    // decorative; a billing approval you can grant yourself is worse.
    await expect(
      withTenant(fixture.businessId, () =>
        commercial.decideMilestoneApproval(fixture.owner, approvalId, "approved"),
      ),
    ).rejects.toMatchObject({ code: "self_approval_forbidden" });

    // Somebody else on the project may, and the row still moves exactly once.
    const decided = await withTenant(fixture.businessId, () =>
      commercial.decideMilestoneApproval(fixture.approver, approvalId, "approved"),
    );
    expect(decided.applied).toBe(true);
    const again = await withTenant(fixture.businessId, () =>
      commercial.decideMilestoneApproval(fixture.approver, approvalId, "rejected"),
    );
    expect(again.applied).toBe(false);
  });

  it("returns a withdrawn request to where its author can edit and send it again", async () => {
    const fixture = await agencyWithEngagement();
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    const approvalId = await submitMilestone(fixture.owner, milestone.id);

    const withdrawn = await withTenant(fixture.businessId, () =>
      commercial.decideMilestoneApproval(fixture.owner, approvalId, "cancelled"),
    );
    expect(withdrawn.applied).toBe(true);

    const after = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyMilestone(fixture.owner, milestone.id),
    );
    // Not stranded in `submitted`: the freeze that protects an approver from a
    // changing row also protects the row from its own author, so without this
    // move a request nobody decides could never be corrected.
    expect(after.status).toBe("draft");
    expect(after.actions.map((a) => a.action)).toContain("submit");

    const edited = await withTenant(fixture.businessId, () =>
      commercial.updateAgencyMilestone(fixture.owner, milestone.id, { percent: 40 }),
    );
    expect(edited.percent).toBe(40);
  });
});

describe("migration 0260's guards", () => {
  it("freezes a submitted row's content, and refuses a percentage and an amount together", async () => {
    const fixture = await agencyWithEngagement();
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    await submitMilestone(fixture.owner, milestone.id);

    // What an approver is reading cannot change underneath them.
    await expect(
      db.query("UPDATE agency_billing_milestones SET title = 'عنوان دیگر' WHERE id = $1", [
        milestone.id,
      ]),
    ).rejects.toThrow();

    // The status chain itself still moves — that is the whole point of the
    // partial freeze — and so does the pointer to the invoice.
    await expect(
      db.query("UPDATE agency_billing_milestones SET percent = 40 WHERE id = $1", [milestone.id]),
    ).rejects.toThrow();

    // Exactly one of a percentage or an amount, so a row can never carry two
    // figures that have to be kept equal by hand.
    await expect(
      db.query(
        `INSERT INTO agency_billing_milestones
           (business_id, project_id, milestone_number, title, percent, amount_rial)
         VALUES ($1, $2, 'MS-900', 'مرحلهٔ نامعتبر', 30, 1000000)`,
        [fixture.businessId, fixture.projectId],
      ),
    ).rejects.toThrow();
  });

  it("refuses a revenue code the tenant's chart does not have", async () => {
    const fixture = await agencyWithEngagement();
    // 4660 is one of the trade's four and is in this tenant's seeded chart.
    await expect(
      addMilestone(fixture.owner, fixture.projectId, {
        title: "شارژ رسانه",
        amountRial: 50_000_000,
        revenueCode: "4660",
      }),
    ).resolves.toMatchObject({ revenueCode: "4660" });

    // The column's own CHECK keeps the four codes, so the trigger's job is the
    // other half: the code has to exist in *this* business's accounts.
    await expect(
      db.query(
        `INSERT INTO agency_billing_milestones
           (business_id, project_id, milestone_number, title, amount_rial, revenue_code)
         VALUES ($1, $2, 'MS-901', 'مرحلهٔ بی‌حساب', 1000000, '4640')`,
        [fixture.businessId, fixture.projectId],
      ),
    ).resolves.toBeTruthy();
    await expect(
      db.query(
        `INSERT INTO agency_billing_milestones
           (business_id, project_id, milestone_number, title, amount_rial, revenue_code)
         VALUES ($1, $2, 'MS-902', 'مرحلهٔ بی‌حساب', 1000000, '9999')`,
        [fixture.businessId, fixture.projectId],
      ),
    ).rejects.toThrow();
  });

  it("deletes a draft, and refuses a row the client has already seen", async () => {
    const fixture = await agencyWithEngagement();
    const draft = await addMilestone(fixture.owner, fixture.projectId, {
      title: "مرحلهٔ اشتباه",
      percent: 10,
    });
    const seen = await addMilestone(fixture.owner, fixture.projectId, {
      title: "مرحلهٔ ارسال‌شده",
      percent: 20,
    });
    await submitMilestone(fixture.owner, seen.id);

    const removed = await withTenant(fixture.businessId, () =>
      commercial.deleteAgencyMilestone(fixture.owner, draft.id),
    );
    expect(removed).toBe(true);
    const kept = await withTenant(fixture.businessId, () =>
      commercial.deleteAgencyMilestone(fixture.owner, seen.id),
    );
    expect(kept).toBe(false);
  });

  it("refuses to edit a milestone that is no longer editable", async () => {
    const fixture = await agencyWithEngagement();
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    await submitMilestone(fixture.owner, milestone.id);
    await expect(
      withTenant(fixture.businessId, () =>
        commercial.updateAgencyMilestone(fixture.owner, milestone.id, { percent: 45 }),
      ),
    ).rejects.toMatchObject({ code: "milestone_not_editable" });
  });

  it("refuses an act the row's own chain does not offer", async () => {
    const fixture = await agencyWithEngagement();
    const milestone = await addMilestone(fixture.owner, fixture.projectId, { percent: 30 });
    // A draft was never priced, so it cannot be invoiced, and it cannot be
    // approved by anybody either — it has not been sent.
    await expect(
      withTenant(fixture.businessId, () =>
        commercial.applyMilestoneAction(fixture.owner, milestone.id, "invoice", {}),
      ),
    ).rejects.toMatchObject({ code: "invalid_milestone_transition" });
    expect(milestone.actions.map((a) => a.action)).toEqual(["submit", "cancel"]);
  });
});

describe("the engagement a schedule bills against", () => {
  it("reads the client's contract and ignores a supplier's", async () => {
    const fixture = await agencyWithEngagement(100_000_000);
    const supplier = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role, roles)
       VALUES ($1, 'چاپخانهٔ افق', 'supplier', ARRAY['supplier']::text[]) RETURNING id`,
      [fixture.businessId],
    );
    // A subcontract on the same project: the agency's own payable, which §D
    // keeps on the cost side. Were it read as the engagement, the schedule
    // would bill the client for what the agency owes a printer.
    await db.query(
      `INSERT INTO workspace_contracts
         (business_id, project_id, party_id, title, contract_type, value_rial, status, created_by)
       VALUES ($1, $2, $3, 'قرارداد چاپ', 'subcontractor', 40000000, 'active', $4)`,
      [fixture.businessId, fixture.projectId, supplier.rows[0].id, fixture.owner.actorUserId],
    );

    const summary = await withTenant(fixture.businessId, () =>
      commercial.loadAgencyCommercial(fixture.owner, fixture.projectId),
    );
    expect(summary.engagement.contractId).toBe(fixture.contractId);
    expect(summary.engagement.contractedRial).toBe(100_000_000);
    expect(summary.engagement.customerId).toBe(fixture.clientId);
    expect(summary.engagement.customerName).toBe("شرکت پدیده");
  });
});
