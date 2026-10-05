/**
 * Issue #799 §26 — the classification checked against the real schema, and the
 * pairing it promises not to break.
 *
 * §26 says three things: classify every new entity, do not put the
 * financial/high-risk operations into generic last-write-wins master-data sync,
 * and *update the replication metadata if new entities are replicated*. The
 * classification itself is in `src/lib/aec-sync-classification.ts` and asserted
 * without a database in its unit test. What only PostgreSQL can answer:
 *
 *   * **nothing is unclassified**: the sweep takes the schema's own table list
 *     (every `aec_*` table plus the shared `ai_project_tasks`,
 *     `workspace_project_phases` and `workspace_documents` the registers extend)
 *     and the guard must find no unclaimed table and no claim without a table —
 *     so a future register cannot arrive without a decision, and a rename cannot
 *     leave the document describing a table nobody has;
 *   * **no classified table is in the master feed**: the `trg_sync_capture`
 *     trigger that makes a table last-write-wins does not exist on any of them
 *     (the query is proven to detect one by checking a table that *is* captured);
 *   * **pairing tells the truth**: an AEC business issues a code, the snapshot
 *     is redeemed and *applied to a second database* — the desktop half of the
 *     platform — and that second database holds **zero rows in every classified
 *     AEC table**. The desktop gets the business, its members and its chart of
 *     accounts, and no AEC register: §26's "do not silently create cloud-only
 *     AEC workflows where the existing desktop architecture expects operational
 *     continuity" answered by showing the desktop has none to lose.
 */
import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  aecClassifiedTables,
  aecSyncClassificationProblems,
} from "../src/lib/aec-sync-classification";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let serverDb: string;
let localDb: string;

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

/** `db.ts` caches its pool on globalThis, so switching databases means ending it. */
const globalForPg = globalThis as unknown as { pgPool?: Pool };

async function useDatabase(name: string): Promise<void> {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(name);
}

async function createDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}

async function dropDatabase(name: string): Promise<void> {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
}

let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let pairing: typeof import("../src/lib/pairing-service");
let pairingApply: typeof import("../src/lib/pairing-apply");
let pairingSnapshot: typeof import("../src/lib/pairing-snapshot");

beforeAll(async () => {
  serverDb = `pos_aec_sync_srv_${randomUUID().replaceAll("-", "")}`;
  localDb = `pos_aec_sync_loc_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(serverDb);
  await createDatabase(localDb);

  await useDatabase(serverDb);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  pairing = await import("../src/lib/pairing-service");
  pairingApply = await import("../src/lib/pairing-apply");
  pairingSnapshot = await import("../src/lib/pairing-snapshot");
}, 300_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(serverDb);
  await dropDatabase(localDb);
});

/** The tables §26's classification covers, asked of the schema rather than of the file. */
async function schemaTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND (table_name LIKE 'aec\\_%'
             OR table_name IN ('ai_project_tasks', 'workspace_project_phases', 'workspace_documents'))
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

describe("§26's classification against the schema", () => {
  it("covers every AEC table, and claims none the schema does not have", async () => {
    const client = new Client({ connectionString: urlFor(serverDb) });
    await client.connect();
    try {
      const tables = await schemaTables(client);
      expect(tables.length).toBeGreaterThan(30);
      const problems = aecSyncClassificationProblems(tables);
      expect(problems.uncovered).toEqual([]);
      expect(problems.unknown).toEqual([]);

      // A sanity check on the guard itself: a table the sweep would see and the
      // classification does not know about is reported, not ignored.
      const invented = aecSyncClassificationProblems([...tables, "aec_future_register"]);
      expect(invented.uncovered).toEqual(["aec_future_register"]);
    } finally {
      await client.end();
    }
  });

  it("keeps every classified table out of the master-data capture feed", async () => {
    const client = new Client({ connectionString: urlFor(serverDb) });
    await client.connect();
    try {
      const classified = aecClassifiedTables();
      const { rows: captured } = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname = 'trg_sync_capture' AND c.relname = ANY($1::text[])`,
        [classified],
      );
      // §26's rule, as a database fact: the trigger that would make any of these
      // last-write-wins does not exist on them.
      expect(captured.map((row) => row.relname)).toEqual([]);

      // …and the query is not vacuously true: the master catalogue's own tables
      // do carry it, so a trigger added to an AEC table would be found here.
      const { rows: masterCaptured } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgname = 'trg_sync_capture'
            AND c.relname IN ('parties', 'menu_items')`,
      );
      expect(Number(masterCaptured[0].n)).toBe(2);
    } finally {
      await client.end();
    }
  });

  it("pairs an AEC business onto a desktop database with no AEC register in it", async () => {
    // ---- the cloud ---------------------------------------------------------
    const created = await provisioning.provisionBusiness({
      businessName: "شرکت ساختمانی موج",
      ownerName: "مالک",
      email: `owner-${randomUUID()}@example.com`,
      password: "correct-horse",
      subdomain: `aecsync${randomUUID().slice(0, 6)}`.toLowerCase(),
      industry: "architecture_construction",
      seedChartOfAccounts: true,
    });

    // One row in a field register and one in a commercial register, so "zero
    // rows on the laptop" is a claim about real data rather than about an empty
    // table either way.
    const projectId = await dbLib.withTenant(created.businessId, async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO ai_projects (business_id, name, created_by, owner_user_id)
         VALUES ($1, 'پروژهٔ موج', $2::text, $2::uuid) RETURNING id`,
        [created.businessId, created.userId],
      );
      await dbLib.query(
        `INSERT INTO aec_rfis (business_id, project_id, rfi_number, subject, raised_date, status, created_by_name)
         VALUES ($1, $2, 'RFI-001', 'تراز فونداسیون', CURRENT_DATE, 'open', 'دفتر فنی')`,
        [created.businessId, rows[0].id],
      );
      await dbLib.query(
        `INSERT INTO aec_site_issues (business_id, project_id, issue_number, kind, title, severity,
                                      raised_date, status, created_by_name)
         VALUES ($1, $2, 'SN-001', 'snag', 'درزگیری ناقص', 'medium', CURRENT_DATE, 'open', 'سرکارگر')`,
        [created.businessId, rows[0].id],
      );
      return rows[0].id;
    });

    const platformAdminId = await dbLib.withoutTenantScope("platform", async () => {
      const { rows } = await dbLib.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, 'x', 'operator') RETURNING id`,
        [`admin-${randomUUID()}@example.com`],
      );
      return rows[0].id;
    });

    const issued = await dbLib.withoutTenantScope("platform", () =>
      pairing.issuePairingCode(created.businessId, platformAdminId, created.locationId),
    );
    if (!("code" in issued)) throw new Error(`pairing code not issued: ${JSON.stringify(issued)}`);

    const installationId = `desktop-installation-${randomUUID()}`;
    const redeemed = await pairing.redeemPairingCode(
      issued.code,
      "127.0.0.1",
      "Windows Business Suite",
      installationId,
    );
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) return;

    // §26's "tell the truth" half: the coverage copy the operator and the
    // desktop both read names the AEC registers as cloud-only and promises no
    // AEC event.
    const classification = redeemed.snapshot.dataClassification;
    expect(classification.ongoingDomainEvents.some((event) => event.includes("aec"))).toBe(false);
    expect(classification.bootstrapMasterData.join(" ")).not.toContain("AEC");
    expect(classification.centralOnlyData.join(" ")).toContain("AEC project registers");

    const validation = pairingSnapshot.validateSnapshot(JSON.parse(JSON.stringify(redeemed.snapshot)));
    expect(validation).toMatchObject({ ok: true });

    // ---- the desktop -------------------------------------------------------
    await useDatabase(localDb);
    const applied = await pairingApply.applyPairingSnapshot(
      redeemed.snapshot,
      "https://pos.example.com",
      { pairingSessionId: redeemed.pairingSessionId, installationId },
    );
    expect(applied.businessId).toBe(created.businessId);

    // The snapshot really landed: the business and the chart of accounts the
    // pairing copy promises are here. The counts below are about the AEC
    // registers, not about a snapshot that failed to apply half-way.
    const { rows: businessRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ n: string; industry: string }>(
        `SELECT count(*)::text AS n, min(industry) AS industry FROM businesses WHERE id = $1`,
        [created.businessId],
      ),
    );
    expect(Number(businessRows[0].n)).toBe(1);
    expect(businessRows[0].industry).toBe("architecture_construction");
    const { rows: accountRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ n: string }>(`SELECT count(*)::text AS n FROM accounts WHERE business_id = $1`, [
        created.businessId,
      ]),
    );
    expect(Number(accountRows[0].n)).toBeGreaterThan(0);

    const { rows: aecRows } = await dbLib.withoutTenantScope("platform", () =>
      dbLib.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
           AND table_name LIKE 'aec\\_%' ORDER BY table_name`,
      ),
    );
    for (const { table_name: table } of aecRows) {
      const { rows } = await dbLib.withoutTenantScope("platform", () =>
        dbLib.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`),
      );
      expect(Number(rows[0].n), table).toBe(0);
    }
    // And the same is true of the shared tables the field registers extend.
    for (const table of ["ai_project_tasks", "workspace_project_phases", "workspace_documents"]) {
      const { rows } = await dbLib.withoutTenantScope("platform", () =>
        dbLib.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`),
      );
      expect(Number(rows[0].n), table).toBe(0);
    }

    // Leaving the pool pointed at the laptop database would break every later
    // test in the file, so the server is restored here.
    await useDatabase(serverDb);
    void projectId;
  }, 180_000);
});
