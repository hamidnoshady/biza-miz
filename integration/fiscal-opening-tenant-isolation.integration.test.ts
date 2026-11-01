/**
 * Issue #867 — tenant isolation and the service-layer answer to a
 * cross-tenant id, against a real database.
 *
 * The app pool connects as an unprivileged role, so row-level security
 * actually applies (superusers bypass it, and both the stock compose file
 * and the CI service make `pos` a superuser — same reasoning and the same
 * helper as authorization.integration.test.ts). Every table the feature
 * added (0217) carries the same `tenant_isolation` policy shape:
 *
 *   - opening_balance_sets / opening_balance_lines (child via set_id),
 *   - voucher_sequences, voucher_renumber_log,
 *   - summary_vouchers / summary_voucher_sources,
 *   - and the voucher columns on journal_entries, which ride the existing
 *     journal_entries policy.
 *
 * The service layer is pinned separately: a cross-tenant id must come back
 * as "not found", never as another business's data — the API answers 404
 * rather than 200-with-someone-else's-rows.
 */
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_fiscal_isolation_test_role";
const APP_PASSWORD = "fiscal-isolation-test-password";

let databaseName: string;
/** Owner connection: seeds fixtures across both tenants, bypassing RLS on purpose. */
let owner: Client;

let dbLib: typeof import("../src/lib/db");
let openingService: typeof import("../src/lib/opening-balances-service");
let voucherService: typeof import("../src/lib/voucher-numbering-service");

const alpha = { businessId: "", ownerId: "" };
const beta = { businessId: "", ownerId: "" };

/** Beta's fixtures, seeded through the owner connection. */
const fixtures = {
  accountId: "",
  setId: "",
  lineId: "",
  entryId: "",
  logId: "",
  summaryId: "",
  sourceId: "",
};

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = role.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function seedBusiness(name: string, slug: string, ownerEmail: string) {
  const biz = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  await owner.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Main')", [biz.rows[0].id]);
  const identity = await owner.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, 'Owner') RETURNING id`,
    [ownerEmail, await bcrypt.hash("owner-password", 10)],
  );
  const ownerUser = await owner.query<{ id: string }>(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email)
     VALUES ($1, $2, 'owner', 'Owner', $3) RETURNING id`,
    [biz.rows[0].id, identity.rows[0].id, ownerEmail],
  );
  return { businessId: biz.rows[0].id, ownerId: ownerUser.rows[0].id };
}

beforeAll(async () => {
  databaseName = `pos_fiscal_iso_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  // The library pool — everything the assertions go through — is the
  // unprivileged role; `owner` seeds fixtures across both tenants.
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  openingService = await import("../src/lib/opening-balances-service");
  voucherService = await import("../src/lib/voucher-numbering-service");

  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();

  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`, "alpha.owner@example.com"));
  Object.assign(beta, await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`, "beta.owner@example.com"));

  // Beta's fiscal-opening footprint: one account, one opening set with a
  // line, one numbered journal entry, its counter, a renumber log row for
  // it, and a summary voucher that aggregates it.
  const account = await owner.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset') RETURNING id`,
    [beta.businessId],
  );
  fixtures.accountId = account.rows[0].id;

  const set = await owner.query<{ id: string }>(
    `INSERT INTO opening_balance_sets
       (business_id, fiscal_year_label, effective_date, status, source)
     VALUES ($1, '1404', '2025-03-21', 'posted', 'manual') RETURNING id`,
    [beta.businessId],
  );
  fixtures.setId = set.rows[0].id;

  const line = await owner.query<{ id: string }>(
    `INSERT INTO opening_balance_lines (set_id, account_id, debit)
     VALUES ($1, $2, 1000) RETURNING id`,
    [fixtures.setId, fixtures.accountId],
  );
  fixtures.lineId = line.rows[0].id;

  const entry = await owner.query<{ id: string }>(
    `INSERT INTO journal_entries
       (business_id, entry_date, memo, voucher_number, voucher_sequence_no)
     VALUES ($1, '2025-04-01', 'beta entry', 'MJ-1404-000001', 1) RETURNING id`,
    [beta.businessId],
  );
  fixtures.entryId = entry.rows[0].id;

  await owner.query(
    `INSERT INTO voucher_sequences (business_id, fiscal_year_label, document_type, last_number)
     VALUES ($1, '1404', 'journal', 1)`,
    [beta.businessId],
  );

  const log = await owner.query<{ id: string }>(
    `INSERT INTO voucher_renumber_log
       (business_id, journal_entry_id, fiscal_year_label, document_type,
        previous_number, new_number, previous_sequence_no, new_sequence_no,
        reason, performed_by)
     VALUES ($1, $2, '1404', 'journal', NULL, 'MJ-1404-000001', NULL, 1,
             'backfilled', $3) RETURNING id`,
    [beta.businessId, fixtures.entryId, beta.ownerId],
  );
  fixtures.logId = log.rows[0].id;

  const summary = await owner.query<{ id: string }>(
    `INSERT INTO summary_vouchers
       (business_id, voucher_number, label, scope, entry_count, total_debit, total_credit, created_by)
     VALUES ($1, 'SV-1404-000001', 'Beta summary', '{"sourceTypes":["manual"]}', 1, 1000, 1000, $2)
     RETURNING id`,
    [beta.businessId, beta.ownerId],
  );
  fixtures.summaryId = summary.rows[0].id;

  const source = await owner.query<{ id: string }>(
    `INSERT INTO summary_voucher_sources
       (business_id, summary_voucher_id, journal_entry_id, entry_date,
        source_type, entry_voucher_number, total_debit, total_credit)
     VALUES ($1, $2, $3, '2025-04-01', 'manual', 'MJ-1404-000001', 1000, 1000)
     RETURNING id`,
    [beta.businessId, fixtures.summaryId, fixtures.entryId],
  );
  fixtures.sourceId = source.rows[0].id;
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("issue #867 — RLS on the new tables (unprivileged role, alpha's scope)", () => {
  it("sees none of beta's opening set rows, and its child lines are protected through the parent", async () => {
    await asBusiness(alpha.businessId, async () => {
      const sets = await dbLib.getPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM opening_balance_sets",
      );
      expect(sets.rows[0].n).toBe(0);

      const byId = await dbLib.getPool().query(
        "SELECT * FROM opening_balance_sets WHERE id = $1",
        [fixtures.setId],
      );
      expect(byId.rowCount).toBe(0);

      const lines = await dbLib.getPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM opening_balance_lines",
      );
      expect(lines.rows[0].n).toBe(0);

      const lineById = await dbLib.getPool().query(
        "SELECT * FROM opening_balance_lines WHERE id = $1",
        [fixtures.lineId],
      );
      expect(lineById.rowCount).toBe(0);
    });
  });

  it("refuses to write into beta's opening rows from alpha's scope", async () => {
    await asBusiness(alpha.businessId, async () => {
      await expect(
        dbLib.getPool().query(
          `INSERT INTO opening_balance_sets
             (business_id, fiscal_year_label, effective_date)
           VALUES ($1, '1404', '2025-03-21')`,
          [beta.businessId],
        ),
      ).rejects.toThrow(/row-level security/i);

      await expect(
        dbLib.getPool().query(
          "INSERT INTO opening_balance_lines (set_id, account_id, debit) VALUES ($1, $2, 500)",
          [fixtures.setId, fixtures.accountId],
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    // Nothing leaked into the table.
    const sets = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM opening_balance_sets WHERE business_id = $1",
      [beta.businessId],
    );
    expect(sets.rows[0].n).toBe(1);
  });

  it("keeps beta's voucher counters, renumber log, and summary vouchers out of alpha's scope", async () => {
    await asBusiness(alpha.businessId, async () => {
      for (const table of ["voucher_sequences", "voucher_renumber_log", "summary_vouchers", "summary_voucher_sources"]) {
        const { rows } = await dbLib.getPool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`,
        );
        expect(rows[0].n, `${table} must be empty for alpha`).toBe(0);
      }

      await expect(
        dbLib.getPool().query(
          `INSERT INTO voucher_sequences (business_id, fiscal_year_label, document_type)
           VALUES ($1, '1404', 'journal')`,
          [beta.businessId],
        ),
      ).rejects.toThrow(/row-level security/i);

      await expect(
        dbLib.getPool().query(
          `INSERT INTO voucher_renumber_log
             (business_id, journal_entry_id, fiscal_year_label, document_type, new_number, new_sequence_no, reason)
           VALUES ($1, $2, '1404', 'journal', 'MJ-1404-000099', 99, 'alpha tries')`,
          [beta.businessId, fixtures.entryId],
        ),
      ).rejects.toThrow(/row-level security/i);

      await expect(
        dbLib.getPool().query(
          `INSERT INTO summary_vouchers
             (business_id, voucher_number, label, scope, entry_count, total_debit, total_credit)
           VALUES ($1, 'SV-1404-000099', 'alpha summary', '{}', 0, 0, 0)`,
          [beta.businessId],
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it("hides beta's numbered journal entries from alpha's register", async () => {
    await asBusiness(alpha.businessId, async () => {
      const { rows } = await dbLib.getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM journal_entries
         WHERE voucher_number IS NOT NULL`,
      );
      expect(rows[0].n).toBe(0);

      const register = await voucherService.listVoucherRegister(alpha.businessId, {});
      expect(register.total).toBe(0);
      expect(register.rows).toHaveLength(0);
    });
  });

  it("lets beta see its own rows — the policy filters, it does not block", async () => {
    await asBusiness(beta.businessId, async () => {
      const { rows } = await dbLib.getPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM opening_balance_sets",
      );
      expect(rows[0].n).toBe(1);

      const register = await voucherService.listVoucherRegister(beta.businessId, {});
      expect(register.total).toBe(1);
      expect(register.rows[0].voucherNumber).toBe("MJ-1404-000001");
    });
  });
});

describe("issue #867 — the service layer answers cross-tenant ids with not-found", () => {
  it("getOpeningSet never returns another business's set", async () => {
    await expect(
      asBusiness(alpha.businessId, () => openingService.getOpeningSet(alpha.businessId, fixtures.setId)),
    ).resolves.toBeNull();
  });

  it("getSummaryVoucher never returns another business's voucher", async () => {
    await expect(
      asBusiness(alpha.businessId, () =>
        voucherService.getSummaryVoucher(alpha.businessId, fixtures.summaryId),
      ),
    ).resolves.toBeNull();
  });

  it("the renumber log and the register stay scoped to the caller's business", async () => {
    await asBusiness(alpha.businessId, async () => {
      expect(await voucherService.listRenumberLog(alpha.businessId)).toHaveLength(0);
      expect(await voucherService.listVoucherRegister(alpha.businessId, {})).toMatchObject({
        total: 0,
        rows: [],
      });
    });
  });

  it("and beta's own reads see exactly its own rows", async () => {
    await asBusiness(beta.businessId, async () => {
      const set = await openingService.getOpeningSet(beta.businessId, fixtures.setId);
      expect(set?.set.id).toBe(fixtures.setId);
      expect(set?.lines).toHaveLength(1);

      const summary = await voucherService.getSummaryVoucher(beta.businessId, fixtures.summaryId);
      expect(summary?.id).toBe(fixtures.summaryId);
      expect(summary?.sources).toHaveLength(1);

      const log = await voucherService.listRenumberLog(beta.businessId);
      expect(log).toHaveLength(1);
      expect(log[0].entryId).toBe(fixtures.entryId);
    });
  });
});
