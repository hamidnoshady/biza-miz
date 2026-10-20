// @vitest-environment jsdom

/**
 * Issue #944 — rendered contracts for the WP overview against a fake server:
 * partial sync is not «انجام شد» (OVR-04), sync buttons honour flags and
 * abilities (OVR-08), configured status and transport health are two badges
 * (OVR-07), the queue tiles count the inbox and needs_review (OVR-03), a
 * failed KPI read is announced with a retry (OVR-06), and nothing of store A
 * is shown under store B (OVR-09).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WpAbility } from "@/lib/wp-access";

const ctx = vi.hoisted(() => ({
  value: null as null | Record<string, unknown>,
}));
vi.mock("./wp-store-context", async (importOriginal) => {
  const original = await importOriginal<typeof import("./wp-store-context")>();
  return { ...original, useWpStore: () => ctx.value };
});

import { WpOverviewSection } from "./overview-section";

interface Recorded {
  method: string;
  url: string;
}
const recorded: Recorded[] = [];
let routes: Record<string, () => { status: number; data: unknown }>;

const queue = (overrides: Partial<Record<string, number>> = {}) => ({
  total: 0, pending: 0, processing: 0, failed: 0, dead: 0, sent: 0, deferred: 0, inboundFailed: 0,
  outboundFailed: 0, needsReview: 0, inboundPending: 0, inFlight: 0, attention: 0, open: 0,
  ...overrides,
});

function stats(connectionId: string) {
  return {
    connections: { total: 1, active: 1, plugin: 0, rest: 1 },
    products: connectionId === "a" ? 12 : 99,
    orders: 3,
    customers: 4,
    terms: 5,
    content: { posts: 1, pages: 1, media: 2 },
    pendingJobs: 0, failedJobs: 0, deadJobs: 0, pendingInboxEvents: 0, failedInboxEvents: 0,
    queue: queue({ pending: 4, inboundPending: 3, processing: 1, inFlight: 5, failed: 2, needsReview: 1, dead: 1, attention: 3, open: 8 }),
  };
}

const storeA = {
  id: "a",
  name: "فروشگاه",
  baseUrl: "https://a.example.com",
  linkMode: "rest_api" as const,
  status: "active",
  syncProducts: true,
  syncOrders: false,
  syncCustomers: true,
  pluginCapabilities: null,
  lastSyncAt: null,
  transportHealth: { state: "healthy", lastSeenAt: null },
};
const storeB = { ...storeA, id: "b", baseUrl: "https://b.example.com", linkMode: "plugin" as const, transportHealth: { state: "stale", lastSeenAt: "2026-01-01T00:00:00Z" } };

function setContext(overrides: Partial<Record<string, unknown>> = {}) {
  const abilities = new Set<WpAbility>((overrides.abilities as WpAbility[]) ?? ["view", "sync"]);
  const selectedId = (overrides.selectedId as string) ?? "a";
  const connections = (overrides.connections as typeof storeA[]) ?? [storeA, storeB];
  ctx.value = {
    connections,
    loadState: "loaded",
    loadError: null,
    selectedId,
    selectedConnection: connections.find((c) => c.id === selectedId) ?? null,
    setSelectedId: vi.fn(),
    reloadConnections: vi.fn(async () => {}),
    abilities,
    can: (ability: WpAbility) => abilities.has(ability),
    ...overrides,
  };
}

beforeEach(() => {
  recorded.length = 0;
  routes = {
    "GET /api/integrations/wp-manager/overview?connectionId=a": () => ({ status: 200, data: { stats: stats("a") } }),
    "GET /api/integrations/wp-manager/overview?connectionId=b": () => ({ status: 200, data: { stats: stats("b") } }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      recorded.push({ method, url });
      const handler = routes[`${method} ${url}`];
      if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      const reply = handler();
      return new Response(JSON.stringify(reply.data), { status: reply.status, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WpOverviewSection", () => {
  it("reports a partial products sync as partial and offers the content sync alone", async () => {
    setContext();
    routes["POST /api/integrations/connections/a/sync/products"] = () => ({
      status: 200,
      data: { ok: true, created: 2, updated: 1, result: "partial", contentError: "HTTP 401", failedSteps: [{ step: "content", error: "HTTP 401" }] },
    });
    render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    fireEvent.click(screen.getByRole("button", { name: /^همگام‌سازی محصولات/ }));
    const notice = (await screen.findByText(/ناقص/)).closest("p")!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).not.toMatch(/همگام‌سازی محصولات انجام شد\./);
    expect(screen.getByRole("button", { name: "همگام‌سازی محتوا به‌تنهایی" })).toBeTruthy();
    // Counts refresh on the reply, not on a timer: one overview read before, one after.
    await waitFor(() => expect(recorded.filter((r) => r.url.includes("overview?connectionId=a"))).toHaveLength(2));
    expect((ctx.value!.reloadConnections as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("disables syncs the store's flags turn off, and all of them without the sync ability", async () => {
    setContext();
    render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    const orders = screen.getByRole("button", { name: /^همگام‌سازی سفارش‌ها/ });
    expect((orders as HTMLButtonElement).disabled).toBe(true);
    expect(orders.getAttribute("title")).toContain("غیرفعال");
    expect((screen.getByRole("button", { name: /^همگام‌سازی محصولات/ }) as HTMLButtonElement).disabled).toBe(false);

    cleanup();
    setContext({ abilities: ["view"] });
    render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    for (const label of ["محصولات", "مشتریان", "محتوا"]) {
      const button = screen.getByRole("button", { name: new RegExp(`^همگام‌سازی ${label}`) });
      expect((button as HTMLButtonElement).disabled, label).toBe(true);
      expect(button.getAttribute("title")).toContain("همگام‌سازی ووکامرس");
    }
    expect(screen.getByLabelText("محدودیت‌های همگام‌سازی").textContent).toContain("همگام‌سازی ووکامرس");
  });

  it("shows configured status and transport health as two badges, with the queue explanation for a stale plugin", async () => {
    setContext({ selectedId: "b" });
    render(<WpOverviewSection />);
    await screen.findByText("۹۹");
    const badges = screen.getByLabelText("وضعیت اتصال");
    expect(within(badges).getByText(/پیکربندی: فعال/)).toBeTruthy();
    expect(within(badges).getByText(/ارتباط: افزونه بی‌پاسخ/)).toBeTruthy();
    expect(screen.getByText(/بیش از ۱۵ دقیقه/).textContent).toContain("صف");
    expect(screen.getByRole("link", { name: "صف همگام‌سازی" }).getAttribute("href")).toBe("/websites/wp/queue?store=b");
  });

  it("the queue tiles count in-flight and attention work including the inbox and needs_review", async () => {
    setContext();
    render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    const inFlight = screen.getByText("در صف / در حال اجرا").closest("a")!;
    expect(within(inFlight).getByText("۵")).toBeTruthy();
    expect(inFlight.textContent).toContain("۳ ورودی");
    const attention = screen.getByText("نیازمند رسیدگی").closest("a")!;
    expect(within(attention).getByText("۳")).toBeTruthy();
    expect(attention.textContent).toContain("۱ بازبینی");
  });

  it("announces a failed KPI read with a retry instead of leaving «…» silently", async () => {
    setContext();
    routes["GET /api/integrations/wp-manager/overview?connectionId=a"] = () => ({ status: 403, data: { error: "forbidden" } });
    render(<WpOverviewSection />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("خواندن شمارنده‌ها ناموفق بود");
    expect(alert.textContent).toContain("دسترسی ندارید");
    routes["GET /api/integrations/wp-manager/overview?connectionId=a"] = () => ({ status: 200, data: { stats: stats("a") } });
    fireEvent.click(within(alert).getByRole("button", { name: "تلاش دوباره" }));
    await screen.findByText("۱۲");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("switching stores drops the previous store's numbers and notice", async () => {
    setContext();
    routes["POST /api/integrations/connections/a/sync/customers"] = () => ({ status: 200, data: { ok: true, result: "completed", created: 1 } });
    const view = render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    fireEvent.click(screen.getByRole("button", { name: /^همگام‌سازی مشتریان/ }));
    await screen.findByText(/همگام‌سازی مشتریان انجام شد/);

    setContext({ selectedId: "b" });
    view.rerender(<WpOverviewSection />);
    expect(screen.queryByText("۱۲")).toBeNull();
    expect(screen.queryByText(/همگام‌سازی مشتریان انجام شد/)).toBeNull();
    await screen.findByText("۹۹");
    expect(screen.queryByText(/همگام‌سازی مشتریان انجام شد/)).toBeNull();
  });

  it("a sync reply that lands after a store switch does not refresh the old store's numbers", async () => {
    setContext();
    let release: (() => void) | null = null;
    routes["POST /api/integrations/connections/a/sync/customers"] = () => ({ status: 200, data: { ok: true, result: "completed" } });
    const realFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") await new Promise<void>((resolve) => (release = resolve));
        return realFetch(url, init);
      }),
    );
    const view = render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    fireEvent.click(screen.getByRole("button", { name: /^همگام‌سازی مشتریان/ }));
    await waitFor(() => expect(release).not.toBeNull());

    setContext({ selectedId: "b" });
    view.rerender(<WpOverviewSection />);
    await screen.findByText("۹۹");
    const readsBefore = recorded.filter((r) => r.url.includes("overview?connectionId=a")).length;
    release!();
    await new Promise((r) => setTimeout(r, 30));
    // No new read for store A, and store B's numbers are still the ones on screen.
    expect(recorded.filter((r) => r.url.includes("overview?connectionId=a"))).toHaveLength(readsBefore);
    expect(screen.getByText("۹۹")).toBeTruthy();
    expect(screen.queryByText("۱۲")).toBeNull();
  });

  it("names stores by name and domain in the picker", async () => {
    setContext();
    render(<WpOverviewSection />);
    await screen.findByText("۱۲");
    const options = within(screen.getByLabelText("انتخاب فروشگاه")).getAllByRole("option");
    expect(options[0].textContent).toContain("a.example.com");
    expect(options[1].textContent).toContain("b.example.com");
  });
});
