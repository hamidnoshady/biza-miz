/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginLocalQueuePage } from "./plugin-local-queue-page";

const state = (body: unknown) => ({ ok: true, json: async () => body });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#1076 plugin-local queue paging control", () => {
  it("shows the answer the plugin already gave, with its cursor", async () => {
    fetchMock.mockResolvedValue(
      state({
        supported: true,
        request: null,
        answer: {
          after: 0,
          limit: 10,
          next: 12,
          answeredAt: "2026-11-05T09:55:00.000Z",
          rows: [
            { topic: "order.updated", remoteId: "8301", status: "failed", attempts: 4, lastError: "timeout", createdAt: "2026-11-05T09:00:00+00:00" },
          ],
        },
      }),
    );
    render(<PluginLocalQueuePage connectionId="site" canSync />);

    await screen.findByText(/صفحهٔ پس از/);
    expect(screen.getByText("order.updated")).toBeTruthy();
    expect(screen.getByText("ناموفق")).toBeTruthy();
    expect(screen.getByText(/صفحهٔ بعدی از رویداد/)).toBeTruthy();
    // The next page continues from the plugin's cursor, not from a page count.
    fireEvent.click(screen.getByRole("button", { name: /صفحهٔ بعدی صف افزونه/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/wp-manager/queue/local",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ connectionId: "site", after: 12, limit: 10 });
  });

  it("says a request is recorded and answered later, never that rows are coming now", async () => {
    fetchMock
      .mockResolvedValueOnce(state({ supported: true, request: null, answer: null }))
      .mockResolvedValueOnce(state({ ok: true, request: { after: 0, limit: 10, requestedAt: "2026-11-05T10:00:00.000Z" } }));
    render(<PluginLocalQueuePage connectionId="site" canSync />);

    fireEvent.click(await screen.findByRole("button", { name: /پیمایش صف افزونه/ }));
    await screen.findByText(/ثبت شد/);
    expect(screen.getByRole("status").textContent).toContain("اجرای بعدی");
  });

  it("tells a legacy-plugin answer apart from an empty page", async () => {
    fetchMock.mockResolvedValue(state({ supported: false, reason: "plugin_too_old" }));
    render(<PluginLocalQueuePage connectionId="site" canSync />);
    await screen.findByText(/به نسخهٔ جدید افزونه نیاز دارد/);
    expect(screen.queryByRole("button", { name: /پیمایش صف افزونه/ })).toBeNull();
  });

  it("does not offer a request to a view-only member", async () => {
    fetchMock.mockResolvedValue(state({ supported: true, request: null, answer: null }));
    render(<PluginLocalQueuePage connectionId="site" canSync={false} />);
    const button = await screen.findByRole("button", { name: /پیمایش صف افزونه/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/دسترسی «همگام‌سازی ووکامرس»/)).toBeTruthy();
  });

  it("surfaces a paused connection as its own refusal", async () => {
    fetchMock
      .mockResolvedValueOnce(state({ supported: true, request: null, answer: null }))
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "connection_paused" }) });
    render(<PluginLocalQueuePage connectionId="site" canSync />);
    fireEvent.click(await screen.findByRole("button", { name: /پیمایش صف افزونه/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("متوقف");
  });
});
