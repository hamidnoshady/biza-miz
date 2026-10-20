import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #911 — the price-change endpoint's untrusted-input surface.
 *
 * The handler used to cast the parsed JSON to an object and read `raw.price`
 * straight off it. `JSON.parse` is happy to answer `null`, `[]` or `7`, and
 * `as { price?: unknown }` is a compile-time assertion that survives into
 * runtime as a property read on `null` — a 500 where a 400 belongs. The path
 * id had the same problem one layer down: it reached a uuid column without
 * ever being checked for uuid shape.
 *
 * These are the shapes a browser, a scripted integration or a stale client
 * can actually send. Each one is answered with a structured 400/404 and the
 * canonical service is never called.
 */
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as priceService from "@/lib/menu-price-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  };
});

vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/menu-price-service", () => ({ changeMenuItemPrice: vi.fn() }));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const ITEM_ID = "11111111-1111-4111-8111-111111111111";

function request(body: unknown, raw?: string) {
  return new NextRequest(`http://localhost/api/menu/items/${ITEM_ID}/price-change`, {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const ctx = (id: string = ITEM_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  // Usage data only — the implementations below are (re)set every time.
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    error: null,
  } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ "?column?": 1 }] } as never);
  vi.mocked(priceService.changeMenuItemPrice).mockResolvedValue({
    ok: true,
    changed: true,
    oldPrice: 0,
    newPrice: 500_000,
  } as never);
});

describe("POST /api/menu/items/:id/price-change — request shape", () => {
  it("refuses a JSON body that is not an object", async () => {
    for (const body of [null, [], 7, "50000", true]) {
      vi.mocked(priceService.changeMenuItemPrice).mockClear();
      const response = await POST(request(body) as never, ctx() as never);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "bad_request" });
      expect(priceService.changeMenuItemPrice).not.toHaveBeenCalled();
    }
  });

  it("refuses malformed JSON", async () => {
    const response = await POST(request(null, "{not json") as never, ctx() as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request" });
  });

  it("refuses a missing or non-integer price", async () => {
    for (const body of [{}, { price: null }, { price: "50000" }, { price: -5 }, { price: 1.5 }]) {
      vi.mocked(priceService.changeMenuItemPrice).mockClear();
      const response = await POST(request(body) as never, ctx() as never);
      expect(response.status).toBe(400);
      expect(priceService.changeMenuItemPrice).not.toHaveBeenCalled();
    }
  });

  it("never asks the database about an id that cannot be a uuid", async () => {
    vi.mocked(db.query).mockClear();
    const response = await POST(request({ price: 50_000 }) as never, ctx("not-a-uuid") as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "bad_request" });
    // The old code queried `menu_items WHERE id = $1` with this string.
    expect(db.query).not.toHaveBeenCalled();
    expect(priceService.changeMenuItemPrice).not.toHaveBeenCalled();
  });

  it("accepts ۰ — a real new price, not a missing one", async () => {
    const response = await POST(request({ price: 0 }) as never, ctx() as never);
    expect(response.status).toBe(200);
    expect(priceService.changeMenuItemPrice).toHaveBeenCalledWith(
      expect.objectContaining({ newPrice: 0, source: "manual", changedBy: "user-1" }),
    );
  });

  it("carries a reason and never lets the body choose a source", async () => {
    const response = await POST(
      request({ price: 500_000, reason: "گران شدن شیر", source: "import" }) as never,
      ctx() as never,
    );
    expect(response.status).toBe(200);
    expect(priceService.changeMenuItemPrice).toHaveBeenCalledWith(
      expect.objectContaining({ newPrice: 500_000, reason: "گران شدن شیر", source: "manual" }),
    );
  });

  it("reports an item that is not this branch's as 404, without touching the price", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);
    const response = await POST(request({ price: 500_000 }) as never, ctx() as never);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "item_not_found" });
    expect(priceService.changeMenuItemPrice).not.toHaveBeenCalled();
  });
});
