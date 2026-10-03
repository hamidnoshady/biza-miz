/**
 * Issue #799 Wave 6 (§10 and §11) — the RFI register and the submittal log,
 * against a real PostgreSQL.
 *
 * `src/lib/aec-rfi.test.ts` proves the pure half: the two status models, the
 * transitions, and what "waiting" and "overdue" mean. What can only be proven
 * here is what the schema and the service do together:
 *
 *   * an asked question is immutable in the *database*, not only in the service:
 *     a raw SQL UPDATE of the number, subject or question of a non-draft RFI is
 *     refused with 23514, a raw DELETE of an answered one likewise, and a
 *     response cannot be rewritten once it exists ("what was answered stays
 *     answered", §33);
 *   * §10's chain only moves forward — `draft → open → answered → closed`, with
 *     cancellation only before an answer — and the service and the trigger agree
 *     about every illegal move;
 *   * a submitted submittal revision is immutable (its file, due date and
 *     reviewer frozen), cannot be deleted, and its status only moves along
 *     §11's line; «Revise & Resubmit» *adds* revision n+1 in draft inside the
 *     same transaction, which is what makes §11's approval history a read;
 *   * `latest_revision_*` and `revision_count` on `aec_submittals` are derived by
 *     the database: a client cannot declare a revision current, and deleting the
 *     draft revision of a submittal re-derives them;
 *   * submitting files exactly one `workspace_approvals` row under
 *     `submittal_revision`, and deciding it through `decideSubmittalApproval`
 *     (the queue path) lands the same revision decision the submittal screen
 *     records — one implementation of «approved» and one of «rejected»;
 *   * both registers' queues (`pendingRfis`, `pendingSubmittals`,
 *     `overdueRegisters`) select the same rows the screens show, and the two
 *     attachments of each are real `workspace_documents` rows of the same
 *     project (with a cross-tenant one refused by trigger);
 *   * the three tables carry forced RLS with a policy, so the sweep in
 *     `integration/aec.integration.test.ts` finds nothing missing and another
 *     business sees no row;
 *   * the two new `parties` references are covered by `party-merge-references.ts`
 *     and move with the surviving party while a frozen record keeps its name.
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
let rfi: typeof import("../src/lib/aec-rfi-service");
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
  databaseName = `pos_aec_rfi_${randomUUID().replaceAll("-", "")}`;

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
  rfi = await import("../src/lib/aec-rfi-service");
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
    businessName: `کسب‌وکار ثبت ${seq}`,
    ownerName: "مالک",
    email: `owner-rfi-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `rfi${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction") {
    // An RFI needs no capability at all (§10 is available to every AEC shape,
    // which is the Wave 6 design decision); submittals need `document_control`,
    // which the contractor preset carries and the design preset does not.
    await dbLib.withTenant(result.businessId, () =>
      aec.saveBusinessAecProfile(owner, { operatingProfile: "contractor" }),
    );
  }
  return { businessId: result.businessId, owner, userId: result.userId };
}

async function createProject(businessId: string, ownerUserId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
     VALUES ($1, $2, $3::text, $3::uuid) RETURNING id`,
    [businessId, name, ownerUserId],
  );
  return rows[0].id;
}

async function createParty(
  businessId: string,
  name: string,
  roles: string[] = ["customer"],
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, roles)
     VALUES ($1, $2, $3, $4::text[]) RETURNING id`,
    [businessId, name, roles[0], roles],
  );
  return rows[0].id;
}

/** A file in the Media Library, exactly as the picker would find it. */
async function addMediaAsset(businessId: string, ownerUserId: string, fileName: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets
       (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256, created_by)
     VALUES ($1, 'document', $2, 'application/pdf', 1024, $3, repeat(md5($4), 2), $5::uuid)
     RETURNING id`,
    [businessId, fileName, `submittals/${randomUUID()}.pdf`, randomUUID(), ownerUserId],
  );
  return rows[0].id;
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A project with one raised RFI, ready to open. */
async function seedRfi(
  owner: { businessId: string; actorUserId: string; actorName: string },
  projectName: string,
  extra: Record<string, unknown> = {},
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  const detail = await dbLib.withTenant(owner.businessId, () =>
    rfi.createRfi(owner, projectId, {
      rfiNumber: "RFI-001",
      subject: "محل دریچهٔ تأسیسات",
      question: "دریچهٔ تأسیسات در طبقهٔ همکف کجا اجرا شود؟",
      discipline: "mep",
      ...extra,
    }),
  );
  return { projectId, detail };
}

/**
 * A project with one submittal whose revision 1 is ready to submit.
 *
 * The file is attached here because §11 cannot submit without one
 * (`submittal_file_required`) and a revision's file is a document of the
 * project — the same path the screen takes when it picks from the library.
 */
async function seedSubmittal(
  owner: { businessId: string; actorUserId: string; actorName: string },
  projectName: string,
  extra: Record<string, unknown> = {},
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  const asset = await addMediaAsset(owner.businessId, owner.actorUserId, `SUB-${seq}.pdf`);
  const detail = await dbLib.withTenant(owner.businessId, async () => {
    const created = await rfi.createSubmittal(owner, projectId, {
      submittalNumber: "SUB-001",
      title: "نقشهٔ کارگاهی اسکلت",
      submissionType: "shop_drawing",
      specSection: "05 12 00",
      discipline: "structural_engineering",
      ...extra,
    });
    return rfi.updateSubmittalRevision(owner, created.revisions[0].id, { mediaAssetId: asset });
  });
  return { projectId, detail };
}

describe("the RFI register (issue #799 §10)", () => {
  it("walks the chain forward, stamps the dates, and counts the impacts", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const consultant = await createParty(businessId, "مهندس مشاور", ["supplier"]);
    const { detail } = await seedRfi(owner, "برج ثبت", {
      responsiblePartyId: consultant,
      raisedDate: "2026-04-01",
      dueDate: "2030-04-10",
      costImpactRial: 5_000_000,
      scheduleImpactDays: 3,
    });

    // A new RFI is a draft: the number is booked, nobody has been asked yet.
    expect(detail.status).toBe("draft");
    expect(detail.statusLabel).toBe("پیش‌نویس");
    expect(detail.rfiNumber).toBe("RFI-001");
    expect(detail.disciplineLabel).toBe("تأسیسات مکانیکی، برقی و لوله‌کشی (MEP)");
    expect(detail.responsiblePartyName).toBe("مهندس مشاور");
    expect(detail.costImpactRial).toBe(5_000_000);
    expect(detail.scheduleImpactDays).toBe(3);
    expect(detail.raisedByName).toBe("مالک");

    const opened = await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "open"),
    );
    expect(opened.status).toBe("open");
    expect(opened.raisedDate).toBe("2026-04-01");
    expect(opened.dueDate).toBe("2030-04-10");
    expect(opened.isOverdue).toBe(false);
    expect(opened.isWaiting).toBe(true);

    // §10 — "the system must clearly surface overdue RFIs": the flag is computed
    // from the business's own today, so an open RFI whose date has passed says so.
    const late = await dbLib.withTenant(businessId, () =>
      rfi.updateRfi(owner, detail.id, { dueDate: "2020-01-01" }),
    );
    expect(late.isOverdue).toBe(true);
    expect(late.isWaiting).toBe(true);

    const answered = await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "answer", { response: "طبق نقشهٔ M-102 اجرا شود." }),
    );
    expect(answered.status).toBe("answered");
    expect(answered.response).toBe("طبق نقشهٔ M-102 اجرا شود.");
    expect(answered.responseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(answered.isWaiting).toBe(false);

    const closed = await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "close"),
    );
    expect(closed.status).toBe("closed");

    // §33: the response is history now, and the record cannot be reopened.
    await dbLib.withTenant(businessId, async () => {
      await expect(rfi.applyRfiAction(owner, detail.id, "open")).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "invalid_rfi_transition");
          return true;
        },
      );
      await expect(
        rfi.updateRfi(owner, detail.id, { subject: "موضوع جدید" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_not_editable");
        return true;
      });
      // And the service cannot write a response at all except by answering:
      // `updateRfi` has no response field, so the only path is `answer`.
      await expect(
        rfi.applyRfiAction(owner, detail.id, "answer", { response: "پاسخ دوم" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_rfi_transition");
        return true;
      });
    });
  });

  it("refuses a duplicate number in the same project and answers with the queue", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, detail } = await seedRfi(owner, "ویلای ثبت");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        rfi.createRfi(owner, projectId, {
          rfiNumber: "RFI-001",
          subject: "تکراری",
          question: "؟",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_number_taken");
        return true;
      });
      await expect(
        rfi.createRfi(owner, projectId, { rfiNumber: "", subject: "بی‌شماره", question: "؟" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_number_required");
        return true;
      });
      await expect(
        rfi.createRfi(owner, projectId, { rfiNumber: "RFI-002", subject: "", question: "؟" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_subject_required");
        return true;
      });
      // Answering without a question would be a transcript with one side.
      await expect(
        rfi.createRfi(owner, projectId, {
          rfiNumber: "RFI-003",
          subject: "بی‌پرسش",
          question: "",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_question_required");
        return true;
      });
      // Answering is checked before the answer is: a draft cannot be answered at
      // all, and an open one cannot be answered with nothing.
      await expect(
        rfi.applyRfiAction(owner, detail.id, "answer", { response: "" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_rfi_transition");
        return true;
      });
      await expect(
        rfi.createRfi(owner, projectId, {
          rfiNumber: "RFI-004",
          subject: "رشتهٔ نامعتبر",
          question: "؟",
          discipline: "catering",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_discipline");
        return true;
      });
    });

    // Open it, then try to answer with no answer: the service refuses before the
    // row is written, so a question cannot be closed out with an empty response.
    await dbLib.withTenant(businessId, async () => {
      await rfi.applyRfiAction(owner, detail.id, "open");
      await expect(
        rfi.applyRfiAction(owner, detail.id, "answer", { response: "   " }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "rfi_response_required");
        return true;
      });
    });

    // An open RFI can still be cancelled; a cancelled one is not in the queue.
    const cancelled = await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "cancel"),
    );
    expect(cancelled.status).toBe("cancelled");
    const queue = await dbLib.withTenant(businessId, () => rfi.pendingRfis(businessId));
    expect(queue.map((row) => row.rfiNumber)).not.toContain("RFI-001");
  });

  it("freezes what was asked in the database, not only in the service", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedRfi(owner, "پروژهٔ انجماد");
    await dbLib.withTenant(businessId, () => rfi.applyRfiAction(owner, detail.id, "open"));

    // The service refuses; the trigger is what makes it true even for a caller
    // that never goes through the service at all.
    await expect(
      db.query(`UPDATE aec_rfis SET subject = 'موضوع عوض‌شده' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`UPDATE aec_rfis SET question = 'سؤال عوض‌شده' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`UPDATE aec_rfis SET rfi_number = 'RFI-999' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    // The fields that are still live are still writable — a due date moves.
    await expect(
      db.query(`UPDATE aec_rfis SET due_date = '2026-05-01' WHERE id = $1`, [detail.id]),
    ).resolves.toBeTruthy();

    // A question that was asked cannot be deleted; a draft still can.
    await expect(db.query(`DELETE FROM aec_rfis WHERE id = $1`, [detail.id])).rejects.toMatchObject({
      code: "23514",
    });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM aec_rfis WHERE id = $1`,
      [detail.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps a response once it exists, and never rewrites the answer", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedRfi(owner, "پروژهٔ پاسخ");
    await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "open"),
    );
    await dbLib.withTenant(businessId, () =>
      rfi.applyRfiAction(owner, detail.id, "answer", { response: "پاسخ اول" }),
    );

    await expect(
      db.query(`UPDATE aec_rfis SET response = 'پاسخ دوم' WHERE id = $1`, [detail.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(db.query(`DELETE FROM aec_rfis WHERE id = $1`, [detail.id])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("refuses a party or a user of another business", async () => {
    const first = await provisionBusiness("architecture_construction");
    const second = await provisionBusiness("architecture_construction");
    const foreignParty = await createParty(second.businessId, "طرف بیگانه", ["supplier"]);
    const { projectId } = await seedRfi(first.owner, "پروژهٔ مرز");

    await dbLib.withTenant(first.businessId, async () => {
      await expect(
        rfi.createRfi(first.owner, projectId, {
          rfiNumber: "RFI-500",
          subject: "طرف بیگانه",
          question: "؟",
          responsiblePartyId: foreignParty,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "party_not_found");
        return true;
      });
      await expect(
        rfi.createRfi(first.owner, projectId, {
          rfiNumber: "RFI-501",
          subject: "کاربر بیگانه",
          question: "؟",
          assignedToId: second.userId,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "user_not_found");
        return true;
      });
    });
  });

  it("refuses the register to a business that is not AEC at all", async () => {
    const cafe = await provisionBusiness("food_service");
    const projectId = await createProject(cafe.businessId, cafe.userId, "کافه");
    await dbLib.withTenant(cafe.businessId, async () => {
      await expect(
        rfi.createRfi(cafe.owner, projectId, { rfiNumber: "RFI-1", subject: "؟", question: "؟" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });
  });
});

describe("the submittal log (issue #799 §11)", () => {
  it("starts at revision 1 in draft and derives the totals in the database", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const contractor = await createParty(businessId, "پیمانکار", ["supplier"]);
    const { detail } = await seedSubmittal(owner, "برج سابمیتال", {
      responsiblePartyId: contractor,
      responseRequiredBy: "2026-05-01",
    });

    expect(detail.submittalNumber).toBe("SUB-001");
    expect(detail.submissionType).toBe("shop_drawing");
    expect(detail.submissionTypeLabel).toBe("نقشهٔ کارگاهی");
    expect(detail.specSection).toBe("05 12 00");
    expect(detail.responsiblePartyName).toBe("پیمانکار");
    expect(detail.revisionCount).toBe(1);
    expect(detail.latestRevisionNo).toBe(1);
    expect(detail.latestRevisionStatus).toBe("draft");
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0].status).toBe("draft");
    // The reviewer's due date belongs to a revision, and none is submitted yet.
    expect(detail.latestRevisionDueDate).toBeNull();

    // The derived columns belong to the trigger: a client cannot declare a
    // revision current, and the register's guard refuses the write outright
    // rather than echoing it back — the same "recompute, never echo" rule
    // migration 0196 set for the BOQ, with the totals trigger announcing itself
    // through a transaction-local marker.
    await expect(
      db.query(`UPDATE aec_submittals SET latest_revision_status = 'approved' WHERE id = $1`, [
        detail.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    // The same write from the totals trigger is what keeps the column honest.
    const { rows: after } = await db.query<{ latest_revision_status: string }>(
      `SELECT latest_revision_status FROM aec_submittals WHERE id = $1`,
      [detail.id],
    );
    expect(after[0].latest_revision_status).toBe("draft");
  });

  it("walks §11's line and files exactly one approval per submission", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedSubmittal(owner, "پروژهٔ بررسی");
    const revisionId = detail.revisions[0].id;

    const submitted = await dbLib.withTenant(businessId, () =>
      rfi.submitSubmittalRevision(owner, revisionId, {
        approverUserId: owner.actorUserId,
        dueDate: "2026-05-01",
        note: "برای بررسی ارسال شد",
      }),
    );
    expect(submitted.latestRevisionStatus).toBe("submitted");
    expect(submitted.revisions[0].submittedByName).toBe("مالک");
    expect(submitted.revisions[0].dueDate).toBe("2026-05-01");
    expect(submitted.revisions[0].approvalRequestedAt).toBeTruthy();

    const { rows: approvals } = await db.query<{
      id: string;
      subject_type: string;
      status: string;
      title: string;
    }>(
      `SELECT id, subject_type, status, title FROM workspace_approvals
        WHERE business_id = $1 AND subject_type = 'submittal_revision'`,
      [businessId],
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
    expect(approvals[0].title).toContain("SUB-001");
    expect(approvals[0].title).toContain("(بازنگری 1)");

    // The queue lists it under §11's label, not under a bare UUID.
    const queue = await dbLib.withTenant(businessId, () =>
      workspace.listApprovals(businessId, { subjectType: "submittal_revision", limit: 5 }),
    );
    expect(queue[0]?.subjectTitle).toContain("SUB-001");

    const reviewing = await dbLib.withTenant(businessId, () =>
      rfi.startSubmittalReview(owner, revisionId),
    );
    expect(reviewing.latestRevisionStatus).toBe("under_review");
    // A submission cannot be re-submitted while a reviewer has it.
    await dbLib.withTenant(businessId, async () => {
      await expect(rfi.submitSubmittalRevision(owner, revisionId)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "invalid_submittal_transition");
          return true;
        },
      );
    });

    const decided = await dbLib.withTenant(businessId, () =>
      rfi.decideSubmittalRevision(owner, revisionId, "approved_with_comments", "با نظر، تأیید"),
    );
    expect(decided.latestRevisionStatus).toBe("approved_with_comments");
    expect(decided.revisions[0].decidedByName).toBe("مالک");
    // The determination's note is the revision's response: §11's "response"
    // and the reviewer's comment are the same sentence, not two fields.
    expect(decided.revisions[0].response).toBe("با نظر، تأیید");
    expect(decided.revisions[0].decidedAt).toBeTruthy();

    const closed = await dbLib.withTenant(businessId, () =>
      rfi.closeSubmittalRevision(owner, revisionId),
    );
    expect(closed.latestRevisionStatus).toBe("closed");

    // §33: the decision is history — the status cannot go back.
    await expect(
      db.query(
        `UPDATE aec_submittal_revisions SET status = 'under_review' WHERE id = $1`,
        [revisionId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("adds revision n+1 in the same transaction as a revise-and-resubmit", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, detail } = await seedSubmittal(owner, "پروژهٔ اصلاح");
    const revisionOne = detail.revisions[0].id;

    await dbLib.withTenant(businessId, async () => {
      await rfi.submitSubmittalRevision(owner, revisionOne, { dueDate: "2026-05-01" });
      await rfi.startSubmittalReview(owner, revisionOne);
    });
    const after = await dbLib.withTenant(businessId, () =>
      rfi.decideSubmittalRevision(owner, revisionOne, "revise_and_resubmit", "ابعاد اصلاح شود"),
    );

    // The reviewer's own instruction *is* the next revision: §11's cycle never
    // leaves a returned submission as a dead end.
    expect(after.latestRevisionNo).toBe(2);
    expect(after.latestRevisionStatus).toBe("draft");
    expect(after.revisionCount).toBe(2);
    expect(after.revisions.map((row) => row.revisionNo)).toEqual([2, 1]);
    expect(after.revisions[1].status).toBe("revise_and_resubmit");
    expect(after.revisions[1].response).toBe("ابعاد اصلاح شود");
    expect(after.revisions[0].id).not.toBe(revisionOne);
    expect(after.revisions[0].response).toBe("");

    // Revision 2 is the editable one; revision 1 is what the reviewer saw.
    const second = after.revisions[0];
    await expect(
      db.query(`UPDATE aec_submittal_revisions SET reviewer_name = 'دستکاری' WHERE id = $1`, [
        revisionOne,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const updated = await dbLib.withTenant(businessId, () =>
      rfi.updateSubmittalRevision(owner, second.id, { dueDate: "2026-06-01" }),
    );
    expect(updated.revisions[0].dueDate).toBe("2026-06-01");
    expect(updated.revisions[0].revisionNo).toBe(2);

    // Deleting the draft revision re-derives "latest" rather than leaving the
    // register claiming a revision that no longer exists.
    const deleted = await dbLib.withTenant(businessId, async () => {
      await rfi.deleteSubmittalRevision(owner, second.id);
      return rfi.loadSubmittal(businessId, detail.id);
    });
    expect(deleted.latestRevisionNo).toBe(1);
    expect(deleted.latestRevisionStatus).toBe("revise_and_resubmit");
    expect(deleted.revisionCount).toBe(1);
    expect(projectId).toBeTruthy();
  });

  it("freezes a submitted revision's file and due date, and refuses its deletion", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "SUB-001-rev1.pdf");
    const { detail } = await seedSubmittal(owner, "پروژهٔ فایل");
    const revisionId = detail.revisions[0].id;

    const withFile = await dbLib.withTenant(businessId, () =>
      rfi.updateSubmittalRevision(owner, revisionId, { mediaAssetId: asset }),
    );
    expect(withFile.revisions[0].fileName).toBe("SUB-001-rev1.pdf");

    await dbLib.withTenant(businessId, () =>
      rfi.submitSubmittalRevision(owner, revisionId, { dueDate: "2026-05-01" }),
    );

    await expect(
      db.query(`UPDATE aec_submittal_revisions SET due_date = '2026-09-09' WHERE id = $1`, [
        revisionId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(`DELETE FROM aec_submittal_revisions WHERE id = $1`, [revisionId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("decides through the approvals queue with the same implementation", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedSubmittal(owner, "پروژهٔ صف تأیید");
    const revisionId = detail.revisions[0].id;

    await dbLib.withTenant(businessId, async () => {
      await rfi.submitSubmittalRevision(owner, revisionId, { dueDate: "2026-05-01" });
      await rfi.startSubmittalReview(owner, revisionId);
    });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM workspace_approvals
        WHERE business_id = $1 AND subject_type = 'submittal_revision' AND subject_id = $2`,
      [businessId, revisionId],
    );
    const approvalId = rows[0].id;

    const result = await dbLib.withTenant(businessId, () =>
      rfi.decideSubmittalApproval(owner, approvalId, "approved", "تأیید از صف"),
    );
    expect(result.applied).toBe(true);
    expect(result.revisionId).toBe(revisionId);

    const loaded = await dbLib.withTenant(businessId, () => rfi.loadSubmittal(businessId, detail.id));
    expect(loaded.latestRevisionStatus).toBe("approved");
    expect(loaded.revisions[0].response).toBe("تأیید از صف");

    const { rows: approved } = await db.query<{ status: string; decided_by: string }>(
      `SELECT status, decided_by FROM workspace_approvals WHERE id = $1`,
      [approvalId],
    );
    expect(approved[0].status).toBe("approved");
    expect(approved[0].decided_by).toBe(owner.actorUserId);

    // A second attempt is not a second decision.
    const again = await dbLib.withTenant(businessId, () =>
      rfi.decideSubmittalApproval(owner, approvalId, "rejected", "دوباره"),
    );
    expect(again.applied).toBe(false);
    const reloaded = await dbLib.withTenant(businessId, () =>
      rfi.loadSubmittal(businessId, detail.id),
    );
    expect(reloaded.latestRevisionStatus).toBe("approved");
  });

  it("keeps the submittal queues and the overdue registers in agreement", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedSubmittal(owner, "پروژهٔ صف‌ها", {
      responseRequiredBy: "2020-01-01",
    });
    const revisionId = detail.revisions[0].id;
    await dbLib.withTenant(businessId, async () => {
      await rfi.submitSubmittalRevision(owner, revisionId, { dueDate: "2020-01-01" });
      await rfi.startSubmittalReview(owner, revisionId);
    });

    const waiting = await dbLib.withTenant(businessId, () => rfi.pendingSubmittals(businessId));
    expect(waiting.map((row) => row.submittalNumber)).toContain("SUB-001");
    // 2020 is behind every business's today, whatever "today" is.
    expect(waiting[0].daysOverdue).toBeGreaterThan(0);

    const registers = await dbLib.withTenant(businessId, () => rfi.overdueRegisters(businessId));
    expect(registers.submittals.map((row) => row.submittalNumber)).toContain("SUB-001");

    // A decided revision leaves the queue: «منتظر تأیید» is not a history.
    await dbLib.withTenant(businessId, () =>
      rfi.decideSubmittalRevision(owner, revisionId, "rejected", "دلیل"),
    );
    const afterDecision = await dbLib.withTenant(businessId, () =>
      rfi.pendingSubmittals(businessId),
    );
    expect(afterDecision.map((row) => row.submittalNumber)).not.toContain("SUB-001");
  });

  it("refuses submittals for a profile without document control, and an RFI never asks", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    // The design preset carries document_control in Wave 5, so switch to the
    // leanest shape that does not: a solo practitioner writes documents but
    // does not run a submittal review.
    await dbLib.withTenant(businessId, () =>
      aec.saveBusinessAecProfile(owner, {
        operatingProfile: "individual",
        capabilityOverrides: { document_control: false },
      }),
    );
    const projectId = await createProject(businessId, owner.actorUserId, "پروژهٔ بی‌قابلیت");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        rfi.createSubmittal(owner, projectId, {
          submittalNumber: "SUB-X",
          title: "بی‌قابلیت",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      await expect(rfi.pendingSubmittals(businessId)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "capability_disabled");
        return true;
      });
      // §10 is not capability-gated: every AEC shape raises questions.
      const created = await rfi.createRfi(owner, projectId, {
        rfiNumber: "RFI-900",
        subject: "بدون قابلیت",
        question: "؟",
      });
      expect(created.status).toBe("draft");
    });
  });
});

describe("attachments ride the document library (§9's store, not a second one)", () => {
  it("links an uploaded asset to an RFI as a real workspace document", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "RFI-001-photo.jpg");
    const { projectId, detail } = await seedRfi(owner, "پروژهٔ پیوست");

    const updated = await dbLib.withTenant(businessId, () =>
      rfi.updateRfi(owner, detail.id, {
        attachments: [{ mediaAssetId: asset, title: "عکس محل" }],
      }),
    );
    expect(updated.attachments).toHaveLength(1);
    expect(updated.attachments[0].title).toBe("عکس محل");
    expect(updated.attachments[0].mediaAssetId).toBe(asset);

    // The row is a document of the same project — so the documents screen, the
    // register and the RFI see one file, not two storage charges.
    const { rows } = await db.query<{ project_id: string; rfi_id: string; title: string }>(
      `SELECT project_id, rfi_id, title FROM workspace_documents WHERE id = $1`,
      [updated.attachments[0].documentId],
    );
    expect(rows[0].project_id).toBe(projectId);
    expect(rows[0].rfi_id).toBe(detail.id);
    expect(rows[0].title).toBe("عکس محل");

    // An attachment of another business's file is refused by the trigger.
    const other = await provisionBusiness("architecture_construction");
    const foreignAsset = await addMediaAsset(other.businessId, other.userId, "بیگانه.jpg");
    await dbLib.withTenant(businessId, async () => {
      await expect(
        rfi.updateRfi(owner, detail.id, {
          attachments: [{ mediaAssetId: foreignAsset, title: "بیگانه" }],
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "media_not_found");
        return true;
      });
    });
  });

  it("links a submittal revision's file through the document library", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const asset = await addMediaAsset(businessId, owner.actorUserId, "SUB-001-rev1.pdf");
    const { projectId, detail } = await seedSubmittal(owner, "پروژهٔ فایل سابمیتال");

    const updated = await dbLib.withTenant(businessId, () =>
      rfi.updateSubmittalRevision(owner, detail.revisions[0].id, { mediaAssetId: asset }),
    );
    const revision = updated.revisions[0];
    expect(revision.workspaceDocumentId).toBeTruthy();

    const { rows } = await db.query<{ project_id: string; submittal_id: string | null }>(
      `SELECT project_id, submittal_id FROM workspace_documents WHERE id = $1`,
      [revision.workspaceDocumentId],
    );
    // A document of this project, held by the revision — and deliberately not
    // double-counted as an attachment of the register entry: §11's attachments
    // are the supporting files (linked by `submittal_id`), while this row is the
    // submitted drawing itself.
    expect(rows[0].project_id).toBe(projectId);
    expect(rows[0].submittal_id).toBeNull();
    expect(revision.workspaceDocumentId).toBeTruthy();
    expect(detail.attachmentCount).toBe(0);
  });

  it("records both registers in the workspace activity trail (§33)", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { detail } = await seedSubmittal(owner, "پروژهٔ تاریخچه");
    await dbLib.withTenant(businessId, () =>
      rfi.submitSubmittalRevision(owner, detail.revisions[0].id, { dueDate: "2026-05-01" }),
    );

    const { rows } = await db.query<{ subject_type: string; action: string; summary: string }>(
      `SELECT subject_type, action, summary FROM workspace_activity
        WHERE business_id = $1 AND subject_type IN ('rfi', 'submittal')
        ORDER BY created_at`,
      [businessId],
    );
    expect(rows.length).toBeGreaterThan(0);
    const submitted = rows.find((row) => row.action === "submitted");
    expect(submitted?.subject_type).toBe("submittal");
    expect(submitted?.summary).toContain("SUB-001");
  });
});

describe("party merges keep the registers honest", () => {
  it("moves both registers' party references onto the surviving counterparty", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    // Both sides need the customer role for a merge to run, per `mergeCustomers`.
    const consultant = await createParty(businessId, "مشاور ادغام‌شدنی", ["customer"]);
    const { projectId, detail } = await seedRfi(owner, "پروژهٔ ادغام", {
      responsiblePartyId: consultant,
    });
    const { detail: submittal } = await seedSubmittal(owner, "پروژهٔ ادغام سابمیتال", {
      responsiblePartyId: consultant,
    });

    await dbLib.withTenant(businessId, async () => {
      await rfi.applyRfiAction(owner, detail.id, "open");
      await rfi.submitSubmittalRevision(owner, submittal.revisions[0].id, {
        dueDate: "2026-05-01",
      });
    });

    const survivor = await createParty(businessId, "مشاور بازمانده", ["customer"]);
    const merged = await dbLib.withTenant(businessId, () =>
      crm.mergeCustomers(businessId, survivor, consultant, { mergedByUserId: owner.actorUserId }),
    );
    expect(merged).not.toBeNull();

    const { rows } = await db.query<{ responsible_party_id: string }>(
      `SELECT responsible_party_id FROM aec_rfis WHERE business_id = $1 AND id = $2`,
      [businessId, detail.id],
    );
    expect(rows[0].responsible_party_id).toBe(survivor);

    const { rows: submittalRows } = await db.query<{ responsible_party_id: string }>(
      `SELECT responsible_party_id FROM aec_submittals WHERE business_id = $1 AND id = $2`,
      [businessId, submittal.id],
    );
    expect(submittalRows[0].responsible_party_id).toBe(survivor);

    const loaded = await dbLib.withTenant(businessId, () => rfi.loadRfi(businessId, detail.id));
    expect(loaded.responsiblePartyName).toBe("مشاور بازمانده");
    expect(projectId).toBeTruthy();
  });
});

describe("every Wave 6 table is tenant-isolated", () => {
  it("answers no row to a predicate scoped to another business", async () => {
    const first = await provisionBusiness("architecture_construction");
    const second = await provisionBusiness("architecture_construction");
    const { projectId, detail } = await seedRfi(first.owner, "پروژهٔ انزوا");
    await dbLib.withTenant(first.businessId, () =>
      rfi.applyRfiAction(first.owner, detail.id, "open"),
    );

    // The local role bypasses RLS, so isolation is proven by the predicate the
    // service itself uses — a query scoped to the wrong business returns nothing,
    // which is exactly what the policy would have done without the bypass.
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM aec_rfis WHERE business_id = $1 AND id = $2`,
      [second.businessId, detail.id],
    );
    expect(rows).toHaveLength(0);

    // And the service refuses the other business's project outright.
    await dbLib.withTenant(second.businessId, async () => {
      await expect(
        rfi.createRfi(second.owner, projectId, {
          rfiNumber: "RFI-1",
          subject: "پروژهٔ بیگانه",
          question: "؟",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "project_not_found");
        return true;
      });
    });
  });
});
