/**
 * سیستم ادواری — the period-close document, tested end-to-end through a
 * scripted PoolClient (the closing-service.test.ts approach): every SQL the
 * service issues is answered from a small in-memory script, so the whole
 * chain — validation, layer building, valuation under the locked method and
 * the compound closing entry's exact lines — is pinned without a database.
 * The pure valuation arithmetic itself is covered by periodic-valuation.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { createPeriodicClosing, listPeriodicClosings } from "./periodic-closing-service";

interface Call {
  sql: string;
  params: unknown[];
}

/** A PoolClient whose query() answers from `respond` and records every call. */
function scriptedClient(respond: (sql: string, params: unknown[]) => Record<string, unknown>[] | undefined) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: flat, params });
      const rows = respond(flat, params);
      if (rows === undefined) throw new Error(`unexpected query: ${flat}`);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const ACCOUNTS = [
  { code: "5100", id: "acc-cogs" },
  { code: "1300", id: "acc-inventory" },
  { code: "5105", id: "acc-periodic-purchases" },
];

interface Script {
  costing?: { method: string; system?: string; lockedAt: string | null };
  previous?: { id: string; period_end: string; ending_value_rial: string } | null;
  previousLines?: Array<{ inventory_item_id: string; counted_qty: string; ending_value_rial: string }>;
  purchases?: Array<{
    inventory_item_id: string;
    quantity: string;
    extended_cost: string;
    purchase_date: string;
    received_at: string | null;
  }>;
  ownedItemIds?: string[] | "echo";
}

/**
 * The voucher-numbering queries every posting now issues in-transaction
 * (issue #867): the fiscal-year lookup, the counter upsert/lock/increment and
 * the entry's own number. A mock counter starting at zero is enough — these
 * tests pin the posting's lines, not the number.
 */
function voucherRows(flat: string): Record<string, unknown>[] | undefined {
  if (flat.includes("SELECT id FROM fiscal_years")) return [];
  if (flat.includes("INSERT INTO voucher_sequences")) return [];
  if (flat.includes("FROM voucher_sequences")) return [{ last_number: "0" }];
  if (flat.includes("UPDATE voucher_sequences")) return [];
  if (flat.includes("UPDATE journal_entries") && flat.includes("voucher_number")) return [];
  return undefined;
}

/** Answers the service's queries in the shape the real schema would. */
function respondWith(script: Script) {
  return (sql: string, params: unknown[]): Record<string, unknown>[] | undefined => {
    const voucher = voucherRows(sql);
    if (voucher !== undefined) return voucher;
    if (sql.includes("FROM settings")) {
      return script.costing ? [{ value: script.costing }] : [];
    }
    if (sql.includes("SELECT id FROM inventory_items")) {
      const requested = params[0] as string[];
      if (script.ownedItemIds === "echo" || script.ownedItemIds === undefined) {
        return requested.map((id) => ({ id }));
      }
      return script.ownedItemIds.filter((id) => requested.includes(id)).map((id) => ({ id }));
    }
    if (sql.includes("FROM periodic_closing_lines")) return script.previousLines ?? [];
    if (sql.includes("FROM periodic_closings") && sql.includes("ORDER BY period_end DESC")) {
      return script.previous ? [script.previous] : [];
    }
    if (sql.includes("FROM purchase_items")) return script.purchases ?? [];
    if (sql.includes("INSERT INTO periodic_closing_lines")) return [];
    if (sql.includes("INSERT INTO periodic_closings")) return [{ id: "closing-1" }];
    if (sql.includes("SELECT code, id FROM accounts")) return ACCOUNTS;
    // The entry's own date is what its voucher number is derived from, so
    // the RETURNING carries it the way the real column does.
    if (sql.includes("INSERT INTO journal_entries")) return [{ id: "entry-1", entry_date: "2026-01-31" }];
    if (sql.includes("INSERT INTO journal_lines")) return [];
    if (sql.includes("SELECT set_config('app.fiscal_constructing_entry_id'")) return [];
    if (sql.includes("UPDATE periodic_closings SET journal_entry_id")) return [];
    return undefined;
  };
}

function baseParams(overrides: Partial<Parameters<typeof createPeriodicClosing>[1]> = {}) {
  return {
    businessId: "biz-1",
    locationId: "loc-1",
    periodEnd: "2026-01-31",
    note: null,
    lines: [{ inventoryItemId: "item-a", countedQty: "4" }],
    createdBy: "user-1",
    ...overrides,
  };
}

function journalLines(calls: Call[]) {
  return calls
    .filter((call) => call.sql.includes("INSERT INTO journal_lines"))
    .map((call) => ({ accountId: call.params[1], debit: call.params[2], credit: call.params[3] }));
}

describe("createPeriodicClosing", () => {
  it("first close, weighted average: values the count from the pooled purchases and posts the compound entry", async () => {
    const { client, calls } = scriptedClient(
      respondWith({
        costing: { method: "weighted_average", system: "periodic", lockedAt: null },
        previous: null,
        // 10 units bought for 1000 → pooled unit cost 100.
        purchases: [
          { inventory_item_id: "item-a", quantity: "10", extended_cost: "1000", purchase_date: "2026-01-10", received_at: null },
        ],
      }),
    );

    const result = await createPeriodicClosing(client, baseParams());

    // Ending = 4 × 100 = 400; COGS = 0 + 1000 − 400 = 600.
    expect(result).toEqual({
      id: "closing-1",
      beginningValueRial: "0",
      purchasesValueRial: "1000",
      endingValueRial: "400",
      cogsValueRial: "600",
    });

    // The header row carries the same totals and the locked method.
    const header = calls.find((c) => c.sql.includes("INSERT INTO periodic_closings ("))!;
    expect(header.params.slice(0, 8)).toEqual([
      "biz-1", "loc-1", "2026-01-31", "weighted_average", "0", "1000", "400", "600",
    ]);

    // One line per counted item, at its ending value.
    const lineInsert = calls.find((c) => c.sql.includes("INSERT INTO periodic_closing_lines"))!;
    expect(lineInsert.params).toEqual(["closing-1", "item-a", "4", "400"]);

    // The closing entry: Dr 5100 COGS 600, Dr 1300 net restatement 400, Cr 5105 purchases 1000.
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "600", credit: "0" },
      { accountId: "acc-inventory", debit: "400", credit: "0" },
      { accountId: "acc-periodic-purchases", debit: "0", credit: "1000" },
    ]);

    // Entry is dated the period end and wears the periodic_closing kind.
    const entry = calls.find((c) => c.sql.includes("INSERT INTO journal_entries"))!;
    expect(entry.params[2]).toBe("2026-01-31");
    expect(entry.params[4]).toBe("periodic_closing");
    expect(entry.params[7]).toBe("periodic_closing");

    // The posted entry id is written back onto the closing.
    const update = calls.find((c) => c.sql.includes("UPDATE periodic_closings SET journal_entry_id"))!;
    expect(update.params).toEqual(["closing-1", "entry-1"]);
  });

  it("second close, FIFO: what remains is the newest layers (beginning is the previous close)", async () => {
    const { client, calls } = scriptedClient(
      respondWith({
        costing: { method: "fifo", system: "periodic", lockedAt: null },
        previous: { id: "prev-1", period_end: "2026-01-31", ending_value_rial: "400" },
        previousLines: [{ inventory_item_id: "item-a", counted_qty: "4", ending_value_rial: "400" }],
        // This period: 6 more units for 900 (unit 150).
        purchases: [
          { inventory_item_id: "item-a", quantity: "6", extended_cost: "900", purchase_date: "2026-02-10", received_at: null },
        ],
      }),
    );

    const result = await createPeriodicClosing(
      client,
      baseParams({ periodEnd: "2026-02-28", lines: [{ inventoryItemId: "item-a", countedQty: "5" }] }),
    );

    // FIFO ending = newest layers: 5 of the 6-unit purchase → 900 × 5/6 = 750.
    // COGS = 400 + 900 − 750 = 550.
    expect(result.beginningValueRial).toBe("400");
    expect(result.purchasesValueRial).toBe("900");
    expect(result.endingValueRial).toBe("750");
    expect(result.cogsValueRial).toBe("550");

    // Net 1300 restatement = 750 − 400 = 350 debit.
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "550", credit: "0" },
      { accountId: "acc-inventory", debit: "350", credit: "0" },
      { accountId: "acc-periodic-purchases", debit: "0", credit: "900" },
    ]);

    // The purchase window opens after the previous close.
    const purchases = calls.find((c) => c.sql.includes("FROM purchase_items"))!;
    expect(purchases.params).toEqual(["loc-1", "2026-02-28", "2026-01-31"]);
  });

  it("second close, LIFO: what remains is the oldest layers", async () => {
    const { client } = scriptedClient(
      respondWith({
        costing: { method: "lifo", system: "periodic", lockedAt: null },
        previous: { id: "prev-1", period_end: "2026-01-31", ending_value_rial: "400" },
        previousLines: [{ inventory_item_id: "item-a", counted_qty: "4", ending_value_rial: "400" }],
        purchases: [
          { inventory_item_id: "item-a", quantity: "6", extended_cost: "900", purchase_date: "2026-02-10", received_at: null },
        ],
      }),
    );

    const result = await createPeriodicClosing(
      client,
      baseParams({ periodEnd: "2026-02-28", lines: [{ inventoryItemId: "item-a", countedQty: "5" }] }),
    );

    // LIFO ending = oldest layers: all 4 beginning (400) + 1 of the purchase (900/6 = 150) = 550.
    expect(result.endingValueRial).toBe("550");
    expect(result.cogsValueRial).toBe("750");
  });

  it("posts a credit-side COGS when the count exceeds beginning + purchases", async () => {
    const { client, calls } = scriptedClient(
      respondWith({
        costing: { method: "weighted_average", system: "periodic", lockedAt: null },
        previous: null,
        purchases: [
          { inventory_item_id: "item-a", quantity: "2", extended_cost: "200", purchase_date: "2026-01-10", received_at: null },
        ],
      }),
    );

    // Counted 3 against 2 bought: the excess unit is valued at the pooled cost.
    const result = await createPeriodicClosing(
      client,
      baseParams({ lines: [{ inventoryItemId: "item-a", countedQty: "3" }] }),
    );

    expect(result.endingValueRial).toBe("300");
    expect(result.cogsValueRial).toBe("-100");
    expect(journalLines(calls)).toEqual([
      { accountId: "acc-cogs", debit: "0", credit: "100" },
      { accountId: "acc-inventory", debit: "300", credit: "0" },
      { accountId: "acc-periodic-purchases", debit: "0", credit: "200" },
    ]);
  });

  it("rejects a malformed period end before touching the database", async () => {
    const { client, calls } = scriptedClient(() => undefined);
    await expect(createPeriodicClosing(client, baseParams({ periodEnd: "31-01-2026" }))).rejects.toThrow(
      "invalid_period_end",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects an empty count", async () => {
    const { client } = scriptedClient(() => undefined);
    await expect(createPeriodicClosing(client, baseParams({ lines: [] }))).rejects.toThrow("no_items");
  });

  it("refuses a perpetual business", async () => {
    const { client } = scriptedClient(respondWith({ costing: { method: "fifo", lockedAt: null } }));
    await expect(createPeriodicClosing(client, baseParams())).rejects.toThrow("not_periodic_system");
  });

  it("refuses a business with no costing setting at all (defaults perpetual)", async () => {
    const { client } = scriptedClient(respondWith({}));
    await expect(createPeriodicClosing(client, baseParams())).rejects.toThrow("not_periodic_system");
  });

  it("rejects a line without an item id", async () => {
    const { client } = scriptedClient(respondWith({ costing: { method: "fifo", system: "periodic", lockedAt: null } }));
    await expect(
      createPeriodicClosing(client, baseParams({ lines: [{ inventoryItemId: "", countedQty: "1" }] })),
    ).rejects.toThrow("invalid_item");
  });

  it("rejects a negative or malformed counted quantity", async () => {
    const { client } = scriptedClient(respondWith({ costing: { method: "fifo", system: "periodic", lockedAt: null } }));
    await expect(
      createPeriodicClosing(client, baseParams({ lines: [{ inventoryItemId: "item-a", countedQty: "-2" }] })),
    ).rejects.toThrow("invalid_item");
    await expect(
      createPeriodicClosing(client, baseParams({ lines: [{ inventoryItemId: "item-a", countedQty: "abc" }] })),
    ).rejects.toThrow("invalid_item");
  });

  it("rejects an item the branch does not own", async () => {
    const { client } = scriptedClient(
      respondWith({ costing: { method: "fifo", system: "periodic", lockedAt: null }, ownedItemIds: [] }),
    );
    await expect(createPeriodicClosing(client, baseParams())).rejects.toThrow("item_not_found");
  });

  it("rejects a period end on or before the previous close", async () => {
    const { client } = scriptedClient(
      respondWith({
        costing: { method: "fifo", system: "periodic", lockedAt: null },
        previous: { id: "prev-1", period_end: "2026-01-31", ending_value_rial: "0" },
      }),
    );
    await expect(createPeriodicClosing(client, baseParams({ periodEnd: "2026-01-31" }))).rejects.toThrow(
      "period_end_not_after_previous",
    );
    await expect(createPeriodicClosing(client, baseParams({ periodEnd: "2026-01-15" }))).rejects.toThrow(
      "period_end_not_after_previous",
    );
  });

  it("demands a count line for every item with a layer, naming the missing item", async () => {
    const { client } = scriptedClient(
      respondWith({
        costing: { method: "fifo", system: "periodic", lockedAt: null },
        purchases: [
          { inventory_item_id: "item-a", quantity: "1", extended_cost: "100", purchase_date: "2026-01-10", received_at: null },
          { inventory_item_id: "item-b", quantity: "1", extended_cost: "100", purchase_date: "2026-01-11", received_at: null },
        ],
      }),
    );
    await expect(createPeriodicClosing(client, baseParams())).rejects.toThrow("count_line_missing: item-b");
  });
});

describe("listPeriodicClosings", () => {
  it("maps rows to camelCase, newest period first, with the default limit", async () => {
    const { client, calls } = scriptedClient((sql) =>
      sql.includes("FROM periodic_closings")
        ? [
            {
              id: "c-2",
              period_end: "2026-02-28",
              method: "fifo",
              beginning_value_rial: "400",
              purchases_value_rial: "900",
              ending_value_rial: "750",
              cogs_value_rial: "550",
              note: null,
              created_at: "2026-02-28 10:00:00",
            },
          ]
        : undefined,
    );

    const rows = await listPeriodicClosings(client, "loc-1");
    expect(rows).toEqual([
      {
        id: "c-2",
        periodEnd: "2026-02-28",
        method: "fifo",
        beginningValueRial: "400",
        purchasesValueRial: "900",
        endingValueRial: "750",
        cogsValueRial: "550",
        note: null,
        createdAt: "2026-02-28 10:00:00",
      },
    ]);
    expect(calls[0].params).toEqual(["loc-1", 50]);
  });
});
