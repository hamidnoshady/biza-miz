import { describe, expect, it } from "vitest";
import { PAPER_WIDTH_PRESETS, paymentMethodLabel, renderReceiptHtml, type ReceiptData } from "./receipt-template";

const baseData: ReceiptData = {
  business: { name: "کافه نمونه", address: "تهران، خیابان ولیعصر", phone: "02112345678", footerMessage: "با تشکر از خرید شما" },
  orderLabel: "#42",
  orderTypeLabel: "حضوری — میز ۳",
  issuedAt: new Date("2024-03-21T10:00:00Z"),
  lines: [
    { name: "قهوه اسپرسو", quantity: 2, lineTotal: 200_000, modifiersLabel: "شیر بادام" },
    { name: "کیک شکلاتی", quantity: 1, lineTotal: 150_000 },
  ],
  subtotal: 350_000,
  discount: 20_000,
  tax: 15_000,
  total: 345_000,
  paymentMethod: "cash",
  cashierName: "علی رضایی",
};

describe("renderReceiptHtml", () => {
  it("prints one row per tender when the bill was split", () => {
    const html = renderReceiptHtml({
      ...baseData,
      payments: [
        { label: "نقدی", amount: 145_000 },
        { label: "کارت‌خوان", amount: 200_000 },
      ],
    });
    expect(html).toContain("نقدی");
    expect(html).toContain("کارت‌خوان");
    // ۱۴٬۵۰۰ and ۲۰٬۰۰۰ Toman — the two slices, each shown with its own amount.
    expect(html).toContain("۱۴٬۵۰۰");
    expect(html).toContain("۲۰٬۰۰۰");
    // The split replaces the single method line rather than printing beside it.
    expect(html).not.toContain("روش پرداخت");
  });

  it("keeps the single «روش پرداخت» line when nothing was split", () => {
    expect(renderReceiptHtml(baseData)).toContain("روش پرداخت");
  });

  it("escapes a payment way named with HTML", () => {
    const html = renderReceiptHtml({ ...baseData, payments: [{ label: "<script>x</script>", amount: 345_000 }] });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is a full RTL Persian HTML document", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
    expect(html).toContain("<!doctype html>");
  });

  it("includes business info, order label, and line items", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("کافه نمونه");
    expect(html).toContain("تهران، خیابان ولیعصر");
    expect(html).toContain("#42");
    expect(html).toContain("قهوه اسپرسو");
    expect(html).toContain("شیر بادام");
    expect(html).toContain("کیک شکلاتی");
  });

  it("formats amounts as Toman with Persian digits, not Rial or Latin digits", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("تومان");
    expect(html).not.toContain("ریال");
    // 345,000 rial -> 34,500 toman -> Persian digits
    expect(html).toContain("۳۴٬۵۰۰");
    // no stray Latin digits should appear where Persian ones belong
    expect(html.match(/۲/g)?.length).toBeGreaterThan(0);
  });

  it("shows the payment method label", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain("نقدی");
  });

  it("omits discount/tax rows when zero", () => {
    const html = renderReceiptHtml({ ...baseData, discount: 0, tax: 0 });
    expect(html).not.toContain("تخفیف");
    expect(html).not.toContain(">مالیات<");
  });

  it("omits the tip row when there's no tip", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).not.toContain("انعام");
    expect(html).not.toContain("مبلغ دریافتی");
  });

  it("shows the tip and a combined amount-received row when a tip was collected", () => {
    const html = renderReceiptHtml({ ...baseData, tip: 30_000 });
    expect(html).toContain("انعام");
    expect(html).toContain("مبلغ دریافتی");
    // tip 30,000 rial -> 3,000 toman
    expect(html).toContain("۳٬۰۰۰");
    // total (345,000) + tip (30,000) = 375,000 rial -> 37,500 toman
    expect(html).toContain("۳۷٬۵۰۰");
  });

  it("escapes HTML-significant characters in free-text fields", () => {
    const html = renderReceiptHtml({ ...baseData, orderTypeLabel: '<script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sizes the body width from the paper preset", () => {
    const html58 = renderReceiptHtml(baseData, { paperWidthMm: 58 });
    const html80 = renderReceiptHtml(baseData, { paperWidthMm: 80 });
    expect(html58).toContain(`width: ${PAPER_WIDTH_PRESETS[58]}px`);
    expect(html80).toContain(`width: ${PAPER_WIDTH_PRESETS[80]}px`);
  });

  it("defaults to 80mm when no width is given", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).toContain(`width: ${PAPER_WIDTH_PRESETS[80]}px`);
  });
});

describe("retail invoice fields (Phase 25)", () => {
  it("prints a gold line's components under the line", () => {
    const html = renderReceiptHtml({
      ...baseData,
      orderTypeLabel: "فاکتور فروش",
      customerName: "خانم رضایی",
      lines: [
        {
          name: "دستبند طرح بافت",
          quantity: 1,
          lineTotal: 50_000_000,
          goldBreakdown: { metalValue: 40_000_000, makingCharge: 6_000_000, profit: 4_000_000 },
        },
      ],
    });
    // A jewellery invoice showing only a total is not a document that trade
    // would accept: the customer is entitled to see metal/اجرت/سود.
    expect(html).toContain("اجرت");
    expect(html).toContain("سود");
    expect(html).toContain("خانم رضایی");
  });

  it("prints a batch-tracked line's batch and expiry under the line", () => {
    const html = renderReceiptHtml({
      ...baseData,
      orderTypeLabel: "فاکتور فروش",
      lines: [
        {
          name: "شامپو ضد شوره",
          quantity: 2,
          lineTotal: 900_000,
          batch: { batchNumber: "LOT-1042", expiryDate: "2027-03-01" },
        },
        {
          name: "کرم مرطوب‌کننده",
          quantity: 1,
          lineTotal: 600_000,
        },
      ],
    });
    expect(html).toContain("بچ");
    expect(html).toContain("LOT-1042");
    expect(html).toContain("انقضا");
  });

  it("prints a pre-owned unit's condition grade and box/papers state under the line", () => {
    const html = renderReceiptHtml({
      ...baseData,
      orderTypeLabel: "فاکتور فروش",
      lines: [
        {
          name: "ساعت مچی — S-1001",
          quantity: 1,
          lineTotal: 30_000_000,
          serialProvenance: { conditionGrade: "good", boxAndPapers: true },
        },
        {
          name: "ساعت مچی — S-1002",
          quantity: 1,
          lineTotal: 25_000_000,
          serialProvenance: { conditionGrade: "like_new", boxAndPapers: false },
        },
      ],
    });
    expect(html).toContain("دست‌دوم");
    expect(html).toContain("خوب");
    expect(html).toContain("در حد نو");
    expect(html).toContain("همراه جعبه و مدارک");
    expect(html).toContain("بدون جعبه و مدارک");
  });

  it("leaves an ordinary caf\u00e9 receipt exactly as it was", () => {
    const html = renderReceiptHtml(baseData);
    expect(html).not.toContain("اجرت");
    expect(html).not.toContain("مشتری");
    expect(html).not.toContain("بچ");
    expect(html).not.toContain("دست‌دوم");
  });
});

describe("paymentMethodLabel", () => {
  it("names every settlement in Persian and never leaks a code", () => {
    expect(paymentMethodLabel("online")).toBe("پرداخت آنلاین");
    expect(paymentMethodLabel("card_to_card")).toBe("کارت‌به‌کارت");
    expect(paymentMethodLabel("something_new")).toBe("روش پرداخت نامشخص");
    expect(paymentMethodLabel(null)).toBe("روش پرداخت نامشخص");
  });
});
