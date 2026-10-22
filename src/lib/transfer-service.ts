import Decimal from "decimal.js";
import { query } from "./db";
import type { PoolClient } from "pg";
import {
  positiveQuantityText, proportionalDepletionValue, quantityText, rialBigInt, rialText,
  subtractQuantity, type QuantityText, type RialText,
} from "./inventory-exact";
import { isLotBased, lotConsumptionOrderClause } from "./inventory-costing";
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { unitCostFromValue } from "./inventory-reversal";
import { postExactOperationalInventoryEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { systemJournalMemo } from "./journal-memo";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";

type TransferSync = { actorRole: Role; clientEventId?: string };

/**
 * The transfer list the screen paints — moved here verbatim from the route so
 * GET and the MCP read share one definition (#883 batch L). Ordered newest
 * first, capped like the route was.
 */
export async function listInventoryTransfers(
  businessId: string,
  options: { limit?: number } = {},
): Promise<
  Array<{
    id: string;
    status: string;
    note: string | null;
    created_at: string;
    shipped_at: string | null;
    received_at: string | null;
    cancelled_at: string | null;
    source_location_name: string;
    destination_location_name: string;
    line_count: number;
  }>
> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  interface TransferListRow extends Record<string, unknown> {
    id: string;
    status: string;
    note: string | null;
    created_at: string;
    shipped_at: string | null;
    received_at: string | null;
    cancelled_at: string | null;
    source_location_name: string;
    destination_location_name: string;
    line_count: number;
  }
  const { rows } = await query<TransferListRow>(
    `SELECT t.id, t.status::text AS status, t.note, t.created_at,
            t.shipped_at, t.received_at, t.cancelled_at,
            sl.name AS source_location_name, dl.name AS destination_location_name,
            (SELECT COUNT(*)::int FROM inventory_transfer_lines tl WHERE tl.transfer_id=t.id) AS line_count
     FROM inventory_transfers t
     JOIN locations sl ON sl.id = t.source_location_id
     JOIN locations dl ON dl.id = t.destination_location_id
     WHERE t.business_id = $1
     ORDER BY t.created_at DESC LIMIT $2`,
    [businessId, limit],
  );
  return rows;
}

export async function createInventoryTransfer(client: PoolClient, params: {
  businessId: string; sourceLocationId: string; destinationLocationId: string; note?: string | null;
  transferId?: string; idempotencyKey: string; createdBy: string; sync?: TransferSync;
  lines: Array<{ sourceInventoryItemId: string; destinationInventoryItemId: string; quantity: QuantityText }>;
}): Promise<{ id: string; duplicate: boolean }> {
  if (params.sourceLocationId === params.destinationLocationId || !params.idempotencyKey || !params.lines.length)
    throw new Error("invalid_transfer");
  const { rows: locations } = await client.query(
    "SELECT id FROM locations WHERE business_id=$1 AND id=ANY($2::uuid[])",
    [params.businessId,[params.sourceLocationId,params.destinationLocationId]]);
  if (locations.length !== 2) throw new Error("transfer_location_not_found");
  const { rows: existing } = await client.query<{id:string}>(
    "SELECT id FROM inventory_transfers WHERE business_id=$1 AND idempotency_key=$2",
    [params.businessId,params.idempotencyKey]);
  if (existing[0]) return { id:existing[0].id, duplicate:true };
  const { rows } = await client.query<{id:string}>(
    `INSERT INTO inventory_transfers
     (id,business_id,source_location_id,destination_location_id,note,created_by,idempotency_key)
     VALUES(COALESCE($7::uuid,gen_random_uuid()),$1,$2,$3,$4,$5,$6) RETURNING id`,
    [params.businessId,params.sourceLocationId,params.destinationLocationId,params.note?.trim()||null,
     params.createdBy,params.idempotencyKey,params.transferId??null]);
  for (const line of params.lines) {
    positiveQuantityText(line.quantity);
    const { rows: matched } = await client.query(
      `SELECT 1 FROM inventory_items s JOIN inventory_items d ON d.id=$2 AND d.location_id=$4
       WHERE s.id=$1 AND s.location_id=$3`,
      [line.sourceInventoryItemId,line.destinationInventoryItemId,params.sourceLocationId,params.destinationLocationId]);
    if (!matched[0]) throw new Error("transfer_inventory_item_not_found");
    await client.query(
      `INSERT INTO inventory_transfer_lines
       (transfer_id,source_inventory_item_id,destination_inventory_item_id,quantity)
       VALUES($1,$2,$3,$4)`,
      [rows[0].id,line.sourceInventoryItemId,line.destinationInventoryItemId,line.quantity]);
  }
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: params.sourceLocationId,
    clientEventId: params.sync.clientEventId ?? params.idempotencyKey,
    eventType: "inventory.transfer.created",
    payload: { transferId: rows[0].id, destinationLocationId: params.destinationLocationId, note: params.note ?? null, lines: params.lines },
    actorUserId: params.createdBy,
    actorRole: params.sync.actorRole,
  });
  return { id:rows[0].id, duplicate:false };
}

export async function shipInventoryTransfer(client: PoolClient, params: {
  businessId:string; transferId:string; actorId:string; sync?: TransferSync;
}): Promise<{eventId:string;value:RialText}> {
  const { rows: transfers } = await client.query<{source_location_id:string;status:string}>(
    "SELECT source_location_id,status::text FROM inventory_transfers WHERE id=$1 AND business_id=$2 FOR UPDATE",
    [params.transferId,params.businessId]);
  const transfer=transfers[0];
  if (!transfer) throw new Error("transfer_not_found");
  if (transfer.status!=="draft") throw new Error(transfer.status==="shipped"?"transfer_already_shipped":"invalid_transfer_status");
  // Transfers move priced stock between branches — a perpetual instrument.
  if ((await getInventorySystem(params.businessId,client))==="periodic") throw new Error("periodic_system_unsupported");
  const method=await getCostingMethod(params.businessId,client);
  const { rows: events } = await client.query<{id:string}>(
    `INSERT INTO inventory_events
     (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
     VALUES($1,$2,'transfer_ship','inventory_transfer',$3,$4,2,$5) RETURNING id`,
    [params.businessId,transfer.source_location_id,params.transferId,params.actorId,`transfer-ship:${params.transferId}`]);
  const { rows: lines } = await client.query<{id:string;source_inventory_item_id:string;quantity:string}>(
    `SELECT id,source_inventory_item_id,quantity::text FROM inventory_transfer_lines
     WHERE transfer_id=$1 ORDER BY source_inventory_item_id`,[params.transferId]);
  let total=0n;
  for (const line of lines) {
    const quantity=positiveQuantityText(line.quantity);
    const { rows: items } = await client.query<{carrying_value_rial:string|null}>(
      "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1 FOR UPDATE",[line.source_inventory_item_id]);
    const { rows: stock } = await client.query<{quantity:string}>(
      "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
      [line.source_inventory_item_id]);
    if (new Decimal(stock[0].quantity).lt(new Decimal(quantity))) throw new Error("insufficient_transfer_stock");
    let lineValue=0n;
    if (isLotBased(method)) {
      let needed=quantity;
      const { rows: lots } = await client.query<{
        id:string;remaining_qty:string;remaining_value_rial:string|null;received_at:string;
      }>(`SELECT id,remaining_qty::text,remaining_value_rial::text,received_at::text FROM inventory_lots
          WHERE inventory_item_id=$1 AND remaining_qty>0 ORDER BY ${lotConsumptionOrderClause(method)} FOR UPDATE`,
        [line.source_inventory_item_id]);
      for (const lot of lots) {
        if (new Decimal(needed).eq(0)) break;
        if (lot.remaining_value_rial===null) throw new Error(`inventory_exact_cutover_required: lot:${lot.id}`);
        const remaining=quantityText(lot.remaining_qty);
        const take=quantityText(Decimal.min(new Decimal(needed),new Decimal(remaining)).toFixed());
        const value=proportionalDepletionValue(remaining,rialText(lot.remaining_value_rial),take);
        await client.query("UPDATE inventory_lots SET remaining_qty=$2,remaining_value_rial=$3 WHERE id=$1",
          [lot.id,subtractQuantity(remaining,take),(BigInt(lot.remaining_value_rial)-BigInt(value)).toString()]);
        await client.query(
          `INSERT INTO stock_movements
           (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
           VALUES($1,$2,'transfer_out',-$3::numeric,$4::numeric/$3::numeric,$4,'inventory_transfer',$5,$6,$7)`,
          [transfer.source_location_id,line.source_inventory_item_id,take,value,params.transferId,params.actorId,events[0].id]);
        await client.query(
          `INSERT INTO inventory_transfer_allocations
           (transfer_line_id,source_lot_id,quantity,value_rial,original_received_at) VALUES($1,$2,$3,$4,$5)`,
          [line.id,lot.id,take,value,lot.received_at]);
        lineValue+=rialBigInt(value);
        needed=subtractQuantity(needed,take);
      }
      if (new Decimal(needed).gt(0)) throw new Error("insufficient_transfer_layers");
    } else {
      if (items[0].carrying_value_rial===null) throw new Error("inventory_exact_cutover_required");
      const value=proportionalDepletionValue(quantityText(stock[0].quantity),rialText(items[0].carrying_value_rial),quantity);
      const remainingValue=BigInt(items[0].carrying_value_rial)-BigInt(value);
      const remainingQuantity=new Decimal(stock[0].quantity).minus(new Decimal(quantity));
      const positiveRemaining = Decimal.max(remainingQuantity, new Decimal("0"));
      const avg = positiveRemaining.lte(0)
        ? "0"
        : new Decimal(remainingValue.toString()).div(positiveRemaining).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
      await client.query(
        `UPDATE inventory_items SET carrying_value_rial=$2::bigint, avg_cost=$3 WHERE id=$1`,
        [line.source_inventory_item_id, positiveRemaining.lte(0) ? "0" : remainingValue.toString(), avg]);
      await client.query(
        `INSERT INTO stock_movements
         (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
         VALUES($1,$2,'transfer_out',-$3::numeric,$4::numeric/$3::numeric,$4,'inventory_transfer',$5,$6,$7)`,
        [transfer.source_location_id,line.source_inventory_item_id,quantity,value,params.transferId,params.actorId,events[0].id]);
      await client.query(
        `INSERT INTO inventory_transfer_allocations(transfer_line_id,quantity,value_rial,original_received_at)
         VALUES($1,$2,$3,now())`,[line.id,quantity,value]);
      lineValue=rialBigInt(value);
    }
    await client.query("UPDATE inventory_transfer_lines SET shipped_value_rial=$2 WHERE id=$1",
      [line.id,lineValue.toString()]);
    total+=lineValue;
  }
  await postExactOperationalInventoryEntry(client,{
    businessId:params.businessId,locationId:transfer.source_location_id,sourceType:"inventory_transfer",
    sourceId:params.transferId,postingKind:"transfer_ship",memo:systemJournalMemo("inventory_transfer_shipped"),
    createdBy:params.actorId,inventoryEventId:events[0].id,debitCode:WELL_KNOWN_CODES.inventoryInTransit,
    creditCode:WELL_KNOWN_CODES.inventory,amount:rialText(total.toString())});
  await client.query(
    `UPDATE inventory_transfers SET status='shipped',shipped_by=$2,shipped_at=now(),ship_event_id=$3
     WHERE id=$1 AND status='draft'`,[params.transferId,params.actorId,events[0].id]);
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[events[0].id]);
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: transfer.source_location_id,
    clientEventId: params.sync.clientEventId ?? `transfer:ship:${params.transferId}`,
    eventType: "inventory.transfer.shipped",
    payload: { transferId: params.transferId }, actorUserId: params.actorId, actorRole: params.sync.actorRole,
  });
  return {eventId:events[0].id,value:rialText(total.toString())};
}

export async function receiveInventoryTransfer(client: PoolClient, params: {
  businessId:string;transferId:string;actorId:string;sync?: TransferSync;
}): Promise<{eventId:string;value:RialText}> {
  const { rows: transfers } = await client.query<{destination_location_id:string;status:string}>(
    "SELECT destination_location_id,status::text FROM inventory_transfers WHERE id=$1 AND business_id=$2 FOR UPDATE",
    [params.transferId,params.businessId]);
  const transfer=transfers[0];
  if (!transfer) throw new Error("transfer_not_found");
  if (transfer.status!=="shipped") throw new Error(transfer.status==="received"?"transfer_already_received":"invalid_transfer_status");
  const method=await getCostingMethod(params.businessId,client);
  const { rows: events }=await client.query<{id:string}>(
    `INSERT INTO inventory_events
     (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
     VALUES($1,$2,'transfer_receive','inventory_transfer',$3,$4,2,$5) RETURNING id`,
    [params.businessId,transfer.destination_location_id,params.transferId,params.actorId,`transfer-receive:${params.transferId}`]);
  const { rows: allocations }=await client.query<{
    id:string;destination_inventory_item_id:string;quantity:string;value_rial:string;original_received_at:string;
  }>(`SELECT a.id,l.destination_inventory_item_id,a.quantity::text,a.value_rial::text,a.original_received_at::text
      FROM inventory_transfer_allocations a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id
      WHERE l.transfer_id=$1 ORDER BY l.destination_inventory_item_id,a.id FOR UPDATE OF a`,[params.transferId]);
  let total=0n;
  for (const a of allocations) {
    const { rows: destination }=await client.query<{carrying_value_rial:string|null}>(
      "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE",
      [a.destination_inventory_item_id,transfer.destination_location_id]);
    if (!destination[0]) throw new Error("transfer_inventory_item_not_found");
    await client.query(
      `INSERT INTO stock_movements
       (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
       VALUES($1,$2,'transfer_in',$3,$4::numeric/$3::numeric,$4,'inventory_transfer',$5,$6,$7)`,
      [transfer.destination_location_id,a.destination_inventory_item_id,a.quantity,a.value_rial,params.transferId,params.actorId,events[0].id]);
    if (isLotBased(method)) {
      const { rows: lots }=await client.query<{id:string}>(
        `INSERT INTO inventory_lots
         (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,received_at,inventory_event_id,
          original_quantity,original_value_rial,remaining_value_rial)
         VALUES($1,$2,$3,$4::numeric/$3::numeric,'inventory_transfer',$5,$6,$7,$3,$4,$4) RETURNING id`,
        [transfer.destination_location_id,a.destination_inventory_item_id,a.quantity,a.value_rial,params.transferId,a.original_received_at,events[0].id]);
      await client.query("UPDATE inventory_transfer_allocations SET destination_lot_id=$2 WHERE id=$1",[a.id,lots[0].id]);
    } else {
      const newValue=BigInt(destination[0].carrying_value_rial??"0")+BigInt(a.value_rial);
      const { rows: stock }=await client.query<{quantity:string}>(
        "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
        [a.destination_inventory_item_id]);
      const positivePhysical = Decimal.max(new Decimal(stock[0]?.quantity ?? "0"), new Decimal("0"));
      const avg = positivePhysical.lte(0)
        ? (new Decimal(a.quantity).gt(0) ? unitCostFromValue(BigInt(a.value_rial), new Decimal(a.quantity)) : "0")
        : new Decimal(newValue.toString()).div(positivePhysical).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
      await client.query(
        "UPDATE inventory_items SET carrying_value_rial=$2,avg_cost=$3 WHERE id=$1",
        [a.destination_inventory_item_id, positivePhysical.lte(0) ? "0" : newValue.toString(), avg]);
    }
    total+=BigInt(a.value_rial);
  }
  await postExactOperationalInventoryEntry(client,{
    businessId:params.businessId,locationId:transfer.destination_location_id,sourceType:"inventory_transfer",
    sourceId:params.transferId,postingKind:"transfer_receive",memo:systemJournalMemo("inventory_transfer_received"),
    createdBy:params.actorId,inventoryEventId:events[0].id,debitCode:WELL_KNOWN_CODES.inventory,
    creditCode:WELL_KNOWN_CODES.inventoryInTransit,amount:rialText(total.toString())});
  await client.query(
    `UPDATE inventory_transfers SET status='received',received_by=$2,received_at=now(),receive_event_id=$3
     WHERE id=$1 AND status='shipped'`,[params.transferId,params.actorId,events[0].id]);
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[events[0].id]);
  if (params.sync) await appendSyncOutboxEvent(client, {
    locationId: transfer.destination_location_id,
    clientEventId: params.sync.clientEventId ?? `transfer:receive:${params.transferId}`,
    eventType: "inventory.transfer.received",
    payload: { transferId: params.transferId }, actorUserId: params.actorId, actorRole: params.sync.actorRole,
  });
  return {eventId:events[0].id,value:rialText(total.toString())};
}

export async function cancelInventoryTransfer(client: PoolClient, params: {
  businessId:string;transferId:string;actorId:string;sync?: TransferSync;
}): Promise<{eventId:string|null;value:RialText}> {
  const {rows:transfers}=await client.query<{
    source_location_id:string;status:string;ship_event_id:string|null;
  }>("SELECT source_location_id,status::text,ship_event_id FROM inventory_transfers WHERE id=$1 AND business_id=$2 FOR UPDATE",
    [params.transferId,params.businessId]);
  const transfer=transfers[0];
  if(!transfer)throw new Error("transfer_not_found");
  if(transfer.status==="received")throw new Error("received_transfer_requires_reverse_transfer");
  if(transfer.status==="cancelled")throw new Error("transfer_already_cancelled");
  const appendCancellation = async () => {
    if (!params.sync) return;
    await appendSyncOutboxEvent(client, {
      locationId: transfer.source_location_id,
      clientEventId: params.sync.clientEventId ?? `transfer:cancel:${params.transferId}`,
      eventType: "inventory.transfer.cancelled",
      payload: { transferId: params.transferId }, actorUserId: params.actorId, actorRole: params.sync.actorRole,
    });
  };
  if(transfer.status==="draft"){
    await client.query(
      "UPDATE inventory_transfers SET status='cancelled',cancelled_by=$2,cancelled_at=now() WHERE id=$1",
      [params.transferId,params.actorId]);
    await appendCancellation();
    return {eventId:null,value:rialText("0")};
  }
  if(transfer.status!=="shipped"||!transfer.ship_event_id)throw new Error("invalid_transfer_status");
  const method=await getCostingMethod(params.businessId,client);
  const {rows:events}=await client.query<{id:string}>(
    `INSERT INTO inventory_events
     (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key,reversal_of)
     VALUES($1,$2,'transfer_ship','inventory_transfer_cancel',$3,$4,2,$5,$6) RETURNING id`,
    [params.businessId,transfer.source_location_id,params.transferId,params.actorId,
      `transfer-cancel:${params.transferId}`,transfer.ship_event_id]);
  const {rows:allocations}=await client.query<{
    source_inventory_item_id:string;quantity:string;value_rial:string;original_received_at:string;
  }>(`SELECT l.source_inventory_item_id,a.quantity::text,a.value_rial::text,a.original_received_at::text
      FROM inventory_transfer_allocations a JOIN inventory_transfer_lines l ON l.id=a.transfer_line_id
      WHERE l.transfer_id=$1 ORDER BY l.source_inventory_item_id,a.id FOR UPDATE OF a`,[params.transferId]);
  let total=0n;
  for(const allocation of allocations){
    await client.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE",[allocation.source_inventory_item_id]);
    await client.query(
      `INSERT INTO stock_movements
       (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
       VALUES($1,$2,'transfer_in',$3,$4::numeric/$3::numeric,$4,'inventory_transfer_cancel',$5,$6,$7)`,
      [transfer.source_location_id,allocation.source_inventory_item_id,allocation.quantity,
       allocation.value_rial,params.transferId,params.actorId,events[0].id]);
    if(isLotBased(method)){
      await client.query(
        `INSERT INTO inventory_lots
         (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,received_at,inventory_event_id,
          original_quantity,original_value_rial,remaining_value_rial)
         VALUES($1,$2,$3,$4::numeric/$3::numeric,'inventory_transfer_cancel',$5,$6,$7,$3,$4,$4)`,
        [transfer.source_location_id,allocation.source_inventory_item_id,allocation.quantity,
         allocation.value_rial,params.transferId,allocation.original_received_at,events[0].id]);
    }else{
      const {rows:stock}=await client.query<{quantity:string}>(
        "SELECT COALESCE(sum(quantity),0)::text quantity FROM stock_movements WHERE inventory_item_id=$1",
        [allocation.source_inventory_item_id]);
      const { rows: itemRows } = await client.query<{ carrying_value_rial: string | null }>(
        "SELECT carrying_value_rial::text FROM inventory_items WHERE id=$1",
        [allocation.source_inventory_item_id]);
      const nextVal = BigInt(itemRows[0]?.carrying_value_rial ?? "0") + BigInt(allocation.value_rial);
      const positivePhysical = Decimal.max(new Decimal(stock[0]?.quantity ?? "0"), new Decimal("0"));
      const avg = positivePhysical.lte(0)
        ? (new Decimal(allocation.quantity).gt(0) ? unitCostFromValue(BigInt(allocation.value_rial), new Decimal(allocation.quantity)) : "0")
        : new Decimal(nextVal.toString()).div(positivePhysical).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
      await client.query(
        `UPDATE inventory_items SET carrying_value_rial=$2, avg_cost=$3 WHERE id=$1`,
        [allocation.source_inventory_item_id, positivePhysical.lte(0) ? "0" : nextVal.toString(), avg]);
    }
    total+=BigInt(allocation.value_rial);
  }
  await postExactOperationalInventoryEntry(client,{
    businessId:params.businessId,locationId:transfer.source_location_id,sourceType:"inventory_transfer_cancel",
    sourceId:params.transferId,postingKind:"transfer_cancel",memo:systemJournalMemo("inventory_transfer_cancellation"),
    createdBy:params.actorId,inventoryEventId:events[0].id,debitCode:WELL_KNOWN_CODES.inventory,
    creditCode:WELL_KNOWN_CODES.inventoryInTransit,amount:rialText(total.toString())});
  await client.query(
    `UPDATE inventory_transfers SET status='cancelled',cancelled_by=$2,cancelled_at=now(),cancel_event_id=$3
     WHERE id=$1 AND status='shipped'`,[params.transferId,params.actorId,events[0].id]);
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[events[0].id]);
  await appendCancellation();
  return {eventId:events[0].id,value:rialText(total.toString())};
}
