import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { applyReservationState, applyTableSessionState } from "./floor-sync";
import { SyncPayloadError, applySyncDomainHandler } from "./sync-domain-handlers";

const businessId = "00000000-0000-0000-0000-000000000001";
const locationId = "00000000-0000-0000-0000-000000000010";
const sessionId = "00000000-0000-0000-0000-000000000020";
const tableId = "00000000-0000-0000-0000-000000000030";
const customerId = "00000000-0000-0000-0000-000000000040";
const reservationId = "00000000-0000-0000-0000-000000000050";

describe("floor-sync appliers for guest visits (table_session.state.synced) and bookings (reservation.state.synced)", () => {
  it("applies table_session.state.synced idempotently with tables and guest customers", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push({ sql: normalized, params });
        if (normalized.startsWith("SELECT id FROM locations")) {
          return { rows: [{ id: locationId }] };
        }
        if (normalized.startsWith("SELECT id FROM dining_tables")) {
          return { rows: [{ id: tableId }] };
        }
        if (normalized.startsWith("SELECT id FROM users")) {
          return { rows: [] };
        }
        if (normalized.startsWith("SELECT id FROM parties")) {
          return { rows: [{ id: customerId }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PoolClient;

    const result = await applyTableSessionState(client, {
      businessId,
      locationId,
      payload: {
        sessionId,
        locationId,
        status: "open",
        partySize: 4,
        guestName: "مهمان ۱",
        openedBy: null,
        openedAt: "2026-10-20T12:00:00.000Z",
        billRequestedAt: null,
        closedAt: null,
        note: "کنار پنجره",
        tables: [
          {
            tableId,
            mergedAt: "2026-10-20T12:00:00.000Z",
            releasedAt: null,
          },
        ],
        customers: [{ guestNumber: 1, customerId }],
      },
    });

    expect(result).toEqual({ effectType: "table_session", effectId: sessionId });
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO table_sessions"))).toBe(true);
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO table_session_tables"))).toBe(true);
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO table_session_customers"))).toBe(true);
  });

  it("applies reservation.state.synced idempotently and links existing table and session", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push({ sql: normalized, params });
        if (normalized.startsWith("SELECT id FROM locations")) {
          return { rows: [{ id: locationId }] };
        }
        if (normalized.startsWith("SELECT id FROM dining_tables")) {
          return { rows: [{ id: tableId }] };
        }
        if (normalized.startsWith("SELECT id FROM table_sessions")) {
          return { rows: [{ id: sessionId }] };
        }
        if (normalized.startsWith("SELECT id FROM users")) {
          return { rows: [] };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PoolClient;

    const result = await applyReservationState(client, {
      businessId,
      locationId,
      payload: {
        reservationId,
        locationId,
        tableId,
        customerName: "سارا احمدی",
        customerPhone: "09121234567",
        partySize: 3,
        reservedAt: "2026-10-20T18:30:00.000Z",
        durationMinutes: 90,
        status: "seated",
        seatedSessionId: sessionId,
        note: "تولد",
        createdBy: null,
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-20T18:35:00.000Z",
      },
    });

    expect(result).toEqual({ effectType: "reservation", effectId: reservationId });
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO reservations"))).toBe(true);
    expect(
      queries.some(
        (q) =>
          q.sql.startsWith("UPDATE table_sessions SET reservation_id = $1") &&
          q.params[0] === reservationId &&
          q.params[1] === sessionId,
      ),
    ).toBe(true);
  });

  it("translates invalid floor-sync payloads into canonical SyncPayloadError via applySyncDomainHandler", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ id: locationId }] })),
    } as unknown as PoolClient;

    await expect(
      applySyncDomainHandler({
        client,
        businessId,
        locationId,
        actor: { userId: "00000000-0000-0000-0000-000000000002", role: "owner" },
        clientEventId: "evt-1",
        definition: {
          eventType: "table_session.state.synced",
          eventVersion: 1,
          handler: "table_session.state.synced",
          category: "pos",
          requiresLocation: true,
          dependencyErrors: [],
        } as never,
        payload: { invalid: true },
      }),
    ).rejects.toBeInstanceOf(SyncPayloadError);

    await expect(
      applySyncDomainHandler({
        client,
        businessId,
        locationId,
        actor: { userId: "00000000-0000-0000-0000-000000000002", role: "owner" },
        clientEventId: "evt-2",
        definition: {
          eventType: "reservation.state.synced",
          eventVersion: 1,
          handler: "reservation.state.synced",
          category: "pos",
          requiresLocation: true,
          dependencyErrors: [],
        } as never,
        payload: { invalid: true },
      }),
    ).rejects.toBeInstanceOf(SyncPayloadError);
  });
});
