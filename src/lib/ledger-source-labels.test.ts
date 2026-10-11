import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LEDGER_SOURCE_LABELS, ledgerSourceLabel } from "./ledger-source-labels";

/**
 * The label table has to stay *complete*, not merely present: the bug it
 * replaced was three partial maps, each silently falling through to the raw
 * English code. So this test does not hard-code the expected list — it greps
 * every `sourceType: "…"` literal out of `src/`, which is how a posting path
 * names itself, and fails if any of them has no Persian label.
 *
 * A new posting rule therefore adds its label in the same change, the way a
 * new notification event adds its producer.
 */
const SRC_DIR = resolve(fileURLToPath(new URL("./", import.meta.url)), "..");

function collectSourceTypeLiterals(): string[] {
  const found = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(/sourceType\s*:\s*"([a-z_]+)"/g)) found.add(match[1]);
      for (const match of source.matchAll(/source_type\s*=\s*'([a-z_]+)'/g)) found.add(match[1]);
    }
  }
  walk(SRC_DIR);
  return [...found].sort();
}

describe("ledger source-type labels", () => {
  it("finds a plausible number of source types (guards against a broken walk)", () => {
    expect(collectSourceTypeLiterals().length).toBeGreaterThan(30);
  });

  it("labels every source_type any posting path emits", () => {
    const unlabelled = collectSourceTypeLiterals().filter((code) => !LEDGER_SOURCE_LABELS[code]);
    expect(
      unlabelled.join(", "),
      [
        `No Persian label for source_type: ${unlabelled.join(", ")}.`,
        "Every posting path's source_type needs an entry in LEDGER_SOURCE_LABELS —",
        "the journal, bank reconciliation and the reports drill-down all read it,",
        "and an unlabelled code shows the reader raw English.",
      ].join("\n"),
    ).toBe("");
  });

  it("labels the source types a payroll void posts under (built from a template, so the literal scan cannot see them)", () => {
    // payroll-service.ts mirrors a run's accrual and payment entries as
    // `payroll_accrual_void` / `payroll_payment_void`; without these the journal
    // fell back to the generic «سند سیستمی» for an undone salary.
    expect(ledgerSourceLabel("payroll_accrual_void")).toBe("ابطال تعهد حقوق");
    expect(ledgerSourceLabel("payroll_payment_void")).toBe("ابطال پرداخت حقوق");
  });

  it("never returns a raw code", () => {
    expect(ledgerSourceLabel("ar_receipt")).toBe("دریافت از مشتری");
    expect(ledgerSourceLabel("a_rule_from_a_newer_deploy")).toBe("سند سیستمی");
    expect(ledgerSourceLabel(null)).toBe("—");
    expect(ledgerSourceLabel("")).toBe("—");
    expect(ledgerSourceLabel("   ")).toBe("—");
  });

  it("has no label that is just its code", () => {
    const englishish = Object.entries(LEDGER_SOURCE_LABELS).filter(([, label]) => /[A-Za-z_]/.test(label));
    expect(englishish.map(([code]) => code).join(", ")).toBe("");
  });
});
