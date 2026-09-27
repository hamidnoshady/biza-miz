/**
 * PLATFORM↔CMS billing: signed ingest and entitlement outbox push (mock CMS).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required");

let databaseName: string;
let db: Client;
let runtime: typeof import("../src/lib/billing/runtime");
let dbLib: typeof import("../src/lib/db");

const BID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  process.env.JWT_SECRET ||= "integration-test-secret";
  process.env.INTEGRATIONS_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  databaseName = `pos_billing_cms_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  runtime = await import("../src/lib/billing/runtime");
  dbLib = await import("../src/lib/db");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(`INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'تست', 'billing-cms', 'free')`, [BID]);
  await db.query(
    `INSERT INTO eshobe_cms_connections (business_id, site_id, site_domain, base_url, api_key_ciphertext)
     VALUES ($1, 'site-billing', 'billing.example', 'https://cms.example', 'cipher')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  vi.unstubAllGlobals();
});

describe("signed usage ingest", () => {
  it("accepts a v1 signed batch through the route handler contract", async () => {
    const { createBillingServiceCredential } = runtime;
    const { signBillingBody } = await import("../src/lib/billing/auth/sign");
    const { verifyBillingServiceRequest } = await import("../src/lib/billing/auth/verify-service-request");

    const cred = await createBillingServiceCredential("cms-test");
    const body = JSON.stringify({
      source: "eshobe-cms",
      contractVersion: 1,
      events: [
        {
          eventId: "cms:site-billing:bandwidth:1",
          siteId: "site-billing",
          meterKey: "cms.bandwidth_bytes",
          quantity: 10,
          unit: "byte",
          periodStart: "2026-09-26T13:00:00.000Z",
          periodEnd: "2026-09-26T14:00:00.000Z",
          occurredAt: "2026-09-26T13:00:00.000Z",
        },
      ],
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signBillingBody(cred.secret, timestamp, body);
    const verified = await verifyBillingServiceRequest(
      { keyId: cred.keyId, timestamp, signature, rawBody: body, legacy: false },
      "billing.usage.write",
    );
    expect(verified.ok).toBe(true);
    const ingest = await runtime.ingestCmsUsageBatchBody(JSON.parse(body));
    if ("error" in ingest) throw new Error(ingest.error);
    expect(ingest.results[0]).toMatchObject({ status: "accepted" });
  });

});

describe("entitlement outbox", () => {
  it("enqueues and marks sent after a mocked CMS push", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { encryptSecret, resolveEncryptionKey } = await import("../src/lib/integrations/secrets");
    const encKey = resolveEncryptionKey(process.env);
    await db.query(`INSERT INTO platform_cms_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
    await db.query(
      `UPDATE platform_cms_config
          SET base_url = 'https://cms.example',
              api_key_ciphertext = $1,
              billing_entitlement_key_id = 'billing_key_1',
              billing_entitlement_secret_ciphertext = $2`,
      [encryptSecret("cms-platform-api-key", encKey), encryptSecret("entitlement-secret", encKey)],
    );

    const { enqueueCmsEntitlementDelivery, runCmsEntitlementOutboxTick } = await import(
      "../src/lib/billing/entitlement/outbox-service"
    );
    const version = await enqueueCmsEntitlementDelivery(BID, "site-billing");
    expect(version).toBeGreaterThan(0);
    const delivered = await runCmsEntitlementOutboxTick();
    expect(delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
  });
});
