/**
 * Issue #1076 — the plugin-local queue page protocol, the pure half.
 *
 * In plugin mode the app never dials the store, so a page of the plugin's own
 * `{prefix}pos_connector_queue` travels over the handshake lane it already
 * uses: the queue screen records a request, the next handshake response hands
 * that request to the plugin, and the handshake after that carries the answer.
 *
 * Both directions are validated here and nowhere else, so the stored mailbox
 * on `integration_connections` can never hold a payload, a credential or an
 * unbounded list — only the same metadata field set the aggregate strip shows.
 */

export interface LocalQueuePageRequest {
  /** Exclusive lower bound: return rows with `id` greater than this. */
  after: number;
  /** Bounded page size — the same ceiling the plugin enforces. */
  limit: number;
  /** When the operator asked, so the screen can say «درخواست شده». */
  requestedAt: string;
}

export interface LocalQueuePageRow {
  topic: string;
  remoteId: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
}

export interface LocalQueuePageAnswer {
  after: number;
  limit: number;
  rows: LocalQueuePageRow[];
  /** Cursor for the next page, or null when the plugin queue has been walked. */
  next: number | null;
  answeredAt: string;
}

export const LOCAL_QUEUE_PAGE_MAX = 25;
export const LOCAL_QUEUE_PAGE_DEFAULT = 10;
/** A row id is a BIGINT in the plugin's own table; anything larger is a lie. */
const MAX_ROW_ID = 2_147_483_647;
const MAX_ROWS = LOCAL_QUEUE_PAGE_MAX;

function cursor(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_ROW_ID) return null;
  return n;
}

function stamp(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const trimmed = value.slice(0, 40);
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

/** `after`/`limit` from an operator request; null when either is unusable. */
export function normaliseLocalQueuePageRequest(after: unknown, limit: unknown, now: Date = new Date()): LocalQueuePageRequest | null {
  const start = cursor(after ?? 0);
  const size = cursor(limit ?? LOCAL_QUEUE_PAGE_DEFAULT);
  if (start === null || size === null || size < 1) return null;
  return { after: start, limit: Math.min(LOCAL_QUEUE_PAGE_MAX, size), requestedAt: now.toISOString() };
}

/** Reads one stored request back — used by the handshake and by the screen. */
export function parseLocalQueuePageRequest(value: unknown): LocalQueuePageRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const after = cursor(record.after);
  const limit = cursor(record.limit);
  const requestedAt = stamp(record.requestedAt);
  if (after === null || limit === null || limit < 1 || !requestedAt) return null;
  return { after, limit: Math.min(LOCAL_QUEUE_PAGE_MAX, limit), requestedAt };
}

/**
 * The plugin's answer, reduced to something safe to store and render: at most
 * `LOCAL_QUEUE_PAGE_MAX` rows, each with the aggregate strip's field set. A
 * malformed row is dropped, never repaired into a fake one; an answer with no
 * usable rows is still valid (the walked range was empty).
 */
export function sanitizeLocalQueuePageAnswer(value: unknown, now: Date = new Date()): LocalQueuePageAnswer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const after = cursor(record.after);
  const limit = cursor(record.limit);
  if (after === null || limit === null || limit < 1) return null;
  if (!Array.isArray(record.rows)) return null;

  const rows: LocalQueuePageRow[] = [];
  for (const item of record.rows.slice(0, MAX_ROWS)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const topic = typeof row.topic === "string" ? row.topic.slice(0, 80) : "";
    if (!topic) continue;
    rows.push({
      topic,
      remoteId: typeof row.remoteId === "string" ? row.remoteId.slice(0, 80) : "",
      status: row.status === "failed" ? "failed" : "pending",
      attempts: Number.isFinite(Number(row.attempts)) ? Math.max(0, Math.floor(Number(row.attempts))) : 0,
      lastError: typeof row.lastError === "string" && row.lastError ? row.lastError.slice(0, 240) : null,
      createdAt: typeof row.createdAt === "string" && row.createdAt ? row.createdAt.slice(0, 40) : null,
    });
  }

  const next = cursor(record.next);
  return {
    after,
    limit: Math.min(LOCAL_QUEUE_PAGE_MAX, limit),
    rows,
    // `next` must move forward, or a screen that follows it would ask for the
    // same page forever.
    next: next !== null && next > after ? next : null,
    answeredAt: stamp(record.answeredAt) ?? now.toISOString(),
  };
}

/** Reads one stored answer back, refusing anything this app did not write. */
export function parseLocalQueuePageAnswer(value: unknown): LocalQueuePageAnswer | null {
  return sanitizeLocalQueuePageAnswer(value);
}
