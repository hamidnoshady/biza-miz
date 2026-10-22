import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { updateWebsiteSyncSettings } from "@/lib/website/connection-service";
import { PATCH } from "./route";

vi.mock("@/lib/auth", () => ({ withTenantScope: (handler: unknown) => handler, requirePermission: vi.fn() }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/website/connection-service", () => ({ updateWebsiteSyncSettings: vi.fn() }));
const session = { sub: "manager", businessId: "tenant-a" };
const request = (body: unknown) => new NextRequest("https://biza.example/api/connections/website/settings", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(resolveActiveLocation).mockResolvedValue({ id: "a1" } as never);
  vi.mocked(updateWebsiteSyncSettings).mockResolvedValue({ syncLocationId: null } as never);
});

it("preserves the explicit null clear operation even without an active branch", async () => {
  vi.mocked(resolveActiveLocation).mockResolvedValue(null);
  const response = await PATCH(request({ syncLocationId: null }));
  expect(response.status).toBe(200);
  expect(requirePermission).toHaveBeenCalledWith(PERMISSIONS.cmsConfigure);
  expect(resolveActiveLocation).not.toHaveBeenCalled();
  expect(updateWebsiteSyncSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ syncLocationId: null }));
});

it("leaves the stored location alone when the field is omitted", async () => {
  expect((await PATCH(request({ pushStock: false }))).status).toBe(200);
  expect(resolveActiveLocation).not.toHaveBeenCalled();
  expect(updateWebsiteSyncSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ pushStock: false, syncLocationId: undefined }));
});

it("permits a non-null assignment only to the active authorized branch", async () => {
  expect((await PATCH(request({ syncLocationId: "a1" }))).status).toBe(200);
  expect(resolveActiveLocation).toHaveBeenCalledWith(session);
  expect(updateWebsiteSyncSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ syncLocationId: "a1" }));
});

it.each(["a2", "tenant-b-branch", "", 123])("rejects a non-active or invalid assignment %s without mutation", async (syncLocationId) => {
  const response = await PATCH(request({ syncLocationId }));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "location_mismatch" });
  expect(updateWebsiteSyncSettings).not.toHaveBeenCalled();
});

it("denies a non-null assignment if no active branch is authorized", async () => {
  vi.mocked(resolveActiveLocation).mockResolvedValue(null);
  expect((await PATCH(request({ syncLocationId: "a1" }))).status).toBe(403);
  expect(updateWebsiteSyncSettings).not.toHaveBeenCalled();
});

it("does not let the null clear operation bypass CMS configuration permission", async () => {
  vi.mocked(requirePermission).mockResolvedValue({ session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }) } as never);
  expect((await PATCH(request({ syncLocationId: null }))).status).toBe(403);
  expect(resolveActiveLocation).not.toHaveBeenCalled();
  expect(updateWebsiteSyncSettings).not.toHaveBeenCalled();
});

it("reports a missing CMS connection rather than falsely reporting a cleared setting", async () => {
  vi.mocked(updateWebsiteSyncSettings).mockResolvedValue(null);
  const response = await PATCH(request({ syncLocationId: null }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "not_connected" });
});
