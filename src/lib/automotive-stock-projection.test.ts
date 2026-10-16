/**
 * Issue #839 §19 / Wave 6 — the wire contract between the cloud's vehicle
 * board and a paired dealership desktop.
 *
 * The two properties worth asserting without a database: a snapshot that
 * cannot say which row is which car is refused whole (duplicate VIN/chassis/
 * stock number, duplicate serial), and the hash that decides "this snapshot is
 * the one I already have" is stable under key order but sensitive to a value.
 * The apply itself — writes, deletes, idempotent re-apply — and the fact that
 * the payload carries no cost field are asserted against PostgreSQL in
 * `integration/automotive-offline.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION,
  EMPTY_AUTOMOTIVE_STOCK_STATE,
  automotiveStockFailed,
  automotiveStockProjectionHash,
  automotiveStockSucceeded,
  automotiveStockSucceeded as succeeded,
  compareRequestCursors,
  encodeRequestCursor,
  nextRequestCursors,
  parseRequestCursor,
  availabilityForVehicle,
  duplicateVehicleIdentities,
  mirrorDaysInStock,
  planRequestStatusApply,
  validateAutomotiveStockProjection,
  vehicleMirrorRowHash,
  type AutomotiveStockProjection,
  type AutomotiveStockRequest,
  type AutomotiveStockVehicle,
} from "./automotive-stock-projection";

const LOCATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function vehicle(overrides: Partial<AutomotiveStockVehicle> = {}): AutomotiveStockVehicle {
  return {
    serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
    itemId: null,
    stockNumber: "A-1",
    make: "پژو",
    model: "207",
    trim: null,
    condition: "new",
    state: "in_stock",
    vehicleYearCalendar: "jalali",
    modelYear: 1403,
    mileageKm: null,
    vin: null,
    chassisNumber: null,
    plateNumber: null,
    bodyType: null,
    transmission: null,
    fuelType: null,
    exteriorColor: null,
    acquiredOn: "2026-01-01",
    askingPriceRial: 900_000_000,
    availability: "available",
    reservationId: null,
    reservationCustomerName: null,
    reservationExpiresAt: null,
    sourceVersion: 1_700_000_000_000,
    cloudUpdatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function projection(
  vehicles: AutomotiveStockVehicle[] = [vehicle()],
  requests: AutomotiveStockRequest[] = [],
): AutomotiveStockProjection {
  return {
    schemaVersion: AUTOMOTIVE_STOCK_PROJECTION_SCHEMA_VERSION,
    locationId: LOCATION,
    generatedAt: "2026-01-02T00:00:00.000Z",
    vehicles,
    requests,
    // The delivery cursors are part of the projection on purpose: they are what the
    // site echoes back so the cloud knows which answers it already holds (0225).
    requestsCursor: null,
    openRequestsCursor: null,
    requestsHasMore: false,
  };
}

describe("the snapshot a desktop replaces its mirror with (§19)", () => {
  it("accepts the shape the cloud actually serves and copies every field", () => {
    const parsed = validateAutomotiveStockProjection(
      JSON.parse(
        JSON.stringify({
          ...projection(),
          requests: [
            {
              id: "9d4e5f6a-1b2c-4d3e-8f4a-5b6c7d8e9f0a",
              requestType: "reserve",
              serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
              stockNumber: "A-1",
              customerName: "آقای خریدار",
              status: "pending",
              conflictCode: null,
              reservationId: null,
              requestedAt: "2026-01-02T00:00:00.000Z",
              resolvedAt: null,
              sourceVersion: null,
            },
          ],
        }),
      ),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.locationId).toBe(LOCATION);
    expect(parsed?.vehicles).toHaveLength(1);
    expect(parsed?.vehicles[0]).toMatchObject({ make: "پژو", askingPriceRial: 900_000_000, state: "in_stock" });
    expect(parsed?.requests[0]).toMatchObject({ requestType: "reserve", status: "pending" });
  });

  it("refuses anything that is not this schema version", () => {
    expect(validateAutomotiveStockProjection(null)).toBeNull();
    expect(validateAutomotiveStockProjection([])).toBeNull();
    expect(validateAutomotiveStockProjection({ ...projection(), schemaVersion: 2 })).toBeNull();
    expect(validateAutomotiveStockProjection({ ...projection(), locationId: "not-a-uuid" })).toBeNull();
    expect(validateAutomotiveStockProjection({ ...projection(), generatedAt: "soon" })).toBeNull();
    expect(validateAutomotiveStockProjection({ ...projection(), vehicles: "many" })).toBeNull();
    expect(validateAutomotiveStockProjection({ ...projection(), requests: undefined })).toBeNull();
  });

  it("refuses a truncated or nonsensical row rather than mirroring a half car", () => {
    const broken: Array<Record<string, unknown>> = [
      { serialId: "nope" },
      { stockNumber: "  " },
      { make: "" },
      { model: null },
      { condition: "certified" },
      { state: "reserved_sold" },
      { availability: "maybe" },
      { sourceVersion: 0 },
      { sourceVersion: 1.5 },
      { cloudUpdatedAt: "later" },
      { mileageKm: -1 },
      { askingPriceRial: -5 },
      { acquiredOn: "1404/01/01" },
      { reservationId: "not-a-uuid" },
      { reservationExpiresAt: "whenever" },
      { vin: 42 },
    ];
    for (const override of broken) {
      expect(
        validateAutomotiveStockProjection({
          ...projection([vehicle(override as Partial<AutomotiveStockVehicle>)]),
        }),
        JSON.stringify(override),
      ).toBeNull();
    }
  });

  it("refuses a duplicate VIN, chassis or stock number whole", () => {
    const first = vehicle({ serialId: "11111111-1111-4111-8111-111111111111", vin: "WVWZZZ1JZ3W386752" });
    const sameVin = vehicle({
      serialId: "22222222-2222-4222-8222-222222222222",
      stockNumber: "A-2",
      vin: "wvwzzz1jz3w386752 ",
    });
    expect(duplicateVehicleIdentities([first, sameVin])).toEqual([
      { field: "vin", value: "WVWZZZ1JZ3W386752", serialIds: [first.serialId, sameVin.serialId] },
    ]);
    expect(validateAutomotiveStockProjection(projection([first, sameVin]))).toBeNull();

    const sameChassis = vehicle({
      serialId: "33333333-3333-4333-8333-333333333333",
      stockNumber: "A-3",
      chassisNumber: "CH-1",
    });
    expect(
      validateAutomotiveStockProjection(
        projection([vehicle({ chassisNumber: "CH-1" }), sameChassis]),
      ),
    ).toBeNull();

    const sameStock = vehicle({ serialId: "44444444-4444-4444-8444-444444444444", stockNumber: "a-1" });
    expect(validateAutomotiveStockProjection(projection([vehicle(), sameStock]))).toBeNull();

    // The same row twice is a duplicate too: two mirror rows for one car is
    // exactly the ambiguity the unique indexes exist to prevent.
    expect(duplicateVehicleIdentities([first, first]).length).toBeGreaterThan(0);
    expect(validateAutomotiveStockProjection(projection([first, { ...first }]))).toBeNull();
  });

  it("refuses an unresolvable request row", () => {
    const base = {
      id: "9d4e5f6a-1b2c-4d3e-8f4a-5b6c7d8e9f0a",
      requestType: "reserve",
      serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
      stockNumber: "A-1",
      customerName: null,
      status: "confirmed",
      conflictCode: null,
      reservationId: "11111111-1111-4111-8111-111111111111",
      requestedAt: "2026-01-02T00:00:00.000Z",
      resolvedAt: "2026-01-02T00:00:05.000Z",
      sourceVersion: 12,
    };
    const withRequests = (request: unknown) => ({ ...projection(), requests: [request] });
    expect(validateAutomotiveStockProjection(withRequests(base))).not.toBeNull();
    for (const broken of [
      { ...base, id: "nope" },
      { ...base, serialId: null },
      { ...base, requestType: "sale" },
      { ...base, status: "in_progress" },
      { ...base, conflictCode: "made_up" },
      { ...base, reservationId: "nope" },
      { ...base, requestedAt: "yesterday" },
      { ...base, resolvedAt: "soon" },
      { ...base, sourceVersion: 0 },
    ]) {
      expect(validateAutomotiveStockProjection(withRequests(broken)), JSON.stringify(broken)).toBeNull();
    }
  });
});

describe("the hash that decides whether a snapshot is news (§19)", () => {
  it("is stable under key order and sensitive to a value", () => {
    const canonical = projection();
    const reordered: AutomotiveStockProjection = {
      requests: [],
      vehicles: [Object.fromEntries(Object.entries(canonical.vehicles[0]).reverse()) as unknown as AutomotiveStockVehicle],
      generatedAt: canonical.generatedAt,
      locationId: canonical.locationId,
      schemaVersion: canonical.schemaVersion,
      requestsCursor: null,
      openRequestsCursor: null,
      requestsHasMore: false,
    };
    expect(automotiveStockProjectionHash(reordered)).toBe(automotiveStockProjectionHash(canonical));
    const repriced = projection([vehicle({ askingPriceRial: 899_000_000 })]);
    expect(automotiveStockProjectionHash(repriced)).not.toBe(automotiveStockProjectionHash(canonical));
    // …and a row a sold car disappears from is news too.
    expect(automotiveStockProjectionHash(projection([]))).not.toBe(automotiveStockProjectionHash(canonical));
  });

  it("gives one row a stable identity of its own", () => {
    const row = vehicle();
    expect(vehicleMirrorRowHash(row)).toBe(vehicleMirrorRowHash({ ...row }));
    expect(vehicleMirrorRowHash(row)).not.toBe(vehicleMirrorRowHash({ ...row, state: "reserved" }));
  });
});

describe("the board's vocabulary (§19)", () => {
  it("calls a held car reserved, a gone car gone, and a shipped car not sellable here", () => {
    expect(availabilityForVehicle({ state: "in_stock", hasActiveReservation: false })).toBe("available");
    expect(availabilityForVehicle({ state: "acquired", hasActiveReservation: false })).toBe("available");
    expect(availabilityForVehicle({ state: "draft", hasActiveReservation: false })).toBe("available");
    expect(availabilityForVehicle({ state: "returned", hasActiveReservation: false })).toBe("available");
    expect(availabilityForVehicle({ state: "in_stock", hasActiveReservation: true })).toBe("reserved");
    expect(availabilityForVehicle({ state: "reserved", hasActiveReservation: false })).toBe("reserved");
    expect(availabilityForVehicle({ state: "sold", hasActiveReservation: false })).toBe("sold");
    expect(availabilityForVehicle({ state: "archived", hasActiveReservation: false })).toBe("unavailable");
    // During a transfer the car is on neither lot: it must not look sellable at
    // the branch that shipped it.
    expect(availabilityForVehicle({ state: "transferred", hasActiveReservation: false })).toBe("unavailable");
  });

  it("ages a car from its acquisition date, never negatively", () => {
    expect(mirrorDaysInStock(null, "2026-01-15")).toBeNull();
    expect(mirrorDaysInStock("2026-01-15", "2026-01-15")).toBe(0);
    expect(mirrorDaysInStock("2026-01-05", "2026-01-15")).toBe(10);
    expect(mirrorDaysInStock("2026-02-01", "2026-01-15")).toBe(0);
    expect(mirrorDaysInStock("today", "2026-01-15")).toBeNull();
  });
});

describe("the cloud's answer to a queued request (§19)", () => {
  const remote = {
    id: "9d4e5f6a-1b2c-4d3e-8f4a-5b6c7d8e9f0a",
    requestType: "reserve" as const,
    serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
    stockNumber: "A-1",
    customerName: "آقای خریدار",
    status: "confirmed" as const,
    conflictCode: null,
    reservationId: "11111111-1111-4111-8111-111111111111",
    requestedAt: "2026-01-02T00:00:00.000Z",
    resolvedAt: "2026-01-02T00:00:05.000Z",
    sourceVersion: 12,
  };
  const local = { status: "pending" as const, conflictCode: null, reservationId: null };

  it("does not confirm a request the cloud has not answered", () => {
    expect(planRequestStatusApply({ local, remote: { ...remote, status: "pending" } })).toBeNull();
  });

  it("adopts the cloud's verdict, and only from pending", () => {
    expect(planRequestStatusApply({ local, remote })).toEqual({
      status: "confirmed",
      conflictCode: null,
      reservationId: remote.reservationId,
    });
    expect(planRequestStatusApply({ local, remote: { ...remote, status: "conflict", conflictCode: "vehicle_unavailable" } })).toEqual({
      status: "conflict",
      conflictCode: "vehicle_unavailable",
      reservationId: remote.reservationId,
    });
    // Monotonic: an older snapshot still saying «pending», or a later one
    // contradicting a decided request, changes nothing.
    const already = { status: "confirmed" as const, conflictCode: null, reservationId: remote.reservationId };
    expect(planRequestStatusApply({ local: already, remote })).toBeNull();
    expect(planRequestStatusApply({ local: already, remote: { ...remote, status: "pending" } })).toBeNull();
  });
});

describe("the state the sync panel stores (§19)", () => {
  const now = new Date("2026-01-15T10:00:00.000Z");

  it("records a success and clears the failure streak", () => {
    const failed = automotiveStockFailed(EMPTY_AUTOMOTIVE_STOCK_STATE, "unreachable", new Date("2026-01-15T09:00:00.000Z"));
    expect(failed.failures).toBe(1);
    expect(failed.lastError).toBe("unreachable");
    expect(failed.nextAttemptAt).not.toBeNull();
    const recovered = succeeded(failed, "hash", true, 7, now);
    expect(recovered).toMatchObject({ hash: "hash", lastError: null, failures: 0, nextAttemptAt: null, vehicleCount: 7 });
    expect(recovered.appliedAt).toBe(now.toISOString());
  });

  it("keeps the last applied board when a refresh fails", () => {
    const applied = succeeded(EMPTY_AUTOMOTIVE_STOCK_STATE, "hash", true, 7, new Date("2026-01-15T09:00:00.000Z"));
    const failed = automotiveStockFailed(applied, "x".repeat(500), now);
    expect(failed.hash).toBe("hash");
    expect(failed.appliedAt).toBe(applied.appliedAt);
    expect(failed.vehicleCount).toBe(7);
    expect(failed.lastError?.length).toBe(300);
  });

  it("does not move appliedAt when an identical snapshot is re-checked", () => {
    const applied = succeeded(EMPTY_AUTOMOTIVE_STOCK_STATE, "hash", true, 7, new Date("2026-01-15T09:00:00.000Z"));
    const checked = succeeded(applied, "hash", false, 7, now);
    expect(checked.appliedAt).toBe(applied.appliedAt);
    expect(checked.checkedAt).toBe(now.toISOString());
  });
});

describe("the delivery watermarks the site acknowledges (§19)", () => {
  const FIRST = "11111111-1111-4111-8111-111111111111";
  const SECOND = "22222222-2222-4222-8222-222222222222";

  it("orders the same instant written at two precisions the way the column stores it", () => {
    // `timestamptz` keeps microseconds; a JavaScript `Date` and therefore a cursor
    // built from `toISOString()` keeps milliseconds. Both spellings reach the
    // comparator, and a string comparison would call the coarser one *greater*
    // because `Z` sorts after `1` — which moved a watermark backwards and re-sent a
    // page forever. The comparator has to read the fraction as a number.
    const exact = encodeRequestCursor({ resolvedAt: "2026-01-02T00:00:05.123456Z", id: FIRST });
    const truncated = encodeRequestCursor({ resolvedAt: "2026-01-02T00:00:05.123Z", id: FIRST });
    expect(compareRequestCursors(exact, truncated)).toBe(1);
    expect(compareRequestCursors(truncated, exact)).toBe(-1);
    expect(compareRequestCursors(exact, exact)).toBe(0);
    // …and the id is only consulted inside the same microsecond.
    const later = encodeRequestCursor({ resolvedAt: "2026-01-02T00:00:05.123456Z", id: SECOND });
    expect(compareRequestCursors(later, exact)).toBe(1);
    expect(compareRequestCursors(FIRST > SECOND ? later : exact, FIRST > SECOND ? exact : later)).toBe(-1);
  });

  it("treats anything that is not a cursor as absent, never as a value to interpolate", () => {
    expect(parseRequestCursor(`2026-01-02T00:00:05.123456Z|${FIRST}`)).toEqual({
      resolvedAt: "2026-01-02T00:00:05.123456Z",
      id: FIRST,
    });
    expect(parseRequestCursor("not-a-cursor'; DROP TABLE sync_events; --")).toBeNull();
    expect(parseRequestCursor(`${FIRST}|2026-01-02T00:00:05Z`)).toBeNull();
    expect(parseRequestCursor("")).toBeNull();
    expect(parseRequestCursor(null)).toBeNull();
    expect(parseRequestCursor(undefined)).toBeNull();
  });

  it("advances each stream forward only, and leaves the other where it was", () => {
    const open = {
      id: FIRST,
      status: "pending" as const,
      requestedAt: "2026-01-02T00:00:01.000000Z",
      resolvedAt: null,
    };
    const answered = {
      id: SECOND,
      status: "confirmed" as const,
      requestedAt: "2026-01-02T00:00:01.000000Z",
      resolvedAt: "2026-01-02T00:00:02.500000Z",
    };
    const advanced = nextRequestCursors([open, answered], { cursor: null, openCursor: null });
    expect(advanced.openCursor).toBe(encodeRequestCursor({ resolvedAt: open.requestedAt, id: FIRST }));
    expect(advanced.cursor).toBe(encodeRequestCursor({ resolvedAt: answered.resolvedAt, id: SECOND }));

    // Re-applying an old page (a retry, a re-delivery) cannot move them backwards.
    const again = nextRequestCursors([answered], { cursor: advanced.cursor, openCursor: advanced.openCursor });
    expect(again).toEqual(advanced);
    const older = nextRequestCursors(
      [{ ...answered, id: "00000000-0000-4000-8000-000000000000", resolvedAt: "2026-01-02T00:00:02.000000Z" }],
      { cursor: advanced.cursor, openCursor: advanced.openCursor },
    );
    expect(older.cursor).toBe(advanced.cursor);
    // A stream that carried nothing keeps the caller's watermark: the site simply
    // asks again, and the cloud has nothing to re-serve.
    expect(nextRequestCursors([], { cursor: advanced.cursor, openCursor: advanced.openCursor })).toEqual(advanced);
  });
});
