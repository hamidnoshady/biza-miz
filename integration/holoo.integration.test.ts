/** Phase 26 Holoo DB integration smoke tests. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { coaTemplateForIndustry, WELL_KNOWN_CODES } from "../src/lib/coa-template";
import { closeDatabasePool, withTenant } from "../src/lib/db";
import { importJournalVouchers, importOpeningBalance, previewJournalVouchers } from "../src/lib/integrations/holoo/journal-import-service";
import { applyBaseImport, previewableHolooAccountCodes } from "../src/lib/integrations/holoo/import-service";
import type { MappedAccount } from "../src/lib/integrations/holoo/mappers";
import { completeImportRun, beginImportRun } from "../src/lib/integrations/holoo/migration-run-service";
import { rollbackImportRun } from "../src/lib/integrations/holoo/rollback-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl)
  throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let client: Client;
let businessId: string;
let locationId: string;
let connectionId: string;

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

beforeAll(async () => {
  databaseName = `pos_holoo_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const databaseUrl = urlFor(databaseName);
  process.env.DATABASE_URL = databaseUrl;
  await closeDatabasePool();
  await runMigrations({ databaseUrl, quiet: true });
  client = new Client({ connectionString: databaseUrl });
  await client.connect();

  ({
    rows: [{ id: businessId }],
  } = await client.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Holoo Biz', 'holoo-biz') RETURNING id",
  ));
  ({
    rows: [{ id: locationId }],
  } = await client.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  ));
}, 120_000);

afterAll(async () => {
  await closeDatabasePool();
  await client?.end();
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

describe("Holoo integration schema", () => {
  it("allows a Holoo connection without WooCommerce credentials while preserving WooCommerce credential checks", async () => {
    await expect(
      client.query(
        `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
         VALUES ($1, $2, 'Bad Woo', 'woocommerce', NULL, 'toman')`,
        [businessId, locationId],
      ),
    ).rejects.toThrow();

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
       VALUES ($1, $2, 'Holoo', 'holoo', NULL, 'rial') RETURNING id`,
      [businessId, locationId],
    );
    connectionId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO holoo_connection_settings
         (business_id, connection_id, host, port, database, currency_unit, write_mode, schema_profile, direct_sql_profile_key)
       VALUES ($1, $2, '192.168.1.10', 1433, 'HolooDb', 'rial', 'direct_sql', 'holoo-generic', 'holoo-generic')`,
      [businessId, connectionId],
    );

    const { rows } = await client.query<{
      provider: string;
      schema_profile: string;
      direct_sql_profile_key: string;
    }>(
      `SELECT c.provider, h.schema_profile, h.direct_sql_profile_key
         FROM integration_connections c JOIN holoo_connection_settings h ON h.connection_id = c.id
        WHERE c.id = $1`,
      [connectionId],
    );
    expect(rows[0]).toMatchObject({
      provider: "holoo",
      schema_profile: "holoo-generic",
      direct_sql_profile_key: "holoo-generic",
    });
  });

  it("accepts Holoo document outbox kinds", async () => {
    const { rowCount } = await client.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, local_id, payload)
       VALUES ($1, $2, 'holoo_sale', 'order:1', NULL, '{"sourceId":"order:1","kind":"sale","values":[]}'::jsonb)`,
      [businessId, connectionId],
    );
    expect(rowCount).toBe(1);
  });

  it("imports opening balances through the exact journal path without losing large Rial precision", async () => {
    const assetCode = "1999";
    const exactRial = 9007199254740993n;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO integration_connections (business_id, location_id, name, provider, base_url, currency_unit)
       VALUES ($1, $2, 'Holoo Opening', 'holoo', NULL, 'rial') RETURNING id`,
      [businessId, locationId],
    );

    await client.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, $2, 'Imported asset', 'asset'),
              ($1, $3, 'Opening equity', 'equity')`,
      [businessId, assetCode, WELL_KNOWN_CODES.openingEquity],
    );

    const result = await withTenant(businessId, () =>
      importOpeningBalance(
        businessId,
        inserted.rows[0].id,
        [{ accountCode: assetCode, debitRial: exactRial }],
        null,
      ),
    );

    expect(result.entryId).toBeTruthy();
    expect(result.unmappedAccounts).toEqual([]);

    const { rows } = await client.query<{
      code: string;
      debit: string;
      credit: string;
    }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1
        ORDER BY a.code`,
      [result.entryId],
    );
    const byCode = new Map(
      rows.map((row) => [row.code, { debit: row.debit, credit: row.credit }]),
    );
    expect(byCode.get(assetCode)).toEqual({
      debit: exactRial.toString(),
      credit: "0",
    });
    expect(byCode.get(WELL_KNOWN_CODES.openingEquity)).toEqual({
      debit: "0",
      credit: exactRial.toString(),
    });
  });

  it("imports journal vouchers exactly once through ledger services and rolls back only the run-owned entry", async () => {
    const debitCode = "2891";
    const creditCode = "2892";
    const remoteVoucherId = `J-${randomUUID()}`;
    const exactRial = 9007199254740993n;
    await client.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, $2, 'Voucher debit', 'asset'), ($1, $3, 'Voucher credit', 'liability')`,
      [businessId, debitCode, creditCode],
    );

    const runId = await withTenant(businessId, () => beginImportRun(businessId, connectionId, null));
    const vouchers = [{
      remoteId: remoteVoucherId,
      entryDate: "2025-02-03",
      memo: "Workbook voucher",
      lines: [
        { accountCode: debitCode, debitRial: exactRial.toString() },
        { accountCode: creditCode, creditRial: exactRial.toString() },
      ],
    }];
    const preview = await withTenant(businessId, () => previewJournalVouchers(businessId, connectionId, vouchers));
    expect(preview).toMatchObject({ importable: 1, alreadyMapped: 0, unbalanced: [], unmappedAccounts: [], skippedEmpty: [] });
    const first = await withTenant(businessId, () =>
      importJournalVouchers(businessId, connectionId, vouchers, null, runId, locationId),
    );
    expect(first.imported).toBe(1);
    expect(first.alreadyMapped).toBe(0);
    const retry = await withTenant(businessId, () =>
      importJournalVouchers(businessId, connectionId, vouchers, null, runId, locationId),
    );
    expect(retry.imported).toBe(0);
    expect(retry.alreadyMapped).toBe(1);

    const { rows: entries } = await client.query<{ id: string; location_id: string; source_type: string }>(
      `SELECT je.id, je.location_id, je.source_type
         FROM integration_mappings m
         JOIN journal_entries je ON je.id = m.local_id
        WHERE m.business_id = $1 AND m.connection_id = $2
          AND m.entity_type = 'holoo_journal' AND m.remote_id = $3`,
      [businessId, connectionId, remoteVoucherId],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ location_id: locationId, source_type: "holoo_import" });
    const { rows: lineRows } = await client.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1 ORDER BY a.code`,
      [entries[0].id],
    );
    expect(lineRows).toEqual([
      { code: debitCode, debit: exactRial.toString(), credit: "0" },
      { code: creditCode, debit: "0", credit: exactRial.toString() },
    ]);

    await withTenant(businessId, () => completeImportRun(businessId, runId, {
      provider: "holoo",
      selectedScopes: ["accounts", "journal", "journalLines"],
      rollbackState: "available",
    }));
    const rolledBack = await withTenant(businessId, () => rollbackImportRun(businessId, runId, connectionId));
    expect(rolledBack.reverted.holoo_journal).toBe(1);
    const remaining = await client.query(
      `SELECT id FROM journal_entries WHERE id = $1`,
      [entries[0].id],
    );
    expect(remaining.rowCount).toBe(0);
    const mapping = await client.query(
      `SELECT remote_id FROM integration_mappings
        WHERE connection_id = $1 AND entity_type = 'holoo_journal' AND remote_id = $2`,
      [connectionId, remoteVoucherId],
    );
    expect(mapping.rowCount).toBe(0);
  });

  it("previews newly selected account rows as provisional, then imports and rolls back their journal references", async () => {
    const newAccountCode = "4899";
    const existingAccountCode = "2999";
    const remoteVoucherId = `J-${randomUUID()}`;
    await client.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, $2, 'Existing voucher offset', 'liability')`,
      [businessId, existingAccountCode],
    );
    const account = {
      remoteId: newAccountCode,
      code: newAccountCode,
      name: "Workbook account",
      nature: "debit",
      parentCode: null,
    };
    const vouchers = [{
      remoteId: remoteVoucherId,
      entryDate: "2025-03-04",
      memo: null,
      lines: [
        { accountCode: newAccountCode, debitRial: "2500" },
        { accountCode: existingAccountCode, creditRial: "2500" },
      ],
    }];
    const provisionalCodes = await withTenant(businessId, () =>
      previewableHolooAccountCodes(businessId, connectionId, [account]),
    );
    expect(provisionalCodes).toEqual([newAccountCode]);
    const preview = await withTenant(businessId, () =>
      previewJournalVouchers(businessId, connectionId, vouchers, provisionalCodes),
    );
    expect(preview.importable).toBe(1);
    expect(preview.unmappedAccounts).toEqual([]);

    const runId = await withTenant(businessId, () => beginImportRun(businessId, connectionId, null));
    await withTenant(businessId, () => applyBaseImport(
      businessId,
      connectionId,
      { goods: [], persons: [], accounts: [account] },
      runId,
      locationId,
    ));
    const applied = await withTenant(businessId, () =>
      importJournalVouchers(businessId, connectionId, vouchers, null, runId, locationId),
    );
    expect(applied.imported).toBe(1);
    await withTenant(businessId, () => completeImportRun(businessId, runId, {
      provider: "holoo",
      selectedScopes: ["accounts", "journal", "journalLines"],
      rollbackState: "available",
    }));
    const rolledBack = await withTenant(businessId, () => rollbackImportRun(businessId, runId, connectionId));
    expect(rolledBack.reverted.holoo_journal).toBe(1);
    expect(rolledBack.reverted.holoo_account).toBe(1);
    const accountRow = await client.query(`SELECT id FROM accounts WHERE business_id = $1 AND code = $2`, [businessId, newAccountCode]);
    expect(accountRow.rowCount).toBe(0);
  });
});

/**
 * Issue #824 finding 1. The importer resolves a child's parent two ways — by
 * mapping and by code — and both must be refused the same way the editor
 * refuses: an archived parent, a parent at the deepest tier, and a child whose
 * type differs from its parent's. Each refusal must also leave nothing behind:
 * no account row, no mapping, and nothing from the rest of the same batch.
 */
describe("issue #824 finding 1: Holoo account import honours the shared attachment rules", () => {
  /** The importer's own path: a fresh run, then one `applyBaseImport`. */
  function importAccounts(accounts: MappedAccount[]) {
    return withTenant(businessId, async () => {
      const runId = await beginImportRun(businessId, connectionId, null);
      return applyBaseImport(businessId, connectionId, { goods: [], persons: [], accounts }, runId, locationId);
    });
  }

  /** A Holoo account whose remote id is its code, as the schema profile maps it. */
  function holooAccount(code: string, parentCode: string | null, nature: string | null = null): MappedAccount {
    return { remoteId: code, code, name: `حساب ${code}`, nature, parentCode };
  }

  async function accountRow(code: string) {
    const { rows } = await client.query<{ level: string; type: string; is_active: boolean; parent_code: string | null }>(
      `SELECT a.level::text AS level, a.type::text AS type, a.is_active, p.code AS parent_code
         FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
        WHERE a.business_id = $1 AND a.code = $2`,
      [businessId, code],
    );
    return rows[0] ?? null;
  }

  async function mappingCount(remoteId: string): Promise<number> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'holoo_account' AND remote_id = $3`,
      [businessId, connectionId, remoteId],
    );
    return Number(rows[0].n);
  }

  // A root seed account of the default industry: resolved by the code branch,
  // because it is in the seed chart but not yet mapped.
  const seedRoot = coaTemplateForIndustry("food_service").find((a) => !a.parentCode && a.type === "asset")!.code;

  it("mapped parent: refuses a child under an archived parent and writes nothing", async () => {
    await importAccounts([holooAccount("9301", null)]);
    expect(await mappingCount("9301")).toBe(1);
    await client.query(`UPDATE accounts SET is_active = false WHERE business_id = $1 AND code = '9301'`, [businessId]);

    // A re-import: the parent is in the batch and already mapped, so the child
    // resolves its parent through the mapping. (A parent outside the batch is
    // not in the planner's known set; that child is reported as orphaned.)
    await expect(importAccounts([holooAccount("9301", null), holooAccount("9302", "9301")])).rejects.toThrow(/^parent_archived$/);
    expect(await accountRow("9302")).toBeNull();
    expect(await mappingCount("9302")).toBe(0);
  });

  it("code-resolved parent: refuses a child under an archived seed account and writes nothing", async () => {
    await client.query(
      `INSERT INTO accounts (business_id, code, name, type, level, is_active)
       VALUES ($1, $2, 'Archived seed root', 'asset', 'group', false)
       ON CONFLICT (business_id, code) DO UPDATE SET is_active = false`,
      [businessId, seedRoot],
    );
    await expect(importAccounts([holooAccount("9311", seedRoot)])).rejects.toThrow(/^parent_archived$/);
    expect(await accountRow("9311")).toBeNull();
    expect(await mappingCount("9311")).toBe(0);
    await client.query(`UPDATE accounts SET is_active = true WHERE business_id = $1 AND code = $2`, [businessId, seedRoot]);
  });

  it("mapped parent: refuses a child whose type differs from its parent, with nothing written", async () => {
    await importAccounts([holooAccount("9321", null)]);
    // 2xxx is a liability under holooAccountType; the parent is an asset.
    await expect(importAccounts([holooAccount("9321", null), holooAccount("2321", "9321")])).rejects.toThrow(/^parent_type_mismatch$/);
    expect(await accountRow("2321")).toBeNull();
    expect(await mappingCount("2321")).toBe(0);
  });

  it("code-resolved parent: refuses a child whose type differs from its parent, with nothing written", async () => {
    await client.query(
      `INSERT INTO accounts (business_id, code, name, type, level, is_active)
       VALUES ($1, $2, 'Seed root', 'asset', 'group', true)
       ON CONFLICT (business_id, code) DO UPDATE SET is_active = true`,
      [businessId, seedRoot],
    );
    await expect(importAccounts([holooAccount("2331", seedRoot)])).rejects.toThrow(/^parent_type_mismatch$/);
    expect(await accountRow("2331")).toBeNull();
    expect(await mappingCount("2331")).toBe(0);
  });

  it("derives each level from its parent through four tiers, and refuses a fifth with the whole batch rolled back", async () => {
    await importAccounts([
      holooAccount("9341", null),
      holooAccount("9342", "9341"),
      holooAccount("9343", "9342"),
      holooAccount("9344", "9343"),
    ]);
    expect((await accountRow("9341"))?.level).toBe("group");
    expect((await accountRow("9342"))?.level).toBe("kol");
    expect((await accountRow("9343"))?.level).toBe("moein");
    expect((await accountRow("9344"))?.level).toBe("tafsili");
    expect((await accountRow("9342"))?.parent_code).toBe("9341");

    // The fifth tier does not exist. The old importer clamped nothing here — it
    // threw — but the batch around it must not survive either.
    await expect(
      importAccounts([holooAccount("9343", "9342"), holooAccount("9344", "9343"), holooAccount("9351", null), holooAccount("9345", "9344")]),
    ).rejects.toThrow(/^parent_too_deep$/);
    expect(await accountRow("9345")).toBeNull();
    expect(await accountRow("9351")).toBeNull();
  });
});
