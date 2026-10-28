import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/tenant-backup-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-transport")>();
  return { ...actual, startUploadSession: mocks.start };
});

import { POST } from "./route";

function request(body: unknown, init: { method?: string; body?: string } = {}): NextRequest {
  return new NextRequest("http://app/api/backup/uploads", {
    method: init.method ?? "POST",
    body: init.body ?? JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({ session: { businessId: "business-a", sub: "user-a" } });
  mocks.start.mockResolvedValue({
    ok: true,
    session: {
      businessId: "business-a",
      token: "a".repeat(32),
      expectedBytes: 1024,
      receivedBytes: 0,
      state: "open",
      sha256: null,
      stagingRef: "upload-x",
      expiresAt: "2026-10-29T00:00:00.000Z",
    },
    chunkBytes: 4 * 1024 * 1024,
  });
});

it("requires the restore capability, not merely backup.manage", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await POST(request({ expectedBytes: 10 }))).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.restore");
  expect(mocks.start).not.toHaveBeenCalled();
});

it("starts a session for this business and returns the chunk size", async () => {
  const response = await POST(request({ expectedBytes: 1024, sha256: "a".repeat(64) }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.token).toHaveLength(32);
  expect(body.chunkBytes).toBe(4 * 1024 * 1024);
  expect(mocks.start).toHaveBeenCalledWith(
    expect.objectContaining({ businessId: "business-a", expectedBytes: 1024, createdBy: "user-a" }),
  );
});

it("passes the service's validation errors through with a 400", async () => {
  mocks.start.mockResolvedValue({ ok: false, error: "upload_too_large" });
  const response = await POST(request({ expectedBytes: 1 }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("upload_too_large");
});

it("rejects a non-JSON body without calling the service", async () => {
  const response = await POST(request(null, { body: "not json" }));
  expect(response.status).toBe(400);
  expect(mocks.start).not.toHaveBeenCalled();
});
