/**
 * Issue #972, item 9 — unassigning a learning path from a staff member.
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
  unassignLearningPathFromStaff: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: mocks.requirePermission,
  withTenantScope: <A extends unknown[]>(handler: (...args: A) => unknown) => handler,
}));

vi.mock("@/lib/learning-paths-service", () => ({
  learningPathViewerFor: mocks.learningPathViewerFor,
  unassignLearningPathFromStaff: mocks.unassignLearningPathFromStaff,
}));

vi.mock("@/lib/learning-paths", () => ({
  learningPathById: mocks.learningPathById,
  pathsForViewer: mocks.pathsForViewer,
}));

import { DELETE } from "./route";

const PATH = "accounting.onboarding";
const USER = "user-2";

function member(permissions: string[]) {
  return {
    session: { businessId: "biz-1", sub: "user-1" },
    membership: { permissions: new Set(permissions) },
    error: null,
  };
}
const DENIED = { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };

const req = (url: string) => new NextRequest(`https://biz.example.test${url}`, { method: "DELETE" });
const ctx = (pathId: string, userId: string) => ({ params: Promise.resolve({ pathId, userId }) });

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
  mocks.unassignLearningPathFromStaff.mockResolvedValue(true);
});

describe("DELETE /api/knowledge/learning-paths/[pathId]/assignments/[userId]", () => {
  it("requires team.manage", async () => {
    mocks.requirePermission.mockResolvedValue(DENIED);
    const res = await DELETE(req(`/api/knowledge/learning-paths/${PATH}/assignments/${USER}`), ctx(PATH, USER));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown path", async () => {
    mocks.learningPathById.mockReturnValue(null);
    const res = await DELETE(req(`/api/knowledge/learning-paths/${PATH}/assignments/${USER}`), ctx(PATH, USER));
    expect(res.status).toBe(404);
  });

  it("unassigns the path and returns removed=true", async () => {
    const res = await DELETE(req(`/api/knowledge/learning-paths/${PATH}/assignments/${USER}`), ctx(PATH, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ removed: true });
    expect(mocks.unassignLearningPathFromStaff).toHaveBeenCalledWith("biz-1", PATH, USER);
  });

  it("returns removed=false when no assignment existed", async () => {
    mocks.unassignLearningPathFromStaff.mockResolvedValue(false);
    const res = await DELETE(req(`/api/knowledge/learning-paths/${PATH}/assignments/${USER}`), ctx(PATH, USER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ removed: false });
  });
});
