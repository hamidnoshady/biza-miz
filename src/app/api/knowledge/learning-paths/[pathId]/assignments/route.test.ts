/**
 * Issue #972, item 9 — staff assignments for learning paths. These tests pin
 * the assignment boundary: only `team.manage` can assign, an unknown/ineligible
 * path is 404, and the assignment count is returned.
 *
 * Only the service boundary is mocked; the route and permission checks run
 * for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  learningPathById: vi.fn(),
  learningPathViewerFor: vi.fn(),
  pathsForViewer: vi.fn(),
  assignLearningPathToStaff: vi.fn(),
  listLearningPathAssignments: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-paths-service", () => ({
  learningPathViewerFor: mocks.learningPathViewerFor,
  assignLearningPathToStaff: mocks.assignLearningPathToStaff,
  listLearningPathAssignments: mocks.listLearningPathAssignments,
}));

vi.mock("@/lib/learning-paths", () => ({
  learningPathById: mocks.learningPathById,
  pathsForViewer: mocks.pathsForViewer,
}));

import { POST as assign, GET as list } from "./route";

const PATH = "accounting.onboarding";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };

const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://biz.example.test${url}`, init);
const ctx = (pathId: string) => ({ params: Promise.resolve({ pathId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue(member([PERMISSIONS.teamManage]));
  mocks.learningPathById.mockResolvedValue({
    id: PATH,
    title: "Accounting onboarding",
    version: 1,
    industry: "café",
    steps: [],
  });
  mocks.pathsForViewer.mockReturnValue([
    { id: PATH, title: "Accounting onboarding", version: 1, industry: "café", steps: [] },
  ]);
  mocks.learningPathViewerFor.mockResolvedValue({
    permissions: new Set([PERMISSIONS.teamManage]),
    industry: "café",
  });
  mocks.assignLearningPathToStaff.mockResolvedValue(true);
  mocks.listLearningPathAssignments.mockResolvedValue([
    { userId: "user-2", fullName: "Alice", assignedAt: "2026-01-01T00:00:00.000Z" },
  ]);
});

describe("POST /api/knowledge/learning-paths/[pathId]/assignments", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await assign(
      req(`/api/knowledge/learning-paths/${PATH}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(PATH),
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown path", async () => {
    mocks.learningPathById.mockReturnValue(null);
    const res = await assign(
      req(`/api/knowledge/learning-paths/${PATH}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(PATH),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a missing userId", async () => {
    const res = await assign(
      req(`/api/knowledge/learning-paths/${PATH}/assignments`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
      ctx(PATH),
    );
    expect(res.status).toBe(400);
  });

  it("assigns the path and returns created=true", async () => {
    const res = await assign(
      req(`/api/knowledge/learning-paths/${PATH}/assignments`, {
        method: "POST",
        body: JSON.stringify({ userId: "user-2" }),
      }),
      ctx(PATH),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ created: true });
    expect(mocks.assignLearningPathToStaff).toHaveBeenCalledWith("biz-1", PATH, "user-2", "user-1");
  });
});

describe("GET /api/knowledge/learning-paths/[pathId]/assignments", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await list(req(`/api/knowledge/learning-paths/${PATH}/assignments`), ctx(PATH));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown path", async () => {
    mocks.learningPathById.mockReturnValue(null);
    const res = await list(req(`/api/knowledge/learning-paths/${PATH}/assignments`), ctx(PATH));
    expect(res.status).toBe(404);
  });

  it("lists assigned staff", async () => {
    const res = await list(req(`/api/knowledge/learning-paths/${PATH}/assignments`), ctx(PATH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0]).toEqual({
      userId: "user-2",
      fullName: "Alice",
      assignedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
