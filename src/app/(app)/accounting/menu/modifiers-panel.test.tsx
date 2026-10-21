// @vitest-environment jsdom

/**
 * Issue #910 — destructive add-on actions are confirmed, explained, and
 * counted, and a view-only member gets no edit affordances at all.
 *
 * The review's complaint was that the trash button on an option deleted it
 * on the spot, and that deleting a group could take options and attachments
 * with it without saying how many. These tests click the real buttons:
 *
 *   - opening the option's trash shows a confirmation and sends nothing;
 *     cancelling still sends nothing; confirming sends exactly one DELETE;
 *   - deleting a group is explained with the server's affected counts, and a
 *     group that the server deactivates instead is reported that way (with
 *     Persian digits), not as «deleted»;
 *   - with `canEdit={false}` there is no «افزودن گروه», no row action menu,
 *     no option switch/edit/delete, and the group sheet shows the bounds as
 *     text rather than as editable inputs.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RestaurantMenuData,
  RestaurantModifier,
  RestaurantModifierGroup,
} from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";
import { ModifiersPanel } from "./modifiers-panel";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const GROUP_A = "11111111-1111-4111-8111-111111111111";
const GROUP_B = "22222222-2222-4222-8222-222222222222";
const OPTION_SHOT = "33333333-3333-4333-8333-333333333333";
const OPTION_SOY = "44444444-4444-4444-8444-444444444444";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";

function group(
  id: string,
  name: string,
  overrides: Partial<RestaurantModifierGroup> = {},
): RestaurantModifierGroup {
  return {
    id,
    name,
    minSelect: 0,
    maxSelect: 3,
    sortOrder: 0,
    isActive: true,
    ...overrides,
  };
}

function option(
  id: string,
  groupId: string,
  name: string,
  priceDelta: number,
  sortOrder = 0,
): RestaurantModifier {
  return { id, groupId, name, priceDelta, sortOrder, isActive: true };
}

const DATA: RestaurantMenuData = {
  categories: [],
  items: [
    {
      id: ITEM_ID,
      categoryId: "66666666-6666-4666-8666-666666666666",
      name: "لاته",
      description: null,
      sku: null,
      price: 100_000,
      imageUrl: null,
      imageMediaId: null,
      isActive: true,
      sortOrder: 0,
      targetMarginPercent: null,
    },
  ],
  modifierGroups: [group(GROUP_A, "افزودنی‌های قهوه"), group(GROUP_B, "شیر جایگزین")],
  modifiers: [
    option(OPTION_SHOT, GROUP_A, "شات اضافه", 20_000, 0),
    option(OPTION_SOY, GROUP_A, "شیر سویا", 15_000, 1),
  ],
  itemModifierGroups: [
    {
      menuItemId: ITEM_ID,
      modifierGroupId: GROUP_A,
      minSelectOverride: null,
      maxSelectOverride: null,
      sortOrder: 0,
      isActive: true,
    },
  ],
};

type SentRequest = { url: string; method: string; body: string | null };
let sent: SentRequest[] = [];
let respondWith: (request: SentRequest) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { ok: true },
});

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

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  sent = [];
  respondWith = () => ({ status: 200, body: { ok: true } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: SentRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : String(init.body),
      };
      if (request.method !== "GET") sent.push(request);
      const reply = respondWith(request);
      return jsonResponse(reply.status, reply.body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel({ canEdit = true, data = DATA }: { canEdit?: boolean; data?: RestaurantMenuData } = {}) {
  const onNotice = vi.fn();
  render(<ModifiersPanel data={data} canEdit={canEdit} run={run} onNotice={onNotice} />);
  return { onNotice };
}

async function openGroupSheet(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("row", { name: `جزئیات ${name}` }));
  // Radix labels the sheet by its `SheetTitle`, which wins over the
  // `aria-label` on the content — so the accessible name is the group name.
  return screen.findByRole("dialog", { name });
}

describe("ModifiersPanel — deleting an option", () => {
  it("asks first, and cancelling sends nothing", async () => {
    const user = userEvent.setup();
    renderPanel();
    await openGroupSheet(user, "افزودنی‌های قهوه");

    await user.click(screen.getByRole("button", { name: "حذف شات اضافه" }));

    const dialog = await screen.findByRole("dialog", { name: "حذف «شات اضافه»" });
    expect(within(dialog).getByText(/فقط غیرفعال می‌ماند/)).toBeTruthy();
    // Nothing has been sent: the trash button only opens the question.
    expect(sent).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "انصراف" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "حذف «شات اضافه»" })).toBeNull(),
    );
    expect(sent).toHaveLength(0);
  });

  it("sends exactly one DELETE when confirmed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await openGroupSheet(user, "افزودنی‌های قهوه");

    await user.click(screen.getByRole("button", { name: "حذف شات اضافه" }));
    const dialog = await screen.findByRole("dialog", { name: "حذف «شات اضافه»" });
    await user.click(within(dialog).getByRole("button", { name: "حذف / غیرفعال کردن" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: `/api/menu/modifiers/${OPTION_SHOT}`,
      method: "DELETE",
    });
  });

  it("keeps the dialog open and shows the server's refusal", async () => {
    respondWith = () => ({ status: 409, body: { error: "modifier_required_minimum" } });
    const user = userEvent.setup();
    renderPanel();
    await openGroupSheet(user, "افزودنی‌های قهوه");

    await user.click(screen.getByRole("button", { name: "حذف شات اضافه" }));
    const dialog = await screen.findByRole("dialog", { name: "حذف «شات اضافه»" });
    await user.click(within(dialog).getByRole("button", { name: "حذف / غیرفعال کردن" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    // Still open: the operator can read why and choose «انصراف» deliberately.
    expect(screen.getByRole("dialog", { name: "حذف «شات اضافه»" })).toBeTruthy();
  });
});

describe("ModifiersPanel — deleting a group", () => {
  it("shows how many items and options are affected before anything is sent", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "عملیات افزودنی‌های قهوه" }));
    await user.click(await screen.findByRole("menuitem", { name: "حذف" }));

    const dialog = await screen.findByRole("dialog", { name: "حذف «افزودنی‌های قهوه»" });
    // One item carries the group; two options belong to it.
    expect(within(dialog).getByText(/به ۱ آیتم وصل است و ۲ گزینه دارد/)).toBeTruthy();
    expect(sent).toHaveLength(0);
    // The action menu is a portal: its clicks must not fall through to the row
    // and open the group sheet behind the confirmation (regression).
    expect(screen.queryByRole("dialog", { name: "افزودنی‌های قهوه" })).toBeNull();
  });

  it("reports a deactivation as preserved, not deleted", async () => {
    respondWith = () => ({
      status: 200,
      body: { ok: true, deactivated: true, affected: { items: 1, options: 2 } },
    });
    const user = userEvent.setup();
    const { onNotice } = renderPanel();

    await user.click(screen.getByRole("button", { name: "عملیات افزودنی‌های قهوه" }));
    await user.click(await screen.findByRole("menuitem", { name: "حذف" }));
    const dialog = await screen.findByRole("dialog", { name: "حذف «افزودنی‌های قهوه»" });
    await user.click(within(dialog).getByRole("button", { name: "حذف کن" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      url: `/api/menu/modifier-groups/${GROUP_A}`,
      method: "DELETE",
    });
    await waitFor(() => expect(onNotice).toHaveBeenCalledTimes(1));
    const message = onNotice.mock.calls[0][0] as string;
    expect(message).toContain("غیرفعال شد");
    expect(message).toContain("۱ آیتم");
    expect(message).toContain("۲ گزینه");
  });
});

describe("ModifiersPanel — a view-only member", () => {
  it("sees no create, reorder, or row action controls", async () => {
    renderPanel({ canEdit: false });

    expect(screen.queryByRole("button", { name: "افزودن گروه" })).toBeNull();
    expect(screen.queryByRole("button", { name: "مرتب‌سازی" })).toBeNull();
    expect(screen.queryByRole("button", { name: "عملیات افزودنی‌های قهوه" })).toBeNull();
    // The counts are still readable — read-only is not blind.
    expect(screen.getByRole("row", { name: "جزئیات افزودنی‌های قهوه" })).toBeTruthy();
  });

  it("gets a read-only group sheet: bounds as text, no option controls", async () => {
    const user = userEvent.setup();
    renderPanel({ canEdit: false });

    const sheet = await openGroupSheet(user, "افزودنی‌های قهوه");

    expect(within(sheet).queryByRole("button", { name: "ذخیرهٔ تنظیمات گروه" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "حذف شات اضافه" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "ویرایش شات اضافه" })).toBeNull();
    expect(within(sheet).queryByRole("switch", { name: "فعال بودن شات اضافه" })).toBeNull();
    // ۰ از ۳ — the rule itself is still shown.
    expect(within(sheet).getByText(/۰ از ۳/)).toBeTruthy();
  });
});
