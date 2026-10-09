/**
 * Optimistic concurrency for the price-list matrix (audit F14).
 *
 * The matrix is a long-lived editing session: a manager opens it, types for a
 * while, and presses «ذخیره قیمت‌ها». Before this module the save was
 * last-write-wins — a colleague's price change (or a «بروزرسانی سریع» run) made
 * after the page loaded was silently replaced by whatever this screen held.
 *
 * Each `price_list_entries` row already carries `updated_at`, bumped by every
 * writer (the matrix save and quick update). Its value in microseconds since the
 * epoch is the row's *version*: the screen keeps the version each cell had when
 * it loaded and sends it back with every edited cell; the server compares under
 * a row lock and applies only the cells whose row has not moved since.
 *
 * Framework- and database-free on purpose: the client imports the key/format
 * helpers, and the decision table (`planEntrySave`) is unit-tested without
 * Postgres. The service in `price-lists-service.ts` does the locking and SQL.
 */

/** One stored cell as the server reads it under lock. */
export interface EntryVersion {
  price: number;
  /** `updated_at` in microseconds since the epoch, as a decimal string. */
  version: string;
  /** `updated_at` as ISO-8601 — the "when" a conflict reports. */
  updatedAt: string;
}

export interface VersionedEntryUpdate {
  priceListId: string;
  itemId: string;
  /** Rial; null clears the cell. */
  price: number | null;
  /**
   * The version the editor loaded for this cell:
   *   - a version string — the row existed with that version;
   *   - `null` — the cell was empty when the editor loaded it;
   *   - absent (`undefined`) — an older client that sends no version: the
   *     write is unconditional, exactly as before this check existed.
   */
  expectedVersion?: string | null;
}

/** A cell the server refused because its row changed after the editor loaded it. */
export interface EntryConflict {
  priceListId: string;
  itemId: string;
  /** What this save asked for (Rial, null = clear). Not applied. */
  requestedPrice: number | null;
  /** What the row holds now (Rial), or null when the cell is now empty. */
  currentPrice: number | null;
  /** The row's current version — what a deliberate overwrite must send. */
  currentVersion: string | null;
  /** When the row last changed (ISO), or null when it no longer exists. */
  updatedAt: string | null;
}

export interface EntryInsert {
  update: VersionedEntryUpdate;
  /**
   * A strict insert expected the cell to be empty; if another session inserts
   * the same cell first it must surface as a conflict, not overwrite it. A
   * loose insert (no version sent) keeps the old upsert semantics.
   */
  strict: boolean;
}

export interface EntrySavePlan {
  /** Existing rows (locked, version matched or unconditional) to set. */
  updates: VersionedEntryUpdate[];
  /** Cells with no row at lock time. */
  inserts: EntryInsert[];
  /** Existing rows to delete. */
  deletes: VersionedEntryUpdate[];
  conflicts: EntryConflict[];
}

export function entryKey(priceListId: string, itemId: string): string {
  return `${priceListId}:${itemId}`;
}

/** Microseconds since the epoch fit in 17 digits for millennia; 20 bounds a bigint. */
const VERSION_PATTERN = /^\d{1,20}$/;

/** `undefined` (no check), `null` (expected empty) or a well-formed version. */
export function isValidExpectedVersion(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || (typeof value === "string" && VERSION_PATTERN.test(value));
}

export function conflictFor(update: VersionedEntryUpdate, current: EntryVersion | undefined): EntryConflict {
  return {
    priceListId: update.priceListId,
    itemId: update.itemId,
    requestedPrice: update.price,
    currentPrice: current?.price ?? null,
    currentVersion: current?.version ?? null,
    updatedAt: current?.updatedAt ?? null,
  };
}

/**
 * Decide, per cell, what the save does given the rows as they are *now*
 * (read under `FOR UPDATE`, keyed by `entryKey`).
 *
 * The rules:
 *   1. No version sent → unconditional (the pre-check behaviour).
 *   2. Version sent and the row is still at it (or still absent when `null`
 *      was sent) → apply.
 *   3. The row moved, but already holds exactly the requested value → nothing
 *      to do and nothing to report: two people made the same change.
 *   4. Otherwise → conflict; the cell is not written.
 *
 * A write whose value equals the stored one is skipped rather than rewritten,
 * so a no-op does not bump the version under another open editor.
 */
export function planEntrySave(
  cells: readonly VersionedEntryUpdate[],
  current: ReadonlyMap<string, EntryVersion>,
): EntrySavePlan {
  const plan: EntrySavePlan = { updates: [], inserts: [], deletes: [], conflicts: [] };
  for (const cell of cells) {
    const now = current.get(entryKey(cell.priceListId, cell.itemId));
    const alreadyThere = cell.price === null ? now === undefined : now?.price === cell.price;
    if (alreadyThere) continue;

    if (cell.expectedVersion !== undefined) {
      const unchanged =
        cell.expectedVersion === null ? now === undefined : now?.version === cell.expectedVersion;
      if (!unchanged) {
        plan.conflicts.push(conflictFor(cell, now));
        continue;
      }
    }

    if (cell.price === null) plan.deletes.push(cell);
    else if (now) plan.updates.push(cell);
    else plan.inserts.push({ update: cell, strict: cell.expectedVersion !== undefined });
  }
  return plan;
}
