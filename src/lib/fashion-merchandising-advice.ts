/**
 * GH #1567 Phase 6E — advisory merchandising suggestions for a fashion shop.
 *
 * Pure and client-safe: given per-variant facts (net units sold in a window,
 * owned on hand, weighted-average cost) it says what an experienced buyer
 * would flag — reorder a fast seller, fill a broken size run, review a
 * markdown, stop buying an overstocked line — and *why*, with the exact
 * numbers, rule and formula behind every row.
 *
 * It is advice and nothing else. Nothing here (or in the service that feeds
 * it) creates a purchase, posts stock, changes a price or sends a message; the
 * payload says so in `advisory`/`notice`, and the only consumers are the
 * read-only report view and the assistant's read-only `run_report` tool.
 */

export const ADVICE_RULES = {
  /** Reorder when a selling variant has less than this many weeks of cover. */
  minCoverWeeks: 3,
  /** …up to this many weeks of cover. */
  targetCoverWeeks: 8,
  /** More cover than this is overstock. */
  overstockCoverWeeks: 26,
  /** A style must sell at least this many units in the window for a size gap to count. */
  sizeGapMinStyleUnits: 4,
  /** A no-sale variant is a markdown candidate only over at least this long a window. */
  markdownMinWindowDays: 28,
  /** Sample-size confidence thresholds (net units sold in the window). */
  highConfidenceUnits: 12,
  mediumConfidenceUnits: 4,
} as const;

export const ADVICE_SOURCES = [
  "domain_events: fashion_apparel.sale_revenue (POS sales)",
  "online_sale_lines (storefront/marketplace sales)",
  "sale_return_facts (customer returns, subtracted)",
  "item_stock (owned on hand and weighted-average cost)",
] as const;

export const ADVISORY_NOTICE =
  "این فهرست فقط پیشنهاد است: هیچ خرید، ثبت انبار، تغییر قیمت یا پیامی به‌طور خودکار انجام نمی‌شود و تصمیم با شماست.";

export interface VariantFact {
  itemId: string;
  styleId: string | null;
  styleName: string;
  /** e.g. "مشکی / M" — the variant's attribute values. */
  variantLabel: string;
  /** Net units sold in the window (sales − returns). */
  soldUnits: number;
  /** Owned units on hand now. */
  onHand: number;
  /** Weighted-average cost per unit, Rial; null before the first receipt. */
  unitCostRial: number | null;
}

export type AdviceKind = "reorder" | "size_gap" | "markdown_review" | "overstock";
export type AdviceConfidence = "high" | "medium" | "low";

export interface AdviceRow {
  kind: AdviceKind;
  itemId: string;
  styleId: string | null;
  styleName: string;
  variantLabel: string;
  /** Units to buy (reorder / size gap); null when the advice is not a purchase. */
  suggestedQuantity: number | null;
  confidence: AdviceConfidence;
  /** One Persian sentence a buyer can act on, with the numbers in it. */
  reason: string;
  metrics: {
    soldUnits: number;
    windowDays: number;
    onHand: number;
    /** Units per week, two decimals. */
    velocityPerWeek: number;
    /** Weeks the current stock lasts at that velocity; null when nothing sells. */
    coverWeeks: number | null;
    unitCostRial: number | null;
    valueAtCostRial: number | null;
    /** Size gap only: this size's share of the style's sales used for the quantity. */
    sizeShare?: number;
    styleSoldUnits?: number;
  };
  provenance: { rule: string; formula: string };
}

export interface AdviceReport {
  advisory: true;
  notice: string;
  window: { from: string; to: string; days: number };
  generatedAt: string;
  rules: typeof ADVICE_RULES;
  sources: readonly string[];
  rows: AdviceRow[];
  summary: Record<AdviceKind, number> & { excludedConsigned: number };
  totalCount: number;
}

const KIND_ORDER: Record<AdviceKind, number> = { reorder: 0, size_gap: 1, overstock: 2, markdown_review: 3 };
const CONFIDENCE_ORDER: Record<AdviceConfidence, number> = { high: 0, medium: 1, low: 2 };

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const fa = (n: number | string) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

export function confidenceFor(units: number): AdviceConfidence {
  if (units >= ADVICE_RULES.highConfidenceUnits) return "high";
  if (units >= ADVICE_RULES.mediumConfidenceUnits) return "medium";
  return "low";
}

/** Inclusive day count between two ISO dates; at least 1. */
export function windowDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

export function buildAdvice(
  facts: VariantFact[],
  window: { from: string; to: string },
  options: { generatedAt: string; excludedConsigned?: number },
): AdviceReport {
  const days = windowDays(window.from, window.to);
  const rows: AdviceRow[] = [];

  const byStyle = new Map<string, VariantFact[]>();
  for (const f of facts) {
    const key = f.styleId ?? f.itemId;
    byStyle.set(key, [...(byStyle.get(key) ?? []), f]);
  }

  for (const f of facts) {
    const sold = Math.max(0, f.soldUnits);
    const onHand = Math.max(0, f.onHand);
    const velocity = (sold / days) * 7;
    const cover = velocity > 0 ? onHand / velocity : null;
    const value = f.unitCostRial == null ? null : Math.round(onHand * f.unitCostRial);
    const metrics: AdviceRow["metrics"] = {
      soldUnits: sold, windowDays: days, onHand, velocityPerWeek: round2(velocity),
      coverWeeks: cover == null ? null : round1(cover), unitCostRial: f.unitCostRial, valueAtCostRial: value,
    };
    const base = { itemId: f.itemId, styleId: f.styleId, styleName: f.styleName, variantLabel: f.variantLabel };

    if (velocity > 0 && cover! < ADVICE_RULES.minCoverWeeks) {
      const qty = Math.max(1, Math.ceil(velocity * ADVICE_RULES.targetCoverWeeks - onHand));
      rows.push({
        ...base, kind: "reorder", suggestedQuantity: qty, confidence: confidenceFor(sold), metrics,
        reason: `در ${fa(days)} روز ${fa(sold)} عدد فروخته و موجودی فقط ${fa(round1(cover!))} هفته کفاف می‌دهد؛ حدود ${fa(qty)} عدد سفارش دهید تا ${fa(ADVICE_RULES.targetCoverWeeks)} هفته پوشش داشته باشید.`,
        provenance: {
          rule: `reorder: velocity > 0 and cover < ${ADVICE_RULES.minCoverWeeks} weeks`,
          formula: `max(1, ceil(velocity/week × ${ADVICE_RULES.targetCoverWeeks} − onHand)) = ceil(${round2(velocity)} × ${ADVICE_RULES.targetCoverWeeks} − ${onHand})`,
        },
      });
      continue;
    }

    if (velocity > 0 && cover! > ADVICE_RULES.overstockCoverWeeks) {
      rows.push({
        ...base, kind: "overstock", suggestedQuantity: null, confidence: confidenceFor(sold), metrics,
        reason: `موجودی ${fa(onHand)} عدد با این سرعت فروش ${fa(round1(cover!))} هفته کفاف می‌دهد؛ خرید تازه را نگه دارید یا انتقال به شعبهٔ دیگر را بررسی کنید.`,
        provenance: { rule: `overstock: cover > ${ADVICE_RULES.overstockCoverWeeks} weeks`, formula: `cover = onHand ÷ velocity/week = ${onHand} ÷ ${round2(velocity)}` },
      });
      continue;
    }

    if (sold === 0 && onHand > 0 && days >= ADVICE_RULES.markdownMinWindowDays) {
      rows.push({
        ...base, kind: "markdown_review", suggestedQuantity: null, confidence: onHand >= ADVICE_RULES.mediumConfidenceUnits ? "medium" : "low", metrics,
        reason: `در ${fa(days)} روز فروشی نداشته و ${fa(onHand)} عدد در انبار مانده${value != null ? ` (به بهای تمام‌شده ${fa(value.toLocaleString("en-US"))} ریال)` : ""}؛ تخفیف یا جابه‌جایی چیدمان را بررسی کنید.`,
        provenance: { rule: `markdown_review: no net sales in a window ≥ ${ADVICE_RULES.markdownMinWindowDays} days and onHand > 0`, formula: `valueAtCost = onHand × WAC = ${onHand} × ${f.unitCostRial ?? "—"}` },
      });
      continue;
    }

    if (sold === 0 && onHand === 0 && f.styleId) {
      const siblings = byStyle.get(f.styleId) ?? [];
      const styleSold = siblings.reduce((sum, s) => sum + Math.max(0, s.soldUnits), 0);
      if (styleSold >= ADVICE_RULES.sizeGapMinStyleUnits) {
        // A size that was not on the shelf could not sell, so its own share is
        // unknown: give it an equal share of the style rather than zero.
        const share = 1 / siblings.length;
        const styleVelocity = (styleSold / days) * 7;
        const qty = Math.max(1, Math.round(styleVelocity * ADVICE_RULES.targetCoverWeeks * share));
        rows.push({
          ...base, kind: "size_gap", suggestedQuantity: qty, confidence: confidenceFor(styleSold),
          metrics: { ...metrics, sizeShare: round2(share), styleSoldUnits: styleSold },
          reason: `این سایز/رنگ تمام شده در حالی که مدل «${f.styleName}» در ${fa(days)} روز ${fa(styleSold)} عدد فروخته است؛ با سهم برابر از منحنی سایز حدود ${fa(qty)} عدد برای تکمیل سری سایز سفارش دهید.`,
          provenance: {
            rule: `size_gap: onHand = 0, no sales, style sold ≥ ${ADVICE_RULES.sizeGapMinStyleUnits} units`,
            formula: `max(1, round(styleVelocity/week × ${ADVICE_RULES.targetCoverWeeks} × share)) = round(${round2(styleVelocity)} × ${ADVICE_RULES.targetCoverWeeks} × ${round2(share)})`,
          },
        });
      }
    }
  }

  rows.sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
    || (b.suggestedQuantity ?? 0) - (a.suggestedQuantity ?? 0)
    || (b.metrics.valueAtCostRial ?? 0) - (a.metrics.valueAtCostRial ?? 0)
    || a.styleName.localeCompare(b.styleName, "fa")
    || a.variantLabel.localeCompare(b.variantLabel, "fa")
    || a.itemId.localeCompare(b.itemId));

  const summary = { reorder: 0, size_gap: 0, markdown_review: 0, overstock: 0, excludedConsigned: options.excludedConsigned ?? 0 };
  for (const row of rows) summary[row.kind] += 1;

  return {
    advisory: true,
    notice: ADVISORY_NOTICE,
    window: { from: window.from, to: window.to, days },
    generatedAt: options.generatedAt,
    rules: ADVICE_RULES,
    sources: ADVICE_SOURCES,
    rows,
    summary,
    totalCount: rows.length,
  };
}
