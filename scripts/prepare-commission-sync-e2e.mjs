/** Disposable CI bootstrap, before either app starts: copy a real initial tenant snapshot to a separate site DB. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
const url = new URL(process.env.DATABASE_URL ?? "");
assert.ok(process.env.COMMISSION_E2E_SEED === "1" && ["127.0.0.1", "localhost"].includes(url.hostname), "Disposable loopback database required");
assert.equal(url.pathname, "/pos", "This CI bootstrap only clones the disposable pos database");
const file = ".cache/commission-sync-e2e.json";
execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-commission-e2e.ts", file], { stdio: "inherit" });
const fixture = JSON.parse(readFileSync(file, "utf8"));
// Per-business and revocable branch identities, never the shared REMOTE_SYNC_TOKEN bypass.
const token = randomBytes(32).toString("hex");
const branchToken = randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query("INSERT INTO server_sync_tokens (business_id,token_hash) VALUES ($1,$2)", [fixture.businessId, hash(token)]);
  const device = await client.query("INSERT INTO site_devices (business_id,location_id,display_name) VALUES ($1,$2,'Commission transport acceptance') RETURNING id", [fixture.businessId, fixture.locationId]);
  await client.query("INSERT INTO site_sync_credentials (site_device_id,business_id,token_hash) VALUES ($1,$2,$3)", [device.rows[0].id, fixture.businessId, hash(branchToken)]);
} finally { await client.end(); }
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  // Must run before the app holds connections. Never terminate a live session to force a copy.
  await admin.query("CREATE DATABASE commission_site_e2e WITH TEMPLATE pos");
} finally { await admin.end(); }
const siteUrl = new URL(url); siteUrl.pathname = "/commission_site_e2e";
const site = new pg.Client({ connectionString: siteUrl.toString() });
await site.connect();
try {
  await site.query(`INSERT INTO settings (business_id,location_id,key,value) VALUES ($1,NULL,'deployment.profile','{"profile":"hybrid"}')
    ON CONFLICT (business_id,location_id,key) DO UPDATE SET value=EXCLUDED.value`, [fixture.businessId]);
} finally { await site.end(); }
writeFileSync(file, JSON.stringify({ ...fixture, token, branchToken }), { mode: 0o600 });
console.log("Prepared separate central/site databases from the same initial fixture; no payout has been made yet.");
