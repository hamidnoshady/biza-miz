// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FloorPlan } from "./floor-plan";

const realtimeListeners: Array<(event: { type: string }) => void> = [];
const apiMock = vi.fn();

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>();
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../use-realtime", () => ({
  useRealtime: (cb: (event: { type: string }) => void) => {
    realtimeListeners.push(cb);
  },
}));

vi.mock("@/components/money/money-context", () => ({
  useMoney: () => ({
    format: (n: number) => `${n} ریال`,
    short: (n: number) => `${n}`,
  }),
}));

vi.mock("../knowledge-help", () => ({
  KnowledgeHelpButton: () => null,
}));

vi.mock("./session-panel", () => ({
  SessionPanel: () => <div data-testid="session-panel" />,
}));

afterEach(() => {
  cleanup();
  realtimeListeners.length = 0;
});

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function typeInput(field: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    field.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

const initialFloorData = {
  timezone: "Asia/Tehran",
  sections: [
    {
      id: "sec-1",
      name: "سالن اصلی",
      color: "#0f766e",
      assigned_waiter_id: null,
      waiter_name: null,
      sort_order: 1,
    },
  ],
  tables: [
    {
      id: "table-1",
      name: "میز ۱",
      zone: null,
      section_id: "sec-1",
      capacity: 4,
      status: "seated",
      pos_x: 40,
      pos_y: 60,
      width: 96,
      height: 96,
      shape: "rect",
      sort_order: 1,
      note: null,
      session_id: "sess-1",
      party_size: 3,
      guest_name: "رضا",
      session_opened_at: "2026-10-20T12:00:00Z",
      bill_requested_at: null,
      session_note: null,
      active_order_count: 2,
      order_count: 2,
      session_total: "370000",
      open_orders: [
        { id: "o-1", order_number: 101, status: "open", total: "150000" },
        { id: "o-2", order_number: 102, status: "held", total: "220000" },
      ],
      upcoming_reservation: null,
    },
  ],
  archivedTables: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.mockImplementation(async (url: string) => {
    if (url === "/api/floor") {
      return { ok: true, data: initialFloorData };
    }
    if (url === "/api/staff") {
      return { ok: true, data: { staff: [] } };
    }
    return { ok: true, data: {} };
  });
});

describe("FloorPlan — canvas zoom, list fallback, and TableEditor dirty-state preservation", () => {
  it("supports canvas zoom controls and toggles between canvas and accessible list fallback", async () => {
    await act(async () => {
      render(<FloorPlan canEdit />);
    });

    expect(screen.getByText("۱۰۰٪")).toBeTruthy();
    click(screen.getByLabelText("بزرگ‌نمایی"));
    expect(screen.getByText("۱۱۰٪")).toBeTruthy();
    click(screen.getByLabelText("کوچک‌نمایی"));
    expect(screen.getByText("۱۰۰٪")).toBeTruthy();

    // Switch to accessible list fallback
    click(screen.getByText("نمایش فهرستی"));
    expect(screen.getByText("نمایش نقشه")).toBeTruthy();
    expect(screen.getByText("۲ سفارش فعال")).toBeTruthy();
  });

  it("preserves unsaved dirty form state in TableEditor when background realtime refresh runs", async () => {
    await act(async () => {
      render(<FloorPlan canEdit />);
    });

    // Enter layout edit mode and select میز ۱
    click(screen.getByText("ویرایش چیدمان"));
    click(screen.getByText("میز ۱"));

    const editHeading = screen.getByText("ویرایش میز ۱");
    expect(editHeading).toBeTruthy();

    const editorContainer = editHeading.closest("div")?.parentElement as HTMLElement;
    const nameInput = editorContainer.querySelector("input") as HTMLInputElement;
    expect(nameInput.value).toBe("میز ۱");

    // User edits the name without saving yet (dirty = true)
    typeInput(nameInput, "میز ویژه ۵");
    expect(nameInput.value).toBe("میز ویژه ۵");

    // Trigger a background realtime refresh (`floor.updated`)
    await act(async () => {
      for (const listener of realtimeListeners) {
        listener({ type: "floor.updated" });
      }
    });

    // Unsaved dirty input value is preserved across the background refresh
    expect(nameInput.value).toBe("میز ویژه ۵");
  });
});
