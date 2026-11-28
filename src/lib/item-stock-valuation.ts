/**
 * Canonical carrying value for fungible (`tracking='none'`) item stock — F1
 * of GH #1567 (stale inventory valuation), shared by every industry that
 * keeps stock in `item_stock`.
 *
 * Costing policy (authoritative): a fungible item is valued at its moving
 * weighted average. `item_stock.unit_cost` is that average, maintained on
 * every receipt; `item_stock.total_value_rial` (migration 0236) is the exact
 * whole-Rial carrying value, kept so rounding pennies of a non-integer
 * average are not lost (1 @ 100 + 1 @ 101 carries 201, not 2 × 101). Batch-
 * and serial-tracked items keep their own per-lot / per-unit values and roll
 * up through `recomputeItemStockRollup`; this module is not for them.
 *
 * The defect this replaces: most writers moved `quantity` and left
 * `total_value_rial` alone, so the next movement that read the total
 * (warehouse write-off, receipt) used a stale figure — buy 10 @ 50,000, sell
 * 4, write off 1 relieved 500,000 / 6 = 83,333 instead of 50,000.
 *
 * Rules every caller gets from here, never re-derived locally:
 *
 *  1. The row is locked (`FOR UPDATE`) before it is read, so concurrent
 *     movements serialise on the item and never relieve the same value twice.
 *  2. A relief is proportional to the carrying *basis*; the last unit out
 *     takes the remainder, so a full depletion leaves exactly zero.
 *  3. Quantity and value move in one UPDATE; the relieved value is what the
 *     caller posts as COGS / inventory credit, so subledger and GL agree.
 *  4. A restore (return, void, cancellation) re-enters the exact value the
 *     original movement relieved — never today's average.
 *  5. Legacy drift is preserved, not rewritten. When a pre-fix row's total
 *     disagrees with quantity × average beyond rounding, the *basis* for new
 *     movements falls back to quantity × average (the figure the GL was
 *     posted with), but the stored difference is carried forward untouched
 *     (`total − relieved`). Only the audited, explicitly authorised
 *     reconciliation (`item-stock-valuation-reconciliation.ts`) clears it.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { MAX_RIAL, roundRial, rialText, type RialText } from "./inventory-exact";

export class ItemStockValuationError extends Error {
  constructor(
    public readonly code: "stock_missing" | "cost_missing" | "insufficient" | "invalid_quantity" | "value_out_of_range",
  ) {
    super(code);
    this.name = "ItemStockValuationError";
  }
}

/** One fungible stock row as stored. All numerics are the raw column text. */
export interface FungibleStockState {
  quantity: string;
  unitCost: string | null;
  totalValue: string | null;
}

function dec(value: string | null | undefined): Decimal {
  return new Decimal(value ?? "0");
}

/** quantity × average, rounded — the value the GL was posted with. */
export function averageBasedValue(state: FungibleStockState): RialText {
  if (state.unitCost == null) return rialText("0");
  const quantity = dec(state.quantity);
  if (quantity.lte(0)) return rialText("0");
  return roundRial(quantity.times(dec(state.unitCost)));
}

/**
 * How far a row's stored total sits from what its quantity and average
 * justify, beyond the rounding an integer average can explain (half a Rial
 * per unit, plus one). Zero means consistent. Signed: positive = the stored
 * total is higher than the average supports.
 */
export function carryingDrift(state: FungibleStockState): bigint {
  if (state.totalValue == null || state.unitCost == null) return 0n;
  const stored = BigInt(state.totalValue);
  const expected = BigInt(averageBasedValue(state));
  const tolerance = BigInt(dec(state.quantity).abs().div(2).ceil().toFixed(0)) + 1n;
  const diff = stored - expected;
  return diff > tolerance || diff < -tolerance ? diff : 0n;
}

/** The carrying value new movements are measured against (rule 5). */
export function carryingBasis(state: FungibleStockState): RialText {
  if (state.totalValue == null) return averageBasedValue(state);
  if (carryingDrift(state) !== 0n) return averageBasedValue(state);
  return rialText(state.totalValue);
}

export interface ReliefPlan {
  /** Value leaving the shelf — post exactly this as COGS / inventory credit. */
  value: RialText;
  nextQuantity: string;
  nextTotal: RialText;
}

/**
 * Plans relieving `quantity` units. `forcedValue` relieves a known exact
 * value instead of the proportional share (used to reverse a movement that
 * originally entered at that value, e.g. undoing a count surplus).
 */
export function planFungibleRelief(
  state: FungibleStockState,
  quantity: string,
  options: { forcedValue?: string; requireCost?: boolean } = {},
): ReliefPlan {
  const take = dec(quantity);
  const onHand = dec(state.quantity);
  if (!take.isFinite() || take.isNegative()) throw new ItemStockValuationError("invalid_quantity");
  if (take.gt(onHand)) throw new ItemStockValuationError("insufficient");
  if ((options.requireCost ?? true) && state.unitCost == null && state.totalValue == null && take.gt(0)) {
    throw new ItemStockValuationError("cost_missing");
  }
  const basis = dec(carryingBasis(state));
  const stored = state.totalValue == null ? basis : dec(state.totalValue);
  let value: Decimal;
  if (options.forcedValue != null) {
    // Never relieve more than is carried — the row cannot go negative.
    value = Decimal.min(dec(options.forcedValue), stored);
  } else if (take.isZero()) {
    value = new Decimal(0);
  } else if (take.eq(onHand)) {
    value = basis;
  } else {
    value = new Decimal(roundRial(basis.times(take).div(onHand)));
  }
  const nextTotal = Decimal.max(stored.minus(value), 0);
  return {
    value: roundRial(value),
    nextQuantity: onHand.minus(take).toFixed(),
    nextTotal: roundRial(nextTotal),
  };
}

export interface RestorePlan {
  nextQuantity: string;
  nextTotal: RialText;
  /** New moving average; unchanged when nothing comes back on hand. */
  nextUnitCost: string | null;
}

/** Plans putting `quantity` units back at the exact `value` they left with. */
export function planFungibleRestore(state: FungibleStockState, quantity: string, value: string): RestorePlan {
  const back = dec(quantity);
  const amount = dec(value);
  if (!back.isFinite() || back.isNegative() || !amount.isFinite() || amount.isNegative()) {
    throw new ItemStockValuationError("invalid_quantity");
  }
  const onHand = Decimal.max(dec(state.quantity), 0);
  const basis = dec(carryingBasis(state));
  const stored = state.totalValue == null ? basis : dec(state.totalValue);
  const nextQuantity = onHand.plus(back);
  const nextTotal = stored.plus(amount);
  if (BigInt(nextTotal.toFixed(0)) > MAX_RIAL) throw new ItemStockValuationError("value_out_of_range");
  let nextUnitCost = state.unitCost;
  if (back.gt(0) && nextQuantity.gt(0)) {
    // Units on hand with no cost basis at all (a legacy uncosted row) must
    // not dilute the incoming cost: the incoming units set the average, as
    // `nextAverageUnitCost` always did.
    const uncosted = state.unitCost == null && basis.isZero();
    nextUnitCost = uncosted || onHand.isZero()
      ? roundRial(amount.div(back))
      : roundRial(basis.plus(amount).div(nextQuantity));
  }
  return { nextQuantity: nextQuantity.toFixed(), nextTotal: roundRial(nextTotal), nextUnitCost };
}

async function lockRow(client: PoolClient, itemId: string): Promise<FungibleStockState | null> {
  const { rows } = await client.query<{ quantity: string; unit_cost: string | null; total_value_rial: string | null }>(
    `SELECT quantity::text, unit_cost::text, total_value_rial::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  if (!rows[0]) return null;
  return { quantity: rows[0].quantity, unitCost: rows[0].unit_cost, totalValue: rows[0].total_value_rial };
}

/** Locks and returns the stock row (null when the item has none yet). */
export async function lockFungibleStock(client: PoolClient, itemId: string): Promise<FungibleStockState | null> {
  return lockRow(client, itemId);
}

/**
 * Relieves fungible stock and returns the exact value that left. The caller
 * posts that value; it must not compute its own `qty × unit_cost`.
 */
export async function relieveFungibleStock(
  client: PoolClient,
  input: {
    itemId: string;
    quantity: string;
    /** Stamp `last_sold_at` (a sale), not for transfers/write-offs. */
    markSold?: boolean;
    /** Relieve this exact value instead of the proportional share. */
    forcedValue?: string;
    /** Allow relieving a row with no cost basis (relieves 0 value). */
    allowMissingCost?: boolean;
  },
): Promise<{ value: RialText; unitCost: string | null; before: FungibleStockState }> {
  const state = await lockRow(client, input.itemId);
  if (!state) throw new ItemStockValuationError("stock_missing");
  const plan = planFungibleRelief(state, input.quantity, {
    forcedValue: input.forcedValue,
    requireCost: !input.allowMissingCost,
  });
  const updated = await client.query(
    `UPDATE item_stock
        SET quantity = quantity - $2::numeric,
            total_value_rial = $3::bigint,
            ${input.markSold ? "last_sold_at = now()," : ""}
            updated_at = now()
      WHERE item_id = $1 AND quantity >= $2::numeric`,
    [input.itemId, dec(input.quantity).toFixed(), plan.nextTotal],
  );
  if (updated.rowCount !== 1) throw new ItemStockValuationError("insufficient");
  return { value: plan.value, unitCost: state.unitCost, before: state };
}

/**
 * Relieves value only, leaving quantity alone — for a sale whose quantity a
 * remote stock snapshot already took off the shelf (no value left then).
 */
export async function relieveFungibleValueOnly(
  client: PoolClient,
  input: { itemId: string; value: string },
): Promise<void> {
  const state = await lockRow(client, input.itemId);
  if (!state) return;
  const stored = state.totalValue == null ? dec(carryingBasis(state)) : dec(state.totalValue);
  const nextTotal = Decimal.max(stored.minus(dec(input.value)), 0);
  await client.query(`UPDATE item_stock SET total_value_rial = $2::bigint, updated_at = now() WHERE item_id = $1`, [
    input.itemId,
    roundRial(nextTotal),
  ]);
}

/**
 * Puts units back at the exact value they left with (customer return, void,
 * order reversal, transfer cancellation, supplier-return reversal). Creates
 * the row when it does not exist yet.
 */
export async function restoreFungibleStock(
  client: PoolClient,
  input: {
    itemId: string;
    quantity: string;
    value: string;
    /**
     * When `value` is zero because the original movement left no posted
     * value to mirror (a legacy line), restore at the current average
     * instead — which leaves the average unchanged rather than diluting it.
     */
    fallbackToAverage?: boolean;
  },
): Promise<void> {
  const state = (await lockRow(client, input.itemId)) ?? { quantity: "0", unitCost: null, totalValue: "0" };
  let value = input.value;
  if (input.fallbackToAverage && dec(value).isZero() && state.unitCost != null) {
    value = roundRial(dec(input.quantity).times(dec(state.unitCost)));
  }
  const plan = planFungibleRestore(state, input.quantity, value);
  await client.query(
    `INSERT INTO item_stock (item_id, quantity, unit_cost, total_value_rial)
     VALUES ($1, $2::numeric, $3::bigint, $4::bigint)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = item_stock.quantity + $5::numeric,
           unit_cost = EXCLUDED.unit_cost,
           total_value_rial = EXCLUDED.total_value_rial,
           updated_at = now()`,
    [input.itemId, plan.nextQuantity, plan.nextUnitCost, plan.nextTotal, dec(input.quantity).toFixed()],
  );
}

/**
 * The inventory value a sale line's COGS entry relieved — the exact amount a
 * void or full reversal must put back on the shelf. Reads the posted entry
 * (whether or not it has since been reversed), so it can run before or after
 * the reversal. Zero when the line has no COGS entry (legacy rows).
 */
export async function postedCogsValue(
  client: PoolClient,
  businessId: string,
  entryIds: readonly string[],
): Promise<bigint> {
  if (entryIds.length === 0) return 0n;
  const { rows } = await client.query<{ debit: string }>(
    `SELECT COALESCE(sum(l.debit), 0)::text AS debit
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.id = ANY($1::uuid[]) AND e.business_id = $2
        AND e.posting_kind ILIKE '%cogs%' AND e.reverses_entry_id IS NULL`,
    [entryIds, businessId],
  );
  return BigInt(rows[0]?.debit ?? "0");
}
