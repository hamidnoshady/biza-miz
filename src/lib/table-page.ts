/**
 * One page of a client-side table — dashboard audit F14.
 *
 * The price editor rendered every one of a store's 1,685 items, each with
 * several inputs, in a single table. It now draws one bounded page; the edits
 * themselves live in a matrix keyed by item, so moving between pages, or
 * filtering, never drops a typed price. This is the arithmetic: the requested
 * page clamped to what exists, and the half-open row range it covers.
 */
export interface TablePageWindow {
  page: number;
  pageCount: number;
  /** First row index on the page (inclusive). */
  start: number;
  /** One past the last row index on the page. */
  end: number;
}

export function tablePageWindow(total: number, page: number, pageSize: number): TablePageWindow {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const clamped = Math.min(pageCount, Math.max(1, Math.floor(page) || 1));
  const start = (clamped - 1) * size;
  return { page: clamped, pageCount, start, end: Math.min(Math.max(0, total), start + size) };
}

/** The page a row index sits on, so a jump to "the first edited row" lands on it. */
export function tablePageOfIndex(index: number, pageSize: number): number {
  return Math.floor(Math.max(0, index) / Math.max(1, Math.floor(pageSize))) + 1;
}
