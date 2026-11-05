/**
 * §D's business-level presentation policy, against a real database (issue #1128).
 *
 * §D requires that gross versus net "must follow chosen business accounting policy and
 * must not be inferred solely from spend". Wave 10 stored the choice per row; this is
 * where a business states it once.
 *
 * The assertion that matters is the third one: that choosing `gross` makes the *next*
 * cost debit **5197** instead of **1270**. A policy that only changed what a screen
 * displayed would pass every other test in this file, and would be worth nothing — the
 * choice is a posting, so it has to be proven at the posting.
 *
 * The other half of the file is what the policy must *not* do: reach backwards. A cost
 * recorded before the change keeps its treatment and its entry line for line, because
 * 0280's trigger freezes `presentation` once the entry has landed and the register may
 * not contradict the ledger.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Industry } from "../src/lib/industries";

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
  databaseName = `agency_policy_${randomUUID().replaceAll("-", "")}`;

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
  locationId: string;
  clientId: string;
  actor: { userId: string; name: string };
}

async function agency(label = "", industry: Industry = "advertising_agency"): Promise<Agency> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `آژانس سیاست ${seq} ${label}`,
    ownerName: "حسابدار",
    email: `agency-policy-${seq}-${randomUUID().slice(0, 6)}@example.test`,
    password: "correct-horse",
    subdomain: `agpol${seq}${randomUUID().slice(0, 4)}`,
    industry,
    seedChartOfAccounts: true,
  });
  const actor = { userId: result.userId, name: "حسابدار" };
  const clientId = (
    await db.query(`INSERT INTO parties (business_id, name) VALUES ($1,'کارفرما') RETURNING id`, [
      result.businessId,
    ])
  ).rows[0].id;
  return {
    businessId: result.businessId,
    locationId: result.locationId,
    clientId,
    actor,
  };
}

async function record(a: Agency, over: Record<string, unknown> = {}) {
  return service.createAgencyReimbursableCost(a.businessId, a.actor, {
    partyId: a.clientId,
    description: "خرید فضای تبلیغاتی",
    amountRial: 1_000_000,
    spentOn: "2026-11-01",
    settledBy: "payable",
    ...over,
  });
}

/** The account codes a cost's entry actually used, read from the ledger. */
async function postedAccounts(entryId: string): Promise<{ debits: string[]; credits: string[] }> {
  const { rows } = await db.query(
    `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1
      ORDER BY a.code`,
    [entryId],
  );
  return {
    debits: rows.filter((r) => Number(r.debit) > 0).map((r) => r.code),
    credits: rows.filter((r) => Number(r.credit) > 0).map((r) => r.code),
  };
}

/** Every line of an entry, as text, for comparing before and after a policy change. */
async function entryFingerprint(entryId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT a.code, l.debit::text AS debit, l.credit::text AS credit, e.entry_date::text AS entry_date, e.memo
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.entry_id = $1
      ORDER BY a.code, l.debit::text`,
    [entryId],
  );
  return JSON.stringify(rows);
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

describe("§D's business-level presentation policy (issue #1128)", () => {
  it("reports «not chosen» rather than dressing the fallback up as a decision", async () => {
    const a = await agency();
    const policy = await service.loadAgencyCostPolicy(a.businessId);

    // `stored: false` is the whole point of the shape: a screen can now say the
    // business has not adopted a policy, instead of showing `net` as though somebody
    // had picked it. The fallback still answers, because a row has to post somewhere.
    expect(policy).toEqual({ presentation: "net", stored: false, updatedAt: null });

    const cost = await record(a);
    expect(cost.presentation).toBe("net");
    expect((await postedAccounts(cost.entryId!)).debits).toContain("1270");
  }, 180_000);

  it("stores the choice, and writes who changed it from what to what", async () => {
    const a = await agency();
    const saved = await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "gross" },
    );

    expect(saved.presentation).toBe("gross");
    expect(saved.stored).toBe(true);
    expect(typeof saved.updatedAt).toBe("string");

    // Read back through the same door a screen uses.
    expect(await service.loadAgencyCostPolicy(a.businessId)).toEqual(saved);

    const audit = (
      await db.query(
        `SELECT action, entity, entity_id, user_id, payload FROM audit_log
          WHERE business_id = $1 AND action = 'settings.agency_cost_policy.update'`,
        [a.businessId],
      )
    ).rows[0];
    expect(audit).toBeDefined();
    expect(audit.entity).toBe("settings");
    expect(audit.entity_id).toBe("agency.cost_policy");
    expect(audit.user_id).toBe(a.actor.userId);
    // The payload is what makes the audit row worth having: not just that it changed.
    expect(audit.payload.before).toEqual({ presentation: "net", stored: false });
    expect(audit.payload.after).toEqual({ presentation: "gross", updatedAt: saved.updatedAt });
  }, 180_000);

  it("changes which account the next cost lands in — the policy is a posting, not a label", async () => {
    const a = await agency();
    await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "gross" },
    );

    const cost = await record(a);
    expect(cost.presentation).toBe("gross");

    const accounts = await postedAccounts(cost.entryId!);
    // The agency's own cost of sale, and *not* a claim on the client.
    expect(accounts.debits).toContain("5197");
    expect(accounts.debits).not.toContain("1270");

    // And back again, so the assertion is about the policy rather than about a default
    // that happened to be gross.
    await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "net" },
    );
    const second = await record(a, { description: "چاپ بنر" });
    expect(second.presentation).toBe("net");
    expect((await postedAccounts(second.entryId!)).debits).toContain("1270");
  }, 180_000);

  it("is a default and never a mandate: an explicit choice on the row wins", async () => {
    const a = await agency();
    await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "gross" },
    );

    // §D's treatment varies by contract, so a business that mostly buys media in its
    // own name still has clients whose money it is merely handling.
    const cost = await record(a, { presentation: "net" });
    expect(cost.presentation).toBe("net");
    expect((await postedAccounts(cost.entryId!)).debits).toContain("1270");
  }, 180_000);

  it("never reaches backwards into costs already in the ledger", async () => {
    const a = await agency();
    const before = await record(a);
    expect(before.presentation).toBe("net");
    const fingerprint = await entryFingerprint(before.entryId!);

    await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "gross" },
    );

    const after = await service.loadAgencyReimbursableCost(a.businessId, before.id);
    expect(after?.presentation).toBe("net");
    // The entry is unchanged line for line, not merely the row: the register must not
    // contradict the ledger, and a policy that silently re-posted history would.
    expect(await entryFingerprint(before.entryId!)).toBe(fingerprint);

    // And the database refuses the change directly, which is why the policy can only
    // ever be a default for new rows.
    expect(
      await refuse(() =>
        db.query(`UPDATE agency_reimbursable_costs SET presentation = 'gross' WHERE id = $1`, [before.id]),
      ),
    ).toContain("frozen");
  }, 180_000);

  it("still refuses a presentation it does not know instead of substituting the policy", async () => {
    const a = await agency();
    await service.saveAgencyCostPolicy(
      { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId },
      { presentation: "gross" },
    );

    // A typo must not quietly become the policy's value: that would change which
    // account the money lands in because of a keystroke nobody meant.
    expect(await refuse(() => record(a, { presentation: "netish" }))).toContain("invalid_presentation");
    expect(await refuse(() => record(a, { presentation: 3 }))).toContain("invalid_presentation");
  }, 180_000);

  it("refuses a save that is not a policy", async () => {
    const a = await agency();
    const actor = { businessId: a.businessId, locationId: a.locationId, userId: a.actor.userId };

    expect(await refuse(() => service.saveAgencyCostPolicy(actor, { presentation: "grossish" }))).toContain(
      "invalid_presentation",
    );
    expect(await refuse(() => service.saveAgencyCostPolicy(actor, null))).toContain("invalid_presentation");
    expect(await refuse(() => service.saveAgencyCostPolicy(actor, [1]))).toContain("invalid_presentation");
    // An unknown key means a body written against a newer contract; storing half of it
    // would silently drop the half that mattered.
    expect(
      await refuse(() => service.saveAgencyCostPolicy(actor, { presentation: "gross", retroactive: true })),
    ).toContain("invalid_presentation");

    // Nothing was stored by any of them.
    expect(await service.loadAgencyCostPolicy(a.businessId)).toEqual({
      presentation: "net",
      stored: false,
      updatedAt: null,
    });
  }, 180_000);

  it("keeps a policy to the trade that has reimbursable client costs", async () => {
    const cafe = await agency("کافه", "food_service");

    // A café has no pass-through to present, so it is refused rather than defaulted —
    // serving it the agency default would let an F&B tenant read configuration it can
    // never use.
    expect(await refuse(() => service.loadAgencyCostPolicy(cafe.businessId))).toContain("not_agency");
    expect(
      await refuse(() =>
        service.saveAgencyCostPolicy(
          { businessId: cafe.businessId, locationId: cafe.locationId, userId: cafe.actor.userId },
          { presentation: "gross" },
        ),
      ),
    ).toContain("not_agency");

    // And one agency's policy is not another's.
    const one = await agency();
    const two = await agency("دوم");
    await service.saveAgencyCostPolicy(
      { businessId: one.businessId, locationId: one.locationId, userId: one.actor.userId },
      { presentation: "gross" },
    );
    expect(await service.loadAgencyCostPolicy(two.businessId)).toEqual({
      presentation: "net",
      stored: false,
      updatedAt: null,
    });
    expect((await record(two)).presentation).toBe("net");
  }, 180_000);
});
