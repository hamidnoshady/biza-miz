import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as guard from "@/lib/industry-guard";
import * as service from "@/lib/retail-pricing-service";
import { DEFAULT_RETAIL_PRICING_POLICY } from "@/lib/retail-pricing-policy";
import { hasModule, moduleForApiPath } from "@/lib/industry-profile";
import { GET, PUT } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/industry-guard", () => ({ requireProductWorkspaceForApi: vi.fn() }));

vi.mock("@/lib/retail-pricing-service", () => ({
  getRetailPricingPolicy: vi.fn(),
  setRetailPricingPolicy: vi.fn(),
  getDefaultTaxPercent: vi.fn(),
}));

const SESSION = { businessId: "biz-1" };
const EXISTING = { ...DEFAULT_RETAIL_PRICING_POLICY, profitPercent: 25 };

function put(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(null);
  vi.mocked(service.getRetailPricingPolicy).mockResolvedValue(EXISTING);
  vi.mocked(service.getDefaultTaxPercent).mockResolvedValue(10);
});

describe("GET /api/settings/retail-pricing", () => {
  it("returns the policy and the business tax rate to anyone who can see inventory", async () => {
    const res = await (GET as unknown as () => Promise<NextResponse>)();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: EXISTING, defaultTaxPercent: 10 });
    expect(auth.requirePermission).toHaveBeenCalledWith("inventory.view");
  });

  it("refuses a trade that has no product workspace", async () => {
    vi.mocked(guard.requireProductWorkspaceForApi).mockResolvedValue(
      NextResponse.json({ error: "industry_mismatch" }, { status: 403 }),
    );
    const res = await (GET as unknown as () => Promise<NextResponse>)();
    expect(res.status).toBe(403);
    expect(service.getRetailPricingPolicy).not.toHaveBeenCalled();
  });
});

describe("PUT /api/settings/retail-pricing", () => {
  const call = PUT as unknown as (request: NextRequest) => Promise<NextResponse>;

  it("needs settings.manage", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const res = await call(put({ profitPercent: 30 }));
    expect(res.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith("settings.manage");
    expect(service.setRetailPricingPolicy).not.toHaveBeenCalled();
  });

  it("merges an omitted key from the stored policy and saves", async () => {
    const res = await call(put({ rounding: "up", percentOverhead: 8 }));
    expect(res.status).toBe(200);
    const saved = { ...EXISTING, rounding: "up", percentOverhead: 8 };
    expect(service.setRetailPricingPolicy).toHaveBeenCalledWith("biz-1", saved);
    expect(await res.json()).toEqual({ ok: true, policy: saved, defaultTaxPercent: 10 });
  });

  it("rejects an invalid value without saving", async () => {
    const res = await call(put({ profitMode: "margin", profitPercent: 120 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_profit_percent" });
    expect(service.setRetailPricingPolicy).not.toHaveBeenCalled();
  });

  it("rejects an unreadable body", async () => {
    const res = await call({ json: async () => { throw new Error("bad"); } } as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});

describe("module gating", () => {
  it("is reachable by the trades that use it — it must not inherit the menu module of /api/settings/pricing", () => {
    expect(moduleForApiPath("/api/settings/pricing")).toBe("menu");
    const module = moduleForApiPath("/api/settings/retail-pricing");
    expect(module).toBe("settings");
    for (const industry of ["accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery"] as const) {
      expect(module && hasModule(industry, module)).toBe(true);
    }
  });
});
