import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/mapping-service", () => ({ localIdForRemote: vi.fn() }));
// Keep the pure validator real — the route's contract IS its strictness —
// and stub only the DB-touching enqueue.
vi.mock("@/lib/integrations/woo-ops-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/woo-ops-service")>();
  return { ...actual, enqueueOperation: vi.fn() };
});

import * as connectionAccess from "@/lib/integrations/connection-access";
import * as mappingService from "@/lib/integrations/mapping-service";
import * as opsService from "@/lib/integrations/woo-ops-service";
import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";

function wooConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    business_id: SESSION.businessId,
    provider: "woocommerce",
    status: "active",
    link_mode: "rest_api",
    currency_unit: "toman",
    push_stock: true,
    push_prices: true,
    ...overrides,
  };
}

function post(body: unknown, rawBody?: string) {
  return POST(
    new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/store/products`, {
      method: "POST",
      body: rawBody ?? JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: CONNECTION_ID }) } as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);
  vi.mocked(mappingService.localIdForRemote).mockResolvedValue("local-uuid");
  vi.mocked(opsService.enqueueOperation).mockResolvedValue(undefined);
});

describe("POST store/products — authorization", () => {
  it("gates on woocommerce.manage, not integrations.manage", async () => {
    await post({ remoteId: "55", fields: { name: "x" } });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceManage);
    // #1037: the connection is fetched through the live-branch-scoped
    // accessor, session in hand — not by business id alone.
    expect(connectionAccess.getAccessibleConnection).toHaveBeenCalledWith(SESSION, CONNECTION_ID);
  });

  it("passes a denial straight through and queues nothing", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await post({ remoteId: "55", fields: { name: "x" } });
    expect(res.status).toBe(403);
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });
});

describe("POST store/products — provider and connection guards", () => {
  it("rejects a Holoo connection id — an invalid integration must never enter Woo outbox work", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ provider: "holoo" }) as never);
    const res = await post({ remoteId: "55", fields: { name: "x" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });

  it("rejects an unknown connection id with 404", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(null);
    expect((await post({ remoteId: "55", fields: { name: "x" } })).status).toBe(404);
  });

  it("refuses to queue while the connection is paused", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ status: "paused" }) as never);
    const res = await post({ remoteId: "55", fields: { name: "x" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "connection_paused" });
  });
});

describe("POST store/products — request validation", () => {
  it("refuses malformed bodies with stable codes", async () => {
    expect((await post(null, "not json")).status).toBe(400);
    const badJson = await post(null, "not json");
    expect(await badJson.json()).toEqual({ error: "invalid_json" });
    const arr = await post([1, 2]);
    expect(await arr.json()).toEqual({ error: "invalid_body" });
    const badFields = await post({ remoteId: "55", fields: "regular_price=1" });
    expect(await badFields.json()).toEqual({ error: "invalid_fields" });
  });

  it("refuses a non-numeric or empty remote id before queueing", async () => {
    for (const remoteId of ["", "abc", "55; DROP", "11111111-1111-1111-1111-111111111111", "۵۵"]) {
      const res = await post({ remoteId, fields: { name: "x" } });
      expect(res.status, String(remoteId)).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_remote_id" });
    }
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });

  it("refuses a product this connection has never mapped", async () => {
    vi.mocked(mappingService.localIdForRemote).mockResolvedValue(null);
    const res = await post({ remoteId: "55", fields: { name: "x" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "product_not_mapped" });
    expect(mappingService.localIdForRemote).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "product", "55");
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });

  it("enforces the store's push switches instead of silently overriding them", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ push_prices: false }) as never);
    const priceRes = await post({ remoteId: "55", fields: { priceRial: "150000" } });
    expect(priceRes.status).toBe(409);
    expect(await priceRes.json()).toEqual({ error: "push_prices_disabled" });

    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ push_stock: false }) as never);
    const stockRes = await post({ remoteId: "55", fields: { stock_quantity: 4 } });
    expect(stockRes.status).toBe(409);
    expect(await stockRes.json()).toEqual({ error: "push_stock_disabled" });
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });

  it("surfaces the strict validator: an ambiguous manage_stock and a fractional stock are refused, not guessed", async () => {
    // Boolean("yes") would have been `true` — the guess the old coercion made.
    const manage = await post({ remoteId: "55", fields: { manage_stock: "yes" } });
    expect(manage.status).toBe(400);
    expect(await manage.json()).toEqual({ error: "invalid_manage_stock" });

    const stock = await post({ remoteId: "55", fields: { stock_quantity: 3.7 } });
    expect(stock.status).toBe(400);
    expect(await stock.json()).toEqual({ error: "invalid_stock_quantity" });
    expect(opsService.enqueueOperation).not.toHaveBeenCalled();
  });

  it("reads the string 'false' manage_stock as false — the opt-out a Boolean() coercion inverted", async () => {
    const res = await post({ remoteId: "55", fields: { manage_stock: "false" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toEqual({ manage_stock: false });
  });
});

describe("POST store/products — money and queueing", () => {
  it("converts a Rial price into the store's unit — Toman store", async () => {
    const res = await post({ remoteId: "55", fields: { priceRial: "1500000" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, queued: true, patch: { regular_price: "150000" } });
    expect(opsService.enqueueOperation).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "product_update", "55", {
      regular_price: "150000",
    });
  });

  it("converts a Rial price into the store's unit — Rial store passes the amount through", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ currency_unit: "rial" }) as never);
    const res = await post({ remoteId: "55", fields: { salePriceRial: "150000" } });
    const body = await res.json();
    expect(body.patch).toEqual({ sale_price: "150000" });
  });

  it("refuses a malformed Rial price", async () => {
    const res = await post({ remoteId: "55", fields: { priceRial: "-100" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_price" });
  });

  it("keeps a manage_stock=false opt-out an opt-out and queues it as false", async () => {
    const res = await post({ remoteId: "55", fields: { manage_stock: false, stock_quantity: 0 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.patch).toEqual({ manage_stock: false, stock_quantity: 0 });
  });

  it("answers an unexpected failure with a stable code and never the raw message", async () => {
    vi.mocked(opsService.enqueueOperation).mockRejectedValue(new Error("ECONNREFUSED secret-host:5432"));
    const res = await post({ remoteId: "55", fields: { name: "x" } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });
});
