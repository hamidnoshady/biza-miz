import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as commissionService from "@/lib/commission-service";
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

vi.mock("@/lib/commission-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/commission-service")>();
  return { ...actual, staffCommissionReport: vi.fn(async () => []) };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function request(search = ""): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/commission/report${search}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(commissionService.staffCommissionReport).mockResolvedValue([]);
});

describe("GET /api/commission/report date validation", () => {
  it("rejects impossible Gregorian dates before querying the report", async () => {
    const response = await GET(request("?from=2026-02-31"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(commissionService.staffCommissionReport).not.toHaveBeenCalled();
  });

  it("rejects a reversed range", async () => {
    const response = await GET(request("?from=2026-03-31&to=2026-03-01"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_range" });
    expect(commissionService.staffCommissionReport).not.toHaveBeenCalled();
  });

  it("passes a valid range to the business-level commission screen", async () => {
    const response = await GET(request("?from=2026-03-01&to=2026-03-31"));
    expect(response.status).toBe(200);
    expect(commissionService.staffCommissionReport).toHaveBeenCalledWith(SESSION.businessId, {
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.commissionView);
  });
});
