import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import {
  positiveQuantityText,
  quantityText,
  rialText,
  type QuantityText,
  type RialText,
} from "./inventory-exact";

export type HistoryClassification = "exact" | "source_backed" | "unavailable";

export interface InventoryCutoverManifestLine {
  inventoryItemId: string;
  physicalQuantity: string;
  carryingValueRial: string;
  sourceClassification: HistoryClassification;
  evidence?: Record<string, unknown>;
}

export interface InventoryCutoverManifest {
  locationId: string;
  effectiveAt: string;
  approvedBy: string;
  backupConfirmation: string;
  evidenceSha256: string;
  lines: InventoryCutoverManifestLine[];
}

interface ValidatedLine {
  inventoryItemId: string;
  physicalQuantity: QuantityText;
  carryingValueRial: RialText;
  sourceClassification: HistoryClassification;
  evidence: Record<string, unknown>;
}

interface ValidatedManifest extends Omit<InventoryCutoverManifest, "lines"> {
  lines: ValidatedLine[];
  manifestSha256: string;
}

export interface InventoryCutoverDryRun {
  locationId: string;
  businessId: string;
  manifestSha256: string;
  lineCount: number;
  targetQuantity: string;
  targetValueRial: string;
  completedOrders: { exact: number; unavailable: number };
  receivedPurchases: { exact: number; sourceBacked: number };
}

function stableManifestJson(manifest: InventoryCutoverManifest): string {
  return JSON.stringify({
    ...manifest,
    lines: [...manifest.lines]
      .sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))
      .map((line) => ({
        ...line,
        evidence: Object.fromEntries(Object.entries(line.evidence ?? {}).sort(([a], [b]) => a.localeCompare(b))),
      })),
  });
}

export function validateInventoryCutoverManifest(manifest: InventoryCutoverManifest): ValidatedManifest {
  if (!manifest.locationId || !manifest.approvedBy) throw new Error("cutover_approval_required");
  if (!manifest.backupConfirmation || manifest.backupConfirmation.trim().length < 8) {
    throw new Error("cutover_backup_confirmation_required");
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.evidenceSha256)) throw new Error("invalid_evidence_sha256");
  if (!Number.isFinite(Date.parse(manifest.effectiveAt))) throw new Error("invalid_cutover_timestamp");
  if (!Array.isArray(manifest.lines) || manifest.lines.length === 0) throw new Error("cutover_manifest_lines_required");
  const seen = new Set<string>();
  const lines = manifest.lines.map((line) => {
    if (!line.inventoryItemId || seen.has(line.inventoryItemId)) throw new Error("duplicate_cutover_item");
    seen.add(line.inventoryItemId);
    if (!["exact", "source_backed", "unavailable"].includes(line.sourceClassification)) {
      throw new Error("invalid_history_classification");
    }
    return {
      inventoryItemId: line.inventoryItemId,
      physicalQuantity:
        line.physicalQuantity === "0" ? quantityText("0") : positiveQuantityText(line.physicalQuantity),
      carryingValueRial: rialText(line.carryingValueRial),
      sourceClassification: line.sourceClassification,
      evidence: line.evidence ?? {},
    };
  });
  return {
    ...manifest,
    lines,
    manifestSha256: createHash("sha256").update(stableManifestJson(manifest)).digest("hex"),
  };
}

async function validateAuthority(
  client: PoolClient,
  manifest: ValidatedManifest,
): Promise<{ businessId: string }> {
  const { rows } = await client.query<{ business_id: string; role: string }>(
    `SELECT l.business_id,u.role::text
       FROM locations l
       JOIN users u ON u.id=$2 AND u.business_id=l.business_id AND u.is_active
      WHERE l.id=$1`,
    [manifest.locationId, manifest.approvedBy],
  );
  if (!rows[0]) throw new Error("cutover_location_or_approver_not_found");
  if (!["owner", "manager"].includes(rows[0].role)) throw new Error("cutover_approval_required");
  return { businessId: rows[0].business_id };
}

export async function dryRunInventoryCutover(
  client: PoolClient,
  input: InventoryCutoverManifest,
): Promise<InventoryCutoverDryRun> {
  const manifest = validateInventoryCutoverManifest(input);
  const { businessId } = await validateAuthority(client, manifest);
  const itemIds = manifest.lines.map((line) => line.inventoryItemId);
  const { rows: items } = await client.query<{ id: string }>(
    "SELECT id FROM inventory_items WHERE location_id=$1 AND id=ANY($2::uuid[])",
    [manifest.locationId, itemIds],
  );
  if (items.length !== itemIds.length) throw new Error("cutover_inventory_item_not_found");

  const { rows: orderCoverage } = await client.query<{ exact: string; unavailable: string }>(
    `SELECT
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM inventory_events ie
          JOIN journal_entries je ON je.inventory_event_id=ie.id AND je.posting_kind='cogs'
         WHERE ie.source_type='order' AND ie.source_id=o.id AND ie.costing_version=2
       ))::text exact,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM inventory_events ie
          JOIN journal_entries je ON je.inventory_event_id=ie.id AND je.posting_kind='cogs'
         WHERE ie.source_type='order' AND ie.source_id=o.id AND ie.costing_version=2
       ))::text unavailable
       FROM orders o WHERE o.location_id=$1 AND o.status='completed' AND o.closed_at <= $2`,
    [manifest.locationId, manifest.effectiveAt],
  );
  const { rows: purchaseCoverage } = await client.query<{ exact: string; source_backed: string }>(
    `SELECT
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM inventory_events ie
          WHERE ie.source_type='purchase' AND ie.source_id=p.id AND ie.costing_version=2
       ))::text exact,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM inventory_events ie
          WHERE ie.source_type='purchase' AND ie.source_id=p.id AND ie.costing_version=2
       ))::text source_backed
       FROM purchases p WHERE p.location_id=$1 AND p.status='received' AND p.received_at <= $2`,
    [manifest.locationId, manifest.effectiveAt],
  );
  const targetQuantity = manifest.lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.physicalQuantity)),
    new Decimal("0"),
  );
  const targetValue = manifest.lines.reduce((sum, line) => sum + BigInt(line.carryingValueRial), 0n);
  return {
    locationId: manifest.locationId,
    businessId,
    manifestSha256: manifest.manifestSha256,
    lineCount: manifest.lines.length,
    targetQuantity: quantityText(targetQuantity.toFixed()),
    targetValueRial: rialText(targetValue.toString()),
    completedOrders: {
      exact: Number(orderCoverage[0].exact),
      unavailable: Number(orderCoverage[0].unavailable),
    },
    receivedPurchases: {
      exact: Number(purchaseCoverage[0].exact),
      sourceBacked: Number(purchaseCoverage[0].source_backed),
    },
  };
}

export async function applyInventoryCutover(
  client: PoolClient,
  input: InventoryCutoverManifest,
): Promise<{ cutoverId: string; inventoryEventId: string; reconciliationJournalId: string | null; duplicate: boolean }> {
  const manifest = validateInventoryCutoverManifest(input);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `inventory-cutover:${manifest.locationId}`,
  ]);
  const { businessId } = await validateAuthority(client, manifest);
  const { rows: existing } = await client.query<{ id: string; manifest_sha256: string; inventory_event_id: string; reconciliation_journal_id: string | null }>(
    "SELECT id,manifest_sha256,inventory_event_id,reconciliation_journal_id FROM inventory_cutovers WHERE location_id=$1",
    [manifest.locationId],
  );
  if (existing[0]) {
    if (existing[0].manifest_sha256 !== manifest.manifestSha256) throw new Error("inventory_cutover_already_exists");
    return {
      cutoverId: existing[0].id,
      inventoryEventId: existing[0].inventory_event_id,
      reconciliationJournalId: existing[0].reconciliation_journal_id,
      duplicate: true,
    };
  }

  const { rows: cutoverRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_cutovers
       (business_id,location_id,effective_at,approved_by,backup_confirmation,evidence_sha256,manifest_sha256)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      businessId,
      manifest.locationId,
      manifest.effectiveAt,
      manifest.approvedBy,
      manifest.backupConfirmation.trim(),
      manifest.evidenceSha256,
      manifest.manifestSha256,
    ],
  );
  const cutoverId = cutoverRows[0].id;
  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,effective_at,created_by,costing_version,
        idempotency_key,metadata)
     VALUES($1,$2,'stock_count_adjustment','inventory_cutover',$3,$4,$5,2,$6,$7)
     RETURNING id`,
    [
      businessId,
      manifest.locationId,
      cutoverId,
      manifest.effectiveAt,
      manifest.approvedBy,
      `inventory-cutover:${manifest.locationId}`,
      JSON.stringify({ evidenceSha256: manifest.evidenceSha256, manifestSha256: manifest.manifestSha256 }),
    ],
  );
  const inventoryEventId = eventRows[0].id;
  let targetValue = 0n;

  for (const line of [...manifest.lines].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId))) {
    const { rows: itemRows } = await client.query<{ id: string }>(
      "SELECT id FROM inventory_items WHERE id=$1 AND location_id=$2 FOR UPDATE",
      [line.inventoryItemId, manifest.locationId],
    );
    if (!itemRows[0]) throw new Error(`cutover_inventory_item_not_found: ${line.inventoryItemId}`);
    const { rows: priorRows } = await client.query<{ quantity: string; value: string }>(
      `SELECT
         trim_scale(COALESCE((SELECT sum(quantity) FROM stock_movements WHERE inventory_item_id=$1),0))::text quantity,
         COALESCE((SELECT gross_carrying_value FROM v_inventory_valuation WHERE inventory_item_id=$1),0)::text value`,
      [line.inventoryItemId],
    );
    await client.query(
      `UPDATE inventory_lots
          SET remaining_qty=0,
              remaining_value_rial=CASE WHEN remaining_value_rial IS NULL THEN NULL ELSE 0 END
        WHERE inventory_item_id=$1 AND remaining_qty>0`,
      [line.inventoryItemId],
    );
    await client.query(
      `UPDATE inventory_negative_layers
          SET remaining_quantity=0,settled_at=COALESCE(settled_at,$2),
              remaining_provisional_value_rial=
                CASE WHEN remaining_provisional_value_rial IS NULL THEN NULL ELSE 0 END
        WHERE inventory_item_id=$1 AND remaining_quantity>0`,
      [line.inventoryItemId, manifest.effectiveAt],
    );
    const delta = new Decimal(line.physicalQuantity).minus(new Decimal(priorRows[0].quantity));
    if (!delta.eq(0)) {
      await client.query(
        `INSERT INTO stock_movements
           (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,
            source_type,source_id,note,created_by,inventory_event_id,occurred_at)
         VALUES($1,$2,'adjustment',$3,0,$4,'inventory_cutover',$5,$6,$7,$8,$9)`,
        [
          manifest.locationId,
          line.inventoryItemId,
          delta.toFixed(),
          line.carryingValueRial,
          cutoverId,
          "Audited inventory cutover",
          manifest.approvedBy,
          inventoryEventId,
          manifest.effectiveAt,
        ],
      );
    }
    if (new Decimal(line.physicalQuantity).gt(0)) {
      const unitCost = new Decimal(line.carryingValueRial)
        .div(new Decimal(line.physicalQuantity))
        .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
        .toFixed();
      await client.query(
        `INSERT INTO inventory_lots
           (location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,received_at,
            inventory_event_id,original_quantity,original_value_rial,remaining_value_rial)
         VALUES($1,$2,$3,$4,'inventory_cutover',$5,$6,$7,$3,$8,$8)`,
        [
          manifest.locationId,
          line.inventoryItemId,
          line.physicalQuantity,
          unitCost,
          cutoverId,
          manifest.effectiveAt,
          inventoryEventId,
          line.carryingValueRial,
        ],
      );
    }
    const phys = new Decimal(line.physicalQuantity);
    const positivePhys = Decimal.max(phys, new Decimal("0"));
    const avg = positivePhys.lte(0)
      ? "0"
      : new Decimal(line.carryingValueRial).div(positivePhys).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
    await client.query(
      `UPDATE inventory_items
          SET carrying_value_rial=$2::bigint,
              avg_cost=$3
        WHERE id=$1`,
      [line.inventoryItemId, positivePhys.lte(0) ? "0" : line.carryingValueRial, avg],
    );
    await client.query(
      `INSERT INTO inventory_cutover_lines
         (cutover_id,inventory_item_id,source_classification,physical_quantity,carrying_value_rial,
          prior_physical_quantity,prior_subledger_value_rial,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        cutoverId,
        line.inventoryItemId,
        line.sourceClassification,
        line.physicalQuantity,
        line.carryingValueRial,
        priorRows[0].quantity,
        priorRows[0].value,
        JSON.stringify(line.evidence),
      ],
    );
    targetValue += BigInt(line.carryingValueRial);
  }

  await client.query(
    `INSERT INTO inventory_history_coverage
       (cutover_id,location_id,source_type,source_id,classification,cogs_available,reason,linked_inventory_event_id)
     SELECT $1,$2,'order',o.id,
       CASE WHEN ie.id IS NULL THEN 'unavailable'::inventory_history_classification
            ELSE 'exact'::inventory_history_classification END,
       ie.id IS NOT NULL,
       CASE WHEN ie.id IS NULL
            THEN 'Historical recipe and immutable cost allocation evidence unavailable'
            ELSE 'Version-2 event and COGS journal are linked' END,
       ie.id
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT event.id FROM inventory_events event
       JOIN journal_entries je ON je.inventory_event_id=event.id AND je.posting_kind='cogs'
       WHERE event.source_type='order' AND event.source_id=o.id AND event.costing_version=2
       LIMIT 1
     ) ie ON true
     WHERE o.location_id=$2 AND o.status='completed' AND o.closed_at <= $3`,
    [cutoverId, manifest.locationId, manifest.effectiveAt],
  );
  await client.query(
    `INSERT INTO inventory_history_coverage
       (cutover_id,location_id,source_type,source_id,classification,cogs_available,reason,linked_inventory_event_id)
     SELECT $1,$2,'purchase',p.id,
       CASE WHEN ie.id IS NULL THEN 'source_backed'::inventory_history_classification
            ELSE 'exact'::inventory_history_classification END,
       true,
       CASE WHEN ie.id IS NULL THEN 'Immutable purchase lines and extended receipt values are available'
            ELSE 'Version-2 receipt allocation is linked' END,
       ie.id
     FROM purchases p
     LEFT JOIN LATERAL (
       SELECT id FROM inventory_events
       WHERE source_type='purchase' AND source_id=p.id AND costing_version=2 LIMIT 1
     ) ie ON true
     WHERE p.location_id=$2 AND p.status='received' AND p.received_at <= $3`,
    [cutoverId, manifest.locationId, manifest.effectiveAt],
  );

  const { rows: glRows } = await client.query<{ balance: string }>(
    `SELECT COALESCE(sum(jl.debit-jl.credit),0)::text balance
       FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id=a.id
      WHERE a.business_id=$1 AND a.code='1300'`,
    [businessId],
  );
  const difference = targetValue - BigInt(glRows[0].balance);
  let reconciliationJournalId: string | null = null;
  if (difference !== 0n) {
    const { rows: accounts } = await client.query<{ code: string; id: string }>(
      "SELECT code,id FROM accounts WHERE business_id=$1 AND code=ANY($2::text[]) AND is_active",
      [businessId, ["1300", "3950"]],
    );
    const accountMap = new Map(accounts.map((account) => [account.code, account.id]));
    if (!accountMap.get("1300") || !accountMap.get("3950")) throw new Error("cutover_ledger_account_missing");
    const { rows: journals } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries
         (business_id,location_id,entry_date,memo,source_type,source_id,created_by,posting_kind,inventory_event_id)
       VALUES($1,$2,$3::timestamptz::date,'Audited historical inventory reconciliation',
              'inventory_cutover',$4,$5,'historical_inventory_reconciliation',$6)
       RETURNING id`,
      [businessId, manifest.locationId, manifest.effectiveAt, cutoverId, manifest.approvedBy, inventoryEventId],
    );
    reconciliationJournalId = journals[0].id;
    const amount = (difference < 0n ? -difference : difference).toString();
    const debitCode = difference > 0n ? "1300" : "3950";
    const creditCode = difference > 0n ? "3950" : "1300";
    await client.query(
      `INSERT INTO journal_lines(entry_id,account_id,debit,credit)
       VALUES($1,$2,$4,0),($1,$3,0,$4)`,
      [reconciliationJournalId, accountMap.get(debitCode), accountMap.get(creditCode), amount],
    );
    await client.query("SELECT set_config('app.fiscal_constructing_entry_id', '', true)");
  }
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);
  await client.query(
    `UPDATE inventory_cutovers
        SET status='applied',inventory_event_id=$2,reconciliation_journal_id=$3,applied_at=now()
      WHERE id=$1`,
    [cutoverId, inventoryEventId, reconciliationJournalId],
  );
  return { cutoverId, inventoryEventId, reconciliationJournalId, duplicate: false };
}
