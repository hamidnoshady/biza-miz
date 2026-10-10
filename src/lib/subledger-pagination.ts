/** Offset windows over a live, deterministically ordered subledger (not a snapshot).
 * No offset clamp: repeating an earlier window is never a valid continuation.
 * Legacy callers without paging/search parameters still receive the full list.
 */
export const SUBLEDGER_PAGE_SIZE = 25;
export const SUBLEDGER_MAX_PAGE_SIZE = 200;

export function validateSubledgerWindow(limit: number, offset: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUBLEDGER_MAX_PAGE_SIZE ||
      !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("invalid_pagination");
  }
}

export function parseSubledgerWindow(params: URLSearchParams): { limit: number; offset: number } | null {
  if (!["limit", "offset", "q"].some((key) => params.has(key))) return null;
  const integer = (key: string, fallback: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error("invalid_pagination");
    return Number(raw);
  };
  const limit = integer("limit", SUBLEDGER_PAGE_SIZE);
  const offset = integer("offset", 0);
  validateSubledgerWindow(limit, offset);
  return { limit, offset };
}

/** Advance by consumed server rows, never by the browser's deduplicated count. */
export function subledgerNextOffset(offset: number, returned: number, total: number): number | null {
  const next = offset + returned;
  return returned > 0 && Number.isSafeInteger(next) && next < total ? next : null;
}
