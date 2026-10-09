/**
 * The dimension-reports route's HTTP contract (issue #868).
 *
 * Two rules matter here. A report never falls back to «all time» or to «all
 * kinds»: a malformed or missing scope is a 400 that names the parameter. And a
 * card is only ever one account's lines for one value, so a card without either
 * is refused rather than widened. The SQL is covered by
 * integration/accounting-dimension-reports.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as dimensionReports from "@/lib/accounting-dimension-reports-service";
import * as statements from "@/lib/reports-service";
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

vi.mock("@/lib/accounting-dimension-reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accounting-dimension-reports-service")>();
  return {
    ...actual,
    getAccountDimensionMatrix: vi.fn(async () => ({ columns: [], rows: [], columnTotals: {}, grandTotal: 0, reconciled: true })),
    getProfitAndLossByDimension: vi.fn(async () => ({ groups: [], total: {}, reconciled: true })),
  };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return { ...actual, getAccountStatement: vi.fn(async () => null) };
});

const SESSION = { businessId: "business-1" };
const CC = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

function request(qs: string): NextRequest {
  return { nextUrl: new URL(`http://localhost:3000/api/ledger/dimension-reports${qs}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/ledger/dimension-reports — the gate", () => {
  it("reads on ledger.view, the door the journal and the trial balance use", async () => {
    await GET(request("?view=matrix&kind=cost_center&dateFrom=2026-10-01&dateTo=2026-10-31"));
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
  });

  it("returns the refusal from the gate unchanged", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await GET(request("?view=matrix&kind=cost_center&dateFrom=2026-10-01&dateTo=2026-10-31"));
    expect(response.status).toBe(403);
    expect(dimensionReports.getAccountDimensionMatrix).not.toHaveBeenCalled();
  });
});

describe("GET /api/ledger/dimension-reports — the scope", () => {
  it("refuses a missing or backwards period rather than reporting all time", async () => {
    expect((await GET(request("?view=matrix&kind=cost_center"))).status).toBe(400);
    expect((await GET(request("?view=matrix&kind=cost_center&dateFrom=2026-10-31&dateTo=2026-10-01"))).status).toBe(400);
    expect(dimensionReports.getAccountDimensionMatrix).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind rather than reporting every kind", async () => {
    const response = await GET(request("?view=profit&kind=project&dateFrom=2026-10-01&dateTo=2026-10-31"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "unknown_dimension_kind" });
  });

  it("refuses an account type outside the five the matrix offers", async () => {
    const response = await GET(
      request("?view=matrix&kind=cost_center&dateFrom=2026-10-01&dateTo=2026-10-31&accountType=everything"),
    );
    expect(response.status).toBe(400);
    expect(dimensionReports.getAccountDimensionMatrix).not.toHaveBeenCalled();
  });

  it("passes a valid matrix scope straight through, including the account type", async () => {
    const response = await GET(
      request("?view=matrix&kind=cost_center&dateFrom=2026-10-01&dateTo=2026-10-31&accountType=expense"),
    );
    expect(response.status).toBe(200);
    expect(dimensionReports.getAccountDimensionMatrix).toHaveBeenCalledWith("business-1", {
      kind: "cost_center",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      accountType: "expense",
    });
  });

  it("answers an unknown view with a 400, never a default report", async () => {
    const response = await GET(request("?view=everything&kind=cost_center&dateFrom=2026-10-01&dateTo=2026-10-31"));
    expect(response.status).toBe(400);
  });
});

describe("GET /api/ledger/dimension-reports — the card", () => {
  it("refuses a card without an account, rather than widening it to every account", async () => {
    const response = await GET(
      request(`?view=card&kind=cost_center&value=${CC}&dateFrom=2026-10-01&dateTo=2026-10-31`),
    );
    expect(response.status).toBe(400);
    expect(statements.getAccountStatement).not.toHaveBeenCalled();
  });

  it("refuses a card without a value, rather than widening it to every centre", async () => {
    const response = await GET(
      request(`?view=card&kind=cost_center&accountId=${ACCOUNT}&dateFrom=2026-10-01&dateTo=2026-10-31`),
    );
    expect(response.status).toBe(400);
  });

  it("answers an account that is not this business's with a 404", async () => {
    const response = await GET(
      request(`?view=card&kind=cost_center&accountId=${ACCOUNT}&value=unassigned&dateFrom=2026-10-01&dateTo=2026-10-31`),
    );
    expect(response.status).toBe(404);
  });
});
