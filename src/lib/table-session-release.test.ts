import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import {
  TableSessionError,
  reconcileTableSessionsOnManualStatusChange,
  releaseSessionWithoutOrders,
  releaseTableAfterOrderSettled,
} from "./table-session-service";

interface FakeState {
  sessionStatus: "open" | "closed";
  sessionClosedBy: string | null;
  reservationId: string | null;
  reservationStatus: "booked" | "seated" | "completed";
  tables: Array<{ id: string; status: string; released: boolean }>;
  orders: Array<{ id: string; tableId?: string | null; sessionId: string | null; status: string }>;
}

function makeFakeClient(state: FakeState): PoolClient {
  const query = async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT coalesce(current_setting('app.sync_replay'")) {
      return { rows: [{ record: false }] };
    }

    if (normalized.startsWith("SELECT table_session_id FROM orders")) {
      const orderId = params[0] as string;
      const found = state.orders.find((o) => o.id === orderId);
      return { rows: found ? [{ table_session_id: found.sessionId }] : [] };
    }

    if (normalized.startsWith("SELECT COUNT(*)::text AS cnt FROM orders o")) {
      const tableId = params[1] as string;
      const activeCount = state.orders.filter(
        (o) =>
          (o.status === "open" || o.status === "held") &&
          (o.tableId === tableId || (o.sessionId === "sess-1" && state.sessionStatus === "open")),
      ).length;
      return { rows: [{ cnt: String(activeCount) }] };
    }

    if (normalized.startsWith("SELECT status FROM table_sessions")) {
      return { rows: [{ status: state.sessionStatus }] };
    }

    if (normalized.startsWith("UPDATE table_sessions SET status = 'closed'")) {
      state.sessionStatus = "closed";
      state.sessionClosedBy = (params[1] as string) ?? (params[2] as string) ?? null;
      return {
        rows: [{ location_id: "loc-1", reservation_id: state.reservationId }],
      };
    }

    if (normalized.startsWith("UPDATE table_session_tables SET released_at = now()")) {
      const released: Array<{ table_id: string }> = [];
      for (const t of state.tables) {
        if (!t.released) {
          t.released = true;
          released.push({ table_id: t.id });
        }
      }
      return { rows: released };
    }

    if (normalized.startsWith("UPDATE table_session_tables tst SET released_at = now()")) {
      const tableId = params[1] as string;
      const released: Array<{ session_id: string }> = [];
      for (const t of state.tables) {
        if (t.id === tableId && !t.released) {
          t.released = true;
          released.push({ session_id: "sess-1" });
        }
      }
      return { rows: released };
    }

    if (normalized.startsWith("SELECT COUNT(*)::text AS cnt FROM table_session_tables")) {
      const active = state.tables.filter((t) => !t.released).length;
      return { rows: [{ cnt: String(active) }] };
    }

    if (normalized.startsWith("UPDATE dining_tables SET status =")) {
      const ids = params[0] as string[];
      const nextStatus = params[1] as string;
      for (const t of state.tables) {
        if (ids.includes(t.id) && t.status !== "out_of_service") {
          t.status = nextStatus;
        }
      }
      return { rows: [] };
    }

    if (normalized.startsWith("UPDATE reservations r SET status = 'completed'")) {
      if (state.reservationId && state.reservationStatus === "seated") {
        state.reservationStatus = "completed";
        return { rows: [{ id: state.reservationId, business_id: "biz-1" }] };
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in fake client: ${normalized}`);
  };
  return { query } as unknown as PoolClient;
}

describe("releaseTableAfterOrderSettled (Issue #916 decoupled table status)", () => {
  it("returns null when the order has no linked table_session_id", async () => {
    const state: FakeState = {
      sessionStatus: "open",
      sessionClosedBy: null,
      reservationId: null,
      reservationStatus: "booked",
      tables: [{ id: "t-1", status: "seated", released: false }],
      orders: [{ id: "o-1", sessionId: null, status: "completed" }],
    };
    const res = await releaseTableAfterOrderSettled(makeFakeClient(state), "loc-1", "o-1", "u-1");
    expect(res).toBeNull();
    expect(state.sessionStatus).toBe("open");
    expect(state.tables[0].status).toBe("seated");
  });

  it("never auto-frees the table, closes the session, or completes the reservation when an order is paid", async () => {
    const state: FakeState = {
      sessionStatus: "open",
      sessionClosedBy: null,
      reservationId: "res-1",
      reservationStatus: "seated",
      tables: [
        { id: "t-1", status: "seated", released: false },
        { id: "t-2", status: "seated", released: false },
      ],
      orders: [{ id: "o-1", sessionId: "sess-1", status: "completed" }],
    };
    const res = await releaseTableAfterOrderSettled(makeFakeClient(state), "loc-1", "o-1", "u-9");
    expect(res).toEqual({ sessionId: "sess-1", tableIds: [] });
    expect(state.sessionStatus).toBe("open");
    expect(state.reservationStatus).toBe("seated");
    expect(state.tables.map((t) => t.status)).toEqual(["seated", "seated"]);
    expect(state.tables.every((t) => !t.released)).toBe(true);
  });
});

describe("releaseSessionWithoutOrders & reconcileTableSessionsOnManualStatusChange", () => {
  it("closes the visit session and completes its linked seated reservation without overriding manual status unless requested", async () => {
    const state: FakeState = {
      sessionStatus: "open",
      sessionClosedBy: null,
      reservationId: "res-1",
      reservationStatus: "seated",
      tables: [{ id: "t-1", status: "seated", released: false }],
      orders: [{ id: "o-open", sessionId: "sess-1", status: "open" }],
    };
    const ids = await releaseSessionWithoutOrders(makeFakeClient(state), "loc-1", "sess-1", "u-3");
    expect(ids).toEqual(["t-1"]);
    expect(state.sessionStatus).toBe("closed");
    expect(state.sessionClosedBy).toBe("u-3");
    expect(state.reservationStatus).toBe("completed");
    // Manual physical status is preserved when nextTableStatus is not passed
    expect(state.tables[0].status).toBe("seated");
    // Independent open orders are untouched
    expect(state.orders[0].status).toBe("open");
  });

  it("transitions tables when an explicit nextTableStatus is requested on visit release", async () => {
    const state: FakeState = {
      sessionStatus: "open",
      sessionClosedBy: null,
      reservationId: null,
      reservationStatus: "booked",
      tables: [{ id: "t-1", status: "seated", released: false }],
      orders: [],
    };
    await releaseSessionWithoutOrders(makeFakeClient(state), "loc-1", "sess-1", "u-3", {
      nextTableStatus: "cleaning",
    });
    expect(state.tables[0].status).toBe("cleaning");
  });

  it("rejects releasing a session that is already closed", async () => {
    const state: FakeState = {
      sessionStatus: "closed",
      sessionClosedBy: "u-1",
      reservationId: null,
      reservationStatus: "booked",
      tables: [{ id: "t-1", status: "free", released: true }],
      orders: [],
    };
    await expect(
      releaseSessionWithoutOrders(makeFakeClient(state), "loc-1", "sess-1", "u-1"),
    ).rejects.toBeInstanceOf(TableSessionError);
  });

  it("never auto-completes a reservation or closes the session on a manual free/cleaning status change while open or held orders exist on that table", async () => {
    for (const activeOrderStatus of ["open", "held"] as const) {
      const state: FakeState = {
        sessionStatus: "open",
        sessionClosedBy: null,
        reservationId: "res-2",
        reservationStatus: "seated",
        tables: [{ id: "t-1", status: "cleaning", released: false }],
        orders: [{ id: "o-1", tableId: "t-1", sessionId: "sess-1", status: activeOrderStatus }],
      };
      const reconciled = await reconcileTableSessionsOnManualStatusChange(
        makeFakeClient(state),
        "loc-1",
        "t-1",
        "cleaning",
        "u-5",
      );
      expect(reconciled).toEqual({
        closedSessionIds: [],
        completedReservationIds: [],
      });
      expect(state.sessionStatus).toBe("open");
      expect(state.reservationStatus).toBe("seated");
      expect(state.tables[0].released).toBe(false);
      expect(state.orders[0].status).toBe(activeOrderStatus);
    }
  });

  it("reconciles open session and completes seated reservation on manual free/cleaning status change when no open or held orders exist on that table", async () => {
    const state: FakeState = {
      sessionStatus: "open",
      sessionClosedBy: null,
      reservationId: "res-2",
      reservationStatus: "seated",
      tables: [{ id: "t-1", status: "cleaning", released: false }],
      orders: [{ id: "o-settled", tableId: "t-1", sessionId: "sess-1", status: "completed" }],
    };
    const reconciled = await reconcileTableSessionsOnManualStatusChange(
      makeFakeClient(state),
      "loc-1",
      "t-1",
      "cleaning",
      "u-5",
    );
    expect(reconciled).toEqual({
      closedSessionIds: ["sess-1"],
      completedReservationIds: ["res-2"],
    });
    expect(state.sessionStatus).toBe("closed");
    expect(state.reservationStatus).toBe("completed");
    expect(state.orders[0].status).toBe("completed");
  });
});
