import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EmployeeShift } from "./shift-service";
import { parseShiftSyncPayload, recordShiftSyncEvent, shiftSyncClientEventId, shiftSyncPayload } from "./shift-sync";
import { syncClientEventId } from "./sync-outbox";

function shift(overrides: Partial<EmployeeShift> = {}): EmployeeShift {
  return {
    id: randomUUID(),
    employeeId: randomUUID(),
    businessId: randomUUID(),
    locationId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: null,
    openingFloat: 5_000_000,
    closingFloat: null,
    businessDate: "2026-09-29",
    startedAt: "2026-09-29T14:30:00.000Z",
    endedAt: null,
    closedBy: null,
    ...overrides,
  };
}

describe("shift sync payload", () => {
  it("round-trips an open and a cashed-up shift, without the device-local session", () => {
    const open = shift();
    expect(parseShiftSyncPayload({ ...shiftSyncPayload(open) })).toEqual(shiftSyncPayload(open));
    expect(shiftSyncPayload(open)).not.toHaveProperty("sessionId");
    const closed = shift({ closingFloat: 7_500_000, endedAt: "2026-09-29T23:10:00.000Z", closedBy: randomUUID() });
    expect(parseShiftSyncPayload({ ...shiftSyncPayload(closed) })).toEqual(shiftSyncPayload(closed));
  });

  it("refuses a payload it cannot trust", () => {
    const good = shiftSyncPayload(shift({ endedAt: "2026-09-29T23:10:00.000Z", closingFloat: 1 }));
    for (const bad of [
      { ...good, shiftId: "not-a-uuid" },
      { ...good, employeeId: 7 },
      { ...good, businessDate: "2026/09/29" },
      { ...good, startedAt: "yesterday" },
      { ...good, endedAt: "2026-09-29T10:00:00.000Z" },
      { ...good, openingFloat: -1 },
      { ...good, closingFloat: 1.5 },
      { ...good, closedBy: "someone" },
    ]) {
      expect(parseShiftSyncPayload(bad as Record<string, unknown>)).toBeNull();
    }
  });

  it("names both events after the shift, so a retry is the same event", () => {
    expect(shiftSyncClientEventId("shift.opened", "abc")).toBe("shift.opened:abc");
    expect(shiftSyncClientEventId("shift.closed", "abc")).toBe("shift.closed:abc");
  });
});

describe("recordShiftSyncEvent", () => {
  it("records nothing for a shift with no branch", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient;
    await recordShiftSyncEvent(client, "shift.opened", shift({ locationId: null }), { userId: null, role: "cashier" });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("appends one outbox row named after the shift", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const opened = shift();
    await recordShiftSyncEvent({ query } as unknown as PoolClient, "shift.opened", opened, { userId: opened.employeeId, role: "cashier" });
    expect(query).toHaveBeenCalledTimes(1);
    // The outbox stores the name-derived UUID of the identity, not the identity itself.
    expect(JSON.stringify(query.mock.calls[0])).toContain(syncClientEventId(`shift.opened:${opened.id}`));
  });
});
