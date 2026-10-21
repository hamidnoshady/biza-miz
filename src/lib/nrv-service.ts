import type { PoolClient } from "pg";
import { rialBigInt, rialText, type RialText } from "./inventory-exact";
import { getInventorySystem } from "./inventory-service";
import { postExactOperationalInventoryEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { systemJournalMemo } from "./journal-memo";

export async function createNrvWriteDown(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    valuationDate: string;
    reason: string;
    idempotencyKey: string;
    createdBy: string;
    lines: Array<{ inventoryItemId: string; nrvValueRial: RialText }>;
  },
): Promise<{ id: string; amount: RialText }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.valuationDate) || !params.reason.trim() || params.lines.length === 0) {
    throw new Error("invalid_write_down");
  }
  // NRV compares carrying value per item — a perpetual notion; ادواری has no
  // per-item carrying value between closes.
  if ((await getInventorySystem(params.businessId, client)) === "periodic") {
    throw new Error("periodic_system_unsupported");
  }
  const { rows: header } = await client.query<{ id: string }>(
    `INSERT INTO inventory_write_downs
       (business_id,location_id,valuation_date,reason,created_by,idempotency_key)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(business_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.valuationDate,
      params.reason.trim(),
      params.createdBy,
      params.idempotencyKey,
    ],
  );
  const writeDownId = header[0].id;
  const { rows: existing } = await client.query("SELECT 1 FROM inventory_write_down_lines WHERE write_down_id=$1", [
    writeDownId,
  ]);
  if (existing.length) {
    const { rows } = await client.query<{ amount: string }>(
      "SELECT COALESCE(sum(amount_rial),0)::text amount FROM inventory_write_down_lines WHERE write_down_id=$1",
      [writeDownId],
    );
    return { id: writeDownId, amount: rialText(rows[0].amount) };
  }
  let total = 0n;
  for (const line of [...params.lines].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    await client.query("SELECT id FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE", [
      line.inventoryItemId,
      params.locationId,
    ]);
    const { rows: valueRows } = await client.query<{ gross: string; allowance: string }>(
      `SELECT COALESCE(gross_carrying_value,0)::text gross,
              COALESCE(nrv_allowance_rial,0)::text allowance
         FROM v_inventory_nrv_valuation WHERE inventory_item_id=$1`,
      [line.inventoryItemId],
    );
    if (!valueRows[0]) throw new Error(`inventory_item_not_found: ${line.inventoryItemId}`);
    const gross = BigInt(valueRows[0].gross);
    const priorAllowance = BigInt(valueRows[0].allowance);
    const nrv = rialBigInt(line.nrvValueRial);
    const currentNet = gross - priorAllowance;
    const amount = currentNet > nrv ? currentNet - nrv : 0n;
    await client.query(
      `INSERT INTO inventory_write_down_lines
         (write_down_id,inventory_item_id,gross_value_rial,prior_allowance_rial,nrv_value_rial,amount_rial)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [writeDownId, line.inventoryItemId, gross.toString(), priorAllowance.toString(), nrv.toString(), amount.toString()],
    );
    total += amount;
  }
  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
     VALUES($1,$2,'nrv_write_down','inventory_write_down',$3,$4,2,$5)
     RETURNING id`,
    [params.businessId, params.locationId, writeDownId, params.createdBy, `nrv:${params.idempotencyKey}`],
  );
  await client.query("UPDATE inventory_write_downs SET inventory_event_id=$2 WHERE id=$1", [writeDownId, events[0].id]);
  await postExactOperationalInventoryEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "inventory_write_down",
    sourceId: writeDownId,
    postingKind: "nrv_write_down",
    memo: systemJournalMemo("inventory_nrv_write_down"),
    createdBy: params.createdBy,
    inventoryEventId: events[0].id,
    debitCode: WELL_KNOWN_CODES.inventoryWriteDownExpense,
    creditCode: WELL_KNOWN_CODES.nrvAllowance,
    amount: rialText(total.toString()),
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [events[0].id]);
  return { id: writeDownId, amount: rialText(total.toString()) };
}

export async function reverseNrvWriteDown(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    originalId: string;
    reason: string;
    idempotencyKey: string;
    createdBy: string;
    amounts?: Array<{ inventoryItemId: string; amountRial: RialText }>;
  },
): Promise<{ id: string; amount: RialText }> {
  const { rows: original } = await client.query<{ valuation_date: string }>(
    `SELECT valuation_date::text FROM inventory_write_downs
      WHERE id=$1 AND business_id=$2 AND location_id=$3 AND reversal_of IS NULL FOR UPDATE`,
    [params.originalId, params.businessId, params.locationId],
  );
  if (!original[0]) throw new Error("write_down_not_found");
  const { rows: available } = await client.query<{ inventory_item_id: string; available: string }>(
    `SELECT original.inventory_item_id,
       (original.amount_rial-COALESCE(sum(reversal_line.amount_rial),0))::text available
     FROM inventory_write_down_lines original
     LEFT JOIN inventory_write_downs reversal ON reversal.reversal_of=original.write_down_id
     LEFT JOIN inventory_write_down_lines reversal_line
       ON reversal_line.write_down_id=reversal.id AND reversal_line.inventory_item_id=original.inventory_item_id
     WHERE original.write_down_id=$1
     GROUP BY original.inventory_item_id,original.amount_rial`,
    [params.originalId],
  );
  const requested = new Map(params.amounts?.map((line) => [line.inventoryItemId, line.amountRial]) ?? []);
  const { rows: headers } = await client.query<{ id: string }>(
    `INSERT INTO inventory_write_downs
       (business_id,location_id,valuation_date,reason,reversal_of,created_by,idempotency_key)
     VALUES($1,$2,CURRENT_DATE,$3,$4,$5,$6)
     ON CONFLICT(business_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [params.businessId, params.locationId, params.reason.trim(), params.originalId, params.createdBy, params.idempotencyKey],
  );
  const { rows: existingLines } = await client.query<{ amount: string }>(
    "SELECT COALESCE(sum(amount_rial),0)::text amount FROM inventory_write_down_lines WHERE write_down_id=$1",
    [headers[0].id],
  );
  if (BigInt(existingLines[0].amount) > 0n) {
    return { id: headers[0].id, amount: rialText(existingLines[0].amount) };
  }
  let total = 0n;
  for (const row of available) {
    const amount = requested.has(row.inventory_item_id)
      ? rialBigInt(requested.get(row.inventory_item_id)!)
      : BigInt(row.available);
    if (amount > BigInt(row.available)) throw new Error("nrv_reversal_exceeds_available");
    if (amount === 0n) continue;
    await client.query(
      `INSERT INTO inventory_write_down_lines
         (write_down_id,inventory_item_id,gross_value_rial,prior_allowance_rial,nrv_value_rial,amount_rial)
       VALUES($1,$2,$3,0,0,$3)`,
      [headers[0].id, row.inventory_item_id, amount.toString()],
    );
    total += amount;
  }
  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key,reversal_of)
     SELECT $1,$2,'nrv_reversal','inventory_write_down',$3,$4,2,$5,inventory_event_id
       FROM inventory_write_downs WHERE id=$6
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      headers[0].id,
      params.createdBy,
      `nrv-reversal:${params.idempotencyKey}`,
      params.originalId,
    ],
  );
  await client.query("UPDATE inventory_write_downs SET inventory_event_id=$2 WHERE id=$1", [
    headers[0].id,
    events[0].id,
  ]);
  await postExactOperationalInventoryEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    sourceType: "inventory_write_down",
    sourceId: headers[0].id,
    postingKind: "nrv_reversal",
    memo: systemJournalMemo("inventory_nrv_reversal"),
    createdBy: params.createdBy,
    inventoryEventId: events[0].id,
    debitCode: WELL_KNOWN_CODES.nrvAllowance,
    creditCode: WELL_KNOWN_CODES.inventoryWriteDownExpense,
    amount: rialText(total.toString()),
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [events[0].id]);
  return { id: headers[0].id, amount: rialText(total.toString()) };
}
