// @vitest-environment jsdom
//
// GH #1567 Phase 6D — the «کالای امانی» screens.
//   - the contract list shows status, consigned on-hand and the owner payable;
//   - a new contract sends exactly the per-variant terms entered (owner price
//     or commission % → basis points), refuses a variant the shop owns stock of,
//     and validates before calling the server;
//   - the detail receives / returns quantities with the contract's version and
//     a fresh idempotency key, settles with method and amount, and shows a
//     server refusal in Persian;
//   - an expired contract offers no receipt; a read-only member sees no
//     mutating controls; settlement needs its own permission.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsignmentManager, ContractDetail, ContractForm, parseWhole, percentToBp, type Contract } from "./consignment-manager";

const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

const CONTRACT: Contract = {
  id: "22222222-2222-4222-8222-222222222222", reference: "C-1401", consignorId: OWNER_ID, consignorName: "تولیدی نگار",
  startsOn: "2026-01-01", expiresOn: "2030-12-31", notes: null, status: "open", version: 3, settledRial: 0,
  outstandingRial: 1_800_000, onHand: 4,
  lines: [
    {
      id: "line-m", itemId: "m", name: "مانتو", sku: null, attributes: "مشکی / M", terms: "owner_price", ownerUnitPriceRial: 600_000,
      commissionBp: null, retailPriceRial: 1_000_000, received: 4, sold: 2, customerReturned: 0, voided: 0, returnedToOwner: 0, onHand: 2,
      shareSoldRial: 1_200_000, shareReturnedRial: 0, shareVoidedRial: 0, commissionRial: 800_000,
    },
    {
      id: "line-l", itemId: "l", name: "مانتو", sku: null, attributes: "مشکی / L", terms: "commission", ownerUnitPriceRial: null,
      commissionBp: 2_500, retailPriceRial: 800_000, received: 3, sold: 1, customerReturned: 0, voided: 0, returnedToOwner: 0, onHand: 2,
      shareSoldRial: 600_000, shareReturnedRial: 0, shareVoidedRial: 0, commissionRial: 200_000,
    },
  ],
};

const CELLS = ["S", "M", "L"].map((size, i) => ({
  itemId: size.toLowerCase(), name: "مانتو", sku: null, attributes: { رنگ: "مشکی", سایز: size },
  onHand: ["5", "0", "0"][i], unitPriceRial: null,
}));

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let actionResponse: { status: number; body: unknown } | null = null;
let detail: Contract = CONTRACT;

beforeEach(() => {
  calls.length = 0;
  actionResponse = null;
  detail = CONTRACT;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/consignment-contracts" && method === "POST") return new Response(JSON.stringify({ contract: CONTRACT }), { status: 201 });
    if (url === "/api/consignment-contracts") return new Response(JSON.stringify({ contracts: [CONTRACT, { ...CONTRACT, id: "x", reference: "C-1300", status: "closed", onHand: 0, outstandingRial: 0 }] }));
    if (url === "/api/consignment-contracts/consignors") return new Response(JSON.stringify({ consignors: [{ id: OWNER_ID, name: "تولیدی نگار", phone: null }] }));
    if (url === `/api/consignment-contracts/${CONTRACT.id}` && method === "POST") {
      if (actionResponse) return new Response(JSON.stringify(actionResponse.body), { status: actionResponse.status });
      return new Response(JSON.stringify({ contract: detail }));
    }
    if (url === `/api/consignment-contracts/${CONTRACT.id}`) {
      return new Response(JSON.stringify({ contract: detail, movements: [{ id: "mv", kind: "receive", itemName: "مانتو (مشکی / M)", quantity: 4, ownerShareRial: null, commissionRial: null, amountRial: null, note: null, actorName: "مالک", at: "2026-11-20T08:00:00Z" }] }));
    }
    if (url === "/api/size-packs/matrix") return new Response(JSON.stringify({ styles: [{ id: STYLE_ID, name: "مانتو", sku: "MT", variants: 3 }] }));
    if (url === `/api/size-packs/matrix?styleId=${STYLE_ID}`) return new Response(JSON.stringify({ axes: ["رنگ", "سایز"], cells: CELLS }));
    return new Response(JSON.stringify({}), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function choose(name: string, option: string) {
  await waitFor(() => expect(screen.getByRole("button", { name }).getAttribute("aria-busy")).not.toBe("true"));
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("consignment helpers", () => {
  it("parses whole quantities and commission percentages, Persian digits included", () => {
    expect(parseWhole("۴")).toBe(4);
    expect(parseWhole("1.5")).toBeNull();
    expect(parseWhole("-1")).toBeNull();
    expect(percentToBp("۲۵")).toBe(2_500);
    expect(percentToBp("12.5")).toBe(1_250);
    expect(percentToBp("101")).toBeNull();
    expect(percentToBp("abc")).toBeNull();
  });
});

describe("ConsignmentManager", () => {
  it("lists contracts with status, consigned on-hand and the owner payable", async () => {
    render(<ConsignmentManager canEdit canSettle />);
    const table = await screen.findByRole("table", { name: "قراردادهای امانی" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("تولیدی نگار")).toBeTruthy();
    expect(within(rows[1]).getByText("باز")).toBeTruthy();
    expect(within(rows[1]).getByText("۴")).toBeTruthy();
    expect(within(rows[2]).getByText("بسته")).toBeTruthy();
    expect(screen.getByRole("button", { name: /قرارداد تازه/ })).toBeTruthy();
  });

  it("a read-only member sees no mutating controls", async () => {
    render(<ConsignmentManager canEdit={false} canSettle={false} />);
    await screen.findByRole("table", { name: "قراردادهای امانی" });
    expect(screen.queryByRole("button", { name: /قرارداد تازه/ })).toBeNull();
  });
});

describe("ContractForm", () => {
  it("sends exactly the per-variant terms entered and refuses a variant the shop owns", async () => {
    const onSaved = vi.fn();
    render(<ContractForm onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("شمارهٔ قرارداد"), { target: { value: "C-1401" } });
    await choose("امانت‌گذار", "تولیدی نگار");
    await choose("مدل", "مانتو (MT)");
    // S has owned stock → cannot be consigned.
    expect((await screen.findByRole("button", { name: "مشکی / S" })).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "مشکی / M" }));
    fireEvent.click(screen.getByRole("button", { name: "مشکی / L" }));
    await choose("شرط مانتو (مشکی / M)", "قیمت توافقی امانت‌گذار");
    fireEvent.change(screen.getByLabelText("قیمت توافقی مانتو (مشکی / M)"), { target: { value: "600000" } });
    fireEvent.change(screen.getByLabelText("قیمت فروش مانتو (مشکی / M)"), { target: { value: "1000000" } });
    fireEvent.change(screen.getByLabelText("درصد کارمزد مانتو (مشکی / L)"), { target: { value: "۲۵" } });
    fireEvent.click(screen.getByRole("button", { name: "ثبت قرارداد" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST")!;
    const lines = post.body!.lines as { itemId: string; terms: string; ownerUnitPriceRial: number | null; commissionBp: number | null; retailPriceRial: number | null }[];
    expect(post.body).toMatchObject({ reference: "C-1401", consignorId: OWNER_ID, expiresOn: null, notes: null });
    expect(lines.map((l) => [l.itemId, l.terms, l.commissionBp, l.retailPriceRial === null])).toEqual([
      ["m", "owner_price", null, false],
      ["l", "commission", 2_500, true],
    ]);
    expect(lines[0].ownerUnitPriceRial).toBeGreaterThan(0);
    expect(lines[0].retailPriceRial! / lines[0].ownerUnitPriceRial!).toBeCloseTo(1_000_000 / 600_000);
  });

  it("validates before calling the server", async () => {
    render(<ContractForm onSaved={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "ثبت قرارداد" }));
    expect(await screen.findByText("شمارهٔ قرارداد، امانت‌گذار و دست‌کم یک تنوع لازم است.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("ContractDetail", () => {
  it("receives quantities with the contract version and a fresh idempotency key, and shows the history", async () => {
    const onChanged = vi.fn();
    render(<ContractDetail id={CONTRACT.id} canEdit canSettle onChanged={onChanged} />);
    await screen.findByRole("table", { name: "ردیف‌های قرارداد" });
    expect(within(screen.getByRole("table", { name: "گردش قرارداد امانی" })).getByText("دریافت از امانت‌گذار")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("تعداد مانتو (مشکی / M)"), { target: { value: "۲" } });
    fireEvent.click(screen.getByRole("button", { name: "دریافت از امانت‌گذار" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ action: "receive", expectedVersion: 3, lines: [{ lineId: "line-m", quantity: 2 }] });
    expect(String(post.body!.idempotencyKey).length).toBeGreaterThanOrEqual(8);
  });

  it("settles by method and shows a server refusal in Persian", async () => {
    actionResponse = { status: 409, body: { error: "settlement_exceeds_payable", message: "مبلغ تسویه از بدهی به امانت‌گذار بیشتر است." } };
    render(<ContractDetail id={CONTRACT.id} canEdit canSettle onChanged={() => undefined} />);
    await screen.findByRole("table", { name: "ردیف‌های قرارداد" });
    fireEvent.change(screen.getByLabelText(/^مبلغ/), { target: { value: "500000" } });
    await choose("روش پرداخت", "بانک");
    fireEvent.click(screen.getByRole("button", { name: "ثبت پرداخت" }));
    expect(await screen.findByText("مبلغ تسویه از بدهی به امانت‌گذار بیشتر است.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ action: "settle", method: "bank" });
    expect(post.body!.amountRial).toBeGreaterThan(0);
  });

  it("an expired contract offers no receipt but still lets goods go back; close waits for zero on hand", async () => {
    detail = { ...CONTRACT, status: "expired" };
    render(<ContractDetail id={CONTRACT.id} canEdit canSettle onChanged={() => undefined} />);
    await screen.findByRole("table", { name: "ردیف‌های قرارداد" });
    expect(screen.queryByRole("button", { name: "دریافت از امانت‌گذار" })).toBeNull();
    expect(screen.getByRole("button", { name: "برگشت به امانت‌گذار" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "بستن قرارداد" }).hasAttribute("disabled")).toBe(true);
  });

  it("without the settlement permission there is no payment form; read-only has no quantity inputs", async () => {
    render(<ContractDetail id={CONTRACT.id} canEdit={false} canSettle={false} onChanged={() => undefined} />);
    await screen.findByRole("table", { name: "ردیف‌های قرارداد" });
    expect(screen.queryByRole("button", { name: "ثبت پرداخت" })).toBeNull();
    expect(screen.queryByLabelText("تعداد مانتو (مشکی / M)")).toBeNull();
    expect(screen.queryByRole("button", { name: "برگشت به امانت‌گذار" })).toBeNull();
  });
});
