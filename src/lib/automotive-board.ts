/**
 * Issue #839 §19 — the branch board's own vocabulary, in a module the browser
 * can hold.
 *
 * The desktop's «موجودی همگام‌شده» screen is a `"use client"` component, so it
 * may not reach a server module through *value* imports: doing so drags
 * `node:crypto`, `pg` and the database pool into the browser bundle, which is a
 * `next build` failure that type-check, ESLint and the unit suite all pass
 * straight through. `src/lib/client-bundle-boundary.test.ts` enforces that rule,
 * and it caught exactly this screen — it had been importing the availability
 * labels and the ageing helper from `automotive-stock-projection.ts`, the wire
 * contract that hashes snapshots with `node:crypto`.
 *
 * The fix is the one that test's own header describes: put the data where the
 * client can take it. What lives here is the *board's* vocabulary — how a car
 * reads on the lot, and how long it has been there. Nothing here computes,
 * validates or stores anything: the projection module still owns the snapshot
 * shape, its hash and its validation, and imports these values from here rather
 * than the other way round.
 */
import type { VehicleState } from "./automotive";

/** How the board reads one car: available, on hold, gone. */
export const VEHICLE_AVAILABILITY_VALUES = ["available", "reserved", "sold", "unavailable"] as const;
export type VehicleAvailability = (typeof VEHICLE_AVAILABILITY_VALUES)[number];

/**
 * The four words the lot actually uses. A mirrored car is *read-only* offline:
 * these labels describe the cloud's answer, never a local decision.
 */
export const VEHICLE_AVAILABILITY_LABELS: Record<VehicleAvailability, string> = {
  available: "آماده فروش",
  reserved: "رزروشده",
  sold: "فروخته‌شده",
  unavailable: "غیرقابل عرضه",
};

/**
 * The mirror row a business-local ISO date is compared against for ageing.
 *
 * Business-local on both sides, deliberately: «۱۲ روز در انبار» has to agree
 * with the branch's own day (see `businessToday`), not with UTC — a car
 * acquired yesterday evening would otherwise age a day early.
 */
export function mirrorDaysInStock(acquiredOn: string | null, today: string): number | null {
  if (!acquiredOn) return null;
  const from = Date.parse(`${acquiredOn}T00:00:00.000Z`);
  const to = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/**
 * The state the board shows for a car, derived rather than stored: an active
 * hold wins over the car's own state, `sold` and `archived` are terminal as
 * they say, and `transferred` reads unavailable because during a branch
 * transfer the car is on neither lot. `draft`/`acquired`/`returned` are still
 * sellable, so they read as available.
 */
export function availabilityForVehicle(input: {
  state: VehicleState;
  hasActiveReservation: boolean;
}): VehicleAvailability {
  if (input.hasActiveReservation) return "reserved";
  if (input.state === "sold") return "sold";
  if (input.state === "reserved") return "reserved";
  if (input.state === "archived" || input.state === "transferred") return "unavailable";
  return "available";
}
