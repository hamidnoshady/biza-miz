import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const UPLOAD_ID = "0b6f3d9b-8bfa-4f7e-9b93-6a1d3c2f4a10";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  profile: vi.fn(),
  import: vi.fn(),
  discard: vi.fn(),
  uploadPath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/restore-upload", () => ({
  isRestoreUploadId: (value: unknown) =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  readRestoreUploadPath: mocks.uploadPath,
  discardRestoreUpload: mocks.discard,
}));
vi.mock("@/lib/tenant-backup-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant-backup-import")>();
  return {
    // The real pure policy — the route must not be the place a rule is decided.
    recoveryImportAvailable: actual.recoveryImportAvailable,
    mapImportError: actual.mapImportError,
    importRecoveryFile: mocks.import,
  };
});

import { POST } from "./route";

const session = { businessId: "business-a", sub: "user-a", mfaVerified: true, recentAuthAt: 1_800_000_000 };

function request(body: unknown, raw = false) {
  return new NextRequest("http://app/api/backup/restores/import", {
    method: "POST",
    body: raw ? String(body) : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.uploadPath.mockResolvedValue("/tmp/pos-restore-uploads/import-business-a/file.part");
  mocks.discard.mockResolvedValue(undefined);
  mocks.import.mockResolvedValue({ ok: true, ref: "ref-1", capturedAt: "2026-10-27T03:30:00.000Z", payloadBytes: 99 });
});

it("requires the destructive-restore capability", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  const response = await POST(request({ uploadId: UPLOAD_ID, manifest: "{}" }));
  expect(response.status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.restore");
  expect(mocks.import).not.toHaveBeenCalled();
});

it("refuses a Local install: its restores are the single-business physical path", async () => {
  mocks.profile.mockResolvedValue({ profile: "local" });
  const response = await POST(request({ uploadId: UPLOAD_ID, manifest: "{}" }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "recovery_import_unavailable" });
  expect(mocks.import).not.toHaveBeenCalled();
});

it("rejects a missing upload id or manifest without touching the service", async () => {
  expect((await POST(request({}, true))).status).toBe(400);
  expect((await POST(request({ manifest: "{}" }))).status).toBe(400);
  expect((await POST(request({ uploadId: "not-a-uuid", manifest: "{}" }))).status).toBe(400);
  expect((await POST(request({ uploadId: UPLOAD_ID }))).status).toBe(400);
  expect((await POST(request({ uploadId: UPLOAD_ID, manifest: "x".repeat(300 * 1024) }))).status).toBe(400);
  expect(mocks.import).not.toHaveBeenCalled();
});

it("imports for the session's business, never one named in the body", async () => {
  const response = await POST(
    request({ uploadId: UPLOAD_ID, manifest: "{}", businessId: "business-b", passphrase: "p".repeat(600) }),
  );
  expect(response.status).toBe(201);
  expect(mocks.import).toHaveBeenCalledWith(
    expect.objectContaining({
      businessId: "business-a",
      manifestText: "{}",
      uploadPath: "/tmp/pos-restore-uploads/import-business-a/file.part",
      // The one-time legacy passphrase is bounded, and it is the only secret the
      // body may carry.
      legacyPassphrase: expect.stringMatching(/^p{512}$/),
      createdBy: "user-a",
    }),
  );
  // Staged bytes never outlive the import.
  expect(mocks.discard).toHaveBeenCalledWith("import-business-a", UPLOAD_ID);
  expect(await response.json()).toEqual(expect.objectContaining({ ref: "ref-1" }));
});

it("reports a refusal as its code and a status, never as internal text", async () => {
  mocks.import.mockResolvedValue({ ok: false, error: "recovery_checksum_mismatch" });
  const response = await POST(request({ uploadId: UPLOAD_ID, manifest: "{}" }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: "recovery_checksum_mismatch" });
  expect(mocks.discard).toHaveBeenCalled();

  mocks.import.mockResolvedValue({ ok: false, error: "ENOENT: /var/lib/private/path" });
  const unknown = await POST(request({ uploadId: UPLOAD_ID, manifest: "{}" }));
  expect(await unknown.json()).toEqual({ error: "recovery_import_failed" });
});

it("refuses another business's file with 403", async () => {
  mocks.import.mockResolvedValue({ ok: false, error: "recovery_file_not_owned_by_business" });
  const response = await POST(request({ uploadId: UPLOAD_ID, manifest: "{}" }));
  expect(response.status).toBe(403);
});
