import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setup from "@/lib/setup-state";
import * as db from "@/lib/db";
import * as connections from "@/lib/integrations/connections-service";
import * as manager from "@/lib/integrations/wp-manager-service";
import * as content from "@/lib/integrations/wp-content-service";
import * as overviewRoute from "./overview/route";
import * as queueRoute from "./queue/route";
import * as retryRoute from "./queue/[id]/retry/route";
import * as customersRoute from "./customers/route";
import * as contentRoute from "./content/route";
import * as postsRoute from "./content/posts/route";
import * as mediaRoute from "./media/route";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  // The content POST gates on the any-of WP sync ability (#944 / OVR-01).
  requireAnyPermission: vi.fn(),
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/setup-state", () => ({ accessibleLocationsFor: vi.fn() }));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(), listConnections: vi.fn(), wooClientFor: vi.fn(),
}));
vi.mock("@/lib/integrations/audit", () => ({ writeIntegrationAudit: vi.fn() }));
vi.mock("@/lib/integrations/wp-manager-service", () => ({
  wpOverviewStats: vi.fn(), wpQueue: vi.fn(), wpQueueSummary: vi.fn(),
  retryWpQueueRow: vi.fn(), retryAllFailedWpQueue: vi.fn(), flushWpOutbox: vi.fn(),
  wpStoreCustomers: vi.fn(),
}));
vi.mock("@/lib/integrations/wp-content-service", () => ({
  countWpContent: vi.fn(), enqueueContentExport: vi.fn(), listWpContent: vi.fn(),
  syncWpContentRest: vi.fn(), getWpContent: vi.fn(), upsertWpContent: vi.fn(),
}));

const session = { businessId: "business", sub: "manager", role: "manager" };
const read = (path: string) => new Request(`https://biza.example/api/integrations/wp-manager/${path}?connectionId=connection&type=post&id=1`);
const write = (path: string, body: Record<string, unknown>) => new Request(read(path), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ connectionId: "connection", ...body }),
});
const routes: [string, () => Promise<Response>][] = [
  ["overview GET", () => overviewRoute.GET(read("overview"))],
  ["queue GET", () => queueRoute.GET(read("queue"))],
  ["queue POST", () => queueRoute.POST(write("queue", { action: "flush" }))],
  ["retry POST", () => retryRoute.POST(write("queue/row/retry", {}), { params: Promise.resolve({ id: "row" }) })],
  ["customers GET", () => customersRoute.GET(read("customers"))],
  ["content GET", () => contentRoute.GET(read("content"))],
  ["content POST", () => contentRoute.POST(write("content", {}))],
  ["post GET", () => postsRoute.GET(read("content/posts"))],
  ["post POST", () => postsRoute.POST(write("content/posts", { post_type: "post", title: "Article" }))],
  ["media POST", () => mediaRoute.POST(write("media", { url: "https://cdn.example/image.jpg" }))],
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(setup.accessibleLocationsFor).mockResolvedValue({
    locations: [{ id: "allowed-branch" }], businessLocationCount: 2,
  } as never);
  vi.mocked(connections.getConnection).mockResolvedValue({
    id: "connection", provider: "woocommerce", location_id: "other-branch", status: "active",
  } as never);
});

describe.each(routes)("WordPress Manager %s", (_name, call) => {
  it("denies an unassigned connection before reads, network calls or queue writes", async () => {
    const response = await call();
    expect(response.status).toBe(404);
    expect(connections.getConnection).toHaveBeenCalledWith(session.businessId, "connection");
    expect(setup.accessibleLocationsFor).toHaveBeenCalledWith(session, { includeInactive: true });
    expect(db.query).not.toHaveBeenCalled();
    expect(connections.wooClientFor).not.toHaveBeenCalled();
    for (const sink of [...Object.values(manager), ...Object.values(content)]) {
      expect(sink).not.toHaveBeenCalled();
    }
  });

  if (_name.endsWith("POST")) {
    it("does not dispatch or retry work on a paused connection", async () => {
      vi.mocked(connections.getConnection).mockResolvedValue({
        id: "connection", provider: "woocommerce", location_id: "allowed-branch", status: "paused",
      } as never);
      const response = await call();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "connection_paused" });
      expect(db.query).not.toHaveBeenCalled();
      for (const sink of [...Object.values(manager), ...Object.values(content)]) {
        expect(sink).not.toHaveBeenCalled();
      }
    });
  }

  it("retains the permission gate before resolving the connection", async () => {
    const denial = { session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never;
    vi.mocked(auth.requirePermission).mockResolvedValue(denial);
    vi.mocked(auth.requireAnyPermission).mockResolvedValue(denial);
    expect((await call()).status).toBe(403);
    expect(connections.getConnection).not.toHaveBeenCalled();
    expect(setup.accessibleLocationsFor).not.toHaveBeenCalled();
  });
});

describe("WordPress Manager aggregate overview", () => {
  it("passes only accessible WooCommerce IDs to every aggregate query", async () => {
    vi.mocked(connections.listConnections).mockResolvedValue([
      { id: "allowed", provider: "woocommerce", locationId: "allowed-branch" },
      { id: "other", provider: "woocommerce", locationId: "other-branch" },
      { id: "global", provider: "woocommerce", locationId: null },
      { id: "holoo", provider: "holoo", locationId: "allowed-branch" },
    ] as never);
    vi.mocked(manager.wpOverviewStats).mockResolvedValue({ connections: { total: 1 } } as never);
    const response = await overviewRoute.GET(new Request("https://biza.example/api/integrations/wp-manager/overview"));
    expect(response.status).toBe(200);
    expect(manager.wpOverviewStats).toHaveBeenCalledWith(session.businessId, ["allowed"]);
  });

  it("passes an explicit empty scope rather than falling back to business totals", async () => {
    vi.mocked(connections.listConnections).mockResolvedValue([]);
    await overviewRoute.GET(new Request("https://biza.example/api/integrations/wp-manager/overview"));
    expect(manager.wpOverviewStats).toHaveBeenCalledWith(session.businessId, []);
  });
});
