import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as features from "@/lib/features";
import * as setup from "@/lib/setup-state";
import * as settings from "@/lib/settings";
import { effectivePermissions, PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: () => Promise<Response>) => handler,
  requireAnyPermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/features", () => ({ effectiveFeatures: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn(), SETTING_KEYS: { businessProfile: "business.profile" } }));

const session = { businessId: "business-1", sub: "cashier-1", role: "cashier" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ name: "Cafe" }] } as never);
  vi.mocked(features.effectiveFeatures).mockResolvedValue({ reservations: false, delivery: true });
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
    id: "location-1",
    address: null,
    phone: null,
  } as never);
  vi.mocked(settings.getSetting).mockResolvedValue(null as never);
});

describe("GET /api/business-info selling-role authorization", () => {
  it.each(["cashier", "waiter"] as const)("lets %s read only the receipt data and effective feature flags", async (role) => {
    const roleSession = { businessId: "business-1", sub: `${role}-1`, role };
    expect(effectivePermissions(role, null).has(PERMISSIONS.ordersCreate)).toBe(true);
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: roleSession, error: null } as never);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.settingsManage,
      PERMISSIONS.ordersCreate,
      PERMISSIONS.ordersView,
      PERMISSIONS.inventoryView,
    );
    expect(await response.json()).toMatchObject({
      name: "Cafe",
      features: { reservations: false, delivery: true },
    });
  });

  it("does not query business information for a member with none of the read capabilities", async () => {
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET();
    expect(response.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
    expect(features.effectiveFeatures).not.toHaveBeenCalled();
  });
});
