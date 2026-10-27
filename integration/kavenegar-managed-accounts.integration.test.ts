/**
 * Issue #902 acceptance, against a real database and a fake provider transport.
 *
 * What this file proves, in the issue's own terms:
 *   1. Activation produces exactly ONE child, even with repeated/duplicate
 *      enqueues, and a lost create response recovers instead of duplicating.
 *   2. A suspension keeps the mapping, the credential and the tariff snapshot
 *      (Growth off must not erase anything) while sending fails closed.
 *   3. The credential is encrypted at rest, readable only through the narrow
 *      documented bypass, and never appears in a tenant-facing view.
 *   4. An unknown funding outcome is never retried blindly: the same
 *      idempotency key cannot move provider credit twice.
 *   5. Tenancy: business B cannot read business A's account row.
 *
 * No network call is made: the adapter's transport is injected, and every
 * provider reply is a recorded fixture from the provider's documentation.
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
/** An unprivileged role, so the RLS assertions are not bypassed by `pos` (superuser). */
let probeRole: string;

let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/kavenegar/provisioning-service");
let policy: typeof import("../src/lib/kavenegar/policy");
let credentials: typeof import("../src/lib/kavenegar/credentials");
let rest: typeof import("../src/lib/kavenegar/rest");
let secrets: typeof import("../src/lib/kavenegar/secrets");
let readiness: typeof import("../src/lib/messaging-service-readiness");
let pricing: typeof import("../src/lib/kavenegar/pricing-service");
let templates: typeof import("../src/lib/kavenegar/template-service");
let reconciliation: typeof import("../src/lib/kavenegar/reconciliation-service");
let vendorCost: typeof import("../src/lib/messaging-vendor-cost");
let jwt: typeof import("../src/lib/jwt-secret");
let delivery: typeof import("../src/lib/messaging-delivery-report");

const alpha = { businessId: "", slug: "" };
const beta = { businessId: "", slug: "" };

const CHILD_KEY = "CHILDKEY1234567890ABCDEFGHIJ";

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

function childEntry(overrides: Record<string, unknown> = {}) {
  return {
    apikey: CHILD_KEY,
    localid: alpha.businessId,
    username: "bm0d5f4c7e2e634e1f",
    fullname: "Alpha",
    status: "Approved",
    remaincredit: 0,
    smsfarsicost: "150",
    smsenglishcost: "360",
    pricingname: "Price",
    mininumallowedcredit: 100000,
    assignedlines: "10004346",
    expiredate: 0,
    lastlogindate: 0,
    ...overrides,
  };
}

function ok(entries: unknown) {
  return {
    status: 200,
    body: JSON.stringify({ return: { status: 200, message: "تایید شد" }, entries }),
  };
}

function providerStatus(status: number) {
  return {
    status: 200,
    body: JSON.stringify({ return: { status, message: "provider said no" } }),
  };
}

type Step = { status: number; body: string } | Error;

function scripted(steps: Step[]) {
  const calls: { method: string; url: string; params: Record<string, string> }[] = [];
  const transport = async (request: {
    method: "GET" | "POST";
    url: string;
    params: Record<string, string>;
  }) => {
    calls.push({ method: request.method, url: request.url, params: request.params });
    const next = steps.shift();
    if (!next) throw new Error(`unexpected provider call: ${request.method} ${request.url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls };
}

function clientFor(script: ReturnType<typeof scripted>) {
  return new rest.KavenegarManagementClient("MASTERKEEPSECRET", {
    transport: script.transport,
    sleep: async () => {},
  });
}

async function seedBusiness(name: string): Promise<{ businessId: string; slug: string }> {
  const slug = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return { businessId: rows[0]!.id, slug };
}

async function enablePolicy(): Promise<void> {
  await policy.saveManagedChildPolicy({
    enabled: true,
    planId: 1484,
    minAllowedCreditRial: 100_000,
    senderLines: "10004346",
    note: "integration test",
  });
}

/**
 * Claim → process, the way the worker does.
 *
 * The queue's backoff is real (30s doubling), and a test must not sleep through
 * it: making queued rows due simulates the NEXT tick, which is exactly the
 * behaviour under test — the retry's decision, not its delay. The delay itself
 * is covered by `provisionRetryDelayMs` in the unit suite.
 */
async function runNextJobWith(client: InstanceType<typeof rest.KavenegarManagementClient>) {
  await db.query(
    `UPDATE kavenegar_provisioning_jobs SET next_attempt_at = now() WHERE state = 'queued'`,
  );
  const job = await service.claimNextProvisioningJob("test-worker");
  if (!job) return null;
  return service.processProvisioningJob(job, client);
}

async function activate(businessId: string) {
  await service.enqueueManagedAccountJob({ businessId, kind: "provision" });
  const script = scripted([ok(childEntry({ localid: businessId }))]);
  const outcome = await runNextJobWith(clientFor(script));
  expect(outcome?.result).toBe("succeeded");
  return script;
}

beforeAll(async () => {
  databaseName = `pos_kavenegar_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/kavenegar/provisioning-service");
  policy = await import("../src/lib/kavenegar/policy");
  credentials = await import("../src/lib/kavenegar/credentials");
  rest = await import("../src/lib/kavenegar/rest");
  secrets = await import("../src/lib/kavenegar/secrets");
  readiness = await import("../src/lib/messaging-service-readiness");
  pricing = await import("../src/lib/kavenegar/pricing-service");
  templates = await import("../src/lib/kavenegar/template-service");
  reconciliation = await import("../src/lib/kavenegar/reconciliation-service");
  vendorCost = await import("../src/lib/messaging-vendor-cost");
  jwt = await import("../src/lib/jwt-secret");
  delivery = await import("../src/lib/messaging-delivery-report");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  probeRole = `kvn_probe_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await db.query(`CREATE ROLE ${probeRole} NOLOGIN`);
  await db.query(
    `GRANT SELECT ON kavenegar_business_accounts, kavenegar_account_credentials,
                      kavenegar_provisioning_jobs, kavenegar_credit_transfers
       TO ${probeRole}`,
  );
}, 120_000);

afterAll(async () => {
  if (probeRole) {
    const probe = new Client({ connectionString: urlFor(databaseName) });
    await probe.connect();
    try {
      await probe.query(`DROP OWNED BY ${probeRole}`);
    } finally {
      await probe.end();
    }
    const admin = new Client({ connectionString: maintenanceUrl() });
    await admin.connect();
    try {
      await admin.query(`DROP ROLE IF EXISTS ${probeRole}`);
    } finally {
      await admin.end();
    }
  }
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
  await db.query("DELETE FROM businesses");
  await db.query("DELETE FROM kavenegar_provisioning_jobs");
  await db.query("DELETE FROM kavenegar_credit_transfers");
  await db.query("DELETE FROM platform_sms_config");
  Object.assign(alpha, await seedBusiness("Alpha"));
  Object.assign(beta, await seedBusiness("Beta"));
  await enablePolicy();
});

describe("provisioning is idempotent and recovers a lost response", () => {
  it("creates exactly one child for repeated activation requests", async () => {
    const first = await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });
    const second = await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });
    expect(first).toMatchObject({ enqueued: true, state: "pending" });
    expect(second.enqueued).toBe(false);

    const script = scripted([ok(childEntry())]);
    const outcome = await runNextJobWith(clientFor(script));
    expect(outcome).toMatchObject({ result: "succeeded" });

    const account = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(account).toMatchObject({
      business_id: alpha.businessId,
      localid: alpha.businessId,
      provision_state: "active",
      provider_status: "approved",
      plan_id: 1484,
      sms_farsi_cost_rial: "150",
      adopted: false,
    });
    expect(account?.sender_lines).toEqual(["10004346"]);
    // Exactly one add, and the request carried the policy's constraints.
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.params).toMatchObject({
      localid: alpha.businessId,
      Status: "2",
      CanUseParentLines: "false",
      Planid: "1484",
      Mininumallowedcredit: "100000",
    });

    // A later "activate" is a no-op: no second job, no second provider call.
    const again = await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });
    expect(again.enqueued).toBe(false);
    expect(await service.claimNextProvisioningJob("test-worker")).toBeNull();
  });

  it("stores the child key encrypted with a hint, and decrypts it only through the narrow bypass", async () => {
    await activate(alpha.businessId);
    const account = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    const { rows } = await db.query<{ api_key_enc: Buffer; api_key_version: number; api_key_hint: string }>(
      `SELECT api_key_enc, api_key_version, api_key_hint
         FROM kavenegar_account_credentials WHERE account_id = $1`,
      [account!.id],
    );
    expect(rows[0]?.api_key_enc).toBeInstanceOf(Buffer);
    expect(rows[0]?.api_key_enc.includes(Buffer.from(CHILD_KEY))).toBe(false);
    expect(rows[0]?.api_key_version).toBe(secrets.CURRENT_CHILD_KEY_VERSION);
    expect(rows[0]?.api_key_hint).toBe("••••GHIJ");

    const decrypted = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readAccountApiKey(account!.id),
    );
    expect(decrypted).toMatchObject({ ok: true, credential: { apiKey: CHILD_KEY } });
  });

  it("recovers an ambiguous create with fetchbylocalid instead of creating twice", async () => {
    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });

    // First attempt: the POST never got an answer.
    const first = scripted([new Error("socket hang up")]);
    expect((await runNextJobWith(clientFor(first)))?.result).toBe("retry");

    const retryState = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(retryState?.provision_state).toBe("retry_pending");
    expect(retryState?.attention_reason).toBe("outcome_unknown");

    // Second attempt: read first, adopt, never POST a second create.
    const second = scripted([ok(childEntry())]);
    expect((await runNextJobWith(clientFor(second)))?.result).toBe("succeeded");
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.method).toBe("GET");
    expect(second.calls[0]?.url).toContain("/client/fetchbylocalid.json");
    expect(second.calls[0]?.params).toEqual({ Localid: alpha.businessId });

    const active = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(active?.provision_state).toBe("active");
    expect(active?.attention_reason).toBeNull();
  });

  it("treats the provider's duplicate-localid refusal as an adoption, not an error", async () => {
    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });
    const script = scripted([providerStatus(503), ok(childEntry())]);
    expect((await runNextJobWith(clientFor(script)))?.result).toBe("succeeded");
    expect(script.calls).toHaveLength(2);
    expect(script.calls[0]?.url).toContain("/client/add.json");
    expect(script.calls[1]?.url).toContain("/client/fetchbylocalid.json");

    const active = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(active?.provision_state).toBe("active");
  });

  it("retries a username collision under a new deterministic username", async () => {
    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "provision" });

    const first = scripted([providerStatus(502)]);
    expect((await runNextJobWith(clientFor(first)))?.result).toBe("retry");
    const retry = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(retry?.provision_state).toBe("retry_pending");
    expect(retry?.attention_reason).toBe("username_collision");

    const second = scripted([providerStatus(449), ok(childEntry({ username: "bm0d5f4c7e2e634e1f1" }))]);
    expect((await runNextJobWith(clientFor(second)))?.result).toBe("succeeded");
    const add = second.calls.find((call) => call.url.endsWith("/client/add.json"));
    // Deterministic: business id compacted to 16 chars, suffixed with the attempt.
    const expected = `bm${alpha.businessId.replaceAll("-", "").slice(0, 16)}1`;
    expect(add?.params.Username).toBe(expected);
  });
});

describe("suspension keeps everything a tenant must not lose", () => {
  it("suspends in place, retains the mapping and key, and fails sending closed", async () => {
    await activate(alpha.businessId);
    const before = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );

    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "suspend" });
    const script = scripted([ok(childEntry({ status: "Removed", remaincredit: 25000 }))]);
    // `setstatus` replies with the child record; `storeSnapshot` is not called
    // by suspend, so only the status call is asserted.
    expect((await runNextJobWith(clientFor(script)))?.result).toBe("succeeded");
    expect(script.calls[0]?.url).toContain("/client/setstatus.json");
    expect(script.calls[0]?.params).toMatchObject({ ApiKey: CHILD_KEY, Status: "0" });

    const after = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(after).toMatchObject({
      id: before!.id,
      provision_state: "suspended",
      localid: alpha.businessId,
      plan_id: 1484,
    });
    expect(after?.suspended_at).not.toBeNull();
    expect(after?.provisioned_at).not.toBeNull();

    // The credential survives: reactivation must not need a new child.
    const key = await dbLib.withTenant(alpha.businessId, () => credentials.readAccountApiKey(after!.id));
    expect(key).toMatchObject({ ok: true, credential: { apiKey: CHILD_KEY } });

    // …but the marketing drain may not send through it.
    const sender = await dbLib.withTenant(alpha.businessId, () =>
      credentials.resolveBusinessSmsSender(alpha.businessId),
    );
    expect(sender).toMatchObject({ mode: "managed", apiKey: null, state: "suspended" });
  });

  it("reactivates through the same recovery path", async () => {
    await activate(alpha.businessId);
    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "suspend" });
    await runNextJobWith(clientFor(scripted([ok(childEntry())])));

    await service.enqueueManagedAccountJob({ businessId: alpha.businessId, kind: "reactivate" });
    const reactivate = scripted([ok(childEntry())]);
    expect((await runNextJobWith(clientFor(reactivate)))?.result).toBe("succeeded");
    expect(reactivate.calls[0]?.params).toMatchObject({ Status: "2" });

    // Reactivation confirms usability by reading the child back.
    const provision = scripted([ok(childEntry())]);
    expect((await runNextJobWith(clientFor(provision)))?.result).toBe("succeeded");
    expect(provision.calls[0]?.url).toContain("/client/fetchbylocalid.json");
  });
});

describe("sales-side readiness never leaks the provider", () => {
  it("describes a business with no account as preparing, in first-party words", async () => {
    const view = await dbLib.withTenant(alpha.businessId, () =>
      credentials.getTenantSmsReadiness(alpha.businessId),
    );
    expect(view).toMatchObject({ service: "messaging.sms", label: "پیامک", status: "preparing" });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toMatch(/kaveh|کاوه|apikey|localid|remaincredit/i);
  });

  it("serialises only readiness, price and switches to the tenant", async () => {
    await activate(alpha.businessId);
    const config = await dbLib.withTenant(alpha.businessId, () =>
      readiness.getTenantMessagingConfig(alpha.businessId),
    );
    expect(config.service.status).toBe("ready");
    expect(Object.keys(config).sort()).toEqual(["configured", "enabled", "rate", "service"]);
    const serialised = JSON.stringify(config);
    expect(serialised).not.toMatch(/kaveh|کاوه|apikey|sender|keyHint/i);
  });

  it("falls back to the legacy platform sender only when no account exists", async () => {
    const legacy = await dbLib.withTenant(alpha.businessId, () =>
      credentials.resolveBusinessSmsSender(alpha.businessId),
    );
    expect(legacy).toMatchObject({ mode: "legacy_platform", apiKey: null });
    expect(await dbLib.withTenant(alpha.businessId, () =>
      credentials.hasManagedSmsAccount(alpha.businessId),
    )).toBe(false);
  });
});

describe("tenancy and platform-only storage", () => {
  it("keeps one business's account row invisible from another (as an unprivileged role)", async () => {
    await activate(alpha.businessId);

    const probe = new Client({ connectionString: urlFor(databaseName) });
    await probe.connect();
    try {
      await probe.query(`SET ROLE ${probeRole}`);

      await probe.query(`SELECT set_config('app.business_id', $1, false)`, [alpha.businessId]);
      const own = await probe.query<{ count: string }>(
        `SELECT count(*) FROM kavenegar_business_accounts`,
      );
      expect(own.rows[0]?.count).toBe("1");

      await probe.query(`SELECT set_config('app.business_id', $1, false)`, [beta.businessId]);
      const crossTenant = await probe.query<{ count: string }>(
        `SELECT count(*) FROM kavenegar_business_accounts`,
      );
      expect(crossTenant.rows[0]?.count).toBe("0");

      // The credential table has no tenant policy at all, not even for the
      // business that owns the row.
      await probe.query(`SELECT set_config('app.business_id', $1, false)`, [alpha.businessId]);
      const keys = await probe.query<{ count: string }>(
        `SELECT count(*) FROM kavenegar_account_credentials`,
      );
      expect(keys.rows[0]?.count).toBe("0");

      // The provisioning queue carries a business id, so it is tenant-scoped
      // too: a scoped read sees this business's job and never the other's.
      const ownJobs = await probe.query<{ count: string }>(
        `SELECT count(*) FROM kavenegar_provisioning_jobs`,
      );
      expect(Number(ownJobs.rows[0]?.count)).toBeGreaterThan(0);
      await probe.query(`SELECT set_config('app.business_id', $1, false)`, [beta.businessId]);
      const otherJobs = await probe.query<{ count: string }>(
        `SELECT count(*) FROM kavenegar_provisioning_jobs`,
      );
      expect(otherJobs.rows[0]?.count).toBe("0");
    } finally {
      await probe.query("RESET ROLE");
      await probe.end();
    }
  });

  it("defines FORCE RLS on the account table and platform-only RLS on credentials", async () => {
    const { rows } = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('kavenegar_business_accounts', 'kavenegar_account_credentials',
                          'kavenegar_provisioning_jobs', 'kavenegar_credit_transfers',
                          'kavenegar_lookup_templates', 'kavenegar_reconciliation_runs')
        ORDER BY relname`,
    );
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const { rows: policies } = await db.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE tablename LIKE 'kavenegar%' ORDER BY tablename`,
    );
    // Only the credential table is platform-only — it carries no business_id to
    // scope by. Every table that does carry one is tenant-scoped, so a scoped
    // query cannot reach another business's row even by mistake; the platform
    // code reads them under the documented bypass.
    expect(policies).toEqual([
      { tablename: "kavenegar_account_credentials", policyname: "platform_only" },
      { tablename: "kavenegar_business_accounts", policyname: "tenant_isolation" },
      { tablename: "kavenegar_credit_transfers", policyname: "tenant_isolation" },
      { tablename: "kavenegar_lookup_templates", policyname: "tenant_isolation" },
      { tablename: "kavenegar_provisioning_jobs", policyname: "tenant_isolation" },
      { tablename: "kavenegar_reconciliation_runs", policyname: "tenant_isolation" },
    ]);
  });
});

describe("internal provider credit is idempotent", () => {
  it("never moves money twice for the same request, and marks an unknown outcome", async () => {
    await activate(alpha.businessId);
    const key = `test-transfer-${randomUUID()}`;

    // A timeout after the request left the process is UNKNOWN, not failed.
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const ambiguous = scripted([timeout]);
    const unknown = await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 25_000,
      idempotencyKey: key,
      client: clientFor(ambiguous),
    });
    expect(unknown.transfer.state).toBe("unknown");
    expect(ambiguous.calls).toHaveLength(1);

    // Retrying the same key must not call the provider at all.
    const replay = scripted([]);
    const duplicate = await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 25_000,
      idempotencyKey: key,
      client: clientFor(replay),
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.transfer.state).toBe("unknown");
    expect(replay.calls).toHaveLength(0);
  });

  it("records a confirmed transfer with the provider balance evidence", async () => {
    await activate(alpha.businessId);
    const script = scripted([ok(childEntry({ remaincredit: 25_000 }))]);
    const result = await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 25_000,
      idempotencyKey: `test-transfer-${randomUUID()}`,
      reason: "safety buffer",
      client: clientFor(script),
    });
    expect(result.transfer).toMatchObject({ state: "applied", amount_rial: "25000" });
    expect(Number(result.transfer.balance_after_rial)).toBe(25_000);
    expect(script.calls[0]?.params).toMatchObject({ Credit: "25000" });
  });
});

describe("the background sweep derives eligibility from the canonical resolver", () => {
  it("does nothing while the platform has not opted in", async () => {
    await policy.saveManagedChildPolicy({ enabled: false });
    const result = await service.runKavenegarManagedServiceTick({ client: clientFor(scripted([])) });
    expect(result).toEqual({ enqueued: 0, processed: 0, failed: 0 });
  });

  it("provisions a business whose Growth app is enabled, without a tenant request", async () => {
    const gamma = await seedBusiness("Gamma");
    await db.query(
      `INSERT INTO feature_flags (key, name, description, default_enabled)
       VALUES ('app.growth', 'رشد و بازاریابی', 'test flag', true)
       ON CONFLICT (key) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO business_features (business_id, flag_key, enabled) VALUES ($1, 'app.growth', true)`,
      [gamma.businessId],
    );

    const script = scripted([ok(childEntry({ localid: gamma.businessId }))]);
    const result = await service.runKavenegarManagedServiceTick({ client: clientFor(script) });
    expect(result).toMatchObject({ enqueued: 1, processed: 1, failed: 0 });

    const account = await dbLib.withTenant(gamma.businessId, () =>
      credentials.readBusinessAccount(gamma.businessId),
    );
    expect(account?.provision_state).toBe("active");
    expect(account?.localid).toBe(gamma.businessId);
  });

  it("suspends an account whose entitlement no longer resolves", async () => {
    await activate(alpha.businessId);
    // A commercial lapse (the business's messaging capability switched off),
    // not a platform outage: the canonical resolver denies, so the sweep must
    // stop new sends without deleting the mapping.
    await db.query(
      `INSERT INTO business_billing_overrides
         (business_id, kind, target, value_bool, reason, created_by, active)
       VALUES ($1, 'capability', 'cloud.messaging', false, 'test lapse', NULL, true)`,
      [alpha.businessId],
    );

    const script = scripted([ok(childEntry())]);
    const result = await service.runKavenegarManagedServiceTick({ client: clientFor(script) });
    expect(result.failed).toBe(0);
    expect(script.calls[0]?.url).toContain("/client/setstatus.json");

    const account = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(account?.provision_state).toBe("suspended");
    expect(account?.localid).toBe(alpha.businessId);
    // …and it becomes provisionable again the moment the lapse is lifted.
    await db.query(`DELETE FROM business_billing_overrides WHERE business_id = $1`, [alpha.businessId]);
    const sweep = scripted([ok(childEntry()), ok(childEntry())]);
    await service.runKavenegarManagedServiceTick({ client: clientFor(sweep) });
    const reactivating = await dbLib.withTenant(alpha.businessId, () =>
      credentials.readBusinessAccount(alpha.businessId),
    );
    expect(["pending", "retry_pending", "active"]).toContain(reactivating?.provision_state);
  });
});

describe("policy", () => {
  it("stores the operator's policy and parses lines strictly", async () => {
    await policy.saveManagedChildPolicy({
      enabled: false,
      planId: null,
      minAllowedCreditRial: 5_000,
      senderLines: "10004346, ۱۰۰۰۵۹۶۴۴۶, not-a-line",
      note: "rollback drill",
    });
    const saved = await policy.getManagedChildPolicy();
    expect(saved).toMatchObject({
      enabled: false,
      planId: null,
      minAllowedCreditRial: 5_000,
      senderLines: ["10004346", "1000596446"],
      note: "rollback drill",
    });

    await policy.saveManagedChildPolicy({
      fundingBufferMessages: 250,
      fundingChildCapRial: 2_000_000,
      fundingDailyCapRial: null,
      fundingMasterFloorRial: 500_000,
    });
    expect(await policy.getManagedChildPolicy()).toMatchObject({
      fundingBufferMessages: 250,
      fundingChildCapRial: 2_000_000,
      fundingDailyCapRial: null,
      fundingMasterFloorRial: 500_000,
    });
    expect(policy.isValidSenderLines("10004346, ۱۰۰۰۵۹۶۴۴۶")).toBe(true);
    expect(policy.isValidSenderLines("10004346, ops")).toBe(false);
  });
});

describe("JIT funding", () => {
  it("funds the configured buffer once, then reports healthy", async () => {
    await activate(alpha.businessId);
    await policy.saveManagedChildPolicy({
      fundingBufferMessages: 100,
      fundingChildCapRial: null,
      fundingDailyCapRial: null,
      fundingMasterFloorRial: 0,
    });

    const plan = await pricing.planBusinessFunding(alpha.businessId, {
      masterBalanceRial: 1_000_000,
    });
    // 100 messages × the dearer (English) wholesale segment of 360 Rial.
    expect(plan?.decision).toMatchObject({ action: "transfer", amountRial: 36_000 });

    const script = scripted([ok(childEntry({ remaincredit: 36_000 }))]);
    const execution = await pricing.fundManagedChild({
      businessId: alpha.businessId,
      client: clientFor(script),
      masterBalanceRial: 1_000_000,
    });
    expect(execution?.transfer?.state).toBe("applied");
    expect(script.calls[0]?.url).toContain("/client/chargecredit.json");
    expect(script.calls[0]?.params.Credit).toBe("36000");

    // The applied transfer updates the cached provider balance, so the next
    // decision does not fund the same buffer again.
    const second = await pricing.planBusinessFunding(alpha.businessId, {
      masterBalanceRial: 1_000_000,
    });
    expect(second?.decision).toMatchObject({ action: "none", reason: "healthy" });
  });

  it("follows the operator's funding strategy, not just the buffer", async () => {
    await activate(alpha.businessId);
    const at = (hour: number) => new Date(`2026-03-02T${String(hour).padStart(2, "0")}:30:00Z`);

    // manual: the buffer is set, the strategy forbids automatic transfers, so
    // not one provider call is made.
    await policy.saveManagedChildPolicy({
      fundingBufferMessages: 100,
      fundingStrategy: "manual",
    });
    const manual = scripted([]);
    const manualRun = await pricing.fundManagedChild({
      businessId: alpha.businessId,
      client: clientFor(manual),
      masterBalanceRial: 10_000_000,
      now: at(12),
    });
    expect(manualRun?.transfer).toBeNull();
    expect(manual.calls).toHaveLength(0);

    // scheduled: outside the UTC window nothing happens; inside it, the same
    // plan transfers.
    await policy.saveManagedChildPolicy({
      fundingStrategy: "scheduled",
      fundingWindowStartHour: 22,
      fundingWindowEndHour: 3,
    });
    const closed = scripted([]);
    expect(
      (
        await pricing.fundManagedChild({
          businessId: alpha.businessId,
          client: clientFor(closed),
          masterBalanceRial: 10_000_000,
          now: at(12),
        })
      )?.transfer,
    ).toBeNull();
    expect(closed.calls).toHaveLength(0);

    const open = scripted([ok(childEntry({ remaincredit: 36_000 }))]);
    const opened = await pricing.fundManagedChild({
      businessId: alpha.businessId,
      client: clientFor(open),
      masterBalanceRial: 10_000_000,
      now: at(23),
    });
    expect(opened?.transfer?.state).toBe("applied");
    expect(open.calls[0]?.url).toContain("/client/chargecredit.json");
  });

  it("low_watermark tolerates a child near its target and refills after the drop", async () => {
    await activate(alpha.businessId);
    // Prime the cached balance: 30 messages × 360 = 10,800 Rial, with a target
    // of 100 messages and a trigger at 20.
    const prime = scripted([ok(childEntry({ remaincredit: 10_800 }))]);
    await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 10_800,
      idempotencyKey: `prime-${randomUUID()}`,
      client: clientFor(prime),
    });
    await policy.saveManagedChildPolicy({
      fundingBufferMessages: 100,
      fundingStrategy: "low_watermark",
      fundingLowWatermarkMessages: 20,
    });

    const healthy = await pricing.planBusinessFunding(alpha.businessId, { masterBalanceRial: 10_000_000 });
    // 30 messages left is below the 100-message target but above the trigger.
    expect(healthy?.decision).toMatchObject({ action: "none", reason: "healthy" });

    // Now the child has spent down to 5 messages: the trigger is crossed and the
    // plan refills to the whole buffer.
    await db.query(
      `UPDATE kavenegar_business_accounts SET provider_balance_rial = $2 WHERE business_id = $1`,
      [alpha.businessId, 5 * 360],
    );
    const refill = await pricing.planBusinessFunding(alpha.businessId, { masterBalanceRial: 10_000_000 });
    expect(refill?.decision.action).toBe("transfer");
    // 95 messages × 360 = 34,200 → rounded DOWN to the provider's 1,000.
    expect(refill?.decision.action === "transfer" ? refill.decision.amountRial : 0).toBe(34_000);
  });

  it("refuses to exceed the fleet-wide daily ceiling", async () => {
    await activate(alpha.businessId);
    await policy.saveManagedChildPolicy({
      fundingBufferMessages: 100,
      fundingGlobalDailyCapRial: 20_000,
    });
    const first = scripted([ok(childEntry({ remaincredit: 36_000 }))]);
    const applied = await pricing.fundManagedChild({
      businessId: alpha.businessId,
      client: clientFor(first),
      masterBalanceRial: 10_000_000,
    });
    expect(applied?.transfer?.state).toBe("applied");

    // The fleet has now spent 36,000 of a 20,000 daily ceiling; a second child
    // may not move money at all.
    // A distinct provider username: the fixture's default is Alpha's, and the
    // table deliberately keeps usernames unique across the fleet.
    await service.enqueueManagedAccountJob({ businessId: beta.businessId, kind: "provision" });
    const betaScript = scripted([
      ok(childEntry({ localid: beta.businessId, username: "bmbeta0000000000" })),
    ]);
    expect((await runNextJobWith(clientFor(betaScript)))?.result).toBe("succeeded");
    const second = scripted([]);
    const blocked = await pricing.fundManagedChild({
      businessId: beta.businessId,
      client: clientFor(second),
      masterBalanceRial: 10_000_000,
    });
    expect(blocked?.transfer).toBeNull();
    expect(blocked?.plan.decision).toMatchObject({ action: "none", reason: "global_daily_cap_reached" });
    expect(second.calls).toHaveLength(0);
  });

  it("refuses to fund while a transfer's outcome is unresolved", async () => {
    await activate(alpha.businessId);
    await policy.saveManagedChildPolicy({ fundingBufferMessages: 100 });

    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 25_000,
      idempotencyKey: `unknown-${randomUUID()}`,
      client: clientFor(scripted([timeout])),
    });

    const plan = await pricing.planBusinessFunding(alpha.businessId, {
      masterBalanceRial: 1_000_000,
    });
    expect(plan?.decision).toMatchObject({ action: "none", reason: "unresolved_transfer" });
  });
});

describe("lookup templates", () => {
  it("keeps a tenant draft provider-free and approves it through the child account", async () => {
    await activate(alpha.businessId);

    const draft = await dbLib.withTenant(alpha.businessId, () =>
      templates.createLookupTemplate({
        businessId: alpha.businessId,
        title: "کد ورود",
        body: "کد ورود شما %token است",
        purpose: "verification",
      }),
    );
    expect(draft.state).toBe("draft");
    // The provider name is derived, not chosen by the tenant.
    expect(draft.name).toMatch(/^bmv[0-9a-f]{10}$/);

    const submit = scripted([
      ok({ id: 9901, name: draft.name, smsMessage: draft.body, approvalStatus: "Approved" }),
    ]);
    const submitted = await templates.submitLookupTemplate({
      templateId: draft.id,
      client: clientFor(submit),
    });
    expect(submitted.state).toBe("approved");
    expect(submit.calls[0]?.url).toContain("/verify/addtemplate.json");
    // The submission targets the CHILD account, never the master.
    expect(submit.calls[0]?.params.apiKey).toBe(CHILD_KEY);

    const list = scripted([
      ok([{ id: 9901, name: draft.name, smsMessage: draft.body, approvalStatus: "Rejected" }]),
    ]);
    const sync = await templates.syncLookupTemplates({
      businessId: alpha.businessId,
      client: clientFor(list),
    });
    expect(sync).toMatchObject({ updated: 1, rejected: 1 });

    const rows = await dbLib.withTenant(alpha.businessId, () =>
      templates.listLookupTemplates(alpha.businessId),
    );
    const tenantView = templates.toTenantLookupTemplates(rows);
    expect(tenantView[0]?.status).toBe("needs_action");
    const serialised = JSON.stringify(tenantView);
    expect(serialised).not.toContain(draft.name);
    expect(serialised).not.toContain("9901");
  });
});

describe("lookup template lifecycle (revise, reapprove, retire)", () => {
  async function draftTemplate(title: string, body: string) {
    return dbLib.withTenant(alpha.businessId, () =>
      templates.createLookupTemplate({ businessId: alpha.businessId, title, body, purpose: "verification" }),
    );
  }

  it("rewrites a rejected template in place and resubmits it as an UPDATE", async () => {
    await activate(alpha.businessId);
    const draft = await draftTemplate("کد ورود", "کد ورود شما %token است");

    const first = scripted([ok({ id: 9901, name: draft.name, approvalStatus: "Rejected" })]);
    await templates.submitLookupTemplate({ templateId: draft.id, client: clientFor(first) });
    // The provider refused it: the tenant now owes an edit, and a resubmit of
    // the same text must not spend another review.
    const unchanged = scripted([]);
    const noop = await templates.submitLookupTemplate({ templateId: draft.id, client: clientFor(unchanged) });
    expect(unchanged.calls).toHaveLength(0);
    expect(noop.state).toBe("rejected");

    const revised = await dbLib.withTenant(alpha.businessId, () =>
      templates.reviseLookupTemplate({
        businessId: alpha.businessId,
        templateId: draft.id,
        title: "کد ورود",
        body: "کد ورود شما %token است. معتبر ۲ دقیقه",
      }),
    );
    expect(revised.created).toBe(false);
    expect(revised.template.id).toBe(draft.id);
    expect(revised.template.state).toBe("draft");
    expect(revised.template.revision).toBe(1);
    // The provider name is the identity of the template: an edit keeps it so
    // the provider copy is updated instead of duplicated.
    expect(revised.template.name).toBe(draft.name);

    const update = scripted([ok({ templateid: "9901", name: draft.name })]);
    const resubmitted = await templates.submitLookupTemplate({
      templateId: draft.id,
      client: clientFor(update),
    });
    expect(update.calls[0]?.url).toContain("/verify/updatetemplate.json");
    expect(update.calls[0]?.params).toMatchObject({
      templateId: "9901",
      name: draft.name,
      apiKey: CHILD_KEY,
    });
    // The documented edit reply carries no approvalStatus, so an accepted edit
    // is "back in review" — never "approved".
    expect(resubmitted.state).toBe("submitted");
    expect(resubmitted.submitted_body).toBe("کد ورود شما %token است. معتبر ۲ دقیقه");
  });

  it("editing an approved template creates a successor and leaves the live one sending", async () => {
    await activate(alpha.businessId);
    const live = await draftTemplate("یادآوری نوبت", "نوبت شما %token است");
    const submit = scripted([ok({ id: 9911, name: live.name, approvalStatus: "Approved" })]);
    const approved = await templates.submitLookupTemplate({ templateId: live.id, client: clientFor(submit) });
    expect(approved.state).toBe("approved");

    const revised = await dbLib.withTenant(alpha.businessId, () =>
      templates.reviseLookupTemplate({
        businessId: alpha.businessId,
        templateId: live.id,
        title: "یادآوری نوبت",
        body: "نوبت شما %token است. لطفاً ۱۰ دقیقه قبل حاضر شوید",
      }),
    );
    expect(revised.created).toBe(true);
    expect(revised.template.id).not.toBe(live.id);
    expect(revised.template.supersedes_id).toBe(live.id);
    expect(revised.template.state).toBe("draft");

    // The old row is untouched: automation keeps working until the successor
    // is approved, which is the whole point of a versioned revision.
    const rows = await dbLib.withTenant(alpha.businessId, () =>
      templates.listLookupTemplates(alpha.businessId),
    );
    expect(rows.find((row) => row.id === live.id)?.state).toBe("approved");
  });

  it("retires a template at the provider, then in the catalog", async () => {
    await activate(alpha.businessId);
    const draft = await draftTemplate("پیام تراکنشی", "سفارش %token ثبت شد");
    const submit = scripted([ok({ id: 9931, name: draft.name, approvalStatus: "Approved" })]);
    await templates.submitLookupTemplate({ templateId: draft.id, client: clientFor(submit) });

    const drop = scripted([ok({ id: 9931, deleted: true })]);
    const archived = await templates.archiveLookupTemplate({
      templateId: draft.id,
      client: clientFor(drop),
    });
    expect(drop.calls[0]?.url).toContain("/verify/deletetemplate.json");
    expect(drop.calls[0]?.params).toMatchObject({ id: "9931", apiKey: CHILD_KEY });
    expect(archived.state).toBe("disabled");
    expect(archived.archived_at).not.toBeNull();
    expect(archived.last_sync_error).toBeNull();

    // A retired template is not editable: a tenant adds a new message instead.
    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        templates.reviseLookupTemplate({
          businessId: alpha.businessId,
          templateId: draft.id,
          title: "پیام تراکنشی",
          body: "سفارش %token ثبت شد و ارسال می‌شود",
        }),
      ),
    ).rejects.toMatchObject({ code: "template_archived" });
  });

  it("still retires the row when the provider copy is already gone, and flags a real failure", async () => {
    await activate(alpha.businessId);
    const draft = await draftTemplate("پیام دوم", "کد %token");
    const submit = scripted([ok({ id: 9941, name: draft.name, approvalStatus: "Approved" })]);
    await templates.submitLookupTemplate({ templateId: draft.id, client: clientFor(submit) });

    // 424 = not found / not editable: the state we wanted already holds.
    const gone = scripted([providerStatus(424)]);
    const first = await templates.archiveLookupTemplate({ templateId: draft.id, client: clientFor(gone) });
    expect(first.state).toBe("disabled");
    expect(first.last_sync_error).toBeNull();

    const other = await draftTemplate("پیام سوم", "کد سوم %token");
    const submitOther = scripted([ok({ id: 9951, name: other.name, approvalStatus: "Approved" })]);
    await templates.submitLookupTemplate({ templateId: other.id, client: clientFor(submitOther) });
    const refused = scripted([providerStatus(403)]);
    const second = await templates.archiveLookupTemplate({
      templateId: other.id,
      client: clientFor(refused),
    });
    // Our catalog stops using it (that is what the operator asked for) but the
    // provider copy may still exist, so the console shows a manual cleanup.
    expect(second.state).toBe("disabled");
    expect(second.last_sync_error).toBe("invalid_credentials");
  });

  it("cannot revise another business's template", async () => {
    await activate(alpha.businessId);
    const draft = await draftTemplate("کد ورود آلفا", "کد %token");
    await expect(
      dbLib.withTenant(beta.businessId, () =>
        templates.reviseLookupTemplate({
          businessId: beta.businessId,
          templateId: draft.id,
          title: "کد ورود",
          body: "کد %token تازه",
        }),
      ),
    ).rejects.toMatchObject({ code: "template_not_found" });
  });
});

describe("wholesale reconciliation", () => {
  it("stores one run per hour and reports drift with its sign", async () => {
    await activate(alpha.businessId);
    const funded = scripted([ok(childEntry({ remaincredit: 36_000 }))]);
    await service.transferManagedCredit({
      businessId: alpha.businessId,
      amountRial: 36_000,
      idempotencyKey: `fund-${randomUUID()}`,
      client: clientFor(funded),
    });

    const now = new Date();
    const okRun = await reconciliation.reconcileManagedChild({
      businessId: alpha.businessId,
      client: clientFor(scripted([ok(childEntry({ remaincredit: 36_000 }))])),
      now,
    });
    expect(okRun?.state).toBe("ok");
    expect(Number(okRun?.delta_rial)).toBe(0);

    // Same hour ⇒ same window ⇒ the unique index makes the second pass a no-op.
    const duplicate = await reconciliation.reconcileManagedChild({
      businessId: alpha.businessId,
      client: clientFor(scripted([ok(childEntry({ remaincredit: 36_000 }))])),
      now: new Date(now.getTime() + 5 * 60_000),
    });
    expect(duplicate).toBeNull();

    const drift = await reconciliation.reconcileManagedChild({
      businessId: alpha.businessId,
      client: clientFor(scripted([ok(childEntry({ remaincredit: 30_000 }))])),
      now: new Date(now.getTime() + 2 * 60 * 60_000),
    });
    expect(drift?.state).toBe("drift");
    expect(Number(drift?.delta_rial)).toBe(-6_000);
  });
});

describe("wholesale cost reaches the commercial ledger", () => {
  const providers = { sms: "kavenegar", email: "smtp" };

  it("posts one event per accepted send, keyed to its outbox row", async () => {
    const outboxId = randomUUID();
    const record = () =>
      dbLib.withTenant(alpha.businessId, () =>
        vendorCost.recordSendVendorCost({
          businessId: alpha.businessId,
          outboxId,
          channel: "sms",
          provider: "kavenegar",
          costRial: 1_733,
        }),
      );

    expect(await record()).toBe(true);
    // A retried drain replays the same row: the unique (provider,
    // source_reference) in 0177 means the second write changes nothing.
    expect(await record()).toBe(false);

    const { rows } = await db.query<{
      business_id: string;
      provider: string;
      meter_key: string;
      amount_rial: string;
      source_reference: string;
    }>(
      `SELECT business_id, provider, meter_key, amount_rial, source_reference
         FROM billing_vendor_cost_events
        WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("kavenegar");
    expect(rows[0].meter_key).toBe("messaging.sms_segment");
    expect(rows[0].source_reference).toBe(`message_outbox:${outboxId}`);
    expect(Number(rows[0].amount_rial)).toBe(1_733);
  });

  it("records nothing when the adapter did not report a cost", async () => {
    const recorded = await dbLib.withTenant(alpha.businessId, () =>
      vendorCost.recordSendVendorCost({
        businessId: alpha.businessId,
        outboxId: randomUUID(),
        channel: "email",
        provider: "smtp",
        costRial: null,
      }),
    );
    expect(recorded).toBe(false);
    const { rows } = await db.query(
      `SELECT id FROM billing_vendor_cost_events WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows).toHaveLength(0);
  });

  it("backfills an already-sent row exactly once, then has nothing left to do", async () => {
    const campaign = await db.query<{ id: string }>(
      `INSERT INTO message_campaigns (business_id, channel, name, status)
       VALUES ($1, 'sms', 'Wholesale backfill', 'completed') RETURNING id`,
      [alpha.businessId],
    );
    const recipient = await db.query<{ id: string }>(
      `INSERT INTO message_recipients (business_id, campaign_id, channel, address, body)
       VALUES ($1, $2, 'sms', '+989120000000', 'سلام') RETURNING id`,
      [alpha.businessId, campaign.rows[0].id],
    );
    await db.query(
      `INSERT INTO message_outbox
         (business_id, recipient_id, campaign_id, status, provider_cost_rial, sent_at)
       VALUES ($1, $2, $3, 'sent', 2500, now())`,
      [alpha.businessId, recipient.rows[0].id, campaign.rows[0].id],
    );

    const first = await vendorCost.backfillSendVendorCosts({ providers });
    expect(first.recorded).toBe(1);

    const second = await vendorCost.backfillSendVendorCosts({ providers });
    expect(second).toMatchObject({ scanned: 0, recorded: 0 });

    const { rows } = await db.query<{ amount_rial: string }>(
      `SELECT amount_rial FROM billing_vendor_cost_events WHERE business_id = $1`,
      [alpha.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount_rial)).toBe(2_500);
  });
});

describe("delivery report (acceptance is not delivery)", () => {
  it("counts each outcome per business and orders the failing one first", async () => {
    const campaign = async (businessId: string, name: string) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO message_campaigns (business_id, channel, name, status)
         VALUES ($1, 'sms', $2, 'completed') RETURNING id`,
        [businessId, name],
      );
      return rows[0].id;
    };
    const outbox = async (businessId: string, campaignId: string, status: string) => {
      const recipient = await db.query<{ id: string }>(
        `INSERT INTO message_recipients (business_id, campaign_id, channel, address, body)
         VALUES ($1, $2, 'sms', '+989120000000', 'سلام') RETURNING id`,
        [businessId, campaignId],
      );
      await db.query(
        `INSERT INTO message_outbox
           (business_id, recipient_id, campaign_id, status, last_attempt_at)
         VALUES ($1, $2, $3, $4, now())`,
        [businessId, recipient.rows[0].id, campaignId, status],
      );
    };

    const alphaCampaign = await campaign(alpha.businessId, "Alpha");
    await outbox(alpha.businessId, alphaCampaign, "sent");
    await outbox(alpha.businessId, alphaCampaign, "delivered");
    await outbox(alpha.businessId, alphaCampaign, "queued");

    // Beta fails twice out of three attempts, so it must sort first.
    const betaCampaign = await campaign(beta.businessId, "Beta");
    await outbox(beta.businessId, betaCampaign, "failed");
    await outbox(beta.businessId, betaCampaign, "failed");
    await outbox(beta.businessId, betaCampaign, "sent");

    const report = await delivery.getDeliveryReport({ sinceHours: 24 });
    expect(report[0]).toMatchObject({
      businessId: beta.businessId,
      sent: 1,
      delivered: 0,
      failed: 2,
      pending: 0,
    });
    expect(delivery.deliveryHealth(report[0])).toBe("attention");

    const alphaRow = report.find((row) => row.businessId === alpha.businessId);
    expect(alphaRow).toMatchObject({ sent: 1, delivered: 1, failed: 0, pending: 1 });
    expect(delivery.deliveryHealth(alphaRow!)).toBe("degraded");
  });
});

describe("the canonical resolver reads the app-availability vocabulary", () => {
  it("does not deny an available app, and does deny a maintenance one", async () => {
    const entitlement = await import("../src/lib/entitlement-service");

    // Regression for the issue #902 discovery: the resolver compared against
    // "enabled" (a state migration 0128 never created), so every app row that
    // said "available" was denied as platform_unavailable — and managed
    // provisioning could never see an entitled business.
    await db.query(`UPDATE app_availability SET state = 'available' WHERE app_key = 'growth'`);
    const available = await dbLib.withTenant(alpha.businessId, () =>
      entitlement.resolveBusinessCapability(alpha.businessId, "cloud.messaging"),
    );
    expect(available.reason).not.toBe("platform_unavailable");

    await db.query(`UPDATE app_availability SET state = 'maintenance' WHERE app_key = 'growth'`);
    const maintenance = await dbLib.withTenant(alpha.businessId, () =>
      entitlement.resolveBusinessCapability(alpha.businessId, "cloud.messaging"),
    );
    expect(maintenance.allowed).toBe(false);
    expect(maintenance.reason).toBe("platform_unavailable");

    await db.query(`UPDATE app_availability SET state = 'available' WHERE app_key = 'growth'`);
  });
});

describe("scheduled provider traffic follows the opt-in switch", () => {
  it("runs no funding or reconciliation pass while the policy is off", async () => {
    await activate(alpha.businessId);
    await policy.saveManagedChildPolicy({ fundingBufferMessages: 100 });
    await policy.saveManagedChildPolicy({ enabled: false });

    const funding = await pricing.runManagedFundingTick({
      client: clientFor(scripted([])),
      masterBalanceRial: 1_000_000,
    });
    expect(funding).toEqual({ planned: 0, funded: 0, failed: 0 });

    const sweep = await reconciliation.runManagedReconciliationSweep({
      client: clientFor(scripted([])),
    });
    expect(sweep).toEqual({ checked: 0, drifted: 0, incomplete: 0 });
  });
});
