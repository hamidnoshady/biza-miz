// @vitest-environment jsdom

/**
 * Issue #911 — two state bugs in the آیتم‌ها tab.
 *
 * 1. The move dialog kept its destination. «انصراف» and a successful move
 *    both closed it without going through `onOpenChange`, which was the only
 *    path that cleared the selection — so the next item opened with the
 *    previous destination already chosen, one confirmation away from being
 *    moved to a category nobody picked.
 * 2. Manual ordering existed for the shared menu reorder API but had no UI:
 *    this tab could *sort* items for viewing and could not change the order
 *    the till sells them in. The move posts the whole category ordering in
 *    one request, so a failure cannot leave two items on one sort slot.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestaurantMenuData, RestaurantMenuItem } from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";
import { ItemsPanel } from "./items-panel";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CATEGORY_A = "22222222-2222-4222-8222-222222222222";
const CATEGORY_B = "33333333-3333-4333-8333-333333333333";

function item(id: string, name: string, sortOrder: number): RestaurantMenuItem {
  return {
    id,
    categoryId: CATEGORY_A,
    name,
    description: null,
    sku: null,
    price: 120_000,
    imageUrl: null,
    imageMediaId: null,
    isActive: true,
    sortOrder,
    targetMarginPercent: null,
  };
}

const DATA: RestaurantMenuData = {
  categories: [
    { id: CATEGORY_A, name: "نوشیدنی", taxRate: 0, isActive: true, sortOrder: 0 },
    { id: CATEGORY_B, name: "شیرینی", taxRate: 0, isActive: true, sortOrder: 1 },
  ],
  items: [
    item("aaaaaaaa-0000-4000-8000-000000000001", "اسپرسو", 0),
    item("aaaaaaaa-0000-4000-8000-000000000002", "لاته", 1),
    item("aaaaaaaa-0000-4000-8000-000000000003", "موکا", 2),
  ],
  modifierGroups: [],
  modifiers: [],
  itemModifierGroups: [],
};

type SentRequest = { url: string; method: string; body: unknown };
let sent: SentRequest[] = [];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const run: Runner = async (fn) => {
  const result = await fn();
  if (result.ok) return { ok: true as const, data: result.data };
  return { ok: false as const, error: "خطا", data: result.data };
};

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getAllByRole("button", { name: `عملیات ${name}` })[0]);
  return user;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        sent.push({ url: String(input), method: init.method, body: JSON.parse(String(init.body)) });
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel() {
  const onNotice = vi.fn();
  render(
    <ItemsPanel
      data={DATA}
      latest={{}}
      canEdit
      busy={false}
      run={run}
      onOpenItem={vi.fn()}
      onChangePrice={vi.fn()}
      onNotice={onNotice}
    />,
  );
  return { onNotice };
}

describe("ItemsPanel — manual ordering", () => {
  it("moves an item up by posting the whole category ordering at once", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderPanel();

    // لاته is second of three in the stored order.
    // The table and the mobile card render the same controls; the table is
    // the one a desktop operator reaches for.
    await user.click(screen.getAllByRole("button", { name: "بالا بردن لاته در منو" })[0]);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe("/api/menu/reorder");
    expect(sent[0].body).toEqual({
      entity: "items",
      ids: [
        "aaaaaaaa-0000-4000-8000-000000000002", // لاته
        "aaaaaaaa-0000-4000-8000-000000000001", // اسپرسو
        "aaaaaaaa-0000-4000-8000-000000000003", // موکا
      ],
    });
    expect(onNotice).toHaveBeenCalled();
  });

  it("cannot move the first item up or the last one down", async () => {
    renderPanel();
    expect(
      (screen.getAllByRole("button", { name: "بالا بردن اسپرسو در منو" })[0] as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getAllByRole("button", { name: "پایین بردن موکا در منو" })[0] as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("ItemsPanel — the move-category dialog", () => {
  it("forgets the destination it was cancelled with", async () => {
    const user = userEvent.setup();
    renderPanel();

    // Open the move dialog for لاته and choose a destination.
    await openRowMenu(user, "لاته");
    await user.click(await screen.findByRole("menuitem", { name: "انتقال به دسته" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "دستهٔ مقصد" }));
    await user.click(await screen.findByRole("option", { name: "شیرینی" }));

    // «انصراف» does not go through onOpenChange — the path that used to be
    // the only one clearing the destination.
    await user.click(screen.getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopening for another item must not offer the earlier destination.
    await openRowMenu(user, "موکا");
    await user.click(await screen.findByRole("menuitem", { name: "انتقال به دسته" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "دستهٔ مقصد" }).textContent).toContain("انتخاب دسته");
    // And the move button stays disabled until a destination is chosen again.
    expect(
      (screen.getAllByRole("button", { name: "انتقال" })[0] as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
