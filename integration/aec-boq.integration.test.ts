/**
 * Issue #799 Wave 4 (§7) — the BOQ, its revisions and its life cycle, against a
 * real PostgreSQL.
 *
 * `src/lib/aec-boq.test.ts` proves the pure half: the status flow and the
 * arithmetic mirror. What can only be proven here is what the schema and the
 * service do together:
 *
 *   * the trigger, not the caller, decides the unit price and the line total —
 *     including when the caller writes them by hand in raw SQL;
 *   * the mirror in `src/lib/aec-boq.ts` produces the same number as the
 *     trigger for the same rates, so the preview is never a lie;
 *   * an approved revision is frozen in the database as well as in the service:
 *     the line guard refuses an edit even to a connection that bypasses every
 *     service-level check;
 *   * submitting files exactly one `workspace_approvals` row with the new
 *     `estimate_version` subject, which the existing approval queue renders and
 *     `decideApproval` decides — the whole point of reusing the engine;
 *   * approving writes the working budget to `ai_projects.budget_rial`, then
 *     follows its own number forward and never overwrites a hand-typed one;
 *   * the variance's actual cost comes from `journal_entries.project_id` — the
 *     BOQ domain owns five tables and no second cost ledger;
 *   * the five tables carry forced RLS with a policy, so
 *     `tenant-isolation.integration.test.ts`'s sweep finds nothing missing and
 *     another business sees no row.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { computeBoqItemTotals } from "../src/lib/aec-boq";
import type { AecError } from "../src/lib/aec-service";

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
let workspace: typeof import("../src/lib/workspace");
let crm: typeof import("../src/lib/crm-service");

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
  databaseName = `pos_aec_boq_${randomUUID().replaceAll("-", "")}`;

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
  workspace = await import("../src/lib/workspace");
  crm = await import("../src/lib/crm-service");

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

async function provisionBusiness(industry: "architecture_construction" | "food_service") {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار متره ${seq}`,
    ownerName: "مالک",
    email: `owner-boq-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `boq${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction") {
    // A newly provisioned business starts as `architecture_office`, and §2's
    // design preset deliberately has no `boq`: an office that draws does not
    // necessarily price. The contractor profile is the one that estimates by
    // preset, so these tests select it the way a real business would — through
    // the profile screen, not by writing a capability override.
    await withTenant(result.businessId, () =>
      aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }),
    );
  }
  return { businessId: result.businessId, owner };
}

/** `dbLib.withTenant`, captured so the helper above can run before the suite. */
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

async function createParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, $2, 'supplier') RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/**
 * A party the CRM may merge. `mergeCustomers` only touches records carrying the
 * `customer` role, which is exactly the case the BOQ's party reference has to
 * survive — a business that buys from and bills the same contractor.
 */
async function createCustomerParty(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, 'customer', ARRAY['customer']::text[]) RETURNING id`,
    [businessId, name],
  );
  return rows[0].id;
}

/** One posted cost against a project — what Accounting's ledger holds. */
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

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A project with one estimate whose first revision holds the given lines. */
async function seedEstimate(
  owner: { businessId: string; actorUserId: string; actorName: string },
  projectName: string,
  items: Array<Record<string, unknown>>,
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  return dbLib.withTenant(owner.businessId, async () => {
    const estimate = await boq.createEstimate(owner, projectId, { title: "برآورد اصلی" });
    const versionId = estimate.versions[0].id;
    const tree = await boq.saveDraftVersion(owner, versionId, {
      sections: [{ code: "01", title: "عملیات خاکی" }],
      items,
    });
    return { projectId, estimateId: estimate.id, versionId, tree };
  });
}

describe("the BOQ arithmetic (issue #799 §7)", () => {
  it("stores the numbers the screen previewed, line by line", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const supplier = await createParty(businessId, "بتن آمادهٔ البرز");
    const lines = [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "خاک‌برداری با ماشین",
        unit: "m3",
        quantity: "1250.5",
        materialRateRial: 0,
        laborRateRial: 180_000,
        equipmentRateRial: 320_000,
        subcontractRateRial: 0,
        wastePercent: "2.5",
        overheadPercent: "7",
        markupPercent: "12",
        workPackage: "خاکی",
        notes: "",
      },
      {
        sectionIndex: 0,
        itemCode: "01-20",
        description: "بتن مگر م۱۵",
        unit: "مترمکعب",
        quantity: "0.0001",
        materialRateRial: 4_500_000,
        laborRateRial: 900_000,
        equipmentRateRial: 250_000,
        subcontractRateRial: 1_000_000,
        wastePercent: "5",
        overheadPercent: "0",
        markupPercent: "0",
        workPackage: "بتن",
        notes: "با تأیید ناظر",
      },
      {
        sectionIndex: null,
        itemCode: "",
        description: "پرتی و ضایعات",
        unit: "کیسه",
        quantity: "2.5",
        materialRateRial: 1_234_567,
        laborRateRial: 0,
        equipmentRateRial: 0,
        subcontractRateRial: 0,
        wastePercent: "0",
        overheadPercent: "0",
        markupPercent: "33.33",
        workPackage: "",
        partyId: supplier,
        notes: "",
      },
    ];

    const { projectId, estimateId, versionId, tree } = await seedEstimate(owner, "ساختمان اداری", lines);
    expect(tree.versionTree?.sections).toHaveLength(1);
    expect(tree.versionTree?.unsectionedItems).toHaveLength(1);

    // The mirror, applied to what was sent, must equal what came back — and
    // what came back is what the trigger computed inside the database.
    const items = [
      ...(tree.versionTree?.sections.flatMap((section) => section.items) ?? []),
      ...(tree.versionTree?.unsectionedItems ?? []),
    ];
    for (const [index, item] of items.entries()) {
      const expected = computeBoqItemTotals({
        quantity: item.quantity,
        materialRateRial: item.materialRateRial,
        laborRateRial: item.laborRateRial,
        equipmentRateRial: item.equipmentRateRial,
        subcontractRateRial: item.subcontractRateRial,
        wastePercent: item.wastePercent,
        overheadPercent: item.overheadPercent,
        markupPercent: item.markupPercent,
      });
      expect(expected.unitPriceRial, `line ${index} unit price`).toBe(item.unitPriceRial);
      expect(expected.totalRial, `line ${index} total`).toBe(item.totalRial);
    }

    // The unit the spreadsheet used was normalised to the catalogue's key, and
    // the supplier somebody typed was kept as a party reference.
    expect(items[1].unit).toBe("m3");
    expect(items[2].partyId).toBe(supplier);
    expect(items[2].partyName).toBe("بتن آمادهٔ البرز");
    expect(items[2].unitPriceRial).toBe(Math.round(1_234_567 * 1.3333));

    // The revision's denormalised totals follow its lines (the AFTER trigger).
    const list = await dbLib.withTenant(businessId, () => boq.listProjectEstimates(businessId, projectId));
    const version = list[0].versions.find((row) => row.id === versionId);
    expect(version?.itemCount).toBe(3);
    expect(version?.totalRial).toBe(items.reduce((sum, item) => sum + item.totalRial, 0));
    expect(list[0].id).toBe(estimateId);
  });

  it("lets nobody — not even raw SQL — write a price that disagrees with the rates", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { versionId } = await seedEstimate(owner, "پروژهٔ راستی‌آزمایی", [
      {
        sectionIndex: 0,
        itemCode: "02-10",
        description: "آجرچینی با ملات ماسه‌سیمان",
        unit: "m2",
        quantity: "10",
        materialRateRial: 1_000_000,
        laborRateRial: 400_000,
        equipmentRateRial: 0,
        subcontractRateRial: 100_000,
        wastePercent: "10",
        overheadPercent: "5",
        markupPercent: "20",
      },
    ]);

    await dbLib.withTenant(businessId, async () => {
      // A hand-written INSERT that claims its own totals: the trigger replaces
      // them before the row is stored.
      const { rows } = await dbLib.query<{ unit_price_rial: string; total_rial: string }>(
        `INSERT INTO aec_boq_items
           (business_id, version_id, description, unit, quantity, material_rate_rial,
            unit_price_rial, total_rial)
         VALUES ($1, $2, 'ردیف دست‌ساز', 'm2', 4, 250000, 7, 7)
         RETURNING unit_price_rial, total_rial`,
        [businessId, versionId],
      );
      expect(Number(rows[0].unit_price_rial)).toBe(250_000);
      expect(Number(rows[0].total_rial)).toBe(1_000_000);

      // And an UPDATE cannot smuggle one in either: raising the markup to 100%
      // re-prices the line (1 500 000 × 1.10 × 1.05 × 2.00), and the 1 rial the
      // statement tried to write is gone.
      const { rows: updated } = await dbLib.query<{ unit_price_rial: string; total_rial: string }>(
        `UPDATE aec_boq_items SET markup_percent = 100, unit_price_rial = 1, total_rial = 1
          WHERE business_id = $1 AND version_id = $2 AND item_code = '02-10'
        RETURNING unit_price_rial, total_rial`,
        [businessId, versionId],
      );
      expect(Number(updated[0].unit_price_rial)).toBe(3_465_000);
      expect(Number(updated[0].total_rial)).toBe(34_650_000);
    });
  });

  it("owns five tables and no second actual-cost ledger", async () => {
    // §7: "actual cost must continue to come from Accounting". A cost table
    // inside this domain would be the second ledger the issue forbids, so the
    // set is asserted rather than assumed.
    const { rows } = await db.query<{ relname: string; rls: boolean; force: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND (c.relname LIKE 'aec\\_estimate%' OR c.relname LIKE 'aec\\_boq%')
        ORDER BY c.relname`,
    );
    expect(rows.map((row) => row.relname)).toEqual([
      "aec_boq_items",
      "aec_boq_sections",
      "aec_estimate_events",
      "aec_estimate_versions",
      "aec_estimates",
    ]);
    for (const table of rows) {
      expect(table.rls, table.relname).toBe(true);
      expect(table.force, table.relname).toBe(true);
      expect(Number(table.policies), table.relname).toBe(1);
    }
  });
});

describe("the revision life cycle (issue #799 §7)", () => {
  it("files one approval on submit, shown in the existing queue and decided there", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, estimateId, versionId } = await seedEstimate(owner, "مجتمع تجاری", [
      {
        sectionIndex: 0,
        itemCode: "05-10",
        description: "اسکلت فلزی",
        unit: "kg",
        quantity: "18500",
        materialRateRial: 420_000,
        laborRateRial: 180_000,
        equipmentRateRial: 60_000,
        subcontractRateRial: 0,
        wastePercent: "3",
        overheadPercent: "6",
        markupPercent: "10",
      },
    ]);

    const submitted = await dbLib.withTenant(businessId, () =>
      boq.submitEstimateVersion(owner, versionId, { note: "برای تأیید کارفرما" }),
    );
    expect(submitted.status).toBe("submitted");

    const approvals = await dbLib.withTenant(businessId, () =>
      workspace.listApprovals(businessId, { subjectType: "estimate_version" }),
    );
    expect(approvals).toHaveLength(1);
    const approval = approvals[0];
    expect(approval.subjectType).toBe("estimate_version");
    expect(approval.subjectId).toBe(versionId);
    expect(approval.projectId).toBe(projectId);
    // The queue's own title resolver reaches the AEC table — the
    // `estimate_version` branch in `APPROVAL_SELECT`.
    expect(approval.title).toContain("برآورد اصلی");
    expect(approval.subjectTitle).toContain("برآورد اصلی");
    expect(approval.status).toBe("pending");

    // Deciding it from the approval route's point of view: the revision moves,
    // the request is closed, and the budget is written.
    const decided = await dbLib.withTenant(businessId, () =>
      boq.decideEstimateApproval(owner, approval.id, "approved", "تأیید شد"),
    );
    expect(decided).toEqual({ versionId, applied: true });

    const tree = await dbLib.withTenant(businessId, () =>
      boq.loadEstimateTree(businessId, estimateId, { versionId }),
    );
    expect(tree.versionTree?.version.status).toBe("approved");
    expect(tree.versionTree?.version.approvedAt).not.toBeNull();
    // §7's audit trail, newest first — the order the panel prints it in.
    expect(tree.events.map((event) => event.action)).toEqual(["approved", "submitted", "created"]);
    expect(tree.events[0].actorName).toBe("مالک");
    expect(tree.events[0].actionLabel).toBe("تأیید شد");

    const closed = await dbLib.withTenant(businessId, () =>
      workspace.listApprovals(businessId, { subjectType: "estimate_version" }),
    );
    expect(closed[0].status).toBe("approved");
    expect(closed[0].decidedBy).toBe(owner.actorUserId);

    const { rows } = await db.query<{ budget_rial: string | null }>(
      `SELECT budget_rial FROM ai_projects WHERE id = $1`,
      [projectId],
    );
    expect(Number(rows[0].budget_rial)).toBe(tree.versionTree?.version.totalRial);

    // Deciding it a second time is a no-op rather than a second approval.
    const again = await dbLib.withTenant(businessId, () =>
      boq.decideEstimateApproval(owner, approval.id, "approved"),
    );
    expect(again.applied).toBe(false);
  });

  it("follows its own number forward and never overwrites a typed budget", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, estimateId, versionId } = await seedEstimate(owner, "انبار مرکزی", [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "فونداسیون",
        unit: "m3",
        quantity: "100",
        materialRateRial: 5_000_000,
        laborRateRial: 2_000_000,
        equipmentRateRial: 1_000_000,
        subcontractRateRial: 0,
        wastePercent: "0",
        overheadPercent: "0",
        markupPercent: "0",
      },
    ]);

    // §7's flow is a flow: a draft cannot jump straight to approved, because
    // nobody would have seen it.
    await dbLib.withTenant(businessId, async () => {
      await expect(boq.approveEstimateVersion(owner, versionId, "")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "invalid_estimate_transition");
          return true;
        },
      );
    });

    // 1. An empty budget is set from the approved total.
    const first = await dbLib.withTenant(businessId, async () => {
      await boq.submitEstimateVersion(owner, versionId, {});
      return boq.approveEstimateVersion(owner, versionId, "");
    });
    expect(first.budgetSync).toBe("set");
    expect(first.projectBudgetRial).toBe(800_000_000);

    // 2. The next revision supersedes this one, and because the budget still
    //    holds the superseded total, it moves with it.
    const second = await dbLib.withTenant(businessId, async () => {
      const version = await boq.createEstimateVersion(owner, estimateId, {
        cloneFromVersionId: versionId,
        title: "نسخهٔ دوم",
      });
      await boq.saveDraftVersion(owner, version.id, {
        sections: [{ code: "01", title: "فونداسیون" }],
        items: [
          {
            sectionIndex: 0,
            itemCode: "01-10",
            description: "فونداسیون",
            unit: "m3",
            quantity: "100",
            materialRateRial: 5_000_000,
            laborRateRial: 3_000_000,
            equipmentRateRial: 1_000_000,
            subcontractRateRial: 0,
            wastePercent: "0",
            overheadPercent: "0",
            markupPercent: "0",
          },
        ],
      });
      await boq.submitEstimateVersion(owner, version.id, {});
      return boq.approveEstimateVersion(owner, version.id, "");
    });
    expect(second.budgetSync).toBe("updated");
    expect(second.projectBudgetRial).toBe(900_000_000);

    // The first revision is retired, not deleted — §7's "never overwrite an
    // approved historical estimate".
    const list = await dbLib.withTenant(businessId, () => boq.listProjectEstimates(businessId, projectId));
    const statuses = list[0].versions.map((version) => [version.versionNo, version.status]);
    expect(statuses).toEqual([
      [2, "approved"],
      [1, "superseded"],
    ]);

    // 3. A budget somebody typed is a decision, not a cache: it stays put and
    //    the approval says which happened.
    await db.query(`UPDATE ai_projects SET budget_rial = 1234567890 WHERE id = $1`, [projectId]);
    const third = await dbLib.withTenant(businessId, async () => {
      const version = await boq.createEstimateVersion(owner, estimateId, {
        cloneFromVersionId: versionId,
        title: "نسخهٔ سوم",
      });
      await boq.saveDraftVersion(owner, version.id, {
        sections: [],
        items: [
          {
            sectionIndex: null,
            itemCode: "01-10",
            description: "فونداسیون",
            unit: "m3",
            quantity: "100",
            materialRateRial: 9_000_000,
            laborRateRial: 0,
            equipmentRateRial: 0,
            subcontractRateRial: 0,
            wastePercent: "0",
            overheadPercent: "0",
            markupPercent: "0",
          },
        ],
      });
      await boq.submitEstimateVersion(owner, version.id, {});
      return boq.approveEstimateVersion(owner, version.id, "");
    });
    expect(third.budgetSync).toBe("kept_manual");
    const { rows } = await db.query<{ budget_rial: string }>(
      `SELECT budget_rial FROM ai_projects WHERE id = $1`,
      [projectId],
    );
    expect(Number(rows[0].budget_rial)).toBe(1_234_567_890);
  });

  it("freezes an approved revision in the database, not only in the service", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { estimateId, versionId } = await seedEstimate(owner, "پروژهٔ قفل‌شده", [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "دیوار برشی",
        unit: "m3",
        quantity: "30",
        materialRateRial: 8_000_000,
        laborRateRial: 3_000_000,
        equipmentRateRial: 500_000,
        subcontractRateRial: 0,
        wastePercent: "2",
        overheadPercent: "4",
        markupPercent: "8",
      },
    ]);
    await dbLib.withTenant(businessId, async () => {
      await boq.submitEstimateVersion(owner, versionId, {});
      await boq.approveEstimateVersion(owner, versionId, "");
    });

    await dbLib.withTenant(businessId, async () => {
      // The service refuses first…
      await expect(
        boq.saveDraftVersion(owner, versionId, { sections: [], items: [] }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "version_not_editable");
        return true;
      });

      // …and the line guard refuses a connection that talks to the table
      // directly, which is what makes the lock real.
      await expect(
        dbLib.query(`UPDATE aec_boq_items SET quantity = 999 WHERE business_id = $1 AND version_id = $2`, [
          businessId,
          versionId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(
          `INSERT INTO aec_boq_sections (business_id, version_id, code, title, display_order)
           VALUES ($1, $2, '99', 'فصل تازه', 9)`,
          [businessId, versionId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`DELETE FROM aec_boq_items WHERE business_id = $1 AND version_id = $2`, [
          businessId,
          versionId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      // The revision itself cannot be deleted either, and its status cannot go
      // backwards — approved only ever becomes superseded.
      await expect(
        dbLib.query(`DELETE FROM aec_estimate_versions WHERE business_id = $1 AND id = $2`, [
          businessId,
          versionId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`UPDATE aec_estimate_versions SET status = 'draft' WHERE business_id = $1 AND id = $2`, [
          businessId,
          versionId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    // Deleting the estimate that holds an approved revision is refused, while
    // an estimate that never got past draft still deletes.
    await dbLib.withTenant(businessId, async () => {
      await expect(boq.deleteEstimate(owner, estimateId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "estimate_has_approved_version");
        return true;
      });
      const draftOnly = await boq.createEstimate(owner, (
        await dbLib.query<{ project_id: string }>(
          `SELECT project_id FROM aec_estimates WHERE business_id = $1 AND id = $2`,
          [businessId, estimateId],
        )
      ).rows[0].project_id, { title: "برآورد کنارگذاشته" });
      await boq.deleteEstimate(owner, draftOnly.id);
      const { rows } = await dbLib.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM aec_estimates WHERE business_id = $1 AND id = $2`,
        [businessId, draftOnly.id],
      );
      expect(rows[0].count).toBe("0");
    });
  });

  it("sends a rejected revision back to its author with the reason recorded", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { estimateId, versionId } = await seedEstimate(owner, "ویلای شمال", [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "سقف تیرچه‌بلوک",
        unit: "m2",
        quantity: "210.75",
        materialRateRial: 2_100_000,
        laborRateRial: 800_000,
        equipmentRateRial: 120_000,
        subcontractRateRial: 0,
        wastePercent: "4",
        overheadPercent: "5",
        markupPercent: "15",
      },
    ]);

    const { approvalId } = await dbLib.withTenant(businessId, async () => {
      await boq.submitEstimateVersion(owner, versionId, {});
      await boq.startEstimateReview(owner, versionId);
      const [pending] = await workspace.listApprovals(businessId, {
        subjectType: "estimate_version",
        status: "pending",
      });
      return { approvalId: pending.id };
    });

    await dbLib.withTenant(businessId, async () => {
      const result = await boq.decideEstimateApproval(owner, approvalId, "rejected", "نرخ مصالح قدیمی است");
      expect(result).toEqual({ versionId, applied: true });

      const tree = await boq.loadEstimateTree(businessId, estimateId, { versionId });
      expect(tree.versionTree?.version.status).toBe("draft");
      const latest = tree.events[0];
      expect(latest.action).toBe("returned");
      expect(latest.summary).toContain("نرخ مصالح قدیمی است");

      // Back in draft, the editor works again and the author can resubmit.
      const edited = await boq.saveDraftVersion(owner, versionId, {
        sections: [{ code: "01", title: "سقف" }],
        items: [
          {
            sectionIndex: 0,
            itemCode: "01-10",
            description: "سقف تیرچه‌بلوک",
            unit: "m2",
            quantity: "210.75",
            materialRateRial: 2_600_000,
            laborRateRial: 800_000,
            equipmentRateRial: 120_000,
            subcontractRateRial: 0,
            wastePercent: "4",
            overheadPercent: "5",
            markupPercent: "15",
          },
        ],
      });
      expect(edited.versionTree?.version.status).toBe("draft");
      expect(edited.versionTree?.totalRial).toBeGreaterThan(0);
      await boq.submitEstimateVersion(owner, versionId, {});
      const queue = await workspace.listApprovals(businessId, { subjectType: "estimate_version" });
      expect(queue.map((row) => row.status)).toEqual(["pending", "rejected"]);
    });
  });
});

describe("the BOQ against the rest of the product (issue #799 §7 and §30)", () => {
  it("reads actual cost from Accounting's ledger and computes the variance", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, versionId } = await seedEstimate(owner, "پروژهٔ مالی", [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "خاک‌برداری",
        unit: "m3",
        quantity: "1000",
        materialRateRial: 0,
        laborRateRial: 200_000,
        equipmentRateRial: 300_000,
        subcontractRateRial: 0,
        wastePercent: "0",
        overheadPercent: "0",
        markupPercent: "0",
      },
      {
        sectionIndex: 0,
        itemCode: "01-20",
        description: "بتن مگر",
        unit: "m3",
        quantity: "50",
        materialRateRial: 4_000_000,
        laborRateRial: 1_000_000,
        equipmentRateRial: 0,
        subcontractRateRial: 0,
        wastePercent: "0",
        overheadPercent: "0",
        markupPercent: "0",
      },
    ]);
    await dbLib.withTenant(businessId, async () => {
      await boq.submitEstimateVersion(owner, versionId, {});
      await boq.approveEstimateVersion(owner, versionId, "");
    });
    await postProjectCost(businessId, projectId, 180_000_000);

    const variance = await dbLib.withTenant(businessId, () => boq.boqVariance(businessId, projectId));
    expect(variance).not.toBeNull();
    expect(variance?.approvedEstimateRial).toBe(500_000_000 + 250_000_000);
    expect(variance?.approvedVersionNo).toBe(1);
    expect(variance?.spentRial).toBe(180_000_000);
    expect(variance?.remainingRial).toBe(570_000_000);
    // §7: the working budget the approval wrote is part of the same picture.
    expect(variance?.budgetRial).toBe(750_000_000);
    expect(variance?.bySection).toEqual([{ title: "عملیات خاکی", totalRial: 750_000_000 }]);
    expect(variance?.openVersionCount).toBe(0);

    // An open draft counts as unfinished work rather than as the estimate.
    await dbLib.withTenant(businessId, async () => {
      const { rows } = await dbLib.query<{ estimate_id: string }>(
        `SELECT estimate_id FROM aec_estimate_versions WHERE business_id = $1 AND id = $2`,
        [businessId, versionId],
      );
      const version = await boq.createEstimateVersion(owner, rows[0].estimate_id, {});
      const open = await boq.boqVariance(businessId, projectId);
      expect(open?.latestVersionNo).toBe(version.versionNo);
      expect(open?.latestVersionStatus).toBe("draft");
      expect(open?.openVersionCount).toBe(1);
      expect(open?.approvedEstimateRial).toBe(750_000_000);
    });

    // §7 allows more than one estimate on a project — an original and a
    // variation, say. When both hold an approved revision, the project's working
    // figure is the one approved **most recently**, not the one with the
    // highest version number: revision numbers count within an estimate, so
    // comparing them across two estimates compares nothing.
    await dbLib.withTenant(businessId, async () => {
      const { rows } = await dbLib.query<{ estimate_id: string; version_id: string }>(
        `SELECT e.id AS estimate_id, v.id AS version_id
           FROM aec_estimates e JOIN aec_estimate_versions v ON v.estimate_id = e.id
          WHERE e.business_id = $1 AND e.title = 'برآورد اصلی' AND v.status = 'approved'
          ORDER BY v.version_no DESC LIMIT 1`,
        [businessId],
      );
      const original = rows[0];
      // Clone the approved revision — its lines come with it — and approve the
      // copy, so the original outranks the variation by version number.
      const second = await boq.createEstimateVersion(owner, original.estimate_id, {
        cloneFromVersionId: original.version_id,
        title: "نسخهٔ دوم",
      });
      await boq.submitEstimateVersion(owner, second.id, {});
      await boq.approveEstimateVersion(owner, second.id, "");

      const variation = await boq.createEstimate(owner, projectId, { title: "برآورد تغییرات" });
      await boq.saveDraftVersion(owner, variation.versions[0].id, {
        sections: [],
        items: [
          {
            sectionIndex: null,
            itemCode: "V-01",
            description: "تغییرات الحاقی",
            unit: "مقطوع",
            quantity: "1",
            materialRateRial: 1_000_000_000,
            laborRateRial: 0,
            equipmentRateRial: 0,
            subcontractRateRial: 0,
            wastePercent: "0",
            overheadPercent: "0",
            markupPercent: "0",
          },
        ],
      });
      await boq.submitEstimateVersion(owner, variation.versions[0].id, {});
      await boq.approveEstimateVersion(owner, variation.versions[0].id, "");

      const after = await boq.boqVariance(businessId, projectId);
      expect(after?.approvedEstimateRial).toBe(1_000_000_000);
      expect(after?.approvedVersionNo).toBe(1); // the variation's own first revision
    });
  });

  it("lands an imported spreadsheet row in the right estimate, revision and chapter", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ ورود فایل");
    const supplier = await createParty(businessId, "تأمین‌کنندهٔ آجر");

    const row = {
      projectName: "پروژهٔ ورود فایل",
      estimateTitle: "",
      versionNo: null,
      sectionCode: "04",
      sectionTitle: "سفت‌کاری",
      itemCode: "04-10",
      description: "دیوار چینی آجر فشاری",
      unit: "متر مربع",
      quantity: "312.5",
      materialRateRial: 1_500_000,
      laborRateRial: 700_000,
      equipmentRateRial: 80_000,
      subcontractRateRial: 0,
      wastePercent: "3",
      overheadPercent: "2",
      markupPercent: "12",
      workPackage: "سفت‌کاری",
      partyId: supplier,
      notes: "از فایل متره",
      duplicateStrategy: "create" as const,
    };

    await dbLib.withTenant(businessId, async () => {
      // The default estimate and its first draft are created on demand, so an
      // operator with a spreadsheet needs no preparation at all.
      const created = await boq.importBoqItem(owner, row);
      expect(created.status).toBe("created");

      const repeated = await boq.importBoqItem(owner, { ...row, duplicateStrategy: "skip" });
      expect(repeated.status).toBe("skipped");
      expect(repeated.id).toBe(created.id);
      expect(repeated.reason).toContain("از پیش هست");

      const updated = await boq.importBoqItem(owner, {
        ...row,
        quantity: "400",
        duplicateStrategy: "update",
      });
      expect(updated.status).toBe("updated");
      expect(updated.id).toBe(created.id);

      const list = await boq.listProjectEstimates(businessId, projectId);
      expect(list.map((estimate) => estimate.title)).toEqual(["برآورد اصلی"]);
      expect(list[0].versions).toHaveLength(1);
      const tree = await boq.loadEstimateTree(businessId, list[0].id, {
        versionId: list[0].versions[0].id,
      });
      const section = tree.versionTree?.sections[0];
      expect(section?.code).toBe("04");
      expect(section?.title).toBe("سفت‌کاری");
      expect(section?.items).toHaveLength(1);
      expect(section?.items[0].quantity).toBe("400.0000");
      expect(section?.items[0].partyName).toBe("تأمین‌کنندهٔ آجر");
      // Re-importing an existing row updated it rather than adding a second.
      expect(tree.versionTree?.version.itemCount).toBe(1);
    });

    // A row that cannot be placed comes back with a reason instead of failing
    // the file — §7's "safe import".
    await dbLib.withTenant(businessId, async () => {
      const unknown = await boq.importBoqItem(owner, { ...row, projectName: "پروژهٔ ناموجود" });
      expect(unknown.status).toBe("skipped");
      expect(unknown.reason).toContain("پیدا نشد");

      const list = await boq.listProjectEstimates(businessId, projectId);
      await boq.submitEstimateVersion(owner, list[0].versions[0].id, {});
      await boq.approveEstimateVersion(owner, list[0].versions[0].id, "");
      const frozen = await boq.importBoqItem(owner, { ...row, versionNo: 1 });
      expect(frozen.status).toBe("skipped");
      expect(frozen.reason).toContain("تأیید");
    });
  });

  it("follows a supplier merge on a draft line, and leaves an approved one as it was", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const supplier = await createCustomerParty(businessId, "آهن‌فروشی البرز");
    const { estimateId, versionId } = await seedEstimate(owner, "پروژهٔ ادغام", [
      {
        sectionIndex: 0,
        itemCode: "05-10",
        description: "میلگرد آجدار",
        unit: "kg",
        quantity: "12000",
        materialRateRial: 380_000,
        laborRateRial: 90_000,
        equipmentRateRial: 20_000,
        subcontractRateRial: 0,
        wastePercent: "2",
        overheadPercent: "3",
        markupPercent: "8",
        partyId: supplier,
      },
    ]);
    await dbLib.withTenant(businessId, async () => {
      await boq.submitEstimateVersion(owner, versionId, {});
      await boq.approveEstimateVersion(owner, versionId, "");
    });

    // The next revision names the same supplier, and is still a draft — the
    // state in which a merge has to be able to re-point the row.
    const draftVersionId = await dbLib.withTenant(businessId, async () => {
      const version = await boq.createEstimateVersion(owner, estimateId, {
        cloneFromVersionId: versionId,
        title: "نسخهٔ دوم",
      });
      return version.id;
    });

    const duplicate = await createCustomerParty(businessId, "آهن‌فروشی البرز ۲");
    const merged = await dbLib.withTenant(businessId, () =>
      crm.mergeCustomers(businessId, duplicate, supplier, { mergedBy: "مالک" }),
    );
    expect(merged).not.toBeNull();

    await dbLib.withTenant(businessId, async () => {
      const { rows } = await dbLib.query<{ version_id: string; party_id: string | null; status: string }>(
        `SELECT i.version_id, i.party_id, v.status
           FROM aec_boq_items i JOIN aec_estimate_versions v ON v.id = i.version_id
          WHERE i.business_id = $1 ORDER BY v.version_no`,
        [businessId],
      );
      // Newest revision last (the rows are ordered by version number).
      expect(rows).toHaveLength(2);
      // The approved revision keeps the name it was approved with — migration
      // 0196's line guard would refuse the write anyway.
      expect(rows[0].version_id).toBe(versionId);
      expect(rows[0].status).toBe("approved");
      expect(rows[0].party_id).toBe(supplier);
      // …while the draft line follows the surviving record.
      expect(rows[1].version_id).toBe(draftVersionId);
      expect(rows[1].status).toBe("draft");
      expect(rows[1].party_id).toBe(duplicate);

      // And the draft is still editable: the merge left no row the model can
      // refuse to write.
      const edited = await boq.saveDraftVersion(owner, draftVersionId, {
        sections: [{ code: "05", title: "اسکلت" }],
        items: [
          {
            sectionIndex: 0,
            itemCode: "05-10",
            description: "میلگرد آجدار",
            unit: "kg",
            quantity: "12500",
            materialRateRial: 380_000,
            laborRateRial: 90_000,
            equipmentRateRial: 20_000,
            subcontractRateRial: 0,
            wastePercent: "2",
            overheadPercent: "3",
            markupPercent: "8",
            partyId: duplicate,
          },
        ],
      });
      expect(edited.versionTree?.version.status).toBe("draft");
    });
  });

  it("refuses a non-AEC business and shows another business nothing", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, estimateId, versionId } = await seedEstimate(owner, "پروژهٔ محرمانه", [
      {
        sectionIndex: 0,
        itemCode: "01-10",
        description: "قیمت محرمانه",
        unit: "m2",
        quantity: "10",
        materialRateRial: 1_000_000,
        laborRateRial: 0,
        equipmentRateRial: 0,
        subcontractRateRial: 0,
        wastePercent: "0",
        overheadPercent: "0",
        markupPercent: "0",
      },
    ]);

    // Another business cannot reach the row even knowing every id.
    const intruder = await provisionBusiness("architecture_construction");
    await dbLib.withTenant(intruder.businessId, async () => {
      await expect(
        boq.loadEstimateTree(intruder.businessId, estimateId, { versionId }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "estimate_not_found");
        return true;
      });
      await expect(
        boq.listProjectEstimates(intruder.businessId, projectId),
      ).resolves.toEqual([]);
      // A write that names its own business but the other business's id changes
      // nothing — the predicate and the forced policy both say no.
      const { rows: touched } = await dbLib.query<{ id: string }>(
        `UPDATE aec_estimate_versions SET title = 'دزدیده‌شده'
          WHERE business_id = $1 AND id = $2 RETURNING id`,
        [intruder.businessId, versionId],
      );
      expect(touched).toHaveLength(0);
    });

    // And bypassing the service entirely, the composite foreign key refuses to
    // file one business's line under another business's revision.
    await expect(
      db.query(
        `INSERT INTO aec_boq_items (business_id, version_id, description, unit, quantity)
         VALUES ($1, $2, 'ردیف بیگانه', 'm2', 1)`,
        [intruder.businessId, versionId],
      ),
    ).rejects.toThrow(/aec_boq_items_business_id_version_id_fkey/);

    // A restaurant's business has no BOQ at all — refused, not hidden.
    const cafe = await provisionBusiness("food_service");
    const cafeProject = await createProject(cafe.businessId, cafe.owner.actorUserId, "پروژهٔ کافه");
    await dbLib.withTenant(cafe.businessId, async () => {
      await expect(boq.listProjectEstimates(cafe.businessId, cafeProject)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "industry_mismatch");
          return true;
        },
      );
      const skipped = await boq.importBoqItem(
        { businessId: cafe.businessId, actorUserId: cafe.owner.actorUserId },
        {
          projectName: "پروژهٔ کافه",
          estimateTitle: "",
          versionNo: null,
          sectionCode: "",
          sectionTitle: null,
          itemCode: "",
          description: "ردیف ناخواسته",
          unit: "",
          quantity: 1,
          materialRateRial: 0,
          laborRateRial: 0,
          equipmentRateRial: 0,
          subcontractRateRial: 0,
          wastePercent: 0,
          overheadPercent: 0,
          markupPercent: 0,
          workPackage: "",
          partyId: null,
          notes: "",
          duplicateStrategy: "create",
        },
      );
      expect(skipped.status).toBe("skipped");
      expect(skipped.reason).toContain("عمرانی");
    });

    // With the AEC business's own estimating capability switched off, the
    // service refuses instead of returning an empty list.
    await dbLib.withTenant(businessId, async () => {
      await aec.saveBusinessAecProfile(owner, { capabilityOverrides: { boq: false } });
      await expect(boq.listProjectEstimates(businessId, projectId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
    });
  });
});
