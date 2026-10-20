/**
 * Issue #924 F07 — the retail price-history read.
 *
 * Every writer appends an immutable row; this endpoint is how the matrix's
 * history dialog and any report read them back. The tests pin the contract
 * that matters at the HTTP edge: branch scope, validated filters (an unknown
 * kind or source is a 400, not an empty report), the hard limit, the joined
 * display fields, and the one failure that is allowed to look like "no rows".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as history from "@/lib/price-history";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/price-history", () => ({ listPriceHistory: vi.fn() }));

const ITEM_ID = "8f14e45f-ceea-467a-9c04-9dbb1f4f6a3c";
const SESSION = { businessId: "biz-1", sub: "user-1" };

function request(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/products/price-history${query}`);
}

const handler = GET as unknown as (req: NextRequest) => Promise<Response>;

const ROW = {
  id: "h1",
  itemId: ITEM_ID,
  itemName: "کرم",
  priceKind: "list" as const,
  priceListId: null,
  priceListName: "عمده",
  oldPrice: 50_000,
  newPrice: 55_000,
  source: "bulk" as const,
  actorId: null,
  actorName: null,
  batchId: "5c2a1f4e-1111-4a2b-9c3d-0e0f1a2b3c4d",
  createdAt: "2026-10-19T08:30:00.000Z",
  reason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(history.listPriceHistory).mockResolvedValue([ROW] as never);
});

describe("GET /api/products/price-history", () => {
  it("reads with inventory.view, scoped to the active branch", async () => {
    const response = await handler(request(`?itemId=${ITEM_ID}`));
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryView);
    const [locationId, filters] = vi.mocked(history.listPriceHistory).mock.calls[0]!;
    expect(locationId).toBe("loc-1");
    expect(filters).toMatchObject({ itemId: ITEM_ID });
  });

  it("returns the display fields the dialog renders", async () => {
    const response = await handler(request(""));
    expect(await response.json()).toEqual({ rows: [ROW] });
  });

  it("rejects an unknown kind or source instead of answering an empty report", async () => {
    const badKind = await handler(request("?kind=wholesale"));
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toEqual({ error: "bad_request" });

    const badSource = await handler(request("?source=telepathy"));
    expect(badSource.status).toBe(400);

    expect(history.listPriceHistory).not.toHaveBeenCalled();
  });

  it("accepts repeated and comma-separated sources", async () => {
    await handler(request("?source=bulk,ai&source=import"));
    const [, filters] = vi.mocked(history.listPriceHistory).mock.calls[0]!;
    expect(filters?.sources).toEqual(["bulk", "ai", "import"]);
  });

  it("passes the kind filter through and lets the service clamp the limit", async () => {
    await handler(request("?kind=sale&limit=99999"));
    const [, filters] = vi.mocked(history.listPriceHistory).mock.calls[0]!;
    expect(filters).toMatchObject({ priceKind: "sale", limit: 99_999 });

    // `limit=0` is "not given", so the service default applies rather than an
    // empty page that looks like "no changes recorded".
    await handler(request("?limit=0"));
    const [, zero] = vi.mocked(history.listPriceHistory).mock.calls[1]!;
    expect(zero?.limit).toBeUndefined();
  });

  it("rejects a malformed item id rather than returning the whole branch", async () => {
    const response = await handler(request("?itemId=not-a-uuid"));
    expect(response.status).toBe(400);
    expect(history.listPriceHistory).not.toHaveBeenCalled();
  });

  it("answers no rows when there is no active branch", async () => {
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await handler(request(""));
    expect(await response.json()).toEqual({ rows: [] });
    expect(history.listPriceHistory).not.toHaveBeenCalled();
  });
});
