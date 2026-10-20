import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setup from "@/lib/setup-state";
import * as reservationService from "@/lib/reservation-service";
import { PATCH } from "./route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
  requirePermission: vi.fn(),
  requireAnyPermission: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/reservation-service", () => ({
  decryptReservationPhones: vi.fn(async (_biz: string, rows: unknown[]) => rows),
  encryptReservationPhone: vi.fn(async () => ({ enc: null, bidx: null })),
  lockTableForReservationWrite: vi.fn(async () => {}),
  parseDate: vi.fn((v: unknown) => (typeof v === "string" ? new Date(v) : null)),
  tableConflicts: vi.fn(async () => []),
}));
vi.mock("@/lib/table-session-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/table-session-service")>();
  return {
    ...actual,
    recordReservationState: vi.fn(async () => {}),
    recordReservationStateStandalone: vi.fn(async () => {}),
    recordTableSessionState: vi.fn(async () => {}),
  };
});
vi.mock("@/lib/realtime", () => ({ broadcast: vi.fn() }));

const session = {
  businessId: "00000000-0000-0000-0000-000000000001",
  sub: "00000000-0000-0000-0000-000000000002",
  role: "waiter",
};
const locationId = "00000000-0000-0000-0000-000000000010";
const reservationId = "00000000-0000-0000-0000-000000000050";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({
    session,
    error: null,
  } as never);
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session,
    error: null,
  } as never);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({
    id: locationId,
  } as never);
});

describe("PATCH /api/reservations/[id] atomic seat & completion lifecycle", () => {
  it("prevents concurrent double-seating by returning 409 reservation_already_processed when status is no longer booked", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        // SELECT ... FOR UPDATE shows status is already 'seated'
        rows: [
          {
            id: reservationId,
            table_id: "00000000-0000-0000-0000-000000000021",
            customer_name: "رضا",
            party_size: 3,
            status: "seated",
            note: null,
          },
        ],
      })
      .mockResolvedValueOnce({}); // ROLLBACK

    vi.mocked(db.getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    } as never);

    const res = await PATCH(
      new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "seat" }),
      }),
      { params: Promise.resolve({ id: reservationId }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("reservation_not_booked");
    expect(body.currentStatus).toBe("seated");
  });

  it("supports action='complete' to mark a seated reservation as completed", async () => {
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [
          {
            id: reservationId,
            status: "seated",
            customer_name: "رضا",
            customer_phone: null,
            customer_phone_enc: null,
          },
        ],
      } as never)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [],
      } as never);
    vi.mocked(reservationService.decryptReservationPhones).mockResolvedValueOnce([
      {
        id: reservationId,
        status: "seated",
        customer_name: "رضا",
        customer_phone: null,
      },
    ] as never);

    const res = await PATCH(
      new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "complete" }),
      }),
      { params: Promise.resolve({ id: reservationId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reservation.status).toBe("completed");
  });
});
