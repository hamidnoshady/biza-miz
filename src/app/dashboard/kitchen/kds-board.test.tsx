// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KdsBoard } from "./kds-board";
import { useRealtime } from "../use-realtime";

const offlineState = vi.hoisted(() => ({ isOnline: true, pendingCount: 0 }));
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  apiOrQueue: vi.fn(),
  enqueueAction: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../offline-queue", () => ({
  apiOrQueue: mocks.apiOrQueue,
  enqueueAction: mocks.enqueueAction,
  useOfflineQueue: () => ({ isOnline: offlineState.isOnline, pendingCount: offlineState.pendingCount }),
}));
vi.mock("../use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("../ui", () => ({
  api: mocks.api,
  errorMessage: (error: string) => error,
  inputClass: "input",
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
    </label>
  ),
  InfoBox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../knowledge-help", () => ({
  KnowledgeHelpButton: () => <button type="button">Help</button>,
}));
vi.mock("../page-chrome", () => ({
  cardClass: "card",
  PageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  SectionCard: ({ title, description, children }: { title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) => (
    <section>
      {title}
      {description}
      {children}
    </section>
  ),
  StatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  LoadingSkeleton: () => <div>loading</div>,
}));
vi.mock("sonner", () => ({
  toast: {
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

function line(
  orderId: string,
  id: string,
  status: "sent" | "preparing" | "ready",
  orderNumber: number,
  orderType: "dine_in" | "takeaway" | "delivery",
  ageMinutes: number,
) {
  return {
    id,
    order_id: orderId,
    name_snapshot: `خوراک ${id}`,
    quantity: 1,
    status,
    note: null as string | null,
    order_note: null as string | null,
    sent_to_kitchen_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    order_type: orderType,
    order_number: orderNumber,
    table_session_id: null as string | null,
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

const defaultThresholds = { overdueMinutes: 10, approachingMinutes: null };

function installApi(
  initialItemsForTest = initialItems,
  thresholds: { overdueMinutes: number; approachingMinutes: number | null } = defaultThresholds,
) {
  const state = { items: initialItemsForTest, thresholds };
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/kitchen/alerts") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          thresholds: { overdueMinutes: number; approachingMinutes: number | null };
        };
        state.thresholds = body.thresholds;
        return { ok: true, status: 200, data: { thresholds: body.thresholds, canEdit: true } };
      }
      return { ok: true, status: 200, data: { thresholds: state.thresholds, canEdit: true } };
    }
    if (url === "/api/kitchen/tickets") {
      return { ok: true, status: 200, data: { items: state.items, modifiers: [] } };
    }
    return { ok: true, status: 200, data: {} };
  });
  return state;
}

function ticketCalls() {
  return mocks.api.mock.calls.filter(([url]) => url === "/api/kitchen/tickets").length;
}

/**
 * Wraps the main harness so the ticket GET and alert/rules reads still work,
 * while a batch POST returns the supplied result.
 */
function installBatchApi(
  items: ReturnType<typeof line>[],
  batchResponse: { ok: boolean; status: number; data: unknown },
) {
  installApi(items);
  const base = mocks.api.getMockImplementation();
  if (!base) throw new Error("installApi did not install a mock");
  mocks.api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/batch")) {
      return { ...batchResponse, aborted: false };
    }
    return base(url, init);
  });
}

function realtimeCallbacks() {
  return vi.mocked(useRealtime).mock.calls.at(-1) as unknown as [
    (event: { type: string }) => void,
    (status: { connected: boolean; recovery?: "reconnect" | "visibility" }) => void,
  ];
}

function installAudioContext(stateAtStart: AudioContextState, resumeTo: AudioContextState) {
  class FakeAudioContext {
    state = stateAtStart;
    currentTime = 0;
    destination = {};
    resume = vi.fn(async () => {
      this.state = resumeTo;
    });
    close = vi.fn(async () => {
      this.state = "closed";
    });
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
    }
    createGain() {
      return { gain: { value: 0 }, connect: vi.fn() };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

beforeEach(() => {
  localStorage.clear();
  offlineState.isOnline = true;
  offlineState.pendingCount = 0;
  mocks.api.mockReset();
  mocks.apiOrQueue.mockReset();
  mocks.enqueueAction.mockReset();
  mocks.toastInfo.mockReset();
  mocks.toastWarning.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  installApi();
  installAudioContext("running", "running");
  mocks.apiOrQueue.mockResolvedValue({ ok: true, queued: false, data: {} });
  mocks.enqueueAction.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    fireEvent.change(screen.getByLabelText("زمان انتظار"), { target: { value: "aging" } });
    expect(document.body.textContent).not.toContain("سفارش ۱");
    expect(document.body.textContent).toContain("سفارش ۲");
    expect(document.body.textContent).toContain("سفارش ۳");

    fireEvent.click(screen.getByRole("button", { name: /آمادهٔ تحویل/ }));
    expect(document.body.textContent).toContain("سفارش ۳");
    expect(document.body.textContent).not.toContain("سفارش ۲");
  });

  it("keeps status counts equal to the filtered queue and keeps the selection across a live refresh", async () => {
    // Issue #1049: the counts must describe the queue the filters leave
    // visible, and a realtime event must neither reset the selection nor hide
    // work that the selection still matches.
    const state = installApi();
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    const tabText = () =>
      within(screen.getByRole("navigation", { name: "فیلتر وضعیت سفارش‌های آشپزخانه" }))
        .getAllByRole("button")
        .map((button) => button.textContent);

    expect(tabText()).toEqual(["همه۳", "جدید۱", "در حال آماده‌سازی۱", "آماده۱"]);

    fireEvent.change(screen.getByLabelText("نوع سفارش"), { target: { value: "takeaway" } });
    expect(tabText()).toEqual(["همه۱", "جدید۰", "در حال آماده‌سازی۱", "آماده۰"]);
    expect(document.body.textContent).not.toContain("سفارش ۱");

    state.items = [...state.items, line("order-5", "line-5", "sent", 5, "takeaway", 1)];
    await act(async () => {
      realtimeCallbacks()[0]({ type: "order.created" });
    });
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۵"));
    expect(tabText()).toEqual(["همه۲", "جدید۱", "در حال آماده‌سازی۱", "آماده۰"]);
    // The selection survived the refresh — the dine-in ticket is still hidden.
    expect(document.body.textContent).not.toContain("سفارش ۱");
  });

  it("groups mixed rounds by order, shows status counts, and renders the order note", async () => {
    const first = { ...line("order-mixed", "line-new", "sent", 22, "dine_in", 4), order_note: "بدون فلفل", table_session_id: "session-one" };
    const second = { ...line("order-mixed", "line-ready", "ready", 22, "dine_in", 18), order_note: "بدون فلفل", table_session_id: "session-two" };
    installApi([first, second]);
    render(<KdsBoard />);

    const card = await screen.findByRole("button", { name: /سفارش ۲۲.*میز ۱/ });
    expect(card.textContent).toContain("۲ قلم");
    expect(card.textContent).toContain("۱ جدید");
    expect(card.textContent).toContain("۱ آماده");
    expect(screen.getAllByRole("button", { name: /سفارش ۲۲.*میز ۱/ })).toHaveLength(1);

    fireEvent.click(card);
    expect((await screen.findAllByText("دستور سفارش: بدون فلفل")).length).toBeGreaterThan(0);
  });

  it("confirms and posts one server-side batch for the selected eligible lines", async () => {
    const items = [
      line("order-batch", "line-a", "sent", 7, "dine_in", 3),
      line("order-batch", "line-b", "sent", 7, "dine_in", 3),
      line("order-batch", "line-c", "ready", 7, "dine_in", 3),
    ];
    installBatchApi(items, {
      ok: true,
      status: 200,
      data: {
        ok: true,
        orderId: "order-batch",
        requestedStatus: "preparing",
        items: [
          { itemId: "line-a", outcome: "applied", currentStatus: "preparing", nameSnapshot: "خوراک line-a", quantity: 1 },
          { itemId: "line-b", outcome: "applied", currentStatus: "preparing", nameSnapshot: "خوراک line-b", quantity: 1 },
        ],
        summary: { total: 2, applied: 2, alreadyApplied: 0, conflict: 0, ineligible: 0, missing: 0 },
      },
    });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۷"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    expect(document.body.textContent).toContain("خوراک line-a");
    fireEvent.click(screen.getAllByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" })[0]);

    expect(screen.getByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /شروع آماده‌سازی \(۲\)/ }));

    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/kitchen/tickets/order-batch/batch",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const batchCall = mocks.api.mock.calls.find(([url]) => String(url).includes("/batch"));
    expect(JSON.parse(String(batchCall?.[1]?.body))).toEqual({
      status: "preparing",
      itemIds: ["line-a", "line-b"],
    });
    await waitFor(() => expect(screen.getByText(/۲ قلم ثبت شد/)).not.toBeNull());
    expect(mocks.apiOrQueue).not.toHaveBeenCalled();
    expect(mocks.api.mock.calls.filter(([url]) => String(url) === "/api/kitchen/tickets").length).toBeGreaterThanOrEqual(2);
  });

  it("shows truthful per-line partial results and never claims the whole batch succeeded", async () => {
    const items = [
      line("order-partial", "line-a", "preparing", 8, "dine_in", 3),
      line("order-partial", "line-b", "preparing", 8, "dine_in", 3),
    ];
    installBatchApi(items, {
      ok: true,
      status: 200,
      data: {
        ok: true,
        orderId: "order-partial",
        requestedStatus: "ready",
        items: [
          { itemId: "line-a", outcome: "applied", currentStatus: "ready", nameSnapshot: "خوراک line-a", quantity: 1 },
          { itemId: "line-b", outcome: "conflict", currentStatus: "served", nameSnapshot: "خوراک line-b", quantity: 1 },
        ],
        summary: { total: 2, applied: 1, alreadyApplied: 0, conflict: 1, ineligible: 0, missing: 0 },
      },
    });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۸"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /علامت‌گذاری همهٔ اقلام در حال آماده‌سازی/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: /علامت‌گذاری به‌عنوان آماده \(۲\)/ }));

    const panel = await screen.findByLabelText("نتیجهٔ اقدام گروهی آشپزخانه");
    expect(panel.textContent).toContain("۱ قلم ثبت شد.");
    expect(panel.textContent).toContain("۱ قلم توسط همکار دیگر تغییر کرده بود.");
    expect(panel.textContent).toContain("وضعیت فعلی: سرو شده");
    expect(panel.textContent).not.toContain("۲ قلم ثبت شد");
    expect(panel.getAttribute("role")).toBe("alert");
  });

  it("queues the canonical per-item events and reports queued, not applied, when offline", async () => {
    const items = [
      line("order-offline", "line-a", "sent", 9, "dine_in", 3),
      line("order-offline", "line-b", "sent", 9, "dine_in", 3),
    ];
    installBatchApi(items, {
      ok: false,
      status: 0,
      data: { error: "network_error" },
    });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۹"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" })[0]);
    fireEvent.click(screen.getByRole("button", { name: /شروع آماده‌سازی \(۲\)/ }));

    await waitFor(() => expect(mocks.enqueueAction).toHaveBeenCalledTimes(2));
    expect(mocks.enqueueAction).toHaveBeenCalledWith(expect.objectContaining({
      type: "order_item.status",
      payload: { itemId: "line-a", status: "preparing" },
    }));
    expect(screen.getByLabelText("نتیجهٔ اقدام گروهی آشپزخانه").textContent).toContain(
      "۲ قلم در صف همگام‌سازی است و هنوز روی سرور اعمال نشده است.",
    );
    expect(screen.getByLabelText("نتیجهٔ اقدام گروهی آشپزخانه").textContent).not.toContain("ثبت شد.");
    expect(mocks.api.mock.calls.filter(([url]) => String(url) === "/api/kitchen/tickets").length).toBe(1);
  });

  it("lets the operator exclude a line and sends only the selected ids", async () => {
    const items = [
      line("order-select", "line-a", "sent", 10, "dine_in", 3),
      line("order-select", "line-b", "sent", 10, "dine_in", 3),
    ];
    installBatchApi(items, {
      ok: true,
      status: 200,
      data: {
        ok: true,
        orderId: "order-select",
        requestedStatus: "preparing",
        items: [{ itemId: "line-a", outcome: "applied", currentStatus: "preparing", nameSnapshot: "خوراک line-a", quantity: 1 }],
        summary: { total: 1, applied: 1, alreadyApplied: 0, conflict: 0, ineligible: 0, missing: 0 },
      },
    });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱۰"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" })[0]);
    fireEvent.click(screen.getByRole("checkbox", { name: "انتخاب خوراک line-b" }));
    fireEvent.click(screen.getByRole("button", { name: /شروع آماده‌سازی \(۱\)/ }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(
      "/api/kitchen/tickets/order-select/batch",
      expect.objectContaining({ method: "POST" }),
    ));
    const batchCall = mocks.api.mock.calls.find(([url]) => String(url).includes("/batch"));
    expect(JSON.parse(String(batchCall?.[1]?.body)).itemIds).toEqual(["line-a"]);
  });

  it("cancelling the confirmation sends nothing", async () => {
    const items = [line("order-cancel", "line-a", "sent", 11, "dine_in", 3)];
    installBatchApi(items, { ok: true, status: 200, data: {} });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱۱"));
    fireEvent.click(screen.getByRole("button", { name: /انتخاب سفارش اولویت‌دار/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "شروع آماده‌سازی همهٔ اقلام جدید" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "انصراف" }));

    expect(mocks.api.mock.calls.filter(([url]) => String(url).includes("/batch"))).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps sound opt-in and persists a deliberate operator choice", async () => {
    render(<KdsBoard />);
    const toggle = await screen.findByRole("button", { name: "هشدار صوتی خاموش" });
    fireEvent.click(toggle);
    await waitFor(() => expect(localStorage.getItem("kds.sound-alerts")).toBe("true"));
    expect(screen.getByRole("button", { name: /هشدار صوتی روشن|فعال‌سازی صدای هشدار/ })).not.toBeNull();
  });

  it("falls back to visual alerts when the browser denies autoplay", async () => {
    installAudioContext("suspended", "suspended");
    const state = installApi();
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    fireEvent.click(screen.getByRole("button", { name: "هشدار صوتی خاموش" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("پخش صدا در این مرورگر مسدود"),
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("پخش صدا در این مرورگر مسدود"),
    );
    expect(localStorage.getItem("kds.sound-alerts")).toBe("false");

    state.items = [...initialItems, line("order-4", "line-4", "sent", 4, "dine_in", 1)];
    await act(async () => {
      realtimeCallbacks()[0]({ type: "order.created" });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("۱ سفارش تازه به صف آشپزخانه رسید."),
    );
  });

  it("alerts once for a new ticket, once for a new round, and never again on repeated events", async () => {
    const state = installApi();
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    state.items = [...state.items, line("order-4", "line-4", "sent", 4, "dine_in", 1)];
    await act(async () => {
      realtimeCallbacks()[0]({ type: "order.created" });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("۱ سفارش تازه به صف آشپزخانه رسید."),
    );

    await act(async () => {
      realtimeCallbacks()[0]({ type: "order.updated" });
    });
    await waitFor(() => expect(ticketCalls()).toBeGreaterThanOrEqual(3));
    expect(
      mocks.toastInfo.mock.calls.filter(([message]) => String(message).includes("سفارش تازه")),
    ).toHaveLength(1);

    state.items = [...state.items, line("order-1", "line-1b", "sent", 1, "dine_in", 1)];
    await act(async () => {
      realtimeCallbacks()[0]({ type: "order.item_status" });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("۱ قلم تازه به سفارش‌های موجود اضافه شد."),
    );
  });

  it("escalates persisted ticket age through the configured stages without duplicate alerts", async () => {
    const state = installApi(
      [line("order-age", "line-age", "sent", 9, "dine_in", 4)],
      { overdueMinutes: 10, approachingMinutes: 5 },
    );
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۹"));
    expect(document.body.textContent).toContain("در محدوده");

    state.items = [line("order-age", "line-age", "sent", 9, "dine_in", 6)];
    await act(async () => {
      realtimeCallbacks()[1]({ connected: true, recovery: "reconnect" });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("۱ سفارش به آستانهٔ تأخیر نزدیک شد."),
    );

    state.items = [line("order-age", "line-age", "sent", 9, "dine_in", 11)];
    await act(async () => {
      realtimeCallbacks()[1]({ connected: true, recovery: "visibility" });
    });
    await waitFor(() =>
      expect(mocks.toastInfo).toHaveBeenCalledWith("۱ سفارش از آستانهٔ تأخیر عبور کرد."),
    );

    await act(async () => {
      realtimeCallbacks()[1]({ connected: true, recovery: "reconnect" });
    });
    await waitFor(() => expect(ticketCalls()).toBeGreaterThanOrEqual(4));
    expect(
      mocks.toastInfo.mock.calls.filter(([message]) => String(message).includes("آستانهٔ تأخیر")),
    ).toHaveLength(2);
  });

  it("distinguishes disconnect, reconnect and repeated lifecycle states", async () => {
    installApi();
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    await act(async () => {
      realtimeCallbacks()[1]({ connected: true });
    });
    await act(async () => {
      realtimeCallbacks()[1]({ connected: false });
    });
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("اتصال زندهٔ آشپزخانه قطع شد"),
    );

    await act(async () => {
      realtimeCallbacks()[1]({ connected: false });
    });
    expect(
      mocks.toastWarning.mock.calls.filter(([message]) => String(message).includes("قطع شد")),
    ).toHaveLength(1);

    await act(async () => {
      realtimeCallbacks()[1]({ connected: true, recovery: "reconnect" });
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("اتصال زنده دوباره برقرار شد.");
  });

  it("refetches an authoritative snapshot after reconnect and coalesces concurrent recovery signals", async () => {
    let resolveFirst!: (value: { ok: true; data: { items: typeof initialItems; modifiers: never[] } }) => void;
    let ticketRequest = 0;
    mocks.api.mockImplementation((url: string) => {
      if (url === "/api/kitchen/alerts") {
        return Promise.resolve({ ok: true, status: 200, data: { thresholds: defaultThresholds, canEdit: true } });
      }
      if (url === "/api/kitchen/tickets") {
        ticketRequest += 1;
        if (ticketRequest === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ ok: true, status: 200, data: { items: initialItems, modifiers: [] } });
      }
      return Promise.resolve({ ok: true, status: 200, data: {} });
    });
    render(<KdsBoard />);
    await waitFor(() => expect(ticketCalls()).toBe(1));

    await act(async () => {
      realtimeCallbacks()[1]({ connected: true, recovery: "reconnect" });
      realtimeCallbacks()[1]({ connected: true, recovery: "visibility" });
    });
    expect(ticketCalls()).toBe(1);
    expect(screen.getByRole("alert").textContent).toContain("صف آشپزخانه تازه نیست");

    await act(async () => {
      resolveFirst({ ok: true, data: { items: initialItems, modifiers: [] } });
    });
    await waitFor(() => expect(ticketCalls()).toBe(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows the branch thresholds read-only and sends their editing to the settings notifications tab", async () => {
    installApi(initialItems, { overdueMinutes: 12, approachingMinutes: 6 });
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    // The board displays the branch policy but no longer edits it: the
    // thresholds, the sound matrix and the notification rules are configured
    // in /settings/notifications.
    expect(document.body.textContent).toContain("آستانهٔ تأخیر این شعبه");
    expect(document.body.textContent).toContain("۱۲ دقیقه");
    expect(screen.queryByRole("button", { name: "اعلان‌ها و صدا" })).toBeNull();
    expect(screen.queryByRole("button", { name: "تنظیمات آشپزخانه" })).toBeNull();
    expect(screen.queryByRole("button", { name: "بررسی سفارش‌های قدیمی" })).toBeNull();

    const settingsLink = screen.getByRole("link", { name: "تنظیم" });
    expect(settingsLink.getAttribute("href")).toBe("/settings/notifications");
  });

  it("follows sound preferences written by the settings notifications panel on the same device", async () => {
    installApi(initialItems, defaultThresholds);
    render(<KdsBoard />);
    const toggle = await screen.findByRole("button", { name: "هشدار صوتی خاموش" });

    // The settings panel persists through the shared store; the board must
    // follow the event rather than own a second copy of the state.
    await act(async () => {
      localStorage.setItem("kds.sound-alerts", "true");
      localStorage.setItem(
        "kds.sound-preferences",
        JSON.stringify({ enabled: true, events: { newTicket: true } }),
      );
      window.dispatchEvent(new CustomEvent("biza:kitchen-sound-preferences"));
    });

    expect(
      screen.queryByRole("button", { name: /هشدار صوتی روشن|فعال‌سازی صدای هشدار/ }),
    ).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
