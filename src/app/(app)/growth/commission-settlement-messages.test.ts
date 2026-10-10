import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMISSION_SETTLEMENT_ERROR_MESSAGES,
  COMMISSION_SETTLEMENT_FALLBACK_MESSAGE,
  commissionSettlementErrorMessage,
  commissionWarningText,
} from "./commission-settlement-messages";

const ROOT = process.cwd();

/** The settlement sources (not their tests) and the routes that answer for them. */
function settlementSources(): string[] {
  const lib = readdirSync(join(ROOT, "src/lib"))
    .filter((name) => /^commission-settlement-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => join(ROOT, "src/lib", name));
  return lib;
}

/** Strip comments so a code named only in prose does not count as one the API raises. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Every refusal the settlement code can raise: a `CommissionSettlementError` code, or a code the lifecycle maps per action. */
function raisedCodes(): Set<string> {
  const found = new Set<string>();
  for (const file of settlementSources()) {
    const source = code(file);
    for (const match of source.matchAll(/CommissionSettlementError\(\s*"([a-z][a-z_]*)"/g)) found.add(match[1]);
    for (const match of source.matchAll(/\b(?:fail|refuse)\(\s*"([a-z][a-z_]*)"/g)) found.add(match[1]);
    for (const match of source.matchAll(/^\s*(?:calculate|review|approve|reject|release|void|pay|reverse_payout|close): "([a-z][a-z_]*)"/gm)) {
      found.add(match[1]);
    }
    for (const match of source.matchAll(/\bcode = "([a-z][a-z_]*)"/g)) found.add(match[1]);
    // Codes passed as arguments (the input parsers) and the per-action map in the service.
    for (const match of source.matchAll(new RegExp(`"(${CODE_PREFIXES.join("|")})[a-z_]*"`, "g"))) found.add(match[0].slice(1, -1));
  }
  // An event the audit trail records is not a refusal the API answers with.
  for (const event of NOT_REFUSALS) found.delete(event);
  return found;
}

/** Quoted snake_case words with a code prefix that are audit event names, not refusals. */
const NOT_REFUSALS = ["payout_reversal"];

/** The prefixes a refusal code carries. A quoted literal with one of these is a code, not a table or column. */
const CODE_PREFIXES = [
  "run_",
  "payout_",
  "nothing_",
  "invalid_",
  "idempotency_",
  "employee_",
  "location_",
  "allocation_",
  "duplicate_",
  "paid_date_",
  "void_",
  "period_",
  "permission_",
  "approver_",
  "commission_already_",
  "bad_",
  "no_",
  "note_",
];

describe("the settlement API's refusals, in Persian", () => {
  it("has a sentence for every code the settlement code raises", () => {
    const missing = [...raisedCodes()].filter((c) => !(c in COMMISSION_SETTLEMENT_ERROR_MESSAGES)).sort();
    expect(missing).toEqual([]);
  });

  it("finds the refusals it is meant to find (the scan is not vacuous)", () => {
    const found = raisedCodes();
    for (const expected of ["run_not_draft", "allocation_exceeds_outstanding", "idempotency_key_conflict", "nothing_to_settle", "approver_is_calculator"]) {
      expect(found.has(expected), expected).toBe(true);
    }
  });

  it("answers a known code with its sentence, and an unknown one with the generic sentence, never the bare code", () => {
    expect(commissionSettlementErrorMessage("nothing_to_settle")).toBe(COMMISSION_SETTLEMENT_ERROR_MESSAGES.nothing_to_settle);
    expect(commissionSettlementErrorMessage("some_unmapped_code")).toBe(COMMISSION_SETTLEMENT_FALLBACK_MESSAGE);
    expect(commissionSettlementErrorMessage(undefined)).toBe(COMMISSION_SETTLEMENT_FALLBACK_MESSAGE);
  });

  it("writes every sentence in Persian, with no bare English code in it", () => {
    for (const [key, sentence] of Object.entries(COMMISSION_SETTLEMENT_ERROR_MESSAGES)) {
      expect(sentence, key).toMatch(/[\u0600-\u06FF]/);
      expect(sentence, key).not.toBe(key);
    }
  });
});

describe("the warnings a run carries", () => {
  const count = (n: number) => String(n);

  it("names the members held back, by name", () => {
    const text = commissionWarningText(
      { code: "balance_not_positive", employees: [{ employeeId: "e1", fullName: "علی", net: "-100", rows: 2 }, { employeeId: "e2", fullName: "بابک", net: "0", rows: 1 }] },
      count,
    );
    expect(text).toContain("علی");
    expect(text).toContain("بابک");
    expect(text).toContain("پرداخت نشد");
  });

  it("gives each other warning its count", () => {
    expect(commissionWarningText({ code: "claimed_by_payroll", rows: 3, payrolls: [{ payrollRunId: "p1", periodLabel: "مهر ۱۴۰۵", rows: 3 }] }, count)).toContain("مهر ۱۴۰۵");
    expect(commissionWarningText({ code: "earlier_rows_included", rows: 2, before: "2026-10-01" }, count)).toContain("2");
    expect(commissionWarningText({ code: "earlier_rows_included", rows: 2, before: "2026-10-01" }, count)).toContain("دو بار");
    expect(commissionWarningText({ code: "rule_missing", rows: 4 }, count)).toContain("4");
    expect(commissionWarningText({ code: "inactive_member", employees: [{ employeeId: "e1", fullName: "رضا" }] }, count)).toContain("رضا");
    const unmapped = commissionWarningText(
      { code: "unmapped_seller", lines: 3, sellers: [{ employeeId: "e9", fullName: "نیلوفر", lines: 3, salesValue: "900000" }] },
      count,
      (rial) => `${rial} ریال`,
    );
    expect(unmapped).toContain("نیلوفر");
    expect(unmapped).toContain("900000 ریال");
    expect(unmapped).toContain("قانون پورسانت فعال ندارند");
  });
});
