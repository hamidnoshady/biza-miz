/**
 * §A's multi-brand client against a real database (issue #1128).
 *
 * `crm-org-structure.test.ts` pins the resolver — direction collapsing, cycles,
 * two claimed parents, the depth bound. What only a database can show is whether
 * the *reading* is a reading of this tenant's own records:
 *
 *   * that the four registers counted per brand are counted for this group's
 *     parties and nobody else's, which is the whole point of the card — a member
 *     who reads «مهر کیمیا: ۲ پیشنهاد» must be reading مهر کیمیا's;
 *   * that a party from another tenant cannot be resolved into this tenant's tree,
 *     through the join or through the id, which is the leak §E shipped with and
 *     caught only here;
 *   * that the hierarchy is read from both relationship kinds, because a member
 *     may record it from either end and the tree must not depend on which;
 *   * that contradictory records terminate rather than hang — a cycle is data a
 *     real tenant can produce in two clicks, and a resolver that looped on it
 *     would take the request down with it.
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
let service: typeof import("../src/lib/crm-relationship-service");
let briefs: typeof import("../src/lib/agency-brief-service");
let proposals: typeof import("../src/lib/agency-proposal-service");

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
  databaseName = `agency_org_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/crm-relationship-service");
  briefs = await import("../src/lib/agency-brief-service");
  proposals = await import("../src/lib/agency-proposal-service");

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
const ACTOR = { userId: randomUUID(), name: "مالک" };

async function provisionAgency(): Promise<string> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس آزمایشی ${seq}`,
    ownerName: "مالک",
    email: `agency-org-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agorg${seq}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  return result.businessId;
}

async function seedParty(businessId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO parties (id, business_id, name, person_type) VALUES ($1,$2,$3,'legal')`,
    [id, businessId, name],
  );
  return id;
}

/**
 * An organisation edge, with the direction it is stored in made explicit.
 *
 * `parent_organization` is written parent → child and `branch_of` child → parent:
 * the same fact stored two ways, which is the thing under test.
 */
async function linkOrg(
  businessId: string,
  from: string,
  to: string,
  kind: "parent_organization" | "branch_of",
  createdAt?: string,
): Promise<void> {
  await db.query(
    `INSERT INTO crm_party_relationships
       (business_id, from_party_id, to_party_id, kind, created_at)
     VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now()))`,
    [businessId, from, to, kind, createdAt ?? null],
  );
}

async function linkContact(businessId: string, from: string, to: string): Promise<void> {
  await db.query(
    `INSERT INTO crm_party_relationships (business_id, from_party_id, to_party_id, kind)
     VALUES ($1,$2,$3,'contact_of')`,
    [businessId, from, to],
  );
}

/** A group with two brands and a contact who is not a brand. */
async function agencyWithGroup() {
  const businessId = await provisionAgency();
  const group = await seedParty(businessId, "گروه صنعتی مهر");
  const food = await seedParty(businessId, "مهر فود");
  const kimia = await seedParty(businessId, "مهر کیمیا");
  const contact = await seedParty(businessId, "نازنین موحد");
  // One brand recorded parent → child, the other child → parent, on purpose: a
  // resolver that read only one kind would see a group with a single brand.
  await linkOrg(businessId, group, food, "parent_organization", "2026-01-01T00:00:00Z");
  await linkOrg(businessId, kimia, group, "branch_of", "2026-01-02T00:00:00Z");
  await linkContact(businessId, contact, food);
  return { businessId, group, food, kimia, contact };
}

async function seedDeal(businessId: string, customerId: string, title: string): Promise<void> {
  await db.query(`INSERT INTO crm_deals (business_id, customer_id, title) VALUES ($1,$2,$3)`, [
    businessId,
    customerId,
    title,
  ]);
}

async function seedContract(businessId: string, partyId: string, title: string): Promise<void> {
  await db.query(`INSERT INTO workspace_contracts (business_id, party_id, title) VALUES ($1,$2,$3)`, [
    businessId,
    partyId,
    title,
  ]);
}

/* --------------------------------------------------------------------- tests */

describe("the multi-brand client against a real database (issue #1128 §A)", () => {
  it("resolves one group from edges recorded in both directions", async () => {
    const { businessId, group, food, kimia, contact } = await agencyWithGroup();

    const structure = await service.organizationStructureFor(businessId, group);
    expect(structure).not.toBeNull();
    expect(structure!.isEmpty).toBe(false);
    expect(structure!.isBrand).toBe(false);
    expect(structure!.groupId).toBe(group);
    expect(structure!.groupName).toBe("گروه صنعتی مهر");
    // Both brands, and only them: the contact is a relationship, not an
    // organisation, and putting a person in the tree is the confusion this card
    // exists to remove.
    expect(structure!.descendantIds.sort()).toEqual([food, kimia].sort());
    expect(structure!.members.map((m) => m.partyId).sort()).toEqual(
      [group, food, kimia].sort(),
    );
    expect(structure!.members.find((m) => m.partyId === contact)).toBeUndefined();
    expect(structure!.conflicts).toEqual([]);
    expect(structure!.depthLimited).toBe(false);
  });

  it("roots a brand's own file on the group, and names its sibling", async () => {
    const { businessId, group, food, kimia } = await agencyWithGroup();

    const structure = await service.organizationStructureFor(businessId, food);
    expect(structure!.isBrand).toBe(true);
    expect(structure!.groupId).toBe(group);
    expect(structure!.ancestorIds).toEqual([group]);
    // The sibling is in the picture, which is the fact that stops one brand's work
    // being priced for another: reading «مهر فود» shows that «مهر کیمیا» exists and
    // is a different brand of the same group.
    expect(structure!.members.map((m) => m.partyId).sort()).toEqual(
      [group, food, kimia].sort(),
    );
    expect(structure!.members.find((m) => m.partyId === food)!.isFocus).toBe(true);
  });

  it("resolves three levels, root-first and depth-ordered", async () => {
    const { businessId, group, food } = await agencyWithGroup();
    const division = await seedParty(businessId, "دستهٔ مصرفی");
    const subBrand = await seedParty(businessId, "مهر اسنک");
    await linkOrg(businessId, group, division, "parent_organization");
    await linkOrg(businessId, division, subBrand, "parent_organization");

    const structure = await service.organizationStructureFor(businessId, subBrand);
    // Depth per party, rather than an exact array: "root-first and depth-ordered"
    // is the contract a screen indents against, and pinning sibling order too would
    // tie this test to the order two edges happened to be inserted in.
    const depthOf = Object.fromEntries(
      structure!.members.map((m) => [m.name, m.depth]),
    );
    expect(depthOf).toEqual({
      "گروه صنعتی مهر": 0,
      "مهر فود": 1,
      "مهر کیمیا": 1,
      "دستهٔ مصرفی": 1,
      "مهر اسنک": 2,
    });
    // Root first, and never a shallower node after a deeper one.
    expect(structure!.members[0].partyId).toBe(group);
    const depths = structure!.members.map((m) => m.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    expect(structure!.ancestorIds).toEqual([division, group]);
    expect(structure!.members.find((m) => m.partyId === food)!.parentId).toBe(group);
    expect(structure!.members.find((m) => m.partyId === subBrand)!.parentId).toBe(division);
  });

  it("counts each brand's own work, and nobody else's", async () => {
    const { businessId, group, food, kimia } = await agencyWithGroup();
    const unrelated = await seedParty(businessId, "کارفرمای بی‌ارتباط");

    await seedDeal(businessId, food, "فرصت فود");
    await seedDeal(businessId, food, "فرصت دوم فود");
    await seedDeal(businessId, unrelated, "فرصت دیگری");
    await seedContract(businessId, kimia, "قرارداد کیمیا");
    await briefs.createAgencyBrief(businessId, ACTOR, { partyId: food, title: "بریف فود" });
    const offer = await proposals.createAgencyProposal(businessId, ACTOR, {
      partyId: food,
      title: "پیشنهاد فود",
      lines: [{ description: "کمپین", quantity: 1, unitPriceRial: 1000 }],
    });
    await proposals.createAgencyProposal(businessId, ACTOR, {
      partyId: kimia,
      title: "پیشنهاد کیمیا",
      lines: [{ description: "کمپین", quantity: 1, unitPriceRial: 1000 }],
    });
    await proposals.applyAgencyProposalAction(businessId, offer.id, ACTOR, "send");
    await proposals.applyAgencyProposalAction(businessId, offer.id, ACTOR, "accept", {
      decidedByName: "کارفرما",
    });

    const structure = await service.organizationStructureFor(businessId, group);
    const workOf = (id: string) => structure!.members.find((m) => m.partyId === id)!.work;

    expect(workOf(food)).toEqual({
      deals: 2,
      briefs: 1,
      proposals: 1,
      acceptedProposals: 1,
      contracts: 0,
      campaigns: 0,
      campaignsInFlight: 0,
    });
    expect(workOf(kimia)).toEqual({
      deals: 0,
      briefs: 0,
      proposals: 1,
      acceptedProposals: 0,
      contracts: 1,
      campaigns: 0,
      campaignsInFlight: 0,
    });
    // The group itself carries nothing: the work belongs to the brands, and
    // rolling it up would double-count every figure on the card.
    expect(workOf(group)).toEqual({
      deals: 0,
      briefs: 0,
      proposals: 0,
      acceptedProposals: 0,
      contracts: 0,
      campaigns: 0,
      campaignsInFlight: 0,
    });
  });

  it("counts campaigns per brand now that a register can answer, and not the one that cannot", async () => {
    const { businessId, group, food, kimia } = await agencyWithGroup();
    // #901's builder campaign: a retail cashback automation with no client. It must
    // not be counted, and giving it one would have made a column mean two things in
    // two trades — see 0278's header.
    await db.query(`INSERT INTO growth_campaigns (business_id, name) VALUES ($1,$2)`, [
      businessId,
      "کمپین کش‌بک فروشگاه",
    ]);
    // 0278's client campaign: two for one brand, one live and one only planned, and
    // one for the other brand.
    await db.query(
      `INSERT INTO agency_client_campaigns
         (business_id, campaign_number, party_id, title, status, start_date, end_date)
       VALUES ($1,'CA-1',$2,'بهاره فود','running','2026-03-01','2026-06-30'),
              ($1,'CA-2',$2,'آینده فود','planned',NULL,NULL),
              ($1,'CA-3',$3,'بهاره کیمیا','running','2026-03-01','2026-06-30')`,
      [businessId, food, kimia],
    );

    const structure = await service.organizationStructureFor(businessId, group);
    const workOf = (id: string) => structure!.members.find((m) => m.partyId === id)!.work;
    // Wave 8 refused to render a campaign count because nothing could answer it.
    // The refusal is lifted by a register that can, not by relaxing the standard.
    expect(workOf(food).campaigns).toBe(2);
    expect(workOf(food).campaignsInFlight).toBe(1);
    expect(workOf(kimia).campaigns).toBe(1);
    expect(workOf(kimia).campaignsInFlight).toBe(1);
    expect(workOf(group).campaigns).toBe(0);
  });

  it("says there is no structure for a party that is only a contact", async () => {
    const { businessId, contact } = await agencyWithGroup();
    const structure = await service.organizationStructureFor(businessId, contact);
    expect(structure).not.toBeNull();
    // Not an error and not an empty group: a client that is not part of a group is
    // the common case, and the card renders nothing at all for it.
    expect(structure!.isEmpty).toBe(true);
    expect(structure!.members).toHaveLength(1);
    expect(structure!.members[0].partyId).toBe(contact);
  });

  it("keeps one tenant out of another tenant's group", async () => {
    const mine = await agencyWithGroup();
    const theirs = await agencyWithGroup();

    // A valid id from another tenant, read through this tenant's scope.
    await expect(
      service.organizationStructureFor(mine.businessId, theirs.group),
    ).resolves.toBeNull();
    await expect(
      service.organizationStructureFor(theirs.businessId, mine.group),
    ).resolves.toBeNull();

    // And an edge cannot pull a foreign party into this tenant's tree, which is
    // what the `business_id` predicate inside each join exists to prevent.
    const structure = await service.organizationStructureFor(mine.businessId, mine.group);
    const ids = structure!.members.map((m) => m.partyId);
    for (const foreign of [theirs.group, theirs.food, theirs.kimia]) {
      expect(ids).not.toContain(foreign);
    }

    // Work from another tenant's register rows cannot be counted onto this group
    // either: the counts are restricted to this group's own party ids.
    await seedDeal(theirs.businessId, theirs.food, "فرصت بیگانه");
    const recounted = await service.organizationStructureFor(mine.businessId, mine.group);
    expect(recounted!.members.find((m) => m.partyId === mine.food)!.work.deals).toBe(0);
  });

  it("refuses a party that does not exist, and an id that is not one", async () => {
    const { businessId } = await agencyWithGroup();
    await expect(
      service.organizationStructureFor(businessId, randomUUID()),
    ).resolves.toBeNull();
    await expect(
      service.organizationStructureFor(businessId, "not-a-uuid"),
    ).resolves.toBeNull();
    await expect(service.organizationStructureFor(businessId, "")).resolves.toBeNull();
  });

  it("takes the newest of two claimed parents and reports the contradiction", async () => {
    const { businessId, group, food } = await agencyWithGroup();
    const otherGroup = await seedParty(businessId, "گروه رقیب");
    // A re-parenting recorded by adding an edge rather than removing the old one,
    // which is how a correction actually arrives.
    await linkOrg(businessId, otherGroup, food, "parent_organization", "2026-06-01T00:00:00Z");

    const structure = await service.organizationStructureFor(businessId, food);
    expect(structure!.members.find((m) => m.partyId === food)!.parentId).toBe(otherGroup);
    expect(structure!.members.find((m) => m.partyId === food)!.contestedParent).toBe(true);
    expect(structure!.conflicts).toEqual([
      { kind: "two_parents", partyId: food, involvedPartyIds: [otherGroup, group] },
    ]);
    // Both groups are drawn, so the member can see the contradiction rather than
    // only its winner.
    expect(structure!.groupId).toBe(otherGroup);
  });

  it("terminates on a cycle and names only the parties in it", async () => {
    const businessId = await provisionAgency();
    const a = await seedParty(businessId, "الف");
    const b = await seedParty(businessId, "ب");
    const below = await seedParty(businessId, "ج");
    // Two members each recorded the hierarchy from their own end. There is no top,
    // and a resolver that walked forever would take the request down with it.
    await linkOrg(businessId, a, b, "parent_organization", "2026-01-01T00:00:00Z");
    await linkOrg(businessId, b, a, "parent_organization", "2026-01-02T00:00:00Z");
    await linkOrg(businessId, a, below, "parent_organization", "2026-01-03T00:00:00Z");

    const structure = await service.organizationStructureFor(businessId, below);
    expect(structure!.conflicts.some((c) => c.kind === "cycle")).toBe(true);
    // «ج» sits below the loop and is not part of the contradiction: naming it would
    // send a member to fix a record that is correct.
    const cycle = structure!.conflicts.find((c) => c.kind === "cycle")!;
    expect(cycle.involvedPartyIds.sort()).toEqual([a, b].sort());
    expect(cycle.involvedPartyIds).not.toContain(below);
    // The picture is still drawable, and every party appears once.
    const ids = structure!.members.map((m) => m.partyId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(below);
  });

  it("stops at the depth bound and reports that the picture is incomplete", async () => {
    const businessId = await provisionAgency();
    const chain: string[] = [];
    for (let index = 0; index < 14; index += 1) {
      chain.push(await seedParty(businessId, `سطح ${index}`));
    }
    for (let index = 0; index < chain.length - 1; index += 1) {
      await linkOrg(businessId, chain[index], chain[index + 1], "parent_organization");
    }

    const structure = await service.organizationStructureFor(businessId, chain[chain.length - 1]);
    expect(structure!.depthLimited).toBe(true);
    expect(structure!.ancestorIds.length).toBeLessThanOrEqual(8);
    expect(structure!.members.length).toBeLessThanOrEqual(9);
  });

  it("ignores a relationship kind that is not an organisation", async () => {
    const { businessId, food, contact } = await agencyWithGroup();
    // The contact edge is real and is read by `/relationships`; it must not make
    // «نازنین موحد» a brand of «مهر فود».
    const structure = await service.organizationStructureFor(businessId, contact);
    expect(structure!.isEmpty).toBe(true);
    expect(structure!.members.map((m) => m.partyId)).not.toContain(food);
  });
});
