/**
 * §D's reimbursable client cost, against a real database (issue #1128, migration 0280).
 *
 * The headline assertion is the second one: that a recorded cost **actually posts**,
 * landing in 1270 on net presentation and in 5197 on gross. Account 1270 was seeded
 * in wave 1 and unreachable for eight waves — the expense path refuses asset accounts
 * and §D forbids an ad hoc journal entry — so this suite is the proof that the door
 * opened rather than that a row was inserted.
 *
 * What only a database can show, and what is therefore here rather than in the pure
 * suite: that the register and the ledger agree; that a posted row is frozen from both
 * the service *and* a raw `UPDATE` that skips the service; that a cross-tenant read
 * returns nothing and a foreign client is refused by the trigger; and that the
 * per-client totals separate the client's money from the agency's own cost, which is
 * the distinction §D exists to make.
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
let service: typeof import("../src/lib/agency-reimbursable-cost-service");

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
  databaseName = `agency_cost_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/agency-reimbursable-cost-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 240_000);

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

interface Agency {
  businessId: string;
  clientId: string;
  projectId: string;
  /**
   * The provisioned owner, and it has to be a real `users` row: `domain_events.created_by`
   * is a foreign key, so an invented actor id fails at the event rather than at the
   * register — which is the right behaviour and a reminder that a posted document is
   * attributed to a member, not to a placeholder.
   */
  actor: { userId: string; name: string };
}

async function agency(label = ""): Promise<Agency> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس هزینه ${seq} ${label}`,
    ownerName: "مالک",
    email: `agency-cost-${seq}-${randomUUID().slice(0, 6)}@example.test`,
    password: "correct-horse",
    subdomain: `agcost${seq}${randomUUID().slice(0, 4)}`,
    industry: "advertising_agency",
    seedChartOfAccounts: true,
  });
  const actor = { userId: result.userId, name: "مالک" };
  const clientId = await seedParty(result.businessId, "کارفرما");
  const projectId = (
    await db.query(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1,'پروژهٔ کمپین',$2) RETURNING id`,
      [result.businessId, actor.userId],
    )
  ).rows[0].id;
  return { businessId: result.businessId, clientId, projectId, actor };
}

async function seedParty(businessId: string, name: string): Promise<string> {
  return (
    await db.query(`INSERT INTO parties (business_id, name) VALUES ($1,$2) RETURNING id`, [
      businessId,
      name,
    ])
  ).rows[0].id;
}

/** The entry a cost posted, as its lines with account codes — the ledger's own view. */
async function entryLines(entryId: string) {
  const { rows } = await db.query(
    `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit,
            e.entry_date::text AS entry_date, e.project_id
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id AND a.business_id = e.business_id
      WHERE e.id = $1
      ORDER BY a.code`,
    [entryId],
  );
  return rows as { code: string; debit: string; credit: string; entry_date: string; project_id: string | null }[];
}

async function refuse(thunk: () => Promise<unknown>): Promise<string> {
  try {
    await thunk();
    return "succeeded";
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return `${err.code ?? ""}:${err.message ?? ""}`;
  }
}

/* --------------------------------------------------------------------- tests */

describe("a reimbursable client cost (issue #1128 §D, migration 0280)", () => {
  it("numbers costs RC- per agency and defaults to the honest presentation", async () => {
    const a = await agency();
    const first = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId,
      description: "خرید فضای تبلیغاتی",
      amountRial: 5_000_000,
      spentOn: "2026-11-01",
    });
    const second = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId,
      description: "چاپ بنر",
      amountRial: 1_000_000,
      spentOn: "2026-11-02",
    });

    // The shared formatter pads to three digits — the same reason a campaign is
    // `CA-001` and not `CA-0001`.
    expect(first.costNumber).toBe("RC-001");
    expect(second.costNumber).toBe("RC-002");
    expect(first.presentation).toBe("net");
    expect(first.settledBy).toBe("payable");
    expect(first.clientName).toBe("کارفرما");
  }, 120_000);

  it("posts to 1270 — the account eight waves could not reach", async () => {
    const a = await agency();
    const cost = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId,
      projectId: a.projectId,
      vendorName: "پلتفرم تبلیغات",
      description: "خرید فضای تبلیغاتی آبان",
      amountRial: 5_000_000,
      spentOn: "2026-11-01",
      presentation: "net",
      settledBy: "payable",
    });

    expect(cost.posted).toBe(true);
    expect(cost.entryId).not.toBeNull();
    expect(cost.passThrough).toBe(true);
    expect(cost.accounts).toEqual({ debitCode: "1270", creditCode: "2140" });

    const lines = await entryLines(cost.entryId!);
    expect(lines).toHaveLength(2);
    const debit = lines.find((line) => Number(line.debit) > 0);
    const credit = lines.find((line) => Number(line.credit) > 0);
    expect(debit?.code).toBe("1270");
    expect(Number(debit?.debit)).toBe(5_000_000);
    expect(credit?.code).toBe("2140");
    expect(Number(credit?.credit)).toBe(5_000_000);
    // The entry is dated the day the money was spent, not the day it was recorded,
    // and carries the project so §D's P&L reads it from the books.
    expect(debit?.entry_date).toBe("2026-11-01");
    expect(debit?.project_id).toBe(a.projectId);
  }, 120_000);

  it("posts to 5197 on gross, and leaves 1270 alone", async () => {
    const a = await agency();
    const cost = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId,
      description: "خرید رسانه — به نام آژانس",
      amountRial: 3_000_000,
      spentOn: "2026-11-03",
      presentation: "gross",
      settledBy: "bank",
    });

    expect(cost.passThrough).toBe(false);
    expect(cost.accounts).toEqual({ debitCode: "5197", creditCode: "1120" });
    const lines = await entryLines(cost.entryId!);
    expect(lines.find((line) => Number(line.debit) > 0)?.code).toBe("5197");
    expect(lines.find((line) => Number(line.credit) > 0)?.code).toBe("1120");

    // The two presentations are different accounting statements about the same spend,
    // and the ledger has to be able to tell them apart: nothing this agency recorded
    // as its own cost may sit in the client's claim.
    const balance = await db.query(
      `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS net
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.business_id = $1 AND a.code = '1270'`,
      [a.businessId],
    );
    expect(Number(balance.rows[0].net)).toBe(0);
  }, 120_000);

  it("credits cash, bank clearing or the media payable by how it was settled", async () => {
    const a = await agency();
    const expected: Record<string, string> = { cash: "1100", bank: "1120", payable: "2140" };
    let n = 0;
    for (const settledBy of ["cash", "bank", "payable"] as const) {
      n += 1;
      const cost = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
        partyId: a.clientId,
        description: `هزینهٔ ${n}`,
        amountRial: 1000 * n,
        spentOn: "2026-11-04",
        settledBy,
      });
      const lines = await entryLines(cost.entryId!);
      expect(lines.find((line) => Number(line.credit) > 0)?.code, settledBy).toBe(expected[settledBy]);
    }
  }, 120_000);

  it("refuses the unusable in words, before anything reaches the ledger", async () => {
    const a = await agency();
    const make = (over: Record<string, unknown>) => () =>
      service.createAgencyReimbursableCost(a.businessId, a.actor, {
        partyId: a.clientId,
        description: "خرید",
        amountRial: 1000,
        spentOn: "2026-11-05",
        ...over,
      });

    expect(await refuse(make({ partyId: "" }))).toContain("client_required");
    expect(await refuse(make({ description: "   " }))).toContain("description_required");
    expect(await refuse(make({ amountRial: undefined }))).toContain("amount_required");
    // A member who typed 1000.5 needs to hear the figure is unusable, not missing.
    expect(await refuse(make({ amountRial: 1000.5 }))).toContain("invalid_amount");
    expect(await refuse(make({ amountRial: 0 }))).toContain("invalid_amount");
    expect(await refuse(make({ spentOn: undefined }))).toContain("date_required");
    // `isValidIsoDate` is calendar-aware about days but shape-based about the year,
    // so a Jalali date passes it and the bound is what refuses it.
    expect(await refuse(make({ spentOn: "1406-03-01" }))).toContain("invalid_date");
    expect(await refuse(make({ spentOn: "2027-02-30" }))).toContain("invalid_date");
    expect(await refuse(make({ presentation: "hybrid" }))).toContain("invalid_presentation");
    expect(await refuse(make({ settledBy: "barter" }))).toContain("invalid_settlement");

    // And nothing was written for any of them: a refusal that leaves a half-row would
    // be a claim on a client the books do not know about.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM agency_reimbursable_costs WHERE business_id = $1`,
      [a.businessId],
    );
    expect(Number(rows[0].n)).toBe(0);
  }, 120_000);

  it("refuses a trade that has no reimbursable client cost, rather than defaulting one", async () => {
    seq += 1;
    const cafe = await provisioning.provisionBusiness({
      businessName: `کافه ${seq}`,
      ownerName: "مالک",
      email: `cafe-cost-${seq}@example.test`,
      password: "correct-horse",
      subdomain: `cafecost${seq}`,
      industry: "food_service",
      seedChartOfAccounts: true,
    });
    const client = await seedParty(cafe.businessId, "مشتری");
    expect(
      await refuse(() =>
        service.createAgencyReimbursableCost(cafe.businessId, { userId: cafe.userId, name: "مالک" }, {
          partyId: client,
          description: "خرید",
          amountRial: 1000,
          spentOn: "2026-11-06",
        }),
      ),
    ).toContain("not_agency");
  }, 120_000);

  it("freezes a posted cost from the service and from a raw UPDATE that skips it", async () => {
    const a = await agency();
    const cost = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId,
      projectId: a.projectId,
      description: "خرید فضای تبلیغاتی",
      amountRial: 2_000_000,
      spentOn: "2026-11-07",
    });
    expect(cost.posted).toBe(true);

    expect(
      await refuse(() => service.updateAgencyReimbursableCost(a.businessId, cost.id, a.actor, { amountRial: 1 })),
    ).toContain("cost_posted");
    expect(
      await refuse(() => service.deleteAgencyReimbursableCost(a.businessId, cost.id)),
    ).toContain("cost_posted");

    // The service check exists so the member is told in words; the authority is 0280's
    // trigger inside the write, and this is what proves it holds without the service.
    const raw = await refuse(() =>
      db.query(`UPDATE agency_reimbursable_costs SET amount_rial = 1 WHERE id = $1`, [cost.id]),
    );
    expect(raw).toContain("23514");
    expect(raw).toContain("frozen");

    // The note stays open, because what a member learned afterwards desyncs nothing.
    const noted = await service.updateAgencyReimbursableCost(a.businessId, cost.id, a.actor, {
      note: "کارفرما تأیید کرد",
    });
    expect(noted.note).toBe("کارفرما تأیید کرد");
    expect(noted.amountRial).toBe(2_000_000);
  }, 120_000);

  it("keeps an unposted row editable and deletable, because nothing is in the books yet", async () => {
    const a = await agency();
    // Written raw, because the service posts in the same transaction it creates in:
    // an unposted row is what a locked fiscal period leaves behind, not something a
    // member can ask for.
    const id = (
      await db.query(
        `INSERT INTO agency_reimbursable_costs
           (business_id, cost_number, party_id, description, amount_rial, spent_on)
         VALUES ($1,'RC-7001',$2,'هزینهٔ در صف',1000,'2026-11-08') RETURNING id`,
        [a.businessId, a.clientId],
      )
    ).rows[0].id;

    const edited = await service.updateAgencyReimbursableCost(a.businessId, id, a.actor, {
      amountRial: 2500,
      presentation: "gross",
    });
    expect(edited.amountRial).toBe(2500);
    expect(edited.presentation).toBe("gross");
    expect(edited.posted).toBe(false);

    // An empty patch is a no-op returning the row, not a not_found: a form that saved
    // without changing anything should say so by showing the row it has.
    const same = await service.updateAgencyReimbursableCost(a.businessId, id, a.actor, {});
    expect(same.id).toBe(id);

    await service.deleteAgencyReimbursableCost(a.businessId, id);
    expect(await service.loadAgencyReimbursableCost(a.businessId, id)).toBeNull();
  }, 120_000);

  it("changes one field without clearing the others", async () => {
    const a = await agency();
    const id = (
      await db.query(
        `INSERT INTO agency_reimbursable_costs
           (business_id, cost_number, party_id, project_id, vendor_name, description,
            amount_rial, spent_on, presentation, settled_by, note)
         VALUES ($1,'RC-7002',$2,$3,'پلتفرم','خرید فضا',5000,'2026-11-09','net','bank','یادداشت')
         RETURNING id`,
        [a.businessId, a.clientId, a.projectId],
      )
    ).rows[0].id;

    await service.updateAgencyReimbursableCost(a.businessId, id, a.actor, { description: "چاپ بنر" });
    const row = await service.loadAgencyReimbursableCost(a.businessId, id);
    expect(row?.description).toBe("چاپ بنر");
    // The bug this pins is the one 0276 documented: a normaliser that returns null for
    // an *absent* field turns "omitted" into "cleared", so renaming a cost would wipe
    // its vendor, its project and its settlement.
    expect(row?.vendorName).toBe("پلتفرم");
    expect(row?.projectId).toBe(a.projectId);
    expect(row?.settledBy).toBe("bank");
    expect(row?.note).toBe("یادداشت");
    expect(row?.amountRial).toBe(5000);
  }, 120_000);

  it("filters the list, and an unknown presentation filters nothing rather than matching nothing", async () => {
    const a = await agency();
    const second = await seedParty(a.businessId, "کارفرمای دوم");
    await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId, projectId: a.projectId, description: "رسانهٔ الف",
      amountRial: 1000, spentOn: "2026-11-10", presentation: "net",
    });
    await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: second, description: "رسانهٔ ب",
      amountRial: 2000, spentOn: "2026-11-11", presentation: "gross",
    });

    expect(await service.listAgencyReimbursableCosts(a.businessId)).toHaveLength(2);
    expect(
      await service.listAgencyReimbursableCosts(a.businessId, { partyId: a.clientId }),
    ).toHaveLength(1);
    expect(
      await service.listAgencyReimbursableCosts(a.businessId, { projectId: a.projectId }),
    ).toHaveLength(1);
    const net = await service.listAgencyReimbursableCosts(a.businessId, { presentation: "net" });
    expect(net).toHaveLength(1);
    expect(net[0].passThrough).toBe(true);
    expect(await service.listAgencyReimbursableCosts(a.businessId, { q: "رسانهٔ ب" })).toHaveLength(1);
    // A stale bookmark shows the list instead of an empty screen that reads as data loss.
    expect(await service.listAgencyReimbursableCosts(a.businessId, { presentation: "hybrid" })).toHaveLength(2);
    // Both rows posted in their own transactions, so nothing is in the queue.
    expect(await service.listAgencyReimbursableCosts(a.businessId, { posted: false })).toHaveLength(0);
    expect(await service.listAgencyReimbursableCosts(a.businessId, { posted: true })).toHaveLength(2);
  }, 120_000);

  it("separates the client's money from the agency's own cost, per client", async () => {
    const a = await agency();
    const second = await seedParty(a.businessId, "کارفرمای دوم");
    await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId, description: "رسانهٔ خالص", amountRial: 5_000_000,
      spentOn: "2026-11-12", presentation: "net",
    });
    await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId, description: "رسانهٔ ناخالص", amountRial: 2_000_000,
      spentOn: "2026-11-12", presentation: "gross",
    });
    await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: second, description: "دیگری", amountRial: 900_000,
      spentOn: "2026-11-12", presentation: "net",
    });

    const totals = await service.sumCostsByParty(a.businessId, [a.clientId, second]);
    expect(totals.get(a.clientId)).toEqual({ total: 7_000_000, passThrough: 5_000_000, unposted: 0 });
    expect(totals.get(second)).toEqual({ total: 900_000, passThrough: 900_000, unposted: 0 });
    // A party with nothing recorded is absent rather than zero-filled, so a caller
    // cannot mistake "no costs" for "not asked about".
    const empty = await service.sumCostsByParty(a.businessId, [randomUUID()]);
    expect(empty.size).toBe(0);
    expect((await service.sumCostsByParty(a.businessId, [])).size).toBe(0);
  }, 120_000);

  it("keeps one tenant's costs out of another's every which way", async () => {
    const a = await agency();
    const b = await agency("دوم");
    const cost = await service.createAgencyReimbursableCost(a.businessId, a.actor, {
      partyId: a.clientId, description: "رسانهٔ محرمانه", amountRial: 1000, spentOn: "2026-11-13",
    });

    expect(await service.loadAgencyReimbursableCost(b.businessId, cost.id)).toBeNull();
    expect(await service.listAgencyReimbursableCosts(b.businessId)).toHaveLength(0);
    expect(
      await refuse(() => service.updateAgencyReimbursableCost(b.businessId, cost.id, a.actor, { note: "x" })),
    ).toContain("cost_not_found");
    expect(
      await refuse(() => service.deleteAgencyReimbursableCost(b.businessId, cost.id)),
    ).toContain("cost_not_found");
    expect((await service.sumCostsByParty(b.businessId, [a.clientId])).size).toBe(0);

    // A foreign client is the trigger's, not the service's: the FK proves a party
    // exists and only 0280 proves it is this tenant's.
    const foreignPartyRefusal = await refuse(() =>
      db.query(
        `INSERT INTO agency_reimbursable_costs
           (business_id, cost_number, party_id, description, amount_rial, spent_on)
         VALUES ($1,'RC-7003',$2,'بیگانه',1000,'2026-11-13')`,
        [b.businessId, a.clientId],
      ),
    );
    expect(foreignPartyRefusal).toContain("23514");
    expect(foreignPartyRefusal).toContain("does not belong to this business");
  }, 120_000);
});
