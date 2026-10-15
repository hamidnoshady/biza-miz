import { toLatinDigits } from "./digits";

export const SHAREHOLDER_PERCENT_SCALE = 1_000_000n;
export const FULL_OWNERSHIP_MICRO_PERCENT = 100n * SHAREHOLDER_PERCENT_SCALE;
export const SHAREHOLDER_ACCOUNT_CODES = {
  capital: "3100",
  additionalPaidInCapital: "3150",
  withdrawals: "3200",
  shareholderLoans: "2510",
  distributionsPayable: "2520",
  retainedEarnings: "3800",
} as const;

export type OwnershipTotalPolicy = "at_most_100" | "exactly_100";
export type OwnershipEventType =
  | "shareholder_added"
  | "ownership_changed"
  | "shareholder_removed"
  | "ownership_transfer_out"
  | "ownership_transfer_in";

export interface OwnershipTimelineEvent {
  partyId: string;
  eventType: OwnershipEventType;
  effectiveOn: string;
  /** Database numeric text, or an integer in micro-percent units. */
  ownershipPercent: string | bigint;
  transferPercent?: string | bigint | null;
  transferGroupId?: string | null;
}

export interface OwnershipTimelineError {
  code:
    | "invalid_ownership_event"
    | "duplicate_shareholder_event_date"
    | "ownership_add_requires_inactive_shareholder"
    | "ownership_change_requires_active_shareholder"
    | "ownership_remove_requires_active_shareholder"
    | "ownership_transfer_pair_invalid"
    | "ownership_transfer_out_exceeds_current"
    | "ownership_transfer_in_invalid"
    | "ownership_total_exceeds_100"
    | "ownership_total_must_equal_100";
  effectiveOn?: string;
  partyId?: string;
}

/**
 * Decimal percent → integer micro-percent. No binary floating point enters an
 * ownership calculation; 1.234567% is exactly 1,234,567 micro-percent.
 */
export function parseOwnershipPercent(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const raw = toLatinDigits(String(value)).trim().replace(/٬/g, "").replace(/,/g, "").replace(/٫/g, ".");
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(raw)) return null;
  const [integer, fraction = ""] = raw.split(".");
  const units = BigInt(integer) * SHAREHOLDER_PERCENT_SCALE + BigInt((fraction + "000000").slice(0, 6));
  return units <= FULL_OWNERSHIP_MICRO_PERCENT ? units : null;
}

export function formatOwnershipPercent(units: bigint): string {
  if (units < 0n || units > FULL_OWNERSHIP_MICRO_PERCENT) throw new Error("invalid_ownership_percent");
  const whole = units / SHAREHOLDER_PERCENT_SCALE;
  const fraction = (units % SHAREHOLDER_PERCENT_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Integer Rial parser used by every shareholder posting form. */
export function parsePositiveRial(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const raw = toLatinDigits(String(value)).replace(/[٬,\s]/g, "").trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  try {
    const amount = BigInt(raw);
    return amount <= 9_223_372_036_854_775_807n ? amount : null;
  } catch {
    return null;
  }
}

export function parseNonNegativeRial(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const raw = toLatinDigits(String(value)).replace(/[٬,\s]/g, "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  try {
    const amount = BigInt(raw);
    return amount <= 9_223_372_036_854_775_807n ? amount : null;
  } catch {
    return null;
  }
}

/**
 * Validate the complete event stream as it will stand after a write. Events on
 * the same effective date are applied as one atomic snapshot, so transfers can
 * exchange one owner's post-event percentage for another's without a transient
 * over-allocation. The caller enforces one event per party/date in PostgreSQL.
 */
export function validateOwnershipTimeline(
  events: readonly OwnershipTimelineEvent[],
  policy: OwnershipTotalPolicy,
): OwnershipTimelineError | null {
  const normalized: Array<OwnershipTimelineEvent & { ownershipUnits: bigint; transferUnits: bigint | null }> = [];
  for (const event of events) {
    const ownershipUnits = parseStoredPercent(event.ownershipPercent);
    const transferUnits = event.transferPercent == null ? null : parseStoredPercent(event.transferPercent);
    if (
      !event.partyId ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.effectiveOn) ||
      ownershipUnits === null ||
      (event.eventType.startsWith("ownership_transfer_") && (transferUnits === null || !event.transferGroupId)) ||
      (!event.eventType.startsWith("ownership_transfer_") && (transferUnits !== null || event.transferGroupId != null))
    ) {
      return { code: "invalid_ownership_event", effectiveOn: event.effectiveOn, partyId: event.partyId };
    }
    normalized.push({ ...event, ownershipUnits, transferUnits });
  }

  normalized.sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn) || a.partyId.localeCompare(b.partyId));
  const owners = new Map<string, bigint>();
  let cursor = 0;
  while (cursor < normalized.length) {
    const effectiveOn = normalized[cursor].effectiveOn;
    const start = cursor;
    while (cursor < normalized.length && normalized[cursor].effectiveOn === effectiveOn) cursor += 1;
    const batch = normalized.slice(start, cursor);
    const seenParties = new Set<string>();
    for (const event of batch) {
      if (seenParties.has(event.partyId)) {
        return { code: "duplicate_shareholder_event_date", effectiveOn, partyId: event.partyId };
      }
      seenParties.add(event.partyId);
    }

    const transferGroups = new Map<string, typeof batch>();
    for (const event of batch) {
      if (event.transferGroupId) {
        const group = transferGroups.get(event.transferGroupId) ?? [];
        group.push(event);
        transferGroups.set(event.transferGroupId, group);
      }
    }
    for (const [groupId, pair] of transferGroups) {
      const outgoing = pair.filter((event) => event.eventType === "ownership_transfer_out");
      const incoming = pair.filter((event) => event.eventType === "ownership_transfer_in");
      if (
        pair.length !== 2 || outgoing.length !== 1 || incoming.length !== 1 ||
        outgoing[0].partyId === incoming[0].partyId ||
        outgoing[0].transferUnits !== incoming[0].transferUnits ||
        outgoing[0].effectiveOn !== incoming[0].effectiveOn ||
        !groupId
      ) {
        return { code: "ownership_transfer_pair_invalid", effectiveOn };
      }
    }

    // The per-party unique event rule means these updates do not conflict and
    // can be evaluated in any deterministic order within the atomic date.
    for (const event of batch) {
      const previous = owners.get(event.partyId) ?? 0n;
      const next = event.ownershipUnits;
      switch (event.eventType) {
        case "shareholder_added":
          if (previous !== 0n || next === 0n) {
            return { code: "ownership_add_requires_inactive_shareholder", effectiveOn, partyId: event.partyId };
          }
          break;
        case "ownership_changed":
          if (previous === 0n || next === 0n) {
            return { code: "ownership_change_requires_active_shareholder", effectiveOn, partyId: event.partyId };
          }
          break;
        case "shareholder_removed":
          if (previous === 0n || next !== 0n) {
            return { code: "ownership_remove_requires_active_shareholder", effectiveOn, partyId: event.partyId };
          }
          break;
        case "ownership_transfer_out":
          if (event.transferUnits === null || previous - next !== event.transferUnits || event.transferUnits <= 0n) {
            return { code: "ownership_transfer_out_exceeds_current", effectiveOn, partyId: event.partyId };
          }
          break;
        case "ownership_transfer_in":
          if (event.transferUnits === null || next - previous !== event.transferUnits || event.transferUnits <= 0n) {
            return { code: "ownership_transfer_in_invalid", effectiveOn, partyId: event.partyId };
          }
          break;
      }
      owners.set(event.partyId, next);
    }

    const total = [...owners.values()].reduce((sum, units) => sum + units, 0n);
    if (total > FULL_OWNERSHIP_MICRO_PERCENT) return { code: "ownership_total_exceeds_100", effectiveOn };
    if (policy === "exactly_100" && total !== FULL_OWNERSHIP_MICRO_PERCENT) {
      return { code: "ownership_total_must_equal_100", effectiveOn };
    }
  }
  return null;
}

/**
 * Allocate an integer-Rial amount by exact integer weights using the largest
 * remainder method. Ties resolve by stable key, so retries produce byte-for-
 * byte identical snapshots and the allocated values always add back exactly.
 */
export function allocateRialByWeight<T extends { key: string; weight: bigint }>(
  totalRial: bigint,
  recipients: readonly T[],
): Array<T & { amountRial: bigint }> {
  if (totalRial < 0n || recipients.length === 0 || recipients.some((row) => row.weight < 0n)) {
    throw new Error("invalid_allocation_input");
  }
  const totalWeight = recipients.reduce((sum, row) => sum + row.weight, 0n);
  if (totalWeight <= 0n) throw new Error("empty_allocation_weights");

  const rows = recipients.map((recipient) => {
    const numerator = totalRial * recipient.weight;
    return {
      ...recipient,
      amountRial: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  let remaining = totalRial - rows.reduce((sum, row) => sum + row.amountRial, 0n);
  const remainderOrder = [...rows].sort((a, b) =>
    a.remainder === b.remainder ? a.key.localeCompare(b.key) : a.remainder > b.remainder ? -1 : 1,
  );
  for (let index = 0; remaining > 0n; index += 1, remaining -= 1n) {
    remainderOrder[index % remainderOrder.length].amountRial += 1n;
  }
  const amounts = new Map(rows.map((row) => [row.key, row.amountRial]));
  return rows.map(({ remainder: _remainder, ...row }) => ({
    ...row,
    amountRial: amounts.get(row.key)!,
  })) as Array<T & { amountRial: bigint }>;
}

/** A profit distribution requires a complete legal snapshot, even in at-most mode. */
export function ownershipSnapshotIsComplete(
  rows: readonly { ownershipPercent: string | bigint }[],
): boolean {
  const total = rows.reduce((sum, row) => {
    const units = parseStoredPercent(row.ownershipPercent);
    return sum + (units ?? 0n);
  }, 0n);
  return total === FULL_OWNERSHIP_MICRO_PERCENT;
}

/**
 * Recompute the post-close source-profit number using only the existing closing
 * entry's credit to retained earnings. Does not create or alter a close.
 */
export function closingEntryProfitRial(input: { debit: bigint; credit: bigint }): bigint {
  const profit = input.credit - input.debit;
  return profit > 0n ? profit : 0n;
}

function parseStoredPercent(value: string | bigint): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= FULL_OWNERSHIP_MICRO_PERCENT ? value : null;
  const parsed = parseOwnershipPercent(value);
  return parsed;
}
