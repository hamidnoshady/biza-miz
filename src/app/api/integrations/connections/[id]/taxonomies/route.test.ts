import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setup from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import * as connections from "@/lib/integrations/connections-service";
import * as taxonomyService from "@/lib/integrations/woo-taxonomy-service";
import * as pluginService from "@/lib/integrations/plugin-service";
import { GET, POST } from "./route";

/**
 * Issue #939 — the taxonomies API boundary.
 *
 * TAX-05: the page (wp-guard) stands behind `woocommerce.view`, and this API
 * used to stand behind `integrations.view` — two independent keys, so the
 * screen and its own data endpoint could disagree about who is allowed. The
 * route now accepts either surface's key (WP Manager: woocommerce.view;
 * connections hub: integrations.view) and the assertions below pin BOTH the
 * key set and the denial path, per permutation: Woo-only and integrations-only
 * members are admitted by the auth layer (requireAnyPermission's contract,
 * covered in auth's own tests); `neither` is refused here; and the check runs
 * on every request regardless of which menus the member can see.
 *
 * TAX-08/TAX-14: group totals are the unique-product/assignment split, and a
 * taxonomy with a state row but no terms is a visible empty group, not a
 * vanished one. TAX-12: the POST is the remote action — queued in plugin mode
 * (with the capability fallback), executed in REST mode.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAnyPermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ accessibleLocationsFor: vi.fn() }));

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
  wooClientFor: vi.fn(),
}));

vi.mock("@/lib/integrations/woo-taxonomy-service", () => ({
  listTerms: vi.fn(),
  listTaxonomyStates: vi.fn(),
  taxonomyGroupStats: vi.fn(),
  syncTaxonomyTree: vi.fn(),
}));

vi.mock("@/lib/integrations/plugin-service", () => ({
  enqueuePluginExport: vi.fn(),
}));

const session = { businessId: "biz-1", sub: "user-1", role: "owner" };
const params = { params: Promise.resolve({ id: "conn-1" }) };

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    business_id: "biz-1",
    location_id: "branch-1",
    provider: "woocommerce",
    link_mode: "rest_api",
    sync_products: true,
    status: "active",
    plugin_capabilities: null,
    last_catalogue_sync_at: "2026-10-12T08:00:00.000Z",
    ...overrides,
  };
}

function granted() {
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, membership: null, error: null } as never);
}

function denied() {
  const body = NextResponse.json({ error: "forbidden" }, { status: 403 });
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: null, membership: null, error: body } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  granted();
  vi.mocked(setup.accessibleLocationsFor).mockResolvedValue({
    locations: [{ id: "branch-1" }], businessLocationCount: 2,
  } as never);
  vi.mocked(connections.getConnection).mockResolvedValue(connectionRow() as never);
  vi.mocked(taxonomyService.listTerms).mockResolvedValue([]);
  vi.mocked(taxonomyService.listTaxonomyStates).mockResolvedValue([]);
  vi.mocked(taxonomyService.taxonomyGroupStats).mockResolvedValue({ groups: [], totals: { mappedProducts: 0, assignments: 0 } });
  vi.mocked(pluginService.enqueuePluginExport).mockResolvedValue(undefined);
});

const getRequest = (query = "") =>
  new Request(`http://localhost/api/integrations/connections/conn-1/taxonomies${query}`) as never;

describe("GET /api/integrations/connections/[id]/taxonomies", () => {
  it("accepts either surface's read key — the WP Manager's or the connections hub's", async () => {
    await GET(getRequest(), params);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.woocommerceView,
      PERMISSIONS.integrationsView,
    );
  });

  it("refuses a member holding neither key, before touching any data", async () => {
    denied();
    const res = await GET(getRequest(), params);
    expect(res.status).toBe(403);
    expect(connections.getConnection).not.toHaveBeenCalled();
    expect(taxonomyService.listTerms).not.toHaveBeenCalled();
  });

  it("scopes the connection read to the session's business — another tenant's id is a 404", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(null as never);
    const res = await GET(getRequest(), params);
    expect(res.status).toBe(404);
    expect(connections.getConnection).toHaveBeenCalledWith("biz-1", "conn-1");
  });

  it("shows a state-only taxonomy as an empty group with its status, not as nothing (TAX-14)", async () => {
    vi.mocked(taxonomyService.listTerms).mockResolvedValue([
      {
        taxonomy: "product_cat",
        remoteId: "7",
        parentRemoteId: null,
        name: "پوشاک",
        slug: "clothing",
        description: "",
        remoteCount: 12,
        menuOrder: 0,
        mappedCount: 3,
      },
    ]);
    vi.mocked(taxonomyService.listTaxonomyStates).mockResolvedValue([
      {
        taxonomy: "product_cat",
        restBase: "",
        status: "synced",
        termCount: 1,
        lastError: null,
        lastSyncedAt: "2026-10-12T08:00:00.000Z",
        snapshotAt: "2026-10-12T08:00:00.000Z",
      },
      {
        // Discovered, legitimately empty — the group must still exist.
        taxonomy: "brand",
        restBase: "brands",
        status: "synced",
        termCount: 0,
        lastError: null,
        lastSyncedAt: "2026-10-12T08:00:00.000Z",
        snapshotAt: "2026-10-12T08:00:00.000Z",
      },
      {
        // Discovered, last read failed — visible with the error, over its
        // surviving mirror data.
        taxonomy: "fabric",
        restBase: "",
        status: "failed",
        termCount: 0,
        lastError: "rest_forbidden",
        lastSyncedAt: null,
        snapshotAt: null,
      },
    ]);
    vi.mocked(taxonomyService.taxonomyGroupStats).mockResolvedValue({
      groups: [{ taxonomy: "product_cat", mappedProducts: 2, assignments: 3 }],
      totals: { mappedProducts: 2, assignments: 3 },
    });

    const res = await GET(getRequest(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: {
        taxonomy: string;
        termCount: number;
        mappedCount: number;
        assignmentCount: number;
        status: string;
        lastError: string | null;
        restBase: string | null;
      }[];
      totals: { mappedProducts: number; assignments: number };
      lastTaxonomySyncAt: string | null;
    };

    const bySlug = new Map(body.groups.map((g) => [g.taxonomy, g]));
    expect([...bySlug.keys()].sort()).toEqual(["brand", "fabric", "product_cat"]);
    expect(bySlug.get("brand")).toMatchObject({ termCount: 0, status: "synced", restBase: "brands" });
    expect(bySlug.get("fabric")).toMatchObject({ status: "failed", lastError: "rest_forbidden" });
    // TAX-08: the group's mapped number is the UNIQUE-product stat, and the
    // additive membership total rides beside it under its own key.
    expect(bySlug.get("product_cat")).toMatchObject({ mappedCount: 2, assignmentCount: 3 });
    expect(body.totals).toMatchObject({ mappedProducts: 2, assignments: 3 });
    expect(body.lastTaxonomySyncAt).toBe("2026-10-12T08:00:00.000Z");
  });

  it("orders attribute groups first, then categories, then tags", async () => {
    vi.mocked(taxonomyService.listTerms).mockResolvedValue([
      { taxonomy: "pa_color", remoteId: "1", parentRemoteId: null, name: "قرمز", slug: "red", description: "", remoteCount: 1, menuOrder: 0, mappedCount: 0 },
      { taxonomy: "product_tag", remoteId: "2", parentRemoteId: null, name: "حراج", slug: "sale", description: "", remoteCount: 1, menuOrder: 0, mappedCount: 0 },
      { taxonomy: "product_cat", remoteId: "3", parentRemoteId: null, name: "پوشاک", slug: "clothing", description: "", remoteCount: 1, menuOrder: 0, mappedCount: 0 },
    ]);
    const res = await GET(getRequest(), params);
    const body = (await res.json()) as { groups: { taxonomy: string }[] };
    expect(body.groups.map((g) => g.taxonomy)).toEqual(["pa_color", "product_cat", "product_tag"]);
  });
});

describe("POST /api/integrations/connections/[id]/taxonomies — the remote sync (TAX-12)", () => {
  const postRequest = () =>
    new Request(`http://localhost/api/integrations/connections/conn-1/taxonomies`, { method: "POST" }) as never;

  it("requires a sync-level key from either surface", async () => {
    await POST(postRequest(), params);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.woocommerceSync,
      PERMISSIONS.integrationsManage,
    );
  });

  it("refuses a member without a sync key", async () => {
    denied();
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(403);
    expect(pluginService.enqueuePluginExport).not.toHaveBeenCalled();
  });

  it("queues a taxonomy-only export in plugin mode when the plugin advertises it", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(
      connectionRow({
        link_mode: "plugin",
        plugin_capabilities: { jobTypes: ["catalogue_export", "taxonomy_export"] },
      }) as never,
    );
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, queued: true, jobType: "taxonomy_export" });
    expect(pluginService.enqueuePluginExport).toHaveBeenCalledWith("biz-1", "conn-1", "taxonomy_export");
  });

  it("falls back to the full catalogue export for a plugin that predates taxonomy_export", async () => {
    // A job type the plugin never advertised would never be leased — the row
    // would sit pending forever while the screen claimed a sync was coming.
    vi.mocked(connections.getConnection).mockResolvedValue(
      connectionRow({ link_mode: "plugin", plugin_capabilities: null }) as never,
    );
    const res = await POST(postRequest(), params);
    expect(await res.json()).toMatchObject({ ok: true, queued: true, jobType: "catalogue_export" });
    expect(pluginService.enqueuePluginExport).toHaveBeenCalledWith("biz-1", "conn-1", "catalogue_export");
  });

  it("pulls the tree directly in REST mode and returns the per-taxonomy outcomes", async () => {
    const client = { marker: "client" };
    vi.mocked(connections.wooClientFor).mockReturnValue(client as never);
    vi.mocked(taxonomyService.syncTaxonomyTree).mockResolvedValue({
      taxonomies: ["product_cat"],
      terms: 3,
      truncated: false,
      failed: ["product_tag"],
      status: "partial",
      results: [
        { taxonomy: "product_cat", restBase: null, terms: 3, status: "synced" },
        { taxonomy: "product_tag", restBase: null, terms: 0, status: "failed", error: "woocommerce_list_failed_http_500" },
      ],
      discoveryErrors: [],
    } as never);

    const res = await POST(postRequest(), params);
    // Partial is an honest 200: the run happened and the results ARE the answer.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; queued: boolean; status: string; failed: string[] };
    expect(body).toMatchObject({ ok: true, queued: false, status: "partial", failed: ["product_tag"] });
    expect(taxonomyService.syncTaxonomyTree).toHaveBeenCalledWith("biz-1", "conn-1", client);
  });

  it("answers a total failure as a 502, not a success", async () => {
    vi.mocked(connections.wooClientFor).mockReturnValue({} as never);
    vi.mocked(taxonomyService.syncTaxonomyTree).mockResolvedValue({
      taxonomies: [],
      terms: 0,
      truncated: false,
      failed: ["product_cat", "product_tag"],
      status: "failed",
      results: [],
      discoveryErrors: [],
    } as never);
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: true, status: "failed" });
  });

  it("refuses a paused connection and a products-sync-off connection with an honest 409", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(connectionRow({ status: "paused" }) as never);
    expect((await POST(postRequest(), params)).status).toBe(409);

    vi.mocked(connections.getConnection).mockResolvedValue(connectionRow({ sync_products: false }) as never);
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "sync_products_disabled" });
    expect(pluginService.enqueuePluginExport).not.toHaveBeenCalled();
  });

  it("is not a door for non-WooCommerce connections", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(connectionRow({ provider: "holoo" }) as never);
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(404);
  });
});


describe.each(["GET", "POST"] as const)("taxonomy %s live branch boundary", (method) => {
  it("refuses another branch before reading terms or dispatching sync", async () => {
    vi.mocked(connections.getConnection).mockResolvedValue(connectionRow({ location_id: "branch-2" }) as never);
    const response = await (method === "GET" ? GET : POST)(getRequest(), params);
    expect(response.status).toBe(404);
    expect(setup.accessibleLocationsFor).toHaveBeenCalledWith(session, { includeInactive: true });
    expect(taxonomyService.listTerms).not.toHaveBeenCalled();
    expect(taxonomyService.syncTaxonomyTree).not.toHaveBeenCalled();
    expect(pluginService.enqueuePluginExport).not.toHaveBeenCalled();
    expect(connections.wooClientFor).not.toHaveBeenCalled();
  });
});
