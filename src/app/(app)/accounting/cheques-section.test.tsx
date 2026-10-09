// @vitest-environment jsdom

/**
 * The cheque register as a reader actually meets it (issue #828).
 *
 * Each case is one thing that was wrong on the real screen:
 *
 *  - «بیشتر» asked for `limit = 50 × page` with no offset. The service caps a
 *    page at 200, so the fourth press returned the same 200 rows forever and
 *    the register could never reach a later cheque — and because the request
 *    restarted the list, every press blanked the rows already read.
 *  - A `ledger.view`-only member was shown live mutation controls that the API
 *    then refused.
 *  - The KPI strip reported a single "active" number that reconciled to no
 *    control account.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toPersianDigits } from "@/lib/digits";
import { MoneyProvider } from "@/components/money/money-context";
import { ChequesSection } from "./cheques-section";

afterEach(cleanup);

function cheque(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `cheque-${index}`,
    locationId: "loc-1",
    locationName: "شعبهٔ مرکزی",
    direction: "receivable",
    status: "on_hand",
    serialNumber: `S-${String(index).padStart(3, "0")}`,
    sayadId: null,
    bankName: "ملت",
    accountNumber: null,
    amount: 1_000_000,
    issueDate: "2026-01-10",
    dueDate: "2026-03-10",
    counterpartyName: "مشتری",
    customerId: "customer-1",
    supplierId: null,
    memo: null,
    replacesChequeId: null,
    replacesSerialNumber: null,
    replacedByAmount: 0,
    createdAt: "2026-01-10T08:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_BUCKET = { count: 0, total: 0 };

function summary(overrides: Record<string, unknown> = {}) {
  return {
    outstanding: { count: 120, total: 120_000_000 },
    onHand: { count: 120, total: 120_000_000 },
    inCollection: EMPTY_BUCKET,
    issued: EMPTY_BUCKET,
    contingent: { count: 2, total: 2_000_000 },
    returnedUnresolved: { count: 1, total: 3_000_000 },
    resolved: EMPTY_BUCKET,
    cleared: EMPTY_BUCKET,
    cancelled: EMPTY_BUCKET,
    settled: EMPTY_BUCKET,
    overdue: EMPTY_BUCKET,
    dueSoon: EMPTY_BUCKET,
    ...overrides,
  };
}

/** Every register URL the component asked for, in order. */
let registerCalls: string[];

function stubFetch(pageFor: (url: URL) => unknown) {
  registerCalls = [];
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/ledger/cheques?")) {
      registerCalls.push(url);
      return { ok: true, status: 200, json: async () => pageFor(new URL(url, "http://t")) };
    }
    return { ok: true, status: 200, json: async () => ({ locations: [], customers: [], suppliers: [] }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSection(props: Partial<Parameters<typeof ChequesSection>[0]> = {}) {
  return render(
    <MoneyProvider unit="rial">
      <ChequesSection busy={false} run={async (fn) => (await fn()).ok} canManage {...props} />
    </MoneyProvider>,
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the cheque register's paging", () => {
  it("asks for the next window by offset and appends it, keeping what is already read", async () => {
    // Five rows per answer keeps the DOM small; what is under test is the
    // *shape* of each request (a fixed limit and a moving offset) and the
    // accumulation, not how many rows a real page holds.
    const WINDOW = 5;
    stubFetch((url) => {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return {
        cheques: Array.from({ length: WINDOW }, (_, i) => cheque(offset + i)),
        total: 210,
        hasMore: offset + WINDOW < 210,
        banks: ["ملت"],
        summary: summary(),
      };
    });

    const user = userEvent.setup();
    renderSection();

    await screen.findByText(toPersianDigits("S-000"));
    expect(new URL(registerCalls[0], "http://t").searchParams.get("limit")).toBe("50");
    expect(new URL(registerCalls[0], "http://t").searchParams.get("offset")).toBe("0");

    await user.click(await screen.findByRole("button", { name: /مورد بیشتر/ }));
    await screen.findByText(toPersianDigits("S-005"));

    // The second request is the *next* window, not a bigger first one…
    const second = new URL(registerCalls[1], "http://t");
    expect(second.searchParams.get("offset")).toBe("5");
    expect(second.searchParams.get("limit")).toBe("50");
    // …and the rows already on screen are still there.
    expect(screen.getByText(toPersianDigits("S-000"))).toBeTruthy();

    // Keep going: the window keeps moving instead of the limit growing, which
    // is what used to stall against the service's 200-row cap.
    for (let press = 0; press < 3; press += 1) {
      await user.click(await screen.findByRole("button", { name: /مورد بیشتر/ }));
    }
    const offsets = registerCalls.map((u) => new URL(u, "http://t").searchParams.get("offset"));
    expect(offsets).toEqual(["0", "5", "10", "15", "20"]);
    expect(
      registerCalls.every((u) => new URL(u, "http://t").searchParams.get("limit") === "50"),
    ).toBe(true);
    await screen.findByText(toPersianDigits("S-020"));
    expect(screen.getByText(toPersianDigits("S-000"))).toBeTruthy();
  });

  it("offers a retry for the page that failed without discarding the register", async () => {
    let fail = true;
    registerCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.startsWith("/api/ledger/cheques?")) {
          return { ok: true, status: 200, json: async () => ({ locations: [] }) };
        }
        registerCalls.push(url);
        const offset = Number(new URL(url, "http://t").searchParams.get("offset") ?? 0);
        if (offset > 0 && fail) {
          fail = false;
          return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            cheques: Array.from({ length: 5 }, (_, i) => cheque(offset + i)),
            total: 120,
            hasMore: true,
            banks: [],
            summary: summary(),
          }),
        };
      }),
    );

    const user = userEvent.setup();
    renderSection();
    await screen.findByText(toPersianDigits("S-000"));

    await user.click(await screen.findByRole("button", { name: /مورد بیشتر/ }));
    const retry = await screen.findByRole("button", { name: "تلاش دوباره" });
    // The failed page did not take the register with it.
    expect(screen.getByText(toPersianDigits("S-000"))).toBeTruthy();

    await user.click(retry);
    await screen.findByText(toPersianDigits("S-005"));
  });
});

describe("the cheque register's permission gate", () => {
  beforeEach(() => {
    stubFetch(() => ({
      cheques: [cheque(1)],
      total: 1,
      hasMore: false,
      banks: ["ملت"],
      summary: summary(),
    }));
  });

  it("shows a read-only member the register and no mutation control", async () => {
    renderSection({ canManage: false });
    await screen.findByText(toPersianDigits("S-001"));
    expect(screen.queryByRole("button", { name: /ثبت چک جدید/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "واگذاری به بانک" })).toBeNull();
  });

  it("shows the same register with controls to a member who may manage cheques", async () => {
    renderSection({ canManage: true });
    await screen.findByText(toPersianDigits("S-001"));
    expect(screen.getByRole("button", { name: /ثبت چک جدید/ })).toBeTruthy();
  });
});

describe("the cheque register's accounting categories", () => {
  it("names each category and the control account it reconciles to", async () => {
    stubFetch(() => ({
      cheques: [cheque(1)],
      total: 1,
      hasMore: false,
      banks: [],
      summary: summary(),
    }));
    renderSection();
    await screen.findByText(toPersianDigits("S-001"));

    await waitFor(() => expect(screen.getAllByText("نزد صندوق").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/۱۲۴۱/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("ظهرنویسی‌شده (تعهد احتمالی)").length).toBe(1);
    expect(screen.getAllByText("برگشتی تعیین‌تکلیف‌نشده").length).toBe(1);
    expect(screen.getAllByText(/۱۲۴۴/).length).toBeGreaterThan(0);
  });
});
