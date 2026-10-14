import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The wiring invariants of «لیست محصولات» — the seams the pure unit suite
 * (`src/lib/product-list.test.ts`) cannot see. The repo's vitest runs in Node
 * with no jsdom and no `@testing-library` (see accounting-nav-rtl.test.ts),
 * so the interactions are pinned the way product-add-regressions.test.ts and
 * team-manager.test.ts pin theirs: against the section's source, which is the
 * same file the route renders. Every assertion here names a behaviour the
 * redesign was asked to keep or add — search, status filtering, KPI counts,
 * the numbered pager, and the stock/price write path.
 */

const here = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const SECTION = here("./products-list-section.tsx");
const PAGE = here("../../(app)/accounting/products/page.tsx");

describe("the products list keeps the shared-chrome contract", () => {
  it("composes the platform's KPI primitives rather than re-deriving tiles", () => {
    for (const marker of ["KpiRow", "KpiCard", "KpiRowSkeleton", "productKpis(items)"]) {
      expect(SECTION, `composes ${marker}`).toContain(marker);
    }
    // The four KPIs the board promises, fed by the shared counters.
    for (const label of ['label="کل محصولات"', 'label="موجود"', 'label="ناموجود"', 'label="غیر قابل فروش"']) {
      expect(SECTION).toContain(label);
    }
    // The approved design-system icons, not new glyph choices.
    for (const icon of ["PackageIcon", "CircleCheckIcon", "CircleXIcon", "BanIcon"]) {
      expect(SECTION).toContain(icon);
    }
  });

  it("keeps the table on the shared DataTable primitives with a status column", () => {
    expect(SECTION).toContain('from "@/app/dashboard/data-table"');
    expect(SECTION).toContain("<DataTable caption=");
    expect(SECTION).toContain("<Th>وضعیت</Th>");
    expect(SECTION).toContain("StatusBadge");
    expect(SECTION).toContain("productStatus(item)");
    // The panel row still spans the whole table, whatever the column count is.
    expect(SECTION).toMatch(/Td colSpan=\{PRODUCT_COLUMNS\}/);
    expect(SECTION).toMatch(/const PRODUCT_COLUMNS = 10/);
  });

  it("keeps the page header user-facing (no architecture phrasing)", () => {
    expect(PAGE).toContain('title="محصولات"');
    expect(PAGE).toContain("نمایش و مدیریت محصولات، موجودی، قیمت و اطلاعات فروش.");
    expect(PAGE).toContain("KnowledgeHelpButton");
    expect(PAGE).not.toContain("همان برد کالای صنف");
    expect(PAGE).toContain("<PageShell>");
    expect(PAGE).toContain("<PageHeader");
  });
});

describe("search and status filtering", () => {
  it("keeps the normalized search path and its placeholder", () => {
    for (const marker of [
      "normalizeListSearch(deferredSearch)",
      "variantSearchNeedles(item)",
      "variantMatchesNeedle(needles, needle)",
      "useDeferredValue(search)",
    ]) {
      expect(SECTION, `keeps ${marker}`).toContain(marker);
    }
    expect(SECTION).toContain('placeholder="جستجو در نام محصول، کد کالا یا بارکد…"');
    expect(SECTION).toContain('label="جستجوی محصول"');
  });

  it("offers the four status options on one compact dropdown", () => {
    expect(SECTION).toContain('value: "all", label: "همه وضعیت‌ها"');
    expect(SECTION).toContain('value: "in_stock", label: "موجود"');
    expect(SECTION).toContain('value: "out_of_stock", label: "ناموجود"');
    expect(SECTION).toContain('value: "non_sellable", label: "غیر قابل فروش"');
    expect(SECTION).toContain('aria-label="فیلتر وضعیت محصولات"');
  });

  it("combines search and status over the already-loaded list", () => {
    // The AND the reference asks for: «Gliss» + «موجود» = only in-stock Gliss.
    expect(SECTION).toContain("(!needle || variantMatchesNeedle(needles, needle)) &&");
    expect(SECTION).toContain("variantMatchesStatusFilter(item, statusFilter)");
    expect(SECTION).toMatch(/\$\{apiBase\}\/items`/);
  });

  it("returns the pager to the first page when the list narrows", () => {
    expect(SECTION).toContain(
      "useEffect(() => setPage(0), [deferredSearch, statusFilter, pageSize]);",
    );
  });

  it("exports the current filtered result through the shared CSV builder", () => {
    // …in the business's selected unit, like every other export.
    expect(SECTION).toContain("buildProductsCsv(filtered, money.unit)");
    expect(SECTION).toContain("دانلود CSV");
    expect(SECTION).toContain("const PAGE_SIZES = [10, 20, 50] as const;");
    expect(SECTION).toContain("ردیف در صفحه");
  });
});

describe("the numbered pager", () => {
  it("draws its window through the shared pageWindow helper", () => {
    expect(SECTION).toContain("pageWindow(safePage + 1, pageCount)");
  });

  it("keeps prev/next, the result summary and the active-page semantics", () => {
    expect(SECTION).toContain('aria-label="صفحه‌بندی لیست محصولات"');
    expect(SECTION).toContain('aria-label="صفحهٔ قبل"');
    expect(SECTION).toContain('aria-label="صفحهٔ بعد"');
    expect(SECTION).toContain('aria-current={active ? "page" : undefined}');
    expect(SECTION).toContain("نمایش {toPersianDigits(rangeStart)} تا {toPersianDigits(rangeEnd)}");
  });
});

describe("the stock/price write path survives the restyle", () => {
  it("still posts the receipt to the trade's own stock route", () => {
    expect(SECTION).toContain("${apiBase}/items/${item.id}/stock");
    expect(SECTION).toContain("quantity: quantityText || undefined");
    expect(SECTION).toContain("unitPrice: unitPriceText ? money.fromInput(Math.round(unitPriceValue ?? 0)) : undefined");
  });

  it("keeps the three fields on PersianNumberInput with the money unit", () => {
    expect(SECTION).toContain("<PersianNumberInput");
    expect(SECTION).toContain('label="تعداد ورودی"');
    expect(SECTION).toContain("بهای تمام‌شده هر واحد (${money.unitLabel})");
    expect(SECTION).toContain("قیمت فروش هر واحد (${money.unitLabel})");
  });

  it("keeps the client-side copies of the server's rules", () => {
    for (const message of [
      "تعداد ورودی یا قیمت فروش را وارد کنید.",
      "تعداد ورودی باید بزرگ‌تر از صفر باشد.",
      "بهای تمام‌شده برای ورود کالا لازم است.",
      "قیمت فروش نامعتبر است.",
    ]) {
      expect(SECTION).toContain(message);
    }
  });

  it("still surfaces the server's own validation text and coded failures", () => {
    expect(SECTION).toContain("data.message?.trim() || errorMessage(data.error)");
    expect(SECTION).toContain('role="alert"');
  });

  it("keeps the expanded-row affordances and the busy state", () => {
    expect(SECTION).toContain("aria-expanded={panelOpen}");
    expect(SECTION).toContain("aria-controls={`stock-panel-${item.id}`}");
    expect(SECTION).toContain("در حال ذخیره…");
    // The panel keeps its measured-width shell — narrow screens stay usable.
    expect(SECTION).toContain('closest("div.overflow-x-auto")');
    expect(SECTION).toContain("ResizeObserver");
  });
});

describe("the empty, filtered and failed states", () => {
  it("keeps the three recovery texts on the shared EmptyState", () => {
    expect(SECTION).toContain("<EmptyState>");
    expect(SECTION).toContain("کالایی ثبت نشده است؛ از «افزودن محصول» اولین کالا را ثبت کنید.");
    expect(SECTION).toContain('title="محصولی با این فیلتر پیدا نشد"');
    expect(SECTION).toContain("پاک کردن فیلترها");
    expect(SECTION).toContain("کالاها خوانده نشد؛ اتصال را بررسی کنید.");
    expect(SECTION).toContain("تلاش دوباره");
  });
});

describe("the section stays industry-agnostic", () => {
  it("addresses only the apiBase it was handed", () => {
    expect(SECTION).toContain("ProductsListSection({ apiBase }: { apiBase: string })");
    for (const industryPath of ["/api/cosmetics", "/api/accessories", "/api/wholesale", "/api/tools-fittings", "/api/haberdashery"]) {
      expect(SECTION, `must not hard-code ${industryPath}`).not.toContain(industryPath);
    }
  });
});
