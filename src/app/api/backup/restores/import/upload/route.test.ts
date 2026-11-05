import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  profile: vi.fn(),
  chunk: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("@/lib/restore-upload-route", () => ({
  handleRestoreChunk: mocks.chunk,
  handleRestoreDiscard: mocks.discard,
}));

import { DELETE, POST } from "./route";

const session = { businessId: "business-a", sub: "user-a", mfaVerified: true, recentAuthAt: 1_800_000_000 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.chunk.mockResolvedValue(NextResponse.json({ ok: true, size: 10 }));
  mocks.discard.mockResolvedValue(NextResponse.json({ ok: true }));
});

it("requires the restore capability for both directions", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await POST(new NextRequest("http://app/x", { method: "POST" }))).status).toBe(403);
  expect((await DELETE(new NextRequest("http://app/x", { method: "DELETE" }))).status).toBe(403);
  expect(mocks.chunk).not.toHaveBeenCalled();
  expect(mocks.discard).not.toHaveBeenCalled();
});

it("refuses a Local install, whose restores use the physical path", async () => {
  mocks.profile.mockResolvedValue({ profile: "local" });
  const response = await POST(new NextRequest("http://app/x", { method: "POST" }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "recovery_import_unavailable" });
  expect(mocks.chunk).not.toHaveBeenCalled();
});

it("stages bytes in this business's own import scope", async () => {
  const request = new NextRequest("http://app/x?id=abc&offset=0", { method: "POST" });
  await POST(request);
  expect(mocks.chunk).toHaveBeenCalledWith(request, "import-business-a");
});

it("discards only from this business's import scope", async () => {
  const request = new NextRequest("http://app/x?id=abc", { method: "DELETE" });
  await DELETE(request);
  expect(mocks.discard).toHaveBeenCalledWith(request, "import-business-a");
});
