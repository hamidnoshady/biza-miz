// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("global inbox", () => {
  it("exposes unread count, filters and permission-safe links even without Push", async () => {
    const entries = [
      {
        id: "one",
        title: "موجودی کم",
        body: "جزئیات",
        url: "/accounting/inventory",
        readAt: null,
        severity: "important",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ];
    let unread = 1;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        unread = 0;
        return new Response('{"updated":1}');
      }
      return new Response(
        JSON.stringify({
          entries: entries.map((e) => ({ ...e, readAt: unread ? null : "2026-06-01" })),
          unread,
          retentionDays: 90,
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);
    render(<NotificationBell identity="business:user" />);
    const bell = await screen.findByRole("button", { name: "اعلان‌ها، 1 خوانده‌نشده" });
    fireEvent.click(bell);
    expect(screen.getByRole("region", { name: "صندوق اعلان" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /موجودی کم/ }).getAttribute("href")).toBe(
      "/accounting/inventory",
    );
    fireEvent.click(screen.getByRole("button", { name: "خواندن همه" }));
    await screen.findByRole("button", { name: "اعلان‌ها، 0 خوانده‌نشده" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/notifications/inbox",
      expect.objectContaining({ method: "PATCH", body: "{}" }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "فیلتر اعلان‌ها" }), {
      target: { value: "unread" },
    });
    expect(screen.queryByRole("link", { name: /موجودی کم/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("region", { name: "صندوق اعلان" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "صندوق اعلان" })).toBeNull());
    expect(document.activeElement).toBe(bell);
  });
});
