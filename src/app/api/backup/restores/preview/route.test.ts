import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  profile: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: () => "central" }));
vi.mock("@/lib/tenant-backup-artifacts-service", () => ({ previewOwnedRestore: mocks.preview }));

import { POST } from "./route";

const session = {
  businessId: "business-a",
  sub: "user-a",
  mfaVerified: true,
  recentAuthAt: 1_800_000_000,
};

function request(body: unknown, raw = false) {
  return new NextRequest("http://app/api/backup/restores/preview", {
    method: "POST",
    body: raw ? String(body) : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.preview.mockResolvedValue({
    preview: { canApply: true, blockers: [], artifactRef: "ref-1" },
    jobId: "job-1",
  });
});

it("requires the destructive-restore capability even to preview", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  const response = await POST(request({ ref: "ref-1" }));
  expect(response.status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.restore");
  expect(mocks.preview).not.toHaveBeenCalled();
});

it("rejects a malformed or oversized reference without touching the service", async () => {
  expect((await POST(request({}, true))).status).toBe(400);
  expect((await POST(request({ ref: "x".repeat(200) }))).status).toBe(400);
  expect((await POST(request({ ref: 42 }))).status).toBe(400);
  expect(mocks.preview).not.toHaveBeenCalled();
});

it("derives actor facts from the session and never from the request body", async () => {
  const response = await POST(request({ ref: "ref-1", mfaSatisfied: false, reauthenticatedAt: null }));
  expect(response.status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith(
    "business-a",
    "ref-1",
    expect.objectContaining({
      role: "central",
      profile: "cloud",
      actor: {
        canRestore: true,
        mfaSatisfied: true,
        reauthenticatedAt: new Date(1_800_000_000 * 1000).toISOString(),
      },
      actorUserId: "user-a",
    }),
  );
  const body = await response.json();
  // An unblocked preview advertises that an apply may be attempted; the apply
  // route itself re-derives every fact and gates on confirmation + re-auth.
  expect(body.applyAvailable).toBe(true);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("reports a session without MFA or recent re-authentication honestly", async () => {
  mocks.permission.mockResolvedValue({ session: { businessId: "business-a", sub: "user-a" } });
  await POST(request({ ref: "ref-1" }));
  expect(mocks.preview).toHaveBeenCalledWith(
    "business-a",
    "ref-1",
    expect.objectContaining({
      actor: { canRestore: true, mfaSatisfied: false, reauthenticatedAt: null },
    }),
  );
});

it("answers 404 for a foreign or unknown artifact reference", async () => {
  mocks.preview.mockResolvedValue({ error: "artifact_not_found" });
  const response = await POST(request({ ref: "someone-elses-ref" }));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "artifact_not_found" });
});
