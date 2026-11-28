/**
 * F1 (GH #1567) — reconciling fungible item stock value with its average and
 * with the general ledger, and the only sanctioned way to clear legacy drift.
 *
 *  - `readItemStockValuationReconciliation` is a pure read (the dry run): it
 *    lists every fungible stock row whose stored carrying value disagrees
 *    with quantity × moving average beyond rounding, totals the subledger per
 *    inventory account, and ties it to the GL balance of that account. Its
 *    fingerprint is a hash of exactly the rows it shows.
 *  - `repairItemStockValuation` applies the dry run's proposal, and only if:
 *    the caller is authorised (route: inventory.adjust + ledger.approve), the
 *    operator gave a reason and an idempotency key, and the current state
 *    still hashes to the fingerprint they reviewed. It writes one audit row
 *    with every before/after value and posts no journal — the ledger already
 *    carries quantity × average, the repair re-aligns the subledger to it.
 *
 * Nothing here runs on its own: no migration, job or writer calls the repair.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { RETAIL_ACCOUNT_CODES } from "./retail-account-codes";
import { isRetailCatalogueIndustry, type Industry } from "./industries";
import { averageBasedValue, carryingDrift, type FungibleStockState } from "./item-stock-valuation";

export interface ValuationDriftRow {
  itemId: string;
  locationId: string;
  name: string;
  sku: string | null;
  quantity: string;
  unitCost: string | null;
  storedTotal: string | null;
  expectedTotal: string;
  /** stored − expected, Rial (signed). */
  drift: string;
}

export interface ValuationReconciliation {
  businessId: string;
  locationId: string | null;
  inventoryAccountCode: string | null;
  rows: ValuationDriftRow[];
  fingerprint: string;
  /** Sum of stored carrying values over every fungible row in scope. */
  subledgerStoredTotal: string;
  /** Sum of quantity × average over every fungible row in scope. */
  subledgerExpectedTotal: string;
  /** Sum of item_stock.total_value_rial over all item stock (incl. batch rollups), business-wide. */
  itemStockTotal: string;
  /** GL balance (debit − credit) of the industry's item inventory account, business-wide; null when not applicable. */
  glInventoryBalance: string | null;
  /** itemStockTotal − glInventoryBalance; null when there is no GL account to tie to. */
  glDifference: string | null;
}

export class ValuationRepairError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "ValuationRepairError";
  }
}

type Runner = Pick<PoolClient, "query">;

function fingerprintOf(rows: ValuationDriftRow[]): string {
  const canonical = rows
    .map((r) => [r.itemId, r.quantity, r.unitCost ?? "", r.storedTotal ?? "", r.expectedTotal].join("|"))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

async function loadRows(
  client: Runner,
  businessId: string,
  locationId: string | null,
  lock: boolean,
  itemIds: readonly string[] | null,
): Promise<Array<{ item_id: string; location_id: string; name: string; sku: string | null; quantity: string; unit_cost: string | null; total_value_rial: string | null }>> {
  const { rows } = await client.query<{
    item_id: string;
    location_id: string;
    name: string;
    sku: string | null;
    quantity: string;
    unit_cost: string | null;
    total_value_rial: string | null;
  }>(
    `SELECT s.item_id, i.location_id, i.name, i.sku, s.quantity::text, s.unit_cost::text, s.total_value_rial::text
       FROM item_stock s
       JOIN items i ON i.id = s.item_id
       JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1
        AND i.tracking = 'none'
        AND ($2::uuid IS NULL OR i.location_id = $2)
        AND ($3::uuid[] IS NULL OR s.item_id = ANY($3::uuid[]))
      ORDER BY s.item_id
      ${lock ? "FOR UPDATE OF s" : ""}`,
    [businessId, locationId, itemIds],
  );
  return rows;
}

function toDriftRows(raw: Awaited<ReturnType<typeof loadRows>>): {
  rows: ValuationDriftRow[];
  stored: bigint;
  expected: bigint;
} {
  const rows: ValuationDriftRow[] = [];
  let stored = 0n;
  let expected = 0n;
  for (const r of raw) {
    const state: FungibleStockState = { quantity: r.quantity, unitCost: r.unit_cost, totalValue: r.total_value_rial };
    const exp = averageBasedValue(state);
    expected += BigInt(exp);
    stored += BigInt(r.total_value_rial ?? exp);
    const drift = carryingDrift(state);
    if (drift === 0n) continue;
    rows.push({
      itemId: r.item_id,
      locationId: r.location_id,
      name: r.name,
      sku: r.sku,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      storedTotal: r.total_value_rial,
      expectedTotal: exp,
      drift: drift.toString(),
    });
  }
  return { rows, stored, expected };
}

/** The dry run. Read-only; safe to call any time. */
export async function readItemStockValuationReconciliation(
  client: Runner,
  input: { businessId: string; locationId?: string | null },
): Promise<ValuationReconciliation> {
  const locationId = input.locationId ?? null;
  const raw = await loadRows(client, input.businessId, locationId, false, null);
  const { rows, stored, expected } = toDriftRows(raw);

  const { rows: industryRows } = await client.query<{ industry: Industry }>(
    "SELECT industry FROM businesses WHERE id = $1",
    [input.businessId],
  );
  const industry = industryRows[0]?.industry;
  const codes = isRetailCatalogueIndustry(industry) ? RETAIL_ACCOUNT_CODES[industry] : undefined;
  const inventoryAccountCode = codes?.inventory ?? null;

  const { rows: totalRows } = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(COALESCE(s.total_value_rial, round(s.quantity * COALESCE(s.unit_cost, 0))::bigint)), 0)::text AS total
       FROM item_stock s JOIN items i ON i.id = s.item_id JOIN locations l ON l.id = i.location_id
      WHERE l.business_id = $1`,
    [input.businessId],
  );
  const itemStockTotal = totalRows[0]?.total ?? "0";

  let glInventoryBalance: string | null = null;
  if (inventoryAccountCode) {
    const { rows: glRows } = await client.query<{ balance: string | null }>(
      `SELECT (SELECT COALESCE(sum(jl.debit) - sum(jl.credit), 0)::text
                 FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE je.business_id = $1 AND jl.account_id = a.id) AS balance
         FROM accounts a WHERE a.business_id = $1 AND a.code = $2 LIMIT 1`,
      [input.businessId, inventoryAccountCode],
    );
    glInventoryBalance = glRows[0]?.balance ?? null;
  }

  return {
    businessId: input.businessId,
    locationId,
    inventoryAccountCode,
    rows,
    fingerprint: fingerprintOf(rows),
    subledgerStoredTotal: stored.toString(),
    subledgerExpectedTotal: expected.toString(),
    itemStockTotal,
    glInventoryBalance,
    glDifference: glInventoryBalance == null ? null : (BigInt(itemStockTotal) - BigInt(glInventoryBalance)).toString(),
  };
}

export interface ValuationRepairInput {
  businessId: string;
  locationId?: string | null;
  performedBy: string;
  reason: string;
  /** The fingerprint returned by the dry run the operator reviewed. */
  fingerprint: string;
  idempotencyKey: string;
}

export interface ValuationRepairResult {
  repairId: string;
  lineCount: number;
  storedTotal: string;
  repairedTotal: string;
  duplicate: boolean;
}

/**
 * Applies a reviewed dry run. Must run inside the caller's transaction; the
 * route is responsible for authorisation (inventory.adjust + ledger.approve).
 */
export async function repairItemStockValuation(
  client: PoolClient,
  input: ValuationRepairInput,
): Promise<ValuationRepairResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 1000) throw new ValuationRepairError("reason_required", 400);
  if (!/^[0-9a-f]{64}$/.test(input.fingerprint ?? "")) throw new ValuationRepairError("fingerprint_required", 400);
  const key = (input.idempotencyKey ?? "").trim();
  if (key.length < 8 || key.length > 200) throw new ValuationRepairError("idempotency_key_required", 400);

  const { rows: prior } = await client.query<{
    id: string;
    fingerprint: string;
    line_count: number;
    stored_total: string;
    repaired_total: string;
  }>(
    `SELECT id, fingerprint, line_count, stored_total::text, repaired_total::text
       FROM item_stock_valuation_repairs WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, key],
  );
  if (prior[0]) {
    if (prior[0].fingerprint !== input.fingerprint) throw new ValuationRepairError("idempotency_conflict");
    return {
      repairId: prior[0].id,
      lineCount: prior[0].line_count,
      storedTotal: prior[0].stored_total,
      repairedTotal: prior[0].repaired_total,
      duplicate: true,
    };
  }

  const locationId = input.locationId ?? null;
  // Lock every fungible row in scope, then re-derive the proposal: if it no
  // longer hashes to what the operator reviewed, nothing is written.
  const raw = await loadRows(client, input.businessId, locationId, true, null);
  const { rows } = toDriftRows(raw);
  if (rows.length === 0) throw new ValuationRepairError("nothing_to_repair");
  if (fingerprintOf(rows) !== input.fingerprint) throw new ValuationRepairError("reconciliation_changed");

  let storedTotal = 0n;
  let repairedTotal = 0n;
  const lines = rows.map((r) => {
    storedTotal += BigInt(r.storedTotal ?? "0");
    repairedTotal += BigInt(r.expectedTotal);
    return { itemId: r.itemId, quantity: r.quantity, unitCost: r.unitCost, before: r.storedTotal, after: r.expectedTotal };
  });
  for (const line of lines) {
    await client.query(
      `UPDATE item_stock SET total_value_rial = $2::bigint, updated_at = now() WHERE item_id = $1`,
      [line.itemId, line.after],
    );
  }
  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_valuation_repairs
       (business_id, location_id, performed_by, reason, fingerprint, idempotency_key,
        line_count, stored_total, repaired_total, lines)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id`,
    [
      input.businessId,
      locationId,
      input.performedBy,
      reason,
      input.fingerprint,
      key,
      lines.length,
      storedTotal.toString(),
      repairedTotal.toString(),
      JSON.stringify(lines),
    ],
  );
  return {
    repairId: inserted[0].id,
    lineCount: lines.length,
    storedTotal: storedTotal.toString(),
    repairedTotal: repairedTotal.toString(),
    duplicate: false,
  };
}
