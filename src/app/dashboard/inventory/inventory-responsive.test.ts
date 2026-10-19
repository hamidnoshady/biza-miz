/**
 * Regression tests for the inventory workspace's responsive redesign.
 *
 * Same technique as ../design-lint.test.ts — grep the source, because every
 * one of these bugs was a *source pattern*, not a behaviour a unit could
 * exercise: a CSS selector that missed the combobox trigger, a fixed
 * four-column grid with no breakpoint, a leftover native <select>, a banner
 * the menu had already replaced. Each rule here failed on the pre-fix code
 * and pins the fix so it cannot drift back.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INVENTORY_DIR = fileURLToPath(new URL("./", import.meta.url));
const SRC_DIR = resolve(INVENTORY_DIR, "../../..");

function read(rel: string): string {
  return readFileSync(join(INVENTORY_DIR, rel), "utf8");
}

/** Every non-test source file of the workspace, as [name, content]. */
function sectionFiles(): Array<[string, string]> {
  return readdirSync(INVENTORY_DIR)
    .filter((name) => /\.(tsx|ts|css)$/.test(name) && !/\.test\.ts$/.test(name))
    .map((name) => [name, read(name)]);
}

describe("touch-height rule (the 'tiny selects' bug)", () => {
  const css = read("inventory-workspace.module.css");

  it("covers the SearchableSelect trigger (aria-haspopup=listbox)", () => {
    // The workspace's 3.25rem min-height once matched only input/select/
    // textarea/Button — SearchableSelect renders a plain <button>, so every
    // dropdown sat a head shorter than the field beside it.
    expect(css).toMatch(/button\[aria-haspopup="listbox"\]/);
  });

  it("covers the JalaliDatePicker trigger (aria-haspopup=dialog)", () => {
    expect(css).toMatch(/button\[aria-haspopup="dialog"\]/);
  });

  it("exempts checkboxes and radios, which a 3.25rem height misaligns", () => {
    expect(css).toMatch(
      /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
    );
    // The bare `input` selector must not survive alongside the guarded one.
    expect(css).not.toMatch(/^\s*\.workspace :global\(input\),\s*$/m);
  });

  it("still gives every control the same 3.25rem floor", () => {
    expect(css).toMatch(/min-height:\s*3\.25rem/);
  });
});

describe("the primitives keep the hooks the CSS rule targets", () => {
  // The workspace CSS reaches the trigger buttons *through* aria-haspopup.
  // If either primitive ever drops or renames the attribute, the selector
  // silently stops matching and the tiny-selects bug returns with no local
  // diff in the inventory folder — so the contract is pinned here.
  it("SearchableSelect's trigger declares aria-haspopup=listbox", () => {
    const src = readFileSync(
      join(SRC_DIR, "components/ui/searchable-select.tsx"),
      "utf8",
    );
    expect(src).toMatch(/aria-haspopup="listbox"/);
  });

  it("JalaliDatePicker's trigger declares aria-haspopup=dialog", () => {
    const src = readFileSync(
      join(SRC_DIR, "app/dashboard/jalali-date-picker.tsx"),
      "utf8",
    );
    expect(src).toMatch(/aria-haspopup="dialog"/);
  });
});

describe("low-stock banner removal", () => {
  const manager = read("inventory-manager.tsx");

  it("no longer renders the «هشدار کمبود موجودی» banner", () => {
    expect(manager).not.toContain("هشدار کمبود موجودی");
  });

  it("no longer fetches /api/inventory/low-stock or subscribes to its event", () => {
    // The section-level views (موجودی انبار filters, لیست انبارها badges)
    // own low stock now; the workspace shell must not re-grow its own copy.
    expect(manager).not.toContain("/api/inventory/low-stock");
    expect(manager).not.toContain("inventory.low_stock");
    expect(manager).not.toMatch(/\buseRealtime\b/);
    expect(manager).not.toMatch(/\bLowStockItem\b/);
  });
});

describe("select controls are the shared combobox", () => {
  it("no section renders a native <select>", () => {
    // A native <select> gets neither the type-to-filter of SearchableSelect
    // nor the workspace styling; the barcodes item picker was the last one.
    for (const [name, content] of sectionFiles()) {
      expect(content, `${name} still renders a native <select>`).not.toMatch(
        /<select[\s>]/,
      );
    }
  });
});

describe("responsive grids", () => {
  it("every arbitrary-value column template is breakpoint-gated", () => {
    // `grid-cols-[minmax(0,2fr)_…]` with no prefix is exactly the shape that
    // crushed the ثبت رسید/حواله item combobox on phones: the columns apply
    // at every width. A fixed template must only kick in from a breakpoint
    // (sm:/md:/lg:/xl:), leaving the base layout a stack.
    const ungated = /(?<![a-z]:)(?<!:)\bgrid-cols-\[/;
    for (const [name, content] of sectionFiles()) {
      for (const [index, line] of content.split("\n").entries()) {
        expect(
          ungated.test(line),
          `${name}:${index + 1} uses an un-gated fixed column template: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

describe("the redesigned line editors", () => {
  it("ثبت رسید/حواله: lines are labeled mini-cards below md, a grid from md up", () => {
    const form = read("document-form-section.tsx");
    // The header row naming the columns only exists where the columns do.
    expect(form).toMatch(/hidden md:grid/);
    // Each line starts as a single-column bordered card and only picks the
    // fixed template up at md; the per-field labels flip to sr-only there.
    expect(form).toMatch(/grid-cols-1[^"]*md:grid-cols-\[/);
    expect(form).toMatch(/md:sr-only/);
  });

  it("خرید: settlement and supplier pickers take a full mobile row (col-span-2)", () => {
    const purchases = read("purchases-section.tsx");
    const pickerRows = purchases.match(/col-span-2 grid min-w-0 gap-1/g) ?? [];
    expect(pickerRows.length).toBeGreaterThanOrEqual(2);
    // The old shape — a fixed min-width picker squeezed into half a 2-col
    // grid — must not return.
    expect(purchases).not.toMatch(/min-w-36 max-w-full gap-1/);
  });

  it("خرید: the row status is a StatusBadge, not a bare text node among buttons", () => {
    const purchases = read("purchases-section.tsx");
    expect(purchases).toMatch(/StatusBadge tone=\{STATUS_TONES\[p\.status\]\}/);
    expect(purchases).toMatch(/const STATUS_TONES/);
  });
});

describe("numeric fields", () => {
  it("no raw <input> carries a numeric/decimal inputMode — PersianNumberInput owns those", () => {
    // A raw numeric <input> can't show Persian digits or the thousands
    // separator; the invoice-OCR panel's quantity/amount fields were the
    // last two. Match each <input …> tag and reject numeric input modes.
    const inputTag = /<input\b[^>]*?(?:\/>|>)/gs;
    for (const [name, content] of sectionFiles()) {
      if (!name.endsWith(".tsx")) continue;
      for (const match of content.matchAll(inputTag)) {
        expect(
          /inputMode="(?:decimal|numeric)"/.test(match[0]),
          `${name} renders a raw numeric <input>; use PersianNumberInput: ${match[0].slice(0, 120)}`,
        ).toBe(false);
      }
    }
  });
});

describe("warehouse list responsive states", () => {
  it("uses a readable mobile card list instead of forcing a wide table through the phone", () => {
    // Both warehouse lists now render the desktop half through the shared
    // `DataTable` (which owns `overflow-x-auto` internally), so the assertion
    // is on the *behaviour* — a desktop-only table and a phone-only card list —
    // rather than on the wrapper's literal classes.
    const retail = readFileSync(
      join(SRC_DIR, "app/dashboard/stock/warehouses-section.tsx"),
      "utf8",
    );
    for (const source of [read("warehouses-section.tsx"), retail]) {
      expect(source).toMatch(/from "(?:@\/app\/dashboard|\.\.)\/data-table"/);
      expect(source).toMatch(/className="hidden border-0 md:block"/);
      expect(source).toMatch(/divide-y divide-border\/80 md:hidden/);
      expect(source).toMatch(/جستجو در انبارها/);
      expect(source).toMatch(/تلاش دوباره/);
      // The table must not also be visible on a phone.
      expect(source).not.toMatch(/<DataTable\b(?![\s\S]{0,200}?hidden)/);
    }
  });
});

describe("section spacing", () => {
  it("keeps the canonical space-y-4 sm:space-y-5 rhythm (no stray space-y-6 stacks)", () => {
    for (const [name, content] of sectionFiles()) {
      expect(content, `${name} reverts to the old space-y-6 stack`).not.toMatch(
        /className="space-y-6"/,
      );
    }
  });
});

describe("خرید — resilience and feedback (the silent-failure bugs)", () => {
  const purchases = read("purchases-section.tsx");

  it("the recent-purchases list never renders a silent blank: skeleton while null, message + retry on failure", () => {
    // Before: `purchases ?? []` meant a first load (or a failed one) left an
    // empty <ul> with no explanation and no way back.
    expect(purchases).toMatch(/purchases === null && !listError/);
    expect(purchases).toMatch(/LoadingSkeleton[^>]*label="در حال بارگذاری فهرست خریدها"/);
    expect(purchases).toMatch(/listError/);
    expect(purchases).toMatch(/تلاش دوباره/);
  });

  it("a cancelled purchase keeps its «مشاهده جزئیات» button (records stay inspectable)", () => {
    // Before: the details button was gated `p.status !== "cancelled"`, so a
    // cancelled purchase's contents were invisible unless deleted.
    expect(purchases).not.toMatch(/\{p\.status !== "cancelled" \? \(\s*<Button[^>]*onClick=\{\(\) => toggleExpanded/);
    // And the detail footer must not offer ویرایش/برگشت for a cancelled one —
    // it splits received (return) from cancelled (view-only).
    expect(purchases).toMatch(/خرید لغوشده فقط قابل مشاهده است/);
  });

  it("stale detail fetches are discarded (the cross-row race)", () => {
    // Expanding row A then quickly row B once let A's response render inside
    // B's panel. The request token pins the guard.
    expect(purchases).toMatch(/detailRequestRef/);
    expect(purchases).toMatch(/request !== detailRequestRef\.current/);
  });

  it("numeric fields refuse negative entry instead of failing server-side", () => {
    // Money/quantity PersianNumberInputs once defaulted allowNegative=true;
    // the server then answered with the generic «یکی از اقلام معتبر نیست».
    const negatives = purchases.match(/allowNegative=\{false\}/g) ?? [];
    expect(negatives.length).toBeGreaterThanOrEqual(3); // qty, amount, return qty
  });

  it("OCR apply asks before replacing hand-entered lines", () => {
    expect(purchases).toMatch(/draftHasContent/);
    expect(purchases).toMatch(/window\.confirm\("ردیف‌ها و یادداشت فعلی فرم/);
  });

  it("return quantities are validated client-side (truthy " + '"0"' + " and over-returns)", () => {
    expect(purchases).toMatch(/qty\.lte\(0\)/);
    expect(purchases).toMatch(/qty\.gt\(new Decimal\(String\(it\.returnable_quantity \?\? it\.quantity\)\)\)/);
  });

  it("the supplier-return idempotency key is minted once per form-open, not per attempt", () => {
    // Per-attempt Date.now keys defeat the server's duplicate answer: a
    // response lost after commit would post the return twice on retry.
    expect(purchases).not.toMatch(/idempotencyKey: `\$\{expandedId\}-\$\{Date\.now\(\)\}`/);
    expect(purchases).toMatch(/idempotencyKey: returnKey/);
  });

  it("action failures surface inside the section, not only above the tab rail", () => {
    expect(purchases).toMatch(/const \[localError, setLocalError\] = useState/);
    expect(purchases).toMatch(/<ErrorBox>\{localError\}<\/ErrorBox>/);
    const forwarded = purchases.match(/,\s*setLocalError,\s*\)/g) ?? [];
    expect(forwarded.length).toBeGreaterThanOrEqual(3); // submit, saveEdit, transition/return/delete
  });

  it("a silent no-op submit is impossible (empty/invalid lines explained)", () => {
    expect(purchases).toMatch(/function validatePayloadLines/);
    expect(purchases).toMatch(/حداقل یک ردیف با قلم و مقدار معتبر وارد کنید/);
  });

  it("an inverted date filter orders itself instead of matching nothing", () => {
    expect(purchases).toMatch(/function setFilterFrom\(value: string\)/);
    expect(purchases).toMatch(/function setFilterTo\(value: string\)/);
  });
});

describe("خرید — the OCR panel guards the picker's contracts", () => {
  const ocr = read("invoice-ocr-panel.tsx");

  it("an invoice date that is not ISO never reaches the JalaliDatePicker", () => {
    expect(ocr).toMatch(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/.test\(invoiceDate\)/);
  });

  it("review quantity/amount fields refuse negative entry", () => {
    const negatives = ocr.match(/allowNegative=\{false\}/g) ?? [];
    expect(negatives.length).toBeGreaterThanOrEqual(2);
  });
});

describe("خرید — the workspace runner can report to a section-level box", () => {
  const manager = read("food-service-inventory-manager.tsx");

  it("run() forwards the mapped message to an optional onError", () => {
    // The purchases section renders its own ErrorBox where the action lives;
    // without the callback its failures only showed above the rail.
    expect(manager).toMatch(/onError\?: \(message: string\) => void/);
    expect(manager).toMatch(/onError\?\.\(message\)/);
  });

  it("error map covers the codes the purchase flows raise", () => {
    for (const code of ["invalid_quantity", "fiscal_period_locked", "fiscal_period_soft_closed"]) {
      expect(manager, `missing ${code}`).toContain(`${code}:`);
    }
  });
});
