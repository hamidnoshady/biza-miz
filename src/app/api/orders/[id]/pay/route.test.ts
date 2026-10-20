// @vitest-environment node
/**
 * Issue #913 item 5 — POST /api/orders/[id]/pay against a STALE split-tender
 * body. The screen re-resolves the split against the server total before it
 * charges (pos-screen.tsx), and the route is the backstop: a body that does
 * not structurally settle the bill is refused with payment_total_mismatch —
 * or, when the slices merely differ from the bill, with customer_required —
 * and never a silent absorb into an auto-opened last tender, and never a
 * payment row for a figure nobody reviewed.
 *
 * The transaction dies at validation, so the heavy posting machinery below
 * it is mocked at its seams — exactly what `validateTenders` short-circuits
 * before it would reach them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => unknown) => handler,
  };
});

vi.mock("@/lib/db", () => ({
  getPool: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/business-day-service", () => ({ getBusinessDayStatus: vi.fn() }));
vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));
vi.mock("@/lib/inventory-service", () => ({ deductForOrder: vi.fn(async () => ({ totalCost: "0" })) }));
vi.mock("@/lib/ledger-service", () => ({
  MissingLedgerAccountError: class extends Error {},
  postExactCogsEntry: vi.fn(async () => undefined),
  postExactOrderPaymentEntry: vi.fn(async () => undefined),
}));
vi.mock("@/lib/online-platforms-service", () => ({
  getOnlinePlatformsConfig: vi.fn(async () => ({ snappfood: null })),
}));
vi.mock("@/lib/order-lock", () => ({ lockOpenOrder: vi.fn() }));
vi.mock("@/lib/order-state-sync", () => ({ recordOrderState: vi.fn() }));
vi.mock("@/lib/order-payment-errors", () => ({ paymentFailureFor: vi.fn() }));
vi.mock("@/lib/payment-methods-service", () => ({ listPaymentMethods: vi.fn() }));
vi.mock("@/lib/integrations/holoo/outbox-producer", () => ({ enqueueHolooSaleForOrder: vi.fn() }));
vi.mock("@/lib/posting-engine", () => ({ emitDomainEvent: vi.fn() }));
vi.mock("@/lib/loyalty-service", () => ({ earnPoints: vi.fn() }));
vi.mock("@/lib/table-session-service", () => ({ releaseTableAfterOrderSettled: vi.fn() }));
vi.mock("@/lib/sync-outbox", () => ({ appendSyncOutboxEvent: vi.fn() }));
vi.mock("@/lib/crm-scoring-freshness", () => ({ markScoringDirtyIn: vi.fn() }));

import * as setupState from "@/lib/setup-state";
import * as orderLock from "@/lib/order-lock";
import * as paymentMethodsService from "@/lib/payment-methods-service";
import * as db from "@/lib/db";
import { rialText } from "@/lib/inventory-exact";

const CASH_WAY = {
  id: "pm-cash",
  code: "cash",
  name: "نقدی",
  settlement: "cash",
  sortOrder: 0,
  isActive: true,
  isBuiltin: true,
  opensDrawer: true,
  requiresReference: false,
};
const CARD_WAY = {
  id: "pm-card",
  code: "card",
  name: "کارت‌خوان",
  settlement: "card",
  sortOrder: 1,
  isActive: true,
  isBuiltin: true,
  opensDrawer: false,
  requiresReference: false,
};

/** A txn client whose only real jobs here are surviving BEGIN/ROLLBACK and the rows the route keys decisions off. */
function fakeClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO inventory_events")) return { rows: [{ id: "evt-1" }] };
      if (sql.includes("UPDATE orders SET status = 'completed'")) {
        return { rows: [{ id: "order-1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}
let client: ReturnType<typeof fakeClient>;

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function payContext() {
  return { params: Promise.resolve({ id: "order-1" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  client = fakeClient();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: { businessId: "biz-1", sub: "user-1", role: "cashier" },
    error: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: async () => client } as never);
  vi.mocked(orderLock.lockOpenOrder).mockResolvedValue({
    ok: true,
    order: {
      total: rialText("300000"),
      tax: rialText("0"),
      type: "takeaway",
      customer_id: null,
    },
  } as never);
  vi.mocked(paymentMethodsService.listPaymentMethods).mockResolvedValue([
    CASH_WAY,
    CARD_WAY,
  ] as never);
});

describe("POST /api/orders/[id]/pay — stale split bodies (issue #913 item 5)", () => {
  it("refuses a split whose slices both defer to the open remainder with payment_total_mismatch", async () => {
    const { POST } = await import("./route");
    // The stale shape: two slices with no amount, each expecting "the rest".
    // The bill is 300000 Rial; nothing here settles it exactly.
    const res = await POST(
      request({ payments: [{ methodId: "pm-cash" }, { methodId: "pm-card" }] }),
      payContext(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payment_total_mismatch" });
    // The transaction rolled back before a single money row.
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO payments")),
    ).toBe(false);
  });

  it("refuses priced slices that miss the bill without a customer rather than charging the difference", async () => {
    const { POST } = await import("./route");
    // Slices priced 100000 + 100000 against a 300000 bill: with allowDifference
    // the mismatch may only settle onto a person's account — a walk-in gets a
    // refusal, not an absorbed 100000.
    const res = await POST(
      request({
        payments: [
          { methodId: "pm-cash", amount: 100000 },
          { methodId: "pm-card", amount: 100000 },
        ],
      }),
      payContext(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "customer_required" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("passes a split that settles the bill exactly (the contract the rebuild guarantees)", async () => {
    const { POST } = await import("./route");
    // lockOpenOrder hands the server's own total to validateTenders: the
    // slices must match THAT, which is what makes the rebuild-before-charge
    // in the screen observable here.
    vi.mocked(orderLock.lockOpenOrder).mockResolvedValue({
      ok: true,
      order: {
        total: rialText("200000"),
        tax: rialText("0"),
        type: "takeaway",
        customer_id: null,
      },
    } as never);
    const res = await POST(
      request({
        payments: [
          { methodId: "pm-cash", amount: 100000 },
          { methodId: "pm-card", amount: 100000 },
        ],
      }),
      payContext(),
    );
    // Reaches the success path (200/redirect-free JSON) rather than a 400 —
    // proving the refusal tests above key off the amounts, not the harness.
    expect(res.status).toBeLessThan(400);
  });
});
