/**
 * The order-number allocator's contract and arithmetic (migration 0318).
 *
 * A location's order numbers are issued by ONE authority: the cloud's
 * per-location sequence. A paired till no longer numbers its own sales; it
 * leases a block of numbers from the cloud, stores that block locally, and
 * mints inside it while it sells offline. That is what makes the sender's
 * number trustworthy on the receiving side: a number the till hands out was
 * reserved for that till before it was used, so a pulled order can keep the
 * number its receipt already shows.
 *
 * Before this, both sides kept their own `order_number_counters`, advanced
 * independently, and a pulled order whose number happened to be taken was
 * silently renumbered — the cloud showed #821 for a bill rung up as #820.
 *
 * Pure on purpose (no database import): the site-side service, the cloud route
 * and the unit suite all share this one description of a lease.
 */

/**
 * Numbers one lease reserves. 200 is five to ten trading days for a busy
 * counter and small enough that a retired till's unused tail is a footnote,
 * not a hole in the numbering.
 */
export const ORDER_NUMBER_BLOCK_SIZE = 200;

/**
 * Renew when this many numbers are left. The lease is fetched BEFORE the
 * current one is exhausted, so a cloud outage only starts to matter after the
 * remaining headroom is spent, and the next block is consumed immediately
 * after the last number of the old one (no gap on an ordinary renewal).
 */
export const ORDER_NUMBER_LEASE_LOW_WATERMARK = 20;

/** How long a failed renewal waits before trying the cloud again. */
export const ORDER_NUMBER_LEASE_RETRY_MS = 60_000;

export interface OrderNumberLeaseGrant {
  id: string;
  locationId: string;
  siteDeviceId: string;
  fromNumber: number;
  toNumber: number;
}

export interface OrderNumberLeaseWindow {
  fromNumber: number;
  toNumber: number;
  nextNumber: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Validate the cloud's answer. A malformed or out-of-scope grant must never be
 * written into the local lease table: a wrong range is a stream of numbers
 * that collides with another install's.
 */
export function parseOrderNumberLeaseGrant(value: unknown): OrderNumberLeaseGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  if (typeof grant.id !== "string" || !UUID.test(grant.id)) return null;
  if (typeof grant.locationId !== "string" || !UUID.test(grant.locationId)) return null;
  if (typeof grant.siteDeviceId !== "string" || !UUID.test(grant.siteDeviceId)) return null;
  if (!positiveSafeInteger(grant.fromNumber) || !positiveSafeInteger(grant.toNumber)) return null;
  if (grant.toNumber < grant.fromNumber) return null;
  return {
    id: grant.id,
    locationId: grant.locationId,
    siteDeviceId: grant.siteDeviceId,
    fromNumber: grant.fromNumber,
    toNumber: grant.toNumber,
  };
}

/** Numbers this lease can still hand out; never negative. */
export function leaseHeadroom(window: OrderNumberLeaseWindow): number {
  return Math.max(0, window.toNumber - window.nextNumber + 1);
}

/** True when the numbers left (across every active lease) warrant fetching another block. */
export function leaseNeedsRenewal(remaining: number): boolean {
  return remaining <= ORDER_NUMBER_LEASE_LOW_WATERMARK;
}

/**
 * The first number a locally recorded lease may hand out. The cloud starts the
 * block above the highest number the site reported, but a local order created
 * between that report and the grant must still never be shadowed.
 */
export function leaseStartFor(grant: OrderNumberLeaseGrant, highestLocalOrderNumber: number | null): number {
  return Math.max(grant.fromNumber, (highestLocalOrderNumber ?? 0) + 1);
}

/** True when `number` is a valid order number this allocator may hand out. */
export function isOrderNumberValue(value: unknown): value is number {
  return positiveSafeInteger(value);
}
