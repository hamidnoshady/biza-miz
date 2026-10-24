import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { consumeInventoryExact } from "../src/lib/inventory-consumption-exact";
import { positiveQuantityText, rialText } from "../src/lib/inventory-exact";
import { applyPurchaseReceiptCosting } from "../src/lib/purchase-receipt-costing";
import {
  postExactNegativeSettlementEntry,
  postExactOperationalInventoryEntry,
  postExactPurchaseEntry,
} from "../src/lib/ledger-service";
import {
  createStockCount,
  editStockCount,
  getStockCountDetail,
  reverseStockCount,
} from "../src/lib/stock-count-service";
import { WELL_KNOWN_CODES } from "../src/lib/coa-template";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";

function urlFor(database: string): string {
  const url = new URL(configuredUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(url = databaseUrl): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

interface Fixture {
  business_id: string;
  location_id: string;
  inventory_item_id: string;
}

async function seed(
  client: Client,
  avgCost: string,
  method: "fifo" | "weighted_average" = "fifo",
): Promise<Fixture> {
  const { rows } = await client.query<Fixture>(
    `WITH business AS (
       INSERT INTO businesses(name) VALUES('Stock Count Corrections') RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
     ), costing AS (
       INSERT INTO settings(business_id,key,value)
       SELECT business_id,'inventory.costing',$1::jsonb FROM location
     ), accounts_created AS (
       INSERT INTO accounts(business_id,code,name,type)
       SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
         ('1100','Cash','asset'),('1120','Bank','asset'),('1300','Inventory','asset'),
         ('2100','AP','liability'),('5100','COGS','expense'),
         ('5150','Waste','expense'),('5160','Count shortage','expense'),('4910','Count gain','revenue')
       ) a(code,name,type)
     ), item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'Coffee beans','unit',$2::numeric,0 FROM location RETURNING id,location_id
     )
     SELECT location.business_id, location.id location_id, item.id inventory_item_id
     FROM location,item`,
    [`{"method":"${method}"}`, avgCost],
  );
  return rows[0];
}

async function newEvent(
  client: Client,
  fixture: Fixture,
  eventType: string,
  sourceType: string,
  sourceId: string | null,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,costing_version)
     VALUES($1,$2,$3,$4,$5,2) RETURNING id`,
    [fixture.business_id, fixture.location_id, eventType, sourceType, sourceId],
  );
  return rows[0].id;
}

async function receipt(
  client: Client,
  fixture: Fixture,
  quantity: string,
  unitCost: string,
  extendedCost: string,
): Promise<void> {
  const event = await newEvent(client, fixture, "purchase_receipt", "purchase", null);
  const { rows: purchase } = await client.query<{ purchase_id: string; purchase_item_id: string }>(
    `WITH purchase AS (
       INSERT INTO purchases(location_id,status,total) VALUES($1,'draft',0) RETURNING id
     ), line AS (
       INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
       SELECT id,$2,$3::numeric,$4::numeric,$5::bigint FROM purchase RETURNING id
     )
     SELECT purchase.id purchase_id, line.id purchase_item_id FROM purchase,line`,
    [fixture.location_id, fixture.inventory_item_id, quantity, unitCost, extendedCost],
  );
  await client.query("UPDATE inventory_events SET source_id=$2 WHERE id=$1", [event, purchase[0].purchase_id]);
  const costing = await applyPurchaseReceiptCosting(client as never, {
    businessId: fixture.business_id,
    locationId: fixture.location_id,
    purchaseId: purchase[0].purchase_id,
    inventoryEventId: event,
    createdBy: null,
    items: [
      {
        purchaseItemId: purchase[0].purchase_item_id,
        inventoryItemId: fixture.inventory_item_id,
        quantity: positiveQuantityText(quantity),
        extendedCost: rialText(extendedCost),
      },
    ],
  });
  await postExactPurchaseEntry(client as never, {
    businessId: fixture.business_id,
    locationId: fixture.location_id,
    purchaseId: purchase[0].purchase_id,
    createdBy: null,
    total: costing.receiptValue,
    settlementMethod: "credit",
    inventoryEventId: event,
  });
  await postExactNegativeSettlementEntry(client as never, {
    businessId: fixture.business_id,
    locationId: fixture.location_id,
    sourceType: "purchase",
    sourceId: purchase[0].purchase_id,
    createdBy: null,
    upward: costing.upwardSettlementAdjustment,
    downward: costing.downwardSettlementAdjustment,
    inventoryEventId: event,
  });
}

async function balances(client: Client, fixture: Fixture) {
  const { rows } = await client.query(
    `SELECT
       (SELECT trim_scale(COALESCE(sum(quantity),0))::text FROM stock_movements WHERE inventory_item_id=$1) physical,
       (SELECT trim_scale(COALESCE(sum(remaining_quantity),0))::text FROM inventory_negative_layers
         WHERE inventory_item_id=$1) open_negative,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='1300') inventory_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5100') cogs_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5160') count_expense_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='4910') count_gain_gl,
       (SELECT COALESCE(sum(jl.debit-jl.credit),0)::text FROM journal_lines jl
         JOIN accounts a ON a.id=jl.account_id WHERE a.business_id=$2 AND a.code='5150') waste_gl`,
    [fixture.inventory_item_id, fixture.business_id],
  );
  return rows[0];
}

beforeAll(async () => {
  databaseName = `pos_stock_count_fix_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await connect(urlFor("postgres"));
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });
});

afterAll(async () => {
  const admin = await connect(urlFor("postgres"));
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("stock count corrections", () => {
  it("reverses a surplus count exactly, restoring stock and ledger", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "12" }],
    });
    const detail = await getStockCountDetail(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
    });
    expect(detail?.lines).toHaveLength(1);
    expect(detail?.lines[0].countedQty).toBe("12");
    expect(detail?.lines[0].variance).toBe("2");

    expect(await balances(client, fixture)).toEqual({
      physical: "12",
      open_negative: "0",
      inventory_gl: "1200",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "-200",
      waste_gl: "0",
    });

    await reverseStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
    });

    expect(await balances(client, fixture)).toEqual({
      physical: "10",
      open_negative: "0",
      inventory_gl: "1000",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "0",
    });
    const { rows: original } = await client.query<{ posting_status: string }>(
      "SELECT posting_status::text FROM inventory_events WHERE source_type='stock_count' AND source_id=$1 AND event_type='stock_count_adjustment'",
      [id],
    );
    expect(original[0].posting_status).toBe("reversed");
    await client.query("ROLLBACK");
    await client.end();
  });

  it("reverses a shortage count, putting the counted quantity back", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "5", "100", "500");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "2" }],
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "2",
      open_negative: "0",
      inventory_gl: "200",
      cogs_gl: "0",
      count_expense_gl: "300",
      count_gain_gl: "0",
      waste_gl: "0",
    });

    await reverseStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "5",
      open_negative: "0",
      inventory_gl: "500",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "0",
    });
    await client.query("ROLLBACK");
    await client.end();
  });

  it("un-settles a negative layer and reverses the COGS correction on a surplus reversal", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "80");

    // Waste 1 unit with nothing on hand opens a priced negative layer.
    const wasteEvent = await newEvent(client, fixture, "waste", "waste", null);
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [wasteEvent]);
    const waste = await consumeInventoryExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      quantity: positiveQuantityText("1"),
      type: "waste",
      sourceType: "waste",
      sourceId: wasteEvent,
      wasteReason: "spoilage",
      createdBy: null,
      inventoryEventId: wasteEvent,
    });
    await postExactOperationalInventoryEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "waste",
      sourceId: wasteEvent,
      postingKind: "waste",
      memo: "ضایعات",
      createdBy: null,
      inventoryEventId: wasteEvent,
      debitCode: WELL_KNOWN_CODES.wasteExpense,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: waste.postedCost,
    });

    // Replacement cost has moved to 100 by the time the shelf is counted.
    await client.query("UPDATE inventory_items SET avg_cost=100 WHERE id=$1", [fixture.inventory_item_id]);
    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "0" }],
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "0",
      open_negative: "0",
      inventory_gl: "0",
      cogs_gl: "20",
      count_expense_gl: "0",
      count_gain_gl: "-100",
      waste_gl: "80",
    });

    await reverseStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
    });
    // The layer is restored, its COGS correction reversed, and the count gain
    // offset; only the original waste expense remains.
    expect(await balances(client, fixture)).toEqual({
      physical: "-1",
      open_negative: "1",
      inventory_gl: "-80",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "80",
    });
    await client.query("ROLLBACK");
    await client.end();
  });

  it("edits a count by reversing the original and re-counting the corrected quantity", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "8" }],
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "8",
      open_negative: "0",
      inventory_gl: "800",
      cogs_gl: "0",
      count_expense_gl: "200",
      count_gain_gl: "0",
      waste_gl: "0",
    });

    const result = await editStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "9" }],
    });
    expect(result.id).toBeTruthy();
    expect(result.id).not.toBe(id);

    expect(await balances(client, fixture)).toEqual({
      physical: "9",
      open_negative: "0",
      inventory_gl: "900",
      cogs_gl: "0",
      count_expense_gl: "100",
      count_gain_gl: "0",
      waste_gl: "0",
    });
    await client.query("ROLLBACK");
    await client.end();
  });

  it("treats an edit with no remaining lines as a delete", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "7" }],
    });
    const result = await editStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
      lines: [],
    });
    expect(result).toEqual({ reversed: true, id: null });
    expect(await balances(client, fixture)).toEqual({
      physical: "10",
      open_negative: "0",
      inventory_gl: "1000",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "0",
    });
    await client.query("ROLLBACK");
    await client.end();
  });

  it("reverses surplus and shortage counts under weighted-average costing", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100", "weighted_average");
    await receipt(client, fixture, "10", "100", "1000");

    const surplus = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "12" }],
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "12",
      open_negative: "0",
      inventory_gl: "1200",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "-200",
      waste_gl: "0",
    });

    await reverseStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: surplus.id,
      createdBy: null,
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "10",
      open_negative: "0",
      inventory_gl: "1000",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "0",
    });

    const shortage = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "8" }],
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "8",
      open_negative: "0",
      inventory_gl: "800",
      cogs_gl: "0",
      count_expense_gl: "200",
      count_gain_gl: "0",
      waste_gl: "0",
    });

    await reverseStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: shortage.id,
      createdBy: null,
    });
    expect(await balances(client, fixture)).toEqual({
      physical: "10",
      open_negative: "0",
      inventory_gl: "1000",
      cogs_gl: "0",
      count_expense_gl: "0",
      count_gain_gl: "0",
      waste_gl: "0",
    });
    await client.query("ROLLBACK");
    await client.end();
  });
});

// ---------------------------------------------------------------------------
// Issue #921 §P1 — historical edit guard: intervening_movements
// ---------------------------------------------------------------------------

describe("F&B edit — intervening_movements guard", () => {
  it("refuses edit when stock moved after counted_at (purchase receipt intervened)", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "8" }],
    });

    // Backdate counted_at so intervening movements are strictly after it
    await client.query("UPDATE stock_counts SET counted_at = counted_at - interval '1 hour' WHERE id=$1", [id]);
    await receipt(client, fixture, "5", "100", "500");
    // Physical should now be 13 (8 after count + 5 receipt)
    const balAfterReceipt = await balances(client, fixture);
    expect(balAfterReceipt.physical).toBe("13");

    await expect(
      editStockCount(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        countId: id,
        createdBy: null,
        lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "9" }],
      }),
    ).rejects.toThrow("intervening_movements");

    // Stock unchanged by refused edit
    expect((await balances(client, fixture)).physical).toBe("13");
    await client.query("ROLLBACK");
    await client.end();
  });

  it("allows edit when no intervening movement (directly after count)", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "8" }],
    });

    // No intervening movement — edit should succeed
    const result = await editStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "9" }],
    });
    expect(result.id).not.toBe(id);
    expect((await balances(client, fixture)).physical).toBe("9");
    // correction_of linkage recorded
    const { rows } = await client.query<{ correction_of: string | null }>(
      "SELECT correction_of::text FROM stock_counts WHERE id=$1",
      [result.id],
    );
    expect(rows[0].correction_of).toBe(id);
    await client.query("ROLLBACK");
    await client.end();
  });

  it("bypasses intervening_movements check when allowInterveningMovements=true (operator confirmed fresh recount)", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "100");
    await receipt(client, fixture, "10", "100", "1000");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "8" }],
    });

    await client.query("UPDATE stock_counts SET counted_at = counted_at - interval '1 hour' WHERE id=$1", [id]);
    await receipt(client, fixture, "2", "100", "200");
    expect((await balances(client, fixture)).physical).toBe("10"); // 8 + 2

    // With bypass flag, edit proceeds despite intervening receipt
    const result = await editStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      countId: id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "9" }],
      allowInterveningMovements: true,
    });
    expect(result.id).toBeTruthy();
    // After reversal (10 → back to 10 original) + new count to 9 => 9
    expect((await balances(client, fixture)).physical).toBe("9");
    await client.query("ROLLBACK");
    await client.end();
  });

  it("refuses edit for shortage→surplus flip when intervening waste occurred", async () => {
    const client = await connect();
    await client.query("BEGIN");
    const fixture = await seed(client, "50");
    await receipt(client, fixture, "10", "50", "500");

    const { id } = await createStockCount(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      createdBy: null,
      lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "7" }],
    });
    expect((await balances(client, fixture)).physical).toBe("7");

    await client.query("UPDATE stock_counts SET counted_at = counted_at - interval '1 hour' WHERE id=$1", [id]);
    // Waste 1 unit after the count
    const wasteEvent = await newEvent(client, fixture, "waste", "waste", null);
    await client.query("UPDATE inventory_events SET source_id=id WHERE id=$1", [wasteEvent]);
    const waste = await consumeInventoryExact(client as never, {
      locationId: fixture.location_id,
      businessId: fixture.business_id,
      inventoryItemId: fixture.inventory_item_id,
      quantity: positiveQuantityText("1"),
      type: "waste",
      sourceType: "waste",
      sourceId: wasteEvent,
      wasteReason: "spoilage",
      createdBy: null,
      inventoryEventId: wasteEvent,
    });
    await postExactOperationalInventoryEntry(client as never, {
      businessId: fixture.business_id,
      locationId: fixture.location_id,
      sourceType: "waste",
      sourceId: wasteEvent,
      postingKind: "waste",
      memo: "ضایعات",
      createdBy: null,
      inventoryEventId: wasteEvent,
      debitCode: WELL_KNOWN_CODES.wasteExpense,
      creditCode: WELL_KNOWN_CODES.inventory,
      amount: waste.postedCost,
    });
    expect((await balances(client, fixture)).physical).toBe("6");

    await expect(
      editStockCount(client as never, {
        businessId: fixture.business_id,
        locationId: fixture.location_id,
        countId: id,
        createdBy: null,
        lines: [{ inventoryItemId: fixture.inventory_item_id, countedQty: "12" }],
      }),
    ).rejects.toThrow("intervening_movements");

    await client.query("ROLLBACK");
    await client.end();
  });
});
