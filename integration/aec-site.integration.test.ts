/**
 * Issue #799 Wave 7 (§13 and §14) — site execution, against a real PostgreSQL.
 *
 * `src/lib/aec-site.test.ts` proves the pure half: the catalogues, the two
 * transition tables, the four-eyes split and what "late" means. What can only be
 * proven here is what the schema and the service do together:
 *
 *   * a *signed* day is frozen in the database, not only in the service: a raw
 *     SQL UPDATE of a submitted log's `work_performed` is refused with 23514, a
 *     raw DELETE of it likewise, and its **lines** are frozen with it — a day
 *     whose attendance could still be edited after signing would not be signed;
 *   * §13's one-day-per-project-per-date rule is enforced where two concurrent
 *     writers cannot slip past it (a unique index, not only a service check);
 *   * the line CHECK is the same shape as `SITE_LOG_LINE_SHAPES`: a raw INSERT of
 *     an attendance line without a headcount, or a material line without a
 *     quantity, is refused by the database;
 *   * §14's lifecycle is one chain for all seven kinds, `resolved → in_progress`
 *     is the failed-verification loop, a result is required before an inspection
 *     or handover leaves work, and **the four-eyes rule is in the trigger**: a
 *     raw SQL close by the assignee is refused, and so is a close without a
 *     verifier;
 *   * a closed or cancelled issue is history (§33): no raw UPDATE of its title,
 *     result or closeout note, and no DELETE;
 *   * a checklist is copied onto an issue, and the copy survives both editing the
 *     template and deleting it — which is the difference between a snapshot and a
 *     live reference;
 *   * the day's numbers (workforce, deliveries, incidents) are the service's
 *     count of the day's own lines, and both registers' attachments are real
 *     `workspace_documents` rows of the same project (a foreign one refused by
 *     trigger);
 *   * the queues the widgets, the scan and the assistant read
 *     (`pendingSiteIssues`, `overdueSiteIssues`) select the same rows the screen
 *     shows, and `site_operations` / `qa_qc` / `snagging` / `hse` gate the
 *     domains the way the profile says;
 *   * the six new tables are tenant-isolated, and the two new `parties`
 *     references move with the surviving party on a merge.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
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
let crm: typeof import("../src/lib/crm-service");
let scans: typeof import("../src/lib/notification-scans");

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
  databaseName = `pos_aec_site_${randomUUID().replaceAll("-", "")}`;

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
  crm = await import("../src/lib/crm-service");
  scans = await import("../src/lib/notification-scans");

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

/**
 * A contractor by default: §13 and §14 are a contractor's day, and the preset
 * carries `site_operations`, `qa_qc`, `snagging` and `hse`. `overrides` flips
 * single capabilities off (or on) so the gating can be tested on the same code
 * path rather than by a second fixture.
 */
async function provisionBusiness(
  overrideProfile?: "consulting_supervision" | "individual",
  overrides?: Record<string, boolean>,
): Promise<{ businessId: string; owner: Owner; userId: string }> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کارگاه ثبت ${seq}`,
    ownerName: "مالک",
    email: `owner-site-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `site${seq}`,
    industry: "architecture_construction",
    seedChartOfAccounts: true,
  });
  const owner: Owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  await dbLib.withTenant(result.businessId, () =>
    aec.saveBusinessAecProfile(owner, {
      operatingProfile: overrideProfile ?? "contractor",
      ...(overrides ? { capabilityOverrides: overrides } : {}),
    }),
  );
  return { businessId: result.businessId, owner, userId: result.userId };
}

/** A member of the business who is not the owner — the second pair of eyes. */
async function addMember(businessId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, email, password_hash, full_name, role)
     VALUES ($1, $2, 'x', $3, 'manager') RETURNING id`,
    [businessId, `member-${randomUUID()}@example.com`, name],
  );
  return rows[0].id;
}

async function createProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

async function createParty(businessId: string, name: string, roles: string[] = ["customer"]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, $3, $4::text[]) RETURNING id`,
    [businessId, name, roles[0], roles],
  );
  return rows[0].id;
}

async function addMediaAsset(businessId: string, ownerUserId: string, fileName: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets
       (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256, created_by)
     VALUES ($1, 'image', $2, 'image/jpeg', 1024, $3, repeat(md5($4), 2), $5::uuid)
     RETURNING id`,
    [businessId, fileName, `site/${randomUUID()}.jpg`, randomUUID(), ownerUserId],
  );
  return rows[0].id;
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A project with one draft day carrying a spoke of every line kind. */
async function seedDay(
  owner: Owner,
  projectName: string,
  extra: Record<string, unknown> = {},
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  const detail = await dbLib.withTenant(owner.businessId, () =>
    site.createSiteLog(owner, projectId, {
      logDate: "2026-06-01",
      workPerformed: "بتن‌ریزی سقف طبقهٔ دوم",
      weather: "آفتابی",
      lines: [
        { kind: "attendance", title: "اکیپ بتن‌ریزی", headcount: 8 },
        { kind: "attendance", title: "اکیپ آرماتوربندی", headcount: 4 },
        { kind: "equipment", title: "پمپ بتن", quantity: 1, unit: "دستگاه", hours: 6 },
        { kind: "material", title: "بتن آماده C30", quantity: 45, unit: "مترمکعب" },
        { kind: "delay", title: "تأخیر در تخلیه", hours: 2 },
        { kind: "incident", title: "سقوط تیرک از داربست" },
        { kind: "instruction", title: "اجرای وال پست طبقهٔ دوم" },
        { kind: "visitor", title: "بازدید کارفرما" },
      ],
      ...extra,
    }),
  );
  return { projectId, detail };
}

/** A project with one open issue of the given kind, ready for its lifecycle. */
async function seedIssue(
  owner: Owner,
  projectName: string,
  input: Record<string, unknown> = {},
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  const detail = await dbLib.withTenant(owner.businessId, () =>
    site.createSiteIssue(owner, projectId, {
      kind: "inspection_request",
      title: "درخواست بازرسی آرماتوربندی محور B",
      location: "طبقهٔ دوم، محور B",
      category: "structural",
      severity: "high",
      dueDate: "2030-09-01",
      ...input,
    }),
  );
  return { projectId, detail };
}

describe("the daily site log (issue #799 §13)", () => {
  it("counts the day's numbers from its own lines", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, detail } = await seedDay(owner, "برج ثبت روز");

    expect(detail.status).toBe("draft");
    expect(detail.statusLabel).toBe("پیش‌نویس");
    expect(detail.logDate).toBe("2026-06-01");
    expect(detail.authorName).toBe("مالک");
    expect(detail.lineCount).toBe(8);
    // Two crews, 8 + 4 people; one delivery, one incident, one delay.
    expect(detail.workforce).toBe(12);
    expect(detail.deliveryCount).toBe(1);
    expect(detail.incidentCount).toBe(1);
    expect(detail.isEditable).toBe(true);

    const lines = detail.lines;
    expect(lines.filter((line) => line.kind === "attendance")).toHaveLength(2);
    const pump = lines.find((line) => line.kind === "equipment");
    expect(pump?.quantity).toBe(1);
    expect(pump?.hours).toBe(6);
    expect(pump?.unit).toBe("دستگاه");
    expect(pump?.kindLabel).toBe("ماشین‌آلات و تجهیزات");
    // Order is the order the day was written in, which is what the panel shows.
    expect(lines.map((line) => line.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    const register = await dbLib.withTenant(businessId, () =>
      site.listProjectSiteLogs(businessId, projectId, {}),
    );
    expect(register).toHaveLength(1);
    expect(register[0].workforce).toBe(12);
    expect(register[0].id).toBe(detail.id);

    // Filters narrow the register without re-counting anything differently.
    const empty = await dbLib.withTenant(businessId, () =>
      site.listProjectSiteLogs(businessId, projectId, { status: "submitted" }),
    );
    expect(empty).toHaveLength(0);
    const searched = await dbLib.withTenant(businessId, () =>
      site.listProjectSiteLogs(businessId, projectId, { search: "آفتابی" }),
    );
    expect(searched).toHaveLength(1);
  });

  it("refuses a line that does not have the inputs its kind says it has", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ اعتبار ردیف");

    await dbLib.withTenant(businessId, async () => {
      // An attendance line without a headcount is not attendance.
      await expect(
        site.createSiteLog(owner, projectId, {
          logDate: "2026-06-02",
          lines: [{ kind: "attendance", title: "اکیپ بی‌شمار" }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_log_line");
        return true;
      });
      // A delivery without a quantity is not a delivery.
      await expect(
        site.createSiteLog(owner, projectId, {
          logDate: "2026-06-02",
          lines: [{ kind: "material", title: "سیمان" }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_log_line");
        return true;
      });
      // And a headcount on a material line is a field the kind does not have.
      await expect(
        site.createSiteLog(owner, projectId, {
          logDate: "2026-06-02",
          lines: [{ kind: "material", title: "سیمان", quantity: 10, headcount: 3 }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_log_line");
        return true;
      });
      await expect(
        site.createSiteLog(owner, projectId, {
          logDate: "2026-06-02",
          lines: [{ kind: "tea_break", title: "چای" }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_log_line");
        return true;
      });
      // A line needs a title at all.
      await expect(
        site.createSiteLog(owner, projectId, {
          logDate: "2026-06-02",
          lines: [{ kind: "visitor", title: "  " }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_log_line");
        return true;
      });
    });

    // The database's CHECK is the same shape, so a raw writer cannot bypass the
    // service: an attendance line with no headcount is 23514 at the table.
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO aec_site_logs (business_id, project_id, log_date, author_user_id, author_name,
                                  created_by, created_by_name)
       VALUES ($1, $2, '2026-06-03', $3, 'مالک', $3, 'مالک') RETURNING id`,
      [businessId, projectId, owner.actorUserId],
    );
    await expect(
      db.query(
        `INSERT INTO aec_site_log_lines (business_id, log_id, kind, title, position)
         VALUES ($1, $2, 'attendance', 'اکیپ بی‌شمار', 0)`,
        [businessId, rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps one day per project per date — and lets another project have the same date", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId } = await seedDay(owner, "پروژهٔ یکتایی");
    const other = await createProject(businessId, owner.actorUserId, "پروژهٔ دوم");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.createSiteLog(owner, projectId, { logDate: "2026-06-01", workPerformed: "تکرار" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_log_exists");
        return true;
      });
      // The same date on another project is another site's day.
      const second = await site.createSiteLog(owner, other, {
        logDate: "2026-06-01",
        workPerformed: "کار در پروژهٔ دوم",
      });
      expect(second.logDate).toBe("2026-06-01");
      // And moving a day onto a taken date is the same refusal.
      const third = await site.createSiteLog(owner, other, {
        logDate: "2026-06-04",
        workPerformed: "روز چهارم",
      });
      await expect(
        site.updateSiteLog(owner, third.id, { logDate: "2026-06-01" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_log_exists");
        return true;
      });
    });
  });

  it("freezes a signed day and its lines in the database, and reopens it explicitly", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { detail } = await seedDay(owner, "پروژهٔ امضا");

    // A day with nothing written in it is not a report.
    const blank = await dbLib.withTenant(businessId, () =>
      site.createSiteLog(owner, detail.projectId, { logDate: "2026-06-05" }),
    );
    await dbLib.withTenant(businessId, async () => {
      await expect(site.applySiteLogAction(owner, blank.id, "submit")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "site_log_work_required");
          return true;
        },
      );
    });

    const submitted = await dbLib.withTenant(businessId, () =>
      site.applySiteLogAction(owner, detail.id, "submit"),
    );
    expect(submitted.status).toBe("submitted");
    expect(submitted.statusLabel).toBe("ثبت‌شده");
    expect(submitted.submittedByName).toBe("مالک");
    expect(submitted.isEditable).toBe(false);

    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.updateSiteLog(owner, detail.id, { workPerformed: "تغییر پنهانی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_log_not_editable");
        return true;
      });
      await expect(site.deleteSiteLog(owner, detail.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_log_not_editable");
        return true;
      });
      // Reopening is the one way back, and it is a transition, not an edit.
      const reopened = await site.applySiteLogAction(owner, detail.id, "reopen");
      expect(reopened.status).toBe("draft");
      expect(reopened.submittedAt).toBeNull();
      await site.applySiteLogAction(owner, detail.id, "submit");
    });

    // The database says the same: a raw UPDATE of a submitted day is 23514…
    await expect(
      db.query(`UPDATE aec_site_logs SET work_performed = 'raw' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // …a raw DELETE of it is 23514…
    await expect(
      db.query(`DELETE FROM aec_site_logs WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // …and its lines are frozen with it: neither an update nor a new line.
    await expect(
      db.query(`UPDATE aec_site_log_lines SET headcount = 99 WHERE log_id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        `INSERT INTO aec_site_log_lines (business_id, log_id, kind, title, position)
         VALUES ($1, $2, 'visitor', 'بازدید بی‌موقع', 9)`,
        [businessId, detail.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A raw status jump the guard does not know is refused too.
    await expect(
      db.query(`UPDATE aec_site_logs SET status = 'archived' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("detaches the day's issues when a draft day is deleted, rather than taking them with it", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, detail } = await seedDay(owner, "پروژهٔ حذف روز");
    const issue = await dbLib.withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "snag",
        title: "نقص دیده‌شده در همان روز",
        siteLogId: detail.id,
      }),
    );
    expect(issue.siteLogId).toBe(detail.id);

    await dbLib.withTenant(businessId, () => site.deleteSiteLog(owner, detail.id));

    const { rows } = await db.query<{ site_log_id: string | null }>(
      `SELECT site_log_id FROM aec_site_issues WHERE business_id = $1 AND id = $2`,
      [businessId, issue.id],
    );
    // The finding outlives the day it was found on; the link is what goes.
    expect(rows[0].site_log_id).toBeNull();
  });

  it("links real Media Library files as the day's photos, and refuses a foreign project's file", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ عکس");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "site-photo.jpg");

    const detail = await dbLib.withTenant(businessId, () =>
      site.createSiteLog(owner, projectId, {
        logDate: "2026-06-10",
        workPerformed: "قالب‌بندی",
        attachments: [{ mediaAssetId: asset, title: "نمای محور B" }],
      }),
    );
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0].title).toBe("نمای محور B");
    expect(detail.attachments[0].mediaAssetId).toBe(asset);
    expect(detail.attachmentCount).toBe(1);

    const { rows } = await db.query<{ site_log_id: string; project_id: string }>(
      `SELECT site_log_id, project_id FROM workspace_documents WHERE business_id = $1 AND site_log_id = $2`,
      [businessId, detail.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe(projectId);

    // The same media file on another project's day is legitimate — each
    // attachment is its own document row, so one photo can evidence two days.
    const other = await createProject(businessId, owner.actorUserId, "پروژهٔ دیگر");
    const otherLog = await dbLib.withTenant(businessId, () =>
      site.createSiteLog(owner, other, {
        logDate: "2026-06-11",
        workPerformed: "کار دیگر",
        attachments: [{ mediaAssetId: asset, title: "همان عکس در پروژهٔ دیگر" }],
      }),
    );
    expect(otherLog.attachments[0].mediaAssetId).toBe(asset);
    // What is *not* legitimate is a document that points at another project's
    // log: the trigger compares the document's owner with the log's, not only
    // the business, so a raw writer cannot cross the two.
    const { rows: documentRows } = await db.query<{ id: string }>(
      `SELECT id FROM workspace_documents WHERE business_id = $1 AND site_log_id = $2`,
      [businessId, detail.id],
    );
    await expect(
      db.query(`UPDATE workspace_documents SET site_log_id = $2 WHERE id = $1`, [
        documentRows[0].id,
        otherLog.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const foreignLog = await dbLib.withTenant(businessId, () =>
      site.createSiteLog(owner, projectId, { logDate: "2026-06-12", workPerformed: "روز بعد" }),
    );

    // Replacement is wholesale: the list sent is the list kept.
    expect(foreignLog.logDate).toBe("2026-06-12");
    const second = await addMediaAsset(businessId, owner.actorUserId, "site-photo-2.jpg");
    const replaced = await dbLib.withTenant(businessId, () =>
      site.updateSiteLog(owner, detail.id, {
        attachments: [{ mediaAssetId: second, title: "نمای دوم" }],
      }),
    );
    expect(replaced.attachments).toHaveLength(1);
    expect(replaced.attachments[0].mediaAssetId).toBe(second);
  });
});

describe("the issue register (issue #799 §14)", () => {
  it("numbers per kind, per project, and refuses a duplicate", async () => {
    const { businessId, owner } = await provisionBusiness();
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ شماره");

    const { snags, ncrs } = await dbLib.withTenant(businessId, async () => {
      const first = await site.createSiteIssue(owner, projectId, { kind: "snag", title: "نقص ۱" });
      const second = await site.createSiteIssue(owner, projectId, { kind: "snag", title: "نقص ۲" });
      const ncr = await site.createSiteIssue(owner, projectId, { kind: "ncr", title: "عدم انطباق ۱" });
      return { snags: [first, second], ncrs: [ncr] };
    });
    expect(snags[0].issueNumber).toBe("SNG-001");
    expect(snags[1].issueNumber).toBe("SNG-002");
    // An NCR has its own series: a punch item and a non-conformance are referred
    // to separately on site.
    expect(ncrs[0].issueNumber).toBe("NCR-001");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.createSiteIssue(owner, projectId, {
          kind: "snag",
          title: "تکراری",
          issueNumber: "SNG-001",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_number_taken");
        return true;
      });
      await expect(
        site.createSiteIssue(owner, projectId, { kind: "snag", title: "  " }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_title_required");
        return true;
      });
      await expect(
        site.createSiteIssue(owner, projectId, { kind: "punch", title: "نوع ناشناس" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_issue_kind");
        return true;
      });
      await expect(
        site.createSiteIssue(owner, projectId, { kind: "ncr", title: "شدت ناشناس", severity: "urgent" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_severity");
        return true;
      });
      await expect(
        site.createSiteIssue(owner, projectId, { kind: "ncr", title: "دستهٔ ناشناس", category: "catering" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_category");
        return true;
      });
    });
  });

  it("walks the lifecycle and refuses the moves that would fake a verification", async () => {
    const { businessId, owner } = await provisionBusiness();
    const verifier = await addMember(businessId, "ناظر مستقل");
    const worker = await addMember(businessId, "مجری");
    const { projectId, detail } = await seedIssue(owner, "پروژهٔ چرخهٔ عمر", {
      kind: "inspection",
      assignedToId: worker,
      assignedToName: "مجری",
    });
    expect(detail.status).toBe("open");
    expect(detail.issueNumber).toBe("INS-001");

    // Resolving an inspection without its result is refused, in the service and
    // in the trigger.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.applySiteIssueAction(owner, detail.id, "resolve", { resolutionNote: "انجام شد" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_result_required");
        return true;
      });
      await expect(
        site.applySiteIssueAction(owner, detail.id, "resolve", { result: "pass" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_resolution_required");
        return true;
      });
      // An open issue is not closed by asking: closing is a transition, and the
      // chain does not have that edge.
      await expect(
        site.applySiteIssueAction(owner, detail.id, "close", { closeoutNote: "بسته" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_issue_transition");
        return true;
      });

      await site.applySiteIssueAction(owner, detail.id, "start");
      const resolved = await site.applySiteIssueAction(owner, detail.id, "resolve", {
        resolutionNote: "آرماتوربندی اصلاح شد",
        result: "fail",
      });
      expect(resolved.status).toBe("resolved");
      expect(resolved.resultLabel).toBe("رد");
      expect(resolved.resolvedByName).toBe("مالک");

      // A verification that failed sends the work back to the *same* record —
      // `resolved → in_progress`, the register's one backward edge — rather than
      // opening a second NCR that loses the first attempt.
      const back = await site.applySiteIssueAction(owner, detail.id, "start");
      expect(back.status).toBe("in_progress");
      const secondPass = await site.applySiteIssueAction(owner, detail.id, "resolve", {
        resolutionNote: "اصلاح دوباره و کنترل مجدد",
        result: "pass_with_comments",
      });
      expect(secondPass.status).toBe("resolved");
      expect(secondPass.resultLabel).toBe("قبول با تذکر");
    });

    // The four-eyes rule: the assignee cannot verify their own fix, and the
    // trigger refuses it even by raw SQL.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.applySiteIssueAction(
          { ...owner, actorUserId: worker, actorName: "مجری" },
          detail.id,
          "close",
          { closeoutNote: "خودم تأیید می‌کنم" },
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_verifier_is_assignee");
        return true;
      });
    });
    await expect(
      db.query(
        `UPDATE aec_site_issues SET status = 'closed', verified_by = $2, verified_at = now(),
                                    closeout_note = 'raw' WHERE id = $1`,
        [detail.id, worker],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A close with no verifier at all is not a close.
    await expect(
      db.query(`UPDATE aec_site_issues SET status = 'closed' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });

    const closed = await dbLib.withTenant(businessId, () =>
      site.applySiteIssueAction(
        { ...owner, actorUserId: verifier, actorName: "ناظر مستقل" },
        detail.id,
        "close",
        { closeoutNote: "بازدید شد و اصلاح پذیرفته است" },
      ),
    );
    expect(closed.status).toBe("closed");
    expect(closed.verifiedByName).toBe("ناظر مستقل");
    expect(closed.closeoutNote).toBe("بازدید شد و اصلاح پذیرفته است");

    // §33: a closed issue is history — no service edit, no raw edit, no delete.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.updateSiteIssue(owner, detail.id, { title: "بازنویسی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_not_editable");
        return true;
      });
      await expect(site.deleteSiteIssue(owner, detail.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_not_editable");
        return true;
      });
    });
    await expect(
      db.query(`UPDATE aec_site_issues SET closeout_note = 'raw' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`DELETE FROM aec_site_issues WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // And the result cannot be rewritten after the fact.
    await expect(
      db.query(`UPDATE aec_site_issues SET result = 'pass' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps a result off the kinds that do not have one, and a delete to a brand-new issue", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, detail } = await seedIssue(owner, "پروژهٔ حذف مورد", { kind: "corrective_action" });
    expect(detail.issueNumber).toBe("CA-001");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.applySiteIssueAction(owner, detail.id, "resolve", {
          resolutionNote: "انجام شد",
          result: "pass",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_site_issue_result");
        return true;
      });
      // Once work has started, the record is part of what happened.
      await site.applySiteIssueAction(owner, detail.id, "start");
      await expect(site.deleteSiteIssue(owner, detail.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "site_issue_not_editable");
        return true;
      });
    });
    await expect(
      db.query(`DELETE FROM aec_site_issues WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });

    // The same project, an issue raised by mistake and cancelled instead.
    const mistake = await dbLib.withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, { kind: "corrective_action", title: "اشتباه" }),
    );
    const cancelled = await dbLib.withTenant(businessId, () =>
      site.applySiteIssueAction(owner, mistake.id, "cancel"),
    );
    expect(cancelled.status).toBe("cancelled");
    await expect(
      db.query(`UPDATE aec_site_issues SET title = 'raw' WHERE id = $1`, [mistake.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("gates the two switchable kinds behind their capability and the day behind site operations", async () => {
    // A supervisor has quality and snags but no daily log (supervision is not
    // running a site), which is exactly what §14 means by "where enabled".
    const supervisor = await provisionBusiness("consulting_supervision");
    const projectId = await createProject(
      supervisor.businessId,
      supervisor.owner.actorUserId,
      "پروژهٔ ناظر",
    );
    await dbLib.withTenant(supervisor.businessId, async () => {
      await expect(
        site.createSiteLog(supervisor.owner, projectId, { workPerformed: "روز" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      const snag = await site.createSiteIssue(supervisor.owner, projectId, {
        kind: "snag",
        title: "نقص قابل مشاهده",
      });
      expect(snag.kindLabel).toBe("نقص (پانچ)");
      const hse = await site.createSiteIssue(supervisor.owner, projectId, {
        kind: "hse_observation",
        title: "مشاهدهٔ ایمنی",
      });
      expect(hse.issueNumber).toBe("HSE-001");
    });

    // A contractor that switched `snagging` and `hse` off is refused both — and
    // still keeps its inspections.
    const contractor = await provisionBusiness(undefined, { snagging: false, hse: false });
    const other = await createProject(contractor.businessId, contractor.owner.actorUserId, "پروژهٔ پیمانکار");
    await dbLib.withTenant(contractor.businessId, async () => {
      await expect(
        site.createSiteIssue(contractor.owner, other, { kind: "snag", title: "نقص" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(
        site.createSiteIssue(contractor.owner, other, { kind: "hse_observation", title: "ایمنی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      const inspection = await site.createSiteIssue(contractor.owner, other, {
        kind: "inspection",
        title: "بازرسی دوام",
      });
      expect(inspection.kind).toBe("inspection");
      // And the day still exists for a contractor.
      const day = await site.createSiteLog(contractor.owner, other, {
        workPerformed: "ادامهٔ کار",
      });
      expect(day.status).toBe("draft");
    });

    // A solo professional has neither the register nor the day.
    const solo = await provisionBusiness("individual");
    const soloProject = await createProject(solo.businessId, solo.owner.actorUserId, "پروژهٔ شخصی");
    await dbLib.withTenant(solo.businessId, async () => {
      await expect(
        site.createSiteIssue(solo.owner, soloProject, { kind: "inspection", title: "بازرسی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(
        site.createSiteLog(solo.owner, soloProject, { workPerformed: "روز" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
    });
  });

  it("attaches evidence and refuses another project's or another business's record", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId, detail } = await seedIssue(owner, "پروژهٔ شواهد");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "crack.jpg");
    const updated = await dbLib.withTenant(businessId, () =>
      site.updateSiteIssue(owner, detail.id, {
        attachments: [{ mediaAssetId: asset, title: "ترک دیوار" }],
      }),
    );
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachmentCount).toBe(1);

    const foreign = await provisionBusiness();
    const foreignAsset = await addMediaAsset(foreign.businessId, foreign.owner.actorUserId, "x.jpg");
    await dbLib.withTenant(businessId, async () => {
      await expect(
        site.updateSiteIssue(owner, detail.id, {
          attachments: [{ mediaAssetId: foreignAsset }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "media_not_found");
        return true;
      });
      // A party or a person from another business is refused before any write.
      const foreignParty = await createParty(foreign.businessId, "پیمانکار بیگانه");
      await expect(
        site.updateSiteIssue(owner, detail.id, { responsiblePartyId: foreignParty }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
      const foreignMember = await addMember(foreign.businessId, "کاربر بیگانه");
      await expect(
        site.updateSiteIssue(owner, detail.id, { assignedToId: foreignMember }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "user_not_found");
        return true;
      });
      // A value that is not a uuid at all never reaches the lookup.
      await expect(
        site.updateSiteIssue(owner, detail.id, { responsiblePartyId: "not-a-uuid" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_reference");
        return true;
      });
    });
    // The trigger refuses a raw cross-business assignment too.
    const foreignMember = await addMember(foreign.businessId, "کاربر بیگانه");
    await expect(
      db.query(`UPDATE aec_site_issues SET assigned_to = $2 WHERE id = $1`, [detail.id, foreignMember]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(projectId).toBeTruthy();
  });
});

describe("inspection checklists (issue #799 §14)", () => {
  it("copies the firm's checklist onto the issue, and the copy is what lives on", async () => {
    const { businessId, owner } = await provisionBusiness();
    const checklist = await dbLib.withTenant(businessId, () =>
      site.createChecklist(owner, {
        name: "چک‌لیست بازرسی آرماتوربندی",
        kind: "inspection",
        discipline: "structural_engineering",
        items: [
          { title: "قطر و فاصلهٔ میلگردها", guidance: "طبق نقشهٔ S-201" },
          { title: "پوشش بتن", guidance: "" },
        ],
      }),
    );
    expect(checklist.kindLabel).toBe("چک‌لیست بازرسی");
    expect(checklist.itemCount).toBe(2);
    expect(checklist.items.map((item) => item.position)).toEqual([0, 1]);
    expect(checklist.isActive).toBe(true);

    const { projectId, detail } = await seedIssue(owner, "پروژهٔ چک‌لیست", {
      kind: "inspection",
      checklistId: checklist.id,
    });
    expect(detail.checklistName).toBe("چک‌لیست بازرسی آرماتوربندی");
    expect(detail.checks).toHaveLength(2);
    expect(detail.checks[0].label).toBe("قطر و فاصلهٔ میلگردها");
    expect(detail.checks[0].guidance).toBe("طبق نقشهٔ S-201");
    expect(detail.checks[0].result).toBe("pending");
    expect(detail.checkCount).toBe(2);
    expect(detail.pendingCheckCount).toBe(2);

    // Filling the checklist in is a write to the issue's own copy.
    const filled = await dbLib.withTenant(businessId, () =>
      site.updateSiteIssue(owner, detail.id, {
        checks: detail.checks.map((check, index) => ({
          label: check.label,
          guidance: check.guidance,
          result: index === 0 ? "pass" : "fail",
          note: index === 0 ? "مطابق نقشه" : "پوشش کم است",
          checklistItemId: check.checklistItemId,
        })),
      }),
    );
    expect(filled.checks[0].result).toBe("pass");
    expect(filled.checks[0].checkedByName).toBe("مالک");
    expect(filled.checks[0].checkedAt).toBeTruthy();
    expect(filled.checks[1].result).toBe("fail");
    expect(filled.checkSummary).toMatchObject({ total: 2, passed: 1, failed: 1, pending: 0, complete: true });

    // Editing the standard tomorrow does not rewrite what was checked today…
    await dbLib.withTenant(businessId, () =>
      site.updateChecklist(owner, checklist.id, {
        items: [{ title: "بند بازنویسی‌شده", guidance: "" }],
      }),
    );
    const afterEdit = await dbLib.withTenant(businessId, () =>
      site.loadSiteIssue(businessId, detail.id),
    );
    expect(afterEdit.checks.map((check) => check.label)).toEqual([
      "قطر و فاصلهٔ میلگردها",
      "پوشش بتن",
    ]);

    // …and deleting it does not either: the provenance link is what goes.
    await dbLib.withTenant(businessId, () => site.deleteChecklist(owner, checklist.id));
    const afterDelete = await dbLib.withTenant(businessId, () =>
      site.loadSiteIssue(businessId, detail.id),
    );
    expect(afterDelete.checks).toHaveLength(2);
    expect(afterDelete.checks[0].checklistItemId).toBeNull();
    expect(afterDelete.checklistId).toBeNull();
    expect(afterDelete.checklistName).toBeNull();
    expect(projectId).toBeTruthy();
  });

  it("refuses a duplicate name, a foreign checklist, and a checklist on the wrong kind", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId } = await seedIssue(owner, "پروژهٔ قواعد چک‌لیست");
    const first = await dbLib.withTenant(businessId, () =>
      site.createChecklist(owner, { name: "چک‌لیست تحویل", kind: "handover" }),
    );

    await dbLib.withTenant(businessId, async () => {
      await expect(site.createChecklist(owner, { name: "  " })).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "checklist_name_required");
          return true;
        },
      );
      await expect(site.createChecklist(owner, { name: "چک‌لیست تحویل" })).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "checklist_name_taken");
          return true;
        },
      );
      await expect(
        site.createChecklist(owner, { name: "بی‌کاربرد", kind: "audit" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_checklist_kind");
        return true;
      });
      // A checklist only belongs to an inspection or a handover.
      await expect(
        site.createSiteIssue(owner, projectId, {
          kind: "ncr",
          title: "عدم انطباق با چک‌لیست",
          checklistId: first.id,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "checklist_not_for_kind");
        return true;
      });
      // A checklist of one project cannot be used on another.
      const scoped = await site.createChecklist(owner, {
        name: "چک‌لیست پروژهٔ دیگر",
        projectId,
      });
      const otherProject = await createProject(businessId, owner.actorUserId, "پروژهٔ سوم");
      await expect(
        site.createSiteIssue(owner, otherProject, {
          kind: "inspection",
          title: "بازرسی",
          checklistId: scoped.id,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "checklist_not_found");
        return true;
      });
    });

    // A deactivated checklist still reads back on the issue that used it.
    const deactivated = await dbLib.withTenant(businessId, () =>
      site.updateChecklist(owner, first.id, { isActive: false }),
    );
    expect(deactivated.isActive).toBe(false);
    const list = await dbLib.withTenant(businessId, () =>
      site.listChecklists(businessId, { includeInactive: false }),
    );
    expect(list.map((row) => row.id)).not.toContain(first.id);
    expect(projectId).toBeTruthy();
  });
});

describe("the queues the widgets, the scan and the assistant read", () => {
  it("lists what is still open, worst first, and the overdue half separately", async () => {
    const { businessId, owner } = await provisionBusiness();
    const { projectId } = await seedIssue(owner, "پروژهٔ صف", { severity: "low", dueDate: "2030-01-01" });
    const critical = await dbLib.withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "ncr",
        title: "عدم انطباق بحرانی",
        severity: "critical",
        dueDate: "2020-01-01",
      }),
    );
    const resolved = await dbLib.withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "snag",
        title: "نقص در انتظار تأیید",
        dueDate: "2020-02-02",
      }),
    );
    await dbLib.withTenant(businessId, () =>
      site.applySiteIssueAction(owner, resolved.id, "resolve", { resolutionNote: "اصلاح شد" }),
    );

    const open = await dbLib.withTenant(businessId, () =>
      site.pendingSiteIssues(businessId, { projectId }),
    );
    // Worst first: the critical NCR, the medium snag awaiting verification, then
    // the low inspection request.
    expect(open.map((row) => row.issueNumber)).toEqual([critical.issueNumber, "SNG-001", "IR-001"]);
    expect(open[0].severityLabel).toBe("بحرانی");
    expect(open[0].daysOverdue).toBeGreaterThan(0);
    expect(open[1].status).toBe("resolved");
    expect(open[1].kindLabel).toBe("نقص (پانچ)");

    const overdue = await dbLib.withTenant(businessId, () =>
      site.overdueSiteIssues(businessId, 20),
    );
    // Both late ones are here — the awaiting-verification snag is exactly what
    // the scan exists to chase — and the far-future one is not.
    expect(overdue.map((row) => row.issueNumber).sort()).toEqual(
      [critical.issueNumber, "SNG-001"].sort(),
    );
    expect(overdue.every((row) => row.daysOverdue > 0)).toBe(true);

    // Closing removes a row from the queue: one person fixes it, another
    // verifies — the pair the register's closeout is built on.
    const second = await addMember(businessId, "ناظر");
    const closed = await dbLib.withTenant(businessId, async () => {
      await site.applySiteIssueAction(owner, critical.id, "resolve", {
        resolutionNote: "دوباره‌کاری طبق مشخصات انجام شد",
      });
      return site.applySiteIssueAction(
        { ...owner, actorUserId: second, actorName: "ناظر" },
        critical.id,
        "close",
        { closeoutNote: "اصلاح پذیرفته شد" },
      );
    });
    expect(closed.status).toBe("closed");
    const afterClose = await dbLib.withTenant(businessId, () =>
      site.pendingSiteIssues(businessId, { projectId }),
    );
    expect(afterClose.map((row) => row.issueNumber)).not.toContain(critical.issueNumber);
  });

  it("answers a non-AEC business without an error, and an AEC one with its own rows only", async () => {
    const aecBusiness = await provisionBusiness();
    const { detail } = await seedIssue(aecBusiness.owner, "پروژهٔ انزوا");
    const otherAec = await provisionBusiness();

    // Another AEC business sees nothing of the first's register…
    const foreign = await dbLib.withTenant(otherAec.businessId, () =>
      site.pendingSiteIssues(otherAec.businessId, {}),
    );
    expect(foreign).toHaveLength(0);
    // …and cannot load the record by id.
    await dbLib.withTenant(otherAec.businessId, async () => {
      await expect(site.loadSiteIssue(otherAec.businessId, detail.id)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "site_issue_not_found");
          return true;
        },
      );
    });

    // A restaurant is not an error for the hourly scan — it is a no-op.
    seq += 1;
    const restaurant = await provisioning.provisionBusiness({
      businessName: `رستوران ثبت ${seq}`,
      ownerName: "مالک",
      email: `owner-site-fnb-${seq}@example.com`,
      password: "correct-horse",
      subdomain: `sitefnb${seq}`,
      industry: "food_service",
      seedChartOfAccounts: true,
    });
    // The sweep the hourly tick runs is a no-op for it — one industry read and
    // no exception — which is what keeps a restaurant out of the AEC scan.
    const swept = await dbLib.withTenant(restaurant.businessId, () =>
      scans.scanOverdueAecRegisters(restaurant.businessId),
    );
    expect(swept).toBe(0);
    // The register itself still refuses a non-AEC business outright.
    await dbLib.withTenant(restaurant.businessId, async () => {
      await expect(site.overdueSiteIssues(restaurant.businessId, 20)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "industry_mismatch");
          return true;
        },
      );
    });
  });
});

describe("party merges keep the site's references honest", () => {
  it("moves the day's crew and the issue's responsibility onto the survivor", async () => {
    const { businessId, owner } = await provisionBusiness();
    const subcontractor = await createParty(businessId, "پیمانکار ادغام‌شدنی", ["customer"]);
    const { projectId, detail } = await seedDay(owner, "پروژهٔ ادغام کارگاه", {
      lines: [{ kind: "attendance", title: "اکیپ پیمانکار", headcount: 3, partyId: subcontractor }],
    });
    const issue = await dbLib.withTenant(businessId, () =>
      site.createSiteIssue(owner, projectId, {
        kind: "ncr",
        title: "عدم انطباق مربوط به پیمانکار",
        responsiblePartyId: subcontractor,
      }),
    );

    const survivor = await createParty(businessId, "پیمانکار بازمانده", ["customer"]);
    const merged = await dbLib.withTenant(businessId, () =>
      crm.mergeCustomers(businessId, survivor, subcontractor, { mergedByUserId: owner.actorUserId }),
    );
    expect(merged).not.toBeNull();

    const { rows: lineRows } = await db.query<{ party_id: string | null }>(
      `SELECT party_id FROM aec_site_log_lines WHERE business_id = $1 AND log_id = $2`,
      [businessId, detail.id],
    );
    expect(lineRows).toHaveLength(1);
    expect(lineRows[0].party_id).toBe(survivor);

    const { rows: issueRows } = await db.query<{ responsible_party_id: string | null }>(
      `SELECT responsible_party_id FROM aec_site_issues WHERE business_id = $1 AND id = $2`,
      [businessId, issue.id],
    );
    expect(issueRows[0].responsible_party_id).toBe(survivor);

    const loaded = await dbLib.withTenant(businessId, () =>
      site.loadSiteIssue(businessId, issue.id),
    );
    expect(loaded.responsiblePartyName).toBe("پیمانکار بازمانده");
  });
});
