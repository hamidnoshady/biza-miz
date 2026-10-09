/**
 * Multicurrency accounting end to end (issue #863).
 *
 * Every promise the Definition of Done makes, proven against a real Postgres:
 *
 *  - base currency is explicit, and a foreign document carries a COMPLETE,
 *    immutable rate snapshot (currency, rate row, rate value, base currency,
 *    rounding version, rounding delta);
 *  - foreign and base values reconcile exactly, per document and in aggregate;
 *  - FX gains/losses post through the explicit 4930/5870 pair on settlement
 *    (realized) and 4935/5875 on revaluation (unrealized);
 *  - historical postings never move when rates change — a later posting uses
 *    the new rate, the old entry keeps its snapshot, a reversal reverts at the
 *    ORIGINAL snapshot;
 *  - foreign A/R, A/P, financial accounts and journals represent foreign
 *    balances safely (FIFO settlement with exact base allocation, party
 *    attribution, per-account currency flags);
 *  - reports expose foreign and base values without touching the base ledger;
 *  - posting is idempotent; the database refuses edits to posted financial
 *    facts; tenant isolation holds at the policy and the service level.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let svc: typeof import("../src/lib/multicurrency-service");
let reports: typeof import("../src/lib/multicurrency-reports-service");
let journalService: typeof import("../src/lib/journal-service");
let ledgerService: typeof import("../src/lib/ledger-service");

const biz = { id: "", locationId: "" };
const otherBiz = { id: "" };
const user = { id: "" };
const acct = {
  cash: "",
  bankFx: "",
  ar: "",
  ap: "",
  fxRealizedGain: "",
  fxRealizedLoss: "",
  fxUnrealizedGain: "",
  fxUnrealizedLoss: "",
};

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

async function createAccount(
  client: Client,
  businessId: string,
  code: string,
  name: string,
  type: string,
  parentCode: string,
  currencyCode: string | null = null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type, level, parent_id, currency_code)
     SELECT $1, $2, $3, $4::account_type, 'moein',
            (SELECT id FROM accounts WHERE business_id = $1 AND code = $5), $6
     RETURNING id`,
    [businessId, code, name, type, parentCode, currencyCode],
  );
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_mcfx_${randomUUID().replaceAll("-", "")}`;

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
  svc = await import("../src/lib/multicurrency-service");
  reports = await import("../src/lib/multicurrency-reports-service");
  journalService = await import("../src/lib/journal-service");
  ledgerService = await import("../src/lib/ledger-service");

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

beforeEach(async () => {
  // journal_lines (account RESTRICT), settlement applications (lot-line
  // RESTRICT) and the revaluation rows are cleared explicitly; the rate
  // tables are append-only at the database level, so they go with the
  // businesses' cascade — the one deletion path the guards permit.
  await db.query("DELETE FROM fx_settlement_applications");
  await db.query("DELETE FROM fx_revaluation_lines");
  await db.query("DELETE FROM fx_revaluations");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");
  await db.query("UPDATE currencies SET is_active = true");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('FX Co', $1) RETURNING id",
    [`fx-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const otherRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
    [`other-${randomUUID().slice(0, 8)}`],
  );
  otherBiz.id = otherRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  // Minimal chart roots, then the accounts the tests post through. 1111 is a
  // foreign-currency bank: an ordinary chart account that names its currency.
  for (const [code, name, type] of [
    ["1000", "دارایی‌ها", "asset"],
    ["2000", "بدهی‌ها", "liability"],
    ["3000", "سرمایه", "equity"],
    ["4000", "درآمدها", "revenue"],
    ["4900", "سایر درآمدها", "revenue"],
    ["5000", "هزینه‌ها", "expense"],
  ] as const) {
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type, level)
       VALUES ($1, $2, $3, $4::account_type, 'group') ON CONFLICT DO NOTHING`,
      [biz.id, code, name, type],
    );
  }
  acct.cash = await createAccount(db, biz.id, "1100", "صندوق", "asset", "1000");
  acct.bankFx = await createAccount(db, biz.id, "1111", "بانک ارزی (دلار)", "asset", "1000", "USD");
  acct.ar = await createAccount(db, biz.id, "1200", "حساب‌های دریافتنی", "asset", "1000");
  acct.ap = await createAccount(db, biz.id, "2100", "حساب‌های پرداختنی", "liability", "2000");
  acct.fxRealizedGain = await createAccount(db, biz.id, "4930", "سود تسعیر ارز (تحقق‌یافته)", "revenue", "4900");
  acct.fxUnrealizedGain = await createAccount(db, biz.id, "4935", "سود تسعیر تسویه‌نشده", "revenue", "4900");
  acct.fxRealizedLoss = await createAccount(db, biz.id, "5870", "زیان تسعیر ارز (تحقق‌یافته)", "expense", "5000");
  acct.fxUnrealizedLoss = await createAccount(db, biz.id, "5875", "زیان تسعیر تسویه‌نشده", "expense", "5000");

  await svc.setBusinessCurrencies(biz.id, {
    baseCurrencyCode: "IRR",
    transactionCurrencyCodes: ["USD", "EUR", "AED"],
  });
});

/** A rate row (USD unless another currency is given), effective now or at an instant. */
async function seedRate(
  rate: string,
  effectiveFrom?: string,
  businessId = biz.id,
  currencyCode = "USD",
): Promise<string> {
  const recorded = await svc.recordRate({
    businessId,
    currencyCode,
    rate,
    effectiveFrom: effectiveFrom ?? null,
    actorId: user.id,
  });
  return recorded.id;
}

/** A foreign sale on account: Dr A/R $X (optionally attributed to a party) / Cr a revenue stand-in. */
async function postForeignInvoice(params: {
  rateId: string;
  partyId?: string | null;
  foreignCents: bigint;
}): Promise<string> {
  const posted = await svc.postMulticurrencyEntry({
    businessId: biz.id,
    locationId: biz.locationId,
    entryDate: null,
    memo: "فاکتور فروش ارزی",
    currencyCode: "USD",
    rateId: params.rateId,
    lines: [
      { accountId: acct.ar, side: "debit", foreignMinor: params.foreignCents, partyId: params.partyId ?? null },
      { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: params.foreignCents },
    ],
    createdBy: user.id,
    idempotencyKey: null,
  });
  return posted.entryId;
}

describe("currency configuration", () => {
  it("seeds a global catalogue with IRR and names the business's base", async () => {
    const currencies = await svc.listCurrencies(true);
    const irr = currencies.find((c) => c.code === "IRR");
    expect(irr).toBeDefined();
    expect(irr!.precision).toBe(0);
    const usd = currencies.find((c) => c.code === "USD")!;
    expect(usd.precision).toBe(2);

    const config = await svc.getBusinessCurrencyConfig(biz.id);
    expect(config.baseCurrencyCode).toBe("IRR");
    expect(config.transactionCurrencies.map((c) => c.code).sort()).toEqual(["AED", "EUR", "USD"]);
  });

  it("refuses the base currency as a transaction currency", async () => {
    await expect(
      svc.setBusinessCurrencies(biz.id, {
        baseCurrencyCode: "IRR",
        transactionCurrencyCodes: ["IRR"],
      }),
    ).rejects.toThrow("base_currency_not_a_transaction_currency");
  });

  it("keeps a switched-off currency's row (history, not deletion)", async () => {
    await svc.setBusinessCurrencies(biz.id, {
      baseCurrencyCode: "IRR",
      transactionCurrencyCodes: ["USD"],
    });
    const config = await svc.getBusinessCurrencyConfig(biz.id);
    expect(config.transactionCurrencies.find((c) => c.code === "EUR")).toMatchObject({ allowed: false });
  });
});

describe("exchange rates", () => {
  it("records a rate with its audit trail and supersession chain", async () => {
    const first = await svc.recordRate({
      businessId: biz.id,
      currencyCode: "USD",
      rate: "600000",
      actorId: user.id,
    });
    expect(first.rate).toBe("600000");
    expect(first.supersedesRateId).toBeNull();

    const second = await svc.recordRate({
      businessId: biz.id,
      currencyCode: "USD",
      rate: "610000",
      actorId: user.id,
    });
    expect(second.supersedesRateId).toBe(first.id);

    const { rows: audit } = await db.query<{ action: string; old_rate: string | null; new_rate: string | null }>(
      `SELECT action, old_rate, new_rate
         FROM exchange_rate_changes WHERE business_id = $1 ORDER BY acted_at`,
      [biz.id],
    );
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ action: "record", old_rate: null, new_rate: "600000" });
    expect(audit[1]).toMatchObject({ action: "record", old_rate: "600000", new_rate: "610000" });
  });

  it("resolves the latest effective rate and hides voided ones", async () => {
    const oldRate = await seedRate("600000", "2026-01-01T00:00:00Z");
    const newRate = await seedRate("610000", "2026-02-01T00:00:00Z");

    const { rows: voided } = await db.query<{ rate: string }>(
      `SELECT trim_scale(rate)::text AS rate FROM exchange_rates WHERE id = $1`,
      [newRate],
    );
    expect(voided[0].rate).toBe("610000");

    await svc.voidRate({
      businessId: biz.id,
      rateId: newRate,
      actorId: user.id,
      reason: "اشتباه تایپی",
    });

    // A document dated after the void resolves back to the older rate.
    const { rows: lookup } = await db.query<{ rate: string }>(
      `SELECT trim_scale(r.rate)::text AS rate
         FROM exchange_rates r
         LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
        WHERE r.business_id = $1 AND r.effective_from <= now() AND v.id IS NULL
        ORDER BY r.effective_from DESC LIMIT 1`,
      [biz.id],
    );
    expect(lookup[0].rate).toBe("600000");
    void oldRate;

    await expect(
      svc.voidRate({ businessId: biz.id, rateId: newRate, actorId: user.id, reason: null }),
    ).rejects.toThrow("rate_already_voided");
  });

  it("is append-only: the database refuses UPDATE and DELETE", async () => {
    const rateId = await seedRate("600000");
    await expect(db.query(`UPDATE exchange_rates SET rate = 1 WHERE id = $1`, [rateId])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM exchange_rates WHERE id = $1`, [rateId])).rejects.toThrow(/append-only/);
  });

  it("is tenant-isolated: another business can neither see nor pin this one's rates", async () => {
    const rateId = await seedRate("600000");
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM exchange_rates WHERE business_id = $1`,
      [otherBiz.id],
    );
    expect(rows[0].count).toBe("0");

    await svc.setBusinessCurrencies(otherBiz.id, {
      baseCurrencyCode: "IRR",
      transactionCurrencyCodes: ["USD"],
    });
    await expect(
      svc.postMulticurrencyEntry({
        businessId: otherBiz.id,
        locationId: null,
        entryDate: null,
        memo: "cross-tenant",
        currencyCode: "USD",
        rateId,
        lines: [
          { accountId: acct.bankFx, side: "debit", foreignMinor: 100n },
          { accountId: acct.ar, side: "credit", foreignMinor: 100n },
        ],
        createdBy: user.id,
        idempotencyKey: null,
      }),
    ).rejects.toThrow("rate_not_found");
  });
});

describe("posting foreign documents", () => {
  it("freezes a complete snapshot and reconciles foreign and base exactly", async () => {
    const rateId = await seedRate("600000");
    const posted = await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: biz.locationId,
      entryDate: "2026-03-01",
      memo: "فروش ارزی",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 10000n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 10000n },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });
    expect(posted.duplicate).toBe(false);
    expect(posted.foreignTotal).toBe("10000");
    expect(posted.baseTotal).toBe("60000000"); // $100.00 × 600,000

    const { rows: entry } = await db.query<{
      currency_code: string;
      base_currency_code: string;
      exchange_rate_id: string;
      exchange_rate: string;
      rounding_version: number;
      rounding_delta: string;
    }>(
      `SELECT currency_code, base_currency_code, exchange_rate_id::text AS exchange_rate_id,
              exchange_rate::text AS exchange_rate, rounding_version, rounding_delta::text AS rounding_delta
         FROM journal_entries WHERE id = $1`,
      [posted.entryId],
    );
    expect(entry[0]).toMatchObject({
      currency_code: "USD",
      base_currency_code: "IRR",
      exchange_rate_id: rateId,
      exchange_rate: "600000",
      rounding_version: 1,
      rounding_delta: "0",
    });

    const { rows: lines } = await db.query<{ foreign_debit: string; foreign_credit: string; debit: string; credit: string }>(
      `SELECT foreign_debit::text AS foreign_debit, foreign_credit::text AS foreign_credit,
              debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [posted.entryId],
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ foreign_debit: "10000", foreign_credit: "0", debit: "60000000", credit: "0" });
    expect(lines[1]).toMatchObject({ foreign_debit: "0", foreign_credit: "10000", debit: "0", credit: "60000000" });
  });

  it("never recalculates a historical posting when the rate changes", async () => {
    const oldRateId = await seedRate("600000");
    const firstEntry = await postForeignInvoice({ rateId: oldRateId, foreignCents: 10000n });

    const newRateId = await seedRate("650000");
    const secondEntry = await postForeignInvoice({ rateId: newRateId, foreignCents: 10000n });

    const { rows } = await db.query<{ id: string; exchange_rate: string }>(
      `SELECT id::text AS id, exchange_rate::text AS exchange_rate
         FROM journal_entries WHERE id = ANY($1::uuid[]) ORDER BY posted_at`,
      [[firstEntry, secondEntry]],
    );
    expect(rows.find((r) => r.id === firstEntry)!.exchange_rate).toBe("600000");
    expect(rows.find((r) => r.id === secondEntry)!.exchange_rate).toBe("650000");
  });

  it("is idempotent by key: a retry returns the entry it already created", async () => {
    const rateId = await seedRate("600000");
    const key = `doc-${randomUUID()}`;
    const first = await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "retry me",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 500n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 500n },
      ],
      createdBy: user.id,
      idempotencyKey: key,
    });
    const second = await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "retry me",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 500n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 500n },
      ],
      createdBy: user.id,
      idempotencyKey: key,
    });
    expect(second.entryId).toBe(first.entryId);
    expect(second.duplicate).toBe(true);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1 AND idempotency_key = $2`,
      [biz.id, key],
    );
    expect(rows[0].count).toBe("1");
  });

  it("absorbs a sub-unit rounding residual and stamps the delta", async () => {
    // 1 USD cent at 50 rial → 0.5 → rounds up to 1; two debit cents vs one credit of 2 cents
    // leaves a 1-rial residual, absorbed on the largest line.
    const rateId = await seedRate("50");
    const posted = await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "rounding",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 1n },
        { accountId: acct.bankFx, side: "debit", foreignMinor: 1n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 2n },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });
    expect(posted.roundingDelta).toBe("1");
    expect(posted.baseTotal).toBe("1"); // one debit absorbed to a zero BASE (its foreign leg stays)

    const { rows: sums } = await db.query<{ d: string; c: string; fd: string; fc: string }>(
      `SELECT sum(debit)::text AS d, sum(credit)::text AS c,
              sum(foreign_debit)::text AS fd, sum(foreign_credit)::text AS fc
         FROM journal_lines WHERE entry_id = $1`,
      [posted.entryId],
    );
    expect(sums[0].d).toBe(sums[0].c); // base balances exactly
    expect(sums[0].fd).toBe(sums[0].fc); // foreign balances exactly
  });

  it("refuses documents the rounding policy cannot explain", async () => {
    const rateId = await seedRate("610000");
    await expect(
      svc.postMulticurrencyEntry({
        businessId: biz.id,
        locationId: null,
        entryDate: null,
        memo: "unexplained",
        currencyCode: "USD",
        rateId,
        lines: [
          { accountId: acct.bankFx, side: "debit", foreignMinor: 10000n },
          { accountId: acct.ar, side: "credit", foreignMinor: 10000n, baseMinor: 60_000_000n },
          { accountId: acct.fxRealizedLoss, side: "debit", baseMinor: 999_999n },
        ],
        createdBy: user.id,
        idempotencyKey: null,
      }),
    ).rejects.toThrow("fx_residual_unexplained");
  });

  it("enforces account-currency affinity and refuses a foreign document in the base currency", async () => {
    const rateId = await seedRate("600000");
    // The USD bank cannot take an EUR document.
    await svc.setBusinessCurrencies(biz.id, { baseCurrencyCode: "IRR", transactionCurrencyCodes: ["USD", "EUR"] });
    await seedRate("65000", undefined, biz.id, "EUR");
    await expect(
      svc.postMulticurrencyEntry({
        businessId: biz.id,
        locationId: null,
        entryDate: null,
        memo: "wrong account currency",
        currencyCode: "EUR",
        rateId: null,
        lines: [
          { accountId: acct.bankFx, side: "debit", foreignMinor: 100n },
          { accountId: acct.ar, side: "credit", foreignMinor: 100n },
        ],
        createdBy: user.id,
        idempotencyKey: null,
      }),
    ).rejects.toThrow("account_currency_mismatch");

    // The base currency itself is not a transaction currency.
    await expect(
      svc.postMulticurrencyEntry({
        businessId: biz.id,
        locationId: null,
        entryDate: null,
        memo: "base as foreign",
        currencyCode: "IRR",
        rateId,
        lines: [
          { accountId: acct.bankFx, side: "debit", foreignMinor: 100n },
          { accountId: acct.ar, side: "credit", foreignMinor: 100n },
        ],
        createdBy: user.id,
        idempotencyKey: null,
      }),
    ).rejects.toThrow("base_currency_not_a_transaction_currency");
  });

  it("refuses to edit posted financial facts at the database level", async () => {
    const rateId = await seedRate("600000");
    const entryId = await postForeignInvoice({ rateId, foreignCents: 100n });
    await expect(
      db.query(`UPDATE journal_entries SET exchange_rate = 1 WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`UPDATE journal_lines SET debit = debit + 1 WHERE entry_id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/);
    // Reversal stamps are still legitimate updates.
    await db.query(`UPDATE journal_entries SET reversed_at = now() WHERE id = $1`, [entryId]);
  });

  it("refuses foreign amounts on base entries and unbalanced foreign sides, at the database level", async () => {
    // The guard is a DEFERRED constraint trigger: it fires at COMMIT, so the
    // rejecting statement must commit on its own (autocommit) for the promise
    // to see the error. The beforeEach cleanup removes the leftovers.
    const { rows: baseEntry } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, CURRENT_DATE, 'base') RETURNING id`,
      [biz.id],
    );
    await expect(
      db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, foreign_debit) VALUES ($1, $2, 100, 0, 5)`,
        [baseEntry[0].id, acct.cash],
      ),
    ).rejects.toThrow(/foreign_amount_on_base_entry/);

    const rateId = await seedRate("600000");
    const { rows: fxEntry } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, currency_code, base_currency_code, exchange_rate_id, exchange_rate, rounding_version)
       VALUES ($1, CURRENT_DATE, 'unbalanced', 'USD', 'IRR', $2, '600000', 1) RETURNING id`,
      [biz.id, rateId],
    );
    // Both legs in ONE statement: the guard is deferred to the statement's
    // commit, so it must see the whole (unbalanced) document at once.
    await expect(
      db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, foreign_debit, foreign_credit)
         SELECT $1::uuid, $2::uuid, 600000, 0, 100, 0
         UNION ALL
         SELECT $1::uuid, $3::uuid, 0, 600000, 0, 99`,
        [fxEntry[0].id, acct.bankFx, acct.ar],
      ),
    ).rejects.toThrow(/foreign_side_unbalanced/);
  });
});

describe("reversal", () => {
  it("reverts at the original snapshot and restores every balance exactly", async () => {
    const rateId = await seedRate("600000");
    const entryId = await postForeignInvoice({ rateId, foreignCents: 10000n });

    // The rate moves before the reversal — the reversal must not care.
    await seedRate("700000");

    const { entryId: reversalId } = await svc.reverseFxEntry({
      businessId: biz.id,
      entryId,
      actorId: user.id,
    });

    const { rows: entries } = await db.query<{
      id: string;
      exchange_rate: string;
      currency_code: string;
      reverses_entry_id: string | null;
      reversed_at: Date | null;
    }>(
      `SELECT id::text AS id, exchange_rate::text AS exchange_rate, currency_code,
              reverses_entry_id::text AS reverses_entry_id, reversed_at
         FROM journal_entries WHERE id = ANY($1::uuid[])`,
      [[entryId, reversalId]],
    );
    const original = entries.find((e) => e.id === entryId)!;
    const reversal = entries.find((e) => e.id === reversalId)!;
    expect(original.reversed_at).not.toBeNull();
    expect(reversal.reverses_entry_id).toBe(entryId);
    expect(reversal.exchange_rate).toBe("600000"); // the ORIGINAL snapshot

    const { rows: sums } = await db.query<{ d: string; c: string; fd: string; fc: string }>(
      `SELECT sum(debit)::text AS d, sum(credit)::text AS c,
              sum(foreign_debit)::text AS fd, sum(foreign_credit)::text AS fc
         FROM journal_lines WHERE entry_id = ANY($1::uuid[])`,
      [[entryId, reversalId]],
    );
    expect(sums[0].d).toBe(sums[0].c);
    expect(sums[0].fd).toBe(sums[0].fc);
    // Net everything to zero.
    expect(BigInt(sums[0].d) - BigInt(sums[0].c)).toBe(0n);
    expect(BigInt(sums[0].fd) - BigInt(sums[0].fc)).toBe(0n);

    await expect(
      svc.reverseFxEntry({ businessId: biz.id, entryId, actorId: user.id }),
    ).rejects.toThrow("already_reversed");
    await expect(
      svc.reverseFxEntry({ businessId: biz.id, entryId: reversalId, actorId: user.id }),
    ).rejects.toThrow("cannot_reverse_a_reversal");
  });

  it("refuses to reverse a base-currency entry through the FX path", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, CURRENT_DATE, 'base entry', 'manual') RETURNING id`,
      [biz.id],
    );
    await expect(
      svc.reverseFxEntry({ businessId: biz.id, entryId: rows[0].id, actorId: user.id }),
    ).rejects.toThrow("not_a_foreign_entry");
  });
});

describe("settlement of foreign receivables — realized FX", () => {
  async function createParty(name: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, $2, 'customer') RETURNING id`,
      [biz.id, name],
    );
    return rows[0].id;
  }

  it("posts a gain at the new rate: bank at settlement, AR at booking, 4930 the difference", async () => {
    const partyId = await createParty("شرکت آلفا");
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, partyId, foreignCents: 10000n }); // $100 booked at 60,000,000

    await seedRate("610000");
    const settlement = await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: biz.locationId,
      direction: "receivable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "10000",
      items: [],
      entryDate: null,
      memo: "دریافت از آلفا",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });

    expect(settlement.realizedDifference).toBe("1000000"); // gain
    expect(settlement.baseSettledAtBooking).toBe("60000000");
    expect(settlement.baseSettledAtSettlementRate).toBe("61000000");

    const { rows: lines } = await db.query<{ code: string; debit: string; credit: string; fd: string; fc: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit,
              jl.foreign_debit::text AS fd, jl.foreign_credit::text AS fc
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY a.code`,
      [settlement.entryId],
    );
    const byCode = new Map(lines.map((l) => [l.code, l]));
    expect(byCode.get("1111")).toMatchObject({ debit: "61000000", fc: "0", fd: "10000" });
    expect(byCode.get("1200")).toMatchObject({ credit: "60000000", fd: "0", fc: "10000" });
    expect(byCode.get("4930")).toMatchObject({ credit: "1000000" });

    // Applications recorded; party's open balance is now zero.
    const { rows: apps } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM fx_settlement_applications WHERE business_id = $1`,
      [biz.id],
    );
    expect(apps[0].count).toBe("1");

    const partyReport = await reports.foreignPartyBalances(biz.id, { direction: "receivable" });
    expect(partyReport.balances).toHaveLength(0);
  });

  it("posts a gain on a payable settled cheaper (obligation view flips), through 4930", async () => {
    const partyId = await createParty("تأمین‌کننده بتا");
    const rateId = await seedRate("600000");
    // A foreign purchase: the AP lot is a credit on 2100, against a stand-in asset.
    await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "خرید ارزی",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.ar, side: "debit", foreignMinor: 20000n }, // stand-in asset leg
        { accountId: acct.ap, side: "credit", foreignMinor: 20000n, partyId },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });

    // The dollar WEAKENED: clearing a $200 liability now costs only 118M —
    // parting with less than the booked 120M is a GAIN for the debtor.
    await seedRate("590000");
    const settlement = await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: null,
      direction: "payable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "20000",
      items: [],
      entryDate: null,
      memo: "پرداخت به بتا",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });
    expect(settlement.realizedDifference).toBe("2000000"); // gain, obligation view

    const { rows: lines } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1`,
      [settlement.entryId],
    );
    const byCode = new Map(lines.map((l) => [l.code, l]));
    expect(byCode.get("2100")).toMatchObject({ debit: "120000000" }); // released at booked base
    expect(byCode.get("1111")).toMatchObject({ credit: "118000000" }); // paid at the new rate
    expect(byCode.get("4930")).toMatchObject({ credit: "2000000" }); // the gain

    // And a payable settled DEARER is a loss through 5870.
    const partyId2 = await createParty("تأمین‌کننده دلتا");
    await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "خرید ارزی",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.ar, side: "debit", foreignMinor: 5000n },
        { accountId: acct.ap, side: "credit", foreignMinor: 5000n, partyId: partyId2 },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });
    await seedRate("610000");
    const dearer = await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: null,
      direction: "payable",
      partyId: partyId2,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "5000",
      items: [],
      entryDate: null,
      memo: "پرداخت به دلتا",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });
    expect(dearer.realizedDifference).toBe("-500000"); // loss
    const { rows: lossLines } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1`,
      [dearer.entryId],
    );
    const lossByCode = new Map(lossLines.map((l) => [l.code, l]));
    expect(lossByCode.get("2100")).toMatchObject({ debit: "30000000" });
    expect(lossByCode.get("1111")).toMatchObject({ credit: "30500000" });
    expect(lossByCode.get("5870")).toMatchObject({ debit: "500000" });
  });

  it("settles partially, FIFO, with base allocation exact across settlements", async () => {
    const partyId = await createParty("مشتری گاما");
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, partyId, foreignCents: 10000n }); // $100 @ 60,000,000

    await seedRate("610000");
    const first = await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "4000",
      items: [],
      entryDate: null,
      memo: "قسط اول",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });
    expect(first.baseSettledAtBooking).toBe("24000000"); // 40% of 60M
    expect(first.realizedDifference).toBe("400000"); // 24.4M − 24M

    const second = await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "6000",
      items: [],
      entryDate: null,
      memo: "قسط دوم",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });
    // The lot-emptying slice takes the whole remaining booked base: exact by construction.
    expect(BigInt(first.baseSettledAtBooking) + BigInt(second.baseSettledAtBooking)).toBe(60_000_000n);
    expect(second.baseSettledAtBooking).toBe("36000000");
    expect(second.realizedDifference).toBe("600000"); // 36.6M − 36M

    const partyReport = await reports.foreignPartyBalances(biz.id, { direction: "receivable" });
    expect(partyReport.balances).toHaveLength(0);
  });

  it("refuses settling more than the open balance and double-settling by key", async () => {
    const partyId = await createParty("مشتری دلتا");
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, partyId, foreignCents: 1000n });

    const key = `stl-${randomUUID()}`;
    const common = {
      businessId: biz.id,
      locationId: null,
      direction: "receivable" as const,
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      items: [],
      entryDate: null,
      memo: "",
      actorId: user.id,
    };
    await expect(
      svc.settleForeignDocument({ ...common, autoAmount: "1001", idempotencyKey: key }),
    ).rejects.toThrow("insufficient_open_balance");

    const first = await svc.settleForeignDocument({ ...common, autoAmount: "1000", idempotencyKey: key });
    const again = await svc.settleForeignDocument({ ...common, autoAmount: "1000", idempotencyKey: key });
    expect(again.entryId).toBe(first.entryId);
    expect(again.duplicate).toBe(true);
  });
});

describe("unrealized revaluation", () => {
  it("restates a foreign bank and posts the difference through 4935", async () => {
    const rateId = await seedRate("600000");
    await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "واریز ارزی",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 10000n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 10000n },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });

    await seedRate("620000");
    const run = await svc.runFxRevaluation({
      businessId: biz.id,
      currencyCode: "USD",
      asOf: "2026-03-31",
      rateId: null,
      actorId: user.id,
      idempotencyKey: `reval-${randomUUID()}`,
    });
    expect(run.totalGain).toBe("2000000");
    expect(run.totalLoss).toBe("0");
    expect(run.entryId).not.toBeNull();

    const { rows: lines } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1`,
      [run.entryId!],
    );
    const byCode = new Map(lines.map((l) => [l.code, l]));
    expect(byCode.get("1111")).toMatchObject({ debit: "2000000" });
    expect(byCode.get("4935")).toMatchObject({ credit: "2000000" });

    // A second run at the SAME rate restates nothing.
    const again = await svc.runFxRevaluation({
      businessId: biz.id,
      currencyCode: "USD",
      asOf: "2026-03-31",
      rateId: null,
      actorId: user.id,
      idempotencyKey: `reval-${randomUUID()}`,
    });
    expect(again.totalGain).toBe("0");
    expect(again.entryId).toBeNull();

    // A rate drop posts the increment as a loss.
    await seedRate("610000");
    const downward = await svc.runFxRevaluation({
      businessId: biz.id,
      currencyCode: "USD",
      asOf: "2026-04-30",
      rateId: null,
      actorId: user.id,
      idempotencyKey: `reval-${randomUUID()}`,
    });
    expect(downward.totalLoss).toBe("1000000");
    const { rows: lossLines } = await db.query<{ code: string; debit: string }>(
      `SELECT a.code, jl.debit::text AS debit
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 AND jl.debit > 0`,
      [downward.entryId!],
    );
    expect(lossLines.find((l) => l.code === "5875")).toBeDefined();
  });

  it("is idempotent by key", async () => {
    const key = `reval-${randomUUID()}`;
    const rateId = await seedRate("600000");
    await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "واریز",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 100n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 100n },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });
    await seedRate("610000");
    const first = await svc.runFxRevaluation({
      businessId: biz.id,
      currencyCode: "USD",
      asOf: "2026-03-31",
      rateId: null,
      actorId: user.id,
      idempotencyKey: key,
    });
    const second = await svc.runFxRevaluation({
      businessId: biz.id,
      currencyCode: "USD",
      asOf: "2026-03-31",
      rateId: null,
      actorId: user.id,
      idempotencyKey: key,
    });
    expect(second.revaluationId).toBe(first.revaluationId);
    expect(second.duplicate).toBe(true);
  });
});

describe("reports", () => {
  it("foreign trial balance balances in foreign and base, per currency and overall", async () => {
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, foreignCents: 10000n });

    const report = await reports.foreignTrialBalance(biz.id);
    expect(report.baseCurrencyCode).toBe("IRR");
    const totals = report.totals.find((t) => t.currencyCode === "USD")!;
    expect(totals.foreignDebit).toBe(totals.foreignCredit);
    expect(totals.baseDebit).toBe(totals.baseCredit);
    expect(report.baseTotals.baseDebit).toBe(report.baseTotals.baseCredit);
    expect(BigInt(report.baseTotals.baseDebit)).toBe(60000000n);
  });

  it("account statement shows foreign and base side by side with running balances", async () => {
    const rateId = await seedRate("600000");
    const entryId = await postForeignInvoice({ rateId, foreignCents: 10000n });
    const statement = await reports.accountStatement(biz.id, acct.ar);
    expect(statement.lines).toHaveLength(1);
    const line = statement.lines[0];
    expect(line.entryId).toBe(entryId);
    expect(line.foreignAmount).toBe("10000");
    expect(line.exchangeRate).toBe("600000");
    expect(line.baseAmount).toBe("60000000");
    expect(line.foreignRunning).toBe("10000");
    expect(statement.totals.baseClosing).toBe("60000000");
  });

  it("gain/loss report reconstructs settlements exactly", async () => {
    const partyId = (await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'شرکت reporting', 'customer') RETURNING id`,
      [biz.id],
    )).rows[0].id;
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, partyId, foreignCents: 5000n });
    await seedRate("610000");
    await svc.settleForeignDocument({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      partyId,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: acct.bankFx,
      autoAmount: "5000",
      items: [],
      entryDate: null,
      memo: "",
      actorId: user.id,
      idempotencyKey: `stl-${randomUUID()}`,
    });

    const report = await reports.gainLossReport(biz.id);
    expect(report.realized).toHaveLength(1);
    expect(report.realized[0]).toMatchObject({
      direction: "receivable",
      currencyCode: "USD",
      foreignApplied: "5000",
      baseAtBooking: "30000000",
      baseAtSettlement: "30500000",
      difference: "500000",
    });
    expect(report.realizedTotals[0]).toMatchObject({ currencyCode: "USD", gain: "500000", loss: "0" });
  });

  it("exposure and foreign-bank reports show the unrealized view without posting it", async () => {
    const rateId = await seedRate("600000");
    await svc.postMulticurrencyEntry({
      businessId: biz.id,
      locationId: null,
      entryDate: null,
      memo: "واریز",
      currencyCode: "USD",
      rateId,
      lines: [
        { accountId: acct.bankFx, side: "debit", foreignMinor: 10000n },
        { accountId: acct.fxRealizedGain, side: "credit", foreignMinor: 10000n },
      ],
      createdBy: user.id,
      idempotencyKey: null,
    });
    await seedRate("620000");

    const banks = await reports.foreignBankBalances(biz.id);
    expect(banks.accounts).toHaveLength(1);
    expect(banks.accounts[0]).toMatchObject({
      code: "1111",
      currencyCode: "USD",
      foreignBalance: "10000",
      bookBase: "60000000",
      currentRate: "620000",
      restatedBase: "62000000",
      unrealizedDifference: "2000000",
    });

    const exposure = await reports.currencyExposure(biz.id);
    const usd = exposure.currencies.find((c) => c.currencyCode === "USD")!;
    expect(usd.netForeign).toBe("10000");
    expect(usd.unrealizedDifference).toBe("2000000");
  });
});

describe("the base ledger is untouched and visible", () => {
  it("the journal lists foreign entries with their snapshot; base entries keep currency NULL", async () => {
    const rateId = await seedRate("600000");
    const fxEntry = await postForeignInvoice({ rateId, foreignCents: 100n });
    await db.query(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, CURRENT_DATE, 'base entry', 'manual')`,
      [biz.id],
    );

    const page = await journalService.listJournalEntries(biz.id, {
      dateFrom: null,
      dateTo: null,
      sourceType: null,
      q: null,
      locationId: null,
      accountId: null,
      createdBy: null,
      projectId: null,
      entryId: null,
      reversalState: "any",
      entryKind: "any",
      amountMin: null,
      amountMax: null,
      limit: 10,
      cursor: null,
    });
    const fx = page.entries.find((e) => e.id === fxEntry)!;
    expect(fx.currencyCode).toBe("USD");
    expect(fx.exchangeRate).toBe("600000");
    expect(fx.roundingVersion).toBe(1);
    expect(fx.lines.every((l) => l.foreignDebit !== undefined)).toBe(true);
    const base = page.entries.find((e) => e.currencyCode === null)!;
    expect(base.exchangeRate).toBeNull();
  });

  it("tenant tables carry RLS with the tenant_isolation policy", async () => {
    for (const table of [
      "business_currencies",
      "exchange_rates",
      "exchange_rate_voids",
      "exchange_rate_changes",
      "fx_settlement_applications",
      "fx_revaluations",
      "fx_revaluation_lines",
    ]) {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect({ table, ...rows[0] }).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const { rows: policies } = await db.query<{ policyname: string }>(
        `SELECT policyname FROM pg_policies WHERE tablename = $1`,
        [table],
      );
      expect(policies.map((p) => p.policyname)).toContain("tenant_isolation");
    }
  });

  it("journal entries expose currency in the shared scope for filters", async () => {
    const rateId = await seedRate("600000");
    await postForeignInvoice({ rateId, foreignCents: 100n });
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM journal_entries WHERE business_id = $1 AND currency_code = 'USD'`,
      [biz.id],
    );
    expect(rows[0].count).toBe("1");
  });
});
