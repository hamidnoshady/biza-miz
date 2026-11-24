// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KdsBoard } from "./kds-board";
import { useRealtime } from "../use-realtime";

const offlineState = vi.hoisted(() => ({ isOnline: true, pendingCount: 0 }));
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  apiOrQueue: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../offline-queue", () => ({
  apiOrQueue: mocks.apiOrQueue,
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

const kitchenRules = {
  events: [
    { key: "kitchen.ticket_created", label: "سفارش تازه در آشپزخانه", description: "سفارش تازه" },
    { key: "kitchen.items_added", label: "اقلام تازه به سفارش آشپزخانه", description: "اقلام تازه" },
    { key: "kitchen.ticket_aged", label: "گذشتن سفارش از آستانهٔ آماده‌سازی", description: "سن سفارش" },
  ],
  preferences: [
    { eventKey: "kitchen.ticket_created", enabled: false, channels: ["inapp"], isDefault: true },
    { eventKey: "kitchen.items_added", enabled: false, channels: ["inapp"], isDefault: true },
    { eventKey: "kitchen.ticket_aged", enabled: false, channels: ["inapp"], isDefault: true },
  ],
};

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
    if (url === "/api/notifications/rules") {
      return { ok: true, status: 200, data: kitchenRules };
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
  mocks.toastInfo.mockReset();
  mocks.toastWarning.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  installApi();
  installAudioContext("running", "running");
  mocks.apiOrQueue.mockResolvedValue({ ok: true, queued: false, data: {} });
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

  it("batch-advances only eligible lines and reports the applied count", async () => {
    installApi([
      line("order-batch", "line-a", "sent", 7, "dine_in", 3),
      line("order-batch", "line-b", "sent", 7, "dine_in", 3),
      line("order-batch", "line-c", "ready", 7, "dine_in", 3),
    ]);
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
      if (url === "/api/notifications/rules") {
        return Promise.resolve({ ok: true, status: 200, data: kitchenRules });
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

  it("saves branch thresholds from the alerts panel and keeps the settings separate", async () => {
    installApi(initialItems, defaultThresholds);
    render(<KdsBoard />);
    await waitFor(() => expect(document.body.textContent).toContain("سفارش ۱"));

    fireEvent.click(screen.getByRole("button", { name: "اعلان‌ها و صدا" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("اعلان‌ها، صدا و چاپ آشپزخانه"),
    );
    expect(document.body.textContent).toContain("اعلان‌های داخل برنامه و Push");

    fireEvent.change(screen.getByLabelText("آستانهٔ تأخیر (دقیقه)"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("آستانهٔ نزدیک‌شدن (دقیقه؛ خالی = خاموش)"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ آستانه‌ها" }));

    await waitFor(() => {
      const put = mocks.api.mock.calls.find(
        ([url, init]) => url === "/api/kitchen/alerts" && (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
        thresholds: { overdueMinutes: 20, approachingMinutes: 12 },
      });
    });
    expect(document.body.textContent).toContain("آستانه‌های این شعبه ذخیره شد.");
  });
});
