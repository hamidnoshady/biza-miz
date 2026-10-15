/** Controlled two-instance acceptance: real central HTTP, separate site DB and production pull client. No mocked transport. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { getPool, query, withTenant } from "../src/lib/db";
import { getServerSyncState, runServerPull } from "../src/lib/server-sync";
import { setSetting, SETTING_KEYS } from "../src/lib/settings";

type Event = { id: number; txid: string; clientEventId: string; type: string; locationId: string | null; businessId: string; schemaVersion: number };
async function main() {
  const database = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(process.env.COMMISSION_E2E_SEED === "1" && ["127.0.0.1", "localhost"].includes(database.hostname));
  assert.equal(database.pathname, "/commission_site_e2e");
  assert.equal(process.env.DEPLOYMENT_ROLE, "site");
  const fixture = JSON.parse(readFileSync(".cache/commission-sync-e2e.json", "utf8"));
  const central = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
  const site = process.env.COMMISSION_SITE_URL ?? "http://127.0.0.1:3001";
  const role = await query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
  assert.equal(role.rows[0].rolsuper, false);
  assert.equal(role.rows[0].rolbypassrls, false);
  async function feed(token: string, extra = ""): Promise<Event[]> {
    const events: Event[] = [];
    let after = 0, tx = "0";
    for (let page = 0; page < 100; page++) {
      const response = await fetch(`${central}/api/server-sync/pull?after=${after}&afterTx=${tx}&limit=200${extra}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      const rows = (await response.json()).events as Event[];
      assert.ok(rows.every((event) => event.businessId === fixture.businessId), "a bearer must never change its business scope");
      if (!rows.length) return events;
      events.push(...rows);
      const last = rows.at(-1)!; after = last.id; tx = last.txid;
    }
    throw new Error("Feed did not reach its end");
  }
  const invalid = await fetch(`${central}/api/server-sync/pull`, { headers: { Authorization: "Bearer invalid-test-credential" } });
  assert.equal(invalid.status, 401);
  const events = await feed(fixture.token, "&businessId=00000000-0000-0000-0000-000000000000");
  const payouts = events.filter((event) => event.type.startsWith("commission.payout."));
  assert.equal(payouts.filter((event) => event.type === "commission.payout.recorded").length, 2);
  assert.equal(payouts.filter((event) => event.type === "commission.payout.reversed").length, 1);
  assert.ok(payouts.every((event) => event.locationId === null && event.schemaVersion === 1));
  assert.equal((await feed(fixture.branchToken)).filter((event) => event.type.startsWith("commission.")).length, 0, "branch credentials intentionally exclude business-scope envelopes");

  const browser = await chromium.launch({ headless: true, executablePath: process.env.VISUAL_CHROMIUM_PATH || undefined });
  try {
    const context = await browser.newContext();
    const login = await context.request.post(`${site}/api/auth/login`, { data: { email: fixture.accountant.email, password: fixture.password } });
    assert.equal(login.status(), 200);
    const page = await context.newPage();
    await page.goto(`${site}/accounting/payroll`);
    const refused = await page.evaluate(async () => {
      const response = await fetch("/api/commission/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      return { status: response.status, body: await response.json() };
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "WRONG_EXECUTION_TARGET", "an authenticated accountant must not create a second Growth authority on a site");
  } finally { await browser.close(); }

  await withTenant(fixture.businessId, async () => {
    const snapshot = async () => (await query(`SELECT
      (SELECT count(*)::int FROM commission_settlement_payouts WHERE business_id=$1) AS payouts,
      (SELECT count(*)::int FROM journal_entries WHERE business_id=$1) AS journals`, [fixture.businessId])).rows[0];
    const before = await snapshot();
    assert.equal(before.payouts, 0, "the site snapshot predates central payouts");
    const config = { enabled: true, token: fixture.token, batchSize: 2, remoteUrl: "http://127.0.0.1:59999", locationId: fixture.locationId };
    await setSetting(fixture.businessId, SETTING_KEYS.serverSyncConfig, config);
    const original = await getServerSyncState(fixture.businessId);
    assert.equal((await runServerPull(fixture.businessId)).status, "error");
    const failed = await getServerSyncState(fixture.businessId);
    assert.equal(failed.lastPulledEventId, original.lastPulledEventId);
    assert.ok(failed.pullFailures > 0 && failed.lastPullError);
    assert.equal((await runServerPull(fixture.businessId)).status, "backoff");
    await setSetting(fixture.businessId, SETTING_KEYS.serverSyncConfig, { ...config, remoteUrl: central });
    // Honour the actual production retry deadline: no reset, fake clock or reduced backoff.
    const wait = Math.max(0, Date.parse(failed.pullNextAttemptAt!) - Date.now());
    assert.ok(wait <= 36_000);
    await new Promise((resolve) => setTimeout(resolve, wait + 1));
    async function drain() {
      for (let page = 0; page < 100; page++) {
        const result = await runServerPull(fixture.businessId);
        assert.equal(result.status, "ok", JSON.stringify(result));
        if (result.status === "ok" && result.pulled === 0) return;
      }
      throw new Error("Production pull client did not finish");
    }
    await drain();
    const recovered = await getServerSyncState(fixture.businessId);
    assert.equal(recovered.pullFailures, 0); assert.equal(recovered.lastPullError, null);
    assert.ok(recovered.lastPulledEventId && recovered.lastPulledTxid && recovered.lastPullSuccessAt);
    const effects = async () => (await query<{ client_event_id: string; status: string; effect_type: string }>(
      "SELECT client_event_id,status,effect_type FROM sync_domain_effects WHERE business_id=$1 AND event_type LIKE 'commission.payout.%' ORDER BY client_event_id", [fixture.businessId])).rows;
    const applied = await effects();
    assert.deepEqual(applied.map((row) => row.client_event_id).sort(), payouts.map((event) => event.clientEventId).sort());
    assert.ok(applied.every((row) => row.status === "applied" && row.effect_type === "cloud_owned"));
    // Exercise a real recovery re-read through HTTP. Only the test cursor is rewound;
    // immutable source events, financial rows and idempotency guards are untouched.
    await setSetting(fixture.businessId, SETTING_KEYS.serverSyncState, { ...recovered, lastPulledEventId: 0, lastPulledTxid: "0" });
    await drain();
    assert.deepEqual(await effects(), applied, "duplicate delivery must retain one durable effect per envelope");
    assert.deepEqual(await snapshot(), before, "acknowledging cloud-owned payouts must not pay them a second time on site");
    const dead = await query<{ n: number }>("SELECT count(*)::int AS n FROM sync_event_dead_letters WHERE business_id=$1 AND event_type LIKE 'commission.payout.%'", [fixture.businessId]);
    assert.equal(dead.rows[0].n, 0);
    await setSetting(fixture.businessId, SETTING_KEYS.serverSyncConfig, { ...config, enabled: false, remoteUrl: central });
  });
  console.log("Commission two-instance HTTP transport passed: scope, authority, real failure/backoff/recovery, durable cloud-owned acknowledgments and duplicate delivery.");
}
main().catch((error) => {
  console.error(`::error::${String(error?.stack ?? error).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  process.exitCode = 1;
}).finally(() => getPool().end());
