/**
 * The reconciliation list's keyset cursor — encode/decode, with no database.
 *
 * A paged candidate list needs a position, and `OFFSET` is the wrong one here:
 * the list is ordered by document date and its rows change status (ticked,
 * unticked) while the reader scrolls, so an offset window drifts and can skip
 * or repeat a line between two requests. The cursor is the last row's full
 * sort key instead, and the next page asks for rows strictly after it.
 *
 * Split into its own file so `bank-reconciliation.test.ts` can pin the
 * round-trip without the rest of the framework-free module growing a second
 * concern, and because a malformed cursor is attacker-reachable input: it is
 * decoded and *validated* here, so the service never interpolates a string it
 * has not parsed into a `date`/`uuid`/`bigint` comparison.
 */

export interface ReconciliationCursor {
  entryDate: string;
  postedAt: string;
  entryId: string;
  journalLineId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `?cursor=` is a plain delimited string: readable in a log, and pure ASCII. */
export function encodeReconciliationCursor(cursor: ReconciliationCursor): string {
  return [cursor.entryDate, cursor.postedAt, cursor.entryId, cursor.journalLineId].join("|");
}

/**
 * Parse a `?cursor=` value, or `null` when it is not one.
 *
 * `null` rather than a throw because the caller answers a malformed cursor
 * with `400 bad_request` — the same answer as any other unusable parameter.
 * Every part is shape-checked so the service can hand them to Postgres as
 * typed parameters without a cast error escaping as a 500.
 */
export function decodeReconciliationCursor(raw: string | null | undefined): ReconciliationCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  const [entryDate, postedAt, entryId, journalLineId] = parts;
  if (!ISO_DATE_RE.test(entryDate)) return null;
  if (!postedAt || !entryId || !journalLineId) return null;
  if (!UUID_RE.test(entryId)) return null;
  if (!/^\d+$/.test(journalLineId)) return null;
  return { entryDate, postedAt, entryId, journalLineId };
}
