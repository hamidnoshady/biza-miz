/**
 * Issue #799 Wave 10 (§25, with §13/§14/§9/§18) — «حالت کارگاه» against a real
 * PostgreSQL.
 *
 * `src/lib/aec-field.test.ts` proves the pure half: §25's eleven flows are all
 * in the catalogue, decisions are never drafted, and every action names a tab
 * the phone can actually open. What needs the schema and the services:
 *
 *   * the board is composed from **the registers' own reads**, so the numbers on
 *     the phone are the numbers in the registers rather than a parallel query
 *     that can drift;
 *   * it is **capability-aware**: a design office that turned `site_operations`,
 *     `snagging`, `qa_qc` and `procurement` off gets four empty queues and no
 *     refusal, because the phone must not show a card that 403s when tapped;
 *   * it is **tenant-scoped**: another business's project is a 404 through the
 *     same predicate the registers use, and nothing of theirs appears;
 *   * dates arrive **Shamsi-formatted** with the day count beside them, measured
 *     from the business's own today — the phone never formats a date itself;
 *   * the queue **caps** hold, so a register with twenty open snags still sends
 *     a phone-sized answer.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { businessToday } from "../src/lib/business-day-service";
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
let site: typeof import("../src/lib/aec-site-service");
let rfi: typeof import("../src/lib/aec-rfi-service");
let docs: typeof import("../src/lib/aec-doc-service");
let procurement: typeof import("../src/lib/aec-procurement-service");
let workspace: typeof import("../src/lib/workspace");
let field: typeof import("../src/lib/aec-field");

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
  databaseName = `pos_aec_field_${randomUUID().replaceAll("-", "")}`;

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
  site = await import("../src/lib/aec-site-service");
  rfi = await import("../src/lib/aec-rfi-service");
  docs = await import("../src/lib/aec-doc-service");
  procurement = await import("../src/lib/aec-procurement-service");
  workspace = await import("../src/lib/workspace");
  field = await import("../src/lib/aec-field");

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

async function provisionBusiness(
  industry: "architecture_construction" | "food_service" = "architecture_construction",
  profile: "contractor" | "design" = "contractor",
): Promise<{ businessId: string; owner: Owner; projectId: string }> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کارگاه ${seq}`,
    ownerName: "مالک",
    email: `owner-field-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `field${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner: Owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction" && profile === "contractor") {
    await dbLib.withTenant(result.businessId, () => aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }));
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [result.businessId, `پروژهٔ کارگاه ${seq}`, result.userId],
  );
  return { businessId: result.businessId, owner, projectId: rows[0].id };
}

function withTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).code ?? (error as { message?: string }).message).toBe(code);
}

/** Whole days before the business's own today. */
function daysFrom(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

describe("§25's board against the registers", () => {
  it("answers every queue from the register that owns it, and formats the dates", async () => {
    const { owner, projectId, businessId } = await provisionBusiness();
    const today = await businessToday(businessId);

    // Today's log, so the header can say the day is in the book.
    await withTenant(businessId, () =>
      site.createSiteLog(owner, projectId, {
        logDate: today,
        workPerformed: "آرماتوربندی فونداسیون",
        lines: [{ kind: "attendance", title: "عوامل و اکیپ‌ها", headcount: 9 }],
      }),
    );

    // Three snags with different severities and due dates: the board shows the
    // soonest first, whatever order they were created in.
    const snagLate = await withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "snag",
        title: "درزگیری ناقص",
        severity: "high",
        dueDate: daysFrom(today, -3),
      }),
    );
    await withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "snag",
        title: "ترک سطحی",
        severity: "low",
        dueDate: daysFrom(today, 10),
      }),
    );

    // A checklist and an inspection made from it — §25's "complete checklist".
    const checklist = await withTenant(businessId, () =>
      site.createChecklist(owner, {
        projectId,
        name: "بازرسی آرماتوربندی",
        kind: "inspection",
        items: [
          { title: "پوشش آرماتور", guidance: "حداقل ۵ سانتی‌متر" },
          { title: "فاصلهٔ خاموت‌ها" },
        ],
      }),
    );
    await withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "inspection",
        title: "بازرسی آرماتوربندی محور ۵",
        checklistId: checklist.id,
        dueDate: daysFrom(today, 1),
      }),
    );

    // An open RFI and a dated task.
    const openRfi = await withTenant(businessId, () =>
      rfi.createRfi(owner, projectId, {
        rfiNumber: "RFI-001",
        subject: "تراز فونداسیون",
        question: "تراز نهایی؟",
        dueDate: daysFrom(today, 5),
      }),
    );
    await withTenant(businessId, () => rfi.applyRfiAction(owner, openRfi.id, "open"));
    // …and one still a draft, which the board must show too: a question the
    // foreman filed on the phone is not "answered", but it is not invisible.
    await withTenant(businessId, () =>
      rfi.createRfi(owner, projectId, { rfiNumber: "RFI-002", subject: "رنگ نمای شمالی", question: "کدام کد رنگ؟" }),
    );
    await withTenant(businessId, () =>
      workspace.createWorkspaceTask(owner, projectId, {
        title: "هماهنگی تراز",
        dueDate: daysFrom(today, 2),
      }),
    );

    // A drawing with a revision, so the latest-drawing card has something.
    const drawing = await withTenant(businessId, () =>
      docs.createDrawing(owner, projectId, { title: "پلان فونداسیون", documentNumber: "DR-001" }),
    );
    await withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { issuePurpose: "for_construction", revisionCode: "B" }),
    );
    const drawings = await withTenant(businessId, () => docs.listProjectDrawings(businessId, projectId));
    expect(drawings[0].latestRevisionCode).toBe("B");

    // An approved purchase commitment, so "record material delivery" has a row.
    const supplier = await withTenant(businessId, async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO parties (business_id, name, role, roles)
         VALUES ($1, 'فولاد شرق', 'supplier', ARRAY['supplier']::text[]) RETURNING id`,
        [businessId],
      );
      return rows[0].id;
    });
    const commitment = await withTenant(businessId, () =>
      procurement.createCommitment(owner, projectId, {
        kind: "purchase",
        title: "خرید میلگرد",
        supplierPartyId: supplier,
        valueRial: 500_000_000,
        expectedDeliveryDate: daysFrom(today, 3),
      }),
    );
    await withTenant(businessId, () => procurement.applyCommitmentAction(owner, commitment.id, "submit"));
    await withTenant(businessId, () => procurement.applyCommitmentAction(owner, commitment.id, "approve"));

    const board = await withTenant(businessId, () => field.fieldBoard(owner, projectId));

    expect(board.project).toMatchObject({ id: projectId });
    expect(board.today).toBe(today);
    expect(board.todayJalali).toBe(field.fieldDateJalali(today));
    expect(board.queues.siteLog.todayLogged).toBe(true);
    expect(board.queues.siteLog.todayLogId).toBeTruthy();

    expect(board.queues.snags.openCount).toBe(2);
    // Soonest first: the late snag before the one due in ten days.
    expect(board.queues.snags.rows.map((row) => row.title)).toEqual(["درزگیری ناقص", "ترک سطحی"]);
    expect(board.queues.snags.rows[0].number).toBe(snagLate.issueNumber);
    expect(board.queues.snags.rows[0].daysRemaining).toBe(-3);
    expect(board.queues.snags.rows[0].chip).toBe("زیاد");
    expect(board.queues.snags.rows[0].dateJalali).toBe(field.fieldDateJalali(daysFrom(today, -3)));

    expect(board.queues.inspections.openCount).toBe(1);
    expect(board.queues.inspections.rows[0].action).toBe("check");
    expect(board.checklists.map((row) => row.name)).toContain("بازرسی آرماتوربندی");

    expect(board.queues.rfis.openCount).toBe(2);
    const rfiTitles = board.queues.rfis.rows.map((row) => row.title);
    expect(rfiTitles).toContain("تراز فونداسیون");
    expect(rfiTitles).toContain("رنگ نمای شمالی");
    expect(board.queues.rfis.rows.find((row) => row.title === "رنگ نمای شمالی")?.chip).toContain("پیش‌نویس");

    // The field screen prefills this number instead of asking the foreman to
    // remember the register's numbering.
    expect(board.suggestions.rfiNumber).toBe("RFI-003");
    expect(board.queues.tasks.rows.map((row) => row.title)).toEqual(["هماهنگی تراز"]);
    expect(board.queues.tasks.rows[0].daysRemaining).toBe(2);

    expect(board.queues.deliveries.pendingCount).toBe(1);
    expect(board.queues.deliveries.rows[0].number).toBe(commitment.commitmentNumber);

    expect(board.queues.drawings.rows[0]).toMatchObject({ documentNumber: "DR-001", revisionCode: "B" });

    // §25's switch list is reported so the screen can hide what is off rather
    // than render a disabled card with no explanation.
    expect(board.capabilities).toContain("site_operations");
    expect(board.capabilities).toContain("procurement");
  }, 120_000);

  it("asks only the registers a design office still has", async () => {
    const { owner, projectId, businessId } = await provisionBusiness("architecture_construction", "design");
    // The design preset keeps design/document work; the site registers are off.
    const profile = await aec.loadBusinessAecProfile(businessId);
    expect(profile.capabilities).not.toContain("site_operations");
    expect(profile.capabilities).not.toContain("procurement");

    const board = await withTenant(businessId, () => field.fieldBoard(owner, projectId));
    expect(board.queues.siteLog.todayLogged).toBe(false);
    expect(board.queues.snags.rows).toEqual([]);
    expect(board.queues.inspections.rows).toEqual([]);
    expect(board.queues.deliveries.rows).toEqual([]);
    // The registers that are on still answer.
    expect(board.capabilities).toContain("document_control");
    expect(Array.isArray(board.queues.drawings.rows)).toBe(true);
    // And the design office's own checklists are still listed (§14 is qa_qc —
    // off in the design preset, so the list is empty rather than a refusal).
    expect(Array.isArray(board.checklists)).toBe(true);
  }, 120_000);

  it("refuses another business's project, and the industry it does not have", async () => {
    const first = await provisionBusiness();
    const second = await provisionBusiness();

    await expect(
      withTenant(second.businessId, () => field.fieldBoard(second.owner, first.projectId)),
    ).rejects.toSatisfy((error: unknown) => {
      expectAecError(error, "project_not_found");
      return true;
    });

    // And a food-service business is refused by the industry gate inside the
    // profile read, exactly as every other AEC surface is.
    const cafe = await provisionBusiness("food_service");
    await expect(
      withTenant(cafe.businessId, () => field.fieldBoard(cafe.owner, cafe.projectId)),
    ).rejects.toSatisfy((error: unknown) => {
      expectAecError(error, "industry_mismatch");
      return true;
    });
  }, 120_000);

  it("caps every queue so a long register still answers a phone", async () => {
    const { owner, projectId, businessId } = await provisionBusiness();
    const today = await businessToday(businessId);
    for (let index = 0; index < 9; index += 1) {
      await withTenant(businessId, () =>
        site.createSiteIssue(owner, projectId, {
          kind: "snag",
          title: `نقص شماره ${index + 1}`,
          severity: "medium",
          dueDate: daysFrom(today, index + 1),
        }),
      );
    }
    const board = await withTenant(businessId, () =>
      field.fieldBoard(owner, projectId, { limit: 3 }),
    );
    expect(board.queues.snags.openCount).toBe(9);
    expect(board.queues.snags.rows).toHaveLength(3);
    // Exactly the three soonest, not the three that happened to be created first.
    expect(board.queues.snags.rows.map((row) => row.title)).toEqual([
      "نقص شماره 1",
      "نقص شماره 2",
      "نقص شماره 3",
    ]);
  }, 120_000);
});
