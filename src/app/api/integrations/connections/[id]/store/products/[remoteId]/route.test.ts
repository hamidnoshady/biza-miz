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
vi.mock("@/lib/integrations/woo-product-content", () => ({ wooProductContentFor: vi.fn() }));

import * as connectionAccess from "@/lib/integrations/connection-access";
import * as contentService from "@/lib/integrations/woo-product-content";
import { GET } from "./route";

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };
const CONNECTION_ID = "conn-woo-1";

function wooConnection(overrides: Record<string, unknown> = {}) {
  return { id: CONNECTION_ID, business_id: SESSION.businessId, provider: "woocommerce", status: "active", link_mode: "plugin", ...overrides };
}

function productContent(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: "55",
    localId: "local-uuid",
    name: "جاکفشی چوبی",
    sku: "SKU-1",
    wooType: "simple",
    remoteStatus: "publish",
    shortDescription: "کوتاه",
    description: "<p>بلند</p>",
    image: null,
    gallery: [],
    galleryCount: null,
    remoteModifiedAt: null,
    lastSeenAt: null,
    queue: null,
    ...overrides,
  };
}

function get(remoteId = "55") {
  return GET(new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/store/products/${remoteId}`) as never, {
    params: Promise.resolve({ id: CONNECTION_ID, remoteId }),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection() as never);
  vi.mocked(contentService.wooProductContentFor).mockResolvedValue(productContent() as never);
});

describe("GET store/products/[remoteId] — the store's own storefront content", () => {
  it("reads one product on the storefront ability, not the integrations one", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceView);
    expect(contentService.wooProductContentFor).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "55");
    const body = await res.json();
    expect(body.product.description).toBe("<p>بلند</p>");
    expect(body.canWrite).toBe(true);
  });

  it("keeps a paused connection readable but closed for writes", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ status: "paused" }) as never);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).canWrite).toBe(false);
  });

  it("refuses a non-numeric id before it reaches the mapping table", async () => {
    const res = await get("../../etc");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_remote_id" });
    expect(contentService.wooProductContentFor).not.toHaveBeenCalled();
  });

  it("answers 404 for an id this connection never mapped — never an empty editor", async () => {
    vi.mocked(contentService.wooProductContentFor).mockResolvedValue(null as never);
    const res = await get("999");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "product_not_mapped" });
  });

  it("treats a Holoo connection as not found rather than reading a store it is not", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(wooConnection({ provider: "holoo" }) as never);
    const res = await get();
    expect(res.status).toBe(404);
    expect(contentService.wooProductContentFor).not.toHaveBeenCalled();
  });

  it("does not hand an internal error to the client", async () => {
    vi.mocked(contentService.wooProductContentFor).mockRejectedValue(new Error("relation does not exist"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });

  it("returns the permission guard's own response when the member may not view the store", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: denied } as never);
    const res = await get();
    expect(res.status).toBe(403);
    expect(contentService.wooProductContentFor).not.toHaveBeenCalled();
  });
});
