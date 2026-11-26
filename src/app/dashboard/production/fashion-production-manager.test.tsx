// @vitest-environment jsdom
//
// GH #1567 Phase 6B — the fashion production screen.
//   - the board lists the branch's orders with status and progress;
//   - a stage report sends one progress action with the order's version and a
//     fresh idempotency key (optimistic lock + retry safety);
//   - a material shortage is shown per material, not as a bare error;
//   - a read-only member (no inventory.adjust) sees no mutating controls;
//   - the WIP report says whether the subledger ties to GL 1310.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FashionProductionManager, parseQuantity, progressText, type OrderDetail, type OrderSummary } from "./fashion-production-manager";

const ORDER_ID = "33333333-3333-4333-8333-333333333333";

function summary(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: ORDER_ID, reference: "PRD-1", status: "in_progress", outputItemId: "dress", outputName: "پیراهن مجلسی M",
    plannedQuantity: "10", receivedQuantity: "0", scrappedQuantity: "0", dueDate: null, version: 7,
    receivableQuantity: "0", outstandingQuantity: "10",
    costs: { materialRial: 1_100_000, conversionRial: 0, receivedRial: 0, returnedRial: 0, writtenOffRial: 0, wipRial: 1_100_000, unitCostRial: null },
    stages: [
      { seq: 1, code: "cut", label: "برش", completed: "10", scrapped: "0" },
      { seq: 2, code: "sew", label: "دوخت", completed: "4", scrapped: "0" },
    ],
    ...overrides,
  };
}

function detail(order: OrderSummary = summary()): OrderDetail {
  return {
    order: { ...order, outputUnit: "عدد" },
    stages: [
      { seq: 1, code: "cut", label: "برش", assigneeName: null, completedQuantity: "10", scrappedQuantity: "0", reworkQuantity: "0" },
      { seq: 2, code: "sew", label: "دوخت", assigneeName: "مریم", completedQuantity: "4", scrappedQuantity: "0", reworkQuantity: "0" },
    ],
    materials: [{ materialItemId: "fabric", name: "پارچه کرپ", unit: "متر", quantityPerUnit: "2", requiredQuantity: "20",
      issuedQuantity: "20", issuedValueRial: 1_000_000, returnedQuantity: "0", onHand: "80" }],
    actions: [{ id: "a1", action: "create", actorName: "مدیر", amountRial: null, at: "2026-11-26T10:00:00Z", detail: {} }],
  };
}

const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let postResponse: { status: number; body: unknown } | null = null;
let current: OrderSummary = summary();

beforeEach(() => {
  calls.length = 0;
  postResponse = null;
  current = summary();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === `/api/production-orders/${ORDER_ID}` && method === "POST") {
      if (postResponse) return new Response(JSON.stringify(postResponse.body), { status: postResponse.status });
      return new Response(JSON.stringify(detail({ ...current, version: current.version + 1 })));
    }
    if (url === `/api/production-orders/${ORDER_ID}`) return new Response(JSON.stringify(detail(current)));
    if (url === "/api/production-orders/report") {
      return new Response(JSON.stringify({ report: {
        openOrders: 1, completedOrders: 2, cancelledOrders: 0, plannedQuantity: "30", receivedQuantity: "18", scrappedQuantity: "2",
        scrapRate: "0.1", receivedValueRial: 3_100_000, averageUnitCostRial: "172222.22", materialCostRial: 3_000_000,
        conversionCostRial: 900_000, wipRial: 800_000, reconciliation: { subledgerWipRial: 800_000, glWipRial: 800_000, reconciled: true },
      } }));
    }
    if (url.startsWith("/api/production-orders")) return new Response(JSON.stringify({ orders: [current] }));
    return new Response(JSON.stringify({ error: "not_mocked" }), { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("fashion production screen (GH #1567 6B)", () => {
  it("records a stage report with the order's version and an idempotency key", async () => {
    render(<FashionProductionManager permissions={{ canAdjust: true, canWriteOff: false }} />);
    fireEvent.click(await screen.findByRole("button", { name: "PRD-1" }));
    const sew = await screen.findByRole("textbox", { name: "تعداد انجام‌شده در دوخت" });
    fireEvent.change(sew, { target: { value: "۳" } });
    const row = sew.closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "ثبت" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ action: "progress", stage: "sew", completed: "3", scrapped: null, expectedVersion: 7 });
    expect(String(post.body?.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    // Without ledger approval the cancel note says so.
    expect(screen.getByText(/به دسترسی «تأیید سند حسابداری» نیاز دارد/u)).toBeTruthy();
  });

  it("shows a release shortage per material", async () => {
    current = summary({ status: "draft", version: 1 });
    postResponse = { status: 409, body: { error: "material_shortage", detail: { shortages: [
      { materialItemId: "fabric", name: "پارچه کرپ", need: "120", available: "100", missing: "20" },
    ] } } };
    render(<FashionProductionManager permissions={{ canAdjust: true, canWriteOff: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "PRD-1" }));
    fireEvent.click(await screen.findByRole("button", { name: "رزرو مواد و آزادسازی سفارش" }));
    const list = await screen.findByRole("list", { name: "کمبود مواد" });
    expect(within(list).getByText(/پارچه کرپ: نیاز ۱۲۰، آزاد ۱۰۰، کمبود ۲۰/u)).toBeTruthy();
    expect(screen.getByText("موجودی آزاد مواد کافی نیست.")).toBeTruthy();
  });

  it("a read-only member sees the order but no mutating controls", async () => {
    render(<FashionProductionManager permissions={{ canAdjust: false, canWriteOff: false }} />);
    expect(screen.queryByRole("button", { name: /سفارش تولید تازه/u })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "PRD-1" }));
    await screen.findByText("پارچه کرپ");
    expect(screen.queryByRole("textbox", { name: "تعداد انجام‌شده در دوخت" })).toBeNull();
    expect(screen.queryByRole("button", { name: "لغو سفارش" })).toBeNull();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("the report states that WIP ties to the ledger", async () => {
    render(<FashionProductionManager permissions={{ canAdjust: true, canWriteOff: true }} />);
    fireEvent.click(await screen.findByRole("tab", { name: "گزارش و تطبیق" }));
    expect(await screen.findByText(/تطبیق است/u)).toBeTruthy();
  });

  it("parses Persian quantities and summarises progress", () => {
    expect(parseQuantity("۲٫۵")).toBe("2.5");
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("abc")).toBeNull();
    expect(progressText(summary())).toBe("۴ از ۱۰");
  });
});
