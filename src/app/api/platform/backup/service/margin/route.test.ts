/**
 * Issue #903 §3/§8 — the margin report the console finally exposes.
 *
 * What is pinned here is the refusal surface and the honesty of the assumption,
 * because a financial screen is only as trustworthy as the numbers it declines
 * to print: an inverted window is a 400, an unparseable one is a 400, a
 * year-long scan is a 400, a cost that is not whole Rial is a 400, and the cost
 * the caller did not state comes back as zero rather than as a default margin.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  report: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
}));
vi.mock("@/lib/tenant-backup-billing-jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-billing-jobs")>();
  return { ...actual, backupMarginReport: mocks.report };
});

import { GET } from "./route";

function get(query = "") {
  return GET(new NextRequest(`http://app/api/platform/backup/service/margin${query}`));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session: { padmin: "admin-1" } });
  mocks.report.mockResolvedValue({
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
    lines: [],
    totals: { byteDays: 0, revenueRial: 0, costRial: 0, marginRial: 0, marginPercent: null },
    assumptions: { providerCostRialPerGbMonth: 0, priced: true },
  });
});

it("needs the policy capability, not the read one", async () => {
  // A cost figure is commercial: the same trust that sets the storage policy and
  // the supplier cost, not the support desk that may look at protection state.
  mocks.permission.mockResolvedValue({
    error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
  });
  const response = await get();
  expect(response.status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.policy");
  expect(mocks.report).not.toHaveBeenCalled();
});

it("computes the default window when the caller names none", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  const call = mocks.report.mock.calls[0][0] as { from: Date; to: Date; providerCostRialPerGbMonth: number };
  // Thirty days back from "now", not a fixed calendar month: the console opens on
  // a rolling window and the operator narrows it.
  expect(call.to.getTime() - call.from.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  // Nothing was stated, so nothing is assumed.
  expect(call.providerCostRialPerGbMonth).toBe(0);
});

it("passes a stated window and cost through unchanged", async () => {
  const response = await get("?from=2026-10-01&to=2026-10-31&providerCostRialPerGbMonth=1200000");
  expect(response.status).toBe(200);
  const call = mocks.report.mock.calls[0][0] as { from: Date; to: Date; providerCostRialPerGbMonth: number };
  expect(call.from.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  // The 31st is included, so the exclusive bound is the 1st of November.
  expect(call.to.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  expect(call.providerCostRialPerGbMonth).toBe(1_200_000);
});

it("refuses an inverted or unreadable window before touching the meter", async () => {
  for (const query of ["?from=2026-10-31&to=2026-10-01", "?from=yesterday&to=today", "?to=2026-13-45"]) {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_window" });
  }
  expect(mocks.report).not.toHaveBeenCalled();
});

it("refuses a range longer than the report is allowed to scan", async () => {
  const response = await get("?from=2024-01-01&to=2026-01-01");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "window_too_long" });
  expect(mocks.report).not.toHaveBeenCalled();
});

it("refuses a provider cost that is not a non-negative whole number of Rial", async () => {
  for (const cost of ["-1", "1.5", "abc", "9999999999999"]) {
    const response = await get(`?providerCostRialPerGbMonth=${cost}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_provider_cost" });
  }
  expect(mocks.report).not.toHaveBeenCalled();
});

it("returns the report uncached", async () => {
  const response = await get();
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  // The assumption travels with the figures: the screen labels them rather than
  // presenting revenue as profit.
  expect(body.report.assumptions).toEqual({ providerCostRialPerGbMonth: 0, priced: true });
});
