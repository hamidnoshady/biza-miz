/**
 * Issue #972 — tenant learning analytics: `team.manage` only, aggregate counts,
 * no member rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  analytics: vi.fn(),
  published: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/tours-service", () => ({
  loadTourAnalyticsForBusiness: mocks.analytics,
}));

vi.mock("@/lib/tour-studio-service", () => ({
  publishedTours: mocks.published,
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({
    session: { businessId: "biz-1", sub: "manager-1" },
    membership: { permissions: new Set([PERMISSIONS.teamManage]) },
    error: null,
  });
  mocks.analytics.mockResolvedValue([]);
  mocks.published.mockResolvedValue([]);
});

describe("GET /api/knowledge/learning-analytics", () => {
  it("requires team.manage and never reads before the guard", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.teamManage);
    expect(mocks.analytics).not.toHaveBeenCalled();
  });

  it("returns aggregate counts and the tour title, not member rows", async () => {
    mocks.analytics.mockResolvedValue([
      {
        tourId: "accounting.overview.ledger",
        started: 10,
        completed: 4,
        inProgress: 3,
        abandoned: 3,
        lastActiveAt: "2026-11-18T10:00:00.000Z",
        topStuckStep: { stepId: "filters", count: 2 },
      },
    ]);
    const response = await GET();
    const body = await response.json();
    expect(body.totals).toMatchObject({ started: 10, completed: 4, inProgress: 3, abandoned: 3 });
    expect(body.tours[0]).toMatchObject({
      tourId: "accounting.overview.ledger",
      title: expect.any(String),
      completionPercent: 40,
      topStuckStep: { stepId: "filters", count: 2 },
    });
    expect(JSON.stringify(body)).not.toContain("fullName");
    expect(JSON.stringify(body)).not.toContain("userId");
  });
});
