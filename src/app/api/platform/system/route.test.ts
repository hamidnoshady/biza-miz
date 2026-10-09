/**
 * `/api/platform/system` — the health endpoint behind the system dashboard.
 *
 * These tests pin the two things the production incident turned on:
 *
 *   1. **authorization is server-side and unconditional.** An unauthenticated
 *      caller, an inactive/revoked platform admin and a tenant session all get
 *      401 — and the migration status is not even computed for them.
 *   2. **the payload carries the canonical migration status**, so the page can
 *      tell a gated AI secret cutover from an ordinary pending migration, and
 *      carries no credential material.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { GET } from "./route";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { getMigrationStatus } from "@/lib/migration-status-service";
import { systemStatus } from "@/lib/platform-service";

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformAdmin: vi.fn(),
  withPlatformScope: (handler: (request: unknown) => Promise<NextResponse>) => handler,
}));

vi.mock("@/lib/migration-status-service", () => ({
  getMigrationStatus: vi.fn(),
}));

// A faithful stand-in for the real service's migration contract: it echoes the
// status it was handed (and the retained count derived from it), exactly as
// `systemStatus` does, so the assertions exercise the route's plumbing.
vi.mock("@/lib/platform-service", () => ({
  systemStatus: vi.fn(async (migrations: { pendingTotal: number | null }) => ({
    pool: { total: 1, idle: 1, waiting: 0 },
    pendingMigrations: migrations.pendingTotal,
    migrationStatus: migrations,
  })),
}));

vi.mock("@/lib/platform-backup-service", () => ({
  getPlatformBackupHealth: vi.fn(async () => null),
}));

const unauthorized = NextResponse.json({ error: "unauthorized" }, { status: 401 });

/** A status built by the real classifier, so the assertions use production shapes. */
async function realStatus(files: string[], applied: string[], secretsStored: boolean) {
  const actual = await vi.importActual<typeof import("@/lib/migration-status-service")>(
    "@/lib/migration-status-service",
  );
  return actual.buildMigrationStatus({
    files,
    applied: new Map(applied.map((f) => [f, "2026-09-01T00:00:00.000Z"])),
    cutoverDatabase: {
      secretsStored,
      legacyColumnsPresent: secretsStored,
      rowsMissingCiphertext: secretsStored ? 0 : 0,
      legacyPlaintextRows: secretsStored ? 2 : 0,
    },
  });
}

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    session: { padmin: "admin-1", role: "owner" },
    error: null,
  } as never);
  vi.mocked(systemStatus).mockImplementation(
    async (migrations: { pendingTotal: number | null }) =>
      ({
        pool: { total: 1, idle: 1, waiting: 0 },
        pendingMigrations: migrations.pendingTotal,
        migrationStatus: migrations,
      }) as never,
  );
});

describe("GET /api/platform/system authorization", () => {
  it("refuses an unauthenticated caller and computes nothing", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getMigrationStatus).not.toHaveBeenCalled();
    expect(systemStatus).not.toHaveBeenCalled();
  });

  it("refuses a revoked or inactive platform admin", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMigrationStatus).not.toHaveBeenCalled();
  });

  it("refuses a tenant session, which carries no platform admin", async () => {
    // A tenant session has no platform cookie, so the platform guard resolves to
    // `unauthorized` before any platform-scope query runs.
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMigrationStatus).not.toHaveBeenCalled();
  });

  it("serves an authenticated platform admin", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue((await realStatus(["0001_a.sql"], ["0001_a.sql"], false)) as never);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getMigrationStatus).toHaveBeenCalledTimes(1);
    // The route hands the shared status to the service rather than a bare count.
    expect(systemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ available: true, pendingTotal: 0 }),
    );
  });
});

describe("GET /api/platform/system migration reporting", () => {
  it("reports the gated AI gateway secret cutover as gated", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      (await realStatus(
        ["0208_x.sql", "0209_ai_gateway_secret_cutover.sql", "0210_later.sql"],
        ["0208_x.sql"],
        true,
      )) as never,
    );
    const res = await GET();
    const body = await res.json();
    expect(body.status.migrationStatus.gated).toHaveLength(1);
    expect(body.status.migrationStatus.gated[0].filename).toBe("0209_ai_gateway_secret_cutover.sql");
    expect(body.status.migrationStatus.gated[0].reasonCode).toBe(
      "ai_gateway_secret_cutover_awaiting_verification",
    );
    expect(body.status.migrationStatus.ordinaryPending).toHaveLength(1);
    expect(body.status.migrationStatus.pendingTotal).toBe(2);
    // Retained for existing consumers, and never a confident zero.
    expect(body.status.pendingMigrations).toBe(2);
  });

  it("reports an unreadable inventory as unknown rather than zero pending", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      (await realStatus([], [], false)) as never,
    );
    const res = await GET();
    const body = await res.json();
    expect(body.status.migrationStatus.available).toBe(true);
    expect(body.status.pendingMigrations).toBe(0);

    const unavailable = await vi.importActual<typeof import("@/lib/migration-status-service")>(
      "@/lib/migration-status-service",
    );
    vi.mocked(getMigrationStatus).mockResolvedValue(
      unavailable.buildMigrationStatus({
        files: null,
        applied: null,
        cutoverDatabase: {
          secretsStored: null,
          legacyColumnsPresent: null,
          rowsMissingCiphertext: null,
          legacyPlaintextRows: null,
        },
      }) as never,
    );
    const second = await (await GET()).json();
    expect(second.status.migrationStatus.available).toBe(false);
    expect(second.status.pendingMigrations).toBeNull();
    expect(second.status.migrationStatus.reasonCode).toBe("migration_inventory_unreadable");
  });

  it("never returns credential material", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue(
      (await realStatus(["0209_ai_gateway_secret_cutover.sql"], [], true)) as never,
    );
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/enc:v\d+:/);
    // Only redacted counts describe the secret state.
    expect(text).toContain("legacyPlaintextRows");
    expect(text).not.toContain("master_key_ciphertext");
  });
});
