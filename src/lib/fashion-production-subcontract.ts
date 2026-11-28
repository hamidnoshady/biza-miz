/**
 * GH #1567 Phase 6.3 — the pure rules of a subcontracted production stage.
 * No database, no I/O; the production service applies them inside its
 * transaction and the tests pin them directly.
 *
 * Model. A subcontract sends units waiting at ONE stage of a production order
 * to a canonical supplier. Those units are "held" by the subcontractor:
 *
 *   held = sent − accepted − scrapped − shortage
 *
 * When work comes back it is inspected. Each inspected unit is exactly one of:
 *   accepted  → the stage completes it (it moves on to the next stage) and the
 *               agreed rate is charged;
 *   rework    → rejected and handed straight back to the subcontractor to
 *               redo; it stays held and is charged only once it is accepted;
 *   scrapped  → rejected and unusable; the stage scraps it, nothing charged;
 *   shortage  → not returned at all; the stage scraps it, nothing charged,
 *               and the material that went with it is recorded as lost.
 *
 * Material custody. Fabric the subcontractor needs is issued into the order's
 * WIP like any issue and recorded as held in custody. Accepted and scrapped
 * units consume their bill-of-materials share; shortage units lose it.
 * Custody that is still held must come back (a material return) or be
 * declared lost before the subcontract can close.
 */
import Decimal from "decimal.js";
import { ProductionRuleError } from "./fashion-production";

export const SUBCONTRACT_STATUSES = ["draft", "approved", "disputed", "closed", "cancelled"] as const;
export type SubcontractStatus = (typeof SUBCONTRACT_STATUSES)[number];

export const SUBCONTRACT_ACTIONS = [
  "subcontract_create", "subcontract_approve", "subcontract_send", "subcontract_receive",
  "subcontract_return_materials", "subcontract_dispute", "subcontract_resolve", "subcontract_close", "subcontract_cancel",
] as const;
export type SubcontractAction = (typeof SUBCONTRACT_ACTIONS)[number];

const ALLOWED: Record<SubcontractStatus, readonly SubcontractAction[]> = {
  draft: ["subcontract_approve", "subcontract_cancel"],
  approved: ["subcontract_send", "subcontract_receive", "subcontract_return_materials", "subcontract_dispute",
    "subcontract_close", "subcontract_cancel"],
  // A dispute freezes new work going out and the close, but goods and
  // material may still come back while it is talked through.
  disputed: ["subcontract_receive", "subcontract_return_materials", "subcontract_resolve"],
  closed: [],
  cancelled: [],
};

export function subcontractActionAllowed(status: SubcontractStatus, action: SubcontractAction): boolean {
  return ALLOWED[status].includes(action);
}

export function isSubcontractAction(action: string): action is SubcontractAction {
  return (SUBCONTRACT_ACTIONS as readonly string[]).includes(action);
}

function dec(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

export interface SubcontractUnits {
  sent: string;
  accepted: string;
  scrapped: string;
  shortage: string;
}

/** Units currently with the subcontractor. */
export function subcontractHeld(units: SubcontractUnits): string {
  return dec(units.sent).minus(units.accepted).minus(units.scrapped).minus(units.shortage).toFixed();
}

/** Units at a stage held by its open subcontracts (in-house work may not touch them). */
export function heldAtStage(subcontracts: readonly (SubcontractUnits & { stageCode: string; status: SubcontractStatus })[], stageCode: string): string {
  return subcontracts
    .filter((s) => s.stageCode === stageCode && (s.status === "approved" || s.status === "disputed"))
    .reduce((sum, s) => sum.plus(subcontractHeld(s)), dec(0))
    .toFixed();
}

export interface InspectionInput {
  accepted?: string | null;
  rework?: string | null;
  scrapped?: string | null;
  shortage?: string | null;
}

export interface Inspection {
  accepted: string;
  rework: string;
  scrapped: string;
  shortage: string;
}

function nonNegative(value: string | null | undefined): Decimal {
  if (value == null || value === "") return dec(0);
  let d: Decimal;
  try {
    d = dec(value);
  } catch {
    throw new ProductionRuleError("invalid_quantity");
  }
  if (!d.isFinite() || d.lt(0) || d.decimalPlaces() > 9 || d.gt("1e12")) throw new ProductionRuleError("invalid_quantity");
  return d;
}

/**
 * Validates one inspection of returned work against what the subcontractor
 * holds. Every inspected unit is counted once, so the four parts together may
 * not exceed `held`.
 */
export function inspectReceipt(units: SubcontractUnits, input: InspectionInput): Inspection {
  const accepted = nonNegative(input.accepted);
  const rework = nonNegative(input.rework);
  const scrapped = nonNegative(input.scrapped);
  const shortage = nonNegative(input.shortage);
  const total = accepted.plus(rework).plus(scrapped).plus(shortage);
  if (total.isZero()) throw new ProductionRuleError("invalid_quantity");
  const held = dec(subcontractHeld(units));
  if (total.gt(held)) throw new ProductionRuleError("subcontract_quantity_exceeded", { held: held.toFixed() });
  return { accepted: accepted.toFixed(), rework: rework.toFixed(), scrapped: scrapped.toFixed(), shortage: shortage.toFixed() };
}

/** The subcontractor's charge for `accepted` units at `rate` Rial per unit (half-up to whole Rial). */
export function subcontractCharge(rate: bigint, accepted: string): bigint {
  if (rate < 0n) throw new ProductionRuleError("invalid_amount");
  const qty = dec(accepted);
  if (qty.lte(0) || rate === 0n) return 0n;
  return BigInt(dec(rate.toString()).times(qty).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed());
}

export interface CustodyLine {
  materialItemId: string;
  quantityPerUnit: string;
  sent: string;
  returned: string;
  consumed: string;
  lost: string;
}

/** Material the subcontractor still holds on one custody line. */
export function custodyBalance(line: Pick<CustodyLine, "sent" | "returned" | "consumed" | "lost">): string {
  return dec(line.sent).minus(line.returned).minus(line.consumed).minus(line.lost).toFixed();
}

/**
 * What an inspection does to custody: accepted + scrapped units consume their
 * BOM share, shortage units lose theirs. Each movement is capped at what the
 * line still holds, so a subcontractor who was sent less than the BOM share
 * (or who already returned some) never goes negative.
 */
export function custodyMovements(lines: readonly CustodyLine[], inspection: Inspection):
  { materialItemId: string; consumed: string; lost: string }[] {
  const worked = dec(inspection.accepted).plus(inspection.scrapped);
  const missing = dec(inspection.shortage);
  const out: { materialItemId: string; consumed: string; lost: string }[] = [];
  for (const line of lines) {
    let balance = dec(custodyBalance(line));
    const perUnit = dec(line.quantityPerUnit);
    const consumed = Decimal.min(perUnit.times(worked).toDecimalPlaces(9, Decimal.ROUND_HALF_UP), balance);
    balance = balance.minus(consumed);
    const lost = Decimal.min(perUnit.times(missing).toDecimalPlaces(9, Decimal.ROUND_HALF_UP), balance);
    if (consumed.gt(0) || lost.gt(0)) out.push({ materialItemId: line.materialItemId, consumed: consumed.toFixed(), lost: lost.toFixed() });
  }
  return out;
}

/** A material return out of custody may not exceed what the subcontractor holds. */
export function assertCustodyReturn(line: Pick<CustodyLine, "sent" | "returned" | "consumed" | "lost">, quantity: string): void {
  if (dec(quantity).gt(custodyBalance(line))) {
    throw new ProductionRuleError("custody_return_exceeds_held", { held: custodyBalance(line) });
  }
}

/**
 * A subcontract may close only when nothing is left with the subcontractor:
 * no held units, and every custody line returned, consumed or declared lost.
 */
export function closeBlockers(units: SubcontractUnits, lines: readonly Pick<CustodyLine, "materialItemId" | "sent" | "returned" | "consumed" | "lost">[],
  declareRemainingLost: boolean): { unitsHeld: string; custody: { materialItemId: string; held: string }[] } | null {
  const unitsHeld = subcontractHeld(units);
  const custody = declareRemainingLost
    ? []
    : lines.map((l) => ({ materialItemId: l.materialItemId, held: custodyBalance(l) })).filter((l) => dec(l.held).gt(0));
  if (dec(unitsHeld).gt(0) || custody.length > 0) return { unitsHeld, custody };
  return null;
}

/**
 * A cancellation is a clean undo only: nothing accepted or charged, and all
 * custody material back. Units still with the subcontractor are recalled —
 * they return undone to the stage they were sent from.
 */
export function cancelBlocker(state: SubcontractUnits & { accrued: bigint; custodyHeld: boolean }): string | null {
  if (dec(state.accepted).gt(0) || state.accrued > 0n) return "subcontract_has_accepted_work";
  if (state.custodyHeld) return "subcontract_custody_held";
  return null;
}
