// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_EMBED_ATTRIBUTE } from "@/lib/cloud-embed";
import { NotificationBell } from "./notification-bell";
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute(CLOUD_EMBED_ATTRIBUTE);
});
describe("global inbox", () => {
  it("leaves the bell and its polling to the host when the embed marker is present", () => {
    document.documentElement.setAttribute(CLOUD_EMBED_ATTRIBUTE, "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<NotificationBell identity="business:user" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not display zero on a failed request and clears the count on identity change", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ entries: [], unread: 47, retentionDays: 90 }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = render(<NotificationBell identity="business:user" />);
    expect(screen.queryByRole("button", { name: /0 خوانده‌نشده/ })).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.focus(window);
    await screen.findByRole("button", { name: "اعلان‌ها، 47 خوانده‌نشده" });
    fireEvent.focus(window);
    await screen.findByRole("button", { name: "اعلان‌ها، 47 خوانده‌نشده، ممکن است به‌روز نباشد" });

    rerender(<NotificationBell identity="business:other-user" />);
    expect(screen.queryByRole("button", { name: /47 خوانده‌نشده/ })).toBeNull();
    await screen.findByRole("button", { name: "اعلان‌ها، شمار خوانده‌نشده نامشخص است" });
  });

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
    expect(screen.getByRole("dialog", { name: "صندوق اعلان" })).toBeTruthy();
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
    fireEvent.keyDown(screen.getByRole("dialog", { name: "صندوق اعلان" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "صندوق اعلان" })).toBeNull());
    expect(document.activeElement).toBe(bell);
  });
});
