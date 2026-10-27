import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import type { CataloguePage, CatalogueRow } from "@/lib/integrations/sync-service";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ cataloguePageFor: vi.fn() }));
vi.mock("@/lib/integrations/woo-ops-service", () => ({ productQueueStates: vi.fn() }));
vi.mock("@/lib/ai-money-unit", () => ({ resolveBusinessMoneyUnit: vi.fn() }));

import * as connectionAccess from "@/lib/integrations/connection-access";
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
    stockTracked: true,
    priceRial: 1500000n,
    quantity: 5,
    parentRemoteId: null,
    categories: [],
    attributes: [],
    remoteStatus: "publish",
    remoteManageStock: true,
    remoteRegularPriceRial: "1500000",
    remoteSalePriceRial: null,
    remoteImageSrc: null,
    remoteImageAlt: null,
    lastSyncedAt: "2026-10-12T08:00:00Z",
    ...overrides,
  } as CatalogueRow;
}

/** A service page result with every field the route mirrors onto the wire. */
function page(overrides: Partial<CataloguePage> = {}): CataloguePage {
  const rows = overrides.rows ?? [];
  return {
    industry: "accessories",
    rows,
    total: overrides.total ?? rows.length,
    mappedTotal: overrides.mappedTotal ?? rows.length,
    summary: overrides.summary ?? {
      total: rows.length,
      sellable: rows.length,
      containers: 0,
      variations: 0,
      outOfStock: 0,
      uncategorised: rows.length,
    },
    types: overrides.types ?? [],
    facets: overrides.facets ?? { categories: [], tags: [], statuses: [] },
    page: overrides.page ?? 1,
    pageSize: overrides.pageSize ?? 25,
    totalPages: overrides.totalPages ?? 1,
    ...overrides,
  };
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
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(WOO_CONNECTION as never);
  vi.mocked(moneyUnit.resolveBusinessMoneyUnit).mockResolvedValue("toman");
  vi.mocked(opsService.productQueueStates).mockResolvedValue({});
  vi.mocked(syncService.cataloguePageFor).mockResolvedValue(page());
});

describe("GET /api/integrations/connections/[id]/catalogue — authorization", () => {
  it("gates on woocommerce.view, not the technical-connection privilege", async () => {
    await get();
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceView);
    // #1037: the connection is fetched through the live-branch-scoped
    // accessor, session in hand — not by business id alone.
    expect(connectionAccess.getAccessibleConnection).toHaveBeenCalledWith(SESSION, CONNECTION_ID);
  });

  it("passes a denial straight through", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await get();
    expect(res.status).toBe(403);
    expect(syncService.cataloguePageFor).not.toHaveBeenCalled();
  });

  it("rejects a Holoo connection id with 404 — this route speaks WooCommerce only", async () => {
    // Since migration 0103 the table holds Holoo rows too; resolving one
    // here must not leak catalogue shapes or queue Woo work.
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue({
      ...WOO_CONNECTION,
      provider: "holoo",
    } as never);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(syncService.cataloguePageFor).not.toHaveBeenCalled();
  });

  it("rejects another tenant's or unknown connection id with 404", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(404);
  });
});

describe("GET /api/integrations/connections/[id]/catalogue — listing", () => {
  it("hands the tenant, the connection and the raw URL parameters to the SQL reader", async () => {
    // Since issue #943 item 1 the paging lives in the database: the route's
    // job is to scope the call to this session's business + this connection
    // and to pass the parameters through for ONE clamping rule (the
    // service's) instead of normalising them twice with drifting limits.
    await get("?page=3&pageSize=50&search=%D8%AA%DB%8C&type=simple&taxonomy=product_cat&term=12&status=draft&stock=out");
    expect(syncService.cataloguePageFor).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, {
      page: 3,
      pageSize: 50,
      search: "تی",
      type: "simple",
      taxonomy: "product_cat",
      term: "12",
      status: "draft",
      stock: "out",
    });
  });

  it("defaults to page 1 / size 25 / no filters and survives junk parameters", async () => {
    await get();
    expect(syncService.cataloguePageFor).toHaveBeenLastCalledWith(SESSION.businessId, CONNECTION_ID, {
      page: 1,
      pageSize: 25,
      search: null,
      type: null,
      taxonomy: null,
      term: null,
      status: null,
      stock: null,
    });
    await get("?page=abc&pageSize=xyz");
    // Number.parseInt of junk is NaN — the service clamps it; the route must
    // hand it over rather than invent its own fallback.
    expect(syncService.cataloguePageFor).toHaveBeenLastCalledWith(SESSION.businessId, CONNECTION_ID, {
      page: Number.NaN,
      pageSize: Number.NaN,
      search: null,
      type: null,
      taxonomy: null,
      term: null,
      status: null,
      stock: null,
    });
  });

  it("serializes prices as strings and attaches the store snapshot + queue state", async () => {
    const rows = [
      row({ remoteId: "3", name: "الف", wooType: "simple", sku: "A-3" }),
      row({ remoteId: "2", name: "ب", wooType: "variation", parentRemoteId: "9" }),
      row({ remoteId: "1", name: "پ", wooType: "grouped", sellable: false, stockTracked: false, quantity: null }),
    ];
    vi.mocked(syncService.cataloguePageFor).mockResolvedValue(
      page({ rows, total: 3, mappedTotal: 3, types: ["grouped", "simple", "variation"] }),
    );
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
    expect(body.types).toEqual(["grouped", "simple", "variation"]);
    // BigInt on the wire is a crash; every price leaves as a string.
    for (const product of body.products) {
      expect(product.priceRial === null || typeof product.priceRial === "string").toBe(true);
    }
    const variation = body.products.find((p: { remoteId: string }) => p.remoteId === "2");
    expect(variation.queue).toMatchObject({ state: "queued", pendingPatch: { regular_price: "15000" } });
    expect(variation.remoteRegularPriceRial).toBe("1500000");
    // The untracked container's honesty travels too: no fabricated quantity.
    const grouped = body.products.find((p: { remoteId: string }) => p.remoteId === "1");
    expect(grouped.stockTracked).toBe(false);
    expect(grouped.quantity).toBeNull();
  });

  it("mirrors the service's whole-catalogue summary and filtered totals without recomputing them", async () => {
    // The old route re-derived these in memory from a full fetch; the numbers
    // now come out of the same SQL statement as the rows, and the route must
    // pass them through untouched — a second, disagreeing computation in the
    // route is exactly the drift issue #943 removed.
    const pageRows = Array.from({ length: 10 }, (_, i) => row({ remoteId: `p${i}`, name: `محصول ${i}` }));
    vi.mocked(syncService.cataloguePageFor).mockResolvedValue(
      page({
        rows: pageRows,
        total: 42,
        mappedTotal: 1200,
        totalPages: 5,
        page: 2,
        pageSize: 10,
        types: ["simple", "variation"],
        summary: { total: 1200, sellable: 1100, containers: 100, variations: 300, outOfStock: 7, uncategorised: 5 },
      }),
    );

    const body = await (await get("?page=2&pageSize=10")).json();
    expect(body.products).toHaveLength(10);
    expect(body.total).toBe(42);
    expect(body.mappedTotal).toBe(1200);
    expect(body.totalPages).toBe(5);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(10);
    expect(body.summary).toEqual({ total: 1200, sellable: 1100, containers: 100, variations: 300, outOfStock: 7, uncategorised: 5 });
  });

  it("asks queue states only for the ids on the page", async () => {
    const pageRows = Array.from({ length: 10 }, (_, i) => row({ remoteId: `p${i}`, name: `محصول ${i}` }));
    vi.mocked(syncService.cataloguePageFor).mockResolvedValue(page({ rows: pageRows, total: 12, mappedTotal: 12 }));
    await get("?page=1&pageSize=10");
    const call = vi.mocked(opsService.productQueueStates).mock.calls[0];
    expect(call[0]).toBe(SESSION.businessId);
    expect(call[1]).toBe(CONNECTION_ID);
    expect(call[2]).toHaveLength(10);
  });

  it("skips the queue read entirely on an empty page", async () => {
    await get("?search=%D9%86%D8%A7%D9%BE%DB%8C%D8%AF%D8%A7");
    expect(opsService.productQueueStates).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, []);
  });
});
