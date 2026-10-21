import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as guard from "@/lib/industry-guard";
import * as setup from "@/lib/setup-state";
import * as productLinks from "@/lib/integrations/product-links-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/integrations/product-links-service", () => ({ listProductWooLinks: vi.fn() }));

const SESSION = { businessId: "business-1", sub: "user-1" };
const LINK = {
  localId: "local-1",
  connectionId: "connection-1",
  provider: "woocommerce",
  storeName: "فروشگاه اصلی",
  remoteId: "42",
  connectionStatus: "active",
  lastCatalogueSyncAt: null,
  lastOutboundStatus: "sent",
  lastOutboundSentAt: "2026-10-21T08:00:00.000Z",
  lastOutboundError: null,
};
const handler = GET as unknown as () => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "location-1" } as never);
  vi.mocked(productLinks.listProductWooLinks).mockResolvedValue([LINK] as never);
});

describe("GET /api/products/woo-links", () => {
  it("requires inventory and integration visibility and scopes to active branch", async () => {
    const response = await handler();
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenNthCalledWith(1, PERMISSIONS.inventoryView);
    expect(auth.requirePermission).toHaveBeenNthCalledWith(2, PERMISSIONS.integrationsView);
    expect(guard.requireProductWorkspaceForApi).toHaveBeenCalledWith(SESSION);
    expect(productLinks.listProductWooLinks).toHaveBeenCalledWith("business-1", "location-1");
    expect(await response.json()).toEqual({ links: [LINK] });
  });

  it("does not reveal connection links without integrations.view", async () => {
    const forbidden = Response.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission)
      .mockResolvedValueOnce({ session: SESSION, error: null } as never)
      .mockResolvedValueOnce({ session: SESSION, error: forbidden } as never);

    const response = await handler();
    expect(response.status).toBe(403);
    expect(productLinks.listProductWooLinks).not.toHaveBeenCalled();
  });

  it("returns an empty list when no active branch exists", async () => {
    vi.mocked(setup.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await handler();
    expect(await response.json()).toEqual({ links: [] });
    expect(productLinks.listProductWooLinks).not.toHaveBeenCalled();
  });
});
