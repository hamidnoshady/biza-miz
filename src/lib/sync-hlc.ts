/**
 * Hybrid logical clock stamps, as minted by `app_sync_next_hlc()` (migration
 * 0190): `<15-digit ms>.<15-digit sequence>.<node id>`. Fixed-width, so "which
 * edit is newer" is a plain string comparison on every node, in SQL and here
 * alike. Pure, so the merge rules built on it can be unit-tested.
 */

/** The clock of a field nobody has edited since tracking began. */
export const ZERO_HLC = "000000000000000.000000000000000.";

const HLC_PATTERN = /^[0-9]{15}\.[0-9]{15}\.[0-9a-z]{0,32}$/;

export function isHlc(value: unknown): value is string {
  return typeof value === "string" && HLC_PATTERN.test(value);
}

/** Strictly newer. Two stamps from different nodes are never equal. */
export function hlcNewer(a: string, b: string): boolean {
  return a > b;
}

export function maxHlc(...stamps: (string | null | undefined)[]): string {
  let best = ZERO_HLC;
  for (const stamp of stamps) if (stamp && stamp > best) best = stamp;
  return best;
}

/** The node that minted a stamp; empty for the zero clock. */
export function hlcNode(stamp: string): string {
  return stamp.split(".")[2] ?? "";
}
