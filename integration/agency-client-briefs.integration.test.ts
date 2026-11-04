/**
 * §A's client briefs against a real database (issue #1128).
 *
 * `agency-brief.test.ts` pins the vocabulary and the chain, and 48 raw-SQL
 * assertions pin migration 0274's constraints. Neither can see what this file is
 * here for, which is the service and the schema agreeing:
 *
 *   * that numbering is one sequence per agency and survives two creates racing
 *     for the same number — the advisory lock only exists inside a transaction,
 *     and only a real database can show that it is in the right one;
 *   * that a tenant cannot read, list or edit another tenant's brief, which is
 *     the class of leak §E shipped with and caught only here;
 *   * that §A's separation rule holds — an approver who is not a contact of *this
 *     brief's own client* is refused, in either direction of the relationship;
 *   * that the freeze and the §A→§B handoff coexist: a confirmed brief refuses a
 *     change to what the client agreed, and still accepts the project it becomes;
 *   * that deleting a client takes a confirmed brief with it, rather than the
 *     guard turning a legitimate cascade into a refusal.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { AGENCY_BRIEF_DELIVERABLE_LIMIT } from "../src/lib/agency-brief";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let service: typeof import("../src/lib/agency-brief-service");

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
  databaseName = `agency_briefs_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Imported only after the environment points at the throwaway database, so every
  // module below binds its pool to it rather than to the runner's default.
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  service = await import("../src/lib/agency-brief-service");

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

/* ------------------------------------------------------------------ fixtures */

let seq = 0;

async function provisionAgency(): Promise<string> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس آزمایشی ${seq}`,
    ownerName: "مالک",
    email: `agency-brief-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agbrief${seq}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  return result.businessId;
}

const ACTOR = { userId: randomUUID(), name: "مالک" };

async function seedParty(businessId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO parties (id, business_id, name) VALUES ($1,$2,$3)`, [
    id,
    businessId,
    name,
  ]);
  return id;
}

async function seedRelationship(
  businessId: string,
  from: string,
  to: string,
  kind = "contact_of",
): Promise<void> {
  await db.query(
    `INSERT INTO crm_party_relationships (business_id, from_party_id, to_party_id, kind)
     VALUES ($1,$2,$3,$4)`,
    [businessId, from, to, kind],
  );
}

async function seedDeal(businessId: string, title: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO crm_deals (id, business_id, title) VALUES ($1,$2,$3)`, [
    id,
    businessId,
    title,
  ]);
  return id;
}

async function seedProject(businessId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO ai_projects (id, business_id, name, created_by) VALUES ($1,$2,$3,$4)`,
    [id, businessId, name, randomUUID()],
  );
  return id;
}

/** A tenant with one client, that client's approver, and an unrelated stranger. */
async function agencyWithClient() {
  const businessId = await provisionAgency();
  const client = await seedParty(businessId, "کارفرمای نمونه");
  const approver = await seedParty(businessId, "نازنین موحد");
  const reverseApprover = await seedParty(businessId, "تماس وارونه");
  const stranger = await seedParty(businessId, "بی‌ارتباط");
  await seedRelationship(businessId, approver, client);
  await seedRelationship(businessId, client, reverseApprover);
  return { businessId, client, approver, reverseApprover, stranger };
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("client briefs against a real database (issue #1128 §A)", () => {
  it("numbers one sequence per agency, and holds it under a race", async () => {
    const { businessId, client } = await agencyWithClient();
    const first = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "بریف یکم",
    });
    const second = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "بریف دوم",
    });
    expect(first.briefNumber).toBe("BR-001");
    expect(second.briefNumber).toBe("BR-002");

    // The advisory lock is transaction-scoped, so this is the only test that can
    // tell whether the number is chosen inside the same transaction as the insert.
    const raced = await Promise.all([
      service.createAgencyBrief(businessId, ACTOR, { partyId: client, title: "همزمان الف" }),
      service.createAgencyBrief(businessId, ACTOR, { partyId: client, title: "همزمان ب" }),
    ]);
    const numbers = raced.map((brief) => brief.briefNumber).sort();
    expect(numbers).toEqual(["BR-003", "BR-004"]);
    expect(new Set(numbers).size, "a race must not hand out one number twice").toBe(2);
  });

  it("starts a separate sequence for a separate agency", async () => {
    const { businessId, client } = await agencyWithClient();
    await service.createAgencyBrief(businessId, ACTOR, { partyId: client, title: "بریف الف" });

    const other = await agencyWithClient();
    const theirs = await service.createAgencyBrief(other.businessId, ACTOR, {
      partyId: other.client,
      title: "بریف ب",
    });
    expect(theirs.briefNumber).toBe("BR-001");
  });

  it("never shows one tenant another tenant's brief", async () => {
    const mine = await agencyWithClient();
    const theirs = await agencyWithClient();
    const brief = await service.createAgencyBrief(mine.businessId, ACTOR, {
      partyId: mine.client,
      title: "محرمانه",
      objective: "هدفی که دیگری نباید ببیند",
    });

    // A 404 rather than a 403: the existence of another tenant's brief is not
    // disclosed either.
    await expectRefusal(
      service.loadAgencyBrief(theirs.businessId, brief.id),
      "brief_not_found",
    );
    await expectRefusal(
      service.updateAgencyBrief(theirs.businessId, brief.id, ACTOR, { title: "دزدی" }),
      "brief_not_found",
    );
    await expectRefusal(
      service.applyAgencyBriefAction(theirs.businessId, brief.id, ACTOR, "send"),
      "brief_not_found",
    );
    expect(await service.deleteAgencyBrief(theirs.businessId, brief.id)).toBe(false);

    const listed = await service.listAgencyBriefs(theirs.businessId);
    expect(listed.map((row) => row.id)).not.toContain(brief.id);
    // And the row is untouched, not merely hidden.
    const stillMine = await service.loadAgencyBrief(mine.businessId, brief.id);
    expect(stillMine.title).toBe("محرمانه");
  });

  it("refuses a brief that points at another tenant's records", async () => {
    const mine = await agencyWithClient();
    const theirs = await agencyWithClient();

    // A trigger refusal arrives as a pg error carrying `23514` rather than as an
    // `AgencyBriefError`, so what is asserted here is the thing that matters: the
    // write did not land, in any tenant.
    const foreignDeal = await seedDeal(theirs.businessId, "فرصت بیگانه");
    const foreignProject = await seedProject(theirs.businessId, "پروژهٔ بیگانه");
    const attempts = await Promise.all(
      [
        { partyId: theirs.client, title: "کارفرمای بیگانه" },
        { partyId: mine.client, title: "فرصت بیگانه", dealId: foreignDeal },
        { partyId: mine.client, title: "پروژهٔ بیگانه", projectId: foreignProject },
        { partyId: mine.client, title: "تأییدکنندهٔ بیگانه", approverPartyId: theirs.approver },
      ].map((input) =>
        service
          .createAgencyBrief(mine.businessId, ACTOR, input)
          .then(() => "written")
          .catch(() => "refused"),
      ),
    );
    expect(attempts, "every reference into another tenant must be refused").toEqual([
      "refused",
      "refused",
      "refused",
      "refused",
    ]);

    const rows = await db.query(
      `SELECT count(*)::int n FROM agency_client_briefs WHERE business_id = $1`,
      [mine.businessId],
    );
    expect(rows.rows[0].n, "nothing at all should have been written").toBe(0);
  });

  it("records an approver only when they are this client's own contact", async () => {
    const { businessId, client, approver, reverseApprover, stranger } = await agencyWithClient();

    // §A: the stakeholder is recorded "without exposing another client's
    // information" — so a contact of somebody else is not an available choice.
    await expect(
      service
        .createAgencyBrief(businessId, ACTOR, {
          partyId: client,
          title: "با بی‌ارتباط",
          approverPartyId: stranger,
        })
        .then(() => "written")
        .catch(() => "refused"),
      "a stranger must not be recordable as this client's approver",
    ).resolves.toBe("refused");

    // And the refusal wrote nothing at all.
    const strangers = await db.query(
      `SELECT count(*)::int n FROM agency_client_briefs
        WHERE business_id = $1 AND approver_party_id = $2`,
      [businessId, stranger],
    );
    expect(strangers.rows[0].n).toBe(0);

    const forward = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "با تأییدکننده",
      objective: "هدف",
      approverPartyId: approver,
      approverName: "نازنین موحد",
    });
    expect(forward.approverPartyId).toBe(approver);

    const reverse = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "با رابطهٔ وارونه",
      objective: "هدف",
      approverPartyId: reverseApprover,
    });
    expect(reverse.approverPartyId).toBe(reverseApprover);
  });

  it("refuses to send a client a brief with no objective", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "خالی",
    });
    expect(brief.status).toBe("draft");
    expect(brief.actions).toContain("send");

    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send"),
      "objective_required",
    );

    const filled = await service.updateAgencyBrief(businessId, brief.id, ACTOR, {
      objective: "افزایش آگاهی از برند",
    });
    expect(filled.objective).toBe("افزایش آگاهی از برند");
    const sent = await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBeTruthy();
  });

  it("walks the chain and refuses every step that is not in it", async () => {
    const { businessId, client, approver } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "کمپین نوروز",
      objective: "هدف نوروز",
      approverPartyId: approver,
      approverName: "نازنین موحد",
    });

    // Confirming before the client has seen it would record an agreement that
    // never happened.
    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "confirm"),
      "invalid_transition",
    );
    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "supersede"),
      "invalid_transition",
    );
    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "reopen"),
      "invalid_transition",
    );
    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "invent"),
      "invalid_action",
    );

    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");
    const confirmed = await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "confirm");
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedAt).toBeTruthy();
    // The approver the brief already named is who the confirmation is attributed
    // to, so confirming without naming anybody is still an attributed act.
    expect(confirmed.confirmedByName).toBe("نازنین موحد");
    expect(confirmed.actions).toEqual(["supersede"]);

    const superseded = await service.applyAgencyBriefAction(
      businessId,
      brief.id,
      ACTOR,
      "supersede",
    );
    expect(superseded.status).toBe("superseded");
    expect(superseded.actions).toEqual([]);
  });

  it("attributes a confirmation to the name given, and refuses one with none", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "بدون تأییدکننده",
      objective: "هدف",
    });
    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");

    // No approver was recorded and none was supplied: an unattributed
    // confirmation is an assertion, not a record.
    await expectRefusal(
      service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "confirm"),
      "confirmer_required",
    );

    const confirmed = await service.applyAgencyBriefAction(
      businessId,
      brief.id,
      ACTOR,
      "confirm",
      { confirmedByName: "رستم دادگر" },
    );
    expect(confirmed.confirmedByName).toBe("رستم دادگر");
  });

  it("withdraws from either side and reopens only what nobody confirmed", async () => {
    const { businessId, client } = await agencyWithClient();

    const draft = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "کنارگذاشته از پیش‌نویس",
    });
    const withdrawnDraft = await service.applyAgencyBriefAction(
      businessId,
      draft.id,
      ACTOR,
      "withdraw",
    );
    expect(withdrawnDraft.status).toBe("withdrawn");
    // A draft can be withdrawn without ever having been sent.
    expect(withdrawnDraft.sentAt).toBeNull();
    const reopened = await service.applyAgencyBriefAction(
      businessId,
      draft.id,
      ACTOR,
      "reopen",
    );
    expect(reopened.status).toBe("draft");

    const sent = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "کنارگذاشته از ارسال",
      objective: "هدف",
    });
    await service.applyAgencyBriefAction(businessId, sent.id, ACTOR, "send");
    const withdrawnSent = await service.applyAgencyBriefAction(
      businessId,
      sent.id,
      ACTOR,
      "withdraw",
    );
    expect(withdrawnSent.status).toBe("withdrawn");
    // Withdrawing does not un-send it: the client saw it, and that stays true.
    expect(withdrawnSent.sentAt).toBeTruthy();
  });

  it("freezes what the client confirmed, but still lets the brief meet its project", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "کمپین مهر",
      objective: "هدف مهر",
      channels: ["social"],
      budgetRial: 5_000_000,
    });
    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");
    const confirmed = await service.applyAgencyBriefAction(
      businessId,
      brief.id,
      ACTOR,
      "confirm",
      { confirmedByName: "کارفرما" },
    );
    expect(confirmed.frozen).toBe(true);

    for (const patch of [
      { title: "عنوان دیگر" },
      { objective: "هدف دیگر" },
      { channels: ["print"] },
      { budgetRial: 9_000_000 },
      { deliverables: [{ title: "قلم تازه" }] },
      { partyId: client },
    ]) {
      await expectRefusal(
        service.updateAgencyBrief(businessId, brief.id, ACTOR, patch),
        "brief_frozen",
      );
    }

    // The note is ours, not the client's, so it stays writable — and so does the
    // pointer to the project the brief becomes, which normally arrives *after*
    // confirmation. Freezing it would break the §A→§B handoff.
    const projectId = await seedProject(businessId, "پروژه مهر");
    const dealId = await seedDeal(businessId, "فرصت مهر");
    const attached = await service.updateAgencyBrief(businessId, brief.id, ACTOR, {
      note: "یادداشت داخلی تازه",
      projectId,
      dealId,
    });
    expect(attached.note).toBe("یادداشت داخلی تازه");
    expect(attached.projectId).toBe(projectId);
    expect(attached.projectName).toBe("پروژه مهر");
    expect(attached.dealId).toBe(dealId);
    // Nothing the client agreed to moved.
    expect(attached.objective).toBe("هدف مهر");
    expect(attached.budgetRial).toBe(5_000_000);
    expect(attached.channels).toEqual(["social"]);
  });

  it("keeps an absent field and honours an explicit null", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "بودجه‌دار",
      objective: "هدف",
      budgetRial: 1_200_000,
      audience: "جوانان",
    });

    // A PATCH that says nothing about the budget must not delete it.
    const untouched = await service.updateAgencyBrief(businessId, brief.id, ACTOR, {
      note: "فقط یادداشت",
    });
    expect(untouched.budgetRial).toBe(1_200_000);
    expect(untouched.audience).toBe("جوانان");

    const cleared = await service.updateAgencyBrief(businessId, brief.id, ACTOR, {
      budgetRial: null,
    });
    expect(cleared.budgetRial, "an explicit null is a decision to clear it").toBeNull();
    expect(cleared.audience, "and only that field").toBe("جوانان");
  });

  it("refuses a channel or deliverable nobody recognises instead of dropping it", async () => {
    const { businessId, client } = await agencyWithClient();

    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "کانال ناشناخته",
        channels: ["social", "billboard"],
      }),
      "invalid_channel",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "قلم ناشناخته",
        deliverables: [{ title: "تیزر", format: "hologram" }],
      }),
      "invalid_deliverable",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "قلم بی‌عنوان",
        deliverables: [{ title: "  " }],
      }),
      "invalid_deliverable",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "قلم‌های زیاد",
        deliverables: Array.from({ length: AGENCY_BRIEF_DELIVERABLE_LIMIT + 1 }, (_, i) => ({
          title: `قلم ${i + 1}`,
        })),
      }),
      "invalid_deliverable",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "بودجهٔ منفی",
        budgetRial: -1,
      }),
      "invalid_budget",
    );

    // Nothing was written by any of them.
    const rows = await db.query(
      `SELECT count(*)::int n FROM agency_client_briefs WHERE business_id = $1`,
      [businessId],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses a delivery date before the start, on create and on patch", async () => {
    const { businessId, client } = await agencyWithClient();
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "بازهٔ وارونه",
        startDate: "2026-03-10",
        deliveryDate: "2026-03-01",
      }),
      "invalid_period",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, {
        partyId: client,
        title: "تاریخ ناممکن",
        startDate: "2026-02-30",
      }),
      "invalid_date",
    );

    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "بازهٔ درست",
      startDate: "2026-03-01",
      deliveryDate: "2026-03-20",
    });
    expect(brief.startDate).toBe("2026-03-01");
    expect(brief.deliveryDate).toBe("2026-03-20");

    // Patching only one end still cannot produce an impossible window.
    await expectRefusal(
      service.updateAgencyBrief(businessId, brief.id, ACTOR, { deliveryDate: "2026-02-01" }),
      "invalid_period",
    );
    const moved = await service.updateAgencyBrief(businessId, brief.id, ACTOR, {
      deliveryDate: "2026-04-01",
    });
    expect(moved.deliveryDate).toBe("2026-04-01");
    expect(moved.startDate, "the untouched end stays put").toBe("2026-03-01");
  });

  it("deletes a draft and refuses a brief the client has seen", async () => {
    const { businessId, client } = await agencyWithClient();
    const draft = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "اشتباهی",
    });
    expect(await service.deleteAgencyBrief(businessId, draft.id)).toBe(true);
    expect(await service.deleteAgencyBrief(businessId, draft.id)).toBe(false);

    const sent = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "ارسال‌شده",
      objective: "هدف",
    });
    await service.applyAgencyBriefAction(businessId, sent.id, ACTOR, "send");
    await expectRefusal(
      service.deleteAgencyBrief(businessId, sent.id),
      "brief_not_deletable",
    );
    // Still there, still readable: the refusal changed nothing.
    expect((await service.loadAgencyBrief(businessId, sent.id)).status).toBe("sent");
  });

  it("takes a confirmed brief away with the client it belongs to", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "همراه کارفرما",
      objective: "هدف",
    });
    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");
    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "confirm", {
      confirmedByName: "کارفرما",
    });

    // The freeze must not become a reason the client's own record cannot be
    // deleted: with no counterparty left there is nobody for the brief to speak
    // for, and refusing would strand the deletion.
    await db.query(`DELETE FROM parties WHERE id = $1 AND business_id = $2`, [client, businessId]);
    const left = await db.query(
      `SELECT count(*)::int n FROM agency_client_briefs WHERE id = $1`,
      [brief.id],
    );
    expect(left.rows[0].n).toBe(0);
  });

  it("keeps a brief when its project or opportunity goes, and lists by every dimension", async () => {
    const { businessId, client, approver } = await agencyWithClient();
    const otherClient = await seedParty(businessId, "کارفرمای دیگر");
    const projectId = await seedProject(businessId, "پروژهٔ گذرا");
    const dealId = await seedDeal(businessId, "فرصت گذرا");

    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "کمپین بهار",
      objective: "هدف بهار",
      projectId,
      dealId,
      approverPartyId: approver,
      channels: ["outdoor", "social"],
      deliverables: [{ title: "بیلبورد", format: "print_ready", quantity: 3 }],
    });
    await service.createAgencyBrief(businessId, ACTOR, {
      partyId: otherClient,
      title: "کمپین تابستان",
      objective: "هدف تابستان",
    });

    // Deleting the project nulls the pointer rather than destroying the record of
    // what was asked for.
    await db.query(`DELETE FROM ai_projects WHERE id = $1`, [projectId]);
    const after = await service.loadAgencyBrief(businessId, brief.id);
    expect(after.projectId).toBeNull();
    expect(after.dealId).toBe(dealId);
    expect(after.deliverables).toEqual([
      { title: "بیلبورد", format: "print_ready", quantity: 3 },
    ]);
    // Vocabulary order, not the caller's, so two briefs asking for the same
    // channels compare equal.
    expect(after.channels).toEqual(["social", "outdoor"]);

    const all = await service.listAgencyBriefs(businessId);
    expect(all).toHaveLength(2);
    expect(await service.listAgencyBriefs(businessId, { partyId: client })).toHaveLength(1);
    expect(await service.listAgencyBriefs(businessId, { dealId })).toHaveLength(1);
    expect(await service.listAgencyBriefs(businessId, { projectId })).toHaveLength(0);
    expect(await service.listAgencyBriefs(businessId, { status: "draft" })).toHaveLength(2);
    // One search across the brief's own words and its client's name.
    expect(await service.listAgencyBriefs(businessId, { q: "بهار" })).toHaveLength(1);
    expect(await service.listAgencyBriefs(businessId, { q: "کارفرمای دیگر" })).toHaveLength(1);
    expect(await service.listAgencyBriefs(businessId, { q: "BR-00" })).toHaveLength(2);

    await service.applyAgencyBriefAction(businessId, brief.id, ACTOR, "send");
    expect(await service.listAgencyBriefs(businessId, { openOnly: true })).toHaveLength(2);
    expect(await service.listAgencyBriefs(businessId, { status: "sent" })).toHaveLength(1);
  });

  it("refuses a brief with no client, and one with no title", async () => {
    const { businessId, client } = await agencyWithClient();
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, { title: "بی‌کارفرما" }),
      "client_required",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, { partyId: "  ", title: "بی‌کارفرما" }),
      "client_required",
    );
    await expectRefusal(
      service.createAgencyBrief(businessId, ACTOR, { partyId: client, title: "   " }),
      "title_required",
    );
    const brief = await service.createAgencyBrief(businessId, ACTOR, {
      partyId: client,
      title: "درست",
    });
    await expectRefusal(
      service.updateAgencyBrief(businessId, brief.id, ACTOR, { title: "" }),
      "title_required",
    );
    await expectRefusal(
      service.updateAgencyBrief(businessId, brief.id, ACTOR, {
        title: "ا".repeat(400),
      }),
      "text_too_long",
    );
  });
});
