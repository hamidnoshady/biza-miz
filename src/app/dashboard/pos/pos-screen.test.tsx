// @vitest-environment jsdom

/**
 * `PosScreen` checkout: issue #913 items 5 and 7.
 *
 * - P1-5: confirmation is SERVER-priced — the screen's preview only stands in
 *   when the order was queued — and a split that was exact against the stale
 *   preview is rebuilt against the server's due, surfacing
 *   `payment_total_mismatch` instead of ever POSTing the stale tender body.
 * - P1-7: the payment step itself refuses invalid, negative, zero, overflowed
 *   and half-typed Persian-numeral entries — no order is created behind a
 *   figure the cashier never successfully entered.
 *
 * Time is faked for the whole file (same discipline as
 * retail-invoice-screen.test.tsx): `HoldToConfirmButton` reads one clock
 * (`performance.now()` via `requestAnimationFrame`), so both must be faked
 * together or the hold either never completes or completes instantly.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatMoney } from "@/lib/money";
import { errorMessage } from "@/app/dashboard/ui";
import { PosScreen } from "./pos-screen";

const toastWarning = vi.fn();
const toastInfo = vi.fn();
const toastSuccess = vi.fn();

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
  pathname: "/dashboard/pos",
  query: {},
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard/pos",
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    warning: (...args: unknown[]) => toastWarning(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastWarning(...args),
  },
}));

const printKitchenTicket = vi.fn(
  async (
    _printerId: string | null,
    _orderId: string,
    _opts?: { requestId?: string; title?: string },
  ) => ({ ok: true, supportsDrawer: false, printerId: undefined }),
);
const printSaleReceipt = vi.fn(
  async (
    _printerId: string | null,
    _orderId: string,
    _opts?: { requestId?: string; title?: string },
  ) => ({ ok: true, supportsDrawer: false, printerId: undefined }),
);
const kickDrawer = vi.fn(async (_printerId: string) => undefined);
vi.mock("@/lib/printing/client", () => ({
  printKitchenTicket: (
    printerId: string | null,
    orderId: string,
    opts?: { requestId?: string; title?: string },
  ) => printKitchenTicket(printerId, orderId, opts),
  printSaleReceipt: (
    printerId: string | null,
    orderId: string,
    opts?: { requestId?: string; title?: string },
  ) => printSaleReceipt(printerId, orderId, opts),
  kickDrawer: (printerId: string) => kickDrawer(printerId),
}));

/**
 * The till reads the offline queue but never writes it in these flows; the
 * real hook requires `OfflineQueueProvider` (and its Dexie/IndexedDB store,
 * which jsdom has no API for). `apiOrQueue` itself stays real — it only falls
 * back to the queue when fetch() throws, which the stub below never does.
 */
vi.mock("@/app/dashboard/offline-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/offline-queue")>();
  const useOfflineQueue = () => ({
    pendingCount: 0,
    isOnline: true,
    connectionState: {
      localServer: "local_server_connected" as const,
      internet: "internet_unknown" as const,
      cloudSync: "cloud_sync_not_configured" as const,
      pendingActions: 0,
      syncError: false,
      syncFault: null,
      attentionNeeded: 0,
      pairingPending: false,
    },
    entries: [],
    serverStatus: null,
  });
  return { ...actual, useOfflineQueue: useOfflineQueue as typeof actual.useOfflineQueue };
});

const CASH_METHOD = {
  id: "pm-cash",
  code: "cash",
  name: "نقدی",
  settlement: "cash",
  sortOrder: 0,
  isActive: true,
  isBuiltin: true,
  opensDrawer: false,
  requiresReference: false,
};

const BANK_METHOD = {
  id: "pm-card",
  code: "card",
  name: "کارت‌خوان",
  settlement: "card",
  sortOrder: 1,
  isActive: true,
  isBuiltin: true,
  opensDrawer: false,
  requiresReference: false,
};

/** Table service and delivery both off → the till falls back to takeaway, no table question. */
const BUSINESS_INFO = {
  name: "کافهٔ آزمایشی",
  address: null,
  phone: null,
  features: { reservations: false, delivery: false },
};

const MENU_PAYLOAD = {
  categories: [
    { id: "cat-1", name: "نوشیدنی", tax_rate: 0, sort_order: 1, is_active: true },
  ],
  items: [
    {
      id: "item-1",
      category_id: "cat-1",
      name: "چای ساده",
      description: null,
      sku: null,
      price: 500_000, // Rial — the preview's whole total (no tax, no discount)
      image_url: null,
      image_media_id: null,
      sort_order: 1,
      is_active: true,
      target_margin_percent: null,
    },
  ],
  modifierGroups: [],
  modifiers: [],
  itemModifierGroups: [],
};

const PREVIEW_TOTAL = 500_000; // Rial, from the menu price alone
const SERVER_TOTAL = 555_000; // Rial — the server re-priced the sale

const ORDER_RESPONSE = {
  orderNumber: 11,
  id: "ord-1",
  totals: { subtotal: PREVIEW_TOTAL, discount: 0, tax: 0, total: SERVER_TOTAL },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const ordersPost = vi.fn(async (_url: string, _init?: RequestInit) => json(ORDER_RESPONSE));
const payPost = vi.fn(async (_url: string, _init?: RequestInit) => json({}));

beforeEach(() => {
  // jsdom implements neither scrollIntoView (the search auto-scroll) nor
  // pointer capture (Radix dialogs) — same shims as cheques-section.test.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  vi.useFakeTimers();
  toastWarning.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  printKitchenTicket.mockClear();
  printSaleReceipt.mockClear();
  kickDrawer.mockClear();
  ordersPost.mockClear();
  ordersPost.mockImplementation(async () => json(ORDER_RESPONSE));
  payPost.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(url).endsWith("/pay")) return payPost(url, init);
      if (init?.method === "POST" && url === "/api/orders") return ordersPost(url, init);
      if (String(url).includes("/api/business-info")) return json(BUSINESS_INFO);
      if (String(url).includes("/api/menu")) return json(MENU_PAYLOAD);
      if (String(url).includes("/api/payment-methods"))
        return json({ paymentMethods: [CASH_METHOD, BANK_METHOD] });
      if (String(url).includes("/api/health")) return json({ ok: true });
      if (String(url).includes("/api/connection/status")) return json({ ok: true, online: true });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Flushes the microtask queue (pending `api()`/`fetch` promises) under fake timers. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Polls a synchronous check by flushing microtasks — a `waitFor`-alike that
 * works under globally-faked timers, where `@testing-library`'s own `waitFor`
 * (real `setTimeout`-driven) would just hang until the test's own timeout.
 */
async function flushUntil(check: () => void, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      check();
      return;
    } catch {
      await flush();
    }
  }
  check(); // last attempt — let its real assertion error surface
}

function press(element: Element) {
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
  });
}

function release(element: Element) {
  act(() => {
    element.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Renders the till and waits for the menu to land. */
async function renderAndLoad() {
  render(<PosScreen />);
  await flushUntil(() => {
    if (screen.queryAllByText("چای ساده").length === 0)
      throw new Error("menu item not rendered yet");
  });
}

async function addTea() {
  fireEvent.click(screen.getAllByText("چای ساده")[0]);
  await flush();
}

/** Opens the payment review («دریافت وجه و تکمیل» → «تأیید دریافت وجه» dialog). */
async function openPaymentReview() {
  fireEvent.click(screen.getByRole("button", { name: "دریافت وجه و تکمیل" }));
  await flushUntil(() => {
    if (!screen.queryByText("تأیید دریافت وجه")) throw new Error("review not open yet");
  });
}

/**
 * Full 4-second hold of the payment button. `HoldToConfirmButton` is one-shot
 * per mount, so a retry in these tests must close and reopen the review (the
 * button remounts; the draft and the cart stay).
 */
async function holdPayment() {
  const button = screen.getByRole("button", { name: /ثبت پرداخت/ });
  press(button);
  advance(4500);
  release(button);
  await flush();
}

function postCount(): number {
  return ordersPost.mock.calls.length;
}

/**
 * One message can legitimately render in several boxes at once (the `error`
 * state is mirrored into the layout's ErrorBoxes and the review dialog's), so
 * presence checks count matches instead of demanding a unique element —
 * jest-dom's matchers aren't loaded in this suite.
 */
function shown(text: string | RegExp): boolean {
  return screen.queryAllByText(text).length > 0;
}

describe("PosScreen checkout — server-priced confirmation (issue #913 item 5)", () => {
  it("shows the SERVER's total on the confirmation and says the price moved", async () => {
    await renderAndLoad();
    await addTea();

    fireEvent.click(screen.getByRole("button", { name: "ثبت سفارش باز (بدون دریافت وجه)" }));
    await flushUntil(() => {
      if (!screen.queryByText("سفارش باز ثبت شد")) throw new Error("confirmation not shown yet");
    });

    // The number the cashier reads back is the server's — not the preview's.
    await flushUntil(() => {
      if (!shown(formatMoney(SERVER_TOTAL, "toman"))) throw new Error("server total not shown yet");
    });
    expect(shown(formatMoney(SERVER_TOTAL, "toman"))).toBe(true);
    const notice = screen.queryAllByText(/مبلغ نهایی با قیمت به‌روزِ سرور/)[0];
    expect(notice).toBeDefined();
    expect(notice!.textContent).toContain(formatMoney(PREVIEW_TOTAL, "toman"));
    expect(notice!.textContent).toContain(formatMoney(SERVER_TOTAL, "toman"));

    expect(postCount()).toBe(1);
    expect(payPost).not.toHaveBeenCalled();
    const submitted = JSON.parse(String(ordersPost.mock.calls[0][1]?.body)) as {
      clientRequestId: string;
      items: { menuItemId: string; quantity: number }[];
    };
    expect(submitted.clientRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(submitted.items).toHaveLength(1);
    expect(submitted.items[0]).toMatchObject({ menuItemId: "item-1", quantity: 1 });
    // Printing is dispatched transactionally by POST /api/orders. The POS
    // must not also call the physical printer and create a duplicate ticket.
    expect(printKitchenTicket).not.toHaveBeenCalled();
  });

  it("rebuilds a split against the server's due: payment_total_mismatch, and no stale body is ever POSTed", async () => {
    await renderAndLoad();
    await addTea();
    await openPaymentReview();

    // A split exact against the SCREEN's total: 40,000t cash + 10,000t card.
    fireEvent.click(screen.getByRole("button", { name: "تقسیم بین چند روش" }));
    await flush();
    const tender0 = document.getElementById("pos-checkout-tender-0") as HTMLInputElement;
    expect(tender0).not.toBeNull();
    fireEvent.change(tender0, { target: { value: "40000" } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "کارت‌خوان" }));
    await flush();
    // The second slice is pre-filled with what is still owed — 10,000t here.
    const tender1 = document.getElementById("pos-checkout-tender-1") as HTMLInputElement;
    expect(tender1).not.toBeNull();
    expect(tender1.value).toContain("۱۰");

    await holdPayment();
    await flushUntil(() => {
      if (!screen.queryByText("سفارش ثبت شد؛ پرداخت تکمیل نشد"))
        throw new Error("flagged confirmation not shown yet");
    });

    // The initial body (against the preview) was valid, so the order exists…
    expect(postCount()).toBe(1);
    // …but the stale split never reached the server: the confirmation carries
    // the rebuilt refusal instead of a silent absorption of the difference.
    expect(payPost).not.toHaveBeenCalled();
    expect(shown(errorMessage("payment_total_mismatch"))).toBe(true);
    expect(shown(formatMoney(SERVER_TOTAL, "toman"))).toBe(true);
    const notice = screen.queryAllByText(/مبلغ نهایی با قیمت به‌روزِ سرور/)[0];
    expect(notice).toBeDefined();
    expect(notice!.textContent).toContain(formatMoney(SERVER_TOTAL, "toman"));
  });
});

describe("PosScreen checkout — the UI refuses unusable received amounts (issue #913 item 7)", () => {
  it("blocks invalid, negative, zero, overflow and half-typed Persian numeral input — no order is created", async () => {
    await renderAndLoad();
    await addTea();
    await openPaymentReview();

    fireEvent.click(screen.getByRole("button", { name: "مبلغ دریافتی" }));
    await flush();

    const badEntries: Array<{ typed: string; why: string }> = [
      { typed: "-۵۰", why: "negative" },
      { typed: "0", why: "zero" },
      { typed: "99999999999999999", why: "overflow" },
      { typed: "12.", why: "half-typed decimal" },
      { typed: "٫۵۰", why: "half-typed Persian decimal" },
    ];

    for (let index = 0; index < badEntries.length; index += 1) {
      const input = document.getElementById("pos-checkout-received") as HTMLInputElement;
      expect(input).not.toBeNull();
      // Reopening the review runs `startCheckout`, which clears the previous
      // attempt's error — so the assertion below is about THIS entry only.
      expect(shown(errorMessage("invalid_received_amount"))).toBe(false);

      fireEvent.change(input, { target: { value: badEntries[index].typed } });
      await flush();
      await holdPayment();

      await flushUntil(() => {
        if (!shown(errorMessage("invalid_received_amount")))
          throw new Error(`no refusal for ${badEntries[index].why}`);
      });
      // Still in the review, the refusal on screen, and not one byte sent.
      expect(shown("تأیید دریافت وجه")).toBe(true);
      expect(postCount()).toBe(0);

      if (index < badEntries.length - 1) {
        // The hold button is one-shot per mount — step out and back in to
        // remount it; the cart and the manual-amount panel persist.
        fireEvent.click(screen.getByRole("button", { name: "بازگشت" }));
        await flush();
        await openPaymentReview();
      }
    }

    expect(postCount()).toBe(0);
    expect(payPost).not.toHaveBeenCalled();
  });
});
