import { describe, expect, it } from "vitest";
import {
  ORDER_NUMBER_BLOCK_SIZE,
  ORDER_NUMBER_LEASE_LOW_WATERMARK,
  leaseHeadroom,
  leaseNeedsRenewal,
  leaseStartFor,
  parseOrderNumberLeaseGrant,
} from "./order-number-lease";

const LOCATION = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: LEASE,
    locationId: LOCATION,
    siteDeviceId: DEVICE,
    fromNumber: 822,
    toNumber: 1021,
    ...overrides,
  };
}

describe("the order-number lease contract", () => {
  it("reserves enough numbers to keep selling offline, and renews before it runs out", () => {
    // The headroom is the offline selling window: a block must outlast a
    // realistic cloud outage, and the renewal must happen while numbers remain
    // so the old block's tail is still consumed first (no gap).
    expect(ORDER_NUMBER_BLOCK_SIZE).toBeGreaterThan(ORDER_NUMBER_LEASE_LOW_WATERMARK * 4);
    expect(ORDER_NUMBER_LEASE_LOW_WATERMARK).toBeGreaterThan(0);
  });

  it("accepts the cloud's grant and rejects anything that could poison the local stream", () => {
    expect(parseOrderNumberLeaseGrant(grant())).toEqual(grant());
    // A range that runs backwards, a fractional number, a zero, a missing
    // identity and a non-uuid are all refusals, never a partially applied lease.
    expect(parseOrderNumberLeaseGrant(grant({ toNumber: 821 }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(grant({ fromNumber: 1.5 }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(grant({ fromNumber: 0 }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(grant({ id: "not-a-uuid" }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(grant({ locationId: undefined }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(grant({ toNumber: Number.MAX_SAFE_INTEGER + 1 }))).toBeNull();
    expect(parseOrderNumberLeaseGrant(null)).toBeNull();
    expect(parseOrderNumberLeaseGrant([])).toBeNull();
  });

  it("counts the numbers a lease can still hand out, and asks for a new one at the watermark", () => {
    expect(leaseHeadroom({ fromNumber: 822, toNumber: 1021, nextNumber: 822 })).toBe(200);
    expect(leaseHeadroom({ fromNumber: 822, toNumber: 1021, nextNumber: 1010 })).toBe(12);
    expect(leaseHeadroom({ fromNumber: 822, toNumber: 1021, nextNumber: 1022 })).toBe(0);
    // Never negative, even for a row corrupted by hand.
    expect(leaseHeadroom({ fromNumber: 822, toNumber: 1021, nextNumber: 2000 })).toBe(0);

    expect(leaseNeedsRenewal(0)).toBe(true);
    expect(leaseNeedsRenewal(ORDER_NUMBER_LEASE_LOW_WATERMARK)).toBe(true);
    expect(leaseNeedsRenewal(ORDER_NUMBER_LEASE_LOW_WATERMARK + 1)).toBe(false);
    expect(leaseNeedsRenewal(ORDER_NUMBER_BLOCK_SIZE * 2)).toBe(false);
  });

  it("starts a recorded block above the highest number the site already holds", () => {
    // Ordinary case: the cloud already started above the reported high-water.
    expect(leaseStartFor(grant(), 820)).toBe(822);
    // A sale landed between the report and the grant — the block must skip it.
    expect(leaseStartFor(grant(), 822)).toBe(823);
    // Nothing has ever been sold here.
    expect(leaseStartFor(grant(), null)).toBe(822);
  });
});
