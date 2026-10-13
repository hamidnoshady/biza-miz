#!/usr/bin/env node
/**
 * Opening balances, fiscal carry-forward & voucher numbering — browser
 * acceptance against a running production server (issue #867). Runs in the
 * media E2E job, which owns a fresh seeded database, so the fiscal years this
 * script defines never touch the visual fixture.
 *
 *   npm run test:e2e:fiscal-opening   (server on E2E_BASE_URL, default :3000)
 *
 * What it proves, through the real HTTP boundary with a real owner session
 * (permission + tenant scoping enforced by the server, not assumed):
 *   1. An opening set for 1403 walks the full life — import preview, create,
 *      submit, approve, post — and posts as one ordinary OP-numbered entry
 *      the voucher register can see.
 *   2. A CSV import reads amounts in the business's selected unit: the same
 *      file is ×10 in Rial while the unit is toman and 1:1 once it is rial.
 *   3. A year with revenue and expense closes only after its twelve periods
 *      are soft-closed, and the close posts the P&L into retained earnings —
 *      a path the 0216 fiscal-authorization trigger guards for the live
 *      session.
 *   4. The carry-forward of the closed year into 1404 reconciles Rial for
 *      Rial — A/R per customer, A/P per supplier, cash net of the year's
 *      activity, one equity line for the result — and is idempotent.
 *   5. The accounting workspace renders for the owner in a real browser.
 *
 * The walk runs on 1403, a year no other E2E in this job touches: the
 * cheque-register E2E runs earlier against the same seeded database and posts
 * entries dated inside 1404/1405 (issue dates of January 2026, bounces of
 * February 2026), which would skew 1404's exact net-income and A/R/A/P/cash
 * balances. 1403 stays pure — every 1403 ledger fact is this script's, so the
 * close and the carry-forward can assert exact Rial — and the transition
 * lands in 1404, which the other E2Es pollute but this script only reads
 * (and never closes).
 *
 * Exits non-zero if any expectation fails. Nothing here is skipped or
 * retried into a pass.
 */
import { chromium } from "playwright";
import { Client } from "pg";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
const DATABASE_URL = process.env.DATABASE_URL;
const EXECUTABLE = process.env.VISUAL_CHROMIUM_PATH || undefined;

if (!DATABASE_URL) {
  console.error("DATABASE_URL (the provisioning connection) is required");
  process.exit(2);
}

/** 1403 runs 2024-03-21 → 2025-03-20; 1404 runs 2025-03-21 → 2026-03-20. */
const YEAR = { labelFrom: "1403", labelTo: "1404", insideFrom: "2024-04-05" };
/** The opening set: a balanced 7,000,000 Rial against the year's start. */
const OPENING = {
  cashDebit: 5_000_000,
  arDebit: 2_000_000,
  apCredit: 2_000_000,
  equityCredit: 5_000_000,
};
/** The year's P&L: 10,000,000 revenue, 1,000,000 expense → 9,000,000 net. */
const PNL = { revenue: 10_000_000, expense: 1_000_000 };

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function until(fn, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function login(context) {
  const response = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!response.ok()) throw new Error(`owner login failed (${response.status()})`);
}

/**
 * Calls the API the way the app's own UI does: `fetch` inside a page on the
 * app's origin. The request API does not send the Secure session cookie over
 * plain http://127.0.0.1, and a bare request carries no Origin header, which
 * the origin check refuses for every mutation.
 */
async function api(page, method, path, body) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    { method, path, body },
  );
}

async function apiJson(page, method, path, body) {
  const response = await api(page, method, path, body);
  if (response.status >= 300) {
    throw new Error(`${method} ${path} → ${response.status}: ${response.text}`);
  }
  return JSON.parse(response.text);
}

/** A multipart import preview, the way the import dialog sends it. */
async function importCsv(page, csvText, filename, fiscalYearLabel, effectiveDate) {
  const result = await page.evaluate(
    async ({ csvText, filename, fiscalYearLabel, effectiveDate }) => {
      const form = new FormData();
      form.append("file", new File([csvText], filename, { type: "text/csv" }));
      form.append("fiscalYearLabel", fiscalYearLabel);
      form.append("effectiveDate", effectiveDate);
      const response = await fetch("/api/ledger/opening-balances/import", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      return { status: response.status, text: await response.text() };
    },
    { csvText, filename, fiscalYearLabel, effectiveDate },
  );
  if (result.status >= 300) {
    throw new Error(`CSV import preview → ${result.status}: ${result.text}`);
  }
  return JSON.parse(result.text);
}

// ---------------------------------------------------------------------------
// Provisioning — the seeded business has a login, not a chart.
//
// The opening set needs cash, A/R, A/P and an equity account; the year's P&L
// needs any revenue and any expense account; the close posts the result to the
// well-known retained-earnings code, so the chart must carry it. The industry
// templates differ in their P&L numbering (food service books revenue in 4000,
// not 7000), so the base codes are required by code and the P&L accounts are
// discovered by type.
// ---------------------------------------------------------------------------

const REQUIRED_CODES = ["1100", "1200", "2100", "3800", "3900"];

/** Provisions the industry template through the setup route, like the cheques script. */
async function ensureChartOfAccounts(page) {
  const current = await apiJson(page, "GET", "/api/setup/accounts");
  const codes = new Set((current.existing ?? []).map((a) => a.code));
  if (REQUIRED_CODES.every((code) => codes.has(code))) return;
  const posted = await api(page, "POST", "/api/setup/accounts", { accounts: current.template });
  if (posted.status >= 300) {
    throw new Error(`provisioning the chart failed (${posted.status}): ${posted.text}`);
  }
  console.log(`[e2e-fiscal-opening] chart of accounts provisioned (${current.template.length} accounts)`);
}

/**
 * Parties with accounting roles (the parties API has no role field for a
 * plain create) and the unit preference — fixture facts, written through the
 * provisioning connection the way the media script writes its config.
 */
async function ensureFixtures(provisioning, businessId) {
  const upsert = async (role, name) => {
    const found = await provisioning.query(
      "SELECT id FROM parties WHERE business_id = $1 AND name = $2 AND role = $3",
      [businessId, name, role],
    );
    if (found.rowCount) return found.rows[0].id;
    const inserted = await provisioning.query(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, $2, $3) RETURNING id",
      [businessId, name, role],
    );
    return inserted.rows[0].id;
  };
  const customerOne = await upsert("customer", "قنادی نمونه");
  const supplierOne = await upsert("supplier", "کارخانه نمونه");

  await provisioning.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'business.prefs', jsonb_build_object('currencyDisplay', 'toman'))
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = settings.value || jsonb_build_object('currencyDisplay', 'toman')`,
    [businessId],
  );
  return { customerOne, supplierOne };
}

async function setUnit(provisioning, businessId, unit) {
  await provisioning.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'business.prefs', jsonb_build_object('currencyDisplay', $2::text))
     ON CONFLICT (business_id, location_id, key)
     DO UPDATE SET value = settings.value || jsonb_build_object('currencyDisplay', $2::text)`,
    [businessId, unit],
  );
}

// ---------------------------------------------------------------------------
// The fiscal walk
// ---------------------------------------------------------------------------

async function fiscalYearId(page, label) {
  const list = await apiJson(page, "GET", "/api/ledger/fiscal-years");
  const existing = (list.fiscalYears ?? []).find((y) => String(y.label) === label);
  if (existing) return existing.id;
  const created = await apiJson(page, "POST", "/api/ledger/fiscal-years", { year: Number(label) });
  return created.fiscalYear.id;
}

async function manualEntry(page, entryDate, memo, lines) {
  const draft = await apiJson(page, "POST", "/api/ledger/entries/drafts", {
    entryDate,
    memo,
    lines,
  });
  const draftId = draft.id ?? draft.draft?.id;
  if (!draftId) throw new Error(`no draft id in ${JSON.stringify(draft)}`);
  const approved = await apiJson(page, "POST", `/api/ledger/entries/drafts/${draftId}/approve`, {});
  return approved;
}

async function run() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  // Every api() call is a same-origin fetch inside this page, so the page must
  // be on the app's origin before the first one — login goes through the
  // context's request API and does not navigate. On about:blank the relative
  // URLs do not parse. The root may still be redirecting (unauthenticated
  // visitors get sent to /login), so wait for the URL to settle — a fetch in
  // a context about to be destroyed throws "Execution context was destroyed".
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await until(async () => {
    const url = page.url();
    await new Promise((r) => setTimeout(r, 150));
    return url === page.url() ? url : null;
  }, 10_000);

  const provisioning = new Client({ connectionString: DATABASE_URL });
  await provisioning.connect();
  await provisioning.query("SELECT set_config('app.rls_bypass', 'on', false)");
  const businessId = (await provisioning.query("SELECT id FROM businesses LIMIT 1")).rows[0].id;
  if (!businessId) throw new Error("no seeded business — run db:seed first");

  try {
    await login(context);
    await ensureChartOfAccounts(page);
    const accountsList = (await apiJson(page, "GET", "/api/ledger/accounts?all=1")).accounts ?? [];
    const acct = Object.fromEntries(accountsList.map((a) => [a.code, a.id]));
    for (const code of REQUIRED_CODES) {
      if (!acct[code]) throw new Error(`account ${code} missing after provisioning`);
    }
    // Posting requires leaf accounts; the section parents (e.g. revenue
    // 4000) exist in every template but cannot receive journal lines.
    const revenueAccount = accountsList.find((a) => a.type === "revenue" && !a.hasChildren);
    const expenseAccount = accountsList.find((a) => a.type === "expense" && !a.hasChildren);
    if (!revenueAccount || !expenseAccount) {
      throw new Error("the chart has no postable (leaf) revenue or expense account to run the year's P&L on");
    }
    const { customerOne, supplierOne } = await ensureFixtures(provisioning, businessId);

    const yearFrom = await fiscalYearId(page, YEAR.labelFrom);
    const yearTo = await fiscalYearId(page, YEAR.labelTo);
    check("fiscal years 1403 and 1404 are defined", Boolean(yearFrom && yearTo));

    // 1 — the opening set's full life, Rial in, Rial out.
    const preview = await apiJson(page, "POST", "/api/ledger/opening-balances/import", {
      fiscalYearLabel: YEAR.labelFrom,
      effectiveDate: YEAR.insideFrom,
      lines: [
        { accountId: acct["1100"], debit: OPENING.cashDebit, credit: 0 },
        { accountId: acct["1200"], debit: OPENING.arDebit, credit: 0, partyType: "customer", partyId: customerOne },
        { accountId: acct["2100"], debit: 0, credit: OPENING.apCredit, partyType: "supplier", partyId: supplierOne },
        { accountId: acct["3900"], debit: 0, credit: OPENING.equityCredit },
      ],
    });
    check("import preview validates the balanced set", preview.valid === true, JSON.stringify(preview.problems ?? []));
    check(
      "preview totals are exact Rial",
      preview.totalDebit === "7000000" && preview.totalCredit === "7000000",
      `${preview.totalDebit}/${preview.totalCredit}`,
    );

    const created = await apiJson(page, "POST", "/api/ledger/opening-balances", {
      fiscalYearLabel: YEAR.labelFrom,
      effectiveDate: YEAR.insideFrom,
      note: "E2E افتتاحیه",
      lines: preview.lines,
    });
    const setId = created.setId;
    check("create returns the draft set", Boolean(setId));
    const submit = await apiJson(page, "POST", `/api/ledger/opening-balances/${setId}/submit`, {});
    check("submit moves the set to review", Boolean(submit?.id ?? submit?.ok ?? submit?.status));
    await apiJson(page, "POST", `/api/ledger/opening-balances/${setId}/approve`, {});
    const posted = await apiJson(page, "POST", `/api/ledger/opening-balances/${setId}/post`, {});
    check("post lands the set in the ledger", posted?.posted !== false && posted?.error === undefined, JSON.stringify(posted));

    const register = await apiJson(page, "GET", "/api/ledger/vouchers?documentType=opening&limit=50");
    const openingRow = (register.rows ?? []).find((r) => r.voucherNumber === "OP-1403-000001");
    check("the register wears the opening number OP-1403-000001", Boolean(openingRow), JSON.stringify(register.rows?.map((r) => r.voucherNumber)));
    check(
      "the posted entry's totals are the set's totals",
      openingRow?.totalDebit === "7000000" && openingRow?.totalCredit === "7000000",
      openingRow ? `${openingRow.totalDebit}/${openingRow.totalCredit}` : "row missing",
    );

    // 2 — the same CSV is ×10 while the unit is toman, 1:1 when it is rial.
    const csv = [
      "کد حساب,نام حساب,بدهکار,بستانکار,مرجع",
      "1100,,1000000,,",
      "3900,,,1000000,",
    ].join("\n");
    // The file-import line contract is numeric Rial (with a safe-integer
    // guard in parseOpeningImportFile); the preview's totals are decimal
    // strings. Compare the line amount as a string so the check rides
    // whichever of the two shapes the response carries.
    const asToman = await importCsv(page, csv, "opening-e2e.csv", YEAR.labelFrom, YEAR.insideFrom);
    check(
      "toman import reads 1,000,000 toman as 10,000,000 Rial",
      asToman.valid === true && String(asToman.lines?.find((l) => l.accountId === acct["1100"])?.debit) === "10000000",
      JSON.stringify(asToman.problems ?? asToman.lines ?? []),
    );
    await setUnit(provisioning, businessId, "rial");
    const asRial = await importCsv(page, csv, "opening-e2e.csv", YEAR.labelFrom, YEAR.insideFrom);
    check(
      "rial import reads the same file 1:1",
      asRial.valid === true && String(asRial.lines?.find((l) => l.accountId === acct["1100"])?.debit) === "1000000",
      JSON.stringify(asRial.problems ?? asRial.lines ?? []),
    );

    // 3 — the year's activity, then the close the trigger guards.
    await manualEntry(page, "2024-06-15", "هزینه E2E", [
      { accountId: expenseAccount.id, debit: PNL.expense, credit: 0 },
      { accountId: acct["1100"], debit: 0, credit: PNL.expense },
    ]);
    await manualEntry(page, "2024-07-15", "فروش E2E", [
      { accountId: acct["1100"], debit: PNL.revenue, credit: 0 },
      { accountId: revenueAccount.id, debit: 0, credit: PNL.revenue },
    ]);
    check("the year's P&L is posted", true);

    const periodsList = await apiJson(page, "GET", `/api/ledger/fiscal-years/${yearFrom}/periods`);
    check("the year has twelve periods", (periodsList.periods ?? []).length === 12);
    for (const period of periodsList.periods ?? []) {
      const patched = await apiJson(page, "PATCH", `/api/ledger/fiscal-periods/${period.id}`, {
        status: "soft_closed",
      });
      check(`period ${period.label} soft-closed`, patched?.period?.status === "soft_closed", JSON.stringify(patched));
    }
    const close = await apiJson(page, "POST", `/api/ledger/fiscal-years/${yearFrom}/close`, {});
    check(
      "the close posts the 9,000,000 Rial result",
      close.netIncome === "9000000" && Boolean(close.closingEntryId),
      JSON.stringify(close),
    );

    // 4 — the carry-forward reconciles Rial for Rial.
    const forward = await apiJson(page, "POST", "/api/ledger/opening-balances/carry-forward", {
      fromYearId: yearFrom,
      toYearId: yearTo,
    });
    check("the carry-forward proposal is balanced", forward.balanced === true && forward.idempotent === false, JSON.stringify(forward.notes ?? []));
    const lineWith = (debit, credit) =>
      (forward.lines ?? []).some((l) => l.debit === String(debit) && l.credit === String(credit));
    check("A/R carries over per the customer's balance", lineWith(OPENING.arDebit, 0));
    check("A/P carries over per the supplier's balance", lineWith(0, OPENING.apCredit));
    check("cash carries the year's net (5,000,000 − 1,000,000 + 10,000,000)", lineWith(14_000_000, 0));
    check("the year's result lands in equity, not revenue", lineWith(0, PNL.revenue - PNL.expense));

    const again = await api(page, "POST", "/api/ledger/opening-balances/carry-forward", {
      fromYearId: yearFrom,
      toYearId: yearTo,
    });
    const againBody = JSON.parse(again.text);
    check(
      "a repeated transition returns the same proposal",
      again.status === 200 && againBody.idempotent === true && againBody.setId === forward.setId,
      `status ${again.status}`,
    );

    // 5 — the workspace renders for the owner.
    await page.goto(`${BASE_URL}/accounting`, { waitUntil: "domcontentloaded" });
    const landed = await until(async () => page.url().includes("/accounting/") || page.url().endsWith("/accounting"));
    check("the accounting door lands inside the workspace", Boolean(landed), page.url());
    const body = await until(async () => {
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      return text.length > 200 ? text : null;
    });
    check("the workspace paints real content", Boolean(body), "empty body");
  } finally {
    await provisioning.end();
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} expectation(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("\nAll fiscal-opening expectations passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
