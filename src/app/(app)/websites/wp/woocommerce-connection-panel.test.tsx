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
