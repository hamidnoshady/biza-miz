/**
 * Issue #907 F04 — the canonical project-cost SQL, pinned.
 *
 * The semantics (expense accounts only, net of credits, reversals attributed
 * through `reverses_entry_id`) are proved against a real database in
 * `integration/workspace.integration.test.ts`; what this file guards is the part
 * a database cannot: that the string carries the clauses the policy is made of,
 * and that it never becomes a way to smuggle a value into SQL.
 */
import { describe, expect, it } from "vitest";
import { projectCostSubquerySql, projectRevenueSubquerySql } from "./project-costs";

const sql = (input = { business: "$1", project: "$2" }) => projectCostSubquerySql(input);

describe("projectCostSubquerySql", () => {
  it("counts only expense accounts, and nets credits against debits", () => {
    const text = sql();
    expect(text).toContain("a.type = 'expense'");
    // A reversal/refund is a credit on the account the original debited, so the
    // sign of the sum is what makes an undone expense stop counting.
    expect(text).toContain("sum(jl.debit - jl.credit)");
    // Summing debits alone is the defect (#907 F04) this replaced.
    expect(text).not.toMatch(/sum\(jl\.debit\)/);
  });

  it("scopes by business on both the entry and the account", () => {
    const text = sql();
    expect(text).toContain("je.business_id = $1");
    // A line may only be counted against an account of the same tenant, so a
    // stray cross-tenant account id cannot contribute to another business's cost.
    expect(text).toContain("a.business_id = $1");
  });

  it("attributes a reversal to the project it reverses", () => {
    const text = sql();
    expect(text).toContain("je.project_id = $2");
    expect(text).toContain("je.reverses_entry_id IS NOT NULL");
    expect(text).toContain("original.project_id = $2");
    // The attribution is a fallback, not a replacement: an entry with its own
    // project is counted once, under its own project.
    expect(text).toContain("je.project_id IS NULL");
  });

  it("returns a number rather than NULL for a project with no ledger rows", () => {
    expect(sql().startsWith("COALESCE((")).toBe(true);
    expect(sql().trimEnd().endsWith("), 0)")).toBe(true);
  });

  it("accepts a column reference as well as a bound parameter", () => {
    const text = sql({ business: "p.business_id", project: "p.id" });
    expect(text).toContain("je.business_id = p.business_id");
    expect(text).toContain("je.project_id = p.id");
    // Both sides of the correlation are the caller's own SQL text, so the
    // subquery is valid inside a SELECT over `ai_projects p`.
    expect(text).not.toContain("$1");
  });
});

describe("projectRevenueSubquerySql", () => {
  it("reads the other side of the same attribution, net credit on revenue", () => {
    const text = projectRevenueSubquerySql({ business: "$1", project: "$2" });
    expect(text).toContain("a.type = 'revenue'");
    expect(text).toContain("sum(jl.credit - jl.debit)");
    expect(text).toContain("original.project_id = $2");
  });
});
