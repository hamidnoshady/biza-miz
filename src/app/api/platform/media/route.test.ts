import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEDIA_CONFIG, type MediaStorageConfig } from "@/lib/media";

vi.mock("@/lib/platform-auth", () => ({
  withPlatformScope: <T>(fn: T) => fn,
  requirePlatformAdmin: vi.fn(),
  requirePlatformCapability: vi.fn(),
  platformAudit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  query: vi.fn(),
}));

vi.mock("@/lib/media-service", () => ({
  countAllStoredMediaAssets: vi.fn(),
  getMediaConfig: vi.fn(),
  listMediaMigrationAudits: vi.fn(),
  listMediaOrphanScans: vi.fn(),
  migrateMediaStorage: vi.fn(),
  recordMediaMigrationAudit: vi.fn(),
  rollbackMediaStorage: vi.fn(),
  runMediaOrphanReconcileScan: vi.fn(),
  saveMediaConfig: vi.fn(),
}));

import { GET, POST, PUT } from "./route";
import * as platformAuth from "@/lib/platform-auth";
import * as db from "@/lib/db";
import * as mediaService from "@/lib/media-service";

const ADMIN = { padmin: 1, email: "root@bizamiz.test", role: "super_admin" as const };

function storedConfig(over: Partial<MediaStorageConfig> = {}): MediaStorageConfig {
  return {
    ...DEFAULT_MEDIA_CONFIG,
    enabled: true,
    endpoint: "https://s3.primary.example.com",
    region: "ir-thr-at1",
    bucket: "media-primary",
    keyPrefix: "media",
    accessKeyId: "AKIA_OLD",
    secretAccessKey: "SECRET_OLD",
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(platformAuth.requirePlatformAdmin).mockResolvedValue({ session: ADMIN as never, error: null });
  vi.mocked(platformAuth.requirePlatformCapability).mockResolvedValue({ session: ADMIN as never, error: null });
  vi.mocked(platformAuth.platformAudit).mockResolvedValue(undefined as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [{ businesses: "2", assets: "15", bytes: "204800" }] } as never);
  vi.mocked(mediaService.listMediaMigrationAudits).mockResolvedValue([]);
  vi.mocked(mediaService.listMediaOrphanScans).mockResolvedValue([]);
});

describe("Superadmin media control plane — safe migration & orphan reconcile (P1 #5, P1 #7)", () => {
  it("GET /api/platform/media returns masked config (never exposing secret), migration status, and orphan scan history", async () => {
    vi.mocked(mediaService.getMediaConfig).mockResolvedValueOnce(storedConfig());

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.secretAccessKeySet).toBe(true);
    expect(body.config.secretAccessKey).toBeUndefined();
    expect(body.usage).toEqual({ businesses: 2, assets: 15, bytes: 204800 });
  });

  it("P1 #5: blocks direct PUT overwrite of bucket/endpoint/keyPrefix with 409 storage_migration_required when assets exist", async () => {
    vi.mocked(mediaService.getMediaConfig).mockResolvedValueOnce(storedConfig());
    vi.mocked(mediaService.countAllStoredMediaAssets).mockResolvedValueOnce({
      totalAssets: 15,
      activeAssets: 12,
      trashedAssets: 3,
      totalBytes: 204800,
    });

    const res = await PUT(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          endpoint: "https://s3.primary.example.com",
          region: "ir-thr-at1",
          bucket: "brand-new-empty-bucket",
          keyPrefix: "media",
          accessKeyId: "AKIA_OLD",
        }),
      }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("storage_migration_required");
    expect(body.changedFields).toEqual(["bucket"]);
    expect(mediaService.saveMediaConfig).not.toHaveBeenCalled();
    expect(mediaService.recordMediaMigrationAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "location_change_blocked", status: "blocked" }),
    );
  });

  it("P1 #5: allows rotating credentials & AI model on PUT when bucket/endpoint/keyPrefix are unchanged", async () => {
    vi.mocked(mediaService.getMediaConfig).mockResolvedValueOnce(storedConfig());

    const res = await PUT(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          endpoint: "https://s3.primary.example.com",
          region: "ir-thr-at1",
          bucket: "media-primary",
          keyPrefix: "media",
          accessKeyId: "AKIA_ROTATED",
          secretAccessKey: "SECRET_ROTATED",
          enhanceModel: "flux-pro",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(mediaService.saveMediaConfig).toHaveBeenCalledTimes(1);
  });

  it("P1 #5: runs verified migration & rollback via POST /api/platform/media", async () => {
    vi.mocked(mediaService.getMediaConfig)
      .mockResolvedValueOnce(storedConfig())
      .mockResolvedValueOnce(storedConfig({ bucket: "media-migrated" }));
    vi.mocked(mediaService.migrateMediaStorage).mockResolvedValueOnce({
      ok: true,
      totalAssets: 15,
      copiedAssets: 15,
      verifiedAssets: 15,
      totalBytes: 204800,
    });

    const migrated = await POST(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "migrate",
          endpoint: "https://s3.primary.example.com",
          region: "ir-thr-at1",
          bucket: "media-migrated",
          keyPrefix: "media",
          accessKeyId: "AKIA_OLD",
        }),
      }),
    );
    expect(migrated.status).toBe(200);
    expect((await migrated.json()).verifiedAssets).toBe(15);

    vi.mocked(mediaService.rollbackMediaStorage).mockResolvedValueOnce({ ok: true, verifiedAssets: 15 });
    vi.mocked(mediaService.getMediaConfig).mockResolvedValueOnce(storedConfig());

    const rolledBack = await POST(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "rollback" }),
      }),
    );
    expect(rolledBack.status).toBe(200);
  });

  it("P1 #7: enforces explicit backupConfirmed=true before destructive orphan cleanup", async () => {
    const blocked = await POST(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reconcile", apply: true, backupConfirmed: false }),
      }),
    );
    expect(blocked.status).toBe(400);
    expect((await blocked.json()).error).toBe("backup_confirmation_required");
    expect(mediaService.runMediaOrphanReconcileScan).not.toHaveBeenCalled();

    vi.mocked(mediaService.runMediaOrphanReconcileScan).mockResolvedValueOnce({
      id: "scan-1",
      mode: "manual_scan",
      status: "ok",
      scannedObjects: 20,
      dbKeysCount: 20,
      orphanCount: 0,
      orphanBytes: 0,
      youngSkipped: 0,
      prefixSkipped: 0,
      deletedCount: 0,
      oldestOrphanAt: null,
      sampleKeys: [],
      actorEmail: null,
      backupConfirmed: false,
      errorDetail: null,
      createdAt: "2026-10-20T00:00:00.000Z",
    });

    const scanRes = await POST(
      new NextRequest("http://localhost:3000/api/platform/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reconcile", apply: false }),
      }),
    );
    expect(scanRes.status).toBe(200);
    expect(mediaService.runMediaOrphanReconcileScan).toHaveBeenCalledWith(
      expect.objectContaining({ apply: false, mode: "manual_scan" }),
    );
  });
});
