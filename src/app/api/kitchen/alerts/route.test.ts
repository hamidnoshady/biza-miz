import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as guard from "@/lib/industry-guard";
import * as service from "@/lib/kitchen-alert-service";
import * as setup from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { GET, PUT } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (request?: Request) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
  requirePermissions: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/kitchen-alert-service", () => ({
  loadKitchenAlertThresholds: vi.fn(),
  saveKitchenAlertThresholds: vi.fn(),
}));

const defaultThresholds = { overdueMinutes: 10, approachingMinutes: null as number | null };
const session = { businessId: "business-1", sub: "member-1", role: "manager" as const };

function guardFor(permissions: string[]) {
  return {
    session,
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "location-1" } as never);
  vi.mocked(guard.isModuleEnabled).mockResolvedValue(true);
  vi.mocked(service.loadKitchenAlertThresholds).mockResolvedValue({
    defaults: null,
    overrides: defaultThresholds,
    effective: defaultThresholds,
  } as never);
});

describe("GET /api/kitchen/alerts", () => {
  it("returns the branch's persisted thresholds and the editor flag to a settings manager", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardFor([PERMISSIONS.kitchenView, PERMISSIONS.settingsManage]) as never,
    );

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thresholds: defaultThresholds, canEdit: true });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.kitchenView);
    expect(guard.isModuleEnabled).toHaveBeenCalledWith("business-1", "kitchen");
    expect(service.loadKitchenAlertThresholds).toHaveBeenCalledWith("business-1", "location-1");
  });

  it("keeps a kitchen member read-only", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardFor([PERMISSIONS.kitchenView]) as never,
    );

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thresholds: defaultThresholds, canEdit: false });
  });

  it("refuses a trade without the kitchen module", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue(
      guardFor([PERMISSIONS.kitchenView]) as never,
    );
    vi.mocked(guard.isModuleEnabled).mockResolvedValue(false);

    const response = await GET();
    expect(response.status).toBe(404);
    expect(service.loadKitchenAlertThresholds).not.toHaveBeenCalled();
  });
});

describe("PUT /api/kitchen/alerts", () => {
  it("requires kitchen.view + settings.manage and validates the two thresholds", async () => {
    vi.mocked(auth.requirePermissions).mockResolvedValue(
      guardFor([PERMISSIONS.kitchenView, PERMISSIONS.settingsManage]) as never,
    );

    const bad = await PUT(
      new Request("http://localhost/api/kitchen/alerts", {
        method: "PUT",
        body: JSON.stringify({ thresholds: { overdueMinutes: 10, approachingMinutes: 10 } }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(service.saveKitchenAlertThresholds).not.toHaveBeenCalled();

    const good = await PUT(
      new Request("http://localhost/api/kitchen/alerts", {
        method: "PUT",
        body: JSON.stringify({ thresholds: { overdueMinutes: 20, approachingMinutes: 10 } }),
      }),
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({
      thresholds: { overdueMinutes: 20, approachingMinutes: 10 },
      canEdit: true,
    });
    expect(auth.requirePermissions).toHaveBeenCalledWith(
      PERMISSIONS.kitchenView,
      PERMISSIONS.settingsManage,
    );
    expect(service.saveKitchenAlertThresholds).toHaveBeenCalledWith(
      expect.anything(),
      {
        businessId: "business-1",
        locationId: "location-1",
        thresholds: { overdueMinutes: 20, approachingMinutes: 10 },
      },
    );
  });
});
