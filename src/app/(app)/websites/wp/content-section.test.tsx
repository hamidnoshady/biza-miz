// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeState = vi.hoisted(() => ({
  value: {
    connections: [{ id: "store-1", name: "Shop", linkMode: "rest_api", status: "active" }],
    loadState: "loaded" as "loaded" | "error",
    loadError: null as { status: number; code: string } | null,
    selectedId: "store-1",
    setSelectedId: vi.fn(),
    reloadConnections: vi.fn(),
  },
}));

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/dashboard/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/dashboard/ui")>();
  return { ...actual, api: apiMock };
});
vi.mock("./wp-store-context", () => ({ useWpStore: () => storeState.value }));
vi.mock("./plugin-wait-note", () => ({ PluginWaitNote: () => null }));

import { WpContentSection } from "./content-section";

const restConnection = {
  id: "store-1",
  name: "Shop",
  linkMode: "rest_api" as const,
  status: "active",
};

beforeEach(() => {
  // Default: no mirror answer, so the permission/connection tests keep testing
  // exactly what they were written for.
  apiMock.mockReset();
  apiMock.mockResolvedValue({ ok: false, status: 0, data: { error: "network_error" } });
  storeState.value = {
    connections: [restConnection],
    loadState: "loaded" as "loaded" | "error",
    loadError: null as { status: number; code: string } | null,
    selectedId: "store-1",
    setSelectedId: vi.fn(),
    reloadConnections: vi.fn(),
  };
});

afterEach(cleanup);

describe("WordPress content permissions and connection loading", () => {
  it("keeps the content listing available but hides all manage actions for view-only members", () => {
    render(<WpContentSection canManage={false} />);

    expect(screen.getByText(/دسترسی فقط‌خواندنی است/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "همگام‌سازی" })).toBeNull();
    expect(screen.queryByRole("button", { name: /نوشتهٔ تازه/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /برگهٔ تازه/ })).toBeNull();
  });

  it("shows management controls only when the server supplies manage permission", () => {
    render(<WpContentSection canManage />);

    expect(screen.getByRole("button", { name: "همگام‌سازی" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /نوشتهٔ تازه/ })).toBeTruthy();
  });

  it("keeps the last known store visible and offers a retry when a refresh fails", () => {
    storeState.value = {
      connections: [restConnection],
      loadState: "error",
      loadError: { status: 0, code: "network_error" },
      selectedId: "store-1",
      setSelectedId: vi.fn(),
      reloadConnections: vi.fn(),
    };
    render(<WpContentSection canManage />);

    expect(screen.getByText(/فهرست قبلی نمایش داده می‌شود/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
    expect(screen.queryByText(/ابتدا یک فروشگاه وردپرس/)).toBeNull();
  });
});

const cardRow = {
  remoteId: "42",
  wpType: "post",
  title: "راهنمای نگهداری فرش",
  slug: "rug-care",
  status: "publish",
  permalink: "",
  authorName: "سارا",
  mediaUrl: null,
  mimeType: null,
  content: null,
  remoteUpdatedAt: "2026-10-01T10:00:00.000Z",
  syncedAt: "2026-10-02T10:00:00.000Z",
  writeStatus: null,
};

describe("editorial cards", () => {
  beforeEach(() => {
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) =>
      Promise.resolve(
        String(path).startsWith("/api/integrations/wp-manager/content")
          ? {
              ok: true,
              status: 200,
              data: {
                rows: [
                  { ...cardRow, featuredImageUrl: "https://shop.example/wp/thumb.jpg", excerptText: "خلاصهٔ کوتاه نوشته" },
                  { ...cardRow, remoteId: "43", wpType: "page", featuredImageUrl: null, excerptText: "" },
                ],
                total: 2,
                page: 1,
                pageSize: 20,
              },
            }
          : { ok: true, status: 200, data: {} },
      ),
    );
  });

  it("draws the site's featured image, the excerpt preview and the content type", async () => {
    const { container } = render(<WpContentSection canManage />);

    await screen.findAllByText("راهنمای نگهداری فرش");
    expect(container.querySelector('img[src="https://shop.example/wp/thumb.jpg"]')).toBeTruthy();
    expect(screen.getByText("خلاصهٔ کوتاه نوشته")).toBeTruthy();
    // Two rows, one with a featured image: the second keeps the standalone icon.
    expect(container.querySelectorAll("img")).toHaveLength(1);
  });

  it("labels each card with its real type instead of leaving the tab to imply it", async () => {
    render(<WpContentSection canManage />);

    await screen.findAllByText("راهنمای نگهداری فرش");
    expect(screen.getAllByText("نوشته").length).toBeGreaterThan(0);
  });

  it("never renders an image for a row whose featured attachment is not mirrored yet", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, data: { rows: [{ ...cardRow, featuredImageUrl: null, excerptText: "" }], total: 1, page: 1, pageSize: 20 } }),
    );
    const { container } = render(<WpContentSection canManage />);

    await screen.findAllByText("راهنمای نگهداری فرش");
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("scheduling from the editor", () => {
  const detail = {
    ...cardRow,
    editorTitle: "نگهداری فرش",
    excerpt: "خلاصه",
    permalink: "https://shop.example/rug-care",
    scheduledFor: null,
  };

  function mockApi() {
    apiMock.mockImplementation((path: string, init?: { method?: string; body?: string }) => {
      const url = String(path);
      if (url.startsWith("/api/integrations/wp-manager/content/posts") && init?.method === "POST") {
        return Promise.resolve({ ok: true, status: 200, data: { ok: true, queued: true } });
      }
      if (url.startsWith("/api/integrations/wp-manager/content/posts")) {
        return Promise.resolve({ ok: true, status: 200, data: { row: detail } });
      }
      if (url.startsWith("/api/integrations/wp-manager/content")) {
        return Promise.resolve({ ok: true, status: 200, data: { rows: [cardRow], total: 1, page: 1, pageSize: 20 } });
      }
      return Promise.resolve({ ok: true, status: 200, data: {} });
    });
  }

  async function openEditor() {
    const user = userEvent.setup();
    render(<WpContentSection canManage />);
    await user.click(await screen.findByRole("button", { name: /ویرایش/ }));
    return user;
  }

  it("shows a Jalali date and a clock only once the owner picks «زمان‌بندی‌شده»", async () => {
    mockApi();
    const user = await openEditor();

    await screen.findByDisplayValue("نگهداری فرش");
    expect(screen.queryByLabelText("تاریخ انتشار")).toBeNull();

    await user.selectOptions(screen.getByLabelText("وضعیت"), "future");

    expect(await screen.findByLabelText("تاریخ انتشار")).toBeTruthy();
    expect(screen.getByLabelText("ساعت انتشار")).toBeTruthy();
  });

  it("sends the schedule as one instant beside the status, never as a raw date", async () => {
    mockApi();
    const user = await openEditor();

    await screen.findByDisplayValue("نگهداری فرش");
    await user.selectOptions(screen.getByLabelText("وضعیت"), "future");
    const clock = await screen.findByLabelText("ساعت انتشار");
    await user.clear(clock);
    await user.type(clock, "10:15");
    await user.click(screen.getByRole("button", { name: "ذخیره در وردپرس" }));

    const posts = () =>
      apiMock.mock.calls.filter(
        ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
      );
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(String((posts()[0][1] as { body: string }).body));
    expect(body.status).toBe("future");
    // 10:15 Tehran is 06:45 UTC.
    expect(body.scheduledFor).toMatch(/T06:45:00\.000Z$/);
    expect(body.date_gmt).toBeUndefined();
  });

  it("hides «زمان‌بندی‌شده» on a store whose plugin cannot apply date_gmt", async () => {
    storeState.value = {
      ...storeState.value,
      connections: [
        {
          id: "store-1",
          name: "Shop",
          linkMode: "plugin" as const,
          status: "active",
          pluginCapabilities: { jobTypes: ["post_upsert"] },
        },
      ] as never,
    };
    mockApi();
    const user = await openEditor();

    await screen.findByDisplayValue("نگهداری فرش");
    expect(screen.queryByRole("option", { name: "زمان‌بندی‌شده" })).toBeNull();
    expect(screen.queryByLabelText("تاریخ انتشار")).toBeNull();
    expect(user).toBeTruthy();
  });

  it("refuses to save a schedule it cannot honour, before anything is queued", async () => {
    mockApi();
    const user = await openEditor();

    await screen.findByDisplayValue("نگهداری فرش");
    await user.selectOptions(screen.getByLabelText("وضعیت"), "future");
    const clock = await screen.findByLabelText("ساعت انتشار");
    // Clearing the clock leaves the schedule without an instant; there is
    // nothing honest to send, so the editor stops before queuing anything.
    await user.clear(clock);
    await user.click(screen.getByRole("button", { name: "ذخیره در وردپرس" }));

    expect(await screen.findByText(/تاریخ و ساعت انتشار را انتخاب کنید/)).toBeTruthy();
    const posts = apiMock.mock.calls.filter(
      ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });
});
