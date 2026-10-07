import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two subledger services' SQL, pinned at the shapes that were wrong and
 * the shapes that fixed them.
 *
 * These are greps, and they are the weaker kind of test — the behaviour they
 * guard is exercised for real in `integration/ar.integration.test.ts`,
 * `integration/ap.integration.test.ts` and `integration/receivables-hardening.
 * integration.test.ts`, which run the queries against Postgres. What a grep
 * can do that a behavioural test cannot is hold the *shape* of a statement: a
 * nested-loop join that is merely slow on a test-sized ledger, or a party
 * check that loses one of its four conditions without failing any single
 * scenario, both pass every behavioural case here and only show up in
 * production.
 *
 * Each assertion below has a plan or a defect behind it:
 *
 *  - `IS NOT DISTINCT FROM` in the aging report planned as a nested loop whose
 *    filter compared every party with every line — 2.7M comparisons at 300
 *    parties × 9,000 lines. `EXPLAIN ANALYZE` after the rewrite: all hash
 *    joins, no `Rows Removed by Join Filter`, ~4× faster on the same data.
 *  - The receipt's party check is four conditions, not one: the id must be in
 *    this business, hold the Customer role, be active, and not have been
 *    merged away. Migration 0137 renamed `customers` to `parties`, and the
 *    foreign key on `ar_receipts.customer_id` cannot say any of them.
 *  - `entry_date <= $3::date` has to be in the query, not a filter over the
 *    rows that came back: the report used to load the whole history and drop
 *    the future in Node.
 *  - The attribution joins appear exactly once per file, inside the exported
 *    fragment every caller shares. `crm-app-boundaries.test.ts` fails if a
 *    caller stops using it; this fails if the fragment itself is copied.
 */

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const AR = read("./ar-service.ts");
const AP = read("./ap-service.ts");

describe("the aging report's SQL shape", () => {
  it("joins parties by key equality, never by a null-tolerant comparison", () => {
    // `IS NOT DISTINCT FROM` is the correct *semantics* for the unattributed
    // bucket and the wrong *plan*: a nested loop. The key is normalised to
    // text (empty string for the unattributed lines) instead.
    for (const [name, source] of [
      ["ar-service.ts", AR],
      ["ap-service.ts", AP],
    ] as const) {
      expect(source, name).not.toContain("IS NOT DISTINCT FROM");
      expect(source, name).toMatch(/coalesce\(\$\{A[RP]_[A-Z_]+_ID_SQL\}::text, ''\)/);
      expect(source, name).toMatch(/customer_key = t\.customer_key|supplier_key = t\.supplier_key/);
    }
  });

  it("carries each party's payments as a window over the rows it is already scanning", () => {
    // The join version of this is what planned as the nested loop above.
    expect(AR).toMatch(/sum\(jl\.credit\) OVER \(PARTITION BY coalesce\(\$\{AR_CUSTOMER_ID_SQL\}::text, ''\)\)/);
    expect(AP).toMatch(/sum\(jl\.debit\) OVER \(PARTITION BY coalesce\(\$\{AP_SUPPLIER_ID_SQL\}::text, ''\)\)/);
  });

  it("filters the as-of date in SQL, and returns one row per party", () => {
    for (const source of [AR, AP]) {
      expect(source).toMatch(/je\.entry_date <= \$3::date/);
      expect(source).toMatch(/GROUP BY customer_key|GROUP BY supplier_key/);
      expect(source).toContain('agingBucketCaseSql("($3::date - entry_date)")');
    }
  });
});

describe("the balance list's SQL shape", () => {
  it("counts the match before the window in the same round trip, and drops settled parties in SQL", () => {
    // `count(*) OVER ()` is evaluated after WHERE and before LIMIT, so a page
    // and its total come back together; `HAVING` keeps a settled party out of
    // the result set rather than out of a JS array.
    expect(AR).toMatch(/count\(\*\) OVER \(\) AS total/);
    expect(AR).toMatch(/HAVING sum\(jl\.debit - jl\.credit\) <> 0/);
    expect(AP).toMatch(/count\(\*\) OVER \(\) AS total/);
  });
});

describe("the attribution rule", () => {
  it("exists once per service, inside the exported fragment, and is never re-stated inline", () => {
    // The amendment bridge is the piece a copy would silently drop.
    expect(AR.match(/LEFT JOIN cheques ch/g)).toHaveLength(1);
    expect(AP.match(/LEFT JOIN cheques ch/g)).toHaveLength(1);
    expect(AR.match(/LEFT JOIN orders o/g)).toHaveLength(1);
    expect(AR).toMatch(/export const AR_CUSTOMER_ATTRIBUTION_SQL = `/);
    expect(AP).toMatch(/export const AP_SUPPLIER_ATTRIBUTION_SQL = `/);
    // Every read model names the fragment rather than its joins.
    expect(AR.match(/\$\{AR_CUSTOMER_ATTRIBUTION_SQL\}/g)!.length).toBeGreaterThanOrEqual(3);
    expect(AP.match(/\$\{AP_SUPPLIER_ATTRIBUTION_SQL\}/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("who may receive a payment", () => {
  it("checks all four invariants on the party in the writing transaction", () => {
    // The pre-fix check was `WHERE id = $1 AND business_id = $2`: a supplier,
    // a former employee, a deactivated customer or a merged duplicate could
    // all be paid into.
    expect(AR).toMatch(
      /FROM parties\s+WHERE id = \$1 AND business_id = \$2\s+AND roles @> ARRAY\[\$3\]::text\[\]\s+AND is_active\s+AND merged_into_id IS NULL/,
    );
    expect(AR).toMatch(/PARTY_ROLE_STORAGE\.Customer/);
    expect(AR).toMatch(/throw new ArError\("customer_not_found", 404\)/);
  });
});

describe("date validation", () => {
  it("uses the one calendar-aware validator in both services", () => {
    for (const source of [AR, AP]) {
      expect(source).toMatch(/import \{ isValidIsoDate \} from "\.\/iso-date"/);
      // The regex this replaced accepted 2026-02-29 and handed it to Postgres.
      expect(source).not.toMatch(/\\d\{4\}-\\d\{2\}-\\d\{2\}/);
      expect(source).toMatch(/isValidIsoDate\(/);
    }
  });
});
