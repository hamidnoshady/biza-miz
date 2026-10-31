/**
 * Issue #902 §9 item 3 (last part) — comparing a supplier's invoice with our books.
 *
 * The interesting cases are not "equal" or "different". They are the three ways
 * this comparison is quietly got wrong:
 *
 *   - `0 ≈ 0` called a match on a period we recorded nothing for;
 *   - a real difference rounded into "close enough" by a tolerance nobody wrote
 *     down;
 *   - the ledger "corrected" so the next comparison passes.
 *
 * Each has a fixture here, plus the source guards for the third.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canAccept,
  canReconcile,
  compareSupplierStatement,
  stateForVerdict,
  SUPPLIER_STATE_LABELS,
  DEFAULT_SUPPLIER_TOLERANCE_RIAL,
} from "./supplier-invoice";

const repoRoot = path.resolve(__dirname, "../../..");
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

describe("a statement is compared with the ledger, not with itself", () => {
  it("matches a statement that agrees exactly", () => {
    const result = compareSupplierStatement({ claimedRial: 1_500_000, recordedRial: 1_500_000, recordedEvents: 900 });
    expect(result).toMatchObject({ verdict: "matched", deltaRial: 0, toleranceRial: DEFAULT_SUPPLIER_TOLERANCE_RIAL });
    expect(result.reason).toContain("برابر");
  });

  it("keeps a small difference, and says it was inside a written tolerance", () => {
    const result = compareSupplierStatement({
      claimedRial: 1_000_600,
      recordedRial: 1_000_000,
      recordedEvents: 500,
      toleranceRial: 1_000,
    });
    expect(result.verdict).toBe("matched");
    // The difference is reported, not erased by the match.
    expect(result.deltaRial).toBe(600);
    expect(result.toleranceRial).toBe(1_000);
  });

  it("the tolerance is symmetric, and defaults to one message's worth", () => {
    expect(DEFAULT_SUPPLIER_TOLERANCE_RIAL).toBe(1_000);
    const over = compareSupplierStatement({ claimedRial: 10_000, recordedRial: 9_000, recordedEvents: 4 });
    const under = compareSupplierStatement({ claimedRial: 9_000, recordedRial: 10_000, recordedEvents: 4 });
    expect(over.verdict).toBe("matched");
    expect(under.verdict).toBe("matched");
  });

  it("disputes a difference outside the tolerance, and says which way", () => {
    const over = compareSupplierStatement({ claimedRial: 1_500_000, recordedRial: 1_400_000, recordedEvents: 800 });
    expect(over).toMatchObject({ verdict: "disputed", deltaRial: 100_000 });
    expect(over.reason).toContain("بیشتر از دفتر ما");

    const under = compareSupplierStatement({ claimedRial: 1_400_000, recordedRial: 1_500_000, recordedEvents: 800 });
    expect(under).toMatchObject({ verdict: "disputed", deltaRial: -100_000 });
    expect(under.reason).toContain("کمتر از دفتر ما");
  });

  it("refuses to call a month we recorded nothing for a match", () => {
    // claimed = 0 would make `|delta| = 0` and "match" by arithmetic alone.
    const empty = compareSupplierStatement({ claimedRial: 0, recordedRial: 0, recordedEvents: 0 });
    expect(empty.verdict).toBe("matched");
    // But a supplier billing us for a period our ledger is silent about is not a
    // small difference — it is the missing half of the books.
    const billed = compareSupplierStatement({ claimedRial: 250_000, recordedRial: 0, recordedEvents: 0 });
    expect(billed.verdict).toBe("unexplained");
    // Even under a tolerance wide enough to swallow the whole claim.
    const swallowed = compareSupplierStatement({
      claimedRial: 250_000,
      recordedRial: 0,
      recordedEvents: 0,
      toleranceRial: 1_000_000,
    });
    expect(swallowed.verdict).toBe("unexplained");
    expect(swallowed.reason).toContain("هیچ هزینه‌ای");
  });

  it("maps a verdict to a stored state, with unexplained counted as a dispute", () => {
    expect(stateForVerdict("matched")).toBe("matched");
    expect(stateForVerdict("disputed")).toBe("disputed");
    expect(stateForVerdict("unexplained")).toBe("disputed");
  });

  it("normalises nonsense instead of propagating it", () => {
    const result = compareSupplierStatement({
      claimedRial: Number.NaN,
      recordedRial: -50,
      recordedEvents: -3,
    });
    expect(result).toMatchObject({ verdict: "matched", deltaRial: 0 });
  });
});

describe("accepting a difference is a decision with a reason", () => {
  it("only a disputed statement can be accepted, and only with a reason", () => {
    expect(canAccept("disputed", "")).toMatchObject({ ok: false, code: "reason_required" });
    expect(canAccept("disputed", "   ")).toMatchObject({ ok: false, code: "reason_required" });
    expect(canAccept("disputed", "تأیید مدیر مالی برای اختلاف نرخ ارز")).toEqual({ ok: true });
    // Accepting a match is a no-op that would suggest a decision was needed.
    expect(canAccept("matched", "ok")).toMatchObject({ ok: false, code: "not_disputed" });
    // An `open` statement has not been compared yet.
    expect(canAccept("open", "ok")).toMatchObject({ ok: false, code: "not_disputed" });
    expect(canAccept("accepted", "ok")).toMatchObject({ ok: false, code: "not_disputed" });
  });

  it("an accepted statement is final; everything else may be re-checked", () => {
    // Late cost events are normal, so re-running the comparison is the point…
    expect(canReconcile("open")).toBe(true);
    expect(canReconcile("matched")).toBe(true);
    expect(canReconcile("disputed")).toBe(true);
    // …but a human already decided to pay this one, and overwriting the verdict
    // would erase the decision while leaving the money paid.
    expect(canReconcile("accepted")).toBe(false);
  });

  it("has first-party labels and no supplier vocabulary", () => {
    for (const label of Object.values(SUPPLIER_STATE_LABELS)) {
      expect(label.trim()).not.toBe("");
      expect(label).not.toMatch(/kavenegar|provider|API/i);
    }
  });
});

describe("the schema and the service keep the evidence intact", () => {
  it("refuses an accepted statement without a reason, in the database", () => {
    const migration = read("migrations/0276_billing_supplier_invoices.sql");
    expect(migration).toMatch(
      /CHECK \(state <> 'accepted' OR length\(trim\(coalesce\(accepted_reason, ''\)\)\) > 0\)/,
    );
    // A verdict cannot exist without the comparison it came from.
    expect(migration).toMatch(/CHECK \(state = 'open' OR \(recorded_rial IS NOT NULL AND delta_rial IS NOT NULL\)\)/);
    // Same supplier reference twice is the same debt.
    expect(migration).toMatch(/UNIQUE \(provider, statement_reference\)/);
  });

  it("is platform-only at the database, like the retail price catalogue", () => {
    const migration = read("migrations/0276_billing_supplier_invoices.sql");
    expect(migration).toMatch(/ALTER TABLE billing_supplier_invoices FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/CREATE POLICY platform_only ON billing_supplier_invoices FOR ALL\s*\n\s*USING \(app_rls_bypass\(\)\)/);
  });

  it("never writes to the cost events it compares against", () => {
    const service = read("src/lib/billing/supplier-invoice-service.ts");
    // Reads only: the reconciliation is evidence about the ledger, not an edit of it.
    expect(service).toMatch(/FROM billing_vendor_cost_events/);
    expect(service).not.toMatch(/INSERT INTO billing_vendor_cost_events/);
    expect(service).not.toMatch(/UPDATE billing_vendor_cost_events/);
    expect(service).not.toMatch(/DELETE FROM billing_vendor_cost_events/);
    // Half-open window, like every other billing period.
    expect(service).toMatch(/occurred_at >= \$2::timestamptz\s*\n\s*AND occurred_at < \$3::timestamptz/);
    // Platform scope: no tenant can reach a supplier's name through this.
    expect(service).toMatch(/withoutTenantScope\("platform"/);
  });

  it("guards each of the route's three actions and audits them", () => {
    const route = read("src/app/api/platform/billing/supplier-invoices/route.ts");
    expect(route).toMatch(/requirePlatformCapability\("billing\.view"\)/);
    expect(route).toMatch(/requirePlatformCapability\("billing\.manage"\)/);
    expect(route).toMatch(/action === "record"/);
    expect(route).toMatch(/action === "reconcile"/);
    expect(route).toMatch(/action === "accept"/);
    // Every write is audited with the numbers it decided on.
    expect((route.match(/platformAudit\(/g) ?? []).length).toBe(3);
    expect(route).toMatch(/deltaRial/);
  });
});
