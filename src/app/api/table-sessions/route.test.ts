import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as floor from "@/lib/floor";
import * as setup from "@/lib/setup-state";
import * as sessionService from "@/lib/table-session-service";
import { POST } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock("@/lib/floor", () => ({
  checkTableSectionAuthorization: vi.fn(),
  isUuid: (v: unknown) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/table-session-service", () => ({
  openSession: vi.fn(),
  setSessionGuests: vi.fn(),
}));
vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));

const session = {
  businessId: "00000000-0000-0000-0000-000000000001",
  sub: "00000000-0000-0000-0000-000000000002",
  role: "waiter",
};
const locationId = "00000000-0000-0000-0000-000000000010";
const table1 = "00000000-0000-0000-0000-000000000021";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session,
    error: null,
  } as never);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
    id: locationId,
  } as never);
  vi.mocked(floor.checkTableSectionAuthorization).mockResolvedValue({
    allowed: true,
    scope: {
      mode: "all",
      hasFullFloorAccess: true,
      assignedSectionIds: [],
      permissions: new Set(["tables.manage"]),
    },
  });
  vi.mocked(db.getPool).mockReturnValue({
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  } as never);
});

describe("POST /api/table-sessions input validation & conflict handling", () => {
  it("returns 400 when tableIds is not an array and tableId is missing", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/table-sessions", {
        method: "POST",
        body: JSON.stringify({ tableIds: "not-an-array" }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad_request" });
  });

  it("returns 400 when duplicate table IDs are passed", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/table-sessions", {
        method: "POST",
        body: JSON.stringify({ tableIds: [table1, table1] }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "duplicate_table_ids" });
  });

  it("returns 400 when partySize is negative or non-integer", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/table-sessions", {
        method: "POST",
        body: JSON.stringify({ tableIds: [table1], partySize: -3 }),
      }),
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_party_size" });
  });

  it("returns 409 upcoming_reservation_conflict when a walk-in overlaps a soon reservation without override", async () => {
    vi.mocked(sessionService.openSession).mockRejectedValue({
      code: "upcoming_reservation_conflict",
      status: 409,
      details: [
        {
          id: "00000000-0000-0000-0000-000000000099",
          tableId: table1,
          customerName: "سارا",
          reservedAt: "2026-10-19T18:30:00Z",
          partySize: 4,
        },
      ],
    });

    const res = await POST(
      new NextRequest("http://localhost/api/table-sessions", {
        method: "POST",
        body: JSON.stringify({
          tableIds: [table1],
          partySize: 2,
          ignoreUpcomingReservation: false,
        }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("upcoming_reservation_conflict");
    expect(body.reservation.customerName).toBe("سارا");
  });
});
