/**
 * Printer connection model — real-database coverage of the whole upgrade path,
 * on an actual pre-0155 database holding legacy rows:
 *
 *   system     → {type: 'windows', systemName}
 *   network    → {type: 'network', ip, port}
 *   ip-only    → {type: 'network', ...}          (pre-transport rows)
 *   usb/webusb/browser/stub → needsReconnect + legacyTransport, identity kept
 *
 * Two migrations share this story and the test asserts the state after BOTH:
 *
 *   * 0155 maps the connection, keeping the row's identity (a `webusb` row
 *     keeps its product name, a `usb` row its device path) so the settings
 *     screen can say WHICH printer needs re-pairing;
 *   * 0212 makes the relational columns the only behavioural truth — `paper`,
 *     `paper_width_mm`, `printer_class`, `supports_drawer`, `supports_cut`,
 *     `is_default` — strips those keys out of the `connection` jsonb, promotes
 *     a printer-held `templateKey` into the branch's print rule, and installs
 *     the one-default-per-purpose index.
 *
 * So the jsonb must end up holding the **hardware target and nothing else**,
 * and behaviour must be readable from the columns. The runner applies the full
 * directory, so the expectation about how many files land is derived from the
 * directory itself rather than hard-coded — a later forward migration must not
 * break this test.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let tempDir: string;
let ownerClient: Client;
/** The seeded branch and one of its printers — migration 0213's assertions need both. */
let seededLocationId: string;
let seededPrinterId: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(): Promise<string> {
  const name = `pos_printer_migration_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  return name;
}

/** A migrations directory holding everything up to (but not including) 0155. */
async function preMigrationDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-printer-mig-"));
  const all = readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const file of all.filter((name) => name < "0155_printer_connection_model.sql")) {
    await copyFile(join(process.cwd(), "migrations", file), join(dir, file));
  }
  return dir;
}

beforeAll(async () => {
  databaseName = await createDatabase();
  tempDir = await preMigrationDir();
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: tempDir, quiet: true });

  ownerClient = new Client({ connectionString: urlFor(databaseName) });
  await ownerClient.connect();

  // A business + location to hang printers off (the FK target).
  const { rows: biz } = await ownerClient.query(
    `INSERT INTO businesses (name, slug, industry) VALUES ('کافه مهاجرت', 'printer-migration-test', 'food_service') RETURNING id`,
  );
  const { rows: loc } = await ownerClient.query(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz[0].id],
  );
  const locationId = loc[0].id;

  const rows: [string, string, Record<string, unknown>][] = [
    ["رسید سیستم", "receipt", { transport: "system", systemName: "EPSON TM-T20III", ip: null, port: 9100, paper: "thermal80", paperWidthMm: 80, openDrawer: true, isDefault: true }],
    ["آشپزخانه شبکه", "kitchen", { transport: "network", ip: "192.168.1.45", port: 9100, paperWidthMm: 58, paper: "thermal58" }],
    ["قدیمی بدون transport", "receipt", { ip: "192.168.1.50", port: 9101 }],
    ["USB قدیمی", "receipt", { transport: "usb", devicePath: "USB001", paperWidthMm: 80 }],
    ["WebUSB قدیمی", "receipt", { transport: "webusb", usbVendorId: 0x04b8, usbProductId: 0x0e15, usbProductName: "TM-T20III" }],
    ["مرورگر قدیمی", "receipt", { transport: "browser", isDefault: true }],
    ["استاب نصب اولیه", "receipt", { ip: null, port: 9100, driver: "escpos-stub" }],
    ["شبکه بدون پورت", "receipt", { transport: "network", ip: "10.0.0.9" }],
  ];
  seededLocationId = locationId;
  for (const [name, kind, connection] of rows) {
    const { rows: inserted } = await ownerClient.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, connection) VALUES ($1, $2, $3, $4) RETURNING id`,
      [locationId, name, kind, JSON.stringify(connection)],
    );
    seededPrinterId ??= inserted[0].id;
  }
});

afterAll(async () => {
  await ownerClient?.end().catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function connectionOf(name: string): Promise<Record<string, unknown>> {
  const { rows } = await ownerClient.query(`SELECT connection FROM printers WHERE name = $1`, [name]);
  return rows[0].connection as Record<string, unknown>;
}

/** The row's behaviour — relational columns only, per the unified model. */
interface PrinterBehaviour {
  paper: string | null;
  paper_width_mm: number | null;
  printer_class: string;
  supports_drawer: boolean;
  supports_cut: boolean;
  is_default: boolean;
  is_active: boolean;
}

async function behaviourOf(name: string): Promise<PrinterBehaviour> {
  const { rows } = await ownerClient.query(
    `SELECT paper, paper_width_mm, printer_class, supports_drawer, supports_cut, is_default, is_active
       FROM printers WHERE name = $1`,
    [name],
  );
  return rows[0] as PrinterBehaviour;
}

describe("the printer connection model — after the full migration history", () => {
  it("applies every pending file on top of the pre-0155 database", async () => {
    const result = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
    const expectedApplied = readdirSync(join(process.cwd(), "migrations"))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name >= "0155_printer_connection_model.sql")
      .length;
    expect(result.applied).toBe(expectedApplied);
  });

  it("maps system → windows: the jsonb keeps the queue name and nothing behavioural", async () => {
    const connection = await connectionOf("رسید سیستم");
    expect(connection.type).toBe("windows");
    expect(connection.systemName).toBe("EPSON TM-T20III");
    expect(connection.transport).toBeUndefined();
    expect(connection.ip).toBeUndefined();
    expect(connection.driverMode).toBeUndefined();
    // Behaviour is no longer answered by the blob…
    expect(connection.openDrawer).toBeUndefined();
    expect(connection.paper).toBeUndefined();
    expect(connection.isDefault).toBeUndefined();

    // …the columns answer it, and the backfill moved the legacy values there.
    const behaviour = await behaviourOf("رسید سیستم");
    expect(behaviour.paper).toBe("thermal80");
    expect(behaviour.paper_width_mm).toBe(80);
    expect(behaviour.printer_class).toBe("thermal");
    expect(behaviour.supports_drawer).toBe(true);
  });

  it("maps network (and pre-transport ip-only rows) → network, and moves the width to the column", async () => {
    const network = await connectionOf("آشپزخانه شبکه");
    expect(network.type).toBe("network");
    expect(network.ip).toBe("192.168.1.45");
    expect(network.port).toBe(9100);
    expect(network.systemName).toBeUndefined();
    expect(network.paperWidthMm).toBeUndefined();
    expect(network.paper).toBeUndefined();

    const kitchen = await behaviourOf("آشپزخانه شبکه");
    expect(kitchen.paper).toBe("thermal58");
    expect(kitchen.paper_width_mm).toBe(58);

    const legacy = await connectionOf("قدیمی بدون transport");
    expect(legacy.type).toBe("network");
    expect(legacy.ip).toBe("192.168.1.50");
    expect(legacy.port).toBe(9101);
    // A row that named no paper gets the purpose's own default.
    expect((await behaviourOf("قدیمی بدون transport")).paper).toBe("thermal80");

    const noPort = await connectionOf("شبکه بدون پورت");
    expect(noPort.type).toBe("network");
    expect(noPort.ip).toBe("10.0.0.9");
  });

  it("flags usb/webusb/browser/stub rows as needsReconnect with their identity preserved", async () => {
    const usb = await connectionOf("USB قدیمی");
    expect(usb.needsReconnect).toBe(true);
    expect(usb.legacyTransport).toBe("usb");
    expect(usb.devicePath).toBe("USB001");
    // Identity (how to find the device again) is not behaviour: it stays.
    expect(usb.paperWidthMm).toBeUndefined();
    expect((await behaviourOf("USB قدیمی")).paper_width_mm).toBe(80);

    const webusb = await connectionOf("WebUSB قدیمی");
    expect(webusb.needsReconnect).toBe(true);
    expect(webusb.legacyTransport).toBe("webusb");
    expect(webusb.usbProductName).toBe("TM-T20III");

    const browser = await connectionOf("مرورگر قدیمی");
    expect(browser.needsReconnect).toBe(true);
    expect(browser.legacyTransport).toBe("browser");
    expect(browser.isDefault).toBeUndefined();

    const stub = await connectionOf("استاب نصب اولیه");
    expect(stub.needsReconnect).toBe(true);
    expect(stub.legacyTransport).toBe("unknown");
    expect(stub.driver).toBeUndefined();
  });

  it("never marks a convertible row as needing reconnection", async () => {
    const { rows } = await ownerClient.query(
      `SELECT name FROM printers WHERE connection @> '{"needsReconnect": true}'::jsonb ORDER BY name`,
    );
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(
      ["USB قدیمی", "WebUSB قدیمی", "استاب نصب اولیه", "مرورگر قدیمی"].sort(),
    );
  });

  it("leaves at most one default printer per purpose, with the index enforcing it", async () => {
    // Two legacy receipt rows claimed to be the default («رسید سیستم» and
    // «مرورگر قدیمی»); the migration keeps one, and this is the index that
    // stops a second from ever appearing again.
    const { rows: defaults } = await ownerClient.query(
      `SELECT kind, count(*)::int AS count FROM printers WHERE is_default GROUP BY kind`,
    );
    for (const row of defaults as { kind: string; count: number }[]) {
      expect(row.count, row.kind).toBe(1);
    }
    const { rows: indexes } = await ownerClient.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'printers' AND indexname = 'idx_printers_one_default_per_purpose'`,
    );
    expect(indexes).toHaveLength(1);
    expect(String(indexes[0].indexdef)).toContain("UNIQUE");
  });

  it("records print ATTEMPTS, not documents (migration 0213)", async () => {
    // 0173 made `print_request_id` NOT NULL and UNIQUE (location_id,
    // print_request_id), and the screens' ids are per DOCUMENT
    // (`receipt:{orderId}`, `label:{code}`) — so a reprint collided with the
    // first row and was recorded nowhere. An attempt is the row itself now:
    // the correlation id may repeat, and may be absent.
    const { rows: column } = await ownerClient.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'print_jobs' AND column_name = 'print_request_id'`,
    );
    expect(column[0].is_nullable).toBe("YES");

    const { rows: unique } = await ownerClient.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'print_jobs'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) LIKE '%(location_id, print_request_id)%'`,
    );
    expect(unique).toHaveLength(0);

    const sameDocument = "receipt:attempt-test";
    await ownerClient.query(
      `INSERT INTO print_jobs (location_id, document_type, printer_id, print_request_id, status)
       VALUES ($1, 'receipt', $2, $3, 'handed_off'), ($1, 'receipt', $2, $3, 'failed')`,
      [seededLocationId, seededPrinterId, sameDocument],
    );
    const { rows: attempts } = await ownerClient.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM print_jobs WHERE location_id = $1 AND print_request_id = $2`,
      [seededLocationId, sameDocument],
    );
    expect(attempts[0].count).toBe(2);
    // A print that carried no id at all is still an attempt (the server mints
    // its own row id and answers with it).
    const { rows: anonymous } = await ownerClient.query<{ id: string }>(
      `INSERT INTO print_jobs (location_id, document_type, printer_id, status)
       VALUES ($1, 'receipt', $2, 'sending') RETURNING id`,
      [seededLocationId, seededPrinterId],
    );
    expect(anonymous[0].id).toMatch(/^[0-9a-f-]{36}$/i);
    // …and the correlation id stays queryable for support.
    const { rows: indexes } = await ownerClient.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'print_jobs' AND indexname = 'idx_print_jobs_request'`,
    );
    expect(indexes).toHaveLength(1);
  });

  it("installs durable diagnostics, immutable snapshot column, one-fallback-per-primary constraint, and safe historical provenance repair (migrations 0222 and 0223)", async () => {
    const { rows: cols } = await ownerClient.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'print_jobs'
          AND column_name IN (
            'attempt_number',
            'previous_job_id',
            'route_reason',
            'delivery_outcome',
            'printer_name',
            'fallback_from_printer_id',
            'fallback_from_printer_name',
            'template_name',
            'template_paper',
            'template_source',
            'render_snapshot'
          )
        ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      "attempt_number",
      "delivery_outcome",
      "fallback_from_printer_id",
      "fallback_from_printer_name",
      "previous_job_id",
      "printer_name",
      "render_snapshot",
      "route_reason",
      "template_name",
      "template_paper",
      "template_source",
    ]);

    // The two reprints inserted above under 'receipt:attempt-test' keep attempt_number = 1,
    // previous_job_id = NULL, and route_reason = 'unknown':
    const { rows: historicalReprints } = await ownerClient.query<{
      attempt_number: number;
      previous_job_id: string | null;
      route_reason: string;
    }>(
      `SELECT attempt_number, previous_job_id, route_reason
         FROM print_jobs
        WHERE location_id = $1 AND print_request_id = 'receipt:attempt-test'
        ORDER BY created_at ASC`,
      [seededLocationId],
    );
    expect(historicalReprints).toEqual([
      { attempt_number: 1, previous_job_id: null, route_reason: "unknown" },
      { attempt_number: 1, previous_job_id: null, route_reason: "unknown" },
    ]);

    const { rows: backupPrinter } = await ownerClient.query<{ id: string }>(
      `INSERT INTO printers (location_id, name, kind, printer_class, paper, paper_width_mm, is_active, connection)
       VALUES ($1, 'Backup Mig Printer', 'receipt', 'thermal', 'thermal80', 80, true, '{"type":"windows","systemName":"Backup-Mig"}'::jsonb)
       RETURNING id`,
      [seededLocationId],
    );
    const backupPrinterId = backupPrinter[0].id;

    const validSnapshot = JSON.stringify({
      documentType: "receipt",
      documentSource: "order-receipt",
      primaryPrinterId: seededPrinterId,
      job: { type: "receipt" },
      template: {
        templateKey: "receipt-standard",
        templateVersion: 1,
        template: { name: "رسید", paper: "thermal80", blocks: [] },
      },
      branding: {},
    });

    const { rows: primary } = await ownerClient.query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, printer_id, status, error_code, delivery_outcome, attempt_number, route_reason, render_snapshot)
       VALUES ($1, 'receipt', $2, 'failed', 'printer_offline', 'not_delivered', 1, 'rule', $3::jsonb)
       RETURNING id`,
      [seededLocationId, seededPrinterId, validSnapshot],
    );
    const primaryId = primary[0].id;

    // First fallback attempt linked via previous_job_id succeeds:
    const { rows: fallback1 } = await ownerClient.query<{ id: string }>(
      `INSERT INTO print_jobs
         (location_id, document_type, printer_id, status, delivery_outcome, attempt_number, previous_job_id, route_reason, fallback_from_printer_id, render_snapshot)
       VALUES ($1, 'receipt', $2, 'handed_off', 'handed_off', 2, $3, 'runtime_fallback', $4, $5::jsonb)
       RETURNING id`,
      [seededLocationId, backupPrinterId, primaryId, seededPrinterId, validSnapshot],
    );
    expect(fallback1[0].id).toMatch(/^[0-9a-f-]{36}$/i);

    // A second fallback attempt for the same primary job row is rejected by idx_print_jobs_unique_previous_job:
    await expect(
      ownerClient.query(
        `INSERT INTO print_jobs
           (location_id, document_type, printer_id, status, delivery_outcome, attempt_number, previous_job_id, route_reason)
         VALUES ($1, 'receipt', $2, 'handed_off', 'handed_off', 2, $3, 'runtime_fallback')`,
        [seededLocationId, backupPrinterId, primaryId],
      ),
    ).rejects.toThrow();

    // An attempt_number > 2 is rejected by print_jobs_attempt_number_check:
    await expect(
      ownerClient.query(
        `INSERT INTO print_jobs
           (location_id, document_type, printer_id, status, attempt_number)
         VALUES ($1, 'receipt', $2, 'sending', 3)`,
        [seededLocationId, seededPrinterId],
      ),
    ).rejects.toThrow();

    // Simulate a database that applied the earlier 0222 revision (stored in
    // schema_migrations with its prior SHA-256 checksum) before 0223 ran,
    // where the earlier 0222 backfill falsely linked an intentional reprint as attempt 2:
    const { rows: reprintRows } = await ownerClient.query<{ id: string }>(
      `SELECT id FROM print_jobs WHERE location_id = $1 AND print_request_id = 'receipt:attempt-test' ORDER BY created_at ASC`,
      [seededLocationId],
    );
    await ownerClient.query(
      `UPDATE print_jobs
          SET attempt_number = 2,
              previous_job_id = $1,
              route_reason = 'runtime_fallback',
              fallback_from_printer_id = $2,
              fallback_from_printer_name = 'Old Primary'
        WHERE id = $3`,
      [reprintRows[0].id, seededPrinterId, reprintRows[1].id],
    );
    await ownerClient.query(
      `UPDATE schema_migrations
          SET checksum = '4450f27e4262cb3586dc553edc5c273f823c0f15643a9ab3886d66c38886f476'
        WHERE filename = '0222_print_jobs_diagnostics_and_fallback.sql'`,
    );
    await ownerClient.query(
      `DELETE FROM schema_migrations WHERE filename = '0223_print_jobs_correct_historical_provenance.sql'`,
    );

    // Run `runMigrations`: must repair 0222's checksum and execute 0223:
    const migResult = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
    expect(migResult.repairedChecksums).toContain("0222_print_jobs_diagnostics_and_fallback.sql");
    expect(migResult.applied).toBe(1);

    // Verify 0223 repaired the falsely-linked reprint back to attempt 1 / unknown provenance:
    const { rows: repairedReprint } = await ownerClient.query<{
      attempt_number: number;
      previous_job_id: string | null;
      route_reason: string;
      fallback_from_printer_id: string | null;
      fallback_from_printer_name: string | null;
    }>(
      `SELECT attempt_number, previous_job_id, route_reason, fallback_from_printer_id, fallback_from_printer_name
         FROM print_jobs
        WHERE id = $1`,
      [reprintRows[1].id],
    );
    expect(repairedReprint[0]).toEqual({
      attempt_number: 1,
      previous_job_id: null,
      route_reason: "unknown",
      fallback_from_printer_id: null,
      fallback_from_printer_name: null,
    });

    // Verify 0223 preserved the legitimate runtime fallback row untouched:
    const { rows: preservedFallback } = await ownerClient.query<{
      attempt_number: number;
      previous_job_id: string | null;
      route_reason: string;
      fallback_from_printer_id: string | null;
    }>(
      `SELECT attempt_number, previous_job_id, route_reason, fallback_from_printer_id
         FROM print_jobs
        WHERE id = $1`,
      [fallback1[0].id],
    );
    expect(preservedFallback[0]).toEqual({
      attempt_number: 2,
      previous_job_id: primaryId,
      route_reason: "runtime_fallback",
      fallback_from_printer_id: seededPrinterId,
    });
  });

  it("keeps every converted row readable by the runtime model", async () => {
    // The settings screen and the resolver read a printer through the row +
    // `connection`; a row that says `type` and a target must be usable, and a
    // legacy one must be refused with `needsReconnect`.
    const { rows } = await ownerClient.query(`SELECT name, connection, is_active FROM printers ORDER BY name`);
    for (const row of rows as { name: string; connection: Record<string, unknown>; is_active: boolean }[]) {
      const connection = row.connection;
      if (connection.needsReconnect === true) continue;
      if (connection.type === "windows") {
        expect(typeof connection.systemName, row.name).toBe("string");
      } else {
        expect(connection.type, row.name).toBe("network");
        expect(typeof connection.ip, row.name).toBe("string");
      }
    }
  });
});
