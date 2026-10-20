// @vitest-environment jsdom

/**
 * Issue #911 — the item Sheet's two behaviours the audit found.
 *
 * 1. Create mode parsed the initial price with the *throwing* parse before
 *    checking whether anything had been typed, so a blank or half-typed price
 *    raised out of `save()` instead of being reported — and a ۰ price (a
 *    perfectly ordinary «price it later») went down the same path.
 * 2. `MenuWorkspace` knows `canEdit` but never passed it in, so a
 *    `menu.view`-only member got a fully editable form whose writes the API
 *    refuses: the screen promised an edit that could never happen.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestaurantMenuData, RestaurantMenuItem } from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";
import { ItemSheet } from "./item-sheet";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const DATA: RestaurantMenuData = {
  categories: [{ id: CATEGORY_ID, name: "نوشیدنی", taxRate: 0, isActive: true, sortOrder: 0 }],
  items: [],
  modifierGroups: [],
  modifiers: [],
  itemModifierGroups: [],
};

const ITEM: RestaurantMenuItem = {
  id: "11111111-1111-4111-8111-111111111111",
  categoryId: CATEGORY_ID,
  name: "لاته",
  description: null,
  sku: null,
  price: 120_000,
  imageUrl: null,
  imageMediaId: null,
  isActive: true,
  sortOrder: 0,
  targetMarginPercent: null,
};

type SentRequest = { url: string; method: string; body: unknown };
let sent: SentRequest[] = [];
/** How many requests *started* — a gated one is counted before it resolves. */
let started = 0;
/** Holds a request open, so a second click lands while the first is in flight. */
let gate: Promise<void> | null = null;
let respondWith: { status: number; body: unknown } = { status: 200, body: { ok: true, id: "new-id" } };

/** `api()` only reads `ok`, `status` and `json()`. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The workspace's runner: no reload, no busy flag. */
const run: Runner = async (fn) => {
  const result = await fn();
  if (result.ok) return { ok: true as const, data: result.data };
  const error =
    typeof (result.data as { error?: unknown }).error === "string"
      ? String((result.data as { error?: unknown }).error)
      : "خطا";
  return { ok: false as const, error, data: result.data };
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  sent = [];
  started = 0;
  gate = null;
  respondWith = { status: 200, body: { ok: true, id: "new-id" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" || init?.method === "PATCH") {
        started += 1;
        sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
        if (gate) await gate;
        return jsonResponse(respondWith.status, respondWith.body);
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

function renderSheet(overrides: Partial<Parameters<typeof ItemSheet>[0]> = {}) {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const onChangePrice = vi.fn();
  render(
    <ItemSheet
      mode="create"
      item={null}
      initialFocusAddons={false}
      data={DATA}
      canEdit
      busy={false}
      run={run}
      onClose={onClose}
      onCreated={onCreated}
      onChangePrice={onChangePrice}
      {...overrides}
    />,
  );
  return { onClose, onCreated, onChangePrice };
}

/**
 * The Sheet as `MenuWorkspace` mounts it: the workspace owns `busy` and flips
 * it for the duration of a mutation, which is what disables the CTA between
 * the first press and the reload.
 */
function renderHarness() {
  function Harness() {
    const [busy, setBusy] = useState(false);
    const workspaceRun: Runner = async (fn) => {
      setBusy(true);
      try {
        const result = await fn();
        if (result.ok) return { ok: true as const, data: result.data };
        const error =
          typeof (result.data as { error?: unknown }).error === "string"
            ? String((result.data as { error?: unknown }).error)
            : "خطا";
        return { ok: false as const, error, data: result.data };
      } finally {
        setBusy(false);
      }
    };
    return (
      <ItemSheet
        mode="create"
        item={null}
        initialFocusAddons={false}
        data={DATA}
        canEdit
        busy={busy}
        run={workspaceRun}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onChangePrice={vi.fn()}
      />
    );
  }
  return render(<Harness />);
}

const priceField = () => screen.getByLabelText(/قیمت \(تومان\)/) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "افزودن آیتم" }) as HTMLButtonElement;

async function fillNameAndCategory(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("نام آیتم"), "لاتهٔ کارامل");
  // The category picker: open it and choose the one option.
  await user.click(screen.getByRole("button", { name: "دستهٔ آیتم" }));
  await user.click(await screen.findByRole("option", { name: "نوشیدنی" }));
}

describe("ItemSheet — creating an item with a price", () => {
  it("creates an item priced ۰ — a real price, not a missing one", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    await user.type(priceField(), "0");
    await user.click(saveButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe("/api/menu/items");
    expect(sent[0].body).toMatchObject({ price: 0, categoryId: CATEGORY_ID });
  });

  it("refuses a blank price inline and posts nothing", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    // The price is left exactly as the form opened it: empty.
    expect(priceField().value).toBe("");
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByText("قیمت فروش را درست وارد کنید.")).toBeTruthy());
    expect(sent).toHaveLength(0);

    // Typing a real amount recovers without reopening anything.
    await user.type(priceField(), "45000");
    await user.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toMatchObject({ price: 450_000 });
  });

  it("explains a half-typed or negative price instead of throwing out of save()", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    await user.type(priceField(), "-");
    await user.click(saveButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("عدد را کامل کنید");
    expect(sent).toHaveLength(0);

    // Completing it into a negative amount is a different, named problem.
    await user.type(priceField(), "500");
    expect(screen.getByRole("alert").textContent).toContain("مبلغ نمی‌تواند منفی باشد");
    await user.click(saveButton());
    expect(sent).toHaveLength(0);
    // The dialog survived: this is the crash.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("creates exactly one item when the CTA is pressed twice", async () => {
    const user = userEvent.setup();
    renderHarness();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    await user.type(priceField(), "30000");

    // Hold the first request open, the way a slow network would: the second
    // press lands while the first is still in flight.
    let release = () => {};
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cta = saveButton();
    await user.click(cta);
    await user.click(cta);
    release();
    gate = null;

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(started).toBe(1);
    expect(sent[0].body).toMatchObject({ price: 300_000 });
  });
});

describe("ItemSheet — without menu.edit", () => {
  it("opens read-only: no save, no price action, disabled fields", async () => {
    renderSheet({ mode: "edit", item: ITEM, canEdit: false });
    await screen.findByRole("dialog");

    // Nothing to submit — the Sheet is a detail view that closes.
    expect(screen.queryByRole("button", { name: "ذخیرهٔ تغییرات" })).toBeNull();
    // The Sheet's own × is also «بستن»; what matters is that the footer's
    // close is there (and that no save button is).
    const closes = screen.getAllByRole("button", { name: "بستن" });
    expect(closes.some((button) => button.getAttribute("data-slot") !== "sheet-close")).toBe(true);
    // No «تغییر قیمت»: price is a write, and this member has no write.
    expect(screen.queryByRole("button", { name: "تغییر قیمت" })).toBeNull();

    expect((screen.getByLabelText("نام آیتم") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/کد کالا/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("توضیحات") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("still offers the price action to a member who may edit", async () => {
    const { onChangePrice } = renderSheet({ mode: "edit", item: ITEM, canEdit: true });
    await screen.findByRole("dialog");

    expect(screen.getByRole("button", { name: "ذخیرهٔ تغییرات" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "تغییر قیمت" }));
    expect(onChangePrice).toHaveBeenCalledWith(ITEM);
  });
});

describe("ItemSheet — a save sent twice creates the item once", () => {
  it("retries a save whose answer never arrived with the same create key", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    await user.type(priceField(), "45000");

    // The first attempt fails — a timeout, a dropped connection, a reload
    // mid-flight: anything the operator never saw the answer to, and so is
    // entitled to press «افزودن آیتم» again.
    respondWith = { status: 500, body: { error: "server_error" } };
    await user.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(1));

    respondWith = { status: 200, body: { ok: true, id: "new-id" } };
    await user.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(2));

    const keys = sent.map((request) => (request.body as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    // The same key both times: the server answers the retry with the item the
    // first attempt created instead of making a second one.
    expect(keys[1]).toBe(keys[0]);
  });

  it("starts a new key once the draft has been created", async () => {
    const user = userEvent.setup();
    renderSheet();
    await screen.findByRole("dialog");

    await fillNameAndCategory(user);
    await user.type(priceField(), "45000");

    await user.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(1));
    // A second save is a second item, not a replay of the first.
    await user.click(saveButton());
    await waitFor(() => expect(sent).toHaveLength(2));

    const keys = sent.map((request) => (request.body as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
