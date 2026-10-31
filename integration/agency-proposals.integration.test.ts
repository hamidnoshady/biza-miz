/**
 * §A's proposals against a real database (issue #1128).
 *
 * `agency-proposal.test.ts` pins the vocabulary, the chain and the arithmetic, and
 * 86 raw-SQL assertions pin migration 0276's constraints. Neither can see what
 * this file is here for, which is the service and the schema *agreeing*:
 *
 *   * that a line's stored amount equals the figure the pure module computes, on
 *     the half-rial case where the two rounding rules could differ by one rial —
 *     a disagreement nobody would notice in review and everybody would notice in
 *     an audit;
 *   * that numbering is one sequence per agency and survives two creates racing
 *     for the same number, since the advisory lock only exists inside a
 *     transaction and only a real database shows it is the right one;
 *   * that a tenant cannot read, list, price or decide another tenant's offer,
 *     which is the class of leak §E shipped with and caught only here;
 *   * that §A's separation rule holds — a stakeholder who is not a contact of
 *     *this* offer's own client is refused, in either direction, and a brief
 *     written for one client cannot be priced for another;
 *   * that the freeze covers the lines, which are the price, and still allows the
 *     one write that happens afterwards: recording the contract the offer became;
 *   * that an offer whose clock has run out cannot be accepted, a rule no CHECK
 *     can express because it needs the current date;
 *   * that the client-facing projection cannot leak a cost, read from real rows.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  AGENCY_PROPOSAL_LINE_LIMIT,
  agencyProposalLineAmountRial,
} from "../src/lib/agency-proposal";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let service: typeof import("../src/lib/agency-proposal-service");

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
  databaseName = `agency_proposals_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/agency-proposal-service");

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
    email: `agency-proposal-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agprop${seq}`,
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
  await db.query(`INSERT INTO ai_projects (id, business_id, name, created_by) VALUES ($1,$2,$3,$4)`, [
    id,
    businessId,
    name,
    randomUUID(),
  ]);
  return id;
}

async function seedContract(businessId: string, title: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO workspace_contracts (id, business_id, title) VALUES ($1,$2,$3)`, [
    id,
    businessId,
    title,
  ]);
  return id;
}

/** A brief, written the way 0274's service writes one. */
async function seedBrief(
  businessId: string,
  partyId: string,
  title: string,
): Promise<{ id: string; briefNumber: string }> {
  const briefs = await import("../src/lib/agency-brief-service");
  const created = await briefs.createAgencyBrief(businessId, ACTOR, { partyId, title });
  return { id: created.id, briefNumber: created.briefNumber };
}

/** A tenant with one client, that client's stakeholder, and an unrelated stranger. */
async function agencyWithClient() {
  const businessId = await provisionAgency();
  const client = await seedParty(businessId, "کارفرمای نمونه");
  const contact = await seedParty(businessId, "نازنین موحد");
  const reverseContact = await seedParty(businessId, "تماس وارونه");
  const stranger = await seedParty(businessId, "بی‌ارتباط");
  const secondClient = await seedParty(businessId, "کارفرمای دوم");
  await seedRelationship(businessId, contact, client);
  await seedRelationship(businessId, client, reverseContact);
  return { businessId, client, contact, reverseContact, stranger, secondClient };
}

/** A priced draft, ready to be sent: two lines totalling ۱٬۵۰۰٬۰۰۰ ریال. */
async function draftOffer(businessId: string, partyId: string, over: Record<string, unknown> = {}) {
  return service.createAgencyProposal(businessId, ACTOR, {
    partyId,
    title: "کمپین بهاره",
    scopeOfWork: "سه کانال، شش هفته.",
    lines: [
      { description: "مدیریت کمپین", quantity: 1, unitPriceRial: 1_000_000 },
      { description: "خرید رسانه", quantity: 2.5, unitPriceRial: 200_000, revenueCode: "4660" },
    ],
    ...over,
  });
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

/* --------------------------------------------------------------------- tests */

describe("agency proposals against a real database (issue #1128 §A + §D)", () => {
  it("numbers one sequence per agency, and holds it under a race", async () => {
    const { businessId, client } = await agencyWithClient();
    const first = await draftOffer(businessId, client);
    const second = await draftOffer(businessId, client);
    expect(first.proposalNumber).toBe("PR-001");
    expect(second.proposalNumber).toBe("PR-002");

    // The advisory lock only exists inside a transaction, so this is the test that
    // says the numbering call is in the right one: two concurrent creates either
    // get different numbers or one of them is a 500.
    const raced = await Promise.all([
      draftOffer(businessId, client),
      draftOffer(businessId, client),
    ]);
    const numbers = raced.map((p) => p.proposalNumber).sort();
    expect(numbers).toEqual(["PR-003", "PR-004"]);

    // And a second agency starts its own sequence rather than joining this one.
    const other = await provisionAgency();
    const otherClient = await seedParty(other, "کارفرمای دیگر");
    expect((await draftOffer(other, otherClient)).proposalNumber).toBe("PR-001");
  });

  it("stores the amount the pure module computes, including the half rial", async () => {
    const { businessId, client } = await agencyWithClient();
    // 0.5 × 1001 is the case where "round half up" and "round half away from
    // zero" could disagree, and where a one-rial gap between the screen and the
    // stored row would be invisible in review.
    const created = await service.createAgencyProposal(businessId, ACTOR, {
      partyId: client,
      title: "گردکردن",
      lines: [{ description: "نیم‌روز", quantity: 0.5, unitPriceRial: 1001 }],
    });
    expect(created.lines[0].amountRial).toBe(501);
    expect(created.lines[0].amountRial).toBe(
      agencyProposalLineAmountRial(created.lines[0].quantity, created.lines[0].unitPriceRial),
    );
    expect(created.totals.subtotalRial).toBe(501);
    expect(created.totals.totalRial).toBe(501);

    // The trigger recomputes on update, and the service reads back what it stored.
    const patched = await service.updateAgencyProposal(businessId, created.id, ACTOR, {
      lines: [{ description: "نیم‌روز", quantity: 1.5, unitPriceRial: 1001 }],
    });
    expect(patched.lines[0].amountRial).toBe(1502);
  });

  it("derives the totals from the lines and never stores one", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client, { discountRial: 100_000, taxRial: 90_000 });
    expect(created.totals).toEqual({
      subtotalRial: 1_500_000,
      discountRial: 100_000,
      taxRial: 90_000,
      totalRial: 1_490_000,
    });
    // The header carries no total to disagree with the lines.
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agency_proposals' AND column_name ~ 'total'`,
    );
    expect(rows).toEqual([]);
  });

  it("shows the agency its own margin, and keeps it off the client's copy", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await service.createAgencyProposal(businessId, ACTOR, {
      partyId: client,
      title: "حاشیه سود",
      discountRial: 100_000,
      lines: [
        { description: "دستمز", quantity: 1, unitPriceRial: 1_000_000, costRial: 300_000 },
        {
          description: "خرید رسانه",
          quantity: 1,
          unitPriceRial: 4_000_000,
          revenueCode: "4660",
          costRial: 4_000_000,
          passThrough: true,
        },
      ],
    });
    expect(created.margin.costRial).toBe(4_300_000);
    // 5_000_000 subtotal − 100_000 discount − 4_300_000 cost. Tax is on neither
    // side: it is collected, not earned.
    expect(created.margin.marginRial).toBe(600_000);
    expect(created.margin.passThroughRial).toBe(4_000_000);
    expect(created.margin.costedLineCount).toBe(2);

    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    const view = await service.loadAgencyProposalClientView(businessId, created.id);
    const dumped = JSON.stringify(view);
    for (const forbidden of ["costRial", "passThrough", "revenueCode", "300000", "4300000", "margin"]) {
      expect(dumped).not.toContain(forbidden);
    }
    // The figure the client is offered survives the projection exactly.
    expect(view.totals.subtotalRial).toBe(5_000_000);
    expect(view.totals.totalRial).toBe(4_900_000);
    expect(view.lines).toHaveLength(2);
    expect(view.agencyName.length).toBeGreaterThan(0);
    expect(view.clientName).toBe("کارفرمای نمونه");
  });

  it("will not hand a client an offer the agency has not finished pricing", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client);
    await expectRefusal(
      service.loadAgencyProposalClientView(businessId, created.id),
      "invalid_transition",
    );
  });

  it("refuses a discount larger than the offer, on create and on a later patch", async () => {
    const { businessId, client } = await agencyWithClient();
    await expectRefusal(
      draftOffer(businessId, client, { discountRial: 1_500_001 }),
      "invalid_discount",
    );
    // Equal is allowed: zero-rial work is a real offer, not an error.
    const free = await draftOffer(businessId, client, { discountRial: 1_500_000 });
    expect(free.totals.totalRial).toBe(0);

    // Patching only the discount still cannot produce a negative offer, because
    // the check reads the lines that will exist after the write.
    const created = await draftOffer(businessId, client);
    await expectRefusal(
      service.updateAgencyProposal(businessId, created.id, ACTOR, { discountRial: 9_000_000 }),
      "invalid_discount",
    );
    // And the other way round: shrinking the lines under an existing discount.
    await expectRefusal(
      service.updateAgencyProposal(businessId, created.id, ACTOR, {
        discountRial: 1_000_000,
        lines: [{ description: "کوچک", quantity: 1, unitPriceRial: 100 }],
      }),
      "invalid_discount",
    );
  });

  it("refuses a pass-through line that does not say what passes through", async () => {
    const { businessId, client } = await agencyWithClient();
    await expectRefusal(
      service.createAgencyProposal(businessId, ACTOR, {
        partyId: client,
        title: "شارژ رسانه",
        lines: [{ description: "خرید رسانه", unitPriceRial: 1000, passThrough: true }],
      }),
      "invalid_line",
    );
  });

  it("refuses a revenue account this agency's chart does not have", async () => {
    const { businessId, client } = await agencyWithClient();
    // 4680 is outside the vocabulary entirely; the trigger says so in words
    // rather than reporting a code the tenant could never add to its own chart.
    await expect(db.query(
      `SELECT code FROM accounts WHERE business_id = $1 AND code = '4640'`,
      [businessId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expectRefusal(
      service.createAgencyProposal(businessId, ACTOR, {
        partyId: client,
        title: "کد نامعتبر",
        lines: [{ description: "x", unitPriceRial: 1, revenueCode: "4680" }],
      }),
      "invalid_line",
    );
  });

  it("keeps one tenant out of another tenant's offer, on every door", async () => {
    const mine = await agencyWithClient();
    const theirs = await agencyWithClient();
    const created = await draftOffer(mine.businessId, mine.client);
    await service.applyAgencyProposalAction(mine.businessId, created.id, ACTOR, "send");

    // The leak §E shipped with: a valid id from another tenant, read through this
    // tenant's scope. `withTenant` sets the RLS scope and does not rewrite SQL, so
    // every predicate below has to be in the statement itself.
    await expectRefusal(
      service.loadAgencyProposal(theirs.businessId, created.id),
      "proposal_not_found",
    );
    await expectRefusal(
      service.loadAgencyProposalClientView(theirs.businessId, created.id),
      "proposal_not_found",
    );
    await expect(service.listAgencyProposals(theirs.businessId, { q: "کمپین بهاره" })).resolves.toEqual([]);
    await expectRefusal(
      service.updateAgencyProposal(theirs.businessId, created.id, ACTOR, { title: "دزدی" }),
      "proposal_not_found",
    );
    await expectRefusal(
      service.applyAgencyProposalAction(theirs.businessId, created.id, ACTOR, "accept"),
      "proposal_not_found",
    );
    await expect(service.deleteAgencyProposal(theirs.businessId, created.id)).resolves.toBe(false);

    // Nothing was changed by the attempts.
    const untouched = await service.loadAgencyProposal(mine.businessId, created.id);
    expect(untouched.title).toBe("کمپین بهاره");
    expect(untouched.status).toBe("sent");
  });

  it("enforces §A's separation rule on the stakeholder, in both directions", async () => {
    const { businessId, client, contact, reverseContact, stranger, secondClient } =
      await agencyWithClient();

    // A contact of this client, whichever way the relationship edge points.
    await expect(
      draftOffer(businessId, client, { clientContactPartyId: contact }),
    ).resolves.toMatchObject({ clientContactPartyId: contact });
    await expect(
      draftOffer(businessId, client, { clientContactPartyId: reverseContact }),
    ).resolves.toMatchObject({ clientContactPartyId: reverseContact });

    // Somebody with no edge to this client cannot be recorded as its approver,
    // even though they are a party of the same tenant. This one is refused by the
    // *database* rather than by the service, deliberately: 0274's trigger owns the
    // rule and the route guard translates its `23514` into a 400, so a second copy
    // of the relationship lookup here would be a second place for the rule to be
    // wrong. Asserting the SQLSTATE is what pins that division of labour.
    await expectRefusal(
      draftOffer(businessId, client, { clientContactPartyId: stranger }),
      "23514",
    );
    await expect(
      draftOffer(businessId, client, { clientContactPartyId: stranger }),
    ).rejects.toThrow(/not a contact of this client/);

    // The other client's own contact is still not this client's contact, so giving
    // the stranger an edge to somebody else changes nothing.
    await seedRelationship(businessId, stranger, secondClient);
    await expectRefusal(
      draftOffer(businessId, client, { clientContactPartyId: stranger }),
      "23514",
    );

    // A client from another tenant is refused by name, not by a foreign key.
    const other = await provisionAgency();
    const otherClient = await seedParty(other, "کارفرمای بیگانه");
    await expect(
      draftOffer(businessId, otherClient),
    ).rejects.toThrow(/another business/);
  });

  it("will not price one client's brief for another client", async () => {
    const { businessId, client, secondClient } = await agencyWithClient();
    const brief = await seedBrief(businessId, client, "بریف کارفرمای نخست");
    const otherBrief = await seedBrief(businessId, secondClient, "بریف کارفرمای دوم");

    await expect(draftOffer(businessId, client, { briefId: brief.id })).resolves.toMatchObject({
      briefId: brief.id,
      briefNumber: brief.briefNumber,
    });
    // The leak this prevents arrives from the other direction: one client's stated
    // requirement inside another client's offer.
    await expect(draftOffer(businessId, client, { briefId: otherBrief.id })).rejects.toThrow(
      /different client/,
    );
  });

  it("attaches the deal and the project the work lives in", async () => {
    const { businessId, client } = await agencyWithClient();
    const deal = await seedDeal(businessId, "فرصت بهاره");
    const project = await seedProject(businessId, "پروژه بهاره");
    const created = await draftOffer(businessId, client, { dealId: deal, projectId: project });
    expect(created.dealTitle).toBe("فرصت بهاره");
    expect(created.projectName).toBe("پروژه بهاره");
    await expect(service.listAgencyProposals(businessId, { dealId: deal })).resolves.toHaveLength(1);
    await expect(service.listAgencyProposals(businessId, { projectId: project })).resolves.toHaveLength(1);
  });

  it("runs the chain, and treats every decision as final", async () => {
    const { businessId, client, contact } = await agencyWithClient();
    const created = await draftOffer(businessId, client, {
      clientContactPartyId: contact,
      clientContactName: "نازنین موحد",
    });
    expect(created.actions).toEqual(["send", "withdraw"]);
    expect(created.frozen).toBe(false);
    expect(created.editable).toBe(true);

    const sent = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();
    expect(sent.frozen).toBe(true);
    expect(sent.editable).toBe(false);
    expect(sent.actions).toEqual(["withdraw", "accept", "decline", "expire"]);

    // The decision is attributed, falling back to the stakeholder the offer names:
    // that person is who the agency recorded as the client's decision-maker.
    const accepted = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept");
    expect(accepted.status).toBe("accepted");
    expect(accepted.decidedByName).toBe("نازنین موحد");
    expect(accepted.decidedAt).not.toBeNull();
    expect(accepted.actions).toEqual([]);

    for (const action of ["send", "withdraw", "accept", "decline", "expire", "reopen"]) {
      await expectRefusal(
        service.applyAgencyProposalAction(businessId, created.id, ACTOR, action),
        "invalid_transition",
      );
    }
  });

  it("needs a name for a decision, and refuses to invent one", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client);
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    // No stakeholder was recorded, so there is nothing to fall back to.
    await expectRefusal(
      service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept"),
      "decider_required",
    );
    await expectRefusal(
      service.applyAgencyProposalAction(businessId, created.id, ACTOR, "decline"),
      "decider_required",
    );
    const declined = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "decline", {
      decidedByName: "کارفرما",
    });
    expect(declined.decidedByName).toBe("کارفرما");
    expect(declined.status).toBe("declined");
  });

  it("will not send an offer with nothing on it", async () => {
    const { businessId, client } = await agencyWithClient();
    const empty = await service.createAgencyProposal(businessId, ACTOR, {
      partyId: client,
      title: "خالی",
    });
    expect(empty.lines).toEqual([]);
    expect(empty.totals.totalRial).toBe(0);
    await expectRefusal(
      service.applyAgencyProposalAction(businessId, empty.id, ACTOR, "send"),
      "lines_required",
    );
    // A draft with no lines is still a draft, and withdrawing it is allowed: what
    // the rule prevents is an empty offer *reaching the client*, and withdrawing
    // one shows it to nobody. The migration originally refused this too, which
    // stranded a half-written draft — unable to be sent, unable to be withdrawn,
    // deletable only while it was still a draft. Only this test caught it, because
    // the service and the schema disagreed and each was self-consistent.
    await expect(
      service.applyAgencyProposalAction(businessId, empty.id, ACTOR, "withdraw"),
    ).resolves.toMatchObject({ status: "withdrawn" });
  });

  it("lets a withdrawn offer be reopened, and a decided one only be replaced", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client);
    const withdrawn = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "withdraw");
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.actions).toEqual(["reopen"]);

    const reopened = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "reopen");
    expect(reopened.status).toBe("draft");
    expect(reopened.lines).toHaveLength(2);
    // The number is not spent: the same proposal goes back out.
    expect(reopened.proposalNumber).toBe(created.proposalNumber);

    // The correction to a decided offer is a new number in the series, and the
    // decided one stays on the record as the offer that was actually refused.
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "decline", {
      decidedByName: "کارفرما",
    });
    const revised = await draftOffer(businessId, client, { title: "پیشنهاد اصلاح‌شده" });
    expect(revised.proposalNumber).not.toBe(created.proposalNumber);
    await expect(service.listAgencyProposals(businessId, { partyId: client })).resolves.toHaveLength(2);
  });

  it("freezes the price once it is sent, lines included", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client, { validUntil: "2027-03-01" });
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");

    for (const patch of [
      { title: "عنوان دیگر" },
      { scopeOfWork: "دامنهٔ دیگر" },
      { terms: "شرایط دیگر" },
      { discountRial: 1 },
      { taxRial: 1 },
      { validUntil: "2028-01-01" },
      { clientContactName: "کس دیگر" },
      { lines: [{ description: "خط تازه", unitPriceRial: 1 }] },
    ]) {
      await expectRefusal(
        service.updateAgencyProposal(businessId, created.id, ACTOR, patch),
        "proposal_frozen",
      );
    }

    // The figure the client read is still the figure stored.
    const after = await service.loadAgencyProposal(businessId, created.id);
    expect(after.totals.subtotalRial).toBe(1_500_000);
    expect(after.lines).toHaveLength(2);
    expect(after.validUntil).toBe("2027-03-01");
  });

  it("still records the contract the offer became, after it was sent", async () => {
    const { businessId, client } = await agencyWithClient();
    const contract = await seedContract(businessId, "قرارداد بهاره");
    const created = await draftOffer(businessId, client);
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept", {
      decidedByName: "کارفرما",
    });

    // The one commercial write that happens after the decision, and the reason the
    // freeze does not cover it: freezing the outcome would make it unrecordable.
    const linked = await service.updateAgencyProposal(businessId, created.id, ACTOR, {
      contractId: contract,
    });
    expect(linked.contractId).toBe(contract);
    expect(linked.contractTitle).toBe("قرارداد بهاره");
    await expect(
      service.listAgencyProposals(businessId, { contractId: contract }),
    ).resolves.toHaveLength(1);
  });

  it("refuses to accept an offer whose clock has run out", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client, { validUntil: "2027-03-01" });
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");

    // No CHECK can express this: `valid_until < now()` is not immutable, so the
    // rule lives in the service. Without it a client could accept a six-month-old
    // quote at the old price — the mistake a validity date exists to prevent.
    await expectRefusal(
      service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept", {
        decidedByName: "کارفرما",
        now: new Date("2027-06-01T00:00:00Z"),
      }),
      "proposal_lapsed",
    );
    // Inclusive: the last day of validity is still valid.
    const onTime = await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept", {
      decidedByName: "کارفرما",
      now: new Date("2027-03-01T12:00:00Z"),
    });
    expect(onTime.status).toBe("accepted");
  });

  it("computes lapsing from the date, and can list what has lapsed", async () => {
    const { businessId, client } = await agencyWithClient();
    const lapsedOffer = await draftOffer(businessId, client, {
      title: "پیشنهادهٔ گذشته",
      validUntil: "2020-01-01",
    });
    const liveOffer = await draftOffer(businessId, client, {
      title: "پیشنهادهٔ جاری",
      validUntil: "2099-01-01",
    });
    await service.applyAgencyProposalAction(businessId, lapsedOffer.id, ACTOR, "send");
    await service.applyAgencyProposalAction(businessId, liveOffer.id, ACTOR, "send");

    // `expired` is a status somebody records; lapsing is a fact about a date. A
    // list that read only the status would keep offering a quote that stopped
    // being an offer years ago, because nothing had got round to marking it.
    const lapsed = await service.loadAgencyProposal(businessId, lapsedOffer.id);
    expect(lapsed.status).toBe("sent");
    expect(lapsed.lapsed).toBe(true);
    const live = await service.loadAgencyProposal(businessId, liveOffer.id);
    expect(live.lapsed).toBe(false);

    const found = await service.listAgencyProposals(businessId, { lapsedOnly: true });
    expect(found.map((p) => p.proposalNumber)).toEqual([lapsed.proposalNumber]);
    expect(found[0].lapsed).toBe(true);
  });

  it("lists with a subtotal but no margin, because a list does not read its lines", async () => {
    const { businessId, client } = await agencyWithClient();
    await draftOffer(businessId, client, { discountRial: 100_000 });
    const listed = await service.listAgencyProposals(businessId, { partyId: client });
    expect(listed).toHaveLength(1);
    expect(listed[0].totals.subtotalRial).toBe(1_500_000);
    expect(listed[0].totals.totalRial).toBe(1_400_000);
    expect(listed[0].lines).toEqual([]);
    expect(listed[0].margin.costedLineCount).toBe(0);
    expect(listed[0].margin.lineCount).toBe(2);
    // Opening the row is what produces the lines and a real margin.
    const opened = await service.loadAgencyProposal(businessId, listed[0].id);
    expect(opened.lines).toHaveLength(2);
  });

  it("honours its filters and its limit", async () => {
    const { businessId, client, secondClient } = await agencyWithClient();
    await draftOffer(businessId, client, { title: "نخست" });
    await draftOffer(businessId, secondClient, { title: "دوم" });
    const sent = await draftOffer(businessId, client, { title: "سوم" });
    await service.applyAgencyProposalAction(businessId, sent.id, ACTOR, "send");

    await expect(service.listAgencyProposals(businessId)).resolves.toHaveLength(3);
    await expect(
      service.listAgencyProposals(businessId, { partyId: secondClient }),
    ).resolves.toHaveLength(1);
    await expect(service.listAgencyProposals(businessId, { openOnly: true })).resolves.toHaveLength(3);
    await expect(service.listAgencyProposals(businessId, { status: "sent" })).resolves.toHaveLength(1);
    await expect(service.listAgencyProposals(businessId, { q: "دوم" })).resolves.toHaveLength(1);
    // A search reaches the client's name too, not only the offer's own words.
    await expect(
      service.listAgencyProposals(businessId, { q: "کارفرمای دوم" }),
    ).resolves.toHaveLength(1);
    await expect(service.listAgencyProposals(businessId, { limit: 2 })).resolves.toHaveLength(2);
  });

  it("refuses more lines than an offer can carry", async () => {
    const { businessId, client } = await agencyWithClient();
    const many = Array.from({ length: AGENCY_PROPOSAL_LINE_LIMIT }, (_, i) => ({
      description: `خط ${i + 1}`,
      unitPriceRial: 1000,
    }));
    await expect(
      service.createAgencyProposal(businessId, ACTOR, { partyId: client, title: "بزرگ", lines: many }),
    ).resolves.toMatchObject({ id: expect.any(String) });
    await expectRefusal(
      service.createAgencyProposal(businessId, ACTOR, {
        partyId: client,
        title: "بزرگ‌تر",
        lines: [...many, { description: "یکی اضافه", unitPriceRial: 1000 }],
      }),
      "invalid_line",
    );
  });

  it("leaves a field alone that a PATCH does not mention", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client, {
      discountRial: 200_000,
      terms: "نصف پیش‌پرداخت",
      validUntil: "2027-03-01",
    });
    const patched = await service.updateAgencyProposal(businessId, created.id, ACTOR, {
      title: "عنوان تازه",
    });
    expect(patched.title).toBe("عنوان تازه");
    // Collapsing absent into null here would have silently deleted a discount,
    // which is the whole reason a PATCH tests presence rather than value.
    expect(patched.discountRial).toBe(200_000);
    expect(patched.terms).toBe("نصف پیش‌پرداخت");
    expect(patched.validUntil).toBe("2027-03-01");
    expect(patched.lines).toHaveLength(2);
    expect(patched.totals.totalRial).toBe(1_300_000);
  });

  it("deletes a draft and its lines, and refuses anything the client saw", async () => {
    const { businessId, client } = await agencyWithClient();
    const draft = await draftOffer(businessId, client);
    await expect(service.deleteAgencyProposal(businessId, draft.id)).resolves.toBe(true);
    await expectRefusal(service.loadAgencyProposal(businessId, draft.id), "proposal_not_found");
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM agency_proposal_lines WHERE proposal_id = $1`,
      [draft.id],
    );
    expect(rows[0].n).toBe(0);

    const sent = await draftOffer(businessId, client);
    await service.applyAgencyProposalAction(businessId, sent.id, ACTOR, "send");
    await expectRefusal(service.deleteAgencyProposal(businessId, sent.id), "proposal_not_deletable");
    // And a nonexistent id is a `false`, not an error: there was nothing to delete.
    await expect(service.deleteAgencyProposal(businessId, randomUUID())).resolves.toBe(false);
  });

  it("does not let a sent offer block the deletion of its own client", async () => {
    const { businessId, client } = await agencyWithClient();
    const created = await draftOffer(businessId, client);
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "send");
    await service.applyAgencyProposalAction(businessId, created.id, ACTOR, "accept", {
      decidedByName: "کارفرما",
    });

    // The cascade-tolerant guard: with no counterparty left there is nobody for the
    // offer to be addressed to, and refusing would let one accepted proposal block
    // the deletion of the client it was sent to.
    await expect(db.query(`DELETE FROM parties WHERE id = $1`, [client])).resolves.toBeDefined();
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM agency_proposals WHERE id = $1`,
      [created.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("keeps a proposal when the brief it priced is deleted", async () => {
    const { businessId, client } = await agencyWithClient();
    const brief = await seedBrief(businessId, client, "بریفی که حذف می‌شود");
    const created = await draftOffer(businessId, client, { briefId: brief.id });
    expect(created.briefNumber).toBe(brief.briefNumber);

    // A brief is a record of what was asked; withdrawing it should not destroy the
    // offer that answered it, so this is SET NULL and not CASCADE.
    await expect(
      db.query(`DELETE FROM agency_client_briefs WHERE id = $1`, [brief.id]),
    ).resolves.toBeDefined();
    const after = await service.loadAgencyProposal(businessId, created.id);
    expect(after.briefId).toBeNull();
    expect(after.title).toBe("کمپین بهاره");
    expect(after.lines).toHaveLength(2);
  });
});
