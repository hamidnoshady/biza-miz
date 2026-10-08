/**
 * The trial-balance route's HTTP contract (issue #820).
 *
 * The interesting rule is that **the report has no "all time" default**: a
 * caller must name a period or an as-of date. A forgotten query string used to
 * mean "the entire ledger history", which is a defensible report but never the
 * one the accountant thought they were looking at — so it is a 400 now.
 *
 * Tenant isolation and the real SQL are covered by
 * integration/trial-balance.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as ledgerReports from "@/lib/ledger-reports-service";
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

vi.mock("@/lib/ledger-reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ledger-reports-service")>();
  return { ...actual, getTrialBalance: vi.fn() };
});

const SESSION = { businessId: "business-1" };
const REPORT = {
  businessName: "کافه نمونه",
  mode: "detailed",
  periodFrom: "2026-03-01",
  periodTo: "2026-03-31",
  asOf: null,
  accounts: [],
  totals: {
    openingDebit: "0", openingCredit: "0", periodDebit: "0",
    periodCredit: "0", closingDebit: "0", closingCredit: "0", closingDifference: "0",
  },
  trialBalanceBalanced: false,
  activity: { entryCount: 0, lineCount: 0 },
  integrity: {
    ledgerHealthy: false, entryCount: 0, lineCount: 0,
    unbalancedEntryCount: 0, invalidEntryCount: 0, balanceDifference: "0",
  },
};

function request(qs: string): NextRequest {
  return { nextUrl: new URL(`http://localhost:3000/api/ledger/trial-balance${qs}`) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(ledgerReports.getTrialBalance).mockResolvedValue(REPORT as never);
});

describe("GET /api/ledger/trial-balance", () => {
  it("gates on ledger.view before touching the report", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    expect(await GET(request("?asOf=2026-03-31"))).toBe(denied);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("passes a custom period straight through", async () => {
    const response = await GET(request("?dateFrom=2026-03-01&dateTo=2026-03-31"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(REPORT);
    expect(ledgerReports.getTrialBalance).toHaveBeenCalledWith(SESSION.businessId, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
  });

  it("passes the as-of shortcut through as a closing-only report", async () => {
    await GET(request("?asOf=2026-03-31"));
    expect(ledgerReports.getTrialBalance).toHaveBeenCalledWith(SESSION.businessId, { asOf: "2026-03-31" });
  });

  it("400s on no scope at all, so a missing filter cannot silently mean 'all time'", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_report_scope" });
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it.each([
    "?dateFrom=2026-03-01",
    "?dateTo=2026-03-31",
    "?asOf=2026-13-01",
    "?asOf=2026-02-31",
    "?dateFrom=2026-03-01&dateTo=banana",
    "?asOf=2026-03-31&dateFrom=2026-03-01&dateTo=2026-03-31",
  ])("400s on a malformed or ambiguous scope: %s", async (qs) => {
    const response = await GET(request(qs));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_report_scope" });
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("400s when the period runs backwards", async () => {
    const response = await GET(request("?dateFrom=2026-03-31&dateTo=2026-03-01"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_date_range" });
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("maps the service's own scope refusal to the same 400 rather than a 500", async () => {
    vi.mocked(ledgerReports.getTrialBalance).mockRejectedValue(
      new Error("invalid_trial_balance_scope"),
    );
    const response = await GET(request("?dateFrom=2026-03-01&dateTo=2026-03-31"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_report_scope" });
  });

  it("lets an unexpected failure propagate instead of reporting an empty ledger", async () => {
    vi.mocked(ledgerReports.getTrialBalance).mockRejectedValue(new Error("connection reset"));
    await expect(GET(request("?asOf=2026-03-31"))).rejects.toThrow("connection reset");
  });

  it("keeps every amount a string in the JSON body", async () => {
    const response = await GET(request("?asOf=2026-03-31"));
    const body = await response.json();
    for (const value of Object.values(body.totals)) expect(typeof value).toBe("string");
    expect(typeof body.integrity.balanceDifference).toBe("string");
  });
});
