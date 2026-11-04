import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  audit: vi.fn(),
  run: vi.fn(),
  catchUp: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/platform-tenant-backup-ops", () => ({
  runBusinessBackup: mocks.run,
  catchUpBusinessUploads: mocks.catchUp,
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "business-a" }) };

function request(body?: unknown) {
  return new NextRequest("http://app/api/platform/businesses/business-a/backups/run", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.permission.mockResolvedValue({ session: { padmin: "admin" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.run.mockResolvedValue({
    ok: true,
    local: { status: "ok", runId: "run-1", sizeBytes: 10, mode: "logical" },
    cloud: { status: "ok" },
  });
  mocks.catchUp.mockResolvedValue({ attempted: 1, uploaded: 1, failed: 0, remaining: 0 });
});

it("requires the engineer capability, not the metadata one", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await POST(request({ action: "run" }), context)).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.verify");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("answers 404 for a business that does not exist, without running anything", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await POST(request({ action: "run" }), context)).status).toBe(404);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("runs through the shipped pipeline and audits the outcome", async () => {
  const response = await POST(request(), context);
  const body = await response.json();
  expect(mocks.run).toHaveBeenCalledWith("business-a");
  expect(body).toMatchObject({ ok: true, local: { runId: "run-1" }, cloud: { status: "ok" } });
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: "business-a", adminId: "admin", action: "tenant_backup.run" }),
  );
});

it("drains the upload queue for a catch-up request", async () => {
  const response = await POST(request({ action: "catch_up" }), context);
  await expect(response.json()).resolves.toMatchObject({ ok: true, attempted: 1, uploaded: 1 });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant_backup.catch_up" }),
  );
});

it("refuses an unknown action instead of guessing", async () => {
  const response = await POST(request({ action: "delete_everything" }), context);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "unknown_action" });
});

it("reports a failed run as 502 with a code, never the raw error", async () => {
  mocks.run.mockResolvedValue({ ok: false, error: "backup_run_failed" });
  const response = await POST(request({ action: "run" }), context);
  expect(response.status).toBe(502);
  await expect(response.json()).resolves.toEqual({ error: "backup_run_failed" });
});
