/**
 * #1128 §C: evidenced period reports, immutable corrections, permission/RLS
 * isolation and preservation of canonical campaign and accounting facts.
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
  databaseName = `agency_report_${randomUUID().replaceAll("-", "")}`;

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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
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
    await db.query(
      `INSERT INTO parties (business_id, name) VALUES ($1,'کارفرما') RETURNING id`,
      [result.businessId],
    )
  ).rows[0].id;
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id) VALUES ($1,'پروژهٔ کمپین',$2,$3) RETURNING id`,
      [result.businessId, actor.userId, actor.userId],
    )
  ).rows[0].id;
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    clientId,
    projectId,
    actor,
  };
}

let reports: typeof import("../src/lib/agency-campaign-report-service");
beforeAll(async () => {
  reports = await import("../src/lib/agency-campaign-report-service");
});
const actor = (a: Agency) => ({
  businessId: a.businessId,
  actorUserId: a.actor.userId,
  actorName: a.actor.name,
  workspaceAllowed: true,
});
const input = (extra: Record<string, unknown> = {}) => ({
  periodStart: "2026-10-01",
  periodEnd: "2026-10-07",
  evidenceReference: "export-oct.csv / row 4",
  attributionNote:
    "تطبیق دستی فرم‌های یکتا و فروش منبع؛ پنجرهٔ هفت‌روزه، بدون ادعای تأیید پلتفرم",
  attributionConfirmed: false,
  spendRial: 1000,
  impressions: 100,
  clicks: 10,
  leadsGenerated: 5,
  conversions: 2,
  revenueRial: 2000,
  ...extra,
});
async function campaign(a: Agency) {
  return (
    await db.query(
      `INSERT INTO agency_client_campaigns
 (business_id,party_id,project_id,campaign_number,title,start_date,end_date,status,budget_rial)
 VALUES ($1,$2,$3,$4,'کمپین کارفرما','2026-10-01','2026-10-31','running',10000) RETURNING id`,
      [a.businessId, a.clientId, a.projectId, `CA-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id as string;
}
describe("period client campaign reports", () => {
  it("requires explicit evidence and suppresses attribution ratios until the user attests reconciliation", async () => {
    const a = await agency(),
      id = await campaign(a);
    await reports.createCampaignReport(actor(a), id, input());
    const [r] = await reports.listCampaignReports(actor(a), id);
    expect(r.metrics).toEqual({
      ctrPct: 10,
      cplRial: null,
      cpaRial: null,
      roas: null,
    });
    expect(r.evidenceReference).toContain("export-oct.csv");
    expect(r.createdByName).toBe(a.actor.name);
    expect(r.campaignBudgetRial).toBe(10000);
    expect(r.reach).toBeNull();
    await db.query(
      `UPDATE agency_client_campaigns SET budget_rial=20000 WHERE id=$1`,
      [id],
    );
    expect(
      (await reports.listCampaignReports(actor(a), id))[0].campaignBudgetRial,
    ).toBe(10000);
    expect(
      (
        await db.query(
          `SELECT spend_rial::text FROM agency_client_campaigns WHERE id=$1`,
          [id],
        )
      ).rows[0].spend_rial,
    ).toBe("0");
    expect(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM domain_events WHERE business_id=$1`,
          [a.businessId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("derives supported ratios and retains immutable corrections, including explicit zero revenue", async () => {
    const a = await agency(),
      id = await campaign(a);
    const original = await reports.createCampaignReport(
      actor(a),
      id,
      input({ attributionConfirmed: true }),
    );
    expect(
      (await reports.listCampaignReports(actor(a), id))[0].metrics,
    ).toEqual({ ctrPct: 10, cplRial: 200, cpaRial: 500, roas: 2 });
    await reports.createCampaignReport(
      actor(a),
      id,
      input({
        supersedesId: original.id,
        attributionConfirmed: true,
        revenueRial: 0,
      }),
    );
    const rows = await reports.listCampaignReports(actor(a), id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === original.id)?.superseded).toBe(true);
    expect(rows.find((r) => !r.superseded)?.metrics.roas).toBe(0);
    await expect(
      db.query(`UPDATE agency_campaign_reports SET spend_rial=0 WHERE id=$1`, [
        original.id,
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query(`DELETE FROM agency_campaign_reports WHERE id=$1`, [
        original.id,
      ]),
    ).rejects.toThrow("immutable");
  });
  it("rejects duplicate roots, stale corrections, foreign periods and concurrent correction branches", async () => {
    const a = await agency(),
      id = await campaign(a);
    const r = await reports.createCampaignReport(actor(a), id, input());
    await expect(
      reports.createCampaignReport(actor(a), id, input()),
    ).rejects.toThrow("report_conflict");
    await expect(
      reports.createCampaignReport(
        actor(a),
        id,
        input({ supersedesId: r.id, periodEnd: "2026-10-08" }),
      ),
    ).rejects.toThrow("report_conflict");
    const race = await Promise.allSettled(
      [1, 2].map(() =>
        reports.createCampaignReport(
          actor(a),
          id,
          input({ supersedesId: r.id }),
        ),
      ),
    );
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (await reports.listCampaignReports(actor(a), id)).filter(
        (r) => !r.superseded,
      ),
    ).toHaveLength(1);
  });
  it("requires Workspace permission and project role independently for linked campaigns", async () => {
    const a = await agency(),
      id = await campaign(a);
    const viewer = (
      await db.query(
        `INSERT INTO users(business_id,role,full_name,email,password_hash) VALUES ($1,'manager','بیننده',$2,'x') RETURNING id`,
        [a.businessId, `${randomUUID()}@example.test`],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO workspace_members(project_id,user_id,role,added_by) VALUES ($1,$2,'viewer','test')`,
      [a.projectId, viewer],
    );
    const v = { ...actor(a), actorUserId: viewer };
    expect(await reports.listCampaignReports(v, id)).toEqual([]);
    await expect(reports.createCampaignReport(v, id, input())).rejects.toThrow(
      "insufficient_project_role",
    );
    await expect(
      reports.listCampaignReports({ ...actor(a), workspaceAllowed: false }, id),
    ).rejects.toThrow("insufficient_project_role");
  });
  it("separates tenants and clients/projects, including a foreign correction ID", async () => {
    const a = await agency(),
      b = await agency(),
      id = await campaign(a),
      other = await campaign(b);
    const r = await reports.createCampaignReport(actor(a), id, input());
    await expect(reports.listCampaignReports(actor(b), id)).rejects.toThrow(
      "campaign_not_found",
    );
    await expect(
      reports.createCampaignReport(
        actor(b),
        other,
        input({ supersedesId: r.id }),
      ),
    ).rejects.toThrow("report_conflict");
    await expect(
      reports.listCampaignReports(
        { ...actor(a), actorUserId: b.actor.userId },
        id,
      ),
    ).rejects.toThrow("project_not_found");
    const otherProject = (
      await db.query(
        `INSERT INTO ai_projects(business_id,name,created_by,owner_user_id) VALUES($1,'دیگر',$2::text,$2::uuid) RETURNING id`,
        [a.businessId, b.actor.userId],
      )
    ).rows[0].id;
    const otherClient = (
      await db.query(
        `INSERT INTO parties(business_id,name) VALUES($1,'دیگر') RETURNING id`,
        [a.businessId],
      )
    ).rows[0].id;
    const c = (
      await db.query(
        `INSERT INTO agency_client_campaigns(business_id,party_id,project_id,campaign_number,title,status,start_date) VALUES($1,$2,$3,'CA-other','دیگر','running','2026-10-01') RETURNING id`,
        [a.businessId, otherClient, otherProject],
      )
    ).rows[0].id;
    await expect(reports.listCampaignReports(actor(a), c)).rejects.toThrow(
      "project_not_found",
    );
  });
  it("freezes reported client/project attribution but still allows the audited canonical CRM merge", async () => {
    const a = await agency(),
      id = await campaign(a);
    await reports.createCampaignReport(actor(a), id, input());
    const winner = (
      await db.query(
        `INSERT INTO parties(business_id,name) VALUES($1,'بازمانده') RETURNING id`,
        [a.businessId],
      )
    ).rows[0].id;
    await expect(
      db.query(`UPDATE agency_client_campaigns SET party_id=$2 WHERE id=$1`, [
        id,
        winner,
      ]),
    ).rejects.toThrow("scope is frozen");
    await expect(
      db.query(
        `UPDATE agency_client_campaigns SET project_id=NULL WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow("scope is frozen");
    await expect(
      db.query(
        `UPDATE agency_client_campaigns SET start_date='2026-10-02' WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow("retain reported periods");
    await expect(
      db.query(
        `UPDATE agency_client_campaigns SET end_date='2026-10-03' WHERE id=$1`,
        [id],
      ),
    ).rejects.toThrow("retain reported periods");
    await db.query(
      `UPDATE agency_client_campaigns SET end_date='2026-11-30' WHERE id=$1`,
      [id],
    );
    const crm = await import("../src/lib/crm-service");
    expect(
      await crm.mergeCustomers(a.businessId, winner, a.clientId, {
        mergedByUserId: a.actor.userId,
      }),
    ).not.toBeNull();
    expect(await reports.listCampaignReports(actor(a), id)).toHaveLength(1);
  });
  it("refuses future/out-of-campaign periods and non-executed campaigns", async () => {
    const a = await agency(),
      id = await campaign(a);
    for (const patch of [
      { periodStart: "2026-09-01" },
      { periodEnd: "2099-01-01" },
    ])
      await expect(
        reports.createCampaignReport(actor(a), id, input(patch)),
      ).rejects.toThrow("invalid_report");
    const planned = (
      await db.query(
        `INSERT INTO agency_client_campaigns(business_id,party_id,project_id,campaign_number,title) VALUES($1,$2,$3,'CA-planned','آینده') RETURNING id`,
        [a.businessId, a.clientId, a.projectId],
      )
    ).rows[0].id;
    await expect(
      reports.createCampaignReport(actor(a), planned, input()),
    ).rejects.toThrow("report_state");
    await db.query(
      `UPDATE agency_client_campaigns SET status='cancelled' WHERE id=$1`,
      [id],
    );
    expect(
      await reports.createCampaignReport(actor(a), id, input()),
    ).toHaveProperty("id");
  });
  it("enforces table RLS even when a report ID is known", async () => {
    const a = await agency(),
      b = await agency(),
      id = await campaign(a);
    const r = await reports.createCampaignReport(actor(a), id, input());
    const role = `report_rls_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT ON agency_campaign_reports TO "${role}"`);
      await db.query(`SET ROLE "${role}"`);
      await db.query(
        `SELECT set_config('app.business_id',$1,false),set_config('app.rls_bypass','',false)`,
        [b.businessId],
      );
      expect(
        (
          await db.query(`SELECT id FROM agency_campaign_reports WHERE id=$1`, [
            r.id,
          ])
        ).rows,
      ).toEqual([]);
      await db.query(`SELECT set_config('app.business_id',$1,false)`, [
        a.businessId,
      ]);
      expect(
        (await db.query(`SELECT id FROM agency_campaign_reports`)).rows,
      ).toEqual([{ id: r.id }]);
    } finally {
      await db.query(`RESET ROLE`);
      await db.query(`SELECT set_config('app.business_id','',false)`);
      await db.query(`REVOKE ALL ON agency_campaign_reports FROM "${role}"`);
      await db.query(`DROP ROLE "${role}"`);
    }
  });
});
