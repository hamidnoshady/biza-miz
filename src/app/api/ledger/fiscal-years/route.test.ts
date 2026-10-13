import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as fiscalService from "@/lib/fiscal-periods-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    requireRole: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/fiscal-periods-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fiscal-periods-service")>();
  return { ...actual, createFiscalYear: vi.fn(), listFiscalYears: vi.fn() };
});

const SESSION = { businessId: "business-1", sub: "user-1" };

function requestWith(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("POST /api/ledger/fiscal-years", () => {
  it("accepts a supported JSON number and returns the created fiscal year", async () => {
    const fiscalYear = {
      id: "year-1",
      label: "1405",
      startsOn: "2026-03-21",
      endsOn: "2027-03-20",
      closedAt: null,
    };
    vi.mocked(fiscalService.createFiscalYear).mockResolvedValue(fiscalYear);

    const response = await POST(requestWith({ year: 1405 }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ fiscalYear });
    expect(fiscalService.createFiscalYear).toHaveBeenCalledWith(SESSION.businessId, 1405, SESSION.sub);
  });

  it.each([null, "1405", true, 1299, 1501, 1405.5])(
    "rejects malformed fiscal year input %j without coercing it",
    async (year) => {
      const response = await POST(requestWith({ year }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_year" });
      expect(fiscalService.createFiscalYear).not.toHaveBeenCalled();
    },
  );

  it("passes an expected creation conflict to the client", async () => {
    vi.mocked(fiscalService.createFiscalYear).mockRejectedValue(
      new fiscalService.FiscalPeriodError("fiscal_year_exists", 409),
    );

    const response = await POST(requestWith({ year: 1405 }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "fiscal_year_exists" });
  });

  it("keeps the close-period permission gate ahead of request validation", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    expect(await POST(requestWith({ year: 1405 }))).toBe(denied);
    expect(fiscalService.createFiscalYear).not.toHaveBeenCalled();
  });
});
