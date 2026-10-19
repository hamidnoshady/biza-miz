/**
 * Issue #915 — food-service supplier returns resolve their lot from the
 * line's OWN receipt cost allocation, never "the first lot of the same
 * purchase + item".
 *
 * The load-bearing claims: a purchase with two lines of the SAME item at
 * different prices creates one lot per line (purchase_receipt_cost_allocations
 * maps purchase_item → lot exactly); returning a line against the OTHER
 * line's lot is refused (`supplier_return_lot_mismatch`) instead of silently
 * valuing the return at the wrong line's cost; returning a line against its
 * own lot relieves exactly that lot at its own price; and receipts predating
 * the allocations table (no allocation rows for the line) keep the legacy
 * purchase+item association, so history stays returnable.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { applyPurchaseReceiptCosting } from "../src/lib/purchase-receipt-costing";
import { createSupplierReturn } from "../src/lib/supplier-return-service";
import { positiveQuantityText, quantityText, rialText } from "../src/lib/inventory-exact";

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
  businessId: string;
  locationId: string;
  ownerId: string;
  itemId: string;
}

/** One FIFO business/location/item with the accounts these paths post to. */
async function seed(client: Client): Promise<Fixture> {
  const { rows } = await client.query<{ business_id: string; location_id: string; owner_id: string; item_id: string }>(
    `WITH business AS (
       INSERT INTO businesses(name) VALUES('Lot Provenance Test') RETURNING id
     ), location AS (
       INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
     ), owner_user AS (
       INSERT INTO users(business_id,role,full_name,password_hash)
       SELECT business_id,'owner','Owner','hash' FROM location RETURNING id
     ), costing AS (
       INSERT INTO settings(business_id,key,value)
       SELECT business_id,'inventory.costing','{"method":"fifo"}'::jsonb FROM location
     ), accounts_created AS (
       INSERT INTO accounts(business_id,code,name,type)
       SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
         ('1100','Cash','asset'),('1120','Bank','asset'),('1210','Supplier Receivable','asset'),
         ('1300','Inventory','asset'),('2100','AP','liability')
       ) a(code,name,type)
     ), item AS (
       INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
       SELECT id,'Coffee beans','unit',0,0 FROM location RETURNING id
     )
     SELECT location.business_id, location.id location_id, owner_user.id owner_id, item.id item_id
       FROM location, owner_user, item`,
  );
  return {
    businessId: rows[0].business_id,
    locationId: rows[0].location_id,
    ownerId: rows[0].owner_id,
    itemId: rows[0].item_id,
  };
}

/**
 * One received purchase with two lines of the SAME item at different unit
 * prices, costed through the real v2 receipt path (which writes the per-line
 * allocations and lots).
 */
async function receiveTwoLinePurchase(client: Client, f: Fixture) {
  const { rows: purchase } = await client.query<{ id: string }>(
    `INSERT INTO purchases(location_id,status,total,received_at) VALUES($1,'received',1500,now()) RETURNING id`,
    [f.locationId],
  );
  const { rows: lines } = await client.query<{ id: string }>(
    `INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
     VALUES ($1,$2,5,100,500),($1,$2,5,200,1000) RETURNING id`,
    [purchase[0].id, f.itemId],
  );
  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,costing_version,posting_status)
     VALUES($1,$2,'purchase_receipt','purchase',$3,2,'posted') RETURNING id`,
    [f.businessId, f.locationId, purchase[0].id],
  );
  await applyPurchaseReceiptCosting(client as never, {
    businessId: f.businessId,
    locationId: f.locationId,
    purchaseId: purchase[0].id,
    inventoryEventId: events[0].id,
    createdBy: f.ownerId,
    items: [
      {
        purchaseItemId: lines[0].id,
        inventoryItemId: f.itemId,
        quantity: positiveQuantityText("5"),
        extendedCost: rialText("500"),
      },
      {
        purchaseItemId: lines[1].id,
        inventoryItemId: f.itemId,
        quantity: positiveQuantityText("5"),
        extendedCost: rialText("1000"),
      },
    ],
  });
  return { purchaseId: purchase[0].id, cheapLineId: lines[0].id, dearLineId: lines[1].id };
}

beforeAll(async () => {
  databaseName = `pos_lotprov_${randomUUID().replaceAll("-", "")}`;
  const admin = await connect(urlFor("postgres"));
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });
}, 120_000);

afterAll(async () => {
  const admin = await connect(urlFor("postgres"));
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("supplier-return lot provenance (issue #915)", () => {
  it("maps each line to its own lot, refuses the other line's lot, and values each return at its own price", async () => {
    const client = await connect();
    const f = await seed(client);
    const { purchaseId, cheapLineId, dearLineId } = await receiveTwoLinePurchase(client, f);

    // The receipt wrote one lot per line, each at the line's own price.
    const { rows: allocations } = await client.query<{ purchase_item_id: string; inventory_lot_id: string; unit_cost: string }>(
      `SELECT a.purchase_item_id, a.inventory_lot_id, l.unit_cost::text
         FROM purchase_receipt_cost_allocations a JOIN inventory_lots l ON l.id = a.inventory_lot_id
        WHERE a.allocation_kind = 'positive_stock' ORDER BY l.unit_cost`,
    );
    expect(allocations).toHaveLength(2);
    const cheapLot = allocations.find((a) => a.purchase_item_id === cheapLineId)!;
    const dearLot = allocations.find((a) => a.purchase_item_id === dearLineId)!;
    expect(Number(cheapLot.unit_cost)).toBe(100);
    expect(Number(dearLot.unit_cost)).toBe(200);
    expect(cheapLot.inventory_lot_id).not.toBe(dearLot.inventory_lot_id);

    // The detail route's per-line resolution (the UI's returnable lot): the
    // allocation row, never "first lot of the purchase+item".
    const { rows: resolved } = await client.query<{ id: string; inventory_lot_id: string }>(
      `SELECT pi.id,
              (SELECT a.inventory_lot_id FROM purchase_receipt_cost_allocations a
                 JOIN inventory_lots il ON il.id = a.inventory_lot_id
                WHERE a.purchase_item_id = pi.id AND a.allocation_kind = 'positive_stock'
                  AND il.remaining_qty > 0
                ORDER BY a.sequence LIMIT 1) AS inventory_lot_id
         FROM purchase_items pi WHERE pi.purchase_id = $1`,
      [purchaseId],
    );
    expect(resolved.find((r) => r.id === cheapLineId)?.inventory_lot_id).toBe(cheapLot.inventory_lot_id);
    expect(resolved.find((r) => r.id === dearLineId)?.inventory_lot_id).toBe(dearLot.inventory_lot_id);

    // Returning the dear line against the cheap line's lot is a mismatch —
    // before #915 this passed the purchase+item join and valued the return
    // off the wrong lot.
    await client.query("BEGIN");
    await expect(
      createSupplierReturn(client as never, {
        businessId: f.businessId,
        locationId: f.locationId,
        purchaseId,
        settlementMethod: "accounts_payable",
        reason: "wrong lot",
        idempotencyKey: "lot-mismatch",
        createdBy: f.ownerId,
        lines: [{ purchaseItemId: dearLineId, inventoryLotId: cheapLot.inventory_lot_id, quantity: quantityText("2") }],
      }),
    ).rejects.toThrow("supplier_return_lot_mismatch");
    await client.query("ROLLBACK");

    // Returning each line against its own lot values it at its own price.
    await client.query("BEGIN");
    const dearReturn = await createSupplierReturn(client as never, {
      businessId: f.businessId,
      locationId: f.locationId,
      purchaseId,
      settlementMethod: "accounts_payable",
      reason: "damaged",
      idempotencyKey: "dear-return",
      createdBy: f.ownerId,
      lines: [{ purchaseItemId: dearLineId, inventoryLotId: dearLot.inventory_lot_id, quantity: quantityText("2") }],
    });
    await client.query("COMMIT");
    expect(dearReturn.value).toBe("400"); // 2 × 200, never 2 × 100

    const { rows: dearLotAfter } = await client.query<{ remaining_qty: string; remaining_value_rial: string }>(
      `SELECT remaining_qty::text, remaining_value_rial::text FROM inventory_lots WHERE id = $1`,
      [dearLot.inventory_lot_id],
    );
    expect(Number(dearLotAfter[0].remaining_qty)).toBe(3);
    expect(dearLotAfter[0].remaining_value_rial).toBe("600");

    await client.end();
  });

  it("keeps legacy receipts (no allocation rows) returnable through the purchase+item association", async () => {
    const client = await connect();
    const f = await seed(client);

    // A pre-allocations receipt: purchase, line and lot written directly,
    // with no purchase_receipt_cost_allocations rows — exactly what the
    // operational-accounting fixtures model.
    const { rows: purchase } = await client.query<{ id: string }>(
      `INSERT INTO purchases(location_id,status,total,received_at) VALUES($1,'received',300,now()) RETURNING id`,
      [f.locationId],
    );
    const { rows: line } = await client.query<{ id: string }>(
      `INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
       VALUES($1,$2,3,100,300) RETURNING id`,
      [purchase[0].id, f.itemId],
    );
    const { rows: events } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,costing_version,posting_status)
       VALUES($1,$2,'purchase_receipt','purchase',$3,2,'posted') RETURNING id`,
      [f.businessId, f.locationId, purchase[0].id],
    );
    await client.query(
      `INSERT INTO stock_movements(location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,inventory_event_id)
       VALUES($1,$2,'purchase',3,100,300,'purchase',$3,$4)`,
      [f.locationId, f.itemId, purchase[0].id, events[0].id],
    );
    const { rows: lot } = await client.query<{ id: string }>(
      `INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id,
         original_quantity,original_value_rial,remaining_value_rial)
       VALUES($1,$2,3,100,'purchase',$3,$4,3,300,300) RETURNING id`,
      [f.locationId, f.itemId, purchase[0].id, events[0].id],
    );

    await client.query("BEGIN");
    const result = await createSupplierReturn(client as never, {
      businessId: f.businessId,
      locationId: f.locationId,
      purchaseId: purchase[0].id,
      settlementMethod: "accounts_payable",
      reason: "legacy return",
      idempotencyKey: "legacy-return",
      createdBy: f.ownerId,
      lines: [{ purchaseItemId: line[0].id, inventoryLotId: lot[0].id, quantity: quantityText("1") }],
    });
    await client.query("COMMIT");
    expect(result.value).toBe("100");
    await client.end();
  });
});
