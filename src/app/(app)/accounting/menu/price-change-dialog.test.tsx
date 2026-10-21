// @vitest-environment jsdom

/**
 * Issue #911 — the reported crash, driven through the real dialog.
 *
 * «تغییر قیمت» used to call `money.parse(priceInput)` *while rendering*, and
 * `parse` throws for every intermediate state of a field somebody is typing
 * into: «» after a backspace, «-», «.». Deleting the old number before typing
 * the new one — the ordinary way to change a price, and unavoidable when the
 * stored price is ۰ — therefore took the whole screen down with an
 * application-error overlay instead of letting the person finish typing.
 *
 * These tests type into the real field: clear it, retype it, and check that
 * the dialog is still there, says what is wrong in Persian, keeps «ثبت تغییر
 * قیمت» disabled until the amount is valid, and posts exactly one request
 * with the amount the operator typed.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import type { RestaurantMenuItem } from "@/lib/restaurant-menu";
import type { Runner } from "./menu-workspace";
import { PriceChangeDialog } from "./price-change-dialog";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

function itemWith(price: number): RestaurantMenuItem {
  return {
    id: ITEM_ID,
    categoryId: "22222222-2222-4222-8222-222222222222",
    name: "لاته",
    description: null,
    sku: null,
    price,
    imageUrl: null,
    imageMediaId: null,
    isActive: true,
    sortOrder: 0,
    targetMarginPercent: null,
  };
}

/** The workspace's runner, standing in for its state: no reload, no busy flag. */
const run: Runner = async (fn) => {
  const result = await fn();
  if (result.ok) return { ok: true as const, data: result.data };
  const error =
    typeof (result.data as { error?: unknown }).error === "string"
      ? String((result.data as { error?: unknown }).error)
      : "خطا";
  return { ok: false as const, error, data: result.data };
};

type SentRequest = { url: string; method: string; body: unknown };
let sent: SentRequest[] = [];

/** `api()` only reads `ok`, `status` and `json()`. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        sent.push({ url, method: "POST", body: JSON.parse(String(init.body)) });
        return jsonResponse(200, { ok: true, changed: true });
      }
      // The cost-plus breakdown: absent, so the suggestion section stays out
      // of the way of the price field these tests are about.
      return jsonResponse(200, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDialog(price: number, unit: "toman" | "rial" = "toman") {
  const onNotice = vi.fn();
  const onClose = vi.fn();
  render(
    <MoneyProvider unit={unit}>
      <PriceChangeDialog
        item={itemWith(price)}
        busy={false}
        run={run}
        onClose={onClose}
        onNotice={onNotice}
      />
    </MoneyProvider>,
  );
  return { onNotice, onClose };
}

const priceField = () => screen.getByLabelText(/قیمت جدید/) as HTMLInputElement;
const submitButton = () =>
  screen.getByRole("button", { name: "ثبت تغییر قیمت" }) as HTMLButtonElement;

describe("PriceChangeDialog — clearing and retyping the price", () => {
  it("survives clearing the price and posts the amount typed afterwards", async () => {
    const user = userEvent.setup();
    const { onNotice, onClose } = renderDialog(120_000); // ۱۲٬۰۰۰ تومان
    await screen.findByRole("dialog");

    const field = priceField();
    expect(field.value).toBe("۱۲٬۰۰۰");

    // The exact user story: delete the previous number, then type a new one.
    await user.clear(field);
    expect(field.value).toBe("");
    // Still rendered — this is the crash. Empty is a state, not an error.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect(sent).toHaveLength(0);

    await user.type(field, "15000");
    expect(submitButton().disabled).toBe(false);

    await user.click(submitButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe(`/api/menu/items/${ITEM_ID}/price-change`);
    expect(sent[0].body).toEqual({ price: 150_000 }); // تومان ۱۵٬۰۰۰ → ۱۵۰٬۰۰۰ ریال
    expect(onNotice).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("moves an item priced ۰ to a real price — the reported case", async () => {
    const user = userEvent.setup();
    renderDialog(0);
    await screen.findByRole("dialog");

    const field = priceField();
    expect(field.value).toBe("۰");

    await user.clear(field);
    await user.type(field, "25000");
    await user.click(submitButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ price: 250_000 });
  });

  it("treats ۰ → ۰ as no change and never posts it", async () => {
    const user = userEvent.setup();
    renderDialog(0);
    await screen.findByRole("dialog");

    const field = priceField();
    await user.clear(field);
    await user.type(field, "0");

    // Same price: nothing to record, so there is nothing to submit.
    expect(submitButton().disabled).toBe(true);
    expect(sent).toHaveLength(0);
    expect(screen.getByText("بدون تغییر")).toBeTruthy();
  });

  it("accepts a positive → ۰ change", async () => {
    const user = userEvent.setup();
    renderDialog(120_000);
    await screen.findByRole("dialog");

    const field = priceField();
    await user.clear(field);
    await user.type(field, "0");
    await user.click(submitButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ price: 0 });
  });

  it("explains a half-typed or invalid amount in Persian, inline", async () => {
    const user = userEvent.setup();
    renderDialog(120_000);
    await screen.findByRole("dialog");

    const field = priceField();
    await user.clear(field);
    await user.type(field, "-");
    expect(submitButton().disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("عدد را کامل کنید");

    // The «-» stays in the box (the field preserves what was typed so the
    // message can explain it), so recovery is: delete it and type the amount.
    await user.clear(field);
    await user.type(field, "30000");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton().disabled).toBe(false);

    // Letters are filtered out by the field itself, so what is left is an
    // empty box: nothing is nagged at while the operator is mid-edit, the CTA
    // simply stays disabled and an attempt to submit reports it once.
    await user.clear(field);
    await user.type(field, "abc");
    expect(field.value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("never posts while the amount is incomplete or unsafe", async () => {
    const user = userEvent.setup();
    renderDialog(120_000);
    await screen.findByRole("dialog");

    const field = priceField();
    await user.clear(field);
    await user.type(field, "99999999999999999999");
    expect(screen.getByRole("alert").textContent).toContain("مبلغ بسیار بزرگ است");
    expect(submitButton().disabled).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("converts a Rial business's entry exactly", async () => {
    const user = userEvent.setup();
    renderDialog(1_250_000, "rial"); // ۱٬۲۵۰٬۰۰۰ ریال
    await screen.findByRole("dialog");

    const field = priceField();
    expect(field.value).toBe("۱٬۲۵۰٬۰۰۰");
    await user.clear(field);
    await user.type(field, "2000000");
    await user.click(submitButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ price: 2_000_000 }); // no ×10 in a Rial business
  });

  it("posts a reason only when one was typed", async () => {
    const user = userEvent.setup();
    renderDialog(120_000);
    await screen.findByRole("dialog");

    await user.clear(priceField());
    await user.type(priceField(), "40000");
    await user.type(screen.getByLabelText(/دلیل تغییر/), "گران شدن شیر");
    await user.click(submitButton());

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body).toEqual({ price: 400_000, reason: "گران شدن شیر" });
  });
});
