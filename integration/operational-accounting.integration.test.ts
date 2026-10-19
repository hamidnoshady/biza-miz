import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createCustomerReturn } from "../src/lib/customer-return-service";
import { createSupplierReturn } from "../src/lib/supplier-return-service";
import {
  cancelInventoryTransfer, createInventoryTransfer, receiveInventoryTransfer, shipInventoryTransfer,
} from "../src/lib/transfer-service";
import { createNrvWriteDown, reverseNrvWriteDown } from "../src/lib/nrv-service";
import { quantityText, rialText } from "../src/lib/inventory-exact";

const configuredUrl=process.env.DATABASE_URL;
if(!configuredUrl)throw new Error("DATABASE_URL is required for database integration tests");
let databaseName="";let databaseUrl="";
function urlFor(database:string){const url=new URL(configuredUrl!);url.pathname=`/${database}`;return url.toString();}
async function connect(url=databaseUrl){const client=new Client({connectionString:url});await client.connect();return client;}
let fixture:{
 businessId:string;sourceLocationId:string;destinationLocationId:string;ownerId:string;
 saleOrderId:string;saleOrderItemId:string;saleInventoryItemId:string;
 purchaseId:string;purchaseItemId:string;purchaseLotId:string;
 transferSourceItemId:string;transferDestinationItemId:string;
};

beforeAll(async()=>{
 databaseName=`pos_ops_${crypto.randomUUID().replaceAll("-","")}`;
 const admin=await connect(urlFor("postgres"));await admin.query(`CREATE DATABASE "${databaseName}"`);await admin.end();
 databaseUrl=urlFor(databaseName);await runMigrations({databaseUrl,quiet:true});
 const client=await connect();
 const {rows}=await client.query<{
  business_id:string;source_location_id:string;destination_location_id:string;owner_id:string;
  sale_order_id:string;sale_order_item_id:string;sale_inventory_item_id:string;
  purchase_id:string;purchase_item_id:string;purchase_lot_id:string;
  transfer_source_item_id:string;transfer_destination_item_id:string;
 }>(`
 WITH business AS (INSERT INTO businesses(name) VALUES('Operational Test') RETURNING id),
 source_location AS (
  INSERT INTO locations(business_id,name) SELECT id,'Source' FROM business RETURNING id,business_id
 ), destination_location AS (
  INSERT INTO locations(business_id,name) SELECT id,'Destination' FROM business RETURNING id,business_id
 ), owner_user AS (
  INSERT INTO users(business_id,role,full_name,password_hash)
  SELECT business_id,'owner','Owner','hash' FROM source_location RETURNING id
 ), costing AS (
  INSERT INTO settings(business_id,key,value)
  SELECT business_id,'inventory.costing','{"method":"fifo"}'::jsonb FROM source_location
 ), accounts_created AS (
  INSERT INTO accounts(business_id,code,name,type)
  SELECT business_id,code,name,type::account_type FROM source_location CROSS JOIN (VALUES
   ('1100','Cash','asset'),('1120','Bank','asset'),('1200','AR','asset'),
   ('1210','Supplier Receivable','asset'),('1300','Inventory','asset'),
   ('1350','Transit','asset'),('1390','NRV Allowance','asset'),('2100','AP','liability'),
   ('2200','VAT','liability'),('4400','Sales Returns','revenue'),('5100','COGS','expense'),
   ('5170','Write-down','expense')
  ) a(code,name,type)
 ), sale_item AS (
  INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
  SELECT id,'Sale item','unit',100,0 FROM source_location RETURNING id,location_id
 ), sale_order AS (
  INSERT INTO orders(location_id,order_number,status,subtotal,tax,total,closed_at)
  SELECT location_id,1,'open',200,20,220,NULL FROM sale_item RETURNING id,location_id
 ), order_line AS (
  INSERT INTO order_items(location_id,order_id,name_snapshot,unit_price,quantity,status)
  SELECT location_id,id,'Sold item',100,2,'served' FROM sale_order RETURNING id,order_id
 ), snapshot AS (
  INSERT INTO order_item_inventory_snapshots(order_item_id,inventory_item_id,required_quantity)
  SELECT order_line.id,sale_item.id,1 FROM order_line,sale_item
 ), sale_event AS (
  INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,costing_version,posting_status)
  SELECT source_location.business_id,source_location.id,'sale_consumption','order',sale_order.id,2,'posted'
  FROM source_location,sale_order RETURNING id
 ), sale_movement AS (
  INSERT INTO stock_movements(location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,inventory_event_id)
  SELECT source_location.id,sale_item.id,'sale',-2,100,200,'order',sale_order.id,sale_event.id
  FROM source_location,sale_item,sale_order,sale_event
 ), payment AS (
  INSERT INTO payments(location_id,order_id,method,amount)
  SELECT location_id,id,'cash',220 FROM sale_order
 ), purchase_item_inventory AS (
  INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
  SELECT id,'Purchased item','unit',100,300 FROM source_location RETURNING id,location_id
 ), purchase AS (
  INSERT INTO purchases(location_id,status,total,received_at)
  SELECT location_id,'received',300,now() FROM purchase_item_inventory RETURNING id,location_id
 ), purchase_line AS (
  INSERT INTO purchase_items(purchase_id,inventory_item_id,quantity,unit_cost,extended_cost)
  SELECT purchase.id,purchase_item_inventory.id,3,100,300 FROM purchase,purchase_item_inventory RETURNING id,purchase_id,inventory_item_id
 ), purchase_event AS (
  INSERT INTO inventory_events(business_id,location_id,event_type,source_type,source_id,costing_version,posting_status)
  SELECT source_location.business_id,source_location.id,'purchase_receipt','purchase',purchase.id,2,'posted'
  FROM source_location,purchase RETURNING id
 ), purchase_movement AS (
  INSERT INTO stock_movements(location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,inventory_event_id)
  SELECT source_location.id,purchase_line.inventory_item_id,'purchase',3,100,300,'purchase',purchase.id,purchase_event.id
  FROM source_location,purchase_line,purchase,purchase_event
 ), purchase_lot AS (
  INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,inventory_event_id,
    original_quantity,original_value_rial,remaining_value_rial)
  SELECT source_location.id,purchase_line.inventory_item_id,3,100,'purchase',purchase.id,purchase_event.id,3,300,300
  FROM source_location,purchase_line,purchase,purchase_event RETURNING id
 ), transfer_source AS (
  INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
  SELECT id,'Transfer source','unit',50,200 FROM source_location RETURNING id,location_id
 ), transfer_destination AS (
  INSERT INTO inventory_items(location_id,name,unit,avg_cost,carrying_value_rial)
  SELECT id,'Transfer destination','unit',0,0 FROM destination_location RETURNING id
 ), transfer_event AS (
  INSERT INTO inventory_events(business_id,location_id,event_type,source_type,costing_version,posting_status)
  SELECT source_location.business_id,source_location.id,'opening','fixture',2,'posted'
  FROM source_location RETURNING id
 ), transfer_movement AS (
  INSERT INTO stock_movements(location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,inventory_event_id)
  SELECT source_location.id,transfer_source.id,'adjustment',4,50,200,'fixture',transfer_event.id
  FROM source_location,transfer_source,transfer_event
 ), transfer_lot AS (
  INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,inventory_event_id,
    original_quantity,original_value_rial,remaining_value_rial)
  SELECT source_location.id,transfer_source.id,4,50,'fixture',transfer_event.id,4,200,200
  FROM source_location,transfer_source,transfer_event
 )
 SELECT source_location.business_id,source_location.id source_location_id,
 destination_location.id destination_location_id,owner_user.id owner_id,
 sale_order.id sale_order_id,order_line.id sale_order_item_id,sale_item.id sale_inventory_item_id,
 purchase.id purchase_id,purchase_line.id purchase_item_id,purchase_lot.id purchase_lot_id,
 transfer_source.id transfer_source_item_id,transfer_destination.id transfer_destination_item_id
 FROM source_location,destination_location,owner_user,sale_order,order_line,sale_item,purchase,purchase_line,purchase_lot,
 transfer_source,transfer_destination`);
 const row=rows[0];
 await client.query("UPDATE orders SET status='completed',closed_at=now() WHERE id=$1",[row.sale_order_id]);
 fixture={
  businessId:row.business_id,sourceLocationId:row.source_location_id,destinationLocationId:row.destination_location_id,
  ownerId:row.owner_id,saleOrderId:row.sale_order_id,saleOrderItemId:row.sale_order_item_id,
  saleInventoryItemId:row.sale_inventory_item_id,purchaseId:row.purchase_id,purchaseItemId:row.purchase_item_id,
  purchaseLotId:row.purchase_lot_id,transferSourceItemId:row.transfer_source_item_id,
  transferDestinationItemId:row.transfer_destination_item_id,
 };await client.end();
});
afterAll(async()=>{const admin=await connect(urlFor("postgres"));await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);await admin.end();});

async function createCompletedSale(input: {
  totalRial: string;
  tipRial?: string;
  quantity?: string;
  tenders: { method: "cash" | "card" | "credit"; amountRial: string }[];
}): Promise<{ orderId: string; orderItemId: string }> {
  const client = await connect();
  try {
    const { rows: counters } = await client.query<{ next_order_number: string }>(
      "SELECT (COALESCE(MAX(order_number), 0) + 1)::text AS next_order_number FROM orders WHERE location_id=$1",
      [fixture.sourceLocationId],
    );
    const { rows: orders } = await client.query<{ id: string }>(
      `INSERT INTO orders (location_id,order_number,type,status,subtotal,tax,total,opened_at,closed_at,tip_amount)
       VALUES ($1,$2,'takeaway','completed',$3,0,$3,now()-interval '1 hour',now(),$4)
       RETURNING id`,
      [fixture.sourceLocationId, counters[0].next_order_number, input.totalRial, input.tipRial ?? "0"],
    );
    const orderId = orders[0].id;
    const { rows: items } = await client.query<{ id: string }>(
      `INSERT INTO order_items (location_id,order_id,name_snapshot,unit_price,quantity,status)
       VALUES ($1,$2,'Return-test item',$3,$4,'served') RETURNING id`,
      [fixture.sourceLocationId, orderId, input.totalRial, input.quantity ?? "2"],
    );
    for (const tender of input.tenders) {
      await client.query(
        "INSERT INTO payments (location_id,order_id,method,amount,received_by) VALUES ($1,$2,$3,$4,$5)",
        [fixture.sourceLocationId, orderId, tender.method, tender.amountRial, fixture.ownerId],
      );
    }
    return { orderId, orderItemId: items[0].id };
  } finally {
    await client.end();
  }
}

async function createReturnAndCommit(input: {
  orderId: string;
  orderItemId: string;
  refundAmountRial: string;
  quantity: string;
  idempotencyKey: string;
}) {
  const client = await connect();
  try {
    await client.query("BEGIN");
    const result = await createCustomerReturn(client as never, {
      businessId: fixture.businessId,
      locationId: fixture.sourceLocationId,
      orderId: input.orderId,
      refundMethod: "cash",
      refundAmount: rialText(input.refundAmountRial),
      reason: "integration test",
      idempotencyKey: input.idempotencyKey,
      createdBy: fixture.ownerId,
      lines: [{
        orderItemId: input.orderItemId,
        quantity: quantityText(input.quantity),
        disposition: "discarded",
      }],
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

describe("operational inventory accounting",()=>{
 it("supports discarded and restockable partial returns and enforces the cumulative cap",async()=>{
  const client=await connect();
  await client.query("BEGIN");
  const discarded=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("55"),reason:"discarded",idempotencyKey:"return-discarded",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("0.5"),disposition:"discarded"}]});
  await client.query("COMMIT");expect(discarded.recoveredValue).toBe("0");
  await client.query("BEGIN");
  const duplicateDiscarded=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("55"),reason:"discarded",idempotencyKey:"return-discarded",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("0.5"),disposition:"discarded"}]});
  await client.query("COMMIT");expect(duplicateDiscarded.duplicate).toBe(true);
  await client.query("BEGIN");
  const restocked=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("110"),reason:"restocked",idempotencyKey:"return-restocked",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("1"),disposition:"restockable"}]});
  await client.query("COMMIT");expect(restocked.recoveredValue).toBe("100");
  await client.query("BEGIN");
  await expect(createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("1"),reason:"too much",idempotencyKey:"return-over-cap",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("1"),disposition:"restockable"}],
  })).rejects.toThrow(/return_quantity_exceeds_sold/);await client.query("ROLLBACK");
  await client.query("BEGIN");
  const final=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("55"),reason:"final",idempotencyKey:"return-final",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("0.5"),disposition:"restockable"}]});
  await client.query("COMMIT");expect(final.recoveredValue).toBe("50");
  await client.query("BEGIN");
  const repeatedFinal=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("55"),reason:"final",idempotencyKey:"return-final",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("0.5"),disposition:"restockable"}]});
  await client.query("COMMIT");expect(repeatedFinal.duplicate).toBe(true);
  await client.query("BEGIN");
  await expect(createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:fixture.saleOrderId,
   refundMethod:"cash",refundAmount:rialText("1"),reason:"past full refund",idempotencyKey:"return-after-full",
   createdBy:fixture.ownerId,lines:[{orderItemId:fixture.saleOrderItemId,quantity:quantityText("0.1"),disposition:"discarded"}],
  })).rejects.toThrow(/refund_exceeds_remaining_refundable_amount/);
  await client.query("ROLLBACK");await client.end();
 });

 it("caps exact refunds by non-credit mixed tenders, sale value, and excludes tips",async()=>{
  const mixed=await createCompletedSale({totalRial:"1000",tipRial:"250",quantity:"2",tenders:[
   {method:"cash",amountRial:"200"},{method:"card",amountRial:"300"},{method:"credit",amountRial:"500"},
  ]});
  await expect(createReturnAndCommit({orderId:mixed.orderId,orderItemId:mixed.orderItemId,
   refundAmountRial:"501",quantity:"1",idempotencyKey:"mixed-over-tender"}))
   .rejects.toThrow("refund_exceeds_remaining_refundable_amount");
  expect((await createReturnAndCommit({orderId:mixed.orderId,orderItemId:mixed.orderItemId,
   refundAmountRial:"250",quantity:"0.5",idempotencyKey:"mixed-partial-1"})).refundAmount).toBe("250");
  expect((await createReturnAndCommit({orderId:mixed.orderId,orderItemId:mixed.orderItemId,
   refundAmountRial:"250",quantity:"0.5",idempotencyKey:"mixed-partial-2"})).refundAmount).toBe("250");
  await expect(createReturnAndCommit({orderId:mixed.orderId,orderItemId:mixed.orderItemId,
   refundAmountRial:"1",quantity:"0.1",idempotencyKey:"mixed-after-full-tender"}))
   .rejects.toThrow("refund_exceeds_remaining_refundable_amount");

  // An overpayment and a separate stored tip must not raise the refund ceiling
  // above the order's 1,000-Rial total.
  const overpaid=await createCompletedSale({totalRial:"1000",tipRial:"250",quantity:"2",
   tenders:[{method:"cash",amountRial:"1200"}]});
  const full=await createReturnAndCommit({orderId:overpaid.orderId,orderItemId:overpaid.orderItemId,
   refundAmountRial:"1000",quantity:"1",idempotencyKey:"overpaid-full-refund"});
  expect(full.refundAmount).toBe("1000");
  await expect(createReturnAndCommit({orderId:overpaid.orderId,orderItemId:overpaid.orderItemId,
   refundAmountRial:"1",quantity:"0.1",idempotencyKey:"overpaid-after-full"}))
   .rejects.toThrow("refund_exceeds_remaining_refundable_amount");
 });

 it("serializes concurrent refunds so only the remaining exact capacity can be committed",async()=>{
  const sale=await createCompletedSale({totalRial:"1000",quantity:"2",tenders:[{method:"cash",amountRial:"1000"}]});
  const results=await Promise.allSettled([
   createReturnAndCommit({orderId:sale.orderId,orderItemId:sale.orderItemId,
    refundAmountRial:"600",quantity:"1",idempotencyKey:"concurrent-return-a"}),
   createReturnAndCommit({orderId:sale.orderId,orderItemId:sale.orderItemId,
    refundAmountRial:"600",quantity:"1",idempotencyKey:"concurrent-return-b"}),
  ]);
  expect(results.filter((result)=>result.status==="fulfilled")).toHaveLength(1);
  const rejected=results.find((result)=>result.status==="rejected");
  expect(rejected?.status==="rejected" ? rejected.reason : null).toMatchObject({
   message:"refund_exceeds_remaining_refundable_amount",
  });
  const check=await connect();
  const {rows}=await check.query<{ count:string; refunded:string }>(
   `SELECT count(*)::text AS count, COALESCE(sum(refund_amount_rial),0)::text AS refunded
      FROM customer_returns WHERE order_id=$1`,[sale.orderId]);
  await check.end();
  expect(rows[0]).toEqual({count:"1",refunded:"600"});
 });

 it("rolls every return side effect back with its caller transaction",async()=>{
  const sale=await createCompletedSale({totalRial:"1000",quantity:"2",tenders:[{method:"cash",amountRial:"1000"}]});
  const client=await connect();
  await client.query("BEGIN");
  const result=await createCustomerReturn(client as never,{
   businessId:fixture.businessId,locationId:fixture.sourceLocationId,orderId:sale.orderId,
   refundMethod:"cash",refundAmount:rialText("100"),reason:"rollback",idempotencyKey:"return-rollback",
   createdBy:fixture.ownerId,lines:[{orderItemId:sale.orderItemId,quantity:quantityText("0.5"),disposition:"discarded"}],
  });
  await client.query("ROLLBACK");
  const {rows}=await client.query<{returns:string;payments:string;journals:string;events:string;audits:string}>(
   `SELECT
     (SELECT count(*)::text FROM customer_returns WHERE id=$1) returns,
     (SELECT count(*)::text FROM payments WHERE reference=$2) payments,
     (SELECT count(*)::text FROM journal_entries WHERE source_type='customer_return' AND source_id=$1) journals,
     (SELECT count(*)::text FROM inventory_events WHERE source_type='customer_return' AND source_id=$1) events,
     (SELECT count(*)::text FROM audit_log WHERE entity='customer_return' AND entity_id=$1) audits`,
   [result.id,`customer-return:${result.id}`]);
  await client.end();
  expect(rows[0]).toEqual({returns:"0",payments:"0",journals:"0",events:"0",audits:"0"});
 });

 it("limits supplier returns to the selected on-hand receipt layer",async()=>{
  const client=await connect();await client.query("BEGIN");
  const result=await createSupplierReturn(client as never,{businessId:fixture.businessId,locationId:fixture.sourceLocationId,
   purchaseId:fixture.purchaseId,settlementMethod:"accounts_payable",reason:"supplier return",
   idempotencyKey:"supplier-return-1",createdBy:fixture.ownerId,
   lines:[{purchaseItemId:fixture.purchaseItemId,inventoryLotId:fixture.purchaseLotId,quantity:quantityText("2")}]});
  await client.query("COMMIT");expect(result.value).toBe("200");
  await client.query("BEGIN");
  await expect(createSupplierReturn(client as never,{businessId:fixture.businessId,locationId:fixture.sourceLocationId,
   purchaseId:fixture.purchaseId,settlementMethod:"accounts_payable",reason:"too much",
   idempotencyKey:"supplier-return-over",createdBy:fixture.ownerId,
   lines:[{purchaseItemId:fixture.purchaseItemId,inventoryLotId:fixture.purchaseLotId,quantity:quantityText("2")}],
  })).rejects.toThrow("quantity_underflow");await client.query("ROLLBACK");await client.end();
 });

 it("ships, cancels, receives exactly once, and preserves transfer value",async()=>{
  const client=await connect();await client.query("BEGIN");
  const cancelled=await createInventoryTransfer(client as never,{businessId:fixture.businessId,
   sourceLocationId:fixture.sourceLocationId,destinationLocationId:fixture.destinationLocationId,
   idempotencyKey:"transfer-cancel",createdBy:fixture.ownerId,lines:[{sourceInventoryItemId:fixture.transferSourceItemId,
    destinationInventoryItemId:fixture.transferDestinationItemId,quantity:quantityText("1")}]});
  await shipInventoryTransfer(client as never,{businessId:fixture.businessId,transferId:cancelled.id,actorId:fixture.ownerId});
  const cancellation=await cancelInventoryTransfer(client as never,{businessId:fixture.businessId,transferId:cancelled.id,actorId:fixture.ownerId});
  await client.query("COMMIT");expect(cancellation.value).toBe("50");
  await client.query("BEGIN");
  const transfer=await createInventoryTransfer(client as never,{businessId:fixture.businessId,
   sourceLocationId:fixture.sourceLocationId,destinationLocationId:fixture.destinationLocationId,
   idempotencyKey:"transfer-receive",createdBy:fixture.ownerId,lines:[{sourceInventoryItemId:fixture.transferSourceItemId,
    destinationInventoryItemId:fixture.transferDestinationItemId,quantity:quantityText("2")}]});
  expect((await shipInventoryTransfer(client as never,{businessId:fixture.businessId,transferId:transfer.id,actorId:fixture.ownerId})).value).toBe("100");
  expect((await receiveInventoryTransfer(client as never,{businessId:fixture.businessId,transferId:transfer.id,actorId:fixture.ownerId})).value).toBe("100");
  await client.query("COMMIT");await client.query("BEGIN");
  await expect(receiveInventoryTransfer(client as never,{businessId:fixture.businessId,transferId:transfer.id,actorId:fixture.ownerId}))
   .rejects.toThrow("transfer_already_received");await client.query("ROLLBACK");await client.end();
 });

 it("caps and idempotently repeats NRV reversals, rolling back if an account is missing",async()=>{
  const client=await connect();await client.query("BEGIN");
  const writeDown=await createNrvWriteDown(client as never,{businessId:fixture.businessId,locationId:fixture.destinationLocationId,
   valuationDate:"2026-07-24",reason:"NRV",idempotencyKey:"nrv-1",createdBy:fixture.ownerId,
   lines:[{inventoryItemId:fixture.transferDestinationItemId,nrvValueRial:rialText("60")}]});
  await client.query("COMMIT");expect(writeDown.amount).toBe("40");
  await client.query("BEGIN");
  const reversal=await reverseNrvWriteDown(client as never,{businessId:fixture.businessId,locationId:fixture.destinationLocationId,
   originalId:writeDown.id,reason:"recover",idempotencyKey:"nrv-reverse-1",createdBy:fixture.ownerId,
   amounts:[{inventoryItemId:fixture.transferDestinationItemId,amountRial:rialText("20")}]});
  const duplicate=await reverseNrvWriteDown(client as never,{businessId:fixture.businessId,locationId:fixture.destinationLocationId,
   originalId:writeDown.id,reason:"recover",idempotencyKey:"nrv-reverse-1",createdBy:fixture.ownerId,
   amounts:[{inventoryItemId:fixture.transferDestinationItemId,amountRial:rialText("20")}]});
  await client.query("COMMIT");expect(duplicate).toEqual(reversal);
  await client.query("BEGIN");
  await expect(reverseNrvWriteDown(client as never,{businessId:fixture.businessId,locationId:fixture.destinationLocationId,
   originalId:writeDown.id,reason:"too much",idempotencyKey:"nrv-reverse-over",createdBy:fixture.ownerId,
   amounts:[{inventoryItemId:fixture.transferDestinationItemId,amountRial:rialText("21")}]})).rejects.toThrow("nrv_reversal_exceeds_available");
  await client.query("ROLLBACK");
  await client.query("BEGIN");await client.query("UPDATE accounts SET code='5170_missing' WHERE business_id=$1 AND code='5170'",[fixture.businessId]);
  await expect(createNrvWriteDown(client as never,{businessId:fixture.businessId,locationId:fixture.sourceLocationId,
   valuationDate:"2026-07-24",reason:"missing account",idempotencyKey:"nrv-missing",createdBy:fixture.ownerId,
   lines:[{inventoryItemId:fixture.transferSourceItemId,nrvValueRial:rialText("0")}]})).rejects.toThrow("ledger_account_missing: 5170");
  await client.query("ROLLBACK");
  expect((await client.query("SELECT count(*)::int count FROM inventory_write_downs WHERE idempotency_key='nrv-missing'")).rows[0].count).toBe(0);
  await client.end();
 });
});
