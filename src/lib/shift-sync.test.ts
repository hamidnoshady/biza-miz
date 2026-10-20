import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { EmployeeShift } from "./shift-service";
import {
  parseShiftAdjustmentSyncPayload,
  parseShiftSyncPayload,
  recordShiftSyncEvent,
  shiftSyncClientEventId,
  shiftSyncPayload,
} from "./shift-sync";
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
    closeMode: null,
    ...overrides,
  };
}

describe("shift sync payload", () => {
  it("round-trips an open and a cashed-up shift, without the device-local session", () => {
    const open = shift();
    expect(parseShiftSyncPayload({ ...shiftSyncPayload(open) })).toEqual(shiftSyncPayload(open));
    expect(shiftSyncPayload(open)).not.toHaveProperty("sessionId");
    const closed = shift({
      closingFloat: 7_500_000,
      endedAt: "2026-09-29T23:10:00.000Z",
      closedBy: randomUUID(),
      closeMode: "counted",
    });
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
      // Postgres would refuse these with a 22xxx cast error, which retries forever.
      { ...good, startedAt: "2026" },
      { ...good, startedAt: "Tue, 29 Sep 2026 14:30:00 GMT" },
      { ...good, startedAt: "2026-09-29T14:30:00" },
      { ...good, startedAt: "2026-02-30T10:00:00.000Z" },
      { ...good, endedAt: "2026-13-45T00:00Z" },
      { ...good, businessDate: "2026-13-45" },
      { ...good, businessDate: "2026-02-30" },
    ]) {
      expect(parseShiftSyncPayload(bad as Record<string, unknown>)).toBeNull();
    }
  });

  it("accepts ISO-8601 instants with Z or an offset", () => {
    const good = shiftSyncPayload(shift());
    for (const startedAt of ["2026-09-29T14:30Z", "2026-09-29T14:30:00+03:30", "2026-09-29T14:30:00.123456-05:00"]) {
      expect(parseShiftSyncPayload({ ...good, startedAt })?.startedAt).toBe(startedAt);
    }
  });

  it("names both events after the shift, so a retry is the same event", () => {
    expect(shiftSyncClientEventId("shift.opened", "abc")).toBe("shift.opened:abc");
    expect(shiftSyncClientEventId("shift.closed", "abc")).toBe("shift.closed:abc");
  });
});

const cashup = (overrides: Record<string, unknown> = {}) => ({
  closeMode: "counted" as const,
  reason: null,
  expectedCash: 12_000_000,
  countedCash: 11_800_000,
  variance: -200_000,
  cashIn: 500_000,
  cashOut: 0,
  orderCount: 4,
  grossTotal: 15_000_000,
  tenders: {
    cash: 7_000_000,
    card: 5_000_000,
    cardToCard: 0,
    online: 2_000_000,
    credit: 1_000_000,
    snappfood: 0,
    cheque: 0,
    other: 0,
    total: 15_000_000,
  },
  ...overrides,
});

describe("shift sync v2 — the cash-up travels with the close", () => {
  it("round-trips a close with its immutable snapshot", () => {
    const closed = shift({
      closingFloat: 11_800_000,
      endedAt: "2026-09-29T23:10:00.000Z",
      closedBy: randomUUID(),
      closeMode: "counted",
    });
    const payload = shiftSyncPayload(closed, cashup());
    expect(parseShiftSyncPayload({ ...payload })).toEqual(payload);
    expect(payload.cashup?.variance).toBe(-200_000);
  });

  it("accepts an unresolved close with no count and no variance", () => {
    const closed = shift({
      closingFloat: null,
      endedAt: "2026-09-29T23:10:00.000Z",
      closeMode: "unresolved",
    });
    const payload = shiftSyncPayload(
      closed,
      cashup({ closeMode: "unresolved", countedCash: null, variance: null, reason: "فراموش کرد ببندد" }),
    );
    expect(parseShiftSyncPayload({ ...payload })?.cashup?.closeMode).toBe("unresolved");
  });

  it("refuses a snapshot that contradicts the row or the database constraint", () => {
    const closed = shift({
      closingFloat: 11_800_000,
      endedAt: "2026-09-29T23:10:00.000Z",
      closeMode: "counted",
    });
    const good = shiftSyncPayload(closed, cashup());
    for (const bad of [
      // An unresolved close that carries a count.
      { ...good, cashup: cashup({ closeMode: "unresolved" }) },
      // A counted close with no count.
      { ...good, cashup: cashup({ countedCash: null }) },
      // A snapshot whose count disagrees with closingFloat.
      { ...good, cashup: cashup({ countedCash: 1 }) },
      // A snapshot on an event with no end time.
      { ...good, endedAt: null },
      // A tender that is not integer Rial.
      { ...good, cashup: cashup({ tenders: { ...cashup().tenders, cash: 1.5 } }) },
      // A close mode the shift row does not understand.
      { ...good, closeMode: "partial" },
    ]) {
      expect(parseShiftSyncPayload(bad as Record<string, unknown>)).toBeNull();
    }
  });
});

describe("shift cash-up adjustment payload", () => {
  const adjustment = {
    adjustmentId: randomUUID(),
    shiftId: randomUUID(),
    delta: 100_000,
    beforeVariance: -100_000,
    afterVariance: 0,
    reason: "a paid-out was found afterwards",
    createdAt: "2026-09-30T08:00:00.000Z",
  };

  it("round-trips a correction", () => {
    expect(parseShiftAdjustmentSyncPayload({ ...adjustment })).toEqual(adjustment);
  });

  it("refuses a correction it cannot apply verbatim", () => {
    for (const bad of [
      { ...adjustment, adjustmentId: "nope" },
      { ...adjustment, shiftId: 7 },
      { ...adjustment, delta: 0 },
      { ...adjustment, delta: 1.5 },
      { ...adjustment, beforeVariance: "x" },
      { ...adjustment, reason: "   " },
      { ...adjustment, reason: "x".repeat(501) },
      { ...adjustment, createdAt: "yesterday" },
    ]) {
      expect(parseShiftAdjustmentSyncPayload(bad as Record<string, unknown>)).toBeNull();
    }
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
    // New events are written as schema v2 (#933) so the cash-up can travel.
    const [, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toContain(2);
  });
});
