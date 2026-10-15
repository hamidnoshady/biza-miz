// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomotiveOfflineBoard } from "./offline-board";

/**
 * The offline panel's own honesty rules, at the level the desk meets them:
 *
 *   * an open request is never drawn as «لغوشده» — a withdrawal the cloud has not
 *     answered is «در حال لغو» and stays in the open list, because the car may still
 *     be held;
 *   * a status filter is a *server* question (the whole point is reaching work older
 *     than any window), and the answer's rows replace what is on screen;
 *   * the footer follows the keyset cursor the server handed back, appending older
 *     pages instead of replacing them;
 *   * a failed fetch shows the error instead of an empty board.
 */

const CAPABILITY = {
  mode: "read_only_mirror" as const,
  localStockReads: true,
  reservationRequests: true,
  releaseRequests: true,
  offlineSaleFinalization: false as const,
  offlineAcquisition: false as const,
  label: "موجودی محلی؛ ثبت فقط با تأیید مرکزی",
  reason: "این شعبه به سرور مرکزی متصل است.",
};

const VEHICLE = {
  serial_id: "11111111-1111-4111-8111-111111111111",
  stock_number: "AUTO-1",
  make: "کیا",
  model: "سراتو",
  trim: null,
  condition: "used" as const,
  state: "in_stock",
  availability: "available" as const,
  model_year: 1403,
  mileage_km: 12_000,
  vin: null,
  chassis_number: "CH-1",
  acquired_on: "2026-01-05",
  asking_price_rial: "1200000000",
  reservation_id: null,
  reservation_customer_name: null,
  source_version: "1",
  cloud_updated_at: "2026-01-06T00:00:00.000Z",
  synced_at: "2026-01-06T00:00:00.000Z",
};

function request(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    request_type: "reserve",
    serial_id: VEHICLE.serial_id,
    stock_number: "AUTO-1",
    customer_id: "33333333-3333-4333-8333-333333333333",
    customer_name: "آقای خریدار",
    reservation_id: null,
    deposit_amount_rial: "5000000",
    deposit_method: "cash",
    deposit_refundable: true,
    note: null,
    expires_at: null,
    reason: null,
    refund_deposit: null,
    status: "pending",
    conflict_code: null,
    acknowledged_at: null,
    requested_at: "2026-01-06T09:00:00.000Z",
    resolved_at: null,
    resolved_note: null,
    ...overrides,
  };
}

function board(
  requests: Array<Record<string, unknown>>,
  page: { total: number; openTotal: number; nextCursor: string | null },
) {
  return {
    capability: CAPABILITY,
    status: {
      vehicles: 1,
      reserved: 0,
      openRequests: page.openTotal,
      pendingRequests: 1,
      cancellingRequests: 1,
      conflicts: 0,
      resolvedRequests: page.total,
      lastSyncedAt: "2026-01-06T09:30:00.000Z",
      state: { checkedAt: "2026-01-06T09:30:00.000Z", appliedAt: null, lastError: null },
    },
    vehicles: [VEHICLE],
    requests,
    requestsPage: page,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => data } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the offline vehicle board's request panel (§19)", () => {
  it("keeps a withdrawal open and unproven instead of drawing it as cancelled", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        board(
          [
            request({ id: "pending-1", status: "pending" }),
            request({
              id: "cancelling-1",
              status: "cancelling",
              requested_at: "2026-01-06T08:00:00.000Z",
            }),
          ],
          { total: 2, openTotal: 2, nextCursor: null },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AutomotiveOfflineBoard />);

    // The pending label also appears in the panel's own explanatory paragraph, so
    // the assertion is on the badge the row carries.
    expect(
      (await screen.findAllByText("در انتظار تأیید سرور")).length,
    ).toBeGreaterThan(0);
    // …and the withdrawal is drawn as open, in the open table and again in history.
    expect(
      screen.getAllByText("در حال لغو — در انتظار سرور").length,
    ).toBeGreaterThan(0);
    // The panel's own words: neither of the two open states counts as cancelled yet.
    expect(
      screen.getByText(/هیچ‌کدام از این دو «لغوشده» حساب نمی‌شود/),
    ).not.toBeNull();
    // The row offers to chase the withdrawal, and nothing claims it has happened.
    expect(
      (await screen.findAllByRole("button", { name: "پیگیری لغو" })).length,
    ).toBeGreaterThan(0);
    // …no row is drawn as a settled cancellation: «لغو شد» is what a decided
    // cancellation's row prints, and neither open request has one.
    expect(screen.queryByText(/لغو شد/)).toBeNull();
  });

  it("reports a withdrawal the cloud has not answered as pending, not as done", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/requests/cancelling-1/cancel")) {
        return jsonResponse(
          {
            request: { id: "cancelling-1", status: "cancelling" },
            action: "withdrawn",
            cancelled: false,
            message:
              "درخواست لغو به سرور مرکزی فرستاده شد؛ نتیجه پس از پاسخ سرور نمایش داده می‌شود.",
          },
          202,
        );
      }
      return jsonResponse(
        board(
          [request({ id: "cancelling-1", status: "cancelling" })],
          { total: 1, openTotal: 1, nextCursor: null },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AutomotiveOfflineBoard />);
    await user.click(await screen.findByRole("button", { name: "پیگیری لغو" }));

    expect(
      await screen.findByText(/نتیجه پس از پاسخ سرور نمایش داده می‌شود/),
    ).not.toBeNull();
    expect(screen.queryByText("درخواست لغو شد.")).toBeNull();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).endsWith("/requests/cancelling-1/cancel"),
        ),
      ).toBe(true),
    );
  });

  it("asks the server for a status, and appends older pages from the keyset cursor", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("cursor=older")) {
        return jsonResponse(
          board([request({ id: "old-1", status: "cancelled", resolved_at: "2026-01-01T00:00:00.000Z" })], {
            total: 1,
            openTotal: 0,
            nextCursor: null,
          }),
        );
      }
      if (url.includes("requestStatus=cancelling")) {
        return jsonResponse(
          board([request({ id: "cancelling-1", status: "cancelling" })], {
            total: 1,
            openTotal: 1,
            nextCursor: "older",
          }),
        );
      }
      return jsonResponse(
        board([request({ id: "pending-1", status: "pending" })], {
          total: 2,
          openTotal: 1,
          nextCursor: null,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AutomotiveOfflineBoard />);
    await screen.findAllByText("در انتظار تأیید سرور");

    await user.click(screen.getByRole("button", { name: "در حال لغو" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("requestStatus=cancelling"),
        ),
      ).toBe(true),
    );
    // The filtered page is what the panel shows, under the filter it answered for.
    expect(await screen.findByText(/۱ درخواست با این فیلتر/)).not.toBeNull();

    await user.click(
      await screen.findByRole("button", { name: "بارگذاری موارد قدیمی‌تر" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=older")),
      ).toBe(true),
    );
    // The older page was appended, not swapped in: two rows under one filter.
    expect(await screen.findByText(/۲ مورد بارگذاری شده/)).not.toBeNull();
    expect(screen.getByText(/۱ درخواست با این فیلتر/)).not.toBeNull();
  });

  it("shows a failed fetch as an error rather than an empty board", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)),
    );

    render(<AutomotiveOfflineBoard />);

    // The failure is shown where the status lives, with the panel's own retry in
    // reach — never as a silently empty board.
    expect(
      await screen.findByText("خطای غیرمنتظره. دوباره تلاش کنید."),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "به‌روزرسانی" })).not.toBeNull();
  });
});
