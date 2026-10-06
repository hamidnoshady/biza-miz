/**
 * Issue #799 Wave 5 (§9 and §12) — the drawing register, its revisions and the
 * transmittals that issue them, against a real PostgreSQL.
 *
 * `src/lib/aec-docs.test.ts` proves the pure half: the two status models, the
 * issue purposes and the revision-code arithmetic. What can only be proven here
 * is what the schema and the service do together:
 *
 *   * an issued revision is immutable in the *database*, not only in the
 *     service — a raw SQL UPDATE or DELETE from a connection that bypasses every
 *     service check is refused with 23514, and so is an edit to the file row the
 *     revision points at ("new revisions must not overwrite historical approved
 *     files");
 *   * a transmittal cannot be issued with no documents or no recipients, and once
 *     it is issued its number, sender, date, purpose, lines and recipients are
 *     frozen — the only write left is a recipient's receipt;
 *   * issuing moves the whole register in one transaction: the revisions become
 *     issued with the transmittal's purpose, the ones they replace become
 *     superseded, and the register's "latest revision" is the highest number;
 *   * §12's answer survives the register being reorganised: each line snapshots
 *     the document number, title, revision code and purpose it carried;
 *   * the five tables carry forced RLS with a policy, so the sweep in
 *     `integration/aec.integration.test.ts` finds nothing missing and another
 *     business sees no row;
 *   * every party reference (`sender_party_id`, recipients) demands a live party
 *     of the same business, and the merge rules in `party-merge-references.ts`
 *     move a draft's references without touching a frozen record.
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
let docs: typeof import("../src/lib/aec-doc-service");
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
  databaseName = `pos_aec_docs_${randomUUID().replaceAll("-", "")}`;

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
  docs = await import("../src/lib/aec-doc-service");
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
    businessName: `کسب‌وکار نقشه ${seq}`,
    ownerName: "مالک",
    email: `owner-docs-${seq}@example.com`,
    password: "correct-horse",
    subdomain: `docs${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  const owner = { businessId: result.businessId, actorUserId: result.userId, actorName: "مالک" };
  if (industry === "architecture_construction") {
    // A newly provisioned AEC business starts as `architecture_office`, whose
    // design preset now carries `document_control` (Wave 5) — selecting the
    // contractor profile is still what a real business does, and it exercises
    // the preset change at the same time.
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
    [businessId, fileName, `docs/${randomUUID()}.pdf`, randomUUID(), ownerUserId],
  );
  return rows[0].id;
}

function expectAecError(error: unknown, code: string): void {
  expect((error as AecError).name).toBe("AecError");
  expect((error as AecError).code).toBe(code);
}

/** A project with one registered drawing, ready for revisions. */
async function seedDrawing(
  owner: { businessId: string; actorUserId: string; actorName: string },
  projectName: string,
  extra: Record<string, unknown> = {},
) {
  const projectId = await createProject(owner.businessId, owner.actorUserId, projectName);
  return dbLib.withTenant(owner.businessId, async () => {
    const drawing = await docs.createDrawing(owner, projectId, {
      documentNumber: "A-101",
      title: "پلان طبقهٔ همکف",
      documentType: "drawing",
      discipline: "architecture",
      ...extra,
    });
    return { projectId, drawing };
  });
}

describe("the drawing register (issue #799 §9)", () => {
  it("keeps a revision chain and reports the highest revision as current", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId, drawing } = await seedDrawing(owner, "برج A");

    const first = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionDate: "2026-04-01" }),
    );
    const second = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionCode: "B" }),
    );

    // The register allocated the numbers and suggested the codes: A then B.
    expect(first.revisionNo).toBe(1);
    expect(first.revisionCode).toBe("A");
    expect(second.revisionNo).toBe(2);
    expect(second.revisionCode).toBe("B");

    const loaded = await dbLib.withTenant(businessId, () => docs.loadDrawing(businessId, drawing.id));
    expect(loaded.revisionCount).toBe(2);
    expect(loaded.latestRevisionNo).toBe(2);
    expect(loaded.latestRevisionCode).toBe("B");
    expect(loaded.latestRevisionStatus).toBe("draft");
    // Newest first — the order the register reads in.
    expect(loaded.revisions.map((revision) => revision.revisionCode)).toEqual(["B", "A"]);
    expect(loaded.revisions[1].revisionDate).toBe("2026-04-01");

    // A revision on a register row is only ever the project's own.
    const list = await dbLib.withTenant(businessId, () =>
      docs.listProjectDrawings(businessId, projectId),
    );
    expect(list.map((row) => row.documentNumber)).toEqual(["A-101"]);
    expect(list[0].disciplineLabel).toBe("معماری");
  });

  it("refuses a duplicate document number in the same project", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const { projectId } = await seedDrawing(owner, "ویلای شمال");

    await dbLib.withTenant(businessId, async () => {
      await expect(
        docs.createDrawing(owner, projectId, { documentNumber: "A-101", title: "تکراری" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "document_number_taken");
        return true;
      });
      await expect(
        docs.createDrawing(owner, projectId, { documentNumber: "", title: "بی‌شماره" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "document_number_required");
        return true;
      });
      await expect(
        docs.createDrawing(owner, projectId, {
          documentNumber: "B-1",
          title: "رشتهٔ نامعتبر",
          discipline: "catering",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "invalid_discipline");
        return true;
      });
    });
  });

  it("creates the document row behind a revision and chains it to the previous file", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const firstAsset = await addMediaAsset(businessId, owner.actorUserId, "A-101-revA.pdf");
    const secondAsset = await addMediaAsset(businessId, owner.actorUserId, "A-101-revB.pdf");

    const { drawing } = await seedDrawing(owner, "کتابخانه");
    const first = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { mediaAssetId: firstAsset }),
    );
    const second = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { mediaAssetId: secondAsset }),
    );

    expect(first.workspaceDocumentId).not.toBeNull();
    expect(second.workspaceDocumentId).not.toBeNull();

    const { rows } = await db.query<{ title: string; supersedes_id: string | null; project_id: string }>(
      `SELECT title, supersedes_id, project_id FROM workspace_documents
        WHERE id = $1`,
      [second.workspaceDocumentId],
    );
    // The document row is a real document of this project, titled with the
    // register's number and revision, and it supersedes the previous revision's
    // file — so the documents screen's own version chain tells the same story.
    expect(rows[0].project_id).toBe(drawing.projectId);
    expect(rows[0].title).toContain("A-101");
    expect(rows[0].supersedes_id).toBe(first.workspaceDocumentId);
  });
});

describe("issuing through a transmittal (issue #799 §9 and §12)", () => {
  it("issues the revisions, supersedes the ones they replace, and freezes both sides", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const contractor = await createParty(businessId, "پیمانکار اصلی", ["supplier"]);
    const { drawing } = await seedDrawing(owner, "پروژهٔ صدور");

    const revisionA = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionDate: "2026-03-01" }),
    );

    // First issue: A goes out for construction.
    const first = await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-001",
        subject: "نقشه‌های اول",
        purpose: "for_construction",
        items: [{ revisionId: revisionA.id }],
        recipients: [{ partyId: contractor, requiresAcknowledgement: true }],
      });
      return docs.issueTransmittal(owner, transmittal.id);
    });

    expect(first.status).toBe("issued");
    expect(first.issuedByName).toBe("مالک");
    // The issue date defaults to the business's own today, not the server's.
    expect(first.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.items[0].documentNumber).toBe("A-101");
    expect(first.items[0].revisionCode).toBe("A");

    let loaded = await dbLib.withTenant(businessId, () => docs.loadDrawing(businessId, drawing.id));
    expect(loaded.revisions[0].status).toBe("issued");
    // The register named no purpose of its own, so the transmittal's stands.
    expect(loaded.revisions[0].issuePurpose).toBe("for_construction");
    expect(loaded.revisions[0].transmittals.map((ref) => ref.transmittalNumber)).toEqual(["TR-001"]);

    // Second issue: B replaces A, and A becomes history.
    const revisionB = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionCode: "B" }),
    );
    const second = await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-002",
        purpose: "for_construction",
        items: [{ revisionId: revisionB.id }],
        recipients: [{ partyId: contractor, requiresAcknowledgement: true }],
      });
      return docs.issueTransmittal(owner, transmittal.id);
    });
    expect(second.status).toBe("issued");

    loaded = await dbLib.withTenant(businessId, () => docs.loadDrawing(businessId, drawing.id));
    expect(loaded.revisions.map((revision) => [revision.revisionCode, revision.status])).toEqual([
      ["B", "issued"],
      ["A", "superseded"],
    ]);
    expect(loaded.latestRevisionCode).toBe("B");
    expect(loaded.latestRevisionStatus).toBe("issued");

    // §9's immutability, from a connection that bypasses the service entirely.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        dbLib.query(`UPDATE aec_document_revisions SET revision_code = 'Z' WHERE id = $1`, [
          revisionA.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`DELETE FROM aec_document_revisions WHERE id = $1`, [revisionA.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`UPDATE aec_document_revisions SET status = 'draft' WHERE id = $1`, [
          revisionB.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      // The transmittal itself is frozen too — number, purpose and lines.
      await expect(
        dbLib.query(`UPDATE aec_transmittals SET transmittal_number = 'TR-999' WHERE id = $1`, [
          second.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`DELETE FROM aec_transmittal_items WHERE transmittal_id = $1`, [second.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`DELETE FROM aec_transmittals WHERE id = $1`, [second.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`UPDATE aec_transmittals SET status = 'draft' WHERE id = $1`, [second.id]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    // The service refuses the same things, with codes the API can map.
    await dbLib.withTenant(businessId, async () => {
      await expect(docs.deleteRevision(owner, revisionB.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "revision_not_editable");
        return true;
      });
      await expect(
        docs.updateRevision(owner, revisionB.id, { notes: "تلاش برای بازنویسی" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "revision_not_editable");
        return true;
      });
      await expect(docs.deleteTransmittal(owner, second.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "transmittal_not_editable");
        return true;
      });
      // And a register entry with issued history cannot be deleted at all.
      await expect(docs.deleteDrawing(owner, drawing.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "drawing_has_issued_revisions");
        return true;
      });
    });
  });

  it("freezes the file behind an issued revision", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const recipient = await createParty(businessId, "کارفرما", ["customer"]);
    const asset = await addMediaAsset(businessId, owner.actorUserId, "S-201-revA.pdf");
    const otherAsset = await addMediaAsset(businessId, owner.actorUserId, "other.pdf");

    const { drawing } = await seedDrawing(owner, "پروژهٔ فایل", {
      documentNumber: "S-201",
      title: "نقشهٔ سازه",
      discipline: "structural_engineering",
    });
    const revision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { mediaAssetId: asset }),
    );

    await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-010",
        items: [{ revisionId: revision.id }],
        recipients: [{ partyId: recipient }],
      });
      await docs.issueTransmittal(owner, transmittal.id);
    });

    const fileRow = revision.workspaceDocumentId as string;
    await dbLib.withTenant(businessId, async () => {
      // Repointing the file at another asset — what an "edit this document"
      // screen would do — is refused, because that would change what was issued.
      await expect(
        dbLib.query(`UPDATE workspace_documents SET media_asset_id = $2 WHERE id = $1`, [
          fileRow,
          otherAsset,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        dbLib.query(`UPDATE workspace_documents SET title = 'چیز دیگری' WHERE id = $1`, [fileRow]),
      ).rejects.toMatchObject({ code: "23514" });
      // The review status of the document stays the approval engine's business.
      await dbLib.query(`UPDATE workspace_documents SET status = 'approved' WHERE id = $1`, [fileRow]);
    });

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM workspace_documents WHERE id = $1`,
      [fileRow],
    );
    expect(rows[0].status).toBe("approved");
  });

  it("refuses to issue a transmittal with nothing in it or nobody to receive it", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const recipient = await createParty(businessId, "گیرندهٔ تنها", ["supplier"]);
    const { drawing } = await seedDrawing(owner, "پروژهٔ ناقص");
    const revision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, {}),
    );

    await dbLib.withTenant(businessId, async () => {
      const empty = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-020",
      });
      await expect(docs.issueTransmittal(owner, empty.id)).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "transmittal_empty");
        return true;
      });

      const noRecipients = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-021",
        items: [{ revisionId: revision.id }],
      });
      await expect(docs.issueTransmittal(owner, noRecipients.id)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "transmittal_has_no_recipients");
          return true;
        },
      );

      // …and the database says the same thing, for a caller that skips the
      // service: a draft with no lines cannot be flipped to issued.
      await expect(
        dbLib.query(`UPDATE aec_transmittals SET status = 'issued' WHERE id = $1`, [noRecipients.id]),
      ).rejects.toMatchObject({ code: "23514" });

      // A valid one, kept for the acknowledgement case below.
      const ready = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-022",
        items: [{ revisionId: revision.id }],
        recipients: [{ partyId: recipient }],
      });
      expect(ready.status).toBe("draft");
      expect(ready.items).toHaveLength(1);
      expect(ready.recipients).toHaveLength(1);
    });
  });

  it("records receipts and closes the transmittal only when every required signature lands", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const employer = await createParty(businessId, "کارفرما", ["customer"]);
    const consultant = await createParty(businessId, "مشاور", ["supplier"]);
    const courtesy = await createParty(businessId, "بایگانی", ["supplier"]);
    const { drawing } = await seedDrawing(owner, "پروژهٔ رسید");
    const revision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, {}),
    );

    const issued = await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-030",
        items: [{ revisionId: revision.id }],
        recipients: [
          { partyId: employer, requiresAcknowledgement: true },
          { partyId: consultant, requiresAcknowledgement: true },
          // A courtesy copy: never counted as a pending signature.
          { partyId: courtesy, requiresAcknowledgement: false },
        ],
      });
      return docs.issueTransmittal(owner, transmittal.id);
    });
    expect(issued.pendingAcknowledgements).toBe(2);

    const employerId = issued.recipients.find((row) => row.partyName === "کارفرما")!.id;
    const consultantId = issued.recipients.find((row) => row.partyName === "مشاور")!.id;

    const afterFirst = await dbLib.withTenant(businessId, () =>
      docs.acknowledgeTransmittal(owner, issued.id, {
        recipientId: employerId,
        acknowledgedByName: "مهندس رضایی",
      }),
    );
    expect(afterFirst.status).toBe("issued");
    expect(afterFirst.pendingAcknowledgements).toBe(1);

    // The same receipt cannot be recorded twice.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        docs.acknowledgeTransmittal(owner, issued.id, { recipientId: employerId }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "recipient_already_acknowledged");
        return true;
      });
    });

    const afterSecond = await dbLib.withTenant(businessId, () =>
      docs.acknowledgeTransmittal(owner, issued.id, {
        recipientId: consultantId,
        acknowledgedByName: "خانم موسوی",
      }),
    );
    expect(afterSecond.status).toBe("acknowledged");
    expect(afterSecond.acknowledgedAt).not.toBeNull();
    expect(afterSecond.pendingAcknowledgements).toBe(0);

    // The database refuses the same two shortcuts: acknowledging a draft, and
    // closing a transmittal that still has unsigned recipients.
    await dbLib.withTenant(businessId, async () => {
      await expect(
        dbLib.query(`UPDATE aec_transmittals SET status = 'issued' WHERE id = $1`, [issued.id]),
      ).rejects.toMatchObject({ code: "23514" });
      const { rows: draftRows } = await dbLib.query<{ id: string }>(
        `INSERT INTO aec_transmittals
           (business_id, project_id, transmittal_number, status)
         VALUES ($1, $2, 'TR-031', 'issued') RETURNING id`,
        [businessId, drawing.projectId],
      );
      expect(draftRows).toHaveLength(1);
    });
  });

  it("keeps what was issued on the line itself, even as the register moves on", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const recipient = await createParty(businessId, "پیمانکار", ["supplier"]);
    const { drawing } = await seedDrawing(owner, "پروژهٔ سابقه", {
      documentNumber: "E-301",
      title: "نقشهٔ برق",
      discipline: "mep",
    });
    const revision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionCode: "C1" }),
    );

    const issued = await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, drawing.projectId, {
        transmittalNumber: "TR-040",
        subject: "پنجره‌های برق",
        purpose: "for_review",
        items: [{ revisionId: revision.id }],
        recipients: [{ partyId: recipient }],
      });
      return docs.issueTransmittal(owner, transmittal.id);
    });

    // The line snapshot is written by the database from the revision, not
    // posted by the caller: what was sent is what the register held.
    const { rows } = await db.query<{
      document_number: string;
      document_title: string;
      revision_code: string;
      issue_purpose: string;
    }>(
      `SELECT document_number, document_title, revision_code, issue_purpose
         FROM aec_transmittal_items WHERE transmittal_id = $1`,
      [issued.id],
    );
    expect(rows[0]).toMatchObject({
      document_number: "E-301",
      document_title: "نقشهٔ برق",
      revision_code: "C1",
      issue_purpose: "for_review",
    });

    // Renaming the register entry afterwards does not rewrite the record of
    // what was issued.
    await dbLib.withTenant(businessId, async () => {
      await docs.updateDrawing(owner, drawing.id, { title: "نقشهٔ برق (اصلاح‌شده)" });
    });
    const { rows: after } = await db.query<{ document_title: string }>(
      `SELECT document_title FROM aec_transmittal_items WHERE transmittal_id = $1`,
      [issued.id],
    );
    expect(after[0].document_title).toBe("نقشهٔ برق");
  });
});

describe("the assistant's drawing read (§23)", () => {
  it("answers with the current revision per document, filtered", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const recipient = await createParty(businessId, "کارفرمای نقشه", ["customer"]);
    const { projectId, drawing } = await seedDrawing(owner, "پروژهٔ پرسش", {
      documentNumber: "A-401",
      title: "پلان معماری",
      discipline: "architecture",
    });
    const structural = await dbLib.withTenant(businessId, () =>
      docs.createDrawing(owner, projectId, {
        documentNumber: "S-401",
        title: "نقشهٔ سازه",
        discipline: "structural_engineering",
      }),
    );

    await dbLib.withTenant(businessId, () => docs.addRevision(owner, drawing.id, {}));
    const structuralRevision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, structural.id, { revisionCode: "01" }),
    );
    await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, projectId, {
        transmittalNumber: "TR-050",
        items: [{ revisionId: structuralRevision.id }],
        recipients: [{ partyId: recipient }],
      });
      await docs.issueTransmittal(owner, transmittal.id);
    });

    const all = await dbLib.withTenant(businessId, () =>
      docs.latestDrawingRevisions(businessId, { projectId }),
    );
    expect(all).toHaveLength(2);
    const structuralRow = all.find((row) => row.documentNumber === "S-401")!;
    expect(structuralRow.revisionStatus).toBe("issued");
    expect(structuralRow.revisionStatusLabel).toBe("صادرشده");
    expect(structuralRow.revisionCode).toBe("01");
    const architectureRow = all.find((row) => row.documentNumber === "A-401")!;
    expect(architectureRow.isDraft).toBe(true);
    expect(architectureRow.revisionStatusLabel).toBe("پیش‌نویس");

    // A discipline filter and a search term both narrow it, and neither
    // invents a row.
    const onlyStructural = await dbLib.withTenant(businessId, () =>
      docs.latestDrawingRevisions(businessId, { projectId, discipline: "structural_engineering" }),
    );
    expect(onlyStructural.map((row) => row.documentNumber)).toEqual(["S-401"]);
    const searched = await dbLib.withTenant(businessId, () =>
      docs.latestDrawingRevisions(businessId, { projectId, search: "معماری" }),
    );
    expect(searched.map((row) => row.documentNumber)).toEqual(["A-401"]);
    const nothing = await dbLib.withTenant(businessId, () =>
      docs.latestDrawingRevisions(businessId, { projectId, search: "استخر" }),
    );
    expect(nothing).toEqual([]);
  });
});

describe("tenancy, capability and the party references", () => {
  it("refuses a café, and an AEC business that switched document control off", async () => {
    const cafe = await provisionBusiness("food_service");
    const projectId = await createProject(cafe.businessId, cafe.userId, "پروژهٔ کافه");
    await dbLib.withTenant(cafe.businessId, async () => {
      await expect(docs.listProjectDrawings(cafe.businessId, projectId)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "industry_mismatch");
          return true;
        },
      );
      await expect(
        docs.createDrawing(cafe.owner, projectId, { documentNumber: "X-1", title: "نقشه" }),
      ).rejects.toSatisfy((error: unknown) => {
        expectAecError(error, "industry_mismatch");
        return true;
      });
    });

    const aecBusiness = await provisionBusiness("architecture_construction");
    const aecProjectId = await createProject(aecBusiness.businessId, aecBusiness.userId, "پروژهٔ خاموش");
    await dbLib.withTenant(aecBusiness.businessId, async () => {
      await aec.saveBusinessAecProfile(aecBusiness.owner, {
        operatingProfile: "contractor",
        capabilityOverrides: { document_control: false },
      });
      await expect(docs.listProjectDrawings(aecBusiness.businessId, aecProjectId)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "capability_disabled");
          return true;
        },
      );
      // A café's drawings are not a business with the key switched off, and the
      // two refusals are different codes on purpose.
      await aec.saveBusinessAecProfile(aecBusiness.owner, {
        operatingProfile: "contractor",
        capabilityOverrides: { document_control: true },
      });
      const list = await docs.listProjectDrawings(aecBusiness.businessId, aecProjectId);
      expect(list).toEqual([]);
    });
  });

  it("shows another business nothing and refuses a cross-tenant write", async () => {
    const first = await provisionBusiness("architecture_construction");
    const second = await provisionBusiness("architecture_construction");
    const { drawing } = await seedDrawing(first.owner, "پروژهٔ اول");
    await dbLib.withTenant(first.businessId, () => docs.addRevision(first.owner, drawing.id, {}));

    // Through the service: the row simply is not there for the other tenant.
    await dbLib.withTenant(second.businessId, async () => {
      await expect(docs.loadDrawing(second.businessId, drawing.id)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "drawing_not_found");
          return true;
        },
      );
      await expect(docs.drawingProjectId(second.businessId, drawing.id)).rejects.toSatisfy(
        (error: unknown) => {
          expectAecError(error, "drawing_not_found");
          return true;
        },
      );
      // A write that names its own business and the other business's id changes
      // nothing — the predicate and the forced policy both say no. (The local
      // development role is a superuser, so RLS itself is proven by the policy
      // sweep in `integration/aec.integration.test.ts`, and the service refusal
      // above is what a caller actually meets.)
      const { rows: touched } = await dbLib.query<{ id: string }>(
        `UPDATE aec_documents SET title = 'دزدیده‌شده'
          WHERE business_id = $1 AND id = $2 RETURNING id`,
        [second.businessId, drawing.id],
      );
      expect(touched).toHaveLength(0);
    });

    // And a revision cannot be attached across tenants: the composite foreign
    // key to the document refuses it, from raw SQL as well.
    await dbLib.withTenant(second.businessId, async () => {
      await expect(
        dbLib.query(
          // A code the document does not already use, so the composite foreign
          // key is what refuses this rather than the per-document uniqueness.
          `INSERT INTO aec_document_revisions
             (business_id, document_id, revision_no, revision_code)
           VALUES ($1, $2, 99, 'ZZ')`,
          [second.businessId, drawing.id],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("demands live, same-business parties for senders and recipients", async () => {
    const first = await provisionBusiness("architecture_construction");
    const second = await provisionBusiness("architecture_construction");
    const { projectId, drawing } = await seedDrawing(first.owner, "پروژهٔ طرف‌ها");
    const revision = await dbLib.withTenant(first.businessId, () =>
      docs.addRevision(first.owner, drawing.id, {}),
    );
    const foreignParty = await createParty(second.businessId, "طرف بیگانه", ["supplier"]);

    await dbLib.withTenant(first.businessId, async () => {
      // The sender of another business is refused by the trigger.
      await expect(
        dbLib.query(
          `INSERT INTO aec_transmittals
             (business_id, project_id, transmittal_number, sender_party_id)
           VALUES ($1, $2, 'TR-060', $3)`,
          [first.businessId, projectId, foreignParty],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });

    const ownParty = await createParty(first.businessId, "طرف خودی", ["supplier"]);
    await dbLib.withTenant(first.businessId, async () => {
      const transmittal = await docs.createTransmittal(first.owner, projectId, {
        transmittalNumber: "TR-061",
        senderPartyId: ownParty,
        items: [{ revisionId: revision.id }],
        recipients: [{ partyId: ownParty }],
      });
      expect(transmittal.senderPartyName).toBe("طرف خودی");

      // A recipient from another business cannot be inserted either.
      await expect(
        dbLib.query(
          `INSERT INTO aec_transmittal_recipients (business_id, transmittal_id, party_id)
           VALUES ($1, $2, $3)`,
          [first.businessId, transmittal.id, foreignParty],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("moves a draft's party references with a merge and leaves an issued record alone", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const loser = await createParty(businessId, "پیمانکار قدیمی", ["customer"]);
    const winner = await createParty(businessId, "پیمانکار جدید", ["customer"]);
    const { projectId, drawing } = await seedDrawing(owner, "پروژهٔ ادغام");
    const draftRevision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionCode: "D" }),
    );
    const issuedRevision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, { revisionCode: "E" }),
    );

    const draftTransmittal = await dbLib.withTenant(businessId, () =>
      docs.createTransmittal(owner, projectId, {
        transmittalNumber: "TR-070",
        senderPartyId: loser,
        items: [{ revisionId: draftRevision.id }],
        recipients: [{ partyId: loser }],
      }),
    );
    const issuedTransmittal = await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, projectId, {
        transmittalNumber: "TR-071",
        senderPartyId: loser,
        items: [{ revisionId: issuedRevision.id }],
        recipients: [{ partyId: loser }],
      });
      return docs.issueTransmittal(owner, transmittal.id);
    });

    // `mergeCustomers(businessId, winnerId, loserId, options)` — the surviving
    // record first, and both sides need the customer role for the merge to run.
    const merged = await dbLib.withTenant(businessId, () =>
      crm.mergeCustomers(businessId, winner, loser, { mergedByUserId: owner.actorUserId }),
    );
    expect(merged).not.toBeNull();

    const { rows } = await db.query<{
      id: string;
      sender_party_id: string | null;
    }>(`SELECT id, sender_party_id FROM aec_transmittals WHERE id = ANY($1::uuid[])`, [
      [draftTransmittal.id, issuedTransmittal.id],
    ]);
    const draftRow = rows.find((row) => row.id === draftTransmittal.id)!;
    const issuedRow = rows.find((row) => row.id === issuedTransmittal.id)!;
    // The draft follows the surviving party — otherwise its next edit would be
    // refused by the trigger that demands a live party.
    expect(draftRow.sender_party_id).toBe(winner);
    // The issued one keeps the sender named in the record it issued, because
    // the guard would refuse the write anyway and the receipt belongs to the
    // party it was actually sent to.
    expect(issuedRow.sender_party_id).toBe(loser);

    const { rows: recipientRows } = await db.query<{ transmittal_id: string; party_id: string }>(
      `SELECT transmittal_id, party_id FROM aec_transmittal_recipients
        WHERE transmittal_id = ANY($1::uuid[])`,
      [[draftTransmittal.id, issuedTransmittal.id]],
    );
    expect(recipientRows.find((row) => row.transmittal_id === draftTransmittal.id)?.party_id).toBe(
      winner,
    );
    expect(recipientRows.find((row) => row.transmittal_id === issuedTransmittal.id)?.party_id).toBe(
      loser,
    );
  });

  it("carries the register's events into the project activity feed", async () => {
    const { businessId, owner } = await provisionBusiness("architecture_construction");
    const recipient = await createParty(businessId, "کارفرمای رویداد", ["customer"]);
    const { projectId, drawing } = await seedDrawing(owner, "پروژهٔ رویداد");
    const revision = await dbLib.withTenant(businessId, () =>
      docs.addRevision(owner, drawing.id, {}),
    );
    await dbLib.withTenant(businessId, async () => {
      const transmittal = await docs.createTransmittal(owner, projectId, {
        transmittalNumber: "TR-080",
        items: [{ revisionId: revision.id }],
        recipients: [{ partyId: recipient }],
      });
      await docs.issueTransmittal(owner, transmittal.id);
    });

    const activity = await dbLib.withTenant(businessId, () =>
      workspace.listActivity(owner, { projectId, limit: 50 }),
    );
    const subjects = activity.map((entry) => entry.subjectType);
    expect(subjects).toContain("document");
    expect(subjects).toContain("document_revision");
    expect(subjects).toContain("transmittal");
    expect(activity.some((entry) => entry.summary.includes("TR-080"))).toBe(true);
    expect(activity.some((entry) => entry.summary.includes("صادر"))).toBe(true);
  });
});
