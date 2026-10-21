import { describe, expect, it } from "vitest";
import { renderKitchenTicketHtml, type KitchenTicketData } from "./kitchen-ticket-template";

const baseData: KitchenTicketData = {
  label: "میز ۳",
  orderTypeLabel: "حضوری",
  orderNumber: 234,
  roundNumber: 2,
  tableName: "میز ۳",
  sentAt: new Date("2024-03-21T10:00:00Z"),
  lines: [
    { name: "قهوه اسپرسو", quantity: 2, modifiersLabel: "شیر بادام", note: "بدون شکر" },
    { name: "کیک شکلاتی", quantity: 1 },
  ],
  orderNote: "مهمان آلرژی به گلوتن دارد",
};

describe("renderKitchenTicketHtml", () => {
  it("is a full RTL Persian HTML document", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="fa"');
  });

  it("includes the table/queue label, order type, and every line", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).toContain("میز ۳");
    expect(html).toContain("حضوری");
    expect(html).toContain("سفارش ۲۳۴");
    expect(html).toContain("نوبت ۲");
    expect(html).toContain("میز: میز ۳");
    expect(html).toContain("قهوه اسپرسو");
    expect(html).toContain("کیک شکلاتی");
  });

  it("shows quantities in Persian digits", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).toContain("۲×");
  });

  it("includes modifiers and per-line notes", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).toContain("شیر بادام");
    expect(html).toContain("بدون شکر");
  });

  it("includes the order-level note only when present", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).toContain("مهمان آلرژی به گلوتن دارد");
    const withoutNote = renderKitchenTicketHtml({ ...baseData, orderNote: null });
    expect(withoutNote).not.toContain("یادداشت سفارش");
  });

  it("never renders prices — kitchen tickets aren't a bill", () => {
    const html = renderKitchenTicketHtml(baseData);
    expect(html).not.toContain("تومان");
  });

  it("escapes HTML-significant characters", () => {
    const html = renderKitchenTicketHtml({ ...baseData, orderNote: "<b>x</b>" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
