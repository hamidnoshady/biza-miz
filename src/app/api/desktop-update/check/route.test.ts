/**
 * Issue #1008 — `POST /api/desktop-update/check`.
 *
 * The settings button must be able to ask Central on demand. This route is the
 * owner-only bridge that performs the exchange in the local backend (which
 * holds the pairing credential) and hands the fresh target back to the
 * renderer. These tests pin the boundary: owner only, credential taken from
 * the session's own config, and reachability reported as data so the screen
 * can tell «offline» from «Central said no update».
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkDesktopUpdateNow: vi.fn(),
  getDesktopUpdatePolicy: vi.fn(),
  getServerSyncConfig: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: mocks.requireRole,
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/app-update", () => ({
  checkDesktopUpdateNow: mocks.checkDesktopUpdateNow,
  getDesktopUpdatePolicy: mocks.getDesktopUpdatePolicy,
}));

vi.mock("@/lib/server-sync", () => ({
  getServerSyncConfig: mocks.getServerSyncConfig,
}));

import { POST } from "./route";

const SESSION = { businessId: "biz-1", sub: "owner-1" };
const CONFIG = { enabled: true, remoteUrl: "https://central.example", token: "POS1-site-token" };
const POLICY = { automaticChecks: true, backgroundDownload: false, automaticInstall: false, channel: "stable" };

const TARGET = {
  version: "1.0.69",
  buildCommit: "b".repeat(40),
  buildId: "production-169",
  channel: "stable" as const,
  releasedAt: "2026-10-17T08:00:00.000Z",
  minimumSupportedVersion: "1.0.0",
  mandatory: false,
  installer: { url: "https://github.com/example/product/update.exe", sha256: "c".repeat(64), size: 4096, signatureRequired: true as const, expectedPublisher: "Business Suite" },
  database: { migrationVersion: 227, minimumSchemaVersion: 1, maximumSchemaVersion: 227, backupRequired: true as const },
  releaseNotes: ["رفع اشکال"],
  recovery: { knownGoodVersion: null, notes: null },
};

const check = (over: Record<string, unknown> = {}) => ({
  status: { checkedAt: "2026-10-18T09:31:00.000Z", targetRelease: TARGET, updateAvailable: true, error: null },
  targetRelease: TARGET,
  checkedAt: "2026-10-18T09:31:00.000Z",
  offline: false,
  error: null,
  outcome: "update_available",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue({ session: SESSION, error: null });
  mocks.getServerSyncConfig.mockResolvedValue(CONFIG);
  mocks.getDesktopUpdatePolicy.mockResolvedValue(POLICY);
  mocks.checkDesktopUpdateNow.mockResolvedValue(check());
});

describe("POST /api/desktop-update/check", () => {
  it("refuses everyone except the owner and never touches Central", async () => {
    mocks.requireRole.mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const response = await POST();

    expect(response.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith("owner");
    expect(mocks.checkDesktopUpdateNow).not.toHaveBeenCalled();
    expect(mocks.getServerSyncConfig).not.toHaveBeenCalled();
  });

  it("runs the exchange with this session's own credential and returns the fresh target", async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    expect(mocks.getServerSyncConfig).toHaveBeenCalledWith("biz-1");
    expect(mocks.checkDesktopUpdateNow).toHaveBeenCalledWith("biz-1", CONFIG);
    const body = await response.json();
    expect(body).toMatchObject({
      outcome: "update_available",
      offline: false,
      error: null,
      targetRelease: { version: "1.0.69" },
      policy: POLICY,
    });
  });

  it("reports an unreachable Central as data, not as a server failure", async () => {
    mocks.checkDesktopUpdateNow.mockResolvedValue(check({
      targetRelease: null,
      offline: true,
      error: "remote_unreachable",
      outcome: "offline",
      status: { checkedAt: "2026-10-18T09:31:00.000Z", targetRelease: null, updateAvailable: false, error: "remote_unreachable" },
    }));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "offline", offline: true, error: "remote_unreachable" });
  });

  it("answers sync_not_configured instead of inventing an up-to-date result", async () => {
    mocks.getServerSyncConfig.mockResolvedValue(null);
    mocks.checkDesktopUpdateNow.mockResolvedValue(check({
      targetRelease: null,
      offline: false,
      error: "sync_not_configured",
      outcome: "error",
    }));

    const response = await POST();

    expect(response.status).toBe(200);
    expect(mocks.checkDesktopUpdateNow).toHaveBeenCalledWith("biz-1", null);
    expect(await response.json()).toMatchObject({ outcome: "error", error: "sync_not_configured" });
  });

  it("returns 500 only for a local failure before Central answered", async () => {
    mocks.checkDesktopUpdateNow.mockRejectedValue(new Error("settings write failed"));

    const response = await POST();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "update_check_failed" });
  });
});
