import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  business: vi.fn(),
  audit: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: (fn: unknown) => fn,
  requirePlatformCapability: mocks.permission,
  platformAudit: mocks.audit,
}));
vi.mock("@/lib/platform-service", () => ({ getBusiness: mocks.business }));
vi.mock("@/lib/platform-tenant-backup-ops", () => ({ verifyBusinessArtifact: mocks.verify }));

import { POST } from "./route";

const context = { params: Promise.resolve({ id: "business-a", ref: "ref-1" }) };
const request = new NextRequest(
  "http://app/api/platform/businesses/business-a/backups/artifacts/ref-1/verify",
  { method: "POST" },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.permission.mockResolvedValue({ session: { padmin: "admin" } });
  mocks.business.mockResolvedValue({ id: "business-a" });
  mocks.verify.mockResolvedValue({ ok: true, state: "ready", tables: 9 });
});

it("requires the verification capability and audits the attempt", async () => {
  expect((await POST(request, context)).status).toBe(200);
  expect(mocks.permission).toHaveBeenCalledWith("tenant_backup.verify");
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "tenant_backup.artifact.verify", businessId: "business-a" }),
  );
});

it("answers 404 for a reference that is not this business's", async () => {
  mocks.verify.mockResolvedValue({ ok: false, error: "artifact_not_found" });
  const response = await POST(request, context);
  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({ error: "artifact_not_found", state: "failed" });
});

it("reports a verification failure as 422, with the code the bytes produced", async () => {
  mocks.verify.mockResolvedValue({ ok: false, error: "artifact_signature_invalid" });
  const response = await POST(request, context);
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toEqual({
    error: "artifact_signature_invalid",
    state: "failed",
  });
});

it("does not verify anything for a business that does not exist", async () => {
  mocks.business.mockResolvedValue(null);
  expect((await POST(request, context)).status).toBe(404);
  expect(mocks.verify).not.toHaveBeenCalled();
});
