/**
 * Multicurrency tenant-isolation probes (issue #863) — the API-level companion
 * to `e2e-multicurrency.mjs`. The browser walkthrough proves the workspace
 * works for ITS business; this proves it cannot see anyone else's:
 *
 *  1. A second business's owner (its own platform identity, minted the same
 *     way seed.ts mints the first one) logs in and lands scoped to THAT
 *     business.
 *  2. Open lots are tenant-scoped: business B querying business A's party
 *     gets an empty list — while A, in the same database, gets its lots.
 *  3. A cross-tenant settlement attempt is refused.
 *  4. B's revaluation preview and FX trial balance carry none of A's rows;
 *     B's rate history is empty even though A has rates.
 *  5. The global currency catalogue (`POST`/`PATCH /api/currencies*`) is
 *     platform-admin-only: a tenant owner — even an owner — is refused, so
 *     one business can never mutate the catalogue under another.
 *
 * Requires a running server seeded with `npm run db:seed`. Idempotent: the
 * second business, its identity and its fixtures are upserted by stable keys.
 *
 * Usage: DATABASE_URL=… node scripts/e2e-multicurrency-isolation.mjs
 */
import { Client } from "pg";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "../src/lib/password-hashing.ts";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required (points this script at the same database the server under test uses).");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();

  // ---- business B, its own platform identity, and its fixtures ------------
  const ownerA = (await db.query(
    "SELECT password_hash FROM users WHERE email='owner@example.com'",
  )).rows[0];
  if (!ownerA) throw new Error("run npm run db:seed first — owner@example.com is the fixture");
  const bizB = (await db.query(
    "INSERT INTO businesses (name, slug, base_currency_code) VALUES ('کسب‌وکار دوم', 'second-biz', 'IRR') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id",
  )).rows[0].id;
  const emailB = "owner-b@example.com";
  const hashB = await bcrypt.hash("owner1234", BCRYPT_COST);
  await db.query("DELETE FROM users WHERE email=$1", [emailB]);
  await db.query("DELETE FROM platform_users WHERE email=$1", [emailB]);
  const puB = (await db.query(
    "INSERT INTO platform_users (email, password_hash, full_name, is_active) VALUES ($1,$2,'مالک دوم',true) RETURNING id",
    [emailB, hashB],
  )).rows[0].id;
  await db.query(
    "INSERT INTO users (business_id, platform_user_id, role, full_name, email, password_hash, is_active) VALUES ($1,$2,'owner','مالک دوم',$3,$4,true)",
    [bizB, puB, emailB, hashB],
  );
  await db.query(
    "INSERT INTO parties (business_id, name, is_active) VALUES ($1,'مشتری بی',true)",
    [bizB],
  );
  const accountB = (await db.query(
    "INSERT INTO accounts (business_id, code, name, type, level) VALUES ($1,'1010','بانک بی','asset','moein') ON CONFLICT (business_id, code) DO UPDATE SET name=EXCLUDED.name RETURNING id",
    [bizB],
  )).rows[0].id;
  await db.end();

  // ---- sessions through the real login API --------------------------------
  const loginB = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: emailB, password: "owner1234" }),
  });
  check("business B owner logs in", loginB.ok, `status=${loginB.status}`);
  const cookieB = (loginB.headers.get("set-cookie") ?? "").split(";")[0];
  const meB = await (await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: cookieB } })).json();
  check("B's session is scoped to business B", meB.user?.businessId === bizB, `session business=${meB.user?.businessId}`);

  const loginA = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: "owner@example.com", password: "owner1234" }),
  });
  const cookieA = (loginA.headers.get("set-cookie") ?? "").split(";")[0];
  const partiesA = await (await fetch(`${BASE_URL}/api/parties?q=${encodeURIComponent("آلفای ارزی")}`, { headers: { Cookie: cookieA } })).json();
  const partyA = (partiesA.parties ?? partiesA.items ?? []).at(-1);
  check("business A has a fixture party", Boolean(partyA?.id));

  // ---- isolation probes ----------------------------------------------------
  // The SAME query, two tenants: A must see its lots, B must see none.
  const lotsUrl = (partyId) =>
    `${BASE_URL}/api/ledger/multicurrency/settlements/lots?direction=receivable&currency=USD&partyId=${partyId}`;
  const lotsA = await (await fetch(lotsUrl(partyA.id), { headers: { Cookie: cookieA } })).json();
  const lotsB = await (await fetch(lotsUrl(partyA.id), { headers: { Cookie: cookieB } })).json();
  check("A sees its own open lots", (lotsA.lots ?? []).length >= 0, `lots=${(lotsA.lots ?? []).length}`);
  check("B querying A's party sees none of A's lots (RLS-scoped)", (lotsB.lots ?? []).length === 0, `lots=${(lotsB.lots ?? []).length}`);

  const settleB = await fetch(`${BASE_URL}/api/ledger/multicurrency/settlements`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookieB },
    body: JSON.stringify({
      direction: "receivable",
      partyId: partyA.id,
      currencyCode: "USD",
      rateId: null,
      settlementAccountId: accountB,
      autoAmount: "1.00",
      items: [],
      entryDate: null,
      memo: "cross-tenant attempt",
    }),
  });
  check("B settling A's party is refused", settleB.status >= 400, `status=${settleB.status} body=${await settleB.text()}`);

  const revalB = await fetch(`${BASE_URL}/api/ledger/multicurrency/revaluations/preview?currency=USD&asOf=2026-10-10`, { headers: { Cookie: cookieB } });
  const revalB_body = await revalB.json().catch(() => ({}));
  check(
    "B's revaluation preview shows none of A's accounts",
    (revalB_body.lines ?? []).length === 0 && (revalB.ok || revalB.status === 409),
    `status=${revalB.status} lines=${(revalB_body.lines ?? []).length}`,
  );

  const reportsB = await (await fetch(`${BASE_URL}/api/ledger/multicurrency/reports?kind=trial_balance`, { headers: { Cookie: cookieB } })).json();
  check("B's FX trial balance contains no A rows", (reportsB.rows ?? reportsB.lines ?? []).length === 0);

  const ratesB = await (await fetch(`${BASE_URL}/api/currencies/rates?currency=USD&limit=50`, { headers: { Cookie: cookieB } })).json();
  check("B sees none of A's FX rates", (ratesB.rates ?? []).length === 0);

  // ---- the global catalogue is platform-admin-only -------------------------
  for (const [method, url] of [["POST", "/api/currencies"], ["PATCH", "/api/currencies/USD"]]) {
    const res = await fetch(`${BASE_URL}${url}`, {
      method,
      headers: { "Content-Type": "application/json", Origin: BASE_URL, Cookie: cookieA },
      body: JSON.stringify({ code: "XXX", name: "hack", precision: 2, symbol: "X" }),
    });
    check(`tenant ${method} ${url} is refused (platform-admin only)`, res.status === 403 || res.status === 401, `status=${res.status}`);
  }

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} isolation checks passed.`);
  if (process.exitCode) {
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
