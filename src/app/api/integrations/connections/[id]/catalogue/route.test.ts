import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import type { CatalogueRow } from "@/lib/integrations/sync-service";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ catalogueFor: vi.fn() }));
vi.mock("@/lib/integrations/woo-ops-service", () => ({ productQueueStates: vi.fn() }));
vi.mock("@/lib/ai-money-unit", () => ({ resolveBusinessMoneyUnit: vi.fn() }));

import * as connectionsService from "@/lib/integrations/connections-service";
import * as syncService from "@/lib/integrations/sync-service";
import * as opsService from "@/lib/integrations/woo-ops-service";
import * as moneyUnit from "@/lib/ai-money-unit";
import { GET } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";

const WOO_CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  status: "active",
  link_mode: "rest_api",
  currency_unit: "toman",
  push_stock: true,
  push_prices: true,
  sync_products: true,
  last_catalogue_sync_at: "2026-10-12T08:00:00Z",
  last_error: null,
};

function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
  return {
    remoteId: "1",
    localId: "11111111-1111-1111-1111-111111111111",
    name: "تی‌شرت",
    sku: null,
    wooType: "simple",
    itemKind: "simple",
    sellable: true,
    priceRial: 1500000n,
    quantity: 5,
    parentRemoteId: null,
    categories: [],
    attributes: [],
    remoteStatus: "publish",
    remoteManageStock: true,
    remoteRegularPriceRial: "1500000",
    remoteSalePriceRial: null,
    lastSyncedAt: "2026-10-12T08:00:00Z",
    ...overrides,
  } as CatalogueRow;
}

function request(query = ""): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/catalogue${query}`),
    { params: Promise.resolve({ id: CONNECTION_ID }) },
  ];
}

async function get(query = "") {
  const [req, ctx] = request(query);
  return GET(req as never, ctx as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(WOO_CONNECTION as never);
  vi.mocked(moneyUnit.resolveBusinessMoneyUnit).mockResolvedValue("toman");
  vi.mocked(opsService.productQueueStates).mockResolvedValue({});
  vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows: [] });
});

describe("GET /api/integrations/connections/[id]/catalogue — authorization", () => {
  it("gates on woocommerce.view, not the technical-connection privilege", async () => {
    await get();
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceView);
  });

  it("passes a denial straight through", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await get();
    expect(res.status).toBe(403);
    expect(syncService.catalogueFor).not.toHaveBeenCalled();
  });

  it("rejects a Holoo connection id with 404 — this route speaks WooCommerce only", async () => {
    // Since migration 0103 the table holds Holoo rows too; resolving one
    // here must not leak catalogue shapes or queue Woo work.
    vi.mocked(connectionsService.getConnection).mockResolvedValue({
      ...WOO_CONNECTION,
      provider: "holoo",
    } as never);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(syncService.catalogueFor).not.toHaveBeenCalled();
  });

  it("rejects another tenant's or unknown connection id with 404", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
  });
});

describe("GET /api/integrations/connections/[id]/catalogue — listing", () => {
  const rows = [
    row({ remoteId: "3", name: "الف", wooType: "simple", sku: "A-3" }),
    row({ remoteId: "2", name: "ب", wooType: "variation", parentRemoteId: "9" }),
    row({ remoteId: "1", name: "پ", wooType: "grouped", sellable: false, quantity: null }),
  ];

  it("serializes prices as strings and attaches the store snapshot + queue state", async () => {
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows });
    vi.mocked(opsService.productQueueStates).mockResolvedValue({
      "2": {
        state: "queued",
        kinds: ["product_update"],
        pendingPatch: { regular_price: "15000" },
        lastError: null,
        updatedAt: "2026-10-12T09:00:00Z",
        lastSentAt: null,
      },
    } as never);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.industry).toBe("accessories");
    expect(body.moneyUnit).toBe("toman");
    expect(body.connection).toMatchObject({ currencyUnit: "toman", linkMode: "rest_api", pushStock: true });
    // BigInt on the wire is a crash; every price leaves as a string.
    for (const product of body.products) {
      expect(product.priceRial === null || typeof product.priceRial === "string").toBe(true);
    }
    const variation = body.products.find((p: { remoteId: string }) => p.remoteId === "2");
    expect(variation.queue).toMatchObject({ state: "queued", pendingPatch: { regular_price: "15000" } });
    expect(variation.remoteRegularPriceRial).toBe("1500000");
  });

  it("derives type facets and the summary from the WHOLE catalogue, not the visible page", async () => {
    const many: CatalogueRow[] = [
      ...Array.from({ length: 12 }, (_, i) => row({ remoteId: `s${i}`, name: `ساده ${i}`, wooType: "simple" })),
      row({ remoteId: "v1", name: "تنوع", wooType: "variation" }),
      row({ remoteId: "g1", name: "گروه", wooType: "grouped", sellable: false }),
    ];
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows: many });

    const res = await get("?page=1&pageSize=10");
    const body = await res.json();
    // The page holds 10 rows, but the facets know about the `grouped` on page 2.
    expect(body.products.length).toBe(10);
    expect(body.types).toEqual(["grouped", "simple", "variation"]);
    expect(body.summary.total).toBe(14);
    expect(body.summary.containers).toBe(1);
    expect(body.total).toBe(14);
    expect(body.totalPages).toBe(2);
  });

  it("pages deterministically — no duplicate and no missing row across the pages", async () => {
    const many: CatalogueRow[] = Array.from({ length: 55 }, (_, i) =>
      row({ remoteId: String(i + 1), name: `محصول ${(i * 7) % 55}` }),
    );
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows: many });

    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const body = await (await get(`?page=${page}&pageSize=20`)).json();
      expect(body.page).toBe(page);
      for (const product of body.products) {
        expect(seen.has(product.remoteId), `duplicate ${product.remoteId} on page ${page}`).toBe(false);
        seen.add(product.remoteId);
      }
    }
    expect(seen.size).toBe(55);
  });

  it("shares one search predicate with the client — the type is searchable too", async () => {
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows });
    const body = await (await get("?search=variation")).json();
    expect(body.total).toBe(1);
    expect(body.products[0].remoteId).toBe("2");
  });

  it("filters by type and reports the filtered total while the summary stays whole", async () => {
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows });
    const body = await (await get("?type=grouped")).json();
    expect(body.total).toBe(1);
    expect(body.products[0].wooType).toBe("grouped");
    expect(body.summary.total).toBe(3);
  });

  it("asks queue states only for the ids on the page", async () => {
    // pageSize is clamped to a minimum of 10, so 12 rows page at 10.
    const many: CatalogueRow[] = Array.from({ length: 12 }, (_, i) =>
      row({ remoteId: `p${i}`, name: `محصول ${i}` }),
    );
    vi.mocked(syncService.catalogueFor).mockResolvedValue({ industry: "accessories", rows: many });
    await get("?page=1&pageSize=10");
    const call = vi.mocked(opsService.productQueueStates).mock.calls[0];
    expect(call[0]).toBe(SESSION.businessId);
    expect(call[1]).toBe(CONNECTION_ID);
    expect(call[2]).toHaveLength(10);
  });
});
