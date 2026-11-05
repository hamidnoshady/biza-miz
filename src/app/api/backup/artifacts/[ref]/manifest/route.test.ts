import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  manifest: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/tenant-backup-import", () => ({ recoveryManifestFor: mocks.manifest }));

import { GET } from "./route";

const session = { businessId: "business-a", sub: "user-a", mfaVerified: true, recentAuthAt: 1_800_000_000 };

function call(ref = "ref-1") {
  return GET(new NextRequest(`http://app/api/backup/artifacts/${ref}/manifest`), {
    params: Promise.resolve({ ref }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.manifest.mockResolvedValue({ ok: true, text: "{}\n", fileName: "ref-1.manifest.json" });
});

it("is Owner-only: it describes the whole business's contents", async () => {
  mocks.permission.mockResolvedValue({ error: NextResponse.json({ error: "forbidden" }, { status: 403 }) });
  expect((await call()).status).toBe(403);
  expect(mocks.permission).toHaveBeenCalledWith("backup.export");
  expect(mocks.manifest).not.toHaveBeenCalled();
});

it("serves the signed manifest as a download this business owns", async () => {
  const response = await call();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="ref-1.manifest.json"');
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("{}\n");
  expect(mocks.manifest).toHaveBeenCalledWith("business-a", "ref-1");
});

it("answers a foreign or stale reference the way the rest of the surface does", async () => {
  mocks.manifest.mockResolvedValue({ ok: false, error: "artifact_not_found" });
  expect((await call("other")).status).toBe(404);

  mocks.manifest.mockResolvedValue({ ok: false, error: "artifact_manifest_missing" });
  expect((await call()).status).toBe(409);
});
