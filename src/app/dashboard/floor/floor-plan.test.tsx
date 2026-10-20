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

  it("never displays a combined payable session_total on the floor canvas and supports manual cleaning transition", async () => {
    await act(async () => {
      render(<FloorPlan canEdit />);
    });

    // Active order count badge is shown, but the combined session_total (370000) is NOT shown
    expect(screen.getAllByText("۲ سفارش فعال").length).toBeGreaterThan(0);
    expect(screen.queryByText(/370000/)).toBeNull();
    expect(screen.queryByText(/۳۷۰۰۰۰/)).toBeNull();

    // Select میز ۱ in operational mode and click manual 'در حال نظافت' transition
    click(screen.getByText("میز ۱"));
    click(screen.getByRole("button", { name: "در حال نظافت" }));

    expect(apiMock).toHaveBeenCalledWith(
      "/api/tables/table-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ status: "cleaning" }),
      }),
    );
  });

  it("supports restoring archived tables and editing section name, color, and sortOrder in layout edit mode", async () => {
    apiMock.mockImplementation(async (url: string) => {
      if (url === "/api/floor") {
        return {
          ok: true,
          data: {
            ...initialFloorData,
            sections: [
              {
                id: "sec-1",
                name: "سالن اصلی",
                color: "#0f766e",
                assigned_waiter_id: null,
                waiter_name: null,
                sort_order: 0,
              },
              {
                id: "sec-2",
                name: "تراس",
                color: "#1d4ed8",
                assigned_waiter_id: null,
                waiter_name: null,
                sort_order: 1,
              },
            ],
            archivedTables: [
              { id: "arch-9", name: "میز ۹", capacity: 6, section_id: "sec-1" },
            ],
          },
        };
      }
      if (url === "/api/staff") {
        return { ok: true, data: { staff: [] } };
      }
      return { ok: true, data: { ok: true } };
    });

    await act(async () => {
      render(<FloorPlan canEdit />);
    });

    click(screen.getByText("ویرایش چیدمان"));

    // 1. Restore archived table (میز ۹)
    expect(screen.getByText(/میزهای بایگانی‌شده/)).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: "بازیابی" }).click();
    });
    expect(apiMock).toHaveBeenCalledWith(
      "/api/tables/arch-9",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ isActive: true }),
      }),
    );

    // 2. Reorder section (move سالن اصلی down)
    await act(async () => {
      screen.getByLabelText("جابه‌جایی سالن اصلی به پایین").click();
    });
    expect(apiMock).toHaveBeenCalledWith(
      "/api/floor/sections/sec-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ sortOrder: 1 }),
      }),
    );

    // 3. Inline rename & color change on section
    click(screen.getByLabelText("ویرایش بخش سالن اصلی"));
    const sectionNameInput = screen.getByLabelText("نام بخش سالن اصلی") as HTMLInputElement;
    typeInput(sectionNameInput, "سالن VIP");
    click(screen.getByLabelText("رنگ #7c3aed"));
    await act(async () => {
      screen.getByText("ذخیره بخش").click();
    });

    expect(apiMock).toHaveBeenCalledWith(
      "/api/floor/sections/sec-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "سالن VIP", color: "#7c3aed" }),
      }),
    );
  });
});
