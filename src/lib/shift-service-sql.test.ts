/**
 * The shape of the shift cash summary's SQL — the one thing about
 * `shift-service.ts` that can be checked without a database.
 *
 * `shift-service.ts` is DB-touching and therefore not unit tested (repo
 * convention; the rules it applies live in `shift.ts`). But the bug this test
 * exists to prevent was a *shape* bug, not a rule one: summing `orders.total`
 * across `orders LEFT JOIN payments` counts an order once per tender, so every
 * split-tender bill inflated the shift's gross total and its per-shift review
 * row — while `branchShiftSales`, three hundred lines above in the same file,
 * had already written the comment explaining why that join must not be summed
 * over. A structural assertion is what keeps the third copy from drifting back.
 */
import { describe, expect, it } from "vitest";
import { SHIFT_CASH_SUMMARY_SQL } from "./shift-service";

describe("SHIFT_CASH_SUMMARY_SQL", () => {
  it("never sums an order total across the payments join", () => {
    // The join exists (the per-method totals need it) but the order aggregates
    // must come from a payment-free subquery, so a bill settled in cash+card
    // contributes its total exactly once.
    const orderAggregates = SHIFT_CASH_SUMMARY_SQL.match(/sum\(\s*\w+\.total\s*\)/g) ?? [];
    expect(orderAggregates.length).toBeGreaterThan(0);
    for (const aggregate of orderAggregates) {
      // `wo` is the payment-free window subquery; `o` would be the joined row.
      expect(aggregate).toMatch(/sum\(wo\.total\)/);
    }
  });

  it("counts orders, not payment rows", () => {
    expect(SHIFT_CASH_SUMMARY_SQL).toMatch(/count\(\*\)\s+FROM \(SELECT o\.id, o\.total\s+FROM orders/);
  });

  it("keeps the per-method totals on the payment rows, where a tender is the unit", () => {
    for (const method of ["cash", "card", "card_to_card", "online", "credit", "snappfood", "cheque"]) {
      expect(SHIFT_CASH_SUMMARY_SQL).toContain(`p.method = '${method}'`);
    }
  });

  it("gives SnapFood and cheque their own buckets instead of leaving a gap in the tie-out (#933 item 9)", () => {
    // Both are real settlement classes in this product. Folding either into
    // cash would be wrong (neither is drawer money), and omitting them is what
    // made gross and the method totals disagree with no explanation.
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("snappfood_total");
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("cheque_total");
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("tendered_total");
    // Only `cash` feeds the expected drawer; the other buckets never do.
    expect(SHIFT_CASH_SUMMARY_SQL).not.toMatch(/FILTER \(WHERE p\.method IN \('cash'/);
  });

  it("reconciles a shift's drawer on closed_by/closed_at, not on opened_at", () => {
    // Deliberately the opposite rule to the shift's *order list*
    // (ORDER_OPENED_IN_WINDOW) — see CLAUDE.md: the drawer count has to
    // reconcile against money this employee actually took.
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("o.closed_by");
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("o.closed_at BETWEEN");
    expect(SHIFT_CASH_SUMMARY_SQL).toContain("o.status = 'completed'");
  });
});
