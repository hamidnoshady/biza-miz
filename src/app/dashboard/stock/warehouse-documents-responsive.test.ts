/**
 * Regression tests for the «رسید و حواله‌های انبار» screens' responsive and
 * dialog fixes — the same grep-the-source technique as
 * ../inventory/inventory-responsive.test.ts, because each of these bugs was a
 * source pattern: a dialog width class that tailwind-merge resolved into
 * dropping the mobile margin, a fixed six-column grid whose fields lost their
 * labels below xl, and a keyboard handler that ignored Space.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STOCK_DIR = fileURLToPath(new URL("./", import.meta.url));
const INVENTORY_DIR = resolve(STOCK_DIR, "../inventory");

const retailList = readFileSync(join(STOCK_DIR, "documents-section.tsx"), "utf8");
const retailForm = readFileSync(join(STOCK_DIR, "document-form-section.tsx"), "utf8");
const fnbList = readFileSync(join(INVENTORY_DIR, "documents-section.tsx"), "utf8");
const fnbForm = readFileSync(join(INVENTORY_DIR, "document-form-section.tsx"), "utf8");

describe("the detail dialog's width", () => {
  // DialogContent's base class ends in `max-w-[calc(100%-2rem)] … sm:max-w-sm`.
  // An unprefixed `max-w-2xl` merges away the *mobile* margin (tailwind-merge
  // keeps the later class) while `sm:max-w-sm` still wins on desktop — the
  // exact inversion of what the override wants. Only `sm:max-w-2xl` widens
  // the dialog from sm up and leaves the phone layout alone.
  it("both lists override with sm:max-w-2xl, never a bare max-w-2xl", () => {
    for (const [name, content] of [
      ["stock/documents-section.tsx", retailList],
      ["inventory/documents-section.tsx", fnbList],
    ] as const) {
      expect(content, `${name} must widen the dialog with sm:max-w-2xl`).toMatch(
        /DialogContent className="sm:max-w-2xl"/,
      );
      expect(content, `${name} regrew the unprefixed max-w-2xl override`).not.toMatch(
        /DialogContent className="max-w-2xl"/,
      );
    }
  });
});

describe("the retail line editor (ثبت رسید انبار/حواله)", () => {
  it("lines are labeled mini-cards below xl, a grid from xl up", () => {
    // The header row naming the columns only exists where the columns do…
    expect(retailForm).toMatch(/hidden text-xs[^"]*xl:grid/);
    // …and each line starts as a bordered single-column card whose per-field
    // labels flip to sr-only when the fixed template kicks in at xl.
    expect(retailForm).toMatch(/grid-cols-1[^"]*rounded-xl border[^"]*xl:grid-cols-\[/);
    expect(retailForm).toMatch(/xl:sr-only/);
  });

  it("carries no mixed-language UI copy (the «بهای relieved» tooltip)", () => {
    // English inside code comments is fine; English inside a rendered Persian
    // string is not. The offending tooltip was title="بهای relieved از …".
    expect(retailForm).not.toMatch(/بهای relieved/);
  });

  it("resets the stale per-item lot cache after a posted document", () => {
    // A posted receipt/issue changes lot quantities and costs; the cached
    // options for the *next* document must be re-fetched, not trusted.
    expect(retailForm).toMatch(/resetLotCache\(\)/);
  });
});

describe("keyboard access to the document rows", () => {
  it("both lists open the detail dialog on Space as well as Enter", () => {
    for (const [name, content] of [
      ["stock/documents-section.tsx", retailList],
      ["inventory/documents-section.tsx", fnbList],
    ] as const) {
      expect(content, `${name} must handle the Space key`).toMatch(
        /e\.key === "Enter" \|\| e\.key === " "/,
      );
    }
  });
});

describe("the list fetches", () => {
  it("both lists distinguish a failed load from an empty ledger", () => {
    for (const [name, content] of [
      ["stock/documents-section.tsx", retailList],
      ["inventory/documents-section.tsx", fnbList],
    ] as const) {
      expect(content, `${name} must track a failed load`).toMatch(/loadFailed/);
    }
  });

  it("the retail search input is debounced", () => {
    expect(retailList).toMatch(/setTimeout\(\(\) => setSearchQuery/);
  });
});

describe("the form submits", () => {
  it("both forms validate lines client-side with a named row number", () => {
    for (const [name, content] of [
      ["stock/document-form-section.tsx", retailForm],
      ["inventory/document-form-section.tsx", fnbForm],
    ] as const) {
      expect(content, `${name} must name the offending row`).toMatch(/ردیف \$\{lineNo\}/);
    }
  });
});

describe("print / PDF / export and the register's P2 filters (#923)", () => {
  const lists = [
    ["stock/documents-section.tsx", retailList],
    ["inventory/documents-section.tsx", fnbList],
  ] as const;

  it("both lists offer print/PDF and both file exports, through the API", () => {
    for (const [name, content] of lists) {
      // The buttons exist…
      expect(content, `${name} must offer print/PDF`).toMatch(/چاپ \/ PDF/);
      expect(content, `${name} must offer a CSV export`).toMatch(/خروجی CSV/);
      expect(content, `${name} must offer an Excel export`).toMatch(/خروجی Excel/);
      // …and the export is the server's: the request carries `format=`.
      expect(content, `${name} must ask the API for the file`).toMatch(/params\.set\("format", format\)/);
    }
  });

  it("the register prints through a portalled sheet, not the app chrome", () => {
    for (const [name, content] of lists) {
      expect(content, `${name} must portal the print sheet`).toMatch(/createPortal\(/);
      expect(content, `${name} must mark the sheet for the print rule`).toMatch(/id="print-sheet-root"/);
      expect(content, `${name} must trigger the browser's print dialog`).toMatch(/window\.print\(\)/);
    }
  });

  it("the detail dialog prints one document through the platform template route", () => {
    for (const [name, content] of lists) {
      expect(content, `${name} must print a single voucher server-side`).toContain("/print`,");
      expect(content, `${name} must label the button`).toMatch(/چاپ \/ PDF سند/);
    }
  });

  it("both lists carry the P2 filters and keep them in the URL", () => {
    for (const [name, content] of lists) {
      for (const param of ["amountMin", "amountMax", "createdBy", "postingState", "sort"]) {
        expect(content, `${name} must send ${param}`).toMatch(new RegExp(`params\\.set\\("${param}"`));
      }
      expect(content, `${name} must offer a creator filter`).toMatch(/ثبت‌کننده/);
      expect(content, `${name} must offer a posting-state filter`).toMatch(/وضعیت ثبت/);
      expect(content, `${name} must offer a sort selector`).toMatch(/WAREHOUSE_REGISTER_SORT_LABELS/);
    }
  });

  it("shows the correction/reversal history with reasons and actors", () => {
    for (const [name, content] of lists) {
      expect(content, `${name} must render the history panel`).toMatch(/سابقهٔ اصلاح و برگشت/);
      expect(content, `${name} must show both ends of the chain`).toMatch(/سند اصلی/);
      expect(content, `${name} must show the reversal`).toMatch(/سند برگشت/);
      expect(content, `${name} must show why`).toMatch(/دلیل:/);
      expect(content, `${name} must show who`).toMatch(/actorName/);
    }
  });

  it("dates come from the branch, not the server's clock", () => {
    for (const [name, content] of lists) {
      // A stored business date is rendered with the UTC-pinned formatter, and a
      // timestamp with the row's own zone — never `formatJalali(created_at)`.
      expect(content, `${name} must use the branch-aware date helper`).toMatch(/formatDocumentDate\(/);
      expect(content, `${name} must format clocks in the branch zone`).toMatch(
        /formatBranchTimestamp\([^)]*location_timezone/s,
      );
      expect(content, `${name} must not format a raw created_at directly`).not.toMatch(
        /formatJalali\(detail\.document\.created_at/,
      );
    }
  });
});
