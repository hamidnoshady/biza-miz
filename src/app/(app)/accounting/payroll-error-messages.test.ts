import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXED_ASSET_ERROR_TRANSLATIONS } from "@/lib/fixed-assets-errors";
import { errorMessage } from "./accounting-errors";
import { PAYROLL_ERROR_MESSAGES } from "./payroll-error-messages";

/**
 * The payroll API's refusals, against the sentences the screen shows for them.
 *
 * Scans the payroll sources for every code they can answer with and demands a
 * Persian message for each, so a new refusal cannot ship as a bare code on the
 * screen.
 */
const ROOT = process.cwd();

/**
 * Whether the accounting workspace's runner has no sentence for a code. Its last
 * resort is the shared dashboard fallback — the code itself, not a vague
 * «خطای غیرمنتظره» — so an unworded code comes back unchanged.
 */
const unworded = (c: string) => errorMessage(c) === c;

/** A source file with its comments removed — a code named only in prose is not one the API raises. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

/** The payroll modules in `src/lib` and every payroll route handler (not their tests). */
function payrollSources(): string[] {
  const lib = readdirSync(join(ROOT, "src/lib"))
    .filter((name) => /^payroll-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => join(ROOT, "src/lib", name));
  const routes = walk(join(ROOT, "src/app/api/ledger/payroll"), (file) => file.endsWith("route.ts"));
  return [...lib, ...routes];
}

/** Every snake_case string literal in a piece of source: the members of a union type, say. */
function literalsIn(text: string): string[] {
  return [...text.matchAll(/"([a-z][a-z_]*)"/g)].map((match) => match[1]);
}

function raisedCodes(): Set<string> {
  const found = new Set<string>();
  // A code named where it is raised…
  const raised = [
    /new PayrollError\(\s*"([a-z][a-z_]*)"/g,
    /badRequest\(\s*"([a-z][a-z_]*)"/g,
    /\berror:\s*"([a-z][a-z_]*)"/g,
  ];
  // …and the unions the pure helpers declare their codes in (`type PayrollSettingsError = "a" | "b"`),
  // or a function takes one as its `code` (`queryError(code: "invalid_limit" | "invalid_cursor")`).
  const declared = [/\btype\s+\w*Error\w*\s*=([^;]*);/g, /\bcode:\s*((?:"[a-z][a-z_]*"\s*\|?\s*)+)/g];
  for (const file of payrollSources()) {
    const text = code(file);
    for (const pattern of raised) for (const match of text.matchAll(pattern)) found.add(match[1]);
    for (const pattern of declared) for (const match of text.matchAll(pattern)) for (const literal of literalsIn(match[1])) found.add(literal);
  }
  return found;
}

/**
 * Codes that are not payroll's to word: the generic fallback for a malformed
 * body (the screen cannot produce one), and the ledger's own refusals, which the
 * shared map words for every section.
 */
const NOT_PAYROLLS = new Set(["bad_request"]);

describe("payroll error messages", () => {
  const raised = raisedCodes();

  it("finds the codes the payroll sources raise (the scan itself is not vacuous)", () => {
    for (const expected of [
      "period_already_accrued",
      "invalid_period",
      "period_in_future",
      "idempotency_key_conflict",
      "deductions_exceed_gross",
      "advance_already_recovered",
      "invalid_cursor",
      "paid_date_before_accrual",
    ]) {
      expect(raised, expected).toContain(expected);
    }
    expect(raised.size).toBeGreaterThan(30);
  });

  it("words every code payroll can raise — in payroll's own map, never left as a bare code", () => {
    const missing = [...raised].filter((c) => !NOT_PAYROLLS.has(c) && !(c in PAYROLL_ERROR_MESSAGES) && unworded(c));
    expect(missing).toEqual([]);
  });

  it("gives the accounting workspace's runner every payroll-only code, without rewording the shared ones", () => {
    // Read last there: a code receipts, payments or expenses already word keeps that wording...
    expect(errorMessage("invalid_amount")).not.toBe(PAYROLL_ERROR_MESSAGES.invalid_amount);
    // ...and one only payroll raises is now worded for every action routed through the runner.
    for (const c of ["period_already_accrued", "deductions_exceed_gross", "advance_already_recovered", "period_in_future", "invalid_overtime"]) {
      expect(errorMessage(c), c).toBe(PAYROLL_ERROR_MESSAGES[c]);
    }
  });

  it("carries no message for a code nothing raises — a dead sentence is a lie about the API", () => {
    expect(Object.keys(PAYROLL_ERROR_MESSAGES).filter((c) => !raised.has(c))).toEqual([]);
  });

  it("no longer carries the free-text period codes (a run is a Jalali month now)", () => {
    for (const dead of ["period_label_required", "period_label_too_long", "invalid_payroll_period"]) {
      expect(dead in PAYROLL_ERROR_MESSAGES, dead).toBe(false);
      expect(raised, dead).not.toContain(dead);
    }
    // Two of them are still real codes — the fixed-asset register raises them — and
    // that register's own dictionary words them for the runner, not payroll's.
    for (const shared of ["period_label_required", "period_label_too_long"]) {
      expect(errorMessage(shared), shared).toBe(FIXED_ASSET_ERROR_TRANSLATIONS[shared]);
    }
    // The third is nobody's any more.
    expect(unworded("invalid_payroll_period")).toBe(true);
  });

  it("leaves a code another domain words first to that domain: the runner never reads payroll's wording for it", () => {
    // `invalid_period` and `invalid_cursor` are payroll codes too, but the fixed-asset dictionary is
    // consulted first. None of the actions routed through the runner (pay, void, the advances) can
    // raise either, and the payroll screen words its own requests from its own map.
    for (const shared of Object.keys(PAYROLL_ERROR_MESSAGES).filter((c) => c in FIXED_ASSET_ERROR_TRANSLATIONS)) {
      expect(["invalid_period", "invalid_cursor"], shared).toContain(shared);
      expect(errorMessage(shared), shared).toBe(FIXED_ASSET_ERROR_TRANSLATIONS[shared]);
    }
  });

  it("words each code in Persian, with a full stop", () => {
    for (const [c, message] of Object.entries(PAYROLL_ERROR_MESSAGES)) {
      expect(message, c).toMatch(/[\u0600-\u06FF]/);
      expect(message.trim().endsWith("."), c).toBe(true);
    }
  });
});
