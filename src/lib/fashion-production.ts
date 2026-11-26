/**
 * GH #1567 Phase 6B — the pure rules of a fashion production order
 * (cut → sew → finish → QC → pack). No database, no I/O: the service applies
 * these inside its transaction and the tests pin them directly.
 *
 * Quantities are decimal strings (numeric(24,9) in the database); money is
 * whole Rial as bigint. Decimal.js keeps the arithmetic exact.
 *
 * Stage model. Units flow through the stages in order. Stage s receives what
 * the previous stage completed (stage 1 receives the planned quantity); of
 * what it received it may complete some and scrap some, never more than it
 * received. A rework sends units waiting at a later stage back to an earlier
 * one: the completed counts of the stages in between drop by that quantity,
 * so the units are done again. Finished units are what the LAST stage
 * completed; receipts into stock draw on those.
 *
 * Costing. The order's work in progress (WIP) is everything issued into it
 * (materials at the exact WAC value relieved, conversion costs absorbed)
 * less what has left it (receipts, returned materials, write-off). A receipt
 * takes WIP × qty / outstanding-good-units; the receipt that leaves no
 * outstanding units takes the remainder, so WIP closes at exactly zero.
 * Normal scrap therefore stays in the cost of the good units — the standard
 * treatment of normal spoilage — and per-unit cost = received value / qty.
 */
import Decimal from "decimal.js";

export const PRODUCTION_ORDER_STATUSES = ["draft", "released", "in_progress", "completed", "cancelled"] as const;
export type ProductionOrderStatus = (typeof PRODUCTION_ORDER_STATUSES)[number];

export const PRODUCTION_COST_KINDS = ["labour", "subcontract", "overhead", "standard"] as const;
export type ProductionCostKind = (typeof PRODUCTION_COST_KINDS)[number];

export interface StageDefinition {
  code: string;
  label: string;
}

/** The garment workshop's usual line; a business may rename, drop or add stages per order. */
export const DEFAULT_FASHION_STAGES: readonly StageDefinition[] = [
  { code: "cut", label: "برش" },
  { code: "sew", label: "دوخت" },
  { code: "finish", label: "تکمیل و اتو" },
  { code: "qc", label: "کنترل کیفیت" },
  { code: "pack", label: "بسته‌بندی" },
];

export class ProductionRuleError extends Error {
  constructor(public readonly code: string, public readonly detail?: Record<string, unknown>) {
    super(code);
    this.name = "ProductionRuleError";
  }
}

const STAGE_CODE = /^[a-z][a-z0-9_]{0,29}$/;

/** Validates a stage list (1–12 stages, unique codes, non-empty labels). */
export function normaliseStages(stages: readonly StageDefinition[] | null | undefined): StageDefinition[] {
  const list = (stages && stages.length > 0 ? stages : DEFAULT_FASHION_STAGES).map((s) => ({
    code: s.code.trim(),
    label: s.label.trim(),
  }));
  if (list.length > 12) throw new ProductionRuleError("too_many_stages");
  const seen = new Set<string>();
  for (const stage of list) {
    if (!STAGE_CODE.test(stage.code)) throw new ProductionRuleError("invalid_stage_code", { code: stage.code });
    if (stage.label.length < 1 || stage.label.length > 60) throw new ProductionRuleError("invalid_stage_label", { code: stage.code });
    if (seen.has(stage.code)) throw new ProductionRuleError("duplicate_stage", { code: stage.code });
    seen.add(stage.code);
  }
  return list;
}

function dec(value: string | number | Decimal): Decimal {
  return new Decimal(value);
}

/** A positive quantity with at most 9 decimals, as canonical text. */
export function positiveQuantity(value: string | number): string {
  let d: Decimal;
  try {
    d = dec(value);
  } catch {
    throw new ProductionRuleError("invalid_quantity");
  }
  if (!d.isFinite() || d.lte(0) || d.decimalPlaces() > 9 || d.gt("1e12")) throw new ProductionRuleError("invalid_quantity");
  return d.toFixed();
}

/** Material needed for `planned` finished units, rounded up to the 9th decimal. */
export function requiredQuantity(perUnit: string, planned: string): string {
  return dec(perUnit).times(dec(planned)).toDecimalPlaces(9, Decimal.ROUND_UP).toFixed();
}

export interface StageState {
  seq: number;
  code: string;
  completed: string;
  scrapped: string;
}

/** Units the stage has received (stage 1: the plan; later: what the previous stage completed). */
export function stageInflow(stages: readonly StageState[], index: number, planned: string): Decimal {
  return index === 0 ? dec(planned) : dec(stages[index - 1].completed);
}

/** Units sitting at a stage, received but neither completed nor scrapped. */
export function stageWaiting(stages: readonly StageState[], index: number, planned: string): Decimal {
  return stageInflow(stages, index, planned).minus(dec(stages[index].completed)).minus(dec(stages[index].scrapped));
}

/**
 * Applies a progress report (units completed and/or scrapped at one stage)
 * and returns the new stage list. Refuses anything that would complete or
 * scrap more than the stage has waiting.
 */
export function applyProgress(
  stages: readonly StageState[],
  planned: string,
  code: string,
  delta: { completed?: string; scrapped?: string },
): StageState[] {
  const index = stages.findIndex((s) => s.code === code);
  if (index < 0) throw new ProductionRuleError("stage_not_found", { code });
  const completed = dec(delta.completed ?? "0");
  const scrapped = dec(delta.scrapped ?? "0");
  if (completed.lt(0) || scrapped.lt(0) || (completed.isZero() && scrapped.isZero())) {
    throw new ProductionRuleError("invalid_quantity");
  }
  const waiting = stageWaiting(stages, index, planned);
  if (completed.plus(scrapped).gt(waiting)) {
    throw new ProductionRuleError("stage_quantity_exceeded", { code, waiting: waiting.toFixed() });
  }
  return stages.map((s, i) => i === index
    ? { ...s, completed: dec(s.completed).plus(completed).toFixed(), scrapped: dec(s.scrapped).plus(scrapped).toFixed() }
    : s);
}

/**
 * Sends `quantity` units waiting at stage `fromCode` back to stage `toCode`
 * (an earlier stage): every stage from `toCode` up to, but not including,
 * `fromCode` loses that many completed units, so they are done again.
 */
export function applyRework(
  stages: readonly StageState[],
  planned: string,
  fromCode: string,
  toCode: string,
  quantity: string,
): StageState[] {
  const from = stages.findIndex((s) => s.code === fromCode);
  const to = stages.findIndex((s) => s.code === toCode);
  if (from < 0 || to < 0) throw new ProductionRuleError("stage_not_found");
  if (to >= from) throw new ProductionRuleError("rework_must_go_back");
  const qty = dec(positiveQuantity(quantity));
  const waiting = stageWaiting(stages, from, planned);
  if (qty.gt(waiting)) throw new ProductionRuleError("rework_quantity_exceeded", { waiting: waiting.toFixed() });
  return stages.map((s, i) => (i >= to && i < from ? { ...s, completed: dec(s.completed).minus(qty).toFixed() } : s));
}

export function totalScrapped(stages: readonly StageState[]): string {
  return stages.reduce((sum, s) => sum.plus(dec(s.scrapped)), dec(0)).toFixed();
}

/** Finished units ready to receipt: what the last stage completed less what was already receipted. */
export function receivableQuantity(stages: readonly StageState[], received: string): string {
  if (stages.length === 0) return "0";
  return Decimal.max(dec(stages[stages.length - 1].completed).minus(dec(received)), 0).toFixed();
}

/** Good units still expected from the order: planned − scrapped − received. */
export function outstandingUnits(planned: string, scrapped: string, received: string): string {
  return Decimal.max(dec(planned).minus(dec(scrapped)).minus(dec(received)), 0).toFixed();
}

export interface WipState {
  materialCost: bigint;
  conversionCost: bigint;
  receivedValue: bigint;
  returnedValue: bigint;
  writtenOff: bigint;
}

export function wipBalance(w: WipState): bigint {
  return w.materialCost + w.conversionCost - w.receivedValue - w.returnedValue - w.writtenOff;
}

/**
 * The value a receipt of `quantity` finished units takes out of WIP. The
 * receipt that leaves no outstanding units takes all of it (the remainder),
 * so WIP closes at exactly zero and normal scrap lands in the good units.
 */
export function receiptValue(wip: bigint, quantity: string, outstandingBefore: string): bigint {
  const qty = dec(quantity);
  const outstanding = dec(outstandingBefore);
  if (qty.lte(0) || qty.gt(outstanding)) throw new ProductionRuleError("receipt_exceeds_outstanding");
  if (wip <= 0n) return 0n;
  if (qty.eq(outstanding)) return wip;
  return BigInt(dec(wip.toString()).times(qty).div(outstanding).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed());
}

/**
 * The value `quantity` returned units of a material take back to stock — at
 * what they were issued at, never today's average. The return that brings the
 * line back to zero net issue takes the remainder.
 */
export function materialReturnValue(
  line: { issuedQuantity: string; issuedValue: bigint; returnedQuantity: string; returnedValue: bigint },
  quantity: string,
): bigint {
  const qty = dec(quantity);
  const netQty = dec(line.issuedQuantity).minus(dec(line.returnedQuantity));
  const netValue = line.issuedValue - line.returnedValue;
  if (qty.lte(0) || qty.gt(netQty)) throw new ProductionRuleError("return_exceeds_issued");
  if (qty.eq(netQty)) return netValue;
  return BigInt(dec(line.issuedValue.toString()).times(qty).div(dec(line.issuedQuantity))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed());
}

export interface MaterialNeed {
  materialItemId: string;
  name: string;
  /** Still to issue for this order. */
  need: string;
  onHand: string;
  /** Held by other open orders (their unissued requirement). */
  reservedElsewhere: string;
}

export interface Shortage {
  materialItemId: string;
  name: string;
  need: string;
  available: string;
  missing: string;
}

/** Materials whose free stock (on hand − other orders' reservations) cannot cover this order's need. */
export function shortages(needs: readonly MaterialNeed[]): Shortage[] {
  const out: Shortage[] = [];
  for (const n of needs) {
    const available = Decimal.max(dec(n.onHand).minus(dec(n.reservedElsewhere)), 0);
    if (dec(n.need).gt(available)) {
      out.push({
        materialItemId: n.materialItemId,
        name: n.name,
        need: n.need,
        available: available.toFixed(),
        missing: dec(n.need).minus(available).toFixed(),
      });
    }
  }
  return out;
}

/**
 * Finished units cannot outrun the material actually issued: for every BOM
 * line, net issued ≥ quantity per unit × units received after this receipt.
 */
export function materialCoversReceipt(
  lines: readonly { materialItemId: string; quantityPerUnit: string; issuedQuantity: string; returnedQuantity: string }[],
  receivedAfter: string,
): { materialItemId: string; missing: string } | null {
  for (const line of lines) {
    const net = dec(line.issuedQuantity).minus(dec(line.returnedQuantity));
    const needed = dec(line.quantityPerUnit).times(dec(receivedAfter));
    if (net.lt(needed.toDecimalPlaces(9, Decimal.ROUND_DOWN))) {
      return { materialItemId: line.materialItemId, missing: needed.minus(net).toFixed() };
    }
  }
  return null;
}

const ALLOWED: Record<ProductionOrderStatus, readonly string[]> = {
  draft: ["release", "cancel", "assign"],
  released: ["issue", "assign", "cost", "cancel"],
  in_progress: ["issue", "return", "progress", "scrap", "rework", "assign", "cost", "receive", "complete", "cancel"],
  completed: [],
  cancelled: [],
};

export function actionAllowed(status: ProductionOrderStatus, action: string): boolean {
  return ALLOWED[status].includes(action);
}

/** Per-unit cost of what was receipted (Rial, 2 decimals) — the report figure. */
export function unitCost(receivedValue: bigint, receivedQuantity: string): string | null {
  const qty = dec(receivedQuantity);
  if (qty.lte(0)) return null;
  return dec(receivedValue.toString()).div(qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed();
}
