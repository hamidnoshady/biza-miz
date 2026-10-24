// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
