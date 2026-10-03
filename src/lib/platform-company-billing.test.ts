import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postingPlanFor, REQUIRED_POSTING_ACCOUNT_CODES } from "./platform-company-billing";

// Use every persisted event kind, so a future plan cannot silently add an
// account that the shared health-check list forgets to inspect.
const migration = readFileSync(join(process.cwd(), "migrations", "0193_platform_company_security_and_repair.sql"), "utf8");
const constraint = migration.match(/CHECK \(source_kind IN \(([\s\S]*?)\)\)/);
if (!constraint) throw new Error("The billing event-kind constraint is missing");
const kinds = [...constraint[1].matchAll(/'([^']+)'/g)].map(match => match[1]);

function event(kind: string): Parameters<typeof postingPlanFor>[0] {
  return {
    id: "event", internal_business_id: "company", customer_tenant_id: "customer",
    source_kind: kind, source_table: "billing_adjustments", source_id: "source", source_version: "created",
    amount_rial: "1000000", settlement_method: "wallet", occurred_at: new Date("2026-01-01T00:00:00Z"),
    payload: { paidRial: 300_000 },
  };
}

describe("posting-account health-check contract", () => {
  it.each(kinds)("includes every account used by %s", kind => {
    const plan = postingPlanFor(event(kind));
    if (kind === "wallet_noncash_credit") {
      expect(plan).toBeNull();
      return;
    }
    expect(plan).not.toBeNull();
    for (const line of plan!.lines) expect(REQUIRED_POSTING_ACCOUNT_CODES).toContain(line.code);
  });

  it("contains exactly the complete, unique set used by posting plans", () => {
    const used = new Set(kinds.flatMap(kind => postingPlanFor(event(kind))?.lines.map(line => line.code) ?? []));
    expect([...used].sort()).toEqual([...REQUIRED_POSTING_ACCOUNT_CODES].sort());
    expect(used.size).toBe(REQUIRED_POSTING_ACCOUNT_CODES.length);
    expect([...used].sort()).toEqual(["1110", "1200", "2100", "2455", "4400", "4500", "5670"]);
  });
});
