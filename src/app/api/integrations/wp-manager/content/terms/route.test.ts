import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * The term list a post's editor offers (#1215, P2-5). The interesting cases are
 * not the happy path but the three ways a store can answer "no list": a plugin
 * that never reported one, a REST key that may not read terms, and one
 * collection failing while the other works.
 */
const m = vi.hoisted(() => ({
  connection: vi.fn(),
  listPage: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: m.connection }));
vi.mock("@/lib/integrations/connections-service", () => ({
  wooClientFor: () => ({ wpListPage: m.listPage }),
}));

import * as auth from "@/lib/auth";
import { GET } from "./route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function get(connectionId = CONNECTION_ID) {
  return new Request(`http://test/api/terms?connectionId=${connectionId}`) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
  m.connection.mockResolvedValue({ id: CONNECTION_ID, provider: "woocommerce", link_mode: "rest_api" });
  m.listPage.mockResolvedValue({ items: [], totalPages: 1 });
});

describe("GET /api/integrations/wp-manager/content/terms", () => {
  it("reads the site's own categories and tags when the app holds the keys", async () => {
    m.listPage.mockImplementation((endpoint: string) =>
      Promise.resolve({
        items: endpoint === "categories" ? [{ id: 2, name: "دستهٔ اصلی", count: 4 }] : [{ id: 9, name: "برچسب", count: 1 }],
        totalPages: 1,
      }),
    );

    const response = await GET(get());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(m.listPage).toHaveBeenCalledWith("categories", expect.objectContaining({ per_page: 100 }));
    expect(m.listPage).toHaveBeenCalledWith("tags", expect.objectContaining({ per_page: 100 }));
    expect(json.categories).toEqual([{ id: 2, name: "دستهٔ اصلی", parent: 0, count: 4 }]);
    expect(json.tags).toEqual([{ id: 9, name: "برچسب", parent: 0, count: 1 }]);
    expect(json.unsupported).toBeUndefined();
  });

  it("keeps the working half when one collection cannot be read", async () => {
    m.listPage.mockImplementation((endpoint: string) =>
      endpoint === "categories"
        ? Promise.reject(new Error("wp_list_terms_forbidden"))
        : Promise.resolve({ items: [{ id: 9, name: "برچسب" }], totalPages: 1 }),
    );

    const json = await (await GET(get())).json();

    expect(json.categories).toEqual([]);
    expect(json.tags).toHaveLength(1);
    // Partial is named, not hidden: the editor says so instead of showing an
    // empty category list that looks like "this site has none".
    expect(json.partial).toBe(true);
  });

  it("answers from the handshake in plugin mode, without reaching the site", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      link_mode: "plugin",
      plugin_capabilities: {
        contentTaxonomies: true,
        postCategories: [{ id: 3, name: "اخبار", count: 7 }],
        postTags: [{ id: 11, name: "راهنما" }],
      },
    });

    const json = await (await GET(get())).json();

    expect(json.categories).toEqual([{ id: 3, name: "اخبار", parent: 0, count: 7 }]);
    expect(json.tags).toEqual([{ id: 11, name: "راهنما", parent: 0, count: 0 }]);
    expect(m.listPage).not.toHaveBeenCalled();
  });

  it("says unsupported — not empty — when an older plugin reported no terms", async () => {
    m.connection.mockResolvedValue({
      id: CONNECTION_ID,
      provider: "woocommerce",
      link_mode: "plugin",
      plugin_capabilities: { jobTypes: ["post_upsert"] },
    });

    const json = await (await GET(get())).json();

    expect(json).toEqual({ categories: [], tags: [], unsupported: true });
  });

  it("hides another business's connection behind not_found", async () => {
    m.connection.mockResolvedValue(null);

    expect((await GET(get())).status).toBe(404);
    expect((await GET(get(""))).status).toBe(400);
  });
});
