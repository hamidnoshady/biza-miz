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
const tableId = "00000000-0000-0000-0000-000000000021";

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

describe("PATCH /api/reservations/[id] atomic seat, cancel/no_show race & completion lifecycle", () => {
  it("prevents concurrent double-seating by returning 409 reservation_not_booked when status is already seated", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: reservationId,
            table_id: tableId,
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

  it("handles cancel and no_show racing against seat without overwriting a seated party", async () => {
    // Shared stateful reservation row to simulate concurrent seat vs cancel/no_show
    const state = {
      status: "booked" as "booked" | "seated" | "cancelled" | "no_show" | "completed",
      seatedSessionId: null as string | null,
    };

    vi.mocked(db.getPool).mockReturnValue({
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
            return { rows: [] };
          }
          if (normalized.includes("FROM reservations WHERE id = $1 AND location_id = $2 FOR UPDATE")) {
            return {
              rows: [
                {
                  id: reservationId,
                  table_id: tableId,
                  customer_name: "رضا",
                  customer_phone: null,
                  party_size: 3,
                  reserved_at: "2026-10-20T19:00:00Z",
                  duration_minutes: 90,
                  status: state.status,
                  seated_session_id: state.seatedSessionId,
                  note: null,
                },
              ],
            };
          }
          if (normalized.startsWith("SELECT ts.id FROM table_sessions")) {
            return { rows: [{ id: "00000000-0000-0000-0000-000000000088" }] };
          }
          if (normalized.startsWith("UPDATE table_sessions")) {
            return { rowCount: 1, rows: [] };
          }
          if (normalized.includes("SET status = 'seated'") && normalized.includes("WHERE id = $1 AND status = 'booked'")) {
            if (state.status !== "booked") return { rowCount: 0, rows: [] };
            state.status = "seated";
            state.seatedSessionId = params[1] as string;
            return { rowCount: 1, rows: [] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    } as never);

    vi.mocked(db.query).mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, table_id, customer_name")) {
        // Simulate cancel/no_show reading the reservation snapshot just before seat commits
        return {
          rows: [
            {
              id: reservationId,
              table_id: tableId,
              customer_name: "رضا",
              customer_phone: null,
              party_size: 3,
              reserved_at: "2026-10-20T19:00:00Z",
              duration_minutes: 90,
              status: "booked",
              seated_session_id: null,
              note: null,
            },
          ],
        } as never;
      }
      if (normalized.includes("UPDATE reservations SET status = $2::reservation_status") && normalized.includes("AND status = 'booked'")) {
        // Conditional UPDATE must check current DB state (`status = 'booked'`)
        if (state.status !== "booked") {
          return { rowCount: 0, rows: [] } as never;
        }
        state.status = (params?.[1] as "cancelled" | "no_show") ?? "cancelled";
        return { rowCount: 1, rows: [] } as never;
      }
      return { rows: [] } as never;
    });

    // 1. `seat` commits first, transitioning status: booked -> seated
    const seatRes = await PATCH(
      new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "seat" }),
      }),
      { params: Promise.resolve({ id: reservationId }) },
    );
    expect(seatRes.status).toBe(200);
    expect(state.status).toBe("seated");

    // 2. Concurrent `cancel` and `no_show` that loaded stale `status = 'booked'` lose the conditional UPDATE
    for (const action of ["cancel", "no_show"] as const) {
      const raceRes = await PATCH(
        new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
          method: "PATCH",
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id: reservationId }) },
      );
      expect(raceRes.status).toBe(409);
      await expect(raceRes.json()).resolves.toEqual({ error: "reservation_not_booked" });
      expect(state.status).toBe("seated");
    }
  });

  it("allows action='complete' ONLY from 'seated' using conditional WHERE status = 'seated', rejecting 'booked'", async () => {
    // 1. Rejects completing a reservation that is still 'booked'
    vi.mocked(db.query).mockResolvedValueOnce({
      rows: [
        {
          id: reservationId,
          status: "booked",
          customer_name: "رضا",
          customer_phone: null,
          customer_phone_enc: null,
        },
      ],
    } as never);

    const fromBooked = await PATCH(
      new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "complete" }),
      }),
      { params: Promise.resolve({ id: reservationId }) },
    );
    expect(fromBooked.status).toBe(409);
    await expect(fromBooked.json()).resolves.toEqual({
      error: "reservation_not_seated",
      currentStatus: "booked",
    });

    // 2. Completes a 'seated' reservation via conditional UPDATE ... WHERE status = 'seated'
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

    const fromSeated = await PATCH(
      new NextRequest(`http://localhost/api/reservations/${reservationId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "complete" }),
      }),
      { params: Promise.resolve({ id: reservationId }) },
    );

    expect(fromSeated.status).toBe(200);
    const body = await fromSeated.json();
    expect(body.reservation.status).toBe("completed");
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1 AND location_id = $2 AND status = 'seated'"),
      [reservationId, locationId],
    );
  });
});
