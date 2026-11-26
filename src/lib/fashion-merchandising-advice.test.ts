// GH #1567 Phase 6E — the advisory planner's rules, thresholds and provenance.
import { describe, expect, it } from "vitest";
import { ADVICE_RULES, ADVISORY_NOTICE, buildAdvice, confidenceFor, windowDays, type VariantFact } from "./fashion-merchandising-advice";

const WINDOW = { from: "2026-09-01", to: "2026-10-26" }; // 56 days = 8 weeks
const AT = "2026-10-26T12:00:00.000Z";

const fact = (over: Partial<VariantFact> & { itemId: string }): VariantFact => ({
  styleId: "style", styleName: "مانتو", variantLabel: over.itemId, soldUnits: 0, onHand: 0, unitCostRial: 100_000, ...over,
});

describe("fashion merchandising advice", () => {
  it("counts the window inclusively and grades confidence by sample size", () => {
    expect(windowDays(WINDOW.from, WINDOW.to)).toBe(56);
    expect(windowDays("2026-10-26", "2026-10-26")).toBe(1);
    expect(confidenceFor(12)).toBe("high");
    expect(confidenceFor(4)).toBe("medium");
    expect(confidenceFor(3)).toBe("low");
  });

  it("reorders a fast seller up to the target cover, with the formula shown", () => {
    // 16 sold in 8 weeks → 2/week; 4 on hand → 2 weeks cover (< 3) → ceil(2×8 − 4) = 12.
    const report = buildAdvice([fact({ itemId: "m", soldUnits: 16, onHand: 4 })], WINDOW, { generatedAt: AT });
    expect(report.rows).toHaveLength(1);
    const [row] = report.rows;
    expect(row).toMatchObject({ kind: "reorder", suggestedQuantity: 12, confidence: "high" });
    expect(row.metrics).toMatchObject({ soldUnits: 16, windowDays: 56, onHand: 4, velocityPerWeek: 2, coverWeeks: 2 });
    expect(row.provenance.formula).toContain("ceil(2 × 8 − 4)");
    expect(row.reason).toContain("۱۲");
  });

  it("flags overstock and never suggests buying it", () => {
    // 2 sold in 8 weeks → 0.25/week; 30 on hand → 120 weeks.
    const [row] = buildAdvice([fact({ itemId: "xl", soldUnits: 2, onHand: 30 })], WINDOW, { generatedAt: AT }).rows;
    expect(row).toMatchObject({ kind: "overstock", suggestedQuantity: null, confidence: "low" });
    expect(row.metrics.coverWeeks).toBe(120);
  });

  it("suggests a markdown review for unsold stock over a long enough window, with the value tied up", () => {
    const [row] = buildAdvice([fact({ itemId: "s", onHand: 6, unitCostRial: 250_000 })], WINDOW, { generatedAt: AT }).rows;
    expect(row).toMatchObject({ kind: "markdown_review", suggestedQuantity: null, confidence: "medium" });
    expect(row.metrics.valueAtCostRial).toBe(1_500_000);
    // A short window is not evidence of a dead line.
    expect(buildAdvice([fact({ itemId: "s", onHand: 6 })], { from: "2026-10-20", to: "2026-10-26" }, { generatedAt: AT }).rows).toEqual([]);
  });

  it("fills a broken size run from the selling style with an equal share", () => {
    const facts = [
      fact({ itemId: "m", soldUnits: 6, onHand: 20 }),
      fact({ itemId: "l", soldUnits: 2, onHand: 20 }),
      fact({ itemId: "s", soldUnits: 0, onHand: 0 }),
    ];
    const rows = buildAdvice(facts, WINDOW, { generatedAt: AT }).rows;
    const gap = rows.find((r) => r.kind === "size_gap")!;
    // style 8 units / 8 weeks = 1/week × 8 weeks × ⅓ = 2.67 → 3.
    expect(gap).toMatchObject({ itemId: "s", suggestedQuantity: 3, confidence: "medium" });
    expect(gap.metrics).toMatchObject({ styleSoldUnits: 8, sizeShare: 0.33 });
    // A style that barely sells does not justify filling the gap.
    const quiet = [fact({ itemId: "m", soldUnits: 3, onHand: 1 }), fact({ itemId: "s" })];
    expect(buildAdvice(quiet, WINDOW, { generatedAt: AT }).rows.some((r) => r.kind === "size_gap")).toBe(false);
    // A standalone item (no style) has no size run to break.
    expect(buildAdvice([fact({ itemId: "solo", styleId: null })], WINDOW, { generatedAt: AT }).rows).toEqual([]);
  });

  it("is advisory, provenance-backed, ordered and deterministic", () => {
    const facts = [
      fact({ itemId: "dead", onHand: 9 }),
      fact({ itemId: "fast", soldUnits: 24, onHand: 1 }),
      fact({ itemId: "over", soldUnits: 1, onHand: 50 }),
      fact({ itemId: "ok", soldUnits: 8, onHand: 6 }), // 1/week, 6 weeks cover → nothing
    ];
    const a = buildAdvice(facts, WINDOW, { generatedAt: AT, excludedConsigned: 2 });
    const b = buildAdvice([...facts].reverse(), WINDOW, { generatedAt: AT, excludedConsigned: 2 });
    expect(a).toEqual(b);
    expect(a.advisory).toBe(true);
    expect(a.notice).toBe(ADVISORY_NOTICE);
    expect(a.rules).toEqual(ADVICE_RULES);
    expect(a.sources.length).toBeGreaterThan(0);
    expect(a.rows.map((r) => [r.kind, r.itemId])).toEqual([["reorder", "fast"], ["overstock", "over"], ["markdown_review", "dead"]]);
    expect(a.summary).toEqual({ reorder: 1, size_gap: 0, overstock: 1, markdown_review: 1, excludedConsigned: 2 });
    for (const row of a.rows) {
      expect(row.provenance.rule.length).toBeGreaterThan(0);
      expect(row.provenance.formula.length).toBeGreaterThan(0);
    }
    // Returns that exceed sales never produce negative velocity.
    expect(buildAdvice([fact({ itemId: "r", soldUnits: -2, onHand: 0 })], WINDOW, { generatedAt: AT }).rows).toEqual([]);
  });
});
