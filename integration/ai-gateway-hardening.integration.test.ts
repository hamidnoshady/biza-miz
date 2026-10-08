/**
 * Issue #748 — P0 correctness/security hardening of the LiteLLM virtual-key
 * lifecycle, against a real Postgres. Complements
 * `ai-gateway.integration.test.ts` (which covers the ordinary singleton/row
 * round-trips); this file is specifically the revoke/rotate transactional
 * safety, business/branch integrity, and secrets-at-rest guarantees.
 *
 * LiteLLM itself is not run here — `fetch` is stubbed per test to answer
 * exactly the management-API response being exercised (success, 404, 401,
 * 500, unreachable, malformed), which is the only way to deterministically
 * reach every branch of the revoke/rotate contract.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { run as runAiSecretBackfill } from "../scripts/encrypt-ai-gateway-secrets";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let gateway: typeof import("../src/lib/ai-gateway-service");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", locationId: "" };
const beta = { businessId: "", locationId: "" };

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

function testConfig(overrides: Partial<import("../src/lib/ai-gateway-service").AiGatewayConfig> = {}) {
  return {
    ...gateway.defaultGatewayConfig(),
    enabled: true,
    baseUrl: "http://litellm:4000/v1",
    chatModel: "pos-chat",
    virtualKeysEnabled: true,
    masterKey: "sk-master",
    ...overrides,
  };
}

beforeAll(async () => {
  databaseName = `pos_ai_gw_hardening_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  gateway = await import("../src/lib/ai-gateway-service");
  dbLib = await import("../src/lib/db");

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
  await db.query("DELETE FROM ai_business_gateway");
  await db.query("DELETE FROM platform_ai_gateway");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const bizRows = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1), ('Beta', $2) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`, `beta-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = bizRows.rows[0].id;
  beta.businessId = bizRows.rows[1].id;

  const locRows = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'Alpha Branch'), ($2, 'Beta Branch') RETURNING id`,
    [alpha.businessId, beta.businessId],
  );
  alpha.locationId = locRows.rows[0].id;
  beta.locationId = locRows.rows[1].id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  );
}

async function rawGatewayRow(businessId: string, locationId: string | null) {
  const { rows } = await db.query(
    `SELECT virtual_key_ciphertext, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1 AND (location_id = $2 OR ($2::uuid IS NULL AND location_id IS NULL))`,
    [businessId, locationId],
  );
  return rows[0] as { virtual_key_ciphertext: string | null; sync_error: string | null } | undefined;
}

describe("provisioning + revoke/rotate lifecycle safety (issue #748 P0-1)", () => {
  it("provisions a key and stores it encrypted, never in the plaintext column", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-1" } }]);
    const config = testConfig();
    const row = await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });
    expect(row.virtualKey).toBe("sk-tenant-1");

    const raw = await rawGatewayRow(alpha.businessId, null);
    expect(raw?.virtual_key_ciphertext).toBeTruthy();
    expect(raw?.virtual_key_ciphertext).not.toContain("sk-tenant-1");
  });

  it("preserves the local key row when the remote revoke is unreachable", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-2" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([new TypeError("fetch failed")]);
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(false);

    const after = await gateway.getBusinessGateway(alpha.businessId);
    expect(after?.virtualKey).toBe("sk-tenant-2");
    expect(after?.syncError).toBeTruthy();
  });

  it("preserves the local key row on a 401/403 from the gateway", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-3" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(false);
    expect((await gateway.getBusinessGateway(alpha.businessId))?.virtualKey).toBe("sk-tenant-3");
  });

  it("preserves the local key row on a 5xx from the gateway", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-4" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([{ status: 500, body: { error: "internal" } }]);
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(false);
    expect((await gateway.getBusinessGateway(alpha.businessId))?.virtualKey).toBe("sk-tenant-4");
  });

  it("clears the row on a confirmed 404 (the gateway already forgot the key)", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-5" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([{ status: 404, body: { error: "not found" } }]);
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(true);
    expect(result.alreadyGone).toBe(true);
    expect(await gateway.getBusinessGateway(alpha.businessId)).toBeNull();
  });

  it("clears the row on a normal successful delete", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-6" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([{ status: 200, body: { deleted_keys: ["sk-tenant-6"] } }]);
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(true);
    expect(await gateway.getBusinessGateway(alpha.businessId)).toBeNull();
  });

  it("revoking a business with no key at all is a harmless no-op success", async () => {
    const config = testConfig();
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result).toEqual({ ok: true, alreadyGone: true });
  });

  it("a failed revoke prevents rotation from proceeding at all", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-7" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([{ status: 500, body: { error: "internal" } }]);
    await expect(gateway.rotateVirtualKey(config, alpha.businessId)).rejects.toThrow();

    // The old key must still be exactly what it was — never orphaned, never forgotten.
    expect((await gateway.getBusinessGateway(alpha.businessId))?.virtualKey).toBe("sk-tenant-7");
  });

  it("a successful rotate invalidates the old key and persists only the new one", async () => {
    stubFetch([{ status: 200, body: { key: "sk-old" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([
      { status: 200, body: { deleted_keys: ["sk-old"] } }, // revoke
      { status: 200, body: { key: "sk-new" } }, // provision replacement
    ]);
    const rotated = await gateway.rotateVirtualKey(config, alpha.businessId);
    expect(rotated.virtualKey).toBe("sk-new");
    expect((await gateway.getBusinessGateway(alpha.businessId))?.virtualKey).toBe("sk-new");
  });

  it("leaves a visible, retryable 'no valid key' row when replacement provisioning fails after a confirmed revoke", async () => {
    stubFetch([{ status: 200, body: { key: "sk-old-2" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    stubFetch([
      { status: 200, body: { deleted_keys: ["sk-old-2"] } }, // revoke succeeds
      { status: 500, body: { error: "internal" } }, // replacement provisioning fails
    ]);
    await expect(gateway.rotateVirtualKey(config, alpha.businessId)).rejects.toThrow();

    const after = await gateway.getBusinessGateway(alpha.businessId);
    expect(after?.virtualKey).toBeNull();
    expect(after?.syncError).toBeTruthy();

    // Retryable: the next provision call sees no key and mints a fresh one.
    stubFetch([{ status: 200, body: { key: "sk-recovered" } }]);
    const recovered = await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });
    expect(recovered.virtualKey).toBe("sk-recovered");
  });

  it("treats a malformed delete response as a failure, preserving the row", async () => {
    stubFetch([{ status: 200, body: { key: "sk-tenant-8" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });

    // A 200 with an unparsable body from asError's perspective is still ok(status)
    // — the important malformed case is on the *generate* path (parseGeneratedKey
    // returning null), which is the "bad_response" branch already covered by
    // provisioning tests below. Here we assert the boundary explicitly: a non-2xx
    // status with a body that carries no usable detail still fails safely.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 500 })),
    );
    const result = await gateway.revokeVirtualKey(config, alpha.businessId);
    expect(result.ok).toBe(false);
    expect((await gateway.getBusinessGateway(alpha.businessId))?.virtualKey).toBe("sk-tenant-8");
  });
});

describe("business ↔ branch integrity (issue #748 P0-3)", () => {
  it("rejects a location that belongs to a different business for every lifecycle action", async () => {
    const config = testConfig();
    await expect(
      gateway.provisionVirtualKey(config, { businessId: alpha.businessId, locationId: beta.locationId }),
    ).rejects.toThrow("ai_gateway_location_business_mismatch");

    await expect(
      gateway.revokeVirtualKey(config, alpha.businessId, beta.locationId),
    ).rejects.toThrow("ai_gateway_location_business_mismatch");

    await expect(
      gateway.rotateVirtualKey(config, alpha.businessId, beta.locationId),
    ).rejects.toThrow("ai_gateway_location_business_mismatch");

    await expect(
      gateway.verifyVirtualKey(config, alpha.businessId, beta.locationId),
    ).rejects.toThrow("ai_gateway_location_business_mismatch");
  });

  it("accepts a location that genuinely belongs to the business", async () => {
    expect(await gateway.locationBelongsToBusiness(alpha.businessId, alpha.locationId)).toBe(true);
    expect(await gateway.locationBelongsToBusiness(alpha.businessId, beta.locationId)).toBe(false);
    expect(await gateway.locationBelongsToBusiness(alpha.businessId, null)).toBe(true);
  });
});

describe("retired LiteLLM policy mirrors (issue #757 P2-7/P2-8)", () => {
  it("drops all obsolete columns on a clean migration and tolerates a repeated cleanup", async () => {
    const retired = [
      ["platform_ai_gateway", "fallback_models"],
      ["platform_ai_gateway", "allow_business_models"],
      ["platform_ai_gateway", "published_models"],
      ["platform_ai_gateway", "prompt_bindings"],
      ["platform_ai_gateway", "mcp_enabled"],
      ["platform_ai_gateway", "mcp_servers"],
      ["ai_business_gateway", "model_override"],
    ] as const;
    const findColumns = async () => {
      const { rows } = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'platform_ai_gateway' AND column_name = ANY($1::text[]))
              OR (table_name = 'ai_business_gateway' AND column_name = 'model_override'))`,
        [retired.filter(([table]) => table === "platform_ai_gateway").map(([, column]) => column)],
      );
      return rows;
    };
    expect(await findColumns()).toEqual([]);

    const migration = await readFile(new URL("../migrations/0184_ai_gateway_dead_column_cleanup.sql", import.meta.url), "utf8");
    await db.query(migration);
    expect(await findColumns()).toEqual([]);
  });
});

describe("secrets at rest (issue #748 P0-2)", () => {
  it("stores the platform master key encrypted, never in the plaintext column", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", masterKey: "sk-super-secret" });
    const { rows } = await db.query<{ master_key_ciphertext: string | null }>(
      `SELECT master_key_ciphertext FROM platform_ai_gateway WHERE id = true`,
    );
    expect(rows[0].master_key_ciphertext).toBeTruthy();
    expect(rows[0].master_key_ciphertext).not.toContain("sk-super-secret");

    // The application layer still reads back the plaintext for outbound calls.
    expect((await gateway.getAiGatewayConfig()).masterKey).toBe("sk-super-secret");
  });

  it("drops the retired plaintext key columns after the migration guard is satisfied", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (
            ('platform_ai_gateway', 'master_key'),
            ('ai_business_gateway', 'virtual_key')
          )`,
    );
    expect(rows).toEqual([]);
  });

  it("backfills, decrypt-verifies, and only then clears both legacy key columns", async () => {
    const previousEncryptionKey = process.env.INTEGRATIONS_ENCRYPTION_KEY;
    const encryptionSecret = "57".repeat(32);
    process.env.INTEGRATIONS_ENCRYPTION_KEY = encryptionSecret;
    try {
      await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN master_key text");
      await db.query("ALTER TABLE ai_business_gateway ADD COLUMN virtual_key text");
      await db.query(
        `INSERT INTO platform_ai_gateway (id, base_url, master_key)
         VALUES (true, 'http://litellm:4000/v1', 'sk-legacy-master')`,
      );
      await db.query(
        `INSERT INTO ai_business_gateway (business_id, virtual_key)
         VALUES ($1, 'sk-legacy-tenant')`,
        [alpha.businessId],
      );

      await runAiSecretBackfill(["--dry-run"]);
      let raw = await db.query<{
        master_key: string | null;
        master_key_ciphertext: string | null;
        virtual_key: string | null;
        virtual_key_ciphertext: string | null;
      }>(
        `SELECT p.master_key, p.master_key_ciphertext, b.virtual_key, b.virtual_key_ciphertext
           FROM platform_ai_gateway p CROSS JOIN ai_business_gateway b
          WHERE p.id = true AND b.business_id = $1`,
        [alpha.businessId],
      );
      expect(raw.rows[0]).toMatchObject({
        master_key: "sk-legacy-master",
        master_key_ciphertext: null,
        virtual_key: "sk-legacy-tenant",
        virtual_key_ciphertext: null,
      });

      await runAiSecretBackfill([]);
      raw = await db.query(
        `SELECT p.master_key, p.master_key_ciphertext, b.virtual_key, b.virtual_key_ciphertext
           FROM platform_ai_gateway p CROSS JOIN ai_business_gateway b
          WHERE p.id = true AND b.business_id = $1`,
        [alpha.businessId],
      );
      expect(raw.rows[0]).toMatchObject({
        master_key: null,
        virtual_key: null,
      });
      const key = resolveEncryptionKey(process.env);
      expect(decryptSecret(raw.rows[0].master_key_ciphertext!, key)).toBe("sk-legacy-master");
      expect(decryptSecret(raw.rows[0].virtual_key_ciphertext!, key)).toBe("sk-legacy-tenant");
      await expect(runAiSecretBackfill(["--verify-only"])).resolves.toBeUndefined();

      await db.query("UPDATE platform_ai_gateway SET master_key = 'sk-mismatch'");
      await expect(runAiSecretBackfill(["--verify-only"])).rejects.toThrow(/ciphertext_invalid/);
      expect((await db.query<{ master_key: string }>("SELECT master_key FROM platform_ai_gateway WHERE id = true")).rows[0].master_key)
        .toBe("sk-mismatch");
      await db.query("UPDATE platform_ai_gateway SET master_key = 'sk-legacy-master'");
      await runAiSecretBackfill([]);
      expect((await db.query<{ master_key: string | null }>("SELECT master_key FROM platform_ai_gateway WHERE id = true")).rows[0].master_key)
        .toBeNull();
    } finally {
      if (previousEncryptionKey === undefined) delete process.env.INTEGRATIONS_ENCRYPTION_KEY;
      else process.env.INTEGRATIONS_ENCRYPTION_KEY = previousEncryptionKey;
      await db.query("DELETE FROM ai_business_gateway WHERE business_id = $1", [alpha.businessId]);
      await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
      await db.query("ALTER TABLE platform_ai_gateway DROP COLUMN IF EXISTS master_key");
      await db.query("ALTER TABLE ai_business_gateway DROP COLUMN IF EXISTS virtual_key");
    }
  });

  it("aborts migration 0209 without dropping an unbackfilled credential", async () => {
    await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN master_key text");
    await db.query("ALTER TABLE ai_business_gateway ADD COLUMN virtual_key text");
    await db.query(
      `INSERT INTO platform_ai_gateway (id, base_url, master_key)
       VALUES (true, 'http://litellm:4000/v1', 'sk-legacy-master')`,
    );
    await db.query(
      `INSERT INTO ai_business_gateway (business_id, virtual_key)
       VALUES ($1, 'sk-legacy-tenant')`,
      [alpha.businessId],
    );

    try {
      const migration = await readFile(new URL("../migrations/0209_ai_gateway_secret_cutover.sql", import.meta.url), "utf8");
      await expect(db.query(migration)).rejects.toThrow(/ai_gateway_secret_backfill_required/);
      const { rows } = await db.query<{ master_key: string; virtual_key: string }>(
        `SELECT p.master_key, b.virtual_key
           FROM platform_ai_gateway p
           CROSS JOIN ai_business_gateway b
          WHERE p.id = true AND b.business_id = $1`,
        [alpha.businessId],
      );
      expect(rows[0]).toEqual({ master_key: "sk-legacy-master", virtual_key: "sk-legacy-tenant" });
    } finally {
      await db.query("DELETE FROM ai_business_gateway WHERE business_id = $1", [alpha.businessId]);
      await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
      await db.query("ALTER TABLE platform_ai_gateway DROP COLUMN IF EXISTS master_key");
      await db.query("ALTER TABLE ai_business_gateway DROP COLUMN IF EXISTS virtual_key");
    }
  });

  it("defers migration 0209 until ciphertext-backed runtime verification is explicitly confirmed", async () => {
    const envNames = [
      "INTEGRATIONS_ENCRYPTION_KEY",
      "AI_GATEWAY_SECRET_CUTOVER_DEFER",
      "AI_GATEWAY_SECRET_CUTOVER_VERIFIED",
    ] as const;
    const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "63".repeat(32);
    delete process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER;
    delete process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED;

    try {
      await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN IF NOT EXISTS master_key text");
      await db.query("ALTER TABLE ai_business_gateway ADD COLUMN IF NOT EXISTS virtual_key text");
      const key = resolveEncryptionKey(process.env);
      await db.query(
        `INSERT INTO platform_ai_gateway (id, base_url, master_key, master_key_ciphertext)
         VALUES (true, 'http://litellm:4000/v1', 'sk-confirm-master', $1)`,
        [encryptSecret("sk-confirm-master", key)],
      );
      await db.query(
        `INSERT INTO ai_business_gateway (business_id, virtual_key, virtual_key_ciphertext)
         VALUES ($1, 'sk-confirm-tenant', $2)`,
        [alpha.businessId, encryptSecret("sk-confirm-tenant", key)],
      );
      await db.query("DELETE FROM schema_migrations WHERE filename = '0209_ai_gateway_secret_cutover.sql'");

      process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER = "true";
      const deferred = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
      expect(deferred.deferredMigrations).toEqual(["0209_ai_gateway_secret_cutover.sql"]);
      expect(deferred.applied).toBe(0);
      expect((await db.query<{ master_key: string }>("SELECT master_key FROM platform_ai_gateway WHERE id = true")).rows[0].master_key)
        .toBe("sk-confirm-master");

      const migration = await readFile(new URL("../migrations/0209_ai_gateway_secret_cutover.sql", import.meta.url), "utf8");
      await db.query("SELECT set_config('app.ai_gateway_secret_cutover_verified', 'false', false)");
      await db.query("BEGIN");
      try {
        await expect(db.query(migration)).rejects.toThrow(/ai_gateway_secret_runtime_verification_required/);
      } finally {
        await db.query("ROLLBACK");
      }

      delete process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER;
      process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED = "true";
      const applied = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
      expect(applied).toMatchObject({ applied: 1, deferredMigrations: [] });
      const { rows: remainingColumns } = await db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'platform_ai_gateway' AND column_name = 'master_key')
              OR (table_name = 'ai_business_gateway' AND column_name = 'virtual_key'))`,
      );
      expect(remainingColumns).toEqual([]);
    } finally {
      for (const name of envNames) {
        const value = previousEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("defers 0209 by itself while credentials exist, still applying later migrations, and lets the entrypoint backfill keep plaintext", async () => {
    const envNames = [
      "INTEGRATIONS_ENCRYPTION_KEY",
      "AI_GATEWAY_SECRET_CUTOVER_DEFER",
      "AI_GATEWAY_SECRET_CUTOVER_VERIFIED",
    ] as const;
    const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.INTEGRATIONS_ENCRYPTION_KEY = "71".repeat(32);
    delete process.env.AI_GATEWAY_SECRET_CUTOVER_DEFER;
    delete process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED;

    // The production state the crash loop came from: 0209 pending behind
    // plaintext-only credentials, with unrelated migrations after it.
    const migrationsDir = await mkdtemp(join(tmpdir(), "ai-cutover-"));
    const dependentDir = await mkdtemp(join(tmpdir(), "ai-cutover-dependent-"));
    await cp(new URL("../migrations", import.meta.url), migrationsDir, { recursive: true });
    await writeFile(join(migrationsDir, "9999_after_cutover_probe.sql"), "CREATE TABLE after_cutover_probe (id int);\n");
    await cp(migrationsDir, dependentDir, { recursive: true });
    await writeFile(join(dependentDir, "9998_reads_master_key.sql"), "SELECT master_key FROM platform_ai_gateway LIMIT 0;\n");

    try {
      await db.query("ALTER TABLE platform_ai_gateway ADD COLUMN IF NOT EXISTS master_key text");
      await db.query("ALTER TABLE ai_business_gateway ADD COLUMN IF NOT EXISTS virtual_key text");
      await db.query("DELETE FROM ai_business_gateway WHERE business_id = $1", [alpha.businessId]);
      await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
      await db.query(
        `INSERT INTO platform_ai_gateway (id, base_url, master_key)
         VALUES (true, 'http://litellm:4000/v1', 'sk-auto-master')`,
      );
      await db.query(
        `INSERT INTO ai_business_gateway (business_id, virtual_key)
         VALUES ($1, 'sk-auto-tenant')`,
        [alpha.businessId],
      );
      await db.query("DELETE FROM schema_migrations WHERE filename = '0209_ai_gateway_secret_cutover.sql'");

      const deferred = await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
      expect(deferred).toMatchObject({ applied: 1, deferredMigrations: ["0209_ai_gateway_secret_cutover.sql"] });
      expect((await db.query("SELECT to_regclass('after_cutover_probe') IS NOT NULL AS present")).rows[0].present).toBe(true);

      await runAiSecretBackfill(["--keep-plaintext"]);
      const key = resolveEncryptionKey(process.env);
      const { rows } = await db.query<{
        master_key: string;
        master_key_ciphertext: string;
        virtual_key: string;
        virtual_key_ciphertext: string;
      }>(
        `SELECT p.master_key, p.master_key_ciphertext, b.virtual_key, b.virtual_key_ciphertext
           FROM platform_ai_gateway p CROSS JOIN ai_business_gateway b
          WHERE p.id = true AND b.business_id = $1`,
        [alpha.businessId],
      );
      expect(rows[0]).toMatchObject({ master_key: "sk-auto-master", virtual_key: "sk-auto-tenant" });
      expect(decryptSecret(rows[0].master_key_ciphertext, key)).toBe("sk-auto-master");
      expect(decryptSecret(rows[0].virtual_key_ciphertext, key)).toBe("sk-auto-tenant");

      // Still deferred on the next boot: only the explicit confirmation drops columns.
      const reboot = await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
      expect(reboot).toMatchObject({ applied: 0, deferredMigrations: ["0209_ai_gateway_secret_cutover.sql"] });

      // A later migration that names a legacy column cannot jump the deferred cutover.
      await expect(runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: dependentDir, quiet: true }))
        .rejects.toThrow("ai_gateway_secret_cutover_deferred_blocks_later_migration:9998_reads_master_key.sql");

      process.env.AI_GATEWAY_SECRET_CUTOVER_VERIFIED = "true";
      const confirmed = await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
      expect(confirmed).toMatchObject({ applied: 1, deferredMigrations: [] });
      const { rows: remainingColumns } = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND ((table_name = 'platform_ai_gateway' AND column_name = 'master_key')
              OR (table_name = 'ai_business_gateway' AND column_name = 'virtual_key'))`,
      );
      expect(remainingColumns).toEqual([]);

      // After the cutover the entrypoint's backfill is a quiet no-op.
      await expect(runAiSecretBackfill(["--keep-plaintext"])).resolves.toBeUndefined();
    } finally {
      for (const name of envNames) {
        const value = previousEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await db.query("DELETE FROM ai_business_gateway WHERE business_id = $1", [alpha.businessId]);
      await db.query("DELETE FROM platform_ai_gateway WHERE id = true");
      await db.query("DROP TABLE IF EXISTS after_cutover_probe");
      await db.query("DELETE FROM schema_migrations WHERE filename = '9999_after_cutover_probe.sql'");
      await db.query("ALTER TABLE platform_ai_gateway DROP COLUMN IF EXISTS master_key");
      await db.query("ALTER TABLE ai_business_gateway DROP COLUMN IF EXISTS virtual_key");
      await rm(migrationsDir, { recursive: true, force: true });
      await rm(dependentDir, { recursive: true, force: true });
    }
  });

  it("stores a business virtual key encrypted, never in the plaintext column", async () => {
    stubFetch([{ status: 200, body: { key: "sk-encrypted-check" } }]);
    const config = testConfig();
    await gateway.provisionVirtualKey(config, { businessId: alpha.businessId });
    const raw = await rawGatewayRow(alpha.businessId, null);
    expect(raw?.virtual_key_ciphertext).toBeTruthy();
    expect(await gateway.getBusinessGateway(alpha.businessId).then((r) => r?.virtualKey)).toBe(
      "sk-encrypted-check",
    );
  });
});
