// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KdsBoard } from "./kds-board";
import { useRealtime } from "../use-realtime";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  apiOrQueue: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../offline-queue", () => ({
  apiOrQueue: mocks.apiOrQueue,
  useOfflineQueue: () => ({ isOnline: true, pendingCount: 0 }),
}));
vi.mock("../use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("../ui", () => ({
  api: mocks.api,
  errorMessage: (error: string) => error,
}));
vi.mock("../knowledge-help", () => ({
  KnowledgeHelpButton: () => <button type="button">Help</button>,
}));
vi.mock("../page-chrome", () => ({
  cardClass: "card",
  PageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("sonner", () => ({ toast: { info: mocks.toastInfo } }));

function line(orderId: string, id: string, status: "sent" | "preparing" | "ready", orderNumber: number, orderType: "dine_in" | "takeaway" | "delivery", ageMinutes: number) {
  return {
    id,
    order_id: orderId,
    name_snapshot: `خوراک ${id}`,
    quantity: 1,
    status,
    note: null,
    order_note: null,
    sent_to_kitchen_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    order_type: orderType,
    order_number: orderNumber,
    table_session_id: null,
    table_id: null,
    table_name: orderType === "dine_in" ? "میز ۱" : null,
    priority: { tier: "waiting", sentAtMs: Date.now() - ageMinutes * 60_000, ageMinutes },
  };
}

const initialItems = [
  line("order-1", "line-1", "sent", 1, "dine_in", 5),
  line("order-2", "line-2", "preparing", 2, "takeaway", 30),
  line("order-3", "line-3", "ready", 3, "delivery", 20),
];

beforeEach(() => {
  localStorage.clear();
  mocks.api.mockReset();
  mocks.apiOrQueue.mockReset();
  mocks.toastInfo.mockReset();
  mocks.api.mockResolvedValue({ ok: true, data: { items: initialItems, modifiers: [] } });
  mocks.apiOrQueue.mockResolvedValue({ ok: true, queued: false, data: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("KdsBoard operational controls", () => {
  it("filters by persisted order type, aging threshold, and ready-for-pickup state", async () => {
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    fireEvent.change(screen.getByLabelText("نوع سفارش"), { target: { value: "takeaway" } });
    expect(document.body.textContent).toContain("سفارش ۲");
    expect(document.body.textContent).not.toContain("سفارش ۱");

    fireEvent.change(screen.getByLabelText("نوع سفارش"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("هشدار تأخیر پس از"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("زمان انتظار"), { target: { value: "aging" } });
    expect(document.body.textContent).not.toContain("سفارش ۱");
    expect(document.body.textContent).toContain("سفارش ۲");
    expect(document.body.textContent).toContain("سفارش ۳");

    fireEvent.click(screen.getByRole("button", { name: /آمادهٔ تحویل/ }));
    expect(document.body.textContent).toContain("سفارش ۳");
    expect(document.body.textContent).not.toContain("سفارش ۲");
  });

  it("batch-advances only eligible lines and reports the applied count", async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { items: [
      line("order-batch", "line-a", "sent", 7, "dine_in", 3),
      line("order-batch", "line-b", "sent", 7, "dine_in", 3),
      line("order-batch", "line-c", "ready", 7, "dine_in", 3),
    ], modifiers: [] } });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۷"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    expect(document.body.textContent).toContain("خوراک line-a");
    fireEvent.click(screen.getAllByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" })[0]);

    await waitFor(() => expect(mocks.apiOrQueue).toHaveBeenCalledTimes(2));
    expect(mocks.apiOrQueue).toHaveBeenCalledWith(
      "/api/kitchen/items/line-a",
      { method: "PATCH", body: { status: "preparing" } },
      expect.objectContaining({ payload: { itemId: "line-a", status: "preparing" } }),
    );
    expect(screen.getByText(/۲ اعمال شد/)).not.toBeNull();
  });

  it("keeps sound opt-in and persists a deliberate operator choice", async () => {
    render(<KdsBoard />);
    const toggle = await screen.findByRole("button", { name: "هشدار صوتی خاموش" });
    fireEvent.click(toggle);
    expect(localStorage.getItem("kds.sound-alerts")).toBe("true");
    expect(screen.getByRole("button", { name: /هشدار صوتی روشن|فعال‌سازی صدای هشدار/ })).not.toBeNull();
  });

  it("refetches an authoritative snapshot after reconnect and coalesces concurrent recovery signals", async () => {
    let resolveFirst!: (value: { ok: true; data: { items: typeof initialItems; modifiers: never[] } }) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    render(<KdsBoard />);
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));

    const lifecycle = vi.mocked(useRealtime).mock.calls.at(-1)?.[1];
    expect(lifecycle).toBeTypeOf("function");
    await act(async () => {
      lifecycle?.({ connected: true, recovery: "reconnect" });
      lifecycle?.({ connected: true, recovery: "visibility" });
    });
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("صف آشپزخانه تازه نیست");

    await act(async () => {
      resolveFirst({ ok: true, data: { items: initialItems, modifiers: [] } });
    });
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
