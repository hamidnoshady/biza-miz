/**
 * Issue #1206, P0 — the «تست کرون» probe, against a real database.
 *
 * The probe's whole value rests on two claims this file has to prove rather
 * than assert:
 *
 *   1. the migration actually lets a `cron_probe` row exist in the shared
 *      outbox (a CHECK constraint, so a typo fails here and not in production);
 *   2. asking for one writes *exactly* one leaseable row, with a correlation id
 *      the plugin will echo back — and asking again does not leave two probes
 *      racing for the plugin's single stored record.
 *
 * What is deliberately NOT here: that the probe ran. Only the plugin's
 * scheduler can establish that, which is the entire point of the feature.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { encryptSecret } from "../src/lib/integrations/secrets";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "cd".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let plugin: typeof import("../src/lib/integrations/plugin-service");

const biz = { id: "", locationId: "" };
const connections: Record<"probe" | "legacy" | "rest", string> = { probe: "", legacy: "", rest: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function insertConnection(
  capabilities: Record<string, unknown> | null,
  linkMode: "plugin" | "rest_api",
): Promise<string> {
  // A plugin-mode connection needs its link token pair (a CHECK constraint);
  // the values are never used here, only their presence.
  const isPlugin = linkMode === "plugin";
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        link_token_hash, link_token_ciphertext,
        currency_unit, link_mode, plugin_capabilities)
     VALUES ($1, $2, $3, 'https://shop.example.com', $4, $5, $6, $7, $8, 'toman', $9, $10::jsonb)
     RETURNING id`,
    [
      biz.id,
      biz.locationId,
      `Store ${linkMode}`,
      encryptSecret("ck_test", Buffer.from(KEY, "hex")),
      encryptSecret("cs_test", Buffer.from(KEY, "hex")),
      encryptSecret("wh_test", Buffer.from(KEY, "hex")),
      isPlugin ? `hash_${randomUUID()}` : null,
      isPlugin ? encryptSecret("wplink_test", Buffer.from(KEY, "hex")) : null,
      linkMode,
      capabilities ? JSON.stringify(capabilities) : null,
    ],
  );
  return rows[0].id;
}

async function probeRows(connectionId: string) {
  const { rows } = await db.query<{ entity_type: string; status: string; remote_id: string; payload: Record<string, unknown> }>(
    `SELECT entity_type, status, remote_id, payload
       FROM integration_outbox_events
      WHERE connection_id = $1
      ORDER BY created_at`,
    [connectionId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_cron_probe_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: (() => {
    const url = new URL(rootDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  })() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  plugin = await import("../src/lib/integrations/plugin-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Boutique', $1, 'accessories') RETURNING id",
    [`cron-probe-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  connections.probe = await insertConnection({ protocolVersion: 3, jobTypes: ["stock", "price", "cron_probe"] }, "plugin");
  // A plugin that predates this release: legacy capabilities list only.
  connections.legacy = await insertConnection({ protocolVersion: 3, jobTypes: ["stock", "price"] }, "plugin");
  // REST mode has no scheduler of the store's to test, whatever it advertises.
  connections.rest = await insertConnection({ protocolVersion: 3, jobTypes: ["cron_probe"] }, "rest_api");
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;

  const maintenance = new Client({ connectionString: (() => {
    const url = new URL(rootDatabaseUrl!);
    url.pathname = "/postgres";
    return url.toString();
  })() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("the cron probe (issue #1206 P0)", () => {
  it("accepts the new entity type in the outbox — the migration's whole job", async () => {
    // Inserted by hand, not through the service: this fails only if the CHECK
    // constraint was never widened.
    await expect(
      db.query(
        `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
         VALUES ($1, $2, 'cron_probe', $3, '{}'::jsonb)`,
        [biz.id, connections.probe, "0".repeat(32)],
      ),
    ).resolves.toBeTruthy();
    await db.query(`DELETE FROM integration_outbox_events WHERE connection_id = $1`, [connections.probe]);
  });

  it("queues exactly one leaseable row, carrying the id the plugin will echo", async () => {
    const { probeId, jobId } = await plugin.requestCronProbe(biz.id, connections.probe);
    expect(probeId).toMatch(/^[a-f0-9]{32}$/);
    expect(jobId).toBeTruthy();
    const rows = await probeRows(connections.probe);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe("cron_probe");
    expect(rows[0].status).toBe("pending");
    expect(rows[0].remote_id).toBe(probeId);
    expect(rows[0].payload).toEqual({ probeId });
  });

  it("leaves one probe, not two racing for the plugin's single stored record", async () => {
    // Asking again supersedes the question, never adds a second one.
    const second = await plugin.requestCronProbe(biz.id, connections.probe);
    const rows = await probeRows(connections.probe);
    const open = rows.filter((row) => row.status === "pending" || row.status === "failed");
    expect(open).toHaveLength(1);
    expect(open[0].remote_id).toBe(second.probeId);
    const superseded = rows.find((row) => row.remote_id !== second.probeId)!;
    expect(superseded.status).toBe("skipped");
    expect(superseded.payload).toEqual({ probeId: superseded.remote_id });
  });

  it("refuses an older plugin rather than stranding a job nothing can lease", async () => {
    await expect(plugin.requestCronProbe(biz.id, connections.legacy)).rejects.toThrow("plugin_job_unsupported");
    expect(await probeRows(connections.legacy)).toHaveLength(0);
  });

  it("refuses REST mode, where there is no store scheduler to test", async () => {
    await expect(plugin.requestCronProbe(biz.id, connections.rest)).rejects.toThrow("plugin_job_unsupported");
    expect(await probeRows(connections.rest)).toHaveLength(0);
  });
});
