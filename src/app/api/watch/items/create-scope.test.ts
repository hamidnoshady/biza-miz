import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { createJewelryPiece, createWatchModel } from "@/lib/specialist-product-creation";
import { POST as watch } from "./route";
import { POST as jewelry } from "../../jewelry/items/route";
import { PERMISSIONS } from "@/lib/permissions";

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/industry-guard", () => ({ requireIndustryForApi: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/specialist-product-creation", () => ({ createJewelryPiece: vi.fn(), createWatchModel: vi.fn() }));
vi.mock("@/lib/item-audit-service", () => ({ recordItemEvent: vi.fn() }));

const session = { businessId: "business", sub: "member" };
function request(industry: string, expectedLocationId?: string) {
  return new NextRequest(`http://localhost/api/${industry}/items`, { method: "POST", body: JSON.stringify({ name: "کالا", expectedLocationId, purity: "18", grossWeight: "2", netWeight: "1" }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(requireIndustryForApi).mockResolvedValue(null);
  vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "branch" } as never);
  vi.mocked(createWatchModel).mockResolvedValue({ id: "watch" } as never);
  vi.mocked(createJewelryPiece).mockResolvedValue({ id: "gold" } as never);
});
describe("specialist creation branch and permission safety", () => {
  it.each([["watch", watch, createWatchModel], ["jewelry", jewelry, createJewelryPiece]] as const)("refuses a stale branch in %s without writing", async (industry, handler, create) => {
    const result = await handler(request(industry, "another-branch"));
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "location_changed" });
    expect(create).not.toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.inventoryAdjust);
  });
  it.each([["watch", watch, createWatchModel], ["jewelry", jewelry, createJewelryPiece]] as const)("preserves existing %s clients and accepts the current branch", async (industry, handler, create) => {
    expect((await handler(request(industry))).status).toBe(200);
    expect((await handler(request(industry, "branch"))).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it.each([["watch", watch, createWatchModel], ["jewelry", jewelry, createJewelryPiece]] as const)("does not write %s on denied permission or industry", async (industry, handler, create) => {
    vi.mocked(requirePermission).mockResolvedValueOnce({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
    expect((await handler(request(industry, "branch"))).status).toBe(403);
    vi.mocked(requireIndustryForApi).mockResolvedValueOnce(NextResponse.json({ error: "industry_mismatch" }, { status: 403 }));
    expect((await handler(request(industry, "branch"))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
