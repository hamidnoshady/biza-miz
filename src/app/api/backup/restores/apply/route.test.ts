import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  profile: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  query: vi.fn(),
  approvalGate: vi.fn(),
  consume: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/db", () => ({ query: mocks.query }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: () => "central" }));
vi.mock("@/lib/tenant-backup-artifacts-service", () => ({ previewOwnedRestore: mocks.preview }));
vi.mock("@/lib/tenant-backup-approvals", () => ({
  checkRestoreApproval: mocks.approvalGate,
  consumeRestoreApproval: mocks.consume,
}));
vi.mock("@/lib/tenant-restore-apply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-restore-apply")>();
  return { ...actual, applyTenantRestore: mocks.apply };
});

import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://app/api/backup/restores/apply", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({
    session: { businessId: "business-a", sub: "user-a", role: "owner", mfaVerified: true, recentAuthAt: Math.floor(Date.now() / 1000) - 60 },
  });
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.preview.mockResolvedValue({
    preview: { canApply: true, blockers: [], artifactRef: "ref-1", confirmationPhrase: "کافه" },
    jobId: "job-1",
  });
  mocks.apply.mockResolvedValue({
    ok: true,
    journalId: "journal-1",
    tables: 3,
    deleted: 9,
    inserted: 9,
    checkpointFile: "/tmp/checkpoint.json",
    verified: true,
  });
  mocks.query.mockResolvedValue({ rows: [{ id: "job-2" }], rowCount: 1 });
  mocks.approvalGate.mockResolvedValue({ ok: true, approval: null });
  mocks.consume.mockResolvedValue(true);
});

it("requires the Owner's destructive-restore capability", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  const response = await POST(request({ ref: "ref-1", confirmation: "کافه" }));
  expect(response.status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.restore");
  expect(mocks.apply).not.toHaveBeenCalled();
});

it("recomputes the preview instead of trusting the request body", async () => {
  await POST(
    request({
      ref: "ref-1",
      confirmation: "کافه",
      // Facts a client must never be able to assert:
      preview: { canApply: true, blockers: [] },
      minutesSinceReauthentication: 0,
      businessId: "business-b",
    }),
  );
  expect(mocks.preview).toHaveBeenCalledWith("business-a", "ref-1", expect.objectContaining({
    actor: expect.objectContaining({ canRestore: true, mfaSatisfied: true }),
    actorUserId: "user-a",
  }));
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: "business-a", ref: "ref-1", typedConfirmation: "کافه" }),
  );
});

it("derives re-authentication from the session, and reports a stale one as refused", async () => {
  mocks.apply.mockResolvedValue({ ok: false, error: "reauthentication_required", journalId: "journal-1" });
  const response = await POST(request({ ref: "ref-1", confirmation: "کافه" }));
  expect(response.status).toBe(403);
  expect((await response.json()).error).toBe("reauthentication_required");
  expect(mocks.apply).toHaveBeenCalledWith(
    expect.objectContaining({ minutesSinceReauthentication: expect.any(Number) }),
  );
});

it("answers 409 for a busy restore and 404 for an unknown reference", async () => {
  mocks.apply.mockResolvedValue({ ok: false, error: "restore_busy" });
  expect((await POST(request({ ref: "ref-1", confirmation: "کافه" }))).status).toBe(409);

  mocks.preview.mockResolvedValue({ error: "artifact_not_found" });
  expect((await POST(request({ ref: "ref-1", confirmation: "کافه" }))).status).toBe(404);
});

it("returns the journal id on success and never an internal error string", async () => {
  const response = await POST(request({ ref: "ref-1", confirmation: "کافه" }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ ok: true, journalId: "journal-1", tables: 3, verified: true });
  expect(JSON.stringify(body)).not.toContain("checkpoint");
});

it("rejects a malformed or oversized body without touching the engine", async () => {
  expect((await POST(new NextRequest("http://app/api/backup/restores/apply", { method: "POST", body: "not json" }))).status).toBe(400);
  expect((await POST(request({ ref: "", confirmation: "x" }))).status).toBe(400);
  expect((await POST(request({ ref: "x".repeat(200), confirmation: "x" }))).status).toBe(400);
  expect(mocks.apply).not.toHaveBeenCalled();
});

describe("recovery approvals (issue #903 §3)", () => {
  it("refuses before anything is journaled when the business requires consent", async () => {
    mocks.approvalGate.mockResolvedValue({ ok: false, error: "restore_approval_required" });
    const response = await POST(request({ ref: "ref-1", confirmation: "کافه" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "restore_approval_required" });
    // Nothing was applied and no restore job row was written.
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tenant_backup_restore_jobs"),
      expect.anything(),
    );
  });

  it("consumes the approval only after the restore committed", async () => {
    mocks.approvalGate.mockResolvedValue({ ok: true, approval: { id: "approval-1" } });
    await POST(request({ ref: "ref-1", confirmation: "کافه" }));
    expect(mocks.consume).toHaveBeenCalledWith("approval-1", "journal-1");
  });

  it("does not burn consent when the restore failed", async () => {
    mocks.approvalGate.mockResolvedValue({ ok: true, approval: { id: "approval-1" } });
    mocks.apply.mockResolvedValue({ ok: false, error: "restore_busy" });
    expect((await POST(request({ ref: "ref-1", confirmation: "کافه" }))).status).toBe(409);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("does nothing extra when the business has not opted in", async () => {
    await POST(request({ ref: "ref-1", confirmation: "کافه" }));
    expect(mocks.approvalGate).toHaveBeenCalledWith("business-a", "ref-1");
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
