// @vitest-environment jsdom

/**
 * `RetailInvoiceDetailModal` is the retail-only counterpart to
 * `OrderDetailModal` — this proves it renders from the dedicated
 * `getRetailInvoiceDetail` read model (not the café order shape) and that its
 * four tabs (فاکتور/پرداخت/حسابداری/اطلاعات) show what a shop invoice
 * actually has: gold breakdown, watch serial/warranty, tenders, and a link
 * to accounting rather than a duplicate ledger view.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetailInvoiceDetailModal } from "./retail-invoice-detail-modal";
import type { RetailInvoiceDetail } from "@/lib/retail-invoice/types";

const detail: RetailInvoiceDetail = {
  orderId: "order-1",
  orderNumber: 101,
  status: "completed",
  issuedAt: "2024-02-10T09:30:00.000Z",
  voidedReason: null,
  businessId: "biz-1",
  locationId: "loc-1",
  locationName: "شعبه مرکزی",
  cashierId: "user-1",
  cashierName: "زهرا احمدی",
  customer: { id: "cust-1", name: "مریم کریمی", phone: "09120000000" },
  note: null,
  lines: [
    {
      kind: "gold",
      orderItemId: "oi-1",
      itemId: "item-1",
      nameSnapshot: "انگشتر طلا",
      quantity: "1",
      gross: "10000000",
      manualDiscount: "0",
      promotionDiscount: "0",
      discount: "0",
      vat: "300000",
      net: "10000000",
      total: "10300000",
      netWeight: "3.500",
      purity: "18",
      pricePerGram: 2_500_000,
      priceDate: "2024-02-10",
      makingChargeType: "percent",
      makingChargeValue: 7,
      profitPercent: 7,
      metalValue: "8750000",
      makingCharge: "612500",
      profit: "637500",
      consigned: false,
    },
  ],
  subtotal: 10_000_000,
  discount: 0,
  tax: 300_000,
  total: 10_300_000,
  payments: [
    {
      id: "p1",
      method: "cash",
      methodLabel: "نقدی",
      amount: 10_300_000,
      reference: null,
      paymentMethodId: null,
      receivedAt: "2024-02-10T09:30:00.000Z",
    },
  ],
  paidTotal: 10_300_000,
  balanceDue: 0,
  overpaid: 0,
  creditTotal: 0,
  currencyUnit: "toman",
  integration: { holooQueued: false, holooSynced: false },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/sales/invoices/")) {
        return new Response(JSON.stringify({ invoice: detail }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("RetailInvoiceDetailModal", () => {
  it("does not fetch anything while closed", () => {
    render(<RetailInvoiceDetailModal invoiceId={null} open={false} onOpenChange={() => {}} />);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads the retail read model, not a generic order shape, and shows the invoice number", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    expect(fetch).toHaveBeenCalledWith("/api/sales/invoices/order-1", expect.anything());
    expect(screen.getByText(/فاکتور ۱۰۱/)).toBeTruthy();
  });

  it("shows a gold line's real weight, purity and price breakdown on the فاکتور tab", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    expect(screen.getByText("انگشتر طلا")).toBeTruthy();
    expect(screen.getByText(/عیار ۱۸/)).toBeTruthy();
    expect(screen.getByText(/۳\.۵۰۰ گرم/)).toBeTruthy();
  });

  it("shows the tender and amount on the پرداخت tab", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    const paymentTab = screen.getByRole("tab", { name: "پرداخت" });
    await userEvent.click(paymentTab);
    const panel = screen.getByRole("tabpanel", { name: "پرداخت" });
    expect(within(panel).getByText("نقدی")).toBeTruthy();
  });

  it("links the حسابداری tab to the accounting entries section instead of duplicating the ledger", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    const accountingTab = screen.getByRole("tab", { name: "حسابداری" });
    await userEvent.click(accountingTab);
    const panel = screen.getByRole("tabpanel", { name: "حسابداری" });
    const link = within(panel).getByRole("link", { name: /ثبت‌های دفتر روزنامه/ });
    expect(link.getAttribute("href")).toContain("entries");
  });

  it("keeps every tab at the app's own touch-target floor and lets a long label wrap instead of overlapping its neighbour", async () => {
    // The shared <TabsList> defaults to a 32px-tall single-line strip — fine
    // for a mouse, but this is the one screen that turns it into a hand-held
    // four-way switch at 390px wide. Below the app's own ~40px floor, and
    // with `whitespace-nowrap` and four equal columns, «حسابداری» — the
    // longest of the four labels — has nowhere to go but over its neighbour.
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();

    for (const name of ["فاکتور", "پرداخت", "حسابداری", "اطلاعات"]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.className).toContain("min-h-10");
      expect(tab.className).toContain("whitespace-normal");
    }
  });

  it("shows the customer and cashier on the اطلاعات tab", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    const infoTab = screen.getByRole("tab", { name: "اطلاعات" });
    await userEvent.click(infoTab);
    const panel = screen.getByRole("tabpanel", { name: "اطلاعات" });
    expect(within(panel).getByText("مریم کریمی")).toBeTruthy();
    expect(within(panel).getByText("زهرا احمدی")).toBeTruthy();
  });
});

describe("RetailInvoiceDetailModal — void", () => {
  it("shows no void button without canVoid, even on a completed invoice", async () => {
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} />);
    await flush();
    expect(screen.queryByRole("button", { name: /ابطال فاکتور/ })).toBeNull();
  });

  it("shows no void button on an already-voided invoice, even with canVoid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ invoice: { ...detail, status: "voided", voidedReason: "اشتباه صندوقدار" } }), {
          status: 200,
        }),
      ),
    );
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} canVoid />);
    await flush();
    expect(screen.queryByRole("button", { name: /ابطال فاکتور/ })).toBeNull();
    expect(screen.getByText("باطل‌شده")).toBeTruthy();
  });

  it("does nothing if the reason prompt is cancelled", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} canVoid />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: /ابطال فاکتور/ }));
    await flush();
    // Only the one initial GET — no POST was attempted.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("posts the reason, shows the server's Persian refusal, and never touches the order on failure", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("اشتباه صندوقدار");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: "void_failed",
            message: "این فاکتور شامل کالای طلا/سریال‌دار است و به دلیل وضعیت نهایی فروش، ابطال خودکار امکان‌پذیر نیست.",
          }),
          { status: 409 },
        );
      }
      return new Response(JSON.stringify({ invoice: detail }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} canVoid />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: /ابطال فاکتور/ }));
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sales/invoices/order-1/void",
      expect.objectContaining({ method: "POST" }),
    );
    // Still shows completed — a refused void never flips the badge.
    expect(screen.getByText("تکمیل‌شده")).toBeTruthy();
  });

  it("on success, refetches the invoice and calls onVoided so the list behind it refreshes", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("اشتباه صندوقدار");
    let voided = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        voided = true;
        return new Response(JSON.stringify({ ok: true, amendmentId: "amend-1", reversedEntryIds: [] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          invoice: voided ? { ...detail, status: "voided", voidedReason: "اشتباه صندوقدار" } : detail,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const onVoided = vi.fn();

    render(<RetailInvoiceDetailModal invoiceId="order-1" open onOpenChange={() => {}} canVoid onVoided={onVoided} />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: /ابطال فاکتور/ }));
    await flush();

    expect(onVoided).toHaveBeenCalledTimes(1);
    expect(screen.getByText("باطل‌شده")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ابطال فاکتور/ })).toBeNull();
  });
});
