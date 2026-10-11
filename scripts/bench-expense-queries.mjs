#!/usr/bin/env node
/**
 * Query-plan evidence for the expense register (issue #832 §19).
 *
 * The register now filters by tenant, date range, expense account, payment
 * account, branch and register state, searches with `ILIKE '%…%'`, orders by
 * `(expense_date DESC, created_at DESC, id DESC)`, pages on that same keyset and
 * computes `SUM`/`COUNT` over the whole filtered set. `0030` gave `expenses`
 * exactly one index — `idx_expenses_business (business_id)` — which answers
 * "whose rows are these" and nothing else.
 *
 * The issue's rule is "do not add speculative indexes without query-plan
 * evidence", so this script produces that evidence instead of asserting it in a
 * comment. It builds a disposable copy of the two tables the register reads
 * (`CREATE TABLE … AS SELECT … WITH NO DATA` keeps the production column types
 * without inheriting foreign keys, RLS or the tenant GUC), fills it with a
 * representative volume, and runs the register's real queries twice: once on the
 * pre-#832 index set, once after creating each candidate. A candidate is only
 * justified when the plan actually changes — a `Seq Scan` becoming an index or
 * bitmap scan, or the explicit `Sort` node disappearing.
 *
 * Usage:
 *   DATABASE_URL=postgres://pos:pos@localhost:5432/pos \
 *     node scripts/bench-expense-queries.mjs --rows 200000
 *
 * Flags:
 *   --rows N         expenses to generate (default 200000)
 *   --branches N     locations per business (default 2)
 *   --businesses N   tenants in the table (default 4, so a plan cannot cheat by
 *                    reading one tenant out of a single-tenant heap)
 *   --keep           leave the bench schema in place for follow-up EXPLAINs
 *   --json PATH      also write the raw plans to a file
 *
 * Nothing outside `expense_bench` is touched, and that schema is dropped at the
 * end unless `--keep`.
 */
import { Client } from "pg";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);

const ROWS = Math.max(1000, Number(flag("rows", 200_000)) || 200_000);
const BRANCHES = Math.max(1, Number(flag("branches", 2)) || 2);
const BUSINESSES = Math.max(1, Number(flag("businesses", 4)) || 4);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required (start the dev server: `npm run db:dev:start`).");
  process.exit(1);
}

const SCHEMA = "expense_bench";
/** Expense accounts per tenant in the fixture — a mid-size customised chart. */
const ACCOUNTS_PER_BUSINESS = 40;

/*
 * Ids are derived from the fixture's own integers, so an expense's account_id is
 * the same uuid as the accounts row it belongs to without a lookup join:
 * tenant `n` is `1111…n`, its account `n·1000 + k` is `2222…`, branch `k` is
 * `3333…`. Deterministic ids also make a re-run comparable.
 */
const BIZ_SQL = "'11111111-0000-0000-0000-' || lpad((%s)::text, 12, '0')";
const ACCT_SQL = "'22222222-0000-0000-0000-' || lpad((%s)::text, 12, '0')";
const BRANCH_SQL = "'33333333-0000-0000-0000-' || lpad((%s)::text, 12, '0')";
const biz = (expr) => `(${BIZ_SQL.replace("%s", expr)})::uuid`;
const acct = (expr) => `(${ACCT_SQL.replace("%s", expr)})::uuid`;
const branch = (expr) => `(${BRANCH_SQL.replace("%s", expr)})::uuid`;

/**
 * The register's queries, from `src/lib/expense-service.ts` (`SELECT_EXPENSE`,
 * `TOTALS_SQL`) with the filter values filled in — the shapes the screen
 * actually issues, not a synthetic worst case.
 */
function queries(ctx) {
  const { biz, from, to, account, payment, branch } = ctx;
  return [
    {
      name: "first page, no filters (the screen's default read)",
      sql: `SELECT e.id, e.expense_date, e.created_at
              FROM expenses e JOIN accounts a ON a.id = e.account_id
             WHERE e.business_id = '${biz}'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "keyset page 2 (the cursor walk — what deep paging costs)",
      sql: `SELECT e.id, e.expense_date, e.created_at
              FROM expenses e JOIN accounts a ON a.id = e.account_id
             WHERE e.business_id = '${biz}'
               AND (e.expense_date, e.created_at, e.id) < (CURRENT_DATE - 30, '${ctx.cursorAt}', '${ctx.cursorId}')
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "server-side totals over the whole filtered set (SUM/COUNT)",
      sql: `SELECT SUM(e.amount - e.vat_amount) AS total,
                   SUM(e.vat_amount) AS vat,
                   SUM(e.amount) AS paid,
                   COUNT(*) AS count
              FROM expenses e
             WHERE e.business_id = '${biz}'
               AND e.expense_date >= '${from}' AND e.expense_date <= '${to}'`,
    },
    {
      name: "date-windowed page",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}'
               AND e.expense_date >= '${from}' AND e.expense_date <= '${to}'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "category-account filter",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}' AND e.account_id = '${account}'
               AND e.expense_date >= '${from}' AND e.expense_date <= '${to}'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "payment-account filter",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}' AND e.payment_account_id = '${payment}'
               AND e.expense_date >= '${from}' AND e.expense_date <= '${to}'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "branch filter",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}' AND e.location_id = '${branch}'
               AND e.expense_date >= '${from}' AND e.expense_date <= '${to}'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "register-state filter (active only)",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}'
               AND e.reversed_at IS NULL AND e.reverses_expense_id IS NULL
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
    {
      name: "free-text search (memo/vendor) — unindexed by design",
      sql: `SELECT e.id FROM expenses e
             WHERE e.business_id = '${biz}' AND e.memo ILIKE '%سوپرمارکت 7%'
             ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
             LIMIT 101`,
    },
  ];
}

/** The candidates migration 0211 creates, in the order the register needs them. */
const CANDIDATES = [
  {
    name: "idx_expenses_business_date_created",
    ddl: `CREATE INDEX IF NOT EXISTS idx_expenses_business_date_created
            ON expenses (business_id, expense_date DESC, created_at DESC, id DESC)`,
    for: "the ordered-list read and every keyset page",
  },
  {
    name: "idx_expenses_business_account_date",
    ddl: `CREATE INDEX IF NOT EXISTS idx_expenses_business_account_date
            ON expenses (business_id, account_id, expense_date DESC, created_at DESC, id DESC)`,
    for: "the category-account filter",
  },
  {
    name: "idx_expenses_business_payment_account_date",
    ddl: `CREATE INDEX IF NOT EXISTS idx_expenses_business_payment_account_date
            ON expenses (business_id, payment_account_id, expense_date DESC, created_at DESC, id DESC)`,
    for: "the payment-account filter",
  },
  {
    name: "idx_expenses_business_location_date",
    ddl: `CREATE INDEX IF NOT EXISTS idx_expenses_business_location_date
            ON expenses (business_id, location_id, expense_date DESC, created_at DESC, id DESC)`,
    for: "the branch filter",
  },
];

const client = new Client({ connectionString: DATABASE_URL, statement_timeout: 0 });

function planSummary(rows) {
  const text = rows.map((r) => r["QUERY PLAN"]);
  // Both spellings matter: `Seq Scan on expenses e` and
  // `Index Only Scan using idx_expenses_business_date_created on expenses e`.
  const scanLine = text.find((t) => /\bScan\b/.test(t) && /expenses/.test(t)) ?? "no expenses scan";
  const sort = text.some((t) => /^\s*->\s+Sort/.test(t) || /^\s*Sort/.test(t)) ? "Sort" : "no Sort";
  const ms = Number(text.find((t) => /Execution Time:/.test(t))?.match(/Execution Time: ([\d.]+)/)?.[1] ?? NaN);
  const buffers = text.find((t) => /Buffers:/.test(t))?.trim().replace(/^.*Buffers:\s*/, "") ?? "";
  return {
    scan: scanLine.trim().replace(/^->\s*/, "").replace(/\(rows.*$/, "").trim(),
    sort,
    buffers,
    ms,
  };
}

async function explain(sql) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
  return { sql: sql.trim().replace(/\s+/g, " "), text: rows.map((r) => r["QUERY PLAN"]).join("\n"), ...planSummary(rows) };
}

async function runSet(label, ctx) {
  const out = [];
  for (const q of queries(ctx)) {
    const r = await explain(q.sql);
    out.push({ name: q.name, ...r });
    console.log(`  ${q.name}\n      ${r.scan} | ${r.sort} | ${Number.isFinite(r.ms) ? r.ms.toFixed(1) : "?"} ms | ${r.buffers || "buffers n/a"}`);
  }
  console.log(`  (${label})`);
  return out;
}

async function main() {
  await client.connect();
  console.log(
    `expense register benchmark — ${ROWS.toLocaleString("en-US")} expenses, ` +
      `${BRANCHES} branches, ${BUSINESSES} tenants, schema ${SCHEMA}`,
  );

  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path = ${SCHEMA}, public`);

  await client.query(`CREATE TABLE accounts AS SELECT * FROM public.accounts WITH NO DATA`);
  await client.query(`CREATE TABLE expenses AS SELECT * FROM public.expenses WITH NO DATA`);

  await client.query(`
    INSERT INTO accounts (id, business_id, code, name, type, is_active, level)
    SELECT ${acct("b * 1000 + a")},
           ${biz("b")},
           lpad((5000 + a)::text, 4, '0'), 'حساب ' || a, 'expense'::account_type, true, 'tafsili'::account_level
      FROM generate_series(1, ${BUSINESSES}) b, generate_series(1, ${ACCOUNTS_PER_BUSINESS}) a
  `);

  /*
   * Dates spread over two years, `created_at` tied to the date, and 2% of the
   * rows sharing one timestamp: that block is a bulk import, and it is the tie
   * the keyset's `id DESC` exists to break, so the fixture has to contain it.
   */
  await client.query(`
    INSERT INTO expenses (id, business_id, location_id, account_id, payment_account_id,
                          amount, vat_amount, expense_date, vendor, memo, created_at, reference)
    SELECT gen_random_uuid(),
           ${biz("f.biz")},
           CASE WHEN ${BRANCHES} > 1 THEN ${branch("f.br")} ELSE NULL END,
           ${acct("f.biz * 1000 + f.acc")},
           ${acct("f.biz * 1000 + f.pay")},
           f.cents,
           CASE WHEN f.vat THEN f.cents / 10 ELSE 0 END,
           f.day,
           CASE WHEN f.grocery THEN 'سوپرمارکت ' || f.vendor ELSE NULL END,
           'خرید ' || f.line || ' — ثبت خودکار دستیار برای پر کردن متن',
           f.day::timestamp AT TIME ZONE 'UTC' + CASE WHEN f.tie THEN interval '0' ELSE f.jitter END,
           'EXP-' || f.g
      FROM (
        -- The random draws are one projection per row: a LATERAL subquery with no
        -- outer reference is shared, which would hand every row the same date.
        SELECT g,
               ((random() * ${BUSINESSES - 1})::int + 1) AS biz,
               ((random() * ${ACCOUNTS_PER_BUSINESS})::int + 1) AS acc,
               ((random() * ${ACCOUNTS_PER_BUSINESS})::int + 1) AS pay,
               ((random() * ${Math.max(1, BRANCHES - 1)})::int + 1) AS br,
               (100000 + (random() * 9900000)::int * 100)::bigint AS cents,
               (random() < 0.3) AS vat,
               (CURRENT_DATE - (random() * 720)::int) AS day,
               (random() < 0.5) AS grocery,
               ((random() * 40)::int + 1) AS vendor,
               ((random() * 200)::int + 1) AS line,
               (random() * interval '20 hours') AS jitter,
               (random() < 0.02) AS tie
          FROM generate_series(1, ${ROWS}) g
      ) f
  `);

  // A slice of rows are reversed, so the register-state predicate and the signed
  // SUM have something real to chew on.
  await client.query(`
    UPDATE expenses SET reversed_at = now() - interval '1 day'
     WHERE id IN (SELECT id FROM expenses ORDER BY random() LIMIT GREATEST(1, (${ROWS} / 100)::int))
  `);

  await client.query(`ANALYZE expenses`);
  await client.query(`ANALYZE accounts`);

  // The busiest tenant, so the plans measure a real register rather than a
  // quarter-filled one. (`min()` is not defined over uuid, hence the GROUP BY.)
  const { rows: tenantRows } = await client.query(`
    SELECT business_id::text AS biz FROM expenses GROUP BY 1 ORDER BY count(*) DESC LIMIT 1
  `);
  const tenant = tenantRows[0]?.biz;
  if (!tenant) throw new Error("fixture produced no rows");
  const { rows: sample } = await client.query(`
    SELECT e.business_id::text AS biz,
           e.account_id::text AS account,
           e.payment_account_id::text AS payment,
           e.location_id::text AS branch,
           e.expense_date::text AS cursor_date,
           e.created_at AS cursor_at,
           e.id::text AS cursor_id
      FROM expenses e
     WHERE e.business_id = '${tenant}'
     ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
     LIMIT 100
  `);
  const last = sample[sample.length - 1];
  const anyRow = sample[0];
  if (!last) throw new Error("fixture produced no rows for the chosen tenant");
  const from = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const ctx = {
    biz: anyRow.biz,
    from,
    to,
    account: anyRow.account,
    payment: anyRow.payment,
    branch: last.branch ?? anyRow.account,
    cursorAt: new Date(last.cursor_at).toISOString(),
    cursorId: last.cursor_id,
  };
  console.log(`  tenant ${ctx.biz} · ${ROWS / BUSINESSES} rows/tenant · cursor anchor ${ctx.cursorAt} ${ctx.cursorId}`);

  console.log("\n=== BEFORE — only 0030's idx_expenses_business ===");
  const before = await runSet("no candidate indexes", ctx);

  /*
   * Each candidate is measured on its own, against the same baseline: created,
   * measured, dropped. A cumulative run answers the wrong question — once the
   * first index makes the ordered read an index scan, every later candidate looks
   * like "no change" while it may be the one that fixes the *filtered* reads.
   */
  const report = [];
  for (const candidate of CANDIDATES) {
    await client.query(candidate.ddl);
    await client.query(`ANALYZE expenses`);
    console.log(`\n=== ONLY ${candidate.name} ===`);
    const set = await runSet(candidate.name, ctx);
    await client.query(`DROP INDEX IF EXISTS ${candidate.name}`);
    const improved = [];
    set.forEach((r, i) => {
      const was = before[i];
      /*
       * Two things have to be true to call an index justified for a query: the
       * plan must actually *name* it (an index-only/index scan `using` it, or a
       * bitmap index scan on it), and the read must be materially cheaper — a
       * removed `Sort` node, or at least a 3× drop in execution time. Naming it
       * alone would count a plan that picked the index and lost; being faster
       * alone would count run-to-run noise.
       */
      // `Index Scan using <name>`, `Index Only Scan using <name>` and
      // `Bitmap Index Scan on <name>` are the three ways a plan admits to it.
      const namesIt = new RegExp(`\\b(using|on) ${candidate.name}\\b`, "i").test(r.text);
      const droppedSort = was.sort === "Sort" && r.sort !== "Sort";
      const muchFaster =
        Number.isFinite(r.ms) && Number.isFinite(was.ms) && was.ms > 0 && r.ms < was.ms / 3;
      if (namesIt && (droppedSort || muchFaster)) {
        improved.push(`${r.name} (${was.ms.toFixed(1)} ms → ${r.ms.toFixed(1)} ms${droppedSort ? ", Sort removed" : ""})`);
      }
    });
    console.log(
      `  → ${candidate.name}: ${improved.length ? `JUSTIFIED (${improved.length} query/queries)` : "not used by any plan — drop it"}`,
    );
    for (const line of improved) console.log(`      · ${line}`);
    report.push({ candidate: candidate.name, for: candidate.for, justifiedBy: improved, plans: set });
  }

  // The shipped state: all four together, which is what the migration leaves.
  for (const candidate of CANDIDATES) await client.query(candidate.ddl);
  await client.query(`ANALYZE expenses`);
  console.log("\n=== SHIPPED — all four candidate indexes (what 0211 leaves) ===");
  const shipped = await runSet("all candidates", ctx);

  console.log(
    "\nThe free-text `ILIKE '%…%'` query stays a scan of the tenant's rows by design:\n" +
      "this schema has no trigram index to reuse anywhere, and adding an extension\n" +
      "for one register is a bigger decision than an index (issue #832 §19 asks for\n" +
      "reuse of existing trigram infrastructure — there is none). The tenant-leading\n" +
      "index still bounds the scan to one business's rows, which is all the WHERE\n" +
      "clause can promise.",
  );

  if (flag("json", null)) {
    writeFileSync(
      flag("json"),
      JSON.stringify({ rows: ROWS, branches: BRANCHES, businesses: BUSINESSES, before, report, shipped }, null, 2),
    );
    console.log(`\nraw plans → ${flag("json")}`);
  }

  if (!has("keep")) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    console.log(`dropped ${SCHEMA}`);
  } else {
    console.log(`kept ${SCHEMA} for follow-up EXPLAINs`);
  }
  await client.end();
}

main().catch(async (err) => {
  console.error(err.message ?? err);
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  } catch {
    /* the connection is already gone */
  }
  process.exit(1);
});
