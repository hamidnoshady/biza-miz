/**
 * Issue #907 F10 — one definition of "a party a workspace picker may show".
 *
 * The workspace pickers used to read the business's whole party list in one
 * `LIMIT 500`: a customer after the five-hundredth name simply did not exist
 * for the contract form, and nothing said so. The searchable picker now asks
 * this module for a page of names instead, filtered by what the member typed
 * and resolved against the row already selected, so the picker reaches the
 * whole directory without loading it.
 *
 * Everything here answers with an id and a display name and nothing else —
 * the route that calls it is gated on `workspace.view` plus the workspace's
 * own write flags, not on `parties.view`, so this must never grow a phone,
 * an address or a balance column. The full party record stays behind
 * `/api/parties` and its own permission.
 */
import { query } from "./db";

/** One page of a picker's search results. */
export const WORKSPACE_PARTY_PAGE_SIZE = 25;
export const WORKSPACE_PARTY_MAX_PAGE_SIZE = 100;
/**
 * The list that still travels with the shared lookups read, for the pickers
 * that have no search box yet. Kept at the width the response already had so
 * those screens do not silently lose rows; the response now also reports the
 * true total and whether more exist, so the truncation is visible rather than
 * implied, and a search box is the way past it.
 */
export const WORKSPACE_PARTY_INITIAL_PAGE_SIZE = 500;
export const WORKSPACE_PARTY_MAX_TERM = 80;
export const WORKSPACE_PARTY_MAX_SELECTED = 50;

export interface WorkspacePartyOption {
  id: string;
  name: string;
}

export interface WorkspacePartyPage {
  /** The rows matching the term, in name order. */
  parties: WorkspacePartyOption[];
  /** The ids the caller asked to resolve, regardless of the term or page. */
  selected: WorkspacePartyOption[];
  /** How many parties match the term before pagination. */
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function emptyWorkspacePartyPage(
  pageSize = WORKSPACE_PARTY_PAGE_SIZE,
): WorkspacePartyPage {
  return { parties: [], selected: [], total: 0, page: 1, pageSize, hasMore: false };
}

/** Trim, collapse runs of whitespace, and bound what a term can cost a scan. */
export function normalizePartySearchTerm(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, WORKSPACE_PARTY_MAX_TERM);
}

function positiveInteger(
  raw: string | number | null | undefined,
  fallback: number,
  max: number,
): number {
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

/** One place decides what a `?page=` may be, so paging cannot be unbounded. */
export function partyPageRequest(input: {
  page?: string | number | null;
  pageSize?: string | number | null;
}): { page: number; pageSize: number; offset: number } {
  const page = positiveInteger(input.page, 1, 10_000);
  const pageSize = positiveInteger(
    input.pageSize,
    WORKSPACE_PARTY_PAGE_SIZE,
    WORKSPACE_PARTY_MAX_PAGE_SIZE,
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids a picker already holds, from `?ids=a,b`. Anything that is not a
 * uuid is dropped rather than sent to Postgres, so a malformed query is an
 * empty resolution, never a 500.
 */
export function partyIdsFrom(
  raw: string | null | undefined,
  limit = WORKSPACE_PARTY_MAX_SELECTED,
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const value of raw.split(",")) {
    const id = value.trim();
    if (!UUID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/** `%` and `_` are the member's literal characters here, not wildcards. */
function likeTerm(term: string): string {
  return term ? `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%` : "";
}

export async function searchWorkspaceParties(
  businessId: string,
  input: { q?: string; page?: number; pageSize?: number; ids?: string[] } = {},
): Promise<WorkspacePartyPage> {
  const { page, pageSize, offset } = partyPageRequest({
    page: input.page,
    pageSize: input.pageSize,
  });
  const term = normalizePartySearchTerm(input.q);
  const pattern = likeTerm(term);
  const ids = (input.ids ?? [])
    .filter((id) => UUID.test(id))
    .slice(0, WORKSPACE_PARTY_MAX_SELECTED);

  // Same tenant, same "live party" rule as every other picker: an archived
  // record and a duplicate merged into another are not choices.
  const filters = "business_id = $1 AND is_active AND merged_into_id IS NULL AND ($2 = '' OR name ILIKE $2)";

  const [rows, counted, chosen] = await Promise.all([
    query<{ id: string; name: string }>(
      `SELECT id, name FROM parties WHERE ${filters} ORDER BY name, id LIMIT $3 OFFSET $4`,
      [businessId, pattern, pageSize, offset],
    ),
    query<{ total: string }>(`SELECT count(*)::text AS total FROM parties WHERE ${filters}`, [
      businessId,
      pattern,
    ]),
    // The row the form is already showing is resolved by id, not by the term:
    // opening an edit panel must not blank the field, and the selected party
    // must still be named even when it is archived or outside this page.
    ids.length > 0
      ? query<{ id: string; name: string }>(
          "SELECT id, name FROM parties WHERE business_id = $1 AND id::text = ANY($2::text[])",
          [businessId, ids],
        )
      : Promise.resolve({ rows: [] as Array<{ id: string; name: string }> }),
  ]);

  return {
    parties: rows.rows.map((row) => ({ id: row.id, name: row.name })),
    selected: chosen.rows.map((row) => ({ id: row.id, name: row.name })),
    total: Number(counted.rows[0]?.total ?? 0),
    page,
    pageSize,
    hasMore: offset + rows.rows.length < Number(counted.rows[0]?.total ?? 0),
  };
}
