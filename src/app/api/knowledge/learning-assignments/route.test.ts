/**
 * Issue #972, Phase E — the staff learning report route.
 *
 * Only the database reads are mocked; the progress/derivation rules run for
 * real. The guard is `team.manage`, and the report joins only the member's
 * name and learning state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  pathAssignments: vi.fn(),
  tourAssignments: vi.fn(),
  pathProgress: vi.fn(),
  tourProgress: vi.fn(),
  published: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-paths-service", () => ({
  listAllLearningPathAssignments: mocks.pathAssignments,
  loadLearningPathProgressForBusiness: mocks.pathProgress,
}));

vi.mock("@/lib/tours-service", () => ({
  listAllTourAssignments: mocks.tourAssignments,
  loadTourProgressForBusiness: mocks.tourProgress,
}));

vi.mock("@/lib/tour-studio-service", () => ({
  publishedTours: mocks.published,
}));

import { GET } from "./route";

const guard = {
  session: { businessId: "biz-1", sub: "manager-1" },
  membership: { permissions: new Set([PERMISSIONS.teamManage]) },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(guard);
  mocks.pathAssignments.mockResolvedValue([]);
  mocks.tourAssignments.mockResolvedValue([]);
  mocks.pathProgress.mockResolvedValue(new Map());
  mocks.tourProgress.mockResolvedValue(new Map());
  mocks.published.mockResolvedValue([]);
});

describe("GET /api/knowledge/learning-assignments", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue({
      session: null,
      error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith(PERMISSIONS.teamManage);
    expect(mocks.pathAssignments).not.toHaveBeenCalled();
  });

  it("reports a not-started path assignment with the member's name", async () => {
    mocks.pathAssignments.mockResolvedValue([
      {
        pathId: "cafe.first-day",
        userId: "user-2",
        fullName: "Sara",
        assignedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    const response = await GET();
    const body = await response.json();
    expect(body.paths[0]).toMatchObject({
      pathId: "cafe.first-day",
      title: "اولین روز در کافه",
      fullName: "Sara",
      state: "not_started",
      percent: 0,
    });
    expect(body.counts).toMatchObject({ paths: 1, tours: 0, incomplete: 1, completed: 0 });
  });

  it("reports a completed tour assignment from the member's own progress", async () => {
    mocks.tourAssignments.mockResolvedValue([
      {
        tourId: "accounting.products.list",
        userId: "user-2",
        fullName: "Sara",
        assignedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    mocks.tourProgress.mockResolvedValue(
      new Map([
        [
          "user-2",
          new Map([
            [
              "accounting.products.list",
              {
                tourId: "accounting.products.list",
                tourVersion: 1,
                seenStepIds: ["welcome", "kpis", "search-filters", "table", "export"],
                currentStepId: null,
                startedAt: "2026-11-01T10:00:00.000Z",
                lastActiveAt: "2026-11-02T10:00:00.000Z",
                completedAt: "2026-11-02T10:00:00.000Z",
              },
            ],
          ]),
        ],
      ]),
    );
    const response = await GET();
    const body = await response.json();
    expect(body.tours[0]).toMatchObject({
      tourId: "accounting.products.list",
      state: "completed",
      percent: 100,
    });
    expect(body.counts).toMatchObject({ tours: 1, completed: 1, incomplete: 0 });
  });

  it("marks an assignment whose definition no longer exists as unavailable", async () => {
    mocks.tourAssignments.mockResolvedValue([
      {
        tourId: "gone.tour",
        userId: "user-2",
        fullName: "Sara",
        assignedAt: "2026-11-01T10:00:00.000Z",
      },
    ]);
    const response = await GET();
    const body = await response.json();
    expect(body.tours[0]).toMatchObject({ state: "unavailable", percent: 0 });
  });
});
