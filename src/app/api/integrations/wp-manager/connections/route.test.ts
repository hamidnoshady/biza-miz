/**
 * Issue #944 / OVR-01 — the manager's own store list: `woocommerce.view`
 * opens it, it is read inside the caller's business only, and it never
 * leaks a non-WooCommerce connection (Holoo) into the WP picker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/integrations/connection-access", () => ({ listAccessibleConnections: vi.fn() }));

const SESSION = { businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", sub: "u1", role: "cashier" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue([
    { id: "w1", provider: "woocommerce", name: "فروشگاه", linkMode: "plugin" },
    { id: "h1", provider: "holoo", name: "هلو" },
    { id: "w2", provider: "woocommerce", name: "فروشگاه", linkMode: "rest_api" },
  ] as never);
});

describe("GET /api/integrations/wp-manager/connections", () => {
  it("is gated on woocommerce.view — not integrations.view", async () => {
    await GET();
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceView);
    expect(auth.requirePermission).not.toHaveBeenCalledWith(PERMISSIONS.integrationsView);
  });

  it("returns the guard's denial untouched and reads nothing", async () => {
    const denial = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({ session: null, error: denial } as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(connectionAccess.listAccessibleConnections).not.toHaveBeenCalled();
  });

  it("lists only the caller's WooCommerce connections, uncached", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(connectionAccess.listAccessibleConnections).toHaveBeenCalledWith(SESSION);
    const body = await res.json();
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual(["w1", "w2"]);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
