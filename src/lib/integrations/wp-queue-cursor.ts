/**
 * Issue #1077 — the keyset cursor for the WP/Woo queue's deep history.
 *
 * Database-free on purpose (the queue route and its tests both import it).
 * The queue's shallow page-number navigation keeps its filtered totals; this
 * opaque token is only for walking deep history without OFFSET drift.
 *
 * The token is `base64url(JSON{c,i})` and is validated on the way back in, so
 * a hand-written `?cursor=` cannot reach the SQL as anything but a timestamp
 * and a row id. Treat it as opaque: it names a position, never filters.
 */

export interface WpQueueCursor {
  /** `created_at` of the last row the caller already has, ISO-8601 from Postgres. */
  createdAt: string;
  /** The id of that same row — the tie-breaker for rows sharing one timestamp. */
  id: string;
}

const MAX_CURSOR_LENGTH = 160;
const MAX_TIMESTAMP_LENGTH = 40;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

export function encodeWpQueueCursor(cursor: WpQueueCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, i: cursor.id }), "utf8").toString("base64url");
}

/**
 * Returns null for anything that is not a cursor this app minted: a missing or
 * oversized token, bad base64, a non-object payload, a timestamp Postgres would
 * reject, or an id that is not a uuid.
 */
export function parseWpQueueCursor(value: unknown): WpQueueCursor | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > MAX_CURSOR_LENGTH) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;

  const { c, i } = decoded as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string") return null;
  if (c.length > MAX_TIMESTAMP_LENGTH || !TIMESTAMP_PATTERN.test(c) || Number.isNaN(Date.parse(c))) return null;
  if (!UUID_PATTERN.test(i)) return null;

  return { createdAt: c, id: i };
}
