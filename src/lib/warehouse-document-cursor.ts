/**
 * The warehouse register's keyset cursor — encode/decode, with no database.
 *
 * The register is ordered by `(created_at DESC, id)` so equal timestamps
 * still page deterministically, and an offset window would drift while
 * receipts/issues keep posting. The cursor is the last row's full sort key,
 * and the next page asks for rows strictly before it:
 *   WHERE (created_at, id) < ($cursorCreatedAt, $cursorId)
 *
 * A malformed `?cursor=` is attacker-reachable input, so it is decoded and
 * *validated* here: the routes only ever compare typed parameters they have
 * parsed, never interpolate a raw string.
 */
const ISO_TIMESTAMPTZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WarehouseDocumentCursor {
  createdAt: string;
  id: string;
}

/** `?cursor=` is a plain delimited string: readable in a log, pure ASCII. */
export function encodeWarehouseDocumentCursor(cursor: WarehouseDocumentCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`).toString("base64url");
}

/**
 * Parse a `?cursor=` value, or `null` when it is not one.
 *
 * `null` rather than a throw because the caller answers a malformed cursor
 * with `400 bad_request` — the same answer as any other unusable parameter.
 */
export function decodeWarehouseDocumentCursor(
  raw: string | null | undefined,
): WarehouseDocumentCursor | null {
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const [createdAt, id] = decoded.split("|");
  if (!createdAt || !id) return null;
  if (!ISO_TIMESTAMPTZ_RE.test(createdAt)) return null;
  if (!UUID_RE.test(id)) return null;
  return { createdAt, id };
}
