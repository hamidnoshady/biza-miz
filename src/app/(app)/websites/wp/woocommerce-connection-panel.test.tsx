/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WpConnectionPanel } from "./woocommerce-connection-panel";
import { api } from "@/app/dashboard/ui";
vi.mock("@/components/feature-lock", () => ({ useFeatureLocked: () => false }));
vi.mock("./woo-store-sections", () => ({ SyncSettingsSection: () => null }));
vi.mock("@/app/dashboard/ui", () => ({
  api: vi.fn(), errorMessageOrRaw: (message: string) => message,
  ErrorBox: ({ children }: { children?: React.ReactNode }) => <div role="alert">{children}</div>,
  InfoBox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>, inputClass: "",
}));
const woo = { id: "woo", name: "Public store", provider: "woocommerce", baseUrl: "https://store.example.com", status: "active", linkMode: "plugin", inbox: {}, outbox: {} };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  vi.mocked(api).mockResolvedValue({ ok: true, data: { connections: [woo, { ...woo, id: "holoo", name: "Accounting database", provider: "holoo" }] } } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("defensively removes Holoo from a mixed response and requires disconnect confirmation", async () => {
  render(<WpConnectionPanel canRotateTokens />);
  expect(await screen.findByText("Public store")).toBeTruthy();
  expect(screen.queryByText("Accounting database")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "قطع اتصال" }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Public store"));
  expect(api).toHaveBeenCalledTimes(1);
  vi.mocked(window.confirm).mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "قطع اتصال" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/integrations/connections/woo", expect.objectContaining({ method: "DELETE" })));
});
it("warns about rotation outage and keeps a one-time token visible if clipboard fails", async () => {
  vi.mocked(window.confirm).mockReturnValue(true);
  vi.mocked(api).mockImplementation(async (path) => path.endsWith("/link-token")
    ? { ok: true, data: { linkToken: "show-once-token" } } as never
    : { ok: true, data: { connections: [woo] } } as never);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<WpConnectionPanel canRotateTokens />);
  fireEvent.click(await screen.findByRole("button", { name: "تعویض توکن افزونه" }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("فوراً قطع"));
  expect(await screen.findByText("show-once-token")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "کپی و بستن" }));
  expect(await screen.findByText("کپی انجام نشد؛ مقدار را دستی کپی کنید.")).toBeTruthy();
  expect(screen.getByText("show-once-token")).toBeTruthy();
});

// Issue #1206: the scheduler's *current* state and the interruption it ended
// are two different rows on the screen. A recovered store must not keep
// showing a live warning, and a dead scheduler must not hide behind a fresh
// connection test.
const pluginHealth = (overrides: Record<string, unknown> = {}) => ({
  status: "active",
  lastPluginSeenAt: new Date(Date.now() - 5_000).toISOString(),
  linkMode: "plugin",
  pluginHealthSummary: {
    silentMinutes: 0,
    stale: false,
    alert: false,
    cron: { state: "healthy", reason: "recent_start", lastAttemptAt: new Date(Date.now() - 5_000).toISOString(), missedIntervals: 0 },
    cronStale: false,
    cronGapSeconds: 5,
    lastVerifiedCycleAt: new Date(Date.now() - 5_000).toISOString(),
    lastDataAppliedAt: new Date(Date.now() - 300_000).toISOString(),
    lastCycleVerdict: "empty",
    nextDueAt: new Date(Date.now() + 55_000).toISOString(),
    previousOutageAt: "2026-10-31T09:00:00.000Z",
    recoveredAt: "2026-10-31T10:00:00.000Z",
    incidentOpen: false,
    queueSize: 0,
    oldestQueuedAgeSeconds: null,
    ...overrides,
  },
});

it("shows a recovered gap as history instead of a live cron warning", async () => {
  vi.mocked(api).mockResolvedValue({ ok: true, data: { connections: [{ ...woo, ...pluginHealth() }] } } as never);
  render(<WpConnectionPanel canRotateTokens />);
  expect(await screen.findByText("کرون در حال اجرا")).toBeTruthy();
  expect(screen.getByText(/وقفهٔ پیشین/)).toBeTruthy();
  expect(screen.getByText(/رفع‌شده در/)).toBeTruthy();
  expect(screen.queryByText(/مدتی اجرا نشده بود/)).toBeNull();
});

it("reports a stopped scheduler with its reason, and does not call a connection test a cron test", async () => {
  vi.mocked(api).mockResolvedValue({
    ok: true,
    data: {
      connections: [
        {
          ...woo,
          ...pluginHealth({
            stale: true,
            alert: true,
            cron: { state: "failed", reason: "no_start_since", lastAttemptAt: new Date(Date.now() - 30 * 60_000).toISOString(), missedIntervals: 30 },
            incidentOpen: true,
          }),
        },
      ],
    },
  } as never);
  render(<WpConnectionPanel canRotateTokens />);
  expect(await screen.findByText("کرون اجرا نمی‌شود")).toBeTruthy();
  expect(screen.getByText(/کرون سیستم یا مسیر WP-CLI/)).toBeTruthy();
  expect(screen.getByText(/هنوز رفع نشده/)).toBeTruthy();
});
