import { describe, expect, it, vi } from "vitest";
import {
  RESTORE_IMMUTABLE_TABLES,
  TENANT_ARCHIVE_MAGIC,
  applyTenantArchive,
  archiveRowCounts,
  buildTenantArchive,
  parseTenantArchive,
  serializeTenantArchive,
  type TenantArchive,
} from "./tenant-archive";
import type { TenantExportTable } from "./tenant-export";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const ALLOWED = new Set(["accounts", "orders", "order_items"]);

function tables(): TenantExportTable[] {
  return [
    { name: "accounts", columns: ["id", "name"], rows: [{ id: "a1", name: "صندوق" }] },
    { name: "orders", columns: ["id", "total"], rows: [{ id: "o1", total: 1000 }, { id: "o2", total: 2500 }] },
  ];
}

function built() {
  return buildTenantArchive({
    businessId: BUSINESS,
    capturedAt: new Date("2026-10-01T00:00:00.000Z"),
    schemaVersion: 268,
    tables: tables(),
  });
}

describe("buildTenantArchive", () => {
  it("drops empty tables and normalizes JSON-hostile values", () => {
    const archive = buildTenantArchive({
      businessId: BUSINESS,
      capturedAt: new Date("2026-10-01T00:00:00.000Z"),
      schemaVersion: 3,
      tables: [
        { name: "accounts", columns: ["id"], rows: [] },
        {
          name: "orders",
          columns: ["id", "at", "big", "blob"],
          rows: [{ id: "o1", at: new Date("2026-01-02T03:04:05.000Z"), big: BigInt(10), blob: Buffer.from("hi") }],
        },
        {
          name: "order_items",
          columns: ["id", "huge"],
          rows: [{ id: "i1", huge: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(5) }],
        },
      ],
    });
    expect(archive.tables.map((table) => table.name)).toEqual(["orders", "order_items"]);
    expect(archive.tables[0].rows[0]).toEqual({
      id: "o1",
      at: "2026-01-02T03:04:05.000Z",
      big: 10,
      blob: "aGk=",
    });
    // Beyond Number.MAX_SAFE_INTEGER a number would silently lose digits.
    expect(archive.tables[1].rows[0].huge).toBe("9007199254740996");
  });

  it("serializes to JSON with the magic and version a reader checks first", () => {
    const raw = serializeTenantArchive(built());
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.magic).toBe(TENANT_ARCHIVE_MAGIC);
    expect(parsed.version).toBe(1);
    expect(archiveRowCounts(built())).toEqual({ accounts: 1, orders: 2 });
  });
});

describe("parseTenantArchive", () => {
  const ok = (raw: string, extra: { businessId?: string; maxSchemaVersion?: number } = {}) =>
    parseTenantArchive(raw, { allowedTables: ALLOWED, businessId: BUSINESS, ...extra });

  it("round-trips what the builder wrote", () => {
    const archive = built();
    const result = ok(serializeTenantArchive(archive));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archive.tables).toEqual(archive.tables);
    expect(result.archive.businessId).toBe(BUSINESS);
  });

  it.each([
    ["", "archive_empty"],
    ["not json", "archive_not_json"],
    ["[]", "archive_not_object"],
    [JSON.stringify({ magic: "OTHER", version: 1, businessId: BUSINESS }), "archive_magic_invalid"],
    [JSON.stringify({ magic: TENANT_ARCHIVE_MAGIC, version: 99, businessId: BUSINESS }), "archive_version_too_new"],
    [JSON.stringify({ magic: TENANT_ARCHIVE_MAGIC, version: 0, businessId: BUSINESS }), "archive_version_unsupported"],
    [JSON.stringify({ magic: TENANT_ARCHIVE_MAGIC, version: 1 }), "archive_business_missing"],
    [
      JSON.stringify({ magic: TENANT_ARCHIVE_MAGIC, version: 1, businessId: BUSINESS, capturedAt: "nope" }),
      "archive_captured_at_invalid",
    ],
    [
      JSON.stringify({
        magic: TENANT_ARCHIVE_MAGIC,
        version: 1,
        businessId: BUSINESS,
        capturedAt: "2026-10-01T00:00:00Z",
        schemaVersion: 0,
      }),
      "archive_schema_invalid",
    ],
    [
      JSON.stringify({
        magic: TENANT_ARCHIVE_MAGIC,
        version: 1,
        businessId: BUSINESS,
        capturedAt: "2026-10-01T00:00:00Z",
        schemaVersion: 1,
        tables: [],
      }),
      "archive_tables_missing",
    ],
    [
      JSON.stringify({
        magic: TENANT_ARCHIVE_MAGIC,
        version: 1,
        businessId: BUSINESS,
        capturedAt: "2026-10-01T00:00:00Z",
        schemaVersion: 1,
        tables: [{ name: "pg_shadow", columns: ["id"], rows: [] }],
      }),
      "archive_table_not_allowed:pg_shadow",
    ],
  ])("refuses %j with %s", (raw, error) => {
    const result = ok(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  it("refuses another business's archive — a restore is never cross-tenant", () => {
    const raw = JSON.stringify({ ...built(), businessId: "22222222-2222-4222-8222-222222222222" });
    const result = ok(raw);
    expect(result).toEqual({ ok: false, error: "archive_business_mismatch" });
  });

  it("refuses an archive newer than this installation", () => {
    const result = ok(serializeTenantArchive(built()), { maxSchemaVersion: 200 });
    expect(result).toEqual({ ok: false, error: "archive_schema_newer_than_installation" });
  });

  it("refuses unsafe identifiers, duplicate tables and column/row mismatches", () => {
    const base = built();
    const withTable = (patch: Record<string, unknown>) =>
      JSON.stringify({ ...base, tables: [{ ...base.tables[0], ...patch }] });

    expect(ok(withTable({ name: "orders; DROP TABLE users" }))).toEqual({
      ok: false,
      // Rejected by the identifier check before the allow-list is even consulted.
      error: "archive_table_invalid",
    });
    expect(ok(withTable({ columns: ["id", "id"] }))).toEqual({ ok: false, error: "archive_columns_invalid" });
    expect(ok(withTable({ columns: ["id", "1bad"] }))).toEqual({ ok: false, error: "archive_columns_invalid" });
    expect(ok(withTable({ rows: [{ id: "a1" }] }))).toEqual({ ok: false, error: "archive_row_columns_mismatch" });
    expect(ok(withTable({ rows: [{ id: "a1", name: "x", extra: 1 }] }))).toEqual({
      ok: false,
      error: "archive_row_columns_mismatch",
    });
    expect(ok(JSON.stringify({ ...base, tables: [base.tables[0], base.tables[0]] }))).toEqual({
      ok: false,
      error: "archive_table_duplicate",
    });
  });
});

/** A `pg` client stand-in that records every statement in order. */
function fakeClient() {
  const statements: { text: string; values?: unknown[] }[] = [];
  return {
    statements,
    query: vi.fn(async (text: string, values?: unknown[]) => {
      statements.push({ text, values });
      return { rowCount: text.startsWith("DELETE") ? 3 : 1, rows: [] };
    }),
  };
}

describe("applyTenantArchive", () => {
  it("deletes in reverse dependency order, then inserts in dependency order", async () => {
    const client = fakeClient();
    const result = await applyTenantArchive(client as never, built(), {
      tablesInOrder: ["accounts", "orders", "order_items"],
    });
    expect(statements(client)).toEqual([
      'DELETE FROM "orders"',
      'DELETE FROM "accounts"',
      'INSERT INTO "accounts" ("id", "name") VALUES ($1, $2)',
      'INSERT INTO "orders" ("id", "total") VALUES ($1, $2)',
      'INSERT INTO "orders" ("id", "total") VALUES ($1, $2)',
    ]);
    expect(result).toEqual({ deleted: 6, inserted: 3, tables: 2 });
  });

  it("parameterises every value — the archive is data, never SQL", async () => {
    const client = fakeClient();
    const hostile: TenantArchive = {
      ...built(),
      tables: [
        {
          name: "accounts",
          columns: ["id", "name"],
          rows: [{ id: "a1", name: "'); DROP TABLE accounts; --" }],
        },
      ],
    };
    await applyTenantArchive(client as never, hostile, { tablesInOrder: ["accounts", "orders"] });
    const insert = client.statements.find((statement) => statement.text.startsWith("INSERT"));
    expect(insert?.text).toBe('INSERT INTO "accounts" ("id", "name") VALUES ($1, $2)');
    expect(insert?.values).toEqual(["a1", "'); DROP TABLE accounts; --"]);
  });

  it("refuses a table it cannot place in dependency order", async () => {
    const client = fakeClient();
    await expect(
      applyTenantArchive(client as never, built(), { tablesInOrder: ["accounts"] }),
    ).rejects.toThrow("archive_table_order_incomplete");
    expect(client.statements).toHaveLength(0);
  });

  it("serializes an object cell rather than stringifying it into the statement", async () => {
    const client = fakeClient();
    const archive: TenantArchive = {
      ...built(),
      tables: [
        { name: "accounts", columns: ["id", "meta"], rows: [{ id: "a1", meta: { nested: true } }] },
      ],
    };
    await applyTenantArchive(client as never, archive, { tablesInOrder: ["accounts"] });
    const insert = client.statements.find((statement) => statement.text.startsWith("INSERT"));
    expect(insert?.values).toEqual(["a1", '{"nested":true}']);
  });
});

function statements(client: ReturnType<typeof fakeClient>): string[] {
  return client.statements.map((statement) => statement.text);
}

describe("applyTenantArchive — the money tables a restore must never rewind", () => {
  function withMoney(): TenantArchive {
    return {
      ...built(),
      tables: [
        ...built().tables,
        { name: "wallet_ledger", columns: ["id", "amount_rial"], rows: [{ id: "w1", amount_rial: 5000 }] },
        { name: "business_wallets", columns: ["business_id", "balance_rial"], rows: [{ business_id: "b1", balance_rial: 0 }] },
      ],
    };
  }

  it("leaves the wallet and the ledger exactly as they are", async () => {
    const client = fakeClient();
    const result = await applyTenantArchive(client as never, withMoney(), {
      tablesInOrder: ["accounts", "orders", "order_items", "wallet_ledger", "business_wallets"],
      skipTables: RESTORE_IMMUTABLE_TABLES,
    });

    // Not one statement reaches a money table: no DELETE, no INSERT.
    const touched = statements(client).filter((text) => /wallet/.test(text));
    expect(touched).toEqual([]);
    expect(result).toEqual({ deleted: 6, inserted: 3, tables: 2 });
  });

  it("still refuses a table it cannot place in dependency order", async () => {
    const client = fakeClient();
    await expect(
      applyTenantArchive(client as never, withMoney(), {
        // A skipped table needs no position in the order; an ordinary one does.
        tablesInOrder: ["accounts"],
        skipTables: RESTORE_IMMUTABLE_TABLES,
      }),
    ).rejects.toThrow("archive_table_order_incomplete");
  });

  it("without the skip set the archive would have rewound the balance", () => {
    // The behaviour this set exists to prevent, stated once so the reason is
    // visible in the test rather than only in the comment above it.
    const archive = withMoney();
    expect(archive.tables.some((table) => table.name === "business_wallets")).toBe(true);
    expect(RESTORE_IMMUTABLE_TABLES.has("business_wallets")).toBe(true);
    expect(RESTORE_IMMUTABLE_TABLES.has("wallet_ledger")).toBe(true);
    expect(RESTORE_IMMUTABLE_TABLES.has("billing_usage_events")).toBe(true);
  });
});
