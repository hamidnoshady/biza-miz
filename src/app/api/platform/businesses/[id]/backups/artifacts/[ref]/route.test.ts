import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  audit: vi.fn(),
  profile: vi.fn(),
  role: vi.fn(),
  config: vi.fn(),
  plan: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.role }));
vi.mock("@/lib/backup-service", () => ({ getBackupConfig: mocks.config }));
vi.mock("@/lib/tenant-backup-transport", () => ({ planArtifactDownload: mocks.plan }));
vi.mock("@/lib/platform-tenant-backup-ops", () => ({ deleteBusinessArtifact: mocks.remove }));
vi.mock("node:fs", () => ({ createReadStream: vi.fn(() => "stream") }));

import { DELETE, GET } from "./route";

const context = { params: Promise.resolve({ id: "business-a", ref: "ref-1" }) };
const request = new NextRequest("http://app/api/platform/businesses/business-a/backups/artifacts/ref-1");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.permission.mockResolvedValue({ session: { padmin: "admin" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.profile.mockResolvedValue({ profile: "hybrid" });
  mocks.role.mockReturnValue("site");
  mocks.config.mockResolvedValue({ directory: "/srv/backups" });
  mocks.plan.mockResolvedValue({ kind: "error", error: "artifact_not_found" });
  mocks.remove.mockResolvedValue({ ok: true, state: "expired", deletedBytes: true });
});

it("downloads behind the owner-level capability, not the engineer's", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await GET(request, context)).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.download");
});

it("redirects a cloud artifact to a time-limited URL instead of exposing a key", async () => {
  mocks.plan.mockImplementation(async (input: { destination: string }) =>
    input.destination === "cloud"
      ? { kind: "redirect", url: "https://s3.example/signed", expiresIn: 300 }
      : { kind: "error", error: "artifact_not_found" },
  );
  const response = await GET(request, context);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://s3.example/signed");
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant_backup.artifact.download", businessId: "business-a" }),
  );
});

it("streams a local artifact with no cache and an attachment name", async () => {
  mocks.plan.mockImplementation(async (input: { destination: string }) =>
    input.destination === "local"
      ? { kind: "stream", path: "/srv/backups/a.dump.enc", sizeBytes: 42, encryption: "legacy_passphrase_v1" }
      : { kind: "error", error: "artifact_not_found" },
  );
  const response = await GET(request, context);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-length")).toBe("42");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("deletes behind the policy capability and reports the protected-copy refusal", async () => {
  expect((await DELETE(request, context)).status).toBe(200);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.policy");

  mocks.remove.mockResolvedValue({ ok: false, error: "protected_copies" });
  const refused = await DELETE(request, context);
  expect(refused.status).toBe(409);
  await expect(refused.json()).resolves.toEqual({ error: "protected_copies" });
});

it("does not report a deletion it could not perform", async () => {
  mocks.remove.mockResolvedValue({ ok: false, error: "storage_delete_failed" });
  const response = await DELETE(request, context);
  expect(response.status).toBe(502);
  expect((await response.json()).deletedBytes).toBeUndefined();
});
