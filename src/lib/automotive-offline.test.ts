/**
 * Issue #839 §19 / Wave 6 — the rules a paired dealership desktop is held to
 * while the cloud is unreachable.
 *
 * These assertions are deliberately about *decisions*, not about plumbing: who
 * may decide a hold, what a queued request may and may not claim, which refusal
 * an operator can act on, and when the local board must be called stale. The
 * database halves (the mirror, the durable queue, the replay through the
 * canonical services) are covered by
 * `integration/automotive-offline.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  AUTOMOTIVE_MIRROR_STALE_AFTER_MS,
  AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES,
  AUTOMOTIVE_OFFLINE_REQUEST_STATUS_LABELS,
  automotiveConflictResolution,
  automotiveSyncSummary,
  classifyVehicleRequestReplay,
  conflictCodeForVehicleError,
  mirrorFreshness,
  offlineRequestIsOpen,
  planMirrorReconcile,
  resolveAutomotiveOfflineCapability,
  validateOfflineRequestTransition,
  validateVehicleReservationDraft,
} from "./automotive-offline";

const RESERVABLE = ["in_stock", "acquired"] as const;

function draft(overrides: Record<string, unknown> = {}) {
  return {
    serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
    customerId: "8c3f5d2f-1a7b-4b6f-8e8f-1e2b3c4d5e6f",
    customerName: "آقای خریدار",
    expiresAt: null,
    expiresAtTime: null,
    depositRial: 0,
    depositMethod: null,
    depositRefundable: true,
    depositNote: null,
    note: null,
    expectedVersion: 1_700_000_000_000,
    expectedState: "in_stock",
    ...overrides,
  };
}

describe("what an install may do with a car (§19)", () => {
  it("gives a Local-profile install authority over its own cars and nothing to queue", () => {
    const capability = resolveAutomotiveOfflineCapability({ profile: "local", runtimeRole: "site" });
    expect(capability.mode).toBe("local_authority");
    expect(capability.localStockReads).toBe(true);
    expect(capability.reservationRequests).toBe(false);
    expect(capability.releaseRequests).toBe(false);
    expect(capability.offlineSaleFinalization).toBe(false);
    expect(capability.offlineAcquisition).toBe(false);
    expect(capability.label.length).toBeGreaterThan(5);
  });

  it("treats the central role as the authority itself, never as a requester", () => {
    for (const profile of ["cloud", "hybrid"] as const) {
      const capability = resolveAutomotiveOfflineCapability({ profile, runtimeRole: "central" });
      expect(capability.mode, profile).toBe("cloud_authority");
      expect(capability.reservationRequests, profile).toBe(false);
      expect(capability.releaseRequests, profile).toBe(false);
    }
  });

  it("gives a paired hybrid site reads and two queued requests, and no financial decision", () => {
    const capability = resolveAutomotiveOfflineCapability({ profile: "hybrid", runtimeRole: "site" });
    expect(capability.mode).toBe("read_only_mirror");
    expect(capability.localStockReads).toBe(true);
    expect(capability.reservationRequests).toBe(true);
    expect(capability.releaseRequests).toBe(true);
    // The point of the whole exercise: a sale, a purchase and their postings
    // are never invented on the site.
    expect(capability.offlineSaleFinalization).toBe(false);
    expect(capability.offlineAcquisition).toBe(false);
    expect(capability.reason).toContain("تأیید سرور");
  });

  it("never answers 'is this the authority' from connectivity", () => {
    // The resolver's only inputs are the stored profile and this process's
    // role: the same install answers the same way whether the cable is in or
    // out, which is what keeps authority from flipping mid-sale.
    const offline = resolveAutomotiveOfflineCapability({ profile: "hybrid", runtimeRole: "site" });
    const again = resolveAutomotiveOfflineCapability({ profile: "hybrid", runtimeRole: "site" });
    expect(again).toEqual(offline);
    expect(Object.keys(offline)).not.toContain("online");
  });
});

describe("a queued request is never presented as a decision (§19)", () => {
  it("lets the cloud's answer be final and monotonic", () => {
    expect(validateOfflineRequestTransition("pending", "confirmed")).toBeNull();
    expect(validateOfflineRequestTransition("pending", "conflict")).toBeNull();
    expect(validateOfflineRequestTransition("pending", "cancelled")).toBeNull();
    expect(validateOfflineRequestTransition("pending", "pending")).toBeNull();
    for (const terminal of ["confirmed", "conflict", "cancelled"] as const) {
      for (const next of ["pending", "confirmed", "conflict", "cancelled"] as const) {
        if (next === terminal) continue;
        expect(validateOfflineRequestTransition(terminal, next), `${terminal}->${next}`).toBe(
          `invalid_request_transition:${terminal}->${next}`,
        );
      }
    }
  });

  it("counts only a pending row as awaiting the cloud", () => {
    expect(offlineRequestIsOpen("pending")).toBe(true);
    for (const status of ["confirmed", "conflict", "cancelled"] as const) {
      expect(offlineRequestIsOpen(status), status).toBe(false);
      expect(AUTOMOTIVE_OFFLINE_REQUEST_STATUS_LABELS[status].length).toBeGreaterThan(3);
    }
  });
});

describe("every refusal has a reason an operator can act on (§19)", () => {
  it("maps the canonical service's codes onto the conflict vocabulary", () => {
    expect(conflictCodeForVehicleError("vehicle_not_found")).toBe("vehicle_not_found");
    expect(conflictCodeForVehicleError("wrong_location")).toBe("wrong_location");
    expect(conflictCodeForVehicleError("customer_not_found")).toBe("customer_not_found");
    expect(conflictCodeForVehicleError("reservation_not_found")).toBe("reservation_not_found");
    expect(conflictCodeForVehicleError("reservation_closed")).toBe("reservation_closed");
    expect(conflictCodeForVehicleError("deposit_already_refunded")).toBe("reservation_closed");
    for (const code of ["vehicle_not_available", "vehicle_reserved", "vehicle_sold", "vehicle_archived"]) {
      expect(conflictCodeForVehicleError(code), code).toBe("vehicle_unavailable");
    }
    // Total on purpose: an unrecognized refusal is recorded bluntly rather than
    // dropped, so a request never fails silently.
    expect(conflictCodeForVehicleError("something_new")).toBe("invalid_request");
  });

  it("offers a resolution for every conflict code", () => {
    for (const code of Object.keys(AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES) as Array<
      keyof typeof AUTOMOTIVE_OFFLINE_CONFLICT_MESSAGES
    >) {
      const resolution = automotiveConflictResolution(code);
      expect(resolution.message.length, code).toBeGreaterThan(10);
      expect(resolution.actions.length, code).toBeGreaterThan(0);
    }
    expect(automotiveConflictResolution("vehicle_reserved_by_other").actions).toEqual(["open_vehicle", "cancel"]);
    expect(automotiveConflictResolution("customer_not_found").actions).toEqual(["retry", "cancel"]);
    expect(automotiveConflictResolution("vehicle_not_found").actions).toEqual(["cancel"]);
  });
});

describe("the draft a counter clerk fills in while the cloud is out (§19)", () => {
  it("accepts a complete hold and trims what a person typed", () => {
    const result = validateVehicleReservationDraft(
      draft({ customerName: "  خانم خریدار  ", expiresAt: "2026-02-01", expiresAtTime: "18:30", note: "  بیعانه  " }),
      { reservableStates: RESERVABLE, today: "2026-01-15" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.customerName).toBe("خانم خریدار");
    expect(result.draft.note).toBe("بیعانه");
    expect(result.draft.depositRefundable).toBe(true);
    expect(result.draft.expiresAtTime).toBe("18:30");
  });

  it("refuses a draft that could only ever conflict", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ customerId: null }, "customer_required"],
      [{ serialId: null }, "invalid_vehicle"],
      [{ depositRial: -1 }, "invalid_amount"],
      [{ depositRial: 1.5 }, "invalid_amount"],
      [{ depositRial: 5_000_000 }, "invalid_deposit_method"],
      [{ depositRial: 5_000_000, depositMethod: "cheque" }, "invalid_deposit_method"],
      [{ expiresAt: "2026-13-45" }, "invalid_date"],
      [{ expiresAt: "2026-02-30" }, "invalid_date"],
      [{ expiresAt: "2026-02-01", expiresAtTime: "25:00" }, "invalid_date"],
      [{ expiresAtTime: "10:00" }, "invalid_date"],
      [{ expectedVersion: 0 }, "invalid_vehicle"],
      [{ expectedVersion: 1.5 }, "invalid_vehicle"],
      [{ expectedState: "sold" }, "vehicle_not_available"],
      [{ expectedState: "transferred" }, "vehicle_not_available"],
    ];
    for (const [overrides, error] of cases) {
      const result = validateVehicleReservationDraft(draft(overrides), {
        reservableStates: RESERVABLE,
        today: "2026-01-15",
      });
      expect(result.ok, JSON.stringify(overrides)).toBe(false);
      if (result.ok) continue;
      expect(result.error, JSON.stringify(overrides)).toBe(error);
      expect(result.message.length).toBeGreaterThan(5);
    }
  });

  it("refuses an expiry that is already in the past", () => {
    const result = validateVehicleReservationDraft(draft({ expiresAt: "2026-01-14" }), {
      reservableStates: RESERVABLE,
      today: "2026-01-15",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_date");
    // …while the same date is accepted when «today» has not reached it.
    expect(
      validateVehicleReservationDraft(draft({ expiresAt: "2026-01-16" }), {
        reservableStates: RESERVABLE,
        today: "2026-01-15",
      }).ok,
    ).toBe(true);
  });
});

describe("the cloud re-validates the car, it does not replay the intent (§19)", () => {
  const request = {
    serialId: "7b2f4c1e-0f6a-4a5f-9d7e-0d1a2b3c4d5e",
    locationId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    expectedVersion: 10,
    expectedState: "in_stock" as const,
  };
  const remote = {
    found: true,
    state: "in_stock" as const,
    locationId: request.locationId,
    sourceVersion: 10,
    blockingHoldId: null,
    ownReservationId: null,
  };

  it("applies an unchanged, still-reservable car and reports a moved version", () => {
    expect(classifyVehicleRequestReplay({ request, remote, reservableStates: RESERVABLE })).toEqual({
      outcome: "apply",
      versionMoved: false,
    });
    expect(
      classifyVehicleRequestReplay({ request, remote: { ...remote, sourceVersion: 11 }, reservableStates: RESERVABLE }),
    ).toEqual({ outcome: "apply", versionMoved: true });
  });

  it("answers a retried request with the hold it already created", () => {
    expect(
      classifyVehicleRequestReplay({
        request,
        remote: { ...remote, ownReservationId: "9d4e5f6a-1b2c-4d3e-8f4a-5b6c7d8e9f0a" },
        reservableStates: RESERVABLE,
      }),
    ).toEqual({ outcome: "duplicate", reservationId: "9d4e5f6a-1b2c-4d3e-8f4a-5b6c7d8e9f0a" });
  });

  it("refuses with a named reason instead of merging two claims", () => {
    const cases: Array<[Parameters<typeof classifyVehicleRequestReplay>[0]["remote"], string]> = [
      [{ ...remote, found: false, state: null }, "vehicle_not_found"],
      [{ ...remote, locationId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, "wrong_location"],
      [{ ...remote, blockingHoldId: "11111111-1111-4111-8111-111111111111" }, "vehicle_reserved_by_other"],
      [{ ...remote, state: "sold" }, "vehicle_unavailable"],
      [{ ...remote, state: "reserved" }, "vehicle_unavailable"],
      [{ ...remote, state: "transferred" }, "vehicle_unavailable"],
      [{ ...remote, state: null }, "vehicle_unavailable"],
    ];
    for (const [facts, code] of cases) {
      expect(classifyVehicleRequestReplay({ request, remote: facts, reservableStates: RESERVABLE })).toEqual({
        outcome: "conflict",
        code,
      });
    }
    // A car that is still free wins even when its price moved in the meantime:
    // a price edit must not cost the customer the car.
    expect(
      classifyVehicleRequestReplay({ request, remote: { ...remote, sourceVersion: 99 }, reservableStates: RESERVABLE }),
    ).toEqual({ outcome: "apply", versionMoved: true });
  });
});

describe("the mirror says how old it is (§19)", () => {
  const now = new Date("2026-01-15T10:00:00.000Z");

  it("distinguishes fresh, stale and never-synced", () => {
    expect(mirrorFreshness(null, now)).toBe("never");
    expect(mirrorFreshness("not-a-date", now)).toBe("never");
    expect(mirrorFreshness("2026-01-15T09:59:00.000Z", now)).toBe("fresh");
    expect(mirrorFreshness(new Date(now.getTime() - AUTOMOTIVE_MIRROR_STALE_AFTER_MS).toISOString(), now)).toBe("fresh");
    expect(mirrorFreshness(new Date(now.getTime() - AUTOMOTIVE_MIRROR_STALE_AFTER_MS - 1).toISOString(), now)).toBe(
      "stale",
    );
    expect(mirrorFreshness("2026-01-15T07:00:00.000Z", now)).toBe("stale");
  });

  it("does not read a clock that jumped backwards as a week of freshness", () => {
    expect(mirrorFreshness("2026-01-15T10:00:30.000Z", now)).toBe("fresh");
    expect(mirrorFreshness("2026-01-16T10:00:00.000Z", now)).toBe("stale");
  });

  it("honours a caller-supplied window", () => {
    expect(mirrorFreshness("2026-01-15T09:59:00.000Z", now, 30_000)).toBe("stale");
    expect(mirrorFreshness("2026-01-15T09:59:45.000Z", now, 30_000)).toBe("fresh");
  });
});

describe("a snapshot replaces rows, it never merges them (§19)", () => {
  it("plans insert, update, skip and remove from the cloud's answer alone", () => {
    const local = { serialId: "a", sourceVersion: 10, contentHash: "h1" };
    const remote = { serialId: "a", sourceVersion: 10, contentHash: "h2" };
    expect(planMirrorReconcile({ local: null, remote: null })).toBe("skip");
    expect(planMirrorReconcile({ local: null, remote })).toBe("insert");
    expect(planMirrorReconcile({ local, remote: null })).toBe("remove");
    expect(planMirrorReconcile({ local, remote: { ...remote, contentHash: "h1" } })).toBe("skip");
    expect(planMirrorReconcile({ local, remote })).toBe("update");
    // Same row, later snapshot: the cloud's word replaces the mirror even when
    // its version looks older, so a site cannot be stuck on stale data.
    expect(planMirrorReconcile({ local, remote: { ...remote, sourceVersion: 9 } })).toBe("update");
  });
});

describe("what the sync panel tells an operator (§19)", () => {
  it("counts what matters and never hides staleness", () => {
    const summary = automotiveSyncSummary({
      vehicles: 12,
      reserved: 3,
      pendingRequests: 2,
      conflicts: 1,
      freshness: "stale",
    });
    expect(summary).toContain("12 خودرو");
    expect(summary).toContain("3 رزرو");
    expect(summary).toContain("2 درخواست در انتظار تأیید");
    expect(summary).toContain("1 تعارض");
    expect(summary).toContain("قدیمی");
  });

  it("says nothing it does not have", () => {
    const summary = automotiveSyncSummary({
      vehicles: 0,
      reserved: 0,
      pendingRequests: 0,
      conflicts: 0,
      freshness: "never",
    });
    expect(summary).not.toContain("رزرو");
    expect(summary).not.toContain("تعارض");
    expect(summary).toContain("هنوز همگام نشده");
  });
});
