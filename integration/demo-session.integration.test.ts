import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";
import {
  provisionBusiness,
  provisionDemoSession,
  type DemoTemplate,
} from "../src/lib/business-provisioning";
import { closeDatabasePool, query, withTenant } from "../src/lib/db";
import { createDemoStartKey } from "../src/lib/demo-session-credentials";
import { resolveDemoSession } from "../src/lib/demo-sessions";
import { getBusiness, hardDeleteBusiness, resetBusiness, setBusinessStatus } from "../src/lib/platform-service";

const rootUrl = process.env.DATABASE_URL;
if (!rootUrl) throw new Error("DATABASE_URL is required for database integration tests");

const suffix = randomUUID().replaceAll("-", "");
const database = `pos_demo_${suffix}`;
const role = `pos_demo_role_${suffix}`;
const databaseId = randomUUID();
const password = "local-demo-test-password";
const template: DemoTemplate = {
  industry: "watch",
  version: "test-v1",
  seed: async ({ businessId }) => {
    await query(
      "INSERT INTO settings (business_id, key, value) VALUES ($1, 'demo.fixture', 'true')",
      [businessId],
    );
  },
};

function urlFor(db: string, runtime = false): string {
  const url = new URL(rootUrl!);
  url.pathname = `/${db}`;
  if (runtime) {
    url.username = role;
    url.password = password;
  }
  return url.toString();
}

let admin: Client;
let owner: Client;
let databaseCreated = false;

beforeAll(async () => {
  admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  const ownerUrl = urlFor(database);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({ databaseUrl: ownerUrl, roleName: role, password, quiet: true });
  owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query("SELECT set_config('app.rls_bypass', 'on', false)");
  vi.stubEnv("DATABASE_URL", urlFor(database, true));
  vi.stubEnv("BIZAMIZ_DEPLOYMENT_PROFILE", "demo");
  vi.stubEnv("DEMO_DATABASE_ID", databaseId);
  vi.stubEnv("DEMO_SESSION_SECRET", "ba".repeat(32));
}, 120_000);

beforeEach(async () => {
  await owner.query(`COMMENT ON DATABASE "${database}" IS 'bizamiz-demo:${databaseId}'`);
});

afterAll(async () => {
  await closeDatabasePool();
  vi.unstubAllEnvs();
  await owner?.end();
  if (admin) {
    try {
      if (databaseCreated) {
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        await dropAppRole(admin, role);
      }
    } finally {
      await admin.end();
    }
  }
});

async function counts() {
  return (await owner.query(
    `SELECT (SELECT count(*) FROM businesses) AS businesses,
            (SELECT count(*) FROM locations) AS locations,
            (SELECT count(*) FROM users) AS users,
            (SELECT count(*) FROM platform_users) AS identities,
            (SELECT count(*) FROM platform_demo_sessions) AS sessions`,
  )).rows[0];
}

describe("demo tenant and session foundation", () => {
  it("refuses ordinary profiles and an unmarked or mismatched live database", async () => {
    const key = createDemoStartKey();
    const before = await counts();
    const originalProfile = process.env.BIZAMIZ_DEPLOYMENT_PROFILE;
    process.env.BIZAMIZ_DEPLOYMENT_PROFILE = "production";
    try {
      await expect(provisionDemoSession(key, template)).rejects.toThrow("demo_deployment_required");
    } finally {
      process.env.BIZAMIZ_DEPLOYMENT_PROFILE = originalProfile;
    }
    await owner.query(`COMMENT ON DATABASE "${database}" IS NULL`);
    await expect(provisionDemoSession(key, template)).rejects.toThrow("demo_database_identity_mismatch");
    await expect(runMigrations({ databaseUrl: urlFor(database), quiet: true }))
      .rejects.toThrow("demo_database_identity_mismatch");
    await expect(owner.query(
      "INSERT INTO businesses (name, slug, ownership_kind) VALUES ('Forbidden', 'forbidden', 'demo')",
    )).rejects.toThrow("demo_database_required");

    await owner.query(`COMMENT ON DATABASE "${database}" IS 'bizamiz-demo:${randomUUID()}'`);
    await expect(provisionDemoSession(key, template)).rejects.toThrow("demo_database_identity_mismatch");
    expect(await counts()).toEqual(before);
  });

  it("provisions once across concurrent requests and resolves only the verified binding", async () => {
    const key = createDemoStartKey();
    const unrelated = await provisionDemoSession(createDemoStartKey(), template);
    const seed = vi.fn(async (tenant: Parameters<DemoTemplate["seed"]>[0]) => {
      const visible = await query<{ id: string }>("SELECT id FROM businesses");
      expect(visible.rows).toEqual([{ id: tenant.businessId }]);
      await template.seed(tenant);
    });
    const sessions = await Promise.all(
      Array.from({ length: 5 }, () => provisionDemoSession(key, { ...template, seed })),
    );
    const [first] = sessions;
    expect(seed).toHaveBeenCalledTimes(1);
    expect(sessions).toEqual(Array(5).fill(first));
    await expect(provisionDemoSession(key, { ...template, industry: "jewelry" }))
      .rejects.toThrow("demo_start_industry_mismatch");

    const { token, ...expected } = first;
    await expect(resolveDemoSession(token)).resolves.toEqual(expected);
    const rows = await owner.query(
      `SELECT b.ownership_kind, p.is_active, p.password_hash, s.token_hash,
              extract(epoch FROM s.expires_at - s.created_at)::integer AS ttl
         FROM platform_demo_sessions s JOIN businesses b ON b.id = s.business_id
         JOIN platform_users p ON p.id = s.platform_user_id`,
    );
    expect(rows.rows).toContainEqual({
      ownership_kind: "demo", is_active: false, password_hash: "demo-login-disabled",
      token_hash: expect.any(Buffer), ttl: 3600,
    });

    expect(unrelated.businessId).not.toEqual(first.businessId);
    await expect(resolveDemoSession(token.replace(first.businessId, unrelated.businessId))).resolves.toBeNull();

    await owner.query("UPDATE locations SET is_active = false WHERE id = $1", [first.locationId]);
    await expect(resolveDemoSession(token)).resolves.toBeNull();
    await owner.query("UPDATE locations SET is_active = true WHERE id = $1", [first.locationId]);
    await owner.query("UPDATE users SET is_active = false WHERE id = $1", [first.userId]);
    await expect(resolveDemoSession(token)).resolves.toBeNull();
    await owner.query("UPDATE users SET is_active = true WHERE id = $1", [first.userId]);
    await owner.query("UPDATE users SET membership_status = 'locked' WHERE id = $1", [first.userId]);
    await expect(resolveDemoSession(token)).resolves.toBeNull();
    await owner.query("UPDATE users SET membership_status = 'active' WHERE id = $1", [first.userId]);
    await owner.query("UPDATE platform_demo_sessions SET revoked_at = now() WHERE id = $1", [first.id]);
    await expect(resolveDemoSession(token)).resolves.toBeNull();
    await expect(provisionDemoSession(key, template)).rejects.toThrow("demo_start_key_unavailable");
  });

  it("enforces expiry before cleanup, and rejects replay after expiry", async () => {
    const key = createDemoStartKey();
    const session = await provisionDemoSession(key, template);
    // Recreate the record as an already-expired fixture without weakening
    // the immutability trigger or advancing the application's wall clock.
    await owner.query(
      `WITH expired AS (DELETE FROM platform_demo_sessions WHERE id = $1 RETURNING *)
       INSERT INTO platform_demo_sessions
         (id, business_id, user_id, location_id, platform_user_id, token_hash, industry,
          template_version, created_at, expires_at, provisioning_state)
       SELECT id, business_id, user_id, location_id, platform_user_id, token_hash, industry,
              template_version, statement_timestamp() - interval '60 minutes',
              statement_timestamp(), provisioning_state FROM expired`,
      [session.id],
    );
    await expect(resolveDemoSession(session.token)).resolves.toBeNull();
    await expect(provisionDemoSession(key, template)).rejects.toThrow("demo_start_key_unavailable");
  });

  it("rolls back failed template and session writes, and permits retry", async () => {
    const key = createDemoStartKey();
    const before = await counts();
    await expect(provisionDemoSession(key, {
      ...template,
      seed: async (tenant) => {
        await template.seed(tenant);
        throw new Error("template_failed");
      },
    })).rejects.toThrow("template_failed");
    expect(await counts()).toEqual(before);

    await expect(provisionDemoSession(key, {
      ...template,
      seed: async ({ userId }) => {
        await query("UPDATE users SET is_active = false WHERE id = $1", [userId]);
      },
    })).rejects.toThrow("invalid_demo_session_binding");
    expect(await counts()).toEqual(before);
    await expect(provisionDemoSession(key, template)).resolves.toMatchObject({ industry: "watch" });
  });

  it("enforces RLS and immutable classification, and keeps ordinary provisioning and lifecycle separate", async () => {
    const customer = await provisionBusiness({
      businessName: "Ordinary watch store", ownerName: "Owner", industry: "watch",
      email: "ordinary@example.invalid", password: "test-only-owner-password",
    });
    const internal = await provisionBusiness({
      businessName: "Internal workspace", ownerName: "Operator", industry: "watch",
      email: "internal@example.invalid", ownershipKind: "platform_internal",
    });
    await expect(getBusiness(customer.businessId)).resolves.toMatchObject({ ownershipKind: "customer" });
    await expect(getBusiness(internal.businessId)).resolves.toMatchObject({ ownershipKind: "platform_internal" });

    const demo = await provisionDemoSession(createDemoStartKey(), template);
    const other = await provisionDemoSession(createDemoStartKey(), template);
    for (const businessId of [other.businessId, customer.businessId, internal.businessId]) {
      await withTenant(demo.businessId, async () => {
        expect((await query("SELECT id FROM businesses WHERE id = $1", [businessId])).rowCount).toBe(0);
        expect((await query("UPDATE businesses SET name = 'changed' WHERE id = $1", [businessId])).rowCount).toBe(0);
        expect((await query("SELECT id FROM platform_demo_sessions WHERE business_id = $1", [businessId])).rowCount).toBe(0);
      });
      await withTenant(businessId, async () => {
        expect((await query("SELECT id FROM businesses WHERE id = $1", [demo.businessId])).rowCount).toBe(0);
        expect((await query("DELETE FROM platform_demo_sessions WHERE id = $1", [demo.id])).rowCount).toBe(0);
      });
    }

    await withTenant(demo.businessId, async () => {
      await expect(query("UPDATE businesses SET ownership_kind = 'customer' WHERE id = $1", [demo.businessId]))
        .rejects.toThrow("demo_classification_immutable");
      await expect(query("UPDATE platform_demo_sessions SET revoked_at = now() WHERE id = $1", [demo.id]))
        .rejects.toThrow("demo_database_required");
    });
    await owner.query("SET session_replication_role = replica");
    try {
      await expect(owner.query("UPDATE businesses SET ownership_kind = 'customer' WHERE id = $1", [demo.businessId]))
        .rejects.toThrow("demo_classification_immutable");
    } finally {
      await owner.query("RESET session_replication_role");
    }
    await expect(owner.query("UPDATE platform_demo_sessions SET business_id = $2 WHERE id = $1", [demo.id, customer.businessId]))
      .rejects.toThrow("demo_session_binding_immutable");
    await expect(getBusiness(demo.businessId)).resolves.toBeNull();
    await expect(setBusinessStatus(demo.businessId, "archived")).resolves.toBeNull();
    await expect(resetBusiness(demo.businessId)).rejects.toThrow();
    await expect(hardDeleteBusiness(demo.businessId)).rejects.toThrow();
  });
});
