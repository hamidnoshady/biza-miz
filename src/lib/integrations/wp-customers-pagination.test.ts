import { describe, expect, it } from "vitest";
import {
  WP_CUSTOMERS_DEFAULT_PAGE_SIZE,
  WP_CUSTOMERS_MAX_PAGE_SIZE,
  WP_CUSTOMERS_MIN_PAGE_SIZE,
  wpCustomersPageSize,
  wpCustomersPageWindow,
  wpCustomersStatusFilter,
} from "./wp-manager-service";

/**
 * The WP customer book's pagination arithmetic.
 *
 * This is the pure half of the bug that made the screen report «۰ مشتری» for a
 * store with hundreds of them. The old query read its total from a
 * `count(*) OVER ()` window on the *page* query — a window that only exists on
 * rows that were actually returned. Page past the end (or narrow a search
 * while sitting on page 4) and the page returned no rows, so there was no
 * window row, so `total` read 0.
 *
 * The rule these tests pin: count first, clamp second, read third.
 */
describe("wpCustomersPageSize", () => {
  it("defaults when nothing is asked for", () => {
    expect(wpCustomersPageSize(undefined)).toBe(WP_CUSTOMERS_DEFAULT_PAGE_SIZE);
  });

  it("clamps into the supported window rather than trusting the caller", () => {
    expect(wpCustomersPageSize(1)).toBe(WP_CUSTOMERS_MIN_PAGE_SIZE);
    expect(wpCustomersPageSize(0)).toBe(WP_CUSTOMERS_MIN_PAGE_SIZE);
    expect(wpCustomersPageSize(-40)).toBe(WP_CUSTOMERS_MIN_PAGE_SIZE);
    expect(wpCustomersPageSize(999_999)).toBe(WP_CUSTOMERS_MAX_PAGE_SIZE);
    expect(wpCustomersPageSize(50)).toBe(50);
  });

  it("survives a non-numeric page size instead of producing NaN LIMIT", () => {
    expect(wpCustomersPageSize(Number.NaN)).toBe(WP_CUSTOMERS_DEFAULT_PAGE_SIZE);
    expect(wpCustomersPageSize(Number.POSITIVE_INFINITY)).toBe(WP_CUSTOMERS_MAX_PAGE_SIZE);
  });
});

describe("wpCustomersPageWindow", () => {
  it("resolves an ordinary middle page", () => {
    expect(wpCustomersPageWindow(2, 25, 300)).toEqual({
      page: 2,
      offset: 25,
      totalPages: 12,
      clamped: false,
    });
  });

  it("clamps a page past the end onto the last page that has rows", () => {
    // The exact shape of the reported bug: page 13 of a 2-page result.
    const window = wpCustomersPageWindow(13, 25, 30);
    expect(window.page).toBe(2);
    expect(window.offset).toBe(25);
    expect(window.totalPages).toBe(2);
    expect(window.clamped).toBe(true);
  });

  it("keeps a non-zero total reachable when an out-of-range page is requested", () => {
    // The regression's signature: total must never be reported as 0 merely
    // because the requested OFFSET moved past the end.
    const total = 137;
    const window = wpCustomersPageWindow(99, 25, total);
    expect(window.totalPages).toBe(6);
    expect(window.page).toBe(6);
    expect(window.offset).toBeLessThan(total);
  });

  it("collapses a narrowed search onto page 1 rather than an empty page 4", () => {
    // Sitting on page 4 of 300 results, then typing a term that matches 3.
    const before = wpCustomersPageWindow(4, 25, 300);
    expect(before.page).toBe(4);
    const after = wpCustomersPageWindow(4, 25, 3);
    expect(after.page).toBe(1);
    expect(after.offset).toBe(0);
    expect(after.totalPages).toBe(1);
    expect(after.clamped).toBe(true);
  });

  it("reports one page, offset zero, for an empty result", () => {
    expect(wpCustomersPageWindow(5, 25, 0)).toEqual({
      page: 1,
      offset: 0,
      totalPages: 1,
      clamped: true,
    });
  });

  it("re-derives the page count when the page size changes", () => {
    // 100 rows: 4 pages at 25, 1 page at 100. Page 3 survives the first and is
    // clamped by the second.
    expect(wpCustomersPageWindow(3, 25, 100).page).toBe(3);
    expect(wpCustomersPageWindow(3, 100, 100).page).toBe(1);
    expect(wpCustomersPageWindow(3, 100, 100).totalPages).toBe(1);
  });

  it("returns to valid pagination once the page is back in range", () => {
    // Clamped down, then the caller adopts the clamped page: no further move.
    const clamped = wpCustomersPageWindow(9, 25, 30);
    expect(clamped.clamped).toBe(true);
    const settled = wpCustomersPageWindow(clamped.page, 25, 30);
    expect(settled.clamped).toBe(false);
    expect(settled.page).toBe(clamped.page);
    expect(settled.offset).toBe(clamped.offset);
  });

  it("treats a junk or zero page as page 1 instead of a negative OFFSET", () => {
    expect(wpCustomersPageWindow(0, 25, 100).offset).toBe(0);
    expect(wpCustomersPageWindow(-7, 25, 100).offset).toBe(0);
    expect(wpCustomersPageWindow(Number.NaN, 25, 100).offset).toBe(0);
    expect(wpCustomersPageWindow(undefined, 25, 100).page).toBe(1);
  });

  it("never produces an offset at or past the total", () => {
    for (const total of [1, 7, 25, 26, 99, 100, 101, 1000]) {
      for (const size of [10, 25, 100]) {
        for (const asked of [1, 2, 5, 50, 10_000]) {
          const window = wpCustomersPageWindow(asked, size, total);
          expect(window.offset).toBeLessThan(Math.max(total, 1));
          expect(window.page).toBeGreaterThanOrEqual(1);
          expect(window.page).toBeLessThanOrEqual(window.totalPages);
        }
      }
    }
  });
});

describe("wpCustomersStatusFilter", () => {
  it("accepts exactly the reconciliation states the read model derives", () => {
    for (const status of ["linked", "unmapped", "needs_review", "conflict", "ignored"] as const) {
      expect(wpCustomersStatusFilter(status)).toBe(status);
    }
  });

  it("reads anything else as no filter rather than an error or an empty book", () => {
    expect(wpCustomersStatusFilter(undefined)).toBeUndefined();
    expect(wpCustomersStatusFilter("")).toBeUndefined();
    expect(wpCustomersStatusFilter("pending")).toBeUndefined();
    expect(wpCustomersStatusFilter("LINKED")).toBeUndefined();
    expect(wpCustomersStatusFilter("linked' OR '1'='1")).toBeUndefined();
  });
});
