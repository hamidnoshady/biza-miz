/**
 * Field-level merge for master data (customers, menu, tables, payment ways).
 * Pure: the database half lives in master-sync-service.ts.
 *
 * Each field is a last-writer-wins register keyed by its hybrid logical clock.
 * A phone changed on the cloud and an address changed on the desktop both
 * survive; when both sides changed the *same* field, the later edit wins. The
 * merge is commutative and idempotent — applying the same change twice, or two
 * changes in either order, gives the same row — which is what makes retries
 * and a re-read feed safe.
 */
import { hlcNewer, maxHlc, ZERO_HLC } from "./sync-hlc";

export interface MasterChange {
  table: string;
  rowId: string;
  deleted: boolean;
  /** The clock of the delete, or of the row's newest field edit. */
  rowHlc: string;
  /** Clock per edited column; a column absent here is at the zero clock. */
  clocks: Record<string, string>;
  /** The full current row as the sender holds it; null for a delete. */
  row: Record<string, unknown> | null;
}

export interface LocalMasterState {
  /** The row exists in the table. */
  exists: boolean;
  /** This side holds a tombstone for the row. */
  deleted: boolean;
  rowHlc: string | null;
  clocks: Record<string, string>;
}

export type MergePlan =
  | { action: "noop" }
  | { action: "delete"; rowHlc: string }
  /** Nothing to remove locally, but remember the delete so a stale edit cannot resurrect the row. */
  | { action: "tombstone"; rowHlc: string }
  | { action: "insert"; fields: Record<string, unknown>; clocks: Record<string, string>; incomingDominates: boolean }
  | { action: "update"; fields: Record<string, unknown>; clocks: Record<string, string>; incomingDominates: boolean };

function clockOf(clocks: Record<string, string>, column: string): string {
  return clocks[column] ?? ZERO_HLC;
}

function newestClock(clocks: Record<string, string>): string {
  return maxHlc(...Object.values(clocks));
}

function mergedClocks(
  local: Record<string, string>,
  incoming: Record<string, string>,
  columns: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of columns) {
    const clock = maxHlc(clockOf(local, column), clockOf(incoming, column));
    if (clock !== ZERO_HLC) out[column] = clock;
  }
  return out;
}

/** True when the merged row is exactly the incoming row: nothing local survived. */
function dominated(local: Record<string, string>, incoming: Record<string, string>, columns: readonly string[]): boolean {
  return columns.every((column) => !hlcNewer(clockOf(local, column), clockOf(incoming, column)));
}

/**
 * Decide what one incoming change does to the local row.
 *
 * @param columns the columns that synchronise for this table (never the
 *   excluded, derived ones)
 */
export function planMasterMerge(
  incoming: MasterChange,
  local: LocalMasterState,
  columns: readonly string[],
): MergePlan {
  const localNewest = maxHlc(newestClock(local.clocks), local.deleted ? local.rowHlc : null);

  if (incoming.deleted) {
    // A delete wins only over edits it has seen: an edit made after it (a
    // newer field clock) keeps the row alive.
    if (!hlcNewer(incoming.rowHlc, localNewest)) return { action: "noop" };
    if (local.exists) return { action: "delete", rowHlc: incoming.rowHlc };
    if (local.deleted && local.rowHlc && !hlcNewer(incoming.rowHlc, local.rowHlc)) return { action: "noop" };
    return { action: "tombstone", rowHlc: incoming.rowHlc };
  }

  const row = incoming.row;
  if (!row) return { action: "noop" };

  if (!local.exists) {
    if (local.deleted && local.rowHlc) {
      // Deleted here. Only an edit made after the delete brings it back.
      const tombstone = local.rowHlc;
      const revived = columns.some((column) => hlcNewer(clockOf(incoming.clocks, column), tombstone));
      if (!revived) return { action: "noop" };
    }
    const fields: Record<string, unknown> = {};
    for (const column of columns) if (column in row) fields[column] = row[column];
    return {
      action: "insert",
      fields,
      clocks: mergedClocks({}, incoming.clocks, columns),
      incomingDominates: true,
    };
  }

  const fields: Record<string, unknown> = {};
  for (const column of columns) {
    if (!(column in row)) continue;
    if (hlcNewer(clockOf(incoming.clocks, column), clockOf(local.clocks, column))) {
      fields[column] = row[column];
    }
  }
  if (Object.keys(fields).length === 0) return { action: "noop" };
  return {
    action: "update",
    fields,
    clocks: mergedClocks(local.clocks, incoming.clocks, columns),
    incomingDominates: dominated(local.clocks, incoming.clocks, columns),
  };
}
