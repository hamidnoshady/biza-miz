import { describe, expect, it } from "vitest";
import {
  renderReportLedgerHtml,
  renderReportTableHtml,
  type ReportPdfLedgerData,
  type ReportPdfTableData,
} from "./report-pdf-template";

const business = { name: "کافه نمونه", address: "تهران، خیابان ولیعصر", phone: "02112345678" };

describe("renderReportTableHtml", () => {
  const baseData: ReportPdfTableData = {
    business,
    title: "خلاصه فروش روزانه",
    generatedAt: new Date("2026-03-21T10:00:00Z"),
    filterSummary: "از ۱۴۰۴/۰۱/۰۱ تا ۱۴۰۴/۰۱/۳۱",
    columns: [
      { key: "day", label: "روز" },
      { key: "total", label: "جمع" },
    ],
    rows: [{ day: "2026-01-01", total: 220000 }],
  };

  it("is a full RTL Persian HTML document with the business header and title", () => {
    const html = renderReportTableHtml(baseData);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("کافه نمونه");
    expect(html).toContain("خلاصه فروش روزانه");
    expect(html).toContain("از ۱۴۰۴/۰۱/۰۱ تا ۱۴۰۴/۰۱/۳۱");
  });

  it("renders column headers and row cells with Shamsi date labels", () => {
    const html = renderReportTableHtml(baseData);
    expect(html).toContain("<th>روز</th>");
    expect(html).toContain("<th>جمع</th>");
    // Issue #819: a reporting view's date column is `YYYY-MM-DD` text, so the
    // PDF showed Gregorian while the screen showed Shamsi.
    expect(html).toContain("۱۴۰۴/۱۰/۱۱");
  });

  it("escapes HTML in cell values", () => {
    const data: ReportPdfTableData = { ...baseData, rows: [{ day: "<script>", total: 1 }] };
    const html = renderReportTableHtml(data);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows a placeholder row when there are no rows", () => {
    const html = renderReportTableHtml({ ...baseData, rows: [] });
    expect(html).toContain("داده‌ای یافت نشد.");
  });
});

describe("renderReportLedgerHtml", () => {
  const data: ReportPdfLedgerData = {
    business,
    title: "صورت سود و زیان",
    generatedAt: new Date("2026-03-21T10:00:00Z"),
    periodLabel: "از ۱۴۰۴/۰۱/۰۱ تا ۱۴۰۴/۰۱/۳۱",
    sections: [
      {
        heading: "درآمدها",
        rows: [{ code: "4300", name: "فروش", amount: 2_200_000 }],
        totalLabel: "جمع درآمدها",
        totalAmount: 2_200_000,
      },
      {
        heading: "هزینه‌ها",
        rows: [{ code: "5300", name: "اجاره", amount: 500_000_000 }],
        totalLabel: "جمع هزینه‌ها",
        totalAmount: 500_000_000,
      },
    ],
    grandTotalLabel: "سود (زیان) خالص",
    grandTotalAmount: -497_800_000,
  };

  it("renders each section with its own heading and total", () => {
    const html = renderReportLedgerHtml(data);
    expect(html).toContain("درآمدها");
    expect(html).toContain("هزینه‌ها");
    expect(html).toContain("جمع درآمدها");
    expect(html).toContain("جمع هزینه‌ها");
    expect(html).toContain("فروش");
    expect(html).toContain("اجاره");
  });

  it("formats amounts as Toman with Persian digits", () => {
    const html = renderReportLedgerHtml(data);
    expect(html).toContain("تومان");
    expect(html).toMatch(/[۰-۹]/);
  });

  it("shows a placeholder for an empty section", () => {
    const html = renderReportLedgerHtml({
      ...data,
      sections: [{ heading: "درآمدها", rows: [], totalLabel: "جمع", totalAmount: 0 }],
    });
    expect(html).toContain("بدون سطر");
  });
});
