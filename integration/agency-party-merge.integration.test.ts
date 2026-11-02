/**
 * The audited door through a frozen agency document (migration 0279, issue #1128).
 *
 * 0274 freezes a confirmed brief and 0276 freezes a sent proposal, and both
 * originally put `party_id` inside the frozen-substance comparison. That made a
 * client record holding either one **unmergeable**: `mergeCustomers` re-points every
 * reference the registry classifies as `move`, and the guard refused — so the CRM's
 * own duplicates screen answered a raw SQLSTATE for a merge that is ordinary
 * hygiene. 0278's campaign was born with the split already in place so a new table
 * would not ship the same bug.
 *
 * What this suite pins is the *shape* of the fix, which is the part a passing merge
 * cannot show on its own. Relaxing a freeze is easy and dangerous: the wrong version
 * of this fix would let a member re-file a confirmed brief as another client's, or
 * move an attribution with no record that it moved. So each test here asserts both
 * halves — that the merge succeeds, and that what was frozen stays frozen.
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
  databaseName = `agency_merge_${randomUUID().replaceAll("-", "")}`;

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
  crm = await import("../src/lib/crm-service");

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
let businessId: string;

beforeAll(async () => {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس ادغام ${seq}`,
    ownerName: "مالک",
    email: `agency-merge-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `agmerge${seq}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  businessId = result.businessId;
}, 180_000);

async function seedParty(name: string): Promise<string> {
  return (
    await db.query(`INSERT INTO parties (business_id, name) VALUES ($1,$2) RETURNING id`, [
      businessId,
      name,
    ])
  ).rows[0].id;
}

async function seedBrief(partyId: string, number: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO agency_client_briefs
         (business_id, brief_number, party_id, title, objective, status, sent_at, confirmed_at, confirmed_by_name)
       VALUES ($1,$2,$3,'بریف','هدف','confirmed', now(), now(), 'کارفرما') RETURNING id`,
      [businessId, number, partyId],
    )
  ).rows[0].id;
}

async function seedProposal(partyId: string, number: string): Promise<string> {
  // Draft, then a line, then sent: 0276 refuses to add a line to an offer the
  // client has already seen, and refuses to send one with nothing on it.
  const id = (
    await db.query(
      `INSERT INTO agency_proposals (business_id, proposal_number, party_id, title, status)
       VALUES ($1,$2,$3,'پیشنهاد','draft') RETURNING id`,
      [businessId, number, partyId],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO agency_proposal_lines
       (business_id, proposal_id, line_number, description, quantity, unit_price_rial, amount_rial)
     VALUES ($1,$2,1,'کار',2,5000,10000)`,
    [businessId, id],
  );
  await db.query(`UPDATE agency_proposals SET status='sent', sent_at=now() WHERE id=$1`, [id]);
  return id;
}

async function seedCampaign(partyId: string, number: string, status: string): Promise<string> {
  return (
    await db.query(
      `INSERT INTO agency_client_campaigns
         (business_id, campaign_number, party_id, title, status, start_date, end_date,
          budget_rial, spend_rial, impressions, clicks, leads_generated)
       VALUES ($1,$2,$3,'کمپین',$4,'2026-01-01','2026-02-01',500000,400000,1000,40,12)
       RETURNING id`,
      [businessId, number, partyId, status],
    )
  ).rows[0].id;
}

async function merge(winnerId: string, loserId: string): Promise<void> {
  await crm.mergeCustomers(businessId, winnerId, loserId, { mergedBy: "مالک", mergedByUserId: null });
}

const attributionMoves = async (tableName: string) =>
  (
    await db.query(
      `SELECT row_id, old_party_id, new_party_id FROM crm_party_attribution_moves
        WHERE business_id = $1 AND table_name = $2 ORDER BY moved_at`,
      [businessId, tableName],
    )
  ).rows;

/* --------------------------------------------------------------------- tests */

describe("a party merge through a frozen agency document (issue #1128, migration 0279)", () => {
  it("moves a confirmed brief onto the surviving client", async () => {
    const winner = await seedParty("برندهٔ بریف");
    const loser = await seedParty("بازندهٔ بریف");
    const briefId = await seedBrief(loser, "BR-8001");

    await merge(winner, loser);

    const row = (
      await db.query(`SELECT party_id, title, objective, status FROM agency_client_briefs WHERE id=$1`, [
        briefId,
      ])
    ).rows[0];
    expect(row.party_id).toBe(winner);
    // What the client confirmed is untouched — only whose file it lives on moved.
    expect(row.title).toBe("بریف");
    expect(row.objective).toBe("هدف");
    expect(row.status).toBe("confirmed");

    const moves = await attributionMoves("agency_client_briefs");
    expect(moves.some((m) => m.row_id === briefId && m.old_party_id === loser && m.new_party_id === winner)).toBe(true);
  });

  it("moves a sent proposal, its lines and its price intact", async () => {
    const winner = await seedParty("برندهٔ پیشنهاد");
    const loser = await seedParty("بازندهٔ پیشنهاد");
    const proposalId = await seedProposal(loser, "PR-8001");

    await merge(winner, loser);

    const row = (
      await db.query(`SELECT party_id, title, status FROM agency_proposals WHERE id=$1`, [proposalId])
    ).rows[0];
    expect(row.party_id).toBe(winner);
    expect(row.title).toBe("پیشنهاد");
    expect(row.status).toBe("sent");

    // The offer the client saw is byte-for-byte the same offer, which is the whole
    // point of freezing the substance while allowing the attribution to move.
    const lines = (
      await db.query(
        `SELECT quantity, unit_price_rial, amount_rial FROM agency_proposal_lines
          WHERE business_id=$1 AND proposal_id=$2`,
        [businessId, proposalId],
      )
    ).rows;
    expect(lines).toHaveLength(1);
    expect(Number(lines[0].quantity)).toBe(2);
    expect(Number(lines[0].unit_price_rial)).toBe(5000);
    expect(Number(lines[0].amount_rial)).toBe(10000);

    const moves = await attributionMoves("agency_proposals");
    expect(moves.some((m) => m.row_id === proposalId && m.new_party_id === winner)).toBe(true);
  });

  it("moves a completed campaign, whose figures were already reported", async () => {
    const winner = await seedParty("برندهٔ کمپین");
    const loser = await seedParty("بازندهٔ کمپین");
    const campaignId = await seedCampaign(loser, "CA-8001", "completed");

    await merge(winner, loser);

    const row = (
      await db.query(
        `SELECT party_id, status, spend_rial, impressions, leads_generated FROM agency_client_campaigns WHERE id=$1`,
        [campaignId],
      )
    ).rows[0];
    expect(row.party_id).toBe(winner);
    expect(row.status).toBe("completed");
    expect(Number(row.spend_rial)).toBe(400_000);
    expect(Number(row.impressions)).toBe(1000);
    expect(Number(row.leads_generated)).toBe(12);

    const moves = await attributionMoves("agency_client_campaigns");
    expect(moves.some((m) => m.row_id === campaignId && m.new_party_id === winner)).toBe(true);
  });

  it("moves a brand's stakeholder and approver along with the documents", async () => {
    // §A's separation rule survives the merge: the approver has to remain a contact
    // of whichever client record survives, and both pointers resolve rather than
    // naming an archived duplicate.
    const winner = await seedParty("برندهٔ رابط");
    const loser = await seedParty("بازندهٔ رابط");
    const contact = await seedParty("رابط مشترک");
    await db.query(
      `INSERT INTO crm_party_relationships (business_id, from_party_id, to_party_id, kind)
       VALUES ($1,$2,$3,'contact_of'), ($1,$2,$4,'contact_of')`,
      [businessId, contact, loser, winner],
    );
    const briefId = (
      await db.query(
        `INSERT INTO agency_client_briefs
           (business_id, brief_number, party_id, title, objective, approver_party_id, approver_name,
            status, sent_at, confirmed_at, confirmed_by_name)
         VALUES ($1,'BR-8002',$2,'بریف','هدف',$3,'رابط','confirmed', now(), now(), 'کارفرما') RETURNING id`,
        [businessId, loser, contact],
      )
    ).rows[0].id;

    await merge(winner, loser);

    const row = (
      await db.query(`SELECT party_id, approver_party_id FROM agency_client_briefs WHERE id=$1`, [briefId])
    ).rows[0];
    expect(row.party_id).toBe(winner);
    expect(row.approver_party_id).toBe(contact);
  });

  it("still refuses an edit that is not a merge", async () => {
    // The relaxation is exactly one transaction-local flag wide. Everything else —
    // every other session, every other path — still hits the guard, which is the
    // difference between an audited door and a hole.
    const winner = await seedParty("برندهٔ ویرایش");
    const loser = await seedParty("بازندهٔ ویرایش");
    const briefId = await seedBrief(loser, "BR-8003");
    const proposalId = await seedProposal(loser, "PR-8003");
    const campaignId = await seedCampaign(loser, "CA-8003", "completed");
    await merge(winner, loser);

    const other = await seedParty("سومین شخص");
    const refused = async (sql: string, params: unknown[]) =>
      db.query(sql, params).then(
        () => "updated",
        (error: { code?: string; message?: string }) => `${error.code}:${error.message}`,
      );

    expect(
      await refused(`UPDATE agency_client_briefs SET party_id=$1 WHERE id=$2`, [other, briefId]),
    ).toContain("audited party merge");
    expect(
      await refused(`UPDATE agency_proposals SET party_id=$1 WHERE id=$2`, [other, proposalId]),
    ).toContain("audited party merge");
    expect(
      await refused(`UPDATE agency_client_campaigns SET party_id=$1 WHERE id=$2`, [other, campaignId]),
    ).toContain("audited party merge");

    // And the substance is still frozen for everybody, flag or no flag.
    expect(
      await refused(`UPDATE agency_client_briefs SET objective='چیز دیگر' WHERE id=$1`, [briefId]),
    ).toContain("frozen");
    expect(
      await refused(`UPDATE agency_proposals SET discount_rial=1 WHERE id=$1`, [proposalId]),
    ).toContain("frozen");
    expect(
      await refused(`UPDATE agency_client_campaigns SET spend_rial=1 WHERE id=$1`, [campaignId]),
    ).toContain("closed");
  });

  it("audits every attribution move, so the trail is the reason the door is safe", async () => {
    const moves = (
      await db.query(
        `SELECT table_name, count(*)::int AS n FROM crm_party_attribution_moves
          WHERE business_id=$1 GROUP BY table_name ORDER BY table_name`,
        [businessId],
      )
    ).rows;
    const byTable = Object.fromEntries(moves.map((row) => [row.table_name, Number(row.n)]));
    expect(byTable["agency_client_briefs"]).toBeGreaterThanOrEqual(3);
    expect(byTable["agency_proposals"]).toBeGreaterThanOrEqual(2);
    expect(byTable["agency_client_campaigns"]).toBeGreaterThanOrEqual(2);
  });
});
