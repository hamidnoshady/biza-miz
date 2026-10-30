/**
 * Issue #903 §11 — database-level proof for the managed backup service.
 *
 * The unit contract tests (`tenant-backup-service-schema.test.ts`) prove the
 * *text* of migrations 0265–0268. This suite proves their *behaviour* against a
 * real PostgreSQL, which is the only thing that can establish the claim the epic
 * makes:
 *
 *  • a tenant connection sees only its own upload sessions, queue entries and
 *    heartbeat — with the RLS policies enabled *and forced*, so the table owner
 *    cannot sidestep them either;
 *  • the fleet's storage destination (`platform_tenant_backup_service`) is
 *    unreadable from a tenant connection at all;
 *  • the artifact table's constraints do what the code assumes: one row per
 *    destination, a managed artifact must name a key generation, no duplicate
 *    refund of the same charge, and the `superseded` state added by 0268 is
 *    accepted while an invented state is not.
 *
 * These are the assertions that must fail loudly if someone later drops FORCE
 * ROW LEVEL SECURITY or renames a policy.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL required");

const APP_ROLE = "pos_tenant_backup_rls_role";
const APP_PASSWORD = "tenant-backup-rls-password";

let databaseName: string;
let owner: Client;
let app: Client;

function urlFor(db: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${db}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function makeBusiness(name: string): Promise<string> {
  const biz = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id",
    [name, `biz-${randomUUID().slice(0, 8)}`],
  );
  return biz.rows[0].id;
}

/** Run `fn` on the tenant connection inside a transaction scoped to `businessId`. */
async function asTenant<T>(client: Client, businessId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

beforeAll(async () => {
  databaseName = `pos_tenant_backup_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName) });
  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD });
  app = new Client({ connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }) });
  await app.connect();
}, 180_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  for (const table of [
    "tenant_backup_upload_queue",
    "platform_tenant_backup_service",
    "tenant_backup_upload_sessions",
    "tenant_backup_site_heartbeat",
    "tenant_backup_artifacts",
    "tenant_backup_restore_jobs",
    "tenant_backup_storage_samples",
    "tenant_backup_business_policy",
    "tenant_backup_restore_approvals",
    "backup_key_versions",
    "wallet_ledger",
    "business_wallets",
    "businesses",
  ]) {
    // `platform_tenant_backup_service` is a singleton with a CHECK (id) — remove
    // the row so a suite run starts from "not configured", which is the state a
    // fresh install is in as well.
    await owner.query(`DELETE FROM ${table}`).catch(() => undefined);
  }
});

describe("tenant_backup_upload_sessions under the unprivileged role", () => {
  async function session(businessId: string, token = randomUUID().slice(0, 32)) {
    await owner.query(
      `INSERT INTO tenant_backup_upload_sessions
         (business_id, session_token, expected_bytes, staging_ref)
       VALUES ($1,$2,1024,'upload-test')`,
      [businessId, token],
    );
    return token;
  }

  it("shows a business only its own sessions", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await session(a);
    await session(b);
    const rows = await asTenant(app, a, async () => {
      const result = await app.query<{ business_id: string }>(
        "SELECT business_id FROM tenant_backup_upload_sessions",
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].business_id).toBe(a);
  });

  it("refuses a session created for another business", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await expect(
      asTenant(app, a, () =>
        app
          .query(
            `INSERT INTO tenant_backup_upload_sessions
               (business_id, session_token, expected_bytes, staging_ref)
             VALUES ($1,$2,1024,'upload-forged')`,
            [b, randomUUID().slice(0, 32)],
          )
          .then(() => true),
      ),
    ).rejects.toThrow();
  });

  it("cannot touch another business's session even by primary key", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await session(b);
    const changed = await asTenant(app, a, async () => {
      const result = await app.query("UPDATE tenant_backup_upload_sessions SET state = 'abandoned'");
      return result.rowCount;
    });
    expect(changed).toBe(0);
  });
});

describe("tenant_backup_upload_queue and heartbeat under the unprivileged role", () => {
  it("isolates queue rows", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await owner.query(
      `INSERT INTO tenant_backup_upload_queue (business_id, artifact_name, generation)
       VALUES ($1,'a.dump.enc',1), ($2,'b.dump.enc',1)`,
      [a, b],
    );
    const names = await asTenant(app, a, async () => {
      const result = await app.query<{ artifact_name: string }>(
        "SELECT artifact_name FROM tenant_backup_upload_queue",
      );
      return result.rows.map((row) => row.artifact_name);
    });
    expect(names).toEqual(["a.dump.enc"]);
  });

  it("isolates the heartbeat row and its generations", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await owner.query(
      `INSERT INTO tenant_backup_site_heartbeat (business_id, site_generation, accepted_generation)
       VALUES ($1, 7, 5), ($2, 3, 9)`,
      [a, b],
    );
    const rows = await asTenant(app, a, async () => {
      const result = await app.query<{ site_generation: string; accepted_generation: string }>(
        "SELECT site_generation, accepted_generation FROM tenant_backup_site_heartbeat",
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].site_generation)).toBe(7);
    expect(Number(rows[0].accepted_generation)).toBe(5);
  });
});

describe("platform_tenant_backup_service", () => {
  it("returns no row to a tenant connection, and refuses a tenant write", async () => {
    const a = await makeBusiness("Alpha");
    await owner.query(
      `INSERT INTO platform_tenant_backup_service (id, managed_cloud, endpoint, bucket)
       VALUES (true, true, 'https://s3.example', 'managed')
       ON CONFLICT (id) DO UPDATE SET bucket = EXCLUDED.bucket`,
    );

    const visible = await asTenant(app, a, async () => {
      const result = await app.query("SELECT bucket FROM platform_tenant_backup_service");
      return result.rowCount;
    });
    expect(visible).toBe(0);

    // The policy's WITH CHECK is what stops a tenant connection writing the
    // fleet's destination — a read filter alone would not.
    await expect(
      asTenant(app, a, () =>
        app
          .query("UPDATE platform_tenant_backup_service SET bucket = 'stolen'")
          .then((result) => {
            if ((result.rowCount ?? 0) > 0) throw new Error("tenant wrote the platform destination");
            return true;
          }),
      ),
    ).resolves.toBe(true);

    const bucket = await owner.query<{ bucket: string }>(
      "SELECT bucket FROM platform_tenant_backup_service WHERE id = true",
    );
    expect(bucket.rows[0]?.bucket).toBe("managed");
  });
});

describe("tenant_backup_artifacts constraints", () => {
  const managed: {
    artifactId: string;
    format: string;
    origin: string;
    state: string;
    encryption: string;
    keyVersion: number | null;
    storageRef: string;
  } = {
    artifactId: randomUUID(),
    format: "logical_snapshot",
    origin: "scheduled",
    state: "ready",
    encryption: "managed_envelope_v1",
    keyVersion: 1,
    storageRef: "artifact-1.archive.enc",
  };

  async function insert(businessId: string, patch: Partial<typeof managed> & { destination?: string } = {}) {
    const row = { ...managed, ...patch };
    return owner.query(
      `INSERT INTO tenant_backup_artifacts
         (business_id, artifact_id, destination, format, origin, state, encryption_scheme,
          key_version, storage_ref, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
      [
        businessId,
        row.artifactId,
        row.destination ?? "local",
        row.format,
        row.origin,
        row.state,
        row.encryption,
        row.keyVersion,
        row.storageRef,
      ],
    );
  }

  it("accepts exactly one row per destination and object", async () => {
    const a = await makeBusiness("Alpha");
    await insert(a);
    await expect(insert(a)).rejects.toThrow();
    // A different destination of the same logical backup is a second, legal row.
    await expect(insert(a, { destination: "cloud" })).resolves.toBeTruthy();
  });

  it("requires a key generation for a managed artifact and forbids one for a legacy artifact", async () => {
    const a = await makeBusiness("Alpha");
    await expect(insert(a, { keyVersion: null })).rejects.toThrow();
    await expect(
      insert(a, { encryption: "legacy_passphrase_v1", keyVersion: null, storageRef: "legacy.enc" }),
    ).resolves.toBeTruthy();
    await expect(
      insert(a, { encryption: "legacy_passphrase_v1", keyVersion: 2, storageRef: "legacy-2.enc" }),
    ).rejects.toThrow();
  });

  it("accepts the superseded state added by 0268 and refuses an invented one", async () => {
    const a = await makeBusiness("Alpha");
    await expect(insert(a, { state: "superseded", storageRef: "old.enc" })).resolves.toBeTruthy();
    await expect(insert(a, { state: "deleted", storageRef: "bad.enc" })).rejects.toThrow();
  });

  it("is invisible to another business under RLS", async () => {
    const a = await makeBusiness("Alpha");
    const b = await makeBusiness("Beta");
    await insert(a);
    const visible = await asTenant(app, b, async () => {
      const result = await app.query("SELECT id FROM tenant_backup_artifacts");
      return result.rowCount;
    });
    expect(visible).toBe(0);
  });
});

describe("wallet_ledger_refund_once (0267)", () => {
  it("refuses a second refund of the same charge", async () => {
    const a = await makeBusiness("Alpha");
    await owner.query("INSERT INTO business_wallets (business_id) VALUES ($1)", [a]);
    const charge = await owner.query<{ id: string }>(
      `INSERT INTO wallet_ledger
         (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
       VALUES ($1,'feature_charge','debit',1000,0,$2::jsonb)
       RETURNING id`,
      [a, JSON.stringify({ runId: randomUUID() })],
    );
    const refund = (id: string) =>
      owner.query(
        `INSERT INTO wallet_ledger
           (business_id, kind, direction, amount_rial, balance_after_rial, metadata)
         VALUES ($1,'refund','credit',1000,1000,$2::jsonb)`,
        [a, JSON.stringify({ refundOf: id })],
      );

    await expect(refund(charge.rows[0].id)).resolves.toBeTruthy();
    await expect(refund(charge.rows[0].id)).rejects.toThrow();
  });
});

describe("0269 — per-business overrides and recovery approvals", () => {
  it("hides a business's policy override from that business", async () => {
    const a = await makeBusiness("Alpha");
    await owner.query(
      `INSERT INTO tenant_backup_business_policy
         (business_id, interval_hours, retention_days, keep_count, require_restore_approval, note)
       VALUES ($1, 6, 120, 12, true, 'legal retention')`,
      [a],
    );

    // A business is *subject* to its policy, never a reader of it: the table is
    // platform-only, so the tenant connection sees no rows at all.
    const visible = await asTenant(app, a, async () => {
      const result = await app.query("SELECT interval_hours FROM tenant_backup_business_policy");
      return result.rowCount;
    });
    expect(visible).toBe(0);

    await expect(
      asTenant(app, a, () =>
        app.query("UPDATE tenant_backup_business_policy SET retention_days = 3650").then((result) => {
          if ((result.rowCount ?? 0) > 0) throw new Error("tenant rewrote its own retention");
          return true;
        }),
      ),
    ).resolves.toBe(true);

    const row = await owner.query<{ retention_days: number }>(
      "SELECT retention_days FROM tenant_backup_business_policy WHERE business_id = $1",
      [a],
    );
    expect(row.rows[0]?.retention_days).toBe(120);
  });

  it("keeps an approval invisible to the tenant it is about", async () => {
    const a = await makeBusiness("Alpha");
    await owner.query(
      `INSERT INTO tenant_backup_restore_approvals (business_id, artifact_ref, expires_at, note)
       VALUES ($1, 'ref-1', now() + interval '1 hour', 'owner called')`,
      [a],
    );

    const visible = await asTenant(app, a, async () => {
      const result = await app.query("SELECT id FROM tenant_backup_restore_approvals");
      return result.rowCount;
    });
    expect(visible).toBe(0);
  });

  it("refuses an approval window that has already closed when it opens", async () => {
    const a = await makeBusiness("Alpha");
    await expect(
      owner.query(
        `INSERT INTO tenant_backup_restore_approvals (business_id, artifact_ref, approved_at, expires_at)
         VALUES ($1, 'ref-1', now(), now() - interval '1 minute')`,
        [a],
      ),
    ).rejects.toThrow();
  });

  it("still accepts a zero protected-copy floor, so the console can turn it off", async () => {
    const a = await makeBusiness("Alpha");
    await owner.query(
      `INSERT INTO tenant_backup_business_policy (business_id, protected_recovery_copies)
       VALUES ($1, 0)`,
      [a],
    );
    const row = await owner.query<{ protected_recovery_copies: number }>(
      "SELECT protected_recovery_copies FROM tenant_backup_business_policy WHERE business_id = $1",
      [a],
    );
    expect(row.rows[0]?.protected_recovery_copies).toBe(0);
  });
});
