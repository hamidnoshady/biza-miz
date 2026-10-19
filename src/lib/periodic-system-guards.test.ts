/**
 * سیستم ادواری — the perpetual-only guards. A periodic business keeps no
 * per-movement cost, so every instrument that writes priced stock movements
 * must refuse with `periodic_system_unsupported` before touching stock —
 * and the one deliberate exception, the customer return, must post the
 * refund while skipping the restock entirely.
 *
 * Each service runs against a scripted PoolClient that answers only the
 * queries leading up to the guard, so a guard that moved *after* a write
 * (or disappeared) fails here as an unexpected query, not just a missed
 * throw.
 */
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { quantityText, rialText, type QuantityText } from "./inventory-exact";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import { applyPurchaseReceiptCosting } from "./purchase-receipt-costing";
import { applyStockAdjustmentExact } from "./inventory-adjustment-exact";
import { createNrvWriteDown } from "./nrv-service";
import { createSupplierReturn } from "./supplier-return-service";
import { shipInventoryTransfer } from "./transfer-service";
import { createWarehouseDocumentInTransaction, parseWarehouseDocumentLines } from "./warehouse-document-service";
import { createCustomerReturn } from "./customer-return-service";

interface Call {
  sql: string;
  params: unknown[];
}

const PERIODIC_COSTING = { method: "weighted_average", system: "periodic", lockedAt: null };

function scriptedClient(respond: (sql: string, params: unknown[]) => Record<string, unknown>[] | undefined) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: flat, params });
      // Issue #867 — the in-transaction voucher numbering is served first so
      // the business-specific scripts stay focused on the guard under test.
      const voucher = voucherRows(flat);
      const rows = voucher !== undefined ? voucher : respond(flat, params);
      if (rows === undefined) throw new Error(`unexpected query: ${flat}`);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

/** Answers only the settings read — any other query is "unexpected", proving the guard fired first. */
function settingsOnly() {
  return scriptedClient((sql) => (sql.includes("FROM settings") ? [{ value: PERIODIC_COSTING }] : undefined));
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

describe("perpetual-only instruments refuse a periodic business", () => {
  it("consumeInventoryExact (sales/waste/production/warehouse issues) — before reading any stock", async () => {
    const { client } = settingsOnly();
    await expect(
      consumeInventoryExact(client, {
        locationId: "loc-1",
        businessId: "biz-1",
        inventoryItemId: "item-a",
        quantity: quantityText("1"),
        type: "waste",
        sourceType: "waste",
        sourceId: null,
        createdBy: "user-1",
        inventoryEventId: "event-1",
      }),
    ).rejects.toThrow("periodic_system_unsupported");
  });

  it("applyPurchaseReceiptCosting (perpetual receipt costing) — before writing any lot", async () => {
    const { client } = settingsOnly();
    await expect(
      applyPurchaseReceiptCosting(client, {
        businessId: "biz-1",
        locationId: "loc-1",
        purchaseId: "purchase-1",
        inventoryEventId: "event-1",
        items: [
          {
            purchaseItemId: "pi-1",
            inventoryItemId: "item-a",
            quantity: quantityText("1"),
            extendedCost: rialText("100"),
          },
        ],
        createdBy: "user-1",
      }),
    ).rejects.toThrow("periodic_system_unsupported");
  });

  it("applyStockAdjustmentExact (انبارگردانی) — the count lives in the period close instead", async () => {
    const { client } = settingsOnly();
    await expect(
      applyStockAdjustmentExact(client, {
        locationId: "loc-1",
        businessId: "biz-1",
        inventoryItemId: "item-a",
        delta: "-1",
        stockCountId: "count-1",
        sourceType: "stock_count",
        sourceId: "count-1",
        createdBy: "user-1",
        inventoryEventId: "event-1",
      }),
    ).rejects.toThrow("periodic_system_unsupported");
  });

  it("createNrvWriteDown — NRV needs a per-item carrying value, which ادواری does not keep", async () => {
    const { client } = settingsOnly();
    await expect(
      createNrvWriteDown(client, {
        businessId: "biz-1",
        locationId: "loc-1",
        valuationDate: "2026-01-31",
        reason: "NRV",
        idempotencyKey: "nrv-1",
        createdBy: "user-1",
        lines: [{ inventoryItemId: "item-a", nrvValueRial: rialText("100") }],
      }),
    ).rejects.toThrow("periodic_system_unsupported");
  });

  it("createSupplierReturn — ادواری posts a credit note (Debit settlement / Credit 5105) with no stock effect", async () => {
    // Issue #915 — the periodic return is no longer refused: a journal-only
    // purchase is reversed by a credit note. The scripted client still traps
    // any unexpected query, so a lot read or stock-movement write — the
    // perpetual machinery this path must never touch — fails the test.
    const { client, calls } = scriptedClient((sql, params) => {
      if (sql.includes("SELECT id,total_value_rial")) return []; // no duplicate
      if (sql.includes("FROM purchases WHERE id=$1")) return [{ id: "purchase-1", total: "1000", vat_amount: "0" }];
      if (sql.includes("INSERT INTO supplier_returns")) return [{ id: "sr-1" }];
      if (sql.includes("INSERT INTO inventory_events")) return [{ id: "event-1" }];
      if (sql.includes("FROM settings")) return [{ value: PERIODIC_COSTING }];
      if (sql.includes("FROM purchase_items pi JOIN purchases p")) return [{ quantity: "4", extended_cost: "1000" }];
      if (sql.includes("FROM supplier_return_lines l JOIN supplier_returns r")) return [{ quantity: "0", value: "0" }];
      if (sql.includes("INSERT INTO supplier_return_lines")) return [];
      if (sql.includes("UPDATE supplier_returns SET total_value_rial")) return [];
      // No posted attribution on the original — the mirror probe answers
      // "an entry exists, unattributed", so the credit note stays plain.
      if (sql.includes("SELECT jl.cost_center_id")) return [];
      if (sql.includes("SELECT 1 AS one FROM journal_entries")) return [{ one: 1 }];
      if (sql.includes("SELECT code, id FROM accounts"))
        return (params[1] as string[]).map((code) => ({ code, id: `acct-${code}` }));
      if (sql.includes("INSERT INTO journal_entries")) return [{ id: "je-1", entry_date: "2026-01-01" }];
      if (sql.includes("INSERT INTO journal_lines")) return [];
      if (sql.includes("set_config")) return [];
      if (sql.includes("UPDATE inventory_events SET posting_status")) return [];
      return undefined; // an inventory_lots / stock_movements query fails here
    });
    const result = await createSupplierReturn(client, {
      businessId: "biz-1",
      locationId: "loc-1",
      purchaseId: "purchase-1",
      settlementMethod: "accounts_payable",
      reason: "return",
      idempotencyKey: "sr-1",
      createdBy: "user-1",
      lines: [{ purchaseItemId: "pi-1", quantity: quantityText("1") }],
    });
    // 1 of 4 units off a 1,000-Rial receipt line → 250, proportionally.
    expect(result).toEqual({ id: "sr-1", value: "250", duplicate: false });
    // No stock effect of any kind — ادواری keeps no lots or priced movements.
    expect(calls.some((c) => c.sql.includes("inventory_lots") || c.sql.includes("stock_movements"))).toBe(false);
    // The credit-note line records provenance with NULL lot and NULL movement.
    const lineInsert = calls.find((c) => c.sql.includes("INSERT INTO supplier_return_lines"))!;
    expect(lineInsert.sql).toContain("NULL");
    expect(lineInsert.params).toEqual(["sr-1", "pi-1", "1", "250"]);
    // Debit the settlement (AP), credit «خرید طی دوره» 5105 — never 1300.
    const journalLines = calls.filter((c) => c.sql.includes("INSERT INTO journal_lines"));
    expect(journalLines.map((c) => [c.params[1], c.params[2], c.params[3]])).toEqual([
      ["acct-2100", "250", "0"],
      ["acct-5105", "0", "250"],
    ]);
  });

  it("shipInventoryTransfer — transfers move priced stock between branches", async () => {
    const { client } = scriptedClient((sql) => {
      if (sql.includes("FROM inventory_transfers")) return [{ source_location_id: "loc-1", status: "draft" }];
      if (sql.includes("FROM settings")) return [{ value: PERIODIC_COSTING }];
      return undefined;
    });
    await expect(
      shipInventoryTransfer(client, { businessId: "biz-1", transferId: "transfer-1", actorId: "user-1" }),
    ).rejects.toThrow("periodic_system_unsupported");
  });

  it("createWarehouseDocumentInTransaction — رسید/حواله write priced stock movements", async () => {
    // Real uuids here, unlike the scripted ids the other cases use: this
    // service screens every id with `isUuid` before it queries (a non-uuid
    // against a uuid column raises a syntax error, i.e. a 500 instead of a
    // 404), so a "loc-1" would be refused by that guard and never reach the
    // periodic one this test is about.
    const locationId = "11111111-1111-4111-8111-111111111111";
    const itemId = "22222222-2222-4222-8222-222222222222";
    const { client } = scriptedClient((sql) => {
      if (sql.includes("FROM locations")) return [{ id: locationId, is_active: true }];
      if (sql.includes("FROM settings")) return [{ value: PERIODIC_COSTING }];
      return undefined;
    });
    const parsed = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: itemId, quantity: "1", unitCost: "100" },
    ]);
    await expect(
      createWarehouseDocumentInTransaction(client, {
        businessId: "biz-1",
        locationId,
        kind: parsed.kind,
        supplierId: null,
        recipient: null,
        documentNumber: null,
        note: null,
        createdBy: "user-1",
        lines: parsed.lines,
      }),
    ).rejects.toThrow("periodic_system_unsupported");
  });
});

describe("customer return under سیستم ادواری", () => {
  it("posts the refund but restocks nothing — no stock movement, no lot, zero recovered value", async () => {
    const journalLineInserts: Call[] = [];
    const { client, calls } = scriptedClient((sql, params) => {
      if (sql.includes("SELECT id,refund_amount_rial::text FROM customer_returns")) return []; // no duplicate
      // Issue #868 — the refund mirrors the sale's attribution: amendment
      // chain, then the original entry's own dimensions (none here), then the
      // order's mapping refs (none) — so the refund posts unattributed.
      if (sql.includes("SELECT id FROM order_amendments WHERE order_id")) return [];
      if (sql.includes("SELECT jl.cost_center_id")) return [];
      if (sql.includes("SELECT 1 AS one FROM journal_entries")) return [];
      if (sql.includes("FROM order_items oi")) return [];
      if (sql.includes("FROM orders WHERE")) return [{ tax: "0", total: "10000" }];
      if (sql.includes("FROM payments WHERE order_id")) return [{ paid: "10000" }];
      if (sql.includes("INSERT INTO customer_returns")) return [{ id: "return-1" }];
      if (sql.includes("INSERT INTO inventory_events")) return [{ id: "event-1" }];
      if (sql.includes("FROM settings")) return [{ value: PERIODIC_COSTING }];
      if (sql.includes("FROM order_items WHERE id=")) return [{ quantity: "1" }];
      if (sql.includes("INSERT INTO customer_return_lines")) return [{ id: "line-1" }];
      if (sql.includes("INSERT INTO payments")) return [];
      if (sql.includes("SELECT code, id FROM accounts")) {
        const codes = params[1] as string[];
        return codes.map((code) => ({ code, id: `acc-${code}` }));
      }
      // The entry's own date is what its voucher number is derived from, so
      // the RETURNING carries it the way the real column does.
      if (sql.includes("INSERT INTO journal_entries")) return [{ id: "entry-1", entry_date: "2026-01-31" }];
      if (sql.includes("INSERT INTO journal_lines")) {
        journalLineInserts.push({ sql, params });
        return [];
      }
      if (sql.includes("SELECT set_config('app.fiscal_constructing_entry_id'")) return [];
      if (sql.includes("UPDATE customer_returns SET inventory_event_id")) return [];
      if (sql.includes("UPDATE inventory_events SET posting_status")) return [];
      return undefined; // a restock query (snapshots/stock_movements/lots) fails the test here
    });

    const result = await createCustomerReturn(client, {
      businessId: "biz-1",
      locationId: "loc-1",
      orderId: "order-1",
      refundMethod: "cash",
      refundAmount: rialText("10000"),
      reason: "returned",
      idempotencyKey: "cr-1",
      createdBy: "user-1",
      lines: [{ orderItemId: "oi-1", quantity: "1" as QuantityText, disposition: "restockable" }],
    });

    // The sale consumed nothing, so the return recovers nothing.
    expect(result.recoveredValue).toBe("0");
    expect(result.refundAmount).toBe("10000");
    expect(result.duplicate).toBe(false);

    // No restock artifacts of any kind.
    const sqls = calls.map((call) => call.sql).join("\n");
    expect(sqls).not.toContain("INSERT INTO stock_movements");
    expect(sqls).not.toContain("INSERT INTO inventory_lots");
    expect(sqls).not.toContain("order_item_inventory_snapshots");

    // The refund money entry still posts: Dr sales returns (4400), Cr cash.
    const refundLines = journalLineInserts.map((call) => ({
      accountId: call.params[1],
      debit: call.params[2],
      credit: call.params[3],
    }));
    expect(refundLines).toEqual([
      { accountId: "acc-4400", debit: "10000", credit: "0" },
      { accountId: "acc-1100", debit: "0", credit: "10000" },
    ]);

    // The refund payment row is written (negative amount against the order).
    expect(sqls).toContain("INSERT INTO payments");
  });
});
