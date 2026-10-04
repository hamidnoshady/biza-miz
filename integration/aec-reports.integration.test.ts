/**
 * Issue #799 Wave 10 (§30, with §20 and §34) — the project report set against a
 * real PostgreSQL.
 *
 * `src/lib/aec-reports.test.ts` proves the pure half: the seventeen keys in
 * §30's order, the capability gate and the aging buckets. What can only be
 * proven here, with the schema, the RLS policies and the guards in the way, is:
 *
 *   * **every report is answered by the register that owns it**, and the numbers
 *     agree with the registers — the schedule variance counts the same tasks the
 *     phases hold, the delay report lists the commitment §18 called late, the
 *     supplier table groups the awards the register counts, the quality counts
 *     group the very issues the site register holds;
 *   * **posted financial facts come from Accounting**: the actual cost in
 *     «بودجه در برابر واقعی» is the ledger's (`journal_entries.project_id` →
 *     `journal_lines`), the forecast is §20's (`costForecast`), and the report
 *     does not recompute either — with an actor who may not read the books it is
 *     `null`, never a fabricated zero;
 *   * the bundle is §30's order for **this** business: the returned keys equal
 *     `reportsForCapabilities(capabilities)` exactly, so an architecture office
 *     that switched `procurement`, `boq`, `variations`, `site_operations`,
 *     `qa_qc`, `snagging` and `progress_claims` off gets those reports absent —
 *     not empty, and not paid for;
 *   * another business's project is out of reach through the same predicates the
 *     registers use (an empty health report, no rows leaking into any table);
 *   * a business that is not in the AEC industry is refused with
 *     `industry_mismatch`, exactly as the cockpits are;
 *   * the row cap is deliberate: a long register prints `AEC_REPORT_ROW_LIMIT`
 *     rows and says how many it did not print, rather than becoming an export.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { businessToday } from "../src/lib/business-day-service";
import { workspaceAccessFlags } from "../src/lib/workspace-shared";
import * as sitePure from "../src/lib/aec-site";
import type { AecError } from "../src/lib/aec-service";
import type { AecReport, AecReportBundle } from "../src/lib/aec-reports-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let aec: typeof import("../src/lib/aec-service");
let boq: typeof import("../src/lib/aec-boq-service");
let procurement: typeof import("../src/lib/aec-procurement-service");
let reports: typeof import("../src/lib/aec-reports-service");
let reportsPure: typeof import("../src/lib/aec-reports");

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
  databaseName = `pos_aec_reports_${randomUUID().replaceAll("-", "")}`;

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
  aec = await import("../src/lib/aec-service");
  boq = await import("../src/lib/aec-boq-service");
  procurement = await import("../src/lib/aec-procurement-service");
  reports = await import("../src/lib/aec-reports-service");
  reportsPure = await import("../src/lib/aec-reports");

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

let seq = 0;

type Owner = { businessId: string; actorUserId: string; actorName: string };

async function provisionBusiness(
  industry: "architecture_construction" | "food_service" = "architecture_construction",
  profile: "contractor" | "design" = "contractor",
): Promise<{ businessId: string; owner: Owner }> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار گزارش ${seq}`,
    ownerName: "مالک",
    email: `owner-reports-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `reports${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction" && profile === "contractor") {
    await dbLib.withTenant(result.businessId, () =>
      aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }),
    );
  }
  return { businessId: result.businessId, owner };
}

function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

/** Whole days before the business's own today, so the ages below are exact. */
function daysAgo(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

async function createProject(
  businessId: string,
  ownerUserId: string,
  name: string,
  budgetRial: number | null = null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id, budget_rial)
     VALUES ($1, $2, $3::text, $3::uuid, $4) RETURNING id`,
    [businessId, name, ownerUserId, budgetRial],
  );
  return rows[0].id;
}

async function createParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, 'supplier', ARRAY['supplier']::text[]) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/** One posted cost against a project — Accounting's half of §20 (Wave 9 copied). */
async function postProjectCost(businessId: string, projectId: string, amountRial: number): Promise<void> {
  await dbLib.withTenant(businessId, async () => {
    const { rows: accounts } = await dbLib.query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 ORDER BY code LIMIT 1`,
      [businessId],
    );
    const { rows: entries } = await dbLib.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, project_id)
       VALUES ($1, '2026-05-01', 'هزینهٔ اجرای پروژه', 'manual', $2) RETURNING id`,
      [businessId, projectId],
    );
    await dbLib.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0)`,
      [entries[0].id, accounts[0].id, amountRial],
    );
  });
}

/** An approved estimate worth 1,000 m³ × 200,000 — §20's baseline. */
async function seedApprovedEstimate(owner: Owner, projectId: string): Promise<void> {
  await withTenant(owner.businessId, async () => {
    const estimate = await boq.createEstimate(owner, projectId, { title: "برآورد اصلی" });
    const versionId = estimate.versions[0].id;
    await boq.saveDraftVersion(owner, versionId, {
      sections: [{ code: "01", title: "عملیات خاکی" }],
      items: [
        {
          sectionIndex: 0,
          itemCode: "01-10",
          description: "خاک‌برداری با ماشین",
          unit: "m3",
          quantity: "1000",
          materialRateRial: 0,
          laborRateRial: 180_000,
          equipmentRateRial: 20_000,
          subcontractRateRial: 0,
          wastePercent: "0",
          overheadPercent: "0",
          markupPercent: "0",
        },
      ],
    });
    await boq.submitEstimateVersion(owner, versionId, {});
    await boq.approveEstimateVersion(owner, versionId, "");
  });
}

/** An award the register counts: created, submitted and approved through §18. */
async function seedApprovedCommitment(
  owner: Owner,
  projectId: string,
  supplierPartyId: string,
  valueRial: number,
  expectedDeliveryDate: string,
): Promise<string> {
  const award = await withTenant(owner.businessId, () =>
    procurement.createCommitment(owner, projectId, {
      kind: "purchase",
      title: "خرید مصالح",
      supplierPartyId,
      valueRial,
      expectedDeliveryDate,
    }),
  );
  await withTenant(owner.businessId, () =>
    procurement.applyCommitmentAction(owner, award.id, "submit"),
  );
  const submitted = await withTenant(owner.businessId, () =>
    procurement.loadCommitment(owner.businessId, award.id),
  );
  await withTenant(owner.businessId, () =>
    procurement.decideCommitmentApproval(owner, submitted.approvalId!, "approved", ""),
  );
  return award.id;
}

/** One report of the bundle, or a failure that says which key was missing. */
function reportFor(bundle: AecReportBundle, key: string): AecReport {
  const found = bundle.reports.find((entry) => entry.key === key);
  if (!found) throw new Error(`report ${key} is absent from the bundle`);
  return found;
}

/** One named total of a report — the label is part of the assertion. */
function totalOf(bundle: AecReportBundle, key: string, label: string): number | null {
  const total = reportFor(bundle, key).totals.find((entry) => entry.label === label);
  if (!total) throw new Error(`report ${key} has no total ${label}`);
  return total.value;
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/**
 * §30's fixture: one project with a phase that is behind, an approved estimate,
 * a posted ledger cost, an approved award past its date, a submitted change, an
 * unanswered RFI, a submittal waiting for review, a drawing whose revision is
 * still a draft, a site log, a snag, an inspection and a certified claim.
 */
async function seedReportFixture(owner: Owner, projectId: string, today: string) {
  const phaseId = await db.query<{ id: string }>(
    `INSERT INTO workspace_project_phases (project_id, name, status, display_order, start_date, end_date)
     VALUES ($1, 'فاز اجرایی', 'active', 1, $2::date, $3::date) RETURNING id`,
    [projectId, daysAgo(today, 60), daysAgo(today, -30)],
  ).then((r) => r.rows[0].id);

  await db.query(
    `INSERT INTO ai_project_tasks (project_id, title, status, created_by, phase_id, due_date)
     VALUES ($1, 'بتن‌ریزی فونداسیون', 'done', 'سیستم', $2, $3::date),
            ($1, 'نصب اسکلت فلزی', 'open', 'سیستم', $2, $4::date),
            ($1, 'تأمین روشنایی', 'open', 'سیستم', NULL, $4::date)`,
    [projectId, phaseId, daysAgo(today, 40), daysAgo(today, 10)],
  );

  // §15 — a submitted change, twenty days old, its amount submitted.
  await db.query(
    `INSERT INTO aec_variations (business_id, project_id, variation_number, source, description,
                                 submitted_amount_rial, estimated_amount_rial, status, submitted_date, created_by_name)
     VALUES ($1, $2, 'CO-101', 'client_instruction', 'افزایش سطح مقطع تیرها',
             50_000_000, 50_000_000, 'submitted', $3::date, 'مالک')`,
    [owner.businessId, projectId, daysAgo(today, 20)],
  );

  // §10 — an RFI that was asked twelve days ago and has no answer yet.
  await db.query(
    `INSERT INTO aec_rfis (business_id, project_id, rfi_number, subject, question, raised_date,
                           assigned_to_name, due_date, status, created_by_name)
     VALUES ($1, $2, 'RFI-101', 'تراز کف طبقهٔ دوم', 'تراز نهایی کدام است؟', $3::date,
             'دفتر فنی', $4::date, 'open', 'مالک')`,
    [owner.businessId, projectId, daysAgo(today, 25), daysAgo(today, 12)],
  );

  // §11 — a submittal whose latest revision is waiting for review.
  const submittalId = await db.query<{ id: string }>(
    `INSERT INTO aec_submittals (business_id, project_id, submittal_number, title, submission_type,
                                 latest_revision_status, latest_revision_no, revision_count, created_by_name)
     VALUES ($1, $2, 'SUB-101', 'نقشهٔ کارگاهی اسکلت', 'shop_drawing', 'submitted', 1, 1, 'مالک')
     RETURNING id`,
    [owner.businessId, projectId],
  ).then((r) => r.rows[0].id);
  const revisionId = await db.query<{ id: string }>(
    `INSERT INTO aec_submittal_revisions (business_id, submittal_id, revision_no, status,
                                          submitted_by_name, due_date, reviewer_name, created_by_name)
     VALUES ($1, $2, 1, 'submitted', 'پیمانکار', $3::date, 'ناظر', 'مالک') RETURNING id`,
    [owner.businessId, submittalId, daysAgo(today, 5)],
  ).then((r) => r.rows[0].id);
  await db.query(`UPDATE aec_submittals SET latest_revision_id = $2 WHERE id = $1`, [
    submittalId,
    revisionId,
  ]);

  // §9 — a drawing whose latest revision is still a draft.
  await db.query(
    `INSERT INTO aec_documents (business_id, project_id, document_number, drawing_number, title,
                                document_type, discipline, latest_revision_no, latest_revision_code,
                                latest_revision_status, revision_count, created_by_name)
     VALUES ($1, $2, 'DR-101', 'A-101', 'پلان طبقهٔ همکف', 'drawing', 'architecture', 1, 'A',
             'draft', 1, 'مالک')`,
    [owner.businessId, projectId],
  );

  // §14 — yesterday's site log, with a crew, a delivery and an incident.
  // The lines are written while the log is still a draft — the guard freezes a
  // submitted log's lines — and then the log is submitted, which is the order
  // the site screen uses.
  const logId = await db.query<{ id: string }>(
    `INSERT INTO aec_site_logs (business_id, project_id, log_date, status, work_performed, weather, author_name)
     VALUES ($1, $2, $3::date, 'draft', 'قالب‌بندی ستون‌ها', 'آفتابی', 'سرکارگر') RETURNING id`,
    [owner.businessId, projectId, daysAgo(today, 1)],
  ).then((r) => r.rows[0].id);
  await db.query(
    `INSERT INTO aec_site_log_lines (business_id, log_id, kind, title, headcount, quantity, unit, position)
     VALUES ($1, $2, 'attendance', 'گروه بتن', 12, NULL, NULL, 0),
            ($1, $2, 'material', 'ورود میلگرد', NULL, 6, 'تن', 1),
            ($1, $2, 'incident', 'بریدگی دست کارگر', NULL, NULL, NULL, 2)`,
    [owner.businessId, logId],
  );
  await db.query(
    `UPDATE aec_site_logs SET status = 'submitted', submitted_by_name = 'سرکارگر' WHERE id = $1`,
    [logId],
  );

  // §13 — one open snag eight days past its due date…
  await db.query(
    `INSERT INTO aec_site_issues (business_id, project_id, issue_number, kind, title, severity,
                                  raised_date, due_date, status, assigned_to_name, created_by_name)
     VALUES ($1, $2, 'SN-101', 'snag', 'درزگیری ناقص نما', 'high', $3::date, $4::date, 'open', 'پیمانکار نما', 'مالک')`,
    [owner.businessId, projectId, daysAgo(today, 20), daysAgo(today, 8)],
  );
  // …and one inspection still in progress thirty days after it was raised.
  await db.query(
    `INSERT INTO aec_site_issues (business_id, project_id, issue_number, kind, title, severity,
                                  raised_date, status, assigned_to_name, created_by_name)
     VALUES ($1, $2, 'IN-101', 'inspection', 'بازرسی جوش اسکلت', 'medium', $3::date, 'in_progress',
             'ناظر جوش', 'مالک')`,
    [owner.businessId, projectId, daysAgo(today, 30)],
  );

  // §16 — a claim that has been certified: the money is certified, not collected.
  await db.query(
    `INSERT INTO aec_payment_certificates (business_id, project_id, certificate_number, kind,
                                           period_start, period_end, progress_percent, gross_rial,
                                           retention_rial, net_rial, approved_amount_rial, status,
                                           submitted_date, certified_date, created_by_name)
     VALUES ($1, $2, 'PC-101', 'application', $3::date, $4::date, 25, 90_000_000, 0, 90_000_000,
             90_000_000, 'certified', $5::date, $6::date, 'مالک')`,
    [owner.businessId, projectId, daysAgo(today, 40), daysAgo(today, 10), daysAgo(today, 15), daysAgo(today, 5)],
  );

  return { phaseId };
}

describe("§30's report set", () => {
  it("answers every report from the register that owns it, in §30's order", async () => {
    const { businessId, owner } = await provisionBusiness();
    const today = await businessToday(businessId);
    const projectId = await createProject(businessId, owner.actorUserId, "برج گزارش", 300_000_000);
    const supplier = await createParty(businessId, "فولاد گزارش");
    await seedReportFixture(owner, projectId, today);
    await seedApprovedEstimate(owner, projectId);
    await postProjectCost(businessId, projectId, 1_500_000_000);
    await seedApprovedCommitment(owner, projectId, supplier, 700_000_000, daysAgo(today, 30));

    const ledgerOwner = { ...owner, access: workspaceAccessFlags(new Set(["ledger.view"])) };
    const bundle = await withTenant(businessId, () =>
      reports.projectAecReports(ledgerOwner, projectId),
    );

    // The bundle is §30's order for *this* business, key for key — the page and
    // the catalogue cannot drift.
    expect(bundle.projectId).toBe(projectId);
    expect(bundle.projectName).toBe("برج گزارش");
    expect(bundle.today).toBe(today);
    expect(bundle.reports.map((entry) => entry.key)).toEqual(
      reportsPure.reportsForCapabilities(bundle.capabilities).map((entry) => entry.key),
    );

    // §30's health line: the plan's own numbers, with the ledger's half.
    const health = reportFor(bundle, "project_health");
    expect(health.rows).toHaveLength(1);
    expect(health.rows[0].overdueTaskCount).toBe(2);
    expect(health.rows[0].spentRial).toBe(1_500_000_000);
    expect(health.rows[0].budgetRial).toBe(300_000_000);

    // The phases §22 puts on screen, measured against today.
    const variance = reportFor(bundle, "schedule_variance");
    const phaseRow = variance.rows.find((row) => row.phase === "فاز اجرایی")!;
    expect(phaseRow.taskCount).toBe(2);
    expect(phaseRow.doneTaskCount).toBe(1);
    expect(phaseRow.overdueTaskCount).toBe(1);
    expect(phaseRow.worstOverdueDays).toBe(10);
    // A project without phases still reports its loose tasks rather than
    // dropping them (§34: no silent totals).
    expect(variance.rows.find((row) => row.phase === "بدون فاز")?.taskCount).toBe(1);

    // §20's commercial half, read from Accounting and §18's register.
    expect(totalOf(bundle, "budget_vs_actual", "مبنا")).toBe(200_000_000);
    expect(totalOf(bundle, "budget_vs_actual", "هزینهٔ ثبت‌شده")).toBe(1_500_000_000);
    expect(totalOf(bundle, "budget_vs_actual", "انحراف")).toBe(-1_300_000_000);
    expect(totalOf(bundle, "committed_vs_budget", "تعهدشده")).toBe(700_000_000);
    expect(totalOf(bundle, "committed_vs_budget", "بدون تعهد")).toBe(0);
    // costForecast: actual + committed, clamped at the estimate's remainder.
    expect(totalOf(bundle, "forecast_final_cost", "تا اتمام کار")).toBe(0);
    expect(totalOf(bundle, "forecast_final_cost", "هزینهٔ نهایی")).toBe(2_200_000_000);
    // §20's sentence explains the number instead of leaving a formula.
    expect((reportFor(bundle, "forecast_final_cost").note ?? "").trim().length).toBeGreaterThan(0);
    expect(totalOf(bundle, "project_margin", "حاشیه")).toBe(-2_200_000_000);

    // §14/§15/§10/§11 — the registers' own rows, aged against the business's day.
    const change = reportFor(bundle, "change_order_exposure");
    expect(totalOf(bundle, "change_order_exposure", "تغییرات باز")).toBe(1);
    expect(change.rows[0].ageDays).toBe(20);
    expect(change.rows[0].agingBucket).toBe(reportsPure.AEC_AGING_BUCKET_LABELS.late);

    const rfi = reportFor(bundle, "rfi_aging");
    expect(totalOf(bundle, "rfi_aging", "از مهلت گذشته")).toBe(1);
    expect(rfi.rows[0].daysOverdue).toBe(12);
    expect(rfi.rows[0].agingBucket).toBe(reportsPure.AEC_AGING_BUCKET_LABELS.waiting);

    const submittal = reportFor(bundle, "submittal_aging");
    expect(totalOf(bundle, "submittal_aging", "در انتظار بررسی")).toBe(1);
    expect(submittal.rows[0].daysOverdue).toBe(5);

    const documents = reportFor(bundle, "document_status");
    expect(totalOf(bundle, "document_status", "سند/نقشه")).toBe(1);
    expect(totalOf(bundle, "document_status", "بازنگری باز")).toBe(1);

    const site = reportFor(bundle, "site_productivity");
    expect(site.rows).toHaveLength(1);
    expect(site.rows[0].workforce).toBe(12);
    expect(totalOf(bundle, "site_productivity", "مصالح رسیده")).toBe(1);
    expect(totalOf(bundle, "site_productivity", "رخداد")).toBe(1);

    const snag = reportFor(bundle, "snag_aging");
    expect(totalOf(bundle, "snag_aging", "نقص باز")).toBe(1);
    expect(snag.rows[0].daysOverdue).toBe(8);
    expect(snag.rows[0].agingBucket).toBe(reportsPure.AEC_AGING_BUCKET_LABELS.waiting);

    const quality = reportFor(bundle, "inspection_status");
    const inspectionRow = quality.rows.find(
      (row) => row.kind === sitePure.SITE_ISSUE_KIND_LABELS.inspection,
    )!;
    expect(inspectionRow.inProgressCount).toBe(1);
    expect(inspectionRow.oldestOpenDays).toBe(30);
    // The snag is grouped under its own kind, not double-counted as an inspection.
    expect(quality.rows.find((row) => row.kind === sitePure.SITE_ISSUE_KIND_LABELS.snag)?.openCount).toBe(1);

    const certificates = reportFor(bundle, "certificate_status");
    expect(totalOf(bundle, "certificate_status", "گواهی‌شده")).toBe(1);
    expect(totalOf(bundle, "certificate_status", "مبلغ گواهی‌شده")).toBe(90_000_000);

    // §18/§20 — the late award, in both reports that read it.
    const delay = reportFor(bundle, "procurement_delay");
    expect(totalOf(bundle, "procurement_delay", "تعهدهای تأخیری")).toBe(1);
    expect(totalOf(bundle, "procurement_delay", "مبلغ در تأخیر")).toBe(700_000_000);
    expect(delay.rows[0].supplierName).toBe("فولاد گزارش");
    expect(delay.rows[0].delayDays).toBe(30);
    expect(delay.rows[0].agingBucket).toBe(reportsPure.AEC_AGING_BUCKET_LABELS.late);

    const supplierReport = reportFor(bundle, "contractor_performance");
    expect(supplierReport.rows[0].supplierName).toBe("فولاد گزارش");
    expect(supplierReport.rows[0].committedRial).toBe(700_000_000);
    expect(supplierReport.rows[0].lateCount).toBe(1);
    expect(supplierReport.rows[0].worstDelayDays).toBe(30);

    // §34 — every figure names the read a summary can be traced to.
    for (const entry of bundle.reports) {
      if (entry.sourceTool !== null) {
        expect(entry.sourceTool.trim().length).toBeGreaterThan(0);
      }
    }
    expect(reportFor(bundle, "rfi_aging").sourceTool).toBe("list_pending_rfis");
    expect(reportFor(bundle, "budget_vs_actual").sourceTool).toBe("get_aec_project_financial_health");
  });

  it("leaves a switched-off capability absent, not empty", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction", "design");
    const other = await provisionBusiness();
    const today = await businessToday(businessId);
    // The design office's own project, with the same fixture: if a report were
    // built from the wrong gate it would find rows here and show up.
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ طراحی");
    await seedReportFixture(owner, projectId, today);

    const bundle = await withTenant(businessId, () =>
      reports.projectAecReports(
        { ...owner, access: workspaceAccessFlags(new Set(["ledger.view"])) },
        projectId,
      ),
    );
    const keys = bundle.reports.map((entry) => entry.key);

    // Not in the design preset: procurement, boq, variations, site, snagging,
    // quality and claims. §21's rule — absent, never greyed out — holds here
    // before a single query runs.
    for (const absent of [
      "boq_variance",
      "change_order_exposure",
      "procurement_delay",
      "contractor_performance",
      "site_productivity",
      "snag_aging",
      "inspection_status",
      "certificate_status",
    ]) {
      expect(keys).not.toContain(absent);
      expect(reportsPure.AEC_REPORTS.some((entry) => entry.key === absent)).toBe(true);
    }
    // The design office still reads its own registers.
    for (const present of [
      "project_health",
      "schedule_variance",
      "budget_vs_actual",
      "project_margin",
      "rfi_aging",
      "submittal_aging",
      "document_status",
    ]) {
      expect(keys).toContain(present);
    }
    expect(keys).toEqual(
      reportsPure.reportsForCapabilities(bundle.capabilities).map((entry) => entry.key),
    );

    // The contractor in the same database still gets the full set.
    const contractorProject = await createProject(other.businessId, other.owner.actorUserId, "پروژهٔ پیمانکاری");
    const contractorBundle = await withTenant(other.businessId, () =>
      reports.projectAecReports(other.owner, contractorProject),
    );
    expect(contractorBundle.reports.map((entry) => entry.key)).toContain("procurement_delay");
    expect(contractorBundle.reports.map((entry) => entry.key)).toContain("snag_aging");
  });

  it("reads posted financial facts from Accounting, and says so when it may not", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ دفتر کل");
    await seedApprovedEstimate(owner, projectId);
    await postProjectCost(businessId, projectId, 400_000_000);

    // The owner's session grants `ledger.view` only when the fixture says so —
    // the same flag the finance cards and the assistant check.
    const blind = await withTenant(businessId, () => reports.projectAecReports(owner, projectId));
    expect(totalOf(blind, "budget_vs_actual", "هزینهٔ ثبت‌شده")).toBeNull();
    expect(reportFor(blind, "budget_vs_actual").rows[0].actualCostRial).toBeNull();
    expect(totalOf(blind, "budget_vs_actual", "انحراف")).toBeNull();
    // Nothing is invented, and the forecast still refuses to guess without the
    // ledger's half.
    expect(totalOf(blind, "project_health", "وظایف باز")).toBe(0);

    const seeing = await withTenant(businessId, () =>
      reports.projectAecReports(
        { ...owner, access: workspaceAccessFlags(new Set(["ledger.view"])) },
        projectId,
      ),
    );
    expect(totalOf(seeing, "budget_vs_actual", "هزینهٔ ثبت‌شده")).toBe(400_000_000);
    expect(totalOf(seeing, "budget_vs_actual", "انحراف")).toBe(-200_000_000);
    expect(totalOf(seeing, "budget_vs_actual", "مصرف‌شده")).toBe(200);
  });

  it("keeps another business's project out of every report", async () => {
    const mine = await provisionBusiness();
    const theirs = await provisionBusiness();
    const today = await businessToday(mine.businessId);
    const myProject = await createProject(mine.businessId, mine.owner.actorUserId, "پروژهٔ من");
    const theirProject = await createProject(theirs.businessId, theirs.owner.actorUserId, "پروژهٔ دیگر");
    const theirSupplier = await createParty(theirs.businessId, "تأمین‌کنندهٔ دیگر");
    await seedReportFixture(theirs.owner, theirProject, today);
    await seedApprovedCommitment(theirs.owner, theirProject, theirSupplier, 500_000_000, daysAgo(today, 20));

    // The project is asserted once, before any register runs: another tenant's
    // id is `project_not_found`, never a page of empty reports that hides the
    // typo — and the same predicate every other AEC aggregate uses.
    await withTenant(mine.businessId, async () => {
      await expect(reports.projectAecReports(mine.owner, theirProject)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "project_not_found");
          return true;
        },
      );
    });

    // My own project is readable, and the registers are mine: none of their
    // rows — phases, tasks, RFIs, awards, snags — reaches my bundle.
    const own = await withTenant(mine.businessId, () =>
      reports.projectAecReports(mine.owner, myProject),
    );
    expect(own.projectName).toBe("پروژهٔ من");
    expect(reportFor(own, "project_health").rows[0].taskCount).toBe(0);
    expect(reportFor(own, "schedule_variance").rows).toEqual([]);
    expect(reportFor(own, "rfi_aging").rows).toEqual([]);
    expect(totalOf(own, "procurement_delay", "تعهدهای تأخیری")).toBe(0);
    expect(totalOf(own, "contractor_performance", "تأمین‌کنندگان")).toBe(0);
    expect(totalOf(own, "change_order_exposure", "تغییرات باز")).toBe(0);
    expect(totalOf(own, "snag_aging", "نقص باز")).toBe(0);
  });

  it("refuses a business that is not in the AEC industry", async () => {
    const { businessId, owner } = await provisionBusiness("food_service");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ رستوران");
    await withTenant(businessId, async () => {
      await expect(reports.projectAecReports(owner, projectId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });
  });

  it("caps a long register and says how many rows did not print", async () => {
    const { businessId, owner } = await provisionBusiness();
    const today = await businessToday(businessId);
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ گزارش بلند");
    // 30 open snags: more than a screen shows, fewer than a register holds.
    for (let index = 1; index <= 30; index += 1) {
      await db.query(
        `INSERT INTO aec_site_issues (business_id, project_id, issue_number, kind, title, severity,
                                      raised_date, due_date, status, created_by_name)
         VALUES ($1, $2, $3, 'snag', $4, 'low', $5::date, $6::date, 'open', 'مالک')`,
        [
          businessId,
          projectId,
          `SN-${String(index).padStart(3, "0")}`,
          `نقص شمارهٔ ${index}`,
          daysAgo(today, 40 + index),
          daysAgo(today, index),
        ],
      );
    }

    const bundle = await withTenant(businessId, () => reports.projectAecReports(owner, projectId));
    const snags = reportFor(bundle, "snag_aging");
    expect(snags.rows).toHaveLength(reports.AEC_REPORT_ROW_LIMIT);
    expect(snags.omittedRows).toBe(30 - reports.AEC_REPORT_ROW_LIMIT);
    // The register is where the rest of the list lives, and every printed row is
    // still aged against the business's own day.
    expect(totalOf(bundle, "snag_aging", "نقص باز")).toBe(30);
    expect(snags.totals.find((entry) => entry.label === "نقص باز")?.kind).toBe("number");
  });
});
