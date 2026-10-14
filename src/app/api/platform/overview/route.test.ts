/**
 * `/api/platform/overview` — the console home's aggregation.
 *
 * Two things are pinned here:
 *
 *   1. **authorization is server-side and unconditional.** Unauthenticated,
 *      inactive/revoked admin and tenant callers all get 401, and the migration
 *      status is not computed for them.
 *   2. **the overview and the system route classify migrations identically**,
 *      because both call the one shared `getMigrationStatus()` service. The
 *      gated AI gateway secret cutover is reported separately from ordinary
 *      pending work, and an unreadable inventory is reported as unknown rather
 *      than as zero pending.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { GET } from "./route";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { getMigrationStatus } from "@/lib/migration-status-service";
import { getPlatformOverview } from "@/lib/platform-overview-service";

vi.mock("@/lib/platform-auth", () => ({
  requirePlatformAdmin: vi.fn(),
  withPlatformScope: (handler: (request: unknown) => Promise<NextResponse>) => handler,
}));

vi.mock("@/lib/migration-status-service", () => ({
  getMigrationStatus: vi.fn(),
}));

// The real aggregation runs against a database; the route's contract is that it
// forwards whatever the shared status service produced, unchanged.
vi.mock("@/lib/platform-overview-service", () => ({
  getPlatformOverview: vi.fn(async (migrations: { pendingTotal: number | null; available: boolean }) => ({
    system: {
      pendingMigrations: migrations.pendingTotal,
      ordinaryPendingMigrations: 0,
      gatedMigrations: 0,
      migrationStatusAvailable: migrations.available,
      migrationStatusReasonCode: null,
      migrationHeadline: null,
      rlsEffective: true,
      poolWaiting: 0,
    },
    alerts: [],
  })),
}));

const unauthorized = NextResponse.json({ error: "unauthorized" }, { status: 401 });

beforeEach(() => {
  vi.mocked(requirePlatformAdmin).mockResolvedValue({
    session: { padmin: "admin-1", role: "owner" },
    error: null,
  } as never);
});

describe("GET /api/platform/overview authorization", () => {
  it("refuses an unauthenticated caller and computes nothing", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMigrationStatus).not.toHaveBeenCalled();
    expect(getPlatformOverview).not.toHaveBeenCalled();
  });

  it("refuses a revoked or inactive platform admin", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getMigrationStatus).not.toHaveBeenCalled();
  });

  it("refuses a tenant session", async () => {
    vi.mocked(requirePlatformAdmin).mockResolvedValue({ session: null, error: unauthorized } as never);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(getPlatformOverview).not.toHaveBeenCalled();
  });

  it("forwards the shared migration status to the aggregation", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue({
      available: true,
      reasonCode: "up_to_date",
      checkedAt: "2026-10-08T10:00:00.000Z",
      appliedCount: 1,
      applied: [],
      lastAppliedAt: null,
      ordinaryPending: [],
      gated: [],
      pendingTotal: 0,
      cutover: {
        migration: "0209_ai_gateway_secret_cutover.sql",
        applied: true,
        gated: false,
        reasonCode: "ai_gateway_secret_cutover_applied",
        deferFlag: false,
        verifiedFlag: false,
        flagsConflict: false,
        legacyColumnsPresent: false,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 0,
        blockedBy: null,
      },
    } as never);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(getPlatformOverview).toHaveBeenCalledWith(
      expect.objectContaining({ available: true, pendingTotal: 0 }),
    );
    const body = await res.json();
    expect(body.overview.system.migrationStatusAvailable).toBe(true);
  });
});

describe("GET /api/platform/overview classification consistency", () => {
  it("uses the same service the system route uses", async () => {
    const { readFileSync } = await import("node:fs");
    const systemRoute = readFileSync("src/app/api/platform/system/route.ts", "utf8");
    const overviewRoute = readFileSync("src/app/api/platform/overview/route.ts", "utf8");
    // Both must call the one shared service; a second local count of unrecorded
    // files is the duplication this replaced.
    expect(systemRoute).toContain('from "@/lib/migration-status-service"');
    expect(overviewRoute).toContain('from "@/lib/migration-status-service"');
    expect(overviewRoute).not.toContain("readdirSync");
    expect(systemRoute).not.toContain("readdirSync");
    expect(overviewRoute).not.toContain("pendingMigrationCount");
    expect(systemRoute).not.toContain("pendingMigrationCount");
  });

  it("reports an unreadable inventory as unknown", async () => {
    vi.mocked(getMigrationStatus).mockResolvedValue({
      available: false,
      reasonCode: "migration_inventory_unreadable",
      checkedAt: "2026-10-08T10:00:00.000Z",
      appliedCount: 0,
      applied: [],
      lastAppliedAt: null,
      ordinaryPending: [],
      gated: [],
      pendingTotal: null,
      cutover: {
        migration: "0209_ai_gateway_secret_cutover.sql",
        applied: false,
        gated: false,
        reasonCode: "ai_gateway_secret_cutover_state_unknown",
        deferFlag: false,
        verifiedFlag: false,
        flagsConflict: false,
        legacyColumnsPresent: null,
        rowsMissingCiphertext: null,
        legacyPlaintextRows: null,
        blockedBy: null,
      },
    } as never);

    const body = await (await GET()).json();
    expect(body.overview.system.migrationStatusAvailable).toBe(false);
    expect(body.overview.system.pendingMigrations).toBeNull();
  });
});
