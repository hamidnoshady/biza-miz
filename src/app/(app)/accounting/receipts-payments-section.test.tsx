// @vitest-environment jsdom
/**
 * Issue #829 — the parts of «دریافت و پرداخت» that are *wiring*, not rules.
 *
 * The register's contract (cursor pagination, the same filters on the list
 * and the export, the export cap, the posting-account tolerance) is proven
 * against a real database in `integration/receipts-payments-list`. What no
 * API test can prove is whether the screen actually speaks it: whether the
 * «فیلترهای بیشتر» panel puts its fields on the list URL, whether the
 * download button asks for the filtered export (not the visible page) and
 * repeats the server's truncation warning instead of swallowing it, whether
 * a failed option-list fetch degrades to disabled pickers with a retry
 * rather than a broken panel, and whether the drill-down links the party
 * and the posted journal entry. Each of those lives in JSX, so each is
 * tested here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MoneyProvider } from "@/components/money/money-context";
import { jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import { ReceiptsPaymentsSection } from "./receipts-payments-section";

vi.mock("next/link", () => ({
  // The drill-down asserts hrefs, not client-side navigation.
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const ENTRY_ID = "33333333-3333-4333-8333-333333333333";
const BRANCH_ID = "44444444-4444-4444-8444-444444444444";
const CASH_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";

const ROW = {
  id: RECEIPT_ID,
  date: "2026-10-01",
  method: "cash",
  amount: 5000000,
  memo: "بابت فاکتور ۱۲",
  partyName: "علی رضایی",
  voucherNumber: 7,
  reversedAt: null,
  bankReference: null,
  cashAccount: { code: "1100", name: "صندوق" },
  locationName: null,
};

const DETAIL = {
  ...ROW,
  receiptDate: "2026-10-01",
  customerId: CUSTOMER_ID,
  customerName: "علی رضایی",
  locationName: "شعبهٔ مرکزی",
  createdByName: "حسابدار",
  createdAt: "2026-10-01T09:30:00.000Z",
  entryId: ENTRY_ID,
  reversedAt: null,
  reversalEntryId: null,
  reversalDate: null,
  reversedByName: null,
};

const DIRECTORY = { customers: [{ customerId: CUSTOMER_ID, customerName: "علی رضایی", customerPhone: null }] };
const SUPPLIERS = { suppliers: [{ supplierId: CUSTOMER_ID, supplierName: "تأمین چاپ", supplierPhone: null }] };
const FILTER_OPTIONS = { locations: [{ id: BRANCH_ID, name: "شعبهٔ مرکزی" }] };
const CHART = {
  accounts: [
    { id: CASH_ACCOUNT_ID, code: "1100", name: "صندوق", type: "asset", parent_code: null },
    { id: "66666666-6666-4666-8666-666666666666", code: "1200", name: "حساب‌های دریافتنی", type: "asset", parent_code: null },
  ],
};

/**
 * Answers the register's GETs. `breakOptions` fails the two pickers' sources
 * (branches + chart) while the list and directory stay healthy, so a test can
 * fail the panel alone; every call's URL is recorded on the mock.
 */
function serve(options: { breakOptions?: boolean; truncated?: string | null } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/api/ledger/ar/customers")) return json(DIRECTORY);
    if (url.includes("/api/ledger/ap/suppliers")) return json(SUPPLIERS);
    if (url.includes("/api/ledger/entries/filters") || url.includes("/api/ledger/accounts")) {
      return options.breakOptions ? json({ error: "server_error" }, 500) : json(url.includes("/filters") ? FILTER_OPTIONS : CHART);
    }
    if (url.includes("/api/ledger/ap/payments") && !/\/api\/ledger\/ap\/payments\//.test(url)) {
      return json({ payments: [], hasMore: false, nextCursor: null });
    }
    if (/\/api\/ledger\/a[pr]\/(receipts|payments)\//.test(url) && !url.includes("format=csv")) {
      return json({ receipt: DETAIL, payment: DETAIL });
    }
    if (url.includes("/api/ledger/ar/receipts")) {
      if (url.includes("format=csv")) {
        const headers: Record<string, string> = { "Content-Type": "text/csv" };
        if (options.truncated) headers["X-Voucher-Export-Truncated"] = options.truncated;
        return new Response("col\nrow\n", { status: 200, headers });
      }
      return json({ receipts: [ROW], hasMore: false, nextCursor: null });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderRegister() {
  return render(
    <MoneyProvider unit="rial">
      <ReceiptsPaymentsSection canManageReceivables canManagePayables canReverseReceipts canReversePayments />
    </MoneyProvider>,
  );
}

/** The list URLs fetched so far, newest last. */
function listUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => /\/api\/ledger\/a[pr]\/(receipts|payments)(\?|$)/.test(url) && !url.includes("format=csv"));
}

function disabled(button: HTMLElement | null): boolean {
  return (button as HTMLButtonElement | null)?.disabled ?? false;
}

/** Opens the panel and picks the customer; the option waits for the directory fetch. */
async function pickCustomer() {
  fireEvent.click(screen.getByRole("button", { name: "فیلترهای بیشتر" }));
  fireEvent.click(screen.getByRole("button", { name: "فیلتر مشتری" }));
  fireEvent.click(await screen.findByRole("option", { name: "علی رضایی" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the «فیلترهای بیشتر» panel", () => {
  it("puts the party, date and amount bounds on the list URL and counts them on the toggle", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();

    // The date range: «امروز» pins an exact ISO day without navigating months.
    fireEvent.click(screen.getByRole("button", { name: "از تاریخ" }));
    const calendar = screen.getByRole("dialog", { name: "انتخاب تاریخ شمسی" });
    fireEvent.click(within(calendar).getByRole("button", { name: "امروز" }));
    const today = todayJalali();
    const todayIso = jalaliToIsoDate(today.jy, today.jm, today.jd);

    // The amount bound, typed in Rial (the provider's unit here).
    fireEvent.change(screen.getByLabelText("حداقل مبلغ"), { target: { value: "5000" } });

    await waitFor(() => {
      const latest = listUrls(fetchMock).at(-1) ?? "";
      expect(latest).toContain(`partyId=${CUSTOMER_ID}`);
      expect(latest).toContain(`dateFrom=${todayIso}`);
      expect(latest).toContain("minAmount=5000");
    });
    // Three fields set: the toggle carries the count in Persian digits.
    expect(screen.queryByRole("button", { name: /بستن فیلترهای بیشتر \(۳\)/ })).not.toBeNull();
  });

  it("clears every extra filter with one action", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "پاک کردن فیلترها" }));
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).not.toContain("partyId=");
    });
  });

  it("degrades to disabled pickers with a retry when the option lists fail", async () => {
    const fetchMock = serve({ breakOptions: true });
    renderRegister();
    await screen.findAllByText("علی رضایی");

    // The list itself loaded (the panel's failure must not break the screen) —
    // open it to see the degraded pickers and the retry banner.
    fireEvent.click(screen.getByRole("button", { name: "فیلترهای بیشتر" }));
    expect(disabled(screen.getByRole("button", { name: "فیلتر حساب" }))).toBe(true);
    expect(disabled(screen.getByRole("button", { name: "فیلتر شعبه" }))).toBe(true);
    expect(screen.queryByText(/فهرست شعب و حساب‌ها بارگذاری نشد/)).not.toBeNull();

    // The retry re-fetches healthy sources and revives the pickers.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/api/ledger/entries/filters")) return json(FILTER_OPTIONS);
      if (url.includes("/api/ledger/accounts")) return json(CHART);
      if (url.includes("/api/ledger/ar/receipts")) return json({ receipts: [ROW], hasMore: false, nextCursor: null });
      if (url.includes("/api/ledger/ar/customers")) return json(DIRECTORY);
      return json({});
    });
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() => {
      expect(disabled(screen.getByRole("button", { name: "فیلتر حساب" }))).toBe(false);
    });
  });

  it("resets the party filter when the stream switches, and asks the other directory", async () => {
    const fetchMock = serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    // A customer id is meaningless as a supplier filter: the switch drops it.
    fireEvent.click(screen.getByRole("button", { name: /پرداختی/ }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes("/api/ledger/ap/suppliers?scope=directory"))).toBe(true);
    });
    await waitFor(() => {
      const latest = listUrls(fetchMock).at(-1) ?? "";
      expect(latest).toContain("/api/ledger/ap/payments");
      expect(latest).not.toContain("partyId=");
    });
  });
});

describe("the CSV export", () => {
  beforeEach(() => {
    // jsdom has no blob URLs and would navigate on an anchor click; the test
    // asserts the download was *triggered*, not the browser's file handling.
    URL.createObjectURL = vi.fn(() => "blob:fake");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("exports the filtered query, not the visible page, and warns when the server truncates", async () => {
    const fetchMock = serve({ truncated: "5000" });
    renderRegister();
    await screen.findAllByText("علی رضایی");

    await pickCustomer();
    await waitFor(() => {
      expect(listUrls(fetchMock).at(-1)).toContain(`partyId=${CUSTOMER_ID}`);
    });

    fireEvent.click(screen.getByRole("button", { name: "دانلود" }));
    await waitFor(() => {
      const csv = fetchMock.mock.calls.map((call) => String(call[0])).find((url) => url.includes("format=csv"));
      expect(csv).toContain(`partyId=${CUSTOMER_ID}`);
    });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    // The truncation header reaches the screen: a silently cut file
    // reconciled as complete is worse than no file.
    expect((await screen.findByRole("status")).textContent).toContain("۵۰۰۰");
  });

  it("stays silent when the export is complete", async () => {
    serve();
    renderRegister();
    await screen.findAllByText("علی رضایی");

    fireEvent.click(screen.getByRole("button", { name: "دانلود" }));
    await waitFor(() => {
      expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("the drill-down", () => {
  it("links the party directory and the posted journal entry", async () => {
    serve();
    renderRegister();
    const cells = await screen.findAllByText("علی رضایی");
    const desktopRow = cells.map((cell) => cell.closest("tr")).find(Boolean);
    expect(desktopRow).not.toBeUndefined();
    fireEvent.click(desktopRow!);

    // The party name links to the customer file; the entry links to the journal.
    const partyLink = await screen.findByRole("link", { name: "علی رضایی" });
    expect(partyLink.getAttribute("href")).toContain(`party=${CUSTOMER_ID}`);
    expect(partyLink.getAttribute("href")).toContain("view=customers");
    const entryLinks = await screen.findAllByRole("link", { name: "مشاهده در دفتر روزنامه" });
    expect(entryLinks).toHaveLength(1);
    expect(entryLinks[0].getAttribute("href")).toContain(`entryId=${ENTRY_ID}`);
    expect(entryLinks[0].getAttribute("href")).toContain("/accounting/entries");
    // …and the settlement account shows its code, not just its name.
    expect(screen.queryByText("۱۱۰۰ صندوق")).not.toBeNull();
  });

  it("opens from the mobile card with the keyboard", async () => {
    serve();
    renderRegister();
    const cards = await screen.findAllByRole("button", { name: /علی رضایی/ });
    fireEvent.keyDown(cards[0], { key: "Enter" });
    expect(await screen.findByText("جزئیات دریافت")).not.toBeNull();
  });
});
