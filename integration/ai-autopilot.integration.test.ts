/**
 * Phase 31 exit criteria, against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves the two new tables
 * carry RLS like every other tenant table. This file proves the behaviour the
 * feature exists for, and the two boundaries it must never cross:
 *
 *   - an in-cap proposal is actually applied, with the prior state captured so
 *     it can be undone;
 *   - an over-cap or disabled-category proposal changes nothing and stays a
 *     clickable manual proposal (never dropped, never forced through);
 *   - a journal draft under autopilot lands in the approval queue and posts
 *     NOTHING to the ledger (Decision 1);
 *   - an owner cannot configure a cap above the server's hard ceiling.
 *
 * The provider round-trip is deliberately not exercised: the proposal is
 * synthesised and handed to applyOrDeferProposal, which is the whole
 * safety-critical half. What is being proven is the gate, not the fetch.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let autopilot: typeof import("../src/lib/ai-autopilot-service");
let executors: typeof import("../src/lib/ai-autopilot-executors");

const alpha = { businessId: "", locationId: "", userId: "", menuItemId: "", customerId: "" };
const beta = { businessId: "", locationId: "", userId: "", menuItemId: "", customerId: "" };

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
  databaseName = `pos_ai_autopilot_${randomUUID().replaceAll("-", "")}`;

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
  autopilot = await import("../src/lib/ai-autopilot-service");
  executors = await import("../src/lib/ai-autopilot-executors");

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

async function seedBusiness(name: string, slug: string) {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = locRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner ' || $2, $3, 'x') RETURNING id`,
    [businessId, slug, `owner-${slug}@example.test`],
  );

  const catRow = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
    [locationId],
  );
  const itemRow = await db.query<{ id: string }>(
    `INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Espresso', 100000)
     RETURNING id`,
    [locationId, catRow.rows[0].id],
  );

  const customerRow = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, notes) VALUES ($1, 'Guest', 'یادداشت قبلی') RETURNING id`,
    [businessId],
  );

  return {
    businessId,
    locationId,
    userId: userRow.rows[0].id,
    menuItemId: itemRow.rows[0].id,
    customerId: customerRow.rows[0].id,
  };
}

beforeEach(async () => {
  await db.query("DELETE FROM ai_action_audit");
  await db.query("DELETE FROM ai_autopilot_settings");
  // Draft lines reference accounts, which businesses does not cascade through.
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`));
  Object.assign(beta, await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`));
});

/** Enables one category for a business with explicit caps. */
async function enable(
  target: typeof alpha,
  category: Parameters<typeof autopilot.setAutopilotCategory>[1],
  caps: Partial<{ maxAmountRial: number | null; maxPercent: number | null; maxItemsPerRun: number; dailyActionLimit: number }> = {},
) {
  return dbLib.withTenant(target.businessId, () =>
    autopilot.setAutopilotCategory(target.businessId, category, { enabled: true, ...caps }, target.userId),
  );
}

function priceProposal(menuItemId: string, price: number) {
  return {
    type: "menu.item.priceUpdate" as const,
    title: "تغییر قیمت",
    summary: "",
    payload: { menuItemId, price },
  };
}

async function decide(target: typeof alpha, category: "pricing" | "money" | "customer", proposal: ReturnType<typeof priceProposal> | { type: never; title: string; summary: string; payload: Record<string, unknown> }) {
  return dbLib.withTenant(target.businessId, async () => {
    const settings = await autopilot.getAutopilotSettings(target.businessId);
    return autopilot.applyOrDeferProposal({
      businessId: target.businessId,
      category,
      setting: settings[category],
      proposal: proposal as ReturnType<typeof priceProposal>,
      authorizedBy: target.userId,
    });
  });
}

async function priceOf(menuItemId: string): Promise<number> {
  const { rows } = await db.query<{ price: string }>("SELECT price::text AS price FROM menu_items WHERE id = $1", [
    menuItemId,
  ]);
  return Number(rows[0].price);
}

describe("an enabled category applies an in-cap proposal", () => {
  it("changes the price, audits it as autopilot, and captures the prior value for undo", async () => {
    await enable(alpha, "pricing", { maxPercent: 10, maxAmountRial: 1_000_000 });

    const decision = await decide(alpha, "pricing", priceProposal(alpha.menuItemId, 105_000));
    expect(decision.outcome).toBe("applied");
    expect(await priceOf(alpha.menuItemId)).toBe(105_000);

    const { rows } = await db.query<{ status: string; source: string; category: string; prior_state: { price: number } }>(
      `SELECT status, source, autopilot_category AS category, prior_state
         FROM ai_action_audit WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", source: "autopilot", category: "pricing" });
    // proposal_payload only ever holds the NEW value; only prior_state can answer
    // "what was the price before", which is what makes undo possible at all.
    expect(rows[0].prior_state.price).toBe(100_000);
  });
});

describe("an over-cap proposal is held, never applied and never dropped", () => {
  it("leaves the price untouched and keeps the proposal clickable with a reason", async () => {
    await enable(alpha, "pricing", { maxPercent: 10, maxAmountRial: 1_000_000 });

    const decision = await decide(alpha, "pricing", priceProposal(alpha.menuItemId, 400_000));
    expect(decision).toMatchObject({ outcome: "deferred", reasonCode: "price_change_too_large" });
    expect(await priceOf(alpha.menuItemId)).toBe(100_000);

    const { rows } = await db.query<{ status: string; deferred_reason: string }>(
      `SELECT status, deferred_reason FROM ai_action_audit WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows[0]).toEqual({ status: "proposed", deferred_reason: "price_change_too_large" });
  });

  it("holds a proposal for a category that is switched off", async () => {
    // No settings row at all — the missing-row default, which must read as off.
    const decision = await decide(alpha, "pricing", priceProposal(alpha.menuItemId, 101_000));
    expect(decision).toMatchObject({ outcome: "deferred", reasonCode: "category_disabled" });
    expect(await priceOf(alpha.menuItemId)).toBe(100_000);
  });
});

describe("tenant isolation", () => {
  it("keeps one business's settings and autopilot history invisible to another", async () => {
    await enable(alpha, "pricing", { maxPercent: 10 });
    await decide(alpha, "pricing", priceProposal(alpha.menuItemId, 105_000));

    const betaSettings = await dbLib.withTenant(beta.businessId, () =>
      autopilot.getAutopilotSettings(beta.businessId),
    );
    expect(betaSettings.pricing.enabled).toBe(false);

    const betaActivity = await dbLib.withTenant(beta.businessId, () =>
      autopilot.listAutopilotActivity(beta.businessId),
    );
    expect(betaActivity.entries).toEqual([]);
  });

  it("does not apply Beta's identical proposal while only Alpha has the category on", async () => {
    await enable(alpha, "pricing", { maxPercent: 10 });

    const decision = await decide(beta, "pricing", priceProposal(beta.menuItemId, 105_000));
    expect(decision).toMatchObject({ outcome: "deferred", reasonCode: "category_disabled" });
    expect(await priceOf(beta.menuItemId)).toBe(100_000);
  });
});

describe("undo", () => {
  it("restores the exact prior price and is a no-op the second time", async () => {
    await enable(alpha, "pricing", { maxPercent: 10 });
    const decision = await decide(alpha, "pricing", priceProposal(alpha.menuItemId, 105_000));
    expect(decision.outcome).toBe("applied");

    const first = await dbLib.withTenant(alpha.businessId, () =>
      autopilot.revertAutopilotAction({ businessId: alpha.businessId, auditId: decision.auditId, actorName: "مالک" }),
    );
    expect(first).toEqual({ ok: true });
    expect(await priceOf(alpha.menuItemId)).toBe(100_000);

    const { rows } = await db.query<{ status: string; reverted_at: string | null }>(
      `SELECT status, reverted_at FROM ai_action_audit WHERE id = $1`,
      [decision.auditId],
    );
    expect(rows[0].status).toBe("reverted");
    expect(rows[0].reverted_at).not.toBeNull();

    // The `AND status = 'applied'` predicate is what makes this idempotent.
    const second = await dbLib.withTenant(alpha.businessId, () =>
      autopilot.revertAutopilotAction({ businessId: alpha.businessId, auditId: decision.auditId, actorName: "مالک" }),
    );
    expect(second).toEqual({ ok: false, error: "not_revertible_status" });
    expect(await priceOf(alpha.menuItemId)).toBe(100_000);
  });

  it("restores a customer's previous note", async () => {
    await enable(alpha, "customer");
    const decision = await decide(alpha, "customer", {
      type: "customer.note.add",
      title: "یادداشت",
      summary: "",
      payload: { customerId: alpha.customerId, notes: "یادداشت جدید" },
    } as never);
    expect(decision.outcome).toBe("applied");

    const afterApply = await db.query<{ notes: string }>("SELECT notes FROM parties WHERE id = $1", [
      alpha.customerId,
    ]);
    expect(afterApply.rows[0].notes).toBe("یادداشت جدید");

    await dbLib.withTenant(alpha.businessId, () =>
      autopilot.revertAutopilotAction({ businessId: alpha.businessId, auditId: decision.auditId, actorName: "مالک" }),
    );
    const afterRevert = await db.query<{ notes: string }>("SELECT notes FROM parties WHERE id = $1", [
      alpha.customerId,
    ]);
    expect(afterRevert.rows[0].notes).toBe("یادداشت قبلی");
  });
});

describe("Decision 1 — a journal entry is only ever drafted, never posted", () => {
  it("creates a draft in the approval queue and leaves journal_entries byte-identical", async () => {
    const accounts = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5300', 'Supplies', 'expense')
       RETURNING id, code`,
      [alpha.businessId],
    );
    const cash = accounts.rows.find((r) => r.code === "1100")!.id;
    const supplies = accounts.rows.find((r) => r.code === "5300")!.id;

    await enable(alpha, "money", { maxAmountRial: 5_000_000, maxPercent: 10, maxItemsPerRun: 5 });

    const entriesBefore = await db.query("SELECT * FROM journal_entries WHERE business_id = $1", [alpha.businessId]);

    const decision = await decide(alpha, "money", {
      type: "journal.manual.propose",
      title: "سند",
      summary: "",
      payload: {
        memo: "خرید ملزومات",
        lines: [
          { accountId: supplies, debit: 500_000, credit: 0 },
          { accountId: cash, debit: 0, credit: 500_000 },
        ],
      },
    } as never);
    expect(decision.outcome).toBe("applied");

    const drafts = await db.query("SELECT id FROM journal_entry_drafts WHERE business_id = $1", [alpha.businessId]);
    expect(drafts.rows).toHaveLength(1);

    // The whole point of Decision 1: the ledger is untouched until a human
    // approves the draft through Phase 16's own, separately-guarded route.
    const entriesAfter = await db.query("SELECT * FROM journal_entries WHERE business_id = $1", [alpha.businessId]);
    expect(entriesAfter.rows).toEqual(entriesBefore.rows);
    expect(entriesAfter.rows).toHaveLength(0);
  });
});

describe("caps cannot be configured above the server's ceiling", () => {
  it("clamps an over-ceiling value on save", async () => {
    const saved = await enable(alpha, "pricing", { maxPercent: 90, maxAmountRial: 999_000_000 });
    expect(saved.maxPercent).toBe(15);
    expect(saved.maxAmountRial).toBe(5_000_000);

    const readBack = await dbLib.withTenant(alpha.businessId, () =>
      autopilot.getAutopilotSettings(alpha.businessId),
    );
    expect(readBack.pricing.maxPercent).toBe(15);
  });

  it("refuses an over-ceiling value written straight to the table", async () => {
    await expect(
      db.query(
        `INSERT INTO ai_autopilot_settings (business_id, category, enabled, max_percent)
         VALUES ($1, 'pricing', true, 90)`,
        [alpha.businessId],
      ),
    ).rejects.toThrow(/max_percent/);
  });
});

/*
 * The expense action's own answers, with a real ledger behind them (issue #832
 * §15: one rule per business act, whichever door it comes through).
 *
 * Two things the pipeline above cannot decide for it. Which *branch* a row
 * belongs to: the executor read «oldest active branch» out of a private copy of
 * that query and passed it to `recordExpense` whatever the model had been told, so
 * «اجارهٔ شعبهٔ شمال» was filed against Main and the number and the date were both
 * right — a request and a ledger disagreeing quietly, which is the failure this
 * whole issue is about. And what to call a chart with no Accounts Payable
 * account: the route answers `ledger_account_missing`, while the action reported
 * the bare account code as its own failure reason.
 *
 * The amount moved to the channel's shared parser in the same change, so a Toman
 * figure whose ×10 landed on a float artefact is read as the Rial it is, and a
 * fraction is refused instead of shortened.
 */
describe("the expense action's branch, amount and account answers", () => {
  const cash = { accountId: "", rentId: "", branchId: "", supplierId: "" };

  /*
   * This suite posts, so it leaves ledger rows behind — and `accounts` is pinned to
   * `journal_lines` by a foreign key, which the file's own `DELETE FROM businesses`
   * cannot cascade past. Clearing the write first is what keeps the next test's
   * fixture reset from erroring out — which is why it is an `afterEach`: the file's
   * own reset for the next test runs before anything this describe sets up.
   */
  afterEach(async () => {
    await db.query("DELETE FROM journal_lines");
    await db.query("DELETE FROM journal_entries");
    await db.query("DELETE FROM expenses");
    await db.query("DELETE FROM expense_reference_counters");
  });

  async function seedLedger() {
    const { rows } = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5300', 'Rent', 'expense')
       RETURNING id, code`,
      [alpha.businessId],
    );
    cash.accountId = rows.find((r) => r.code === "1100")!.id;
    cash.rentId = rows.find((r) => r.code === "5300")!.id;
    const { rows: branches } = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ شمال') RETURNING id`,
      [alpha.businessId],
    );
    cash.branchId = branches[0].id;
    const { rows: suppliers } = await db.query<{ id: string }>(
      `INSERT INTO suppliers (location_id, name) VALUES ($1, 'Acme') RETURNING id`,
      [alpha.locationId],
    );
    cash.supplierId = suppliers[0].id;
  }

  function payload(over: Record<string, unknown> = {}) {
    return {
      accountId: cash.rentId,
      paymentAccountId: cash.accountId,
      amount: 1_200_000,
      memo: "اجارهٔ فروردین",
      expenseDate: "2026-04-01",
      ...over,
    };
  }

  async function runExpense(over: Record<string, unknown> = {}) {
    return dbLib.withTenant(alpha.businessId, () =>
      executors.AUTOPILOT_EXECUTORS.expense({
        businessId: alpha.businessId,
        authorizedByUserId: alpha.userId,
        payload: payload(over),
      }),
    );
  }

  async function storedRows() {
    const { rows } = await db.query<{ id: string; location_id: string; amount: string; vat_amount: string }>(
      `SELECT id, location_id, amount::text, vat_amount::text FROM expenses WHERE business_id = $1 ORDER BY created_at`,
      [alpha.businessId],
    );
    return rows;
  }

  it("files the expense at the branch the request named — by id or by name", async () => {
    await seedLedger();

    const byName = await runExpense({ locationId: "شعبه شمال" });
    expect(byName.ok).toBe(true);
    // The comparison is the branch form's own uniqueness key, so the ZWNJ an
    // Iranian typist leaves in the middle of «شعبهٔ» is not a different branch.
    expect((await storedRows())[0].location_id).toBe(cash.branchId);

    const byId = await runExpense({ locationId: cash.branchId, memo: "اجارهٔ اردیبهشت" });
    expect(byId.ok).toBe(true);
    expect((await storedRows())[1].location_id).toBe(cash.branchId);
  });

  it("keeps the business's default branch when nothing was named", async () => {
    await seedLedger();
    expect((await runExpense()).ok).toBe(true);
    expect((await storedRows())[0].location_id).toBe(alpha.locationId);
  });

  it("refuses another business's branch, and a name two branches share", async () => {
    await seedLedger();
    // Beta's id is a well-formed uuid of a real row in `locations`. The action is
    // not told that the branch exists elsewhere; it is told it is not one of
    // *this* business's, which is the only answer tenant isolation can give.
    const foreign = await runExpense({ locationId: beta.locationId });
    expect(foreign).toMatchObject({ ok: false, errorCode: "invalid_location" });

    // A second branch answering to the same name. `createBranch` would refuse it;
    // an owner can still get there by renaming one, and the action must then ask
    // rather than pick a branch for a posting.
    await db.query(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ شمال')`,
      [alpha.businessId],
    );
    const ambiguous = await runExpense({ locationId: "شعبه شمال" });
    expect(ambiguous).toMatchObject({ ok: false, errorCode: "ambiguous_location" });
    expect(await storedRows()).toEqual([]);
  });

  it("refuses a fractional amount and accepts a Toman figure's float residue", async () => {
    await seedLedger();
    const fraction = await runExpense({ amount: 1_500.75 });
    expect(fraction).toMatchObject({ ok: false });
    expect(await storedRows()).toEqual([]);

    expect((await runExpense({ amount: 1507.0000000000002, memo: "قبوض" })).ok).toBe(true);
    expect((await storedRows())[0].amount).toBe("1507");
  });

  it("names a missing Accounts Payable account as the account that is missing", async () => {
    // Alpha's chart above has no 2100 at all: the owed branch of `recordExpense`
    // needs it to credit, and it says so with `MissingLedgerAccountError` — which
    // is not an `ExpenseError`, so it used to fall through to the generic catch
    // and reach the operator as «ثبت هزینه ممکن نشد (2100)».
    await seedLedger();
    const owed = await runExpense({ paymentAccountId: undefined, settlement: "credit", supplierId: cash.supplierId });
    expect(owed).toMatchObject({ ok: false, errorCode: "ledger_account_missing" });
    expect(await storedRows()).toEqual([]);
  });
});
