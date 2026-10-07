/**
 * «دفتر روزنامه» — the DB-touching half.
 *
 * One query builder serves the screen's page, the export's complete result and
 * the filter pickers, so «خروجی کامل» can never answer a different question
 * than the list above it. The rules it applies (what a valid filter is, what a
 * cursor means, how an exact BIGINT total is summed) are the framework-free
 * `journal-filters.ts`; this module only turns them into SQL.
 *
 * DB-touching, so per repo convention it has no direct unit test — its rules
 * are tested through `journal-filters.test.ts`, its route through
 * `src/app/api/ledger/entries/route.test.ts`, and its behaviour end to end
 * through `integration/manual-journal.integration.test.ts`.
 */
import { query } from "./db";
import {
  encodeJournalCursor,
  JOURNAL_EXPORT_ROW_CAP,
  journalEntryTotalText,
  type JournalFilters,
} from "./journal-filters";

export interface JournalLineRecord {
  entryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Exact Rial, as a decimal string — `journal_lines.debit` is BIGINT. */
  debit: string;
  credit: string;
}

/**
 * A journal document with the audit metadata the model already carries.
 *
 * The compact list shows a handful of these; the rest are what the entry's
 * detail panel exists to answer — "which branch", "which source document",
 * "who reversed it and when". They were in the table all along and the screen
 * simply never returned them.
 */
export interface JournalEntryRecord {
  id: string;
  entryDate: string;
  postedAt: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  locationId: string | null;
  locationName: string | null;
  projectId: string | null;
  projectName: string | null;
  createdBy: string | null;
  createdByName: string | null;
  /** Set on a reversing document: the original it reverses. */
  reversesEntryId: string | null;
  /** Set on an original that has been reversed: the reversing document. */
  reversedByEntryId: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversedByName: string | null;
  /** Exact Rial, as a decimal string: by double entry, the sum of the debit column. */
  totalDebit: string;
  lines: JournalLineRecord[];
}

export interface JournalPage {
  entries: JournalEntryRecord[];
  hasMore: boolean;
  /** Opaque boundary for the next page, or `null` when this is the last one. */
  nextCursor: string | null;
  /**
   * The real number of documents the filter matches — not the number loaded.
   * Counted only on the first page (a cursor request already knows it), so the
   * screen can say «۱۲٬۴۰۳ سند» rather than calling a loaded page a total.
   */
  totalCount: number | null;
}

interface EntryRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  posted_at: string;
  memo: string | null;
  source_type: string | null;
  source_id: string | null;
  location_id: string | null;
  location_name: string | null;
  project_id: string | null;
  project_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversed_by_name: string | null;
  total_debit: string;
}

interface LineRow extends Record<string, unknown> {
  entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
}

/**
 * The shared FROM/WHERE, with every filter bound as a parameter.
 *
 * `$1` is always the business — tenancy is a WHERE clause here as well as an
 * RLS policy, the way every other ledger read in this codebase states it.
 */
function journalScope(businessId: string, filters: JournalFilters): { sql: string; args: unknown[] } {
  const args: unknown[] = [
    businessId,
    filters.dateFrom,
    filters.dateTo,
    filters.sourceType,
    filters.q,
    filters.locationId,
    filters.accountId,
    filters.createdBy,
    filters.projectId,
    filters.reversalState,
    filters.entryKind,
    filters.amountMin,
    filters.amountMax,
    filters.entryId,
  ];
  const sql = `FROM journal_entries je
         LEFT JOIN users u ON u.id = je.created_by
         LEFT JOIN locations loc ON loc.id = je.location_id
         LEFT JOIN ai_projects proj ON proj.id = je.project_id
         LEFT JOIN journal_entries rev ON rev.reverses_entry_id = je.id
         LEFT JOIN users ru ON ru.id = je.reversed_by
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(jl.debit), 0)::bigint AS total_debit
             FROM journal_lines jl WHERE jl.entry_id = je.id
         ) totals ON true
        WHERE je.business_id = $1
          AND ($2::date IS NULL OR je.entry_date >= $2::date)
          AND ($3::date IS NULL OR je.entry_date <= $3::date)
          AND ($4::text IS NULL OR je.source_type = $4::text)
          AND (
            $5::text IS NULL
            OR je.memo ILIKE '%' || $5::text || '%'
            OR u.full_name ILIKE '%' || $5::text || '%'
            OR EXISTS (
              SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
               WHERE jl.entry_id = je.id
                 AND (a.code ILIKE '%' || $5::text || '%' OR a.name ILIKE '%' || $5::text || '%')
            )
          )
          AND ($6::uuid IS NULL OR je.location_id = $6::uuid)
          AND ($7::uuid IS NULL OR EXISTS (
                SELECT 1 FROM journal_lines jl
                 WHERE jl.entry_id = je.id AND jl.account_id = $7::uuid
              ))
          AND ($8::uuid IS NULL OR je.created_by = $8::uuid)
          AND ($9::uuid IS NULL OR je.project_id = $9::uuid)
          AND (
            $10::text IS NULL OR $10::text = 'any'
            OR ($10::text = 'reversal' AND je.reverses_entry_id IS NOT NULL)
            OR ($10::text = 'reversed' AND je.reversed_at IS NOT NULL)
            OR ($10::text = 'none' AND je.reverses_entry_id IS NULL AND je.reversed_at IS NULL)
          )
          AND (
            $11::text IS NULL OR $11::text = 'any'
            OR ($11::text = 'manual' AND je.source_type = 'manual')
            OR ($11::text = 'system' AND (je.source_type IS NULL OR je.source_type <> 'manual'))
          )
          AND ($12::bigint IS NULL OR totals.total_debit >= $12::bigint)
          AND ($13::bigint IS NULL OR totals.total_debit <= $13::bigint)
          AND ($14::uuid IS NULL OR je.id = $14::uuid)`;
  return { sql, args };
}

const ENTRY_COLUMNS = `je.id, je.entry_date::text AS entry_date, je.posted_at::text AS posted_at, je.memo,
          je.source_type, je.source_id::text AS source_id,
          je.location_id, loc.name AS location_name,
          je.project_id, proj.name AS project_name,
          je.created_by, u.full_name AS created_by_name,
          je.reverses_entry_id, rev.id AS reversed_by_entry_id,
          je.reversed_at::text AS reversed_at, je.reversed_by, ru.full_name AS reversed_by_name,
          totals.total_debit::text AS total_debit`;

/**
 * The journal's stable read order: the document's own date first, then when it
 * was recorded, then its id as the tie-break that makes the tuple unique.
 *
 * A journal is read by document date — an amendment or an imported sale
 * carries the date it happened, so ordering purely by `posted_at` filed it at
 * the top of today instead of on its own day. The accounting dashboard's
 * «اسناد اخیر» still orders by `posted_at`: that list answers "what was entered
 * last", a different question.
 */
const ORDER_BY = "ORDER BY je.entry_date DESC, je.posted_at DESC, je.id DESC";

async function attachLines(entries: EntryRow[]): Promise<JournalEntryRecord[]> {
  if (entries.length === 0) return [];
  const { rows: lines } = await query<LineRow>(
    `SELECT jl.entry_id, jl.account_id, a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = ANY($1::uuid[]) ORDER BY jl.entry_id, jl.id`,
    [entries.map((e) => e.id)],
  );
  const byEntry = new Map<string, JournalLineRecord[]>();
  for (const line of lines) {
    const list = byEntry.get(line.entry_id) ?? [];
    list.push({
      entryId: line.entry_id,
      accountId: line.account_id,
      accountCode: line.account_code,
      accountName: line.account_name,
      debit: line.debit,
      credit: line.credit,
    });
    byEntry.set(line.entry_id, list);
  }
  return entries.map((row) => {
    const entryLines = byEntry.get(row.id) ?? [];
    return {
      id: row.id,
      entryDate: row.entry_date,
      postedAt: row.posted_at,
      memo: row.memo,
      sourceType: row.source_type,
      sourceId: row.source_id,
      locationId: row.location_id,
      locationName: row.location_name,
      projectId: row.project_id,
      projectName: row.project_name,
      createdBy: row.created_by,
      createdByName: row.created_by_name,
      reversesEntryId: row.reverses_entry_id,
      reversedByEntryId: row.reversed_by_entry_id,
      reversedAt: row.reversed_at,
      reversedBy: row.reversed_by,
      reversedByName: row.reversed_by_name,
      // The aggregate is authoritative; the fallback keeps a document whose
      // lines failed to load from reading as «۰».
      totalDebit: row.total_debit ?? journalEntryTotalText(entryLines),
      lines: entryLines,
    };
  });
}

/** One keyset page of the journal, plus the filter's true total on the first page. */
export async function listJournalEntries(
  businessId: string,
  filters: JournalFilters,
): Promise<JournalPage> {
  const { sql, args } = journalScope(businessId, filters);
  const cursorArgs = [
    filters.cursor?.entryDate ?? null,
    filters.cursor?.postedAt ?? null,
    filters.cursor?.id ?? null,
  ];
  const base = args.length;
  // Row comparison against the exact ordering tuple: "strictly older than the
  // last document shown". New postings between pages can no longer shift a row
  // across the boundary the way `OFFSET` let them.
  const keyset = `AND (
      $${base + 1}::date IS NULL
      OR (je.entry_date, je.posted_at, je.id) < ($${base + 1}::date, $${base + 2}::timestamptz, $${base + 3}::uuid)
    )`;
  const { rows } = await query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} ${sql} ${keyset} ${ORDER_BY} LIMIT $${base + 4}`,
    [...args, ...cursorArgs, filters.limit + 1],
  );

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const last = page[page.length - 1];

  // Counted only when the reader is on the first page: a «بیشتر» request
  // already has the number, and a count over a wide filter is the expensive
  // half of this endpoint.
  let totalCount: number | null = null;
  if (!filters.cursor) {
    const { rows: countRows } = await query<{ total: string }>(`SELECT count(*)::text AS total ${sql}`, args);
    totalCount = Number(countRows[0]?.total ?? "0");
  }

  return {
    entries: await attachLines(page),
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeJournalCursor({ entryDate: last.entry_date, postedAt: last.posted_at, id: last.id })
        : null,
    totalCount,
  };
}

/**
 * The complete filtered result for an export — pagination deliberately
 * ignored, bounded by `JOURNAL_EXPORT_ROW_CAP`.
 */
export async function listJournalEntriesForExport(
  businessId: string,
  filters: JournalFilters,
): Promise<{ entries: JournalEntryRecord[]; truncated: boolean }> {
  const { sql, args } = journalScope(businessId, filters);
  const { rows } = await query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} ${sql} ${ORDER_BY} LIMIT $${args.length + 1}`,
    [...args, JOURNAL_EXPORT_ROW_CAP + 1],
  );
  const truncated = rows.length > JOURNAL_EXPORT_ROW_CAP;
  return {
    entries: await attachLines(truncated ? rows.slice(0, JOURNAL_EXPORT_ROW_CAP) : rows),
    truncated,
  };
}

export interface JournalFilterOptions {
  sourceTypes: string[];
  locations: { id: string; name: string }[];
  creators: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/**
 * The values this business's journal actually contains.
 *
 * Built from the book rather than from the full label table or the whole
 * org chart, for the reason the source-type list was always built this way: a
 * café has never posted a `gold_sale`, and offering fifty codes of which six
 * can match is a worse filter than six that all can. Codes come back raw; the
 * screen labels them through `ledgerSourceLabel`, the one place a code becomes
 * Persian.
 */
export async function listJournalFilterOptions(businessId: string): Promise<JournalFilterOptions> {
  const [sourceTypes, locations, creators, projects] = await Promise.all([
    query<{ source_type: string | null }>(
      `SELECT DISTINCT source_type FROM journal_entries
        WHERE business_id = $1 AND source_type IS NOT NULL ORDER BY source_type`,
      [businessId],
    ),
    query<{ id: string; name: string }>(
      `SELECT DISTINCT loc.id, loc.name
         FROM journal_entries je JOIN locations loc ON loc.id = je.location_id
        WHERE je.business_id = $1 ORDER BY loc.name`,
      [businessId],
    ),
    query<{ id: string; name: string }>(
      `SELECT DISTINCT u.id, u.full_name AS name
         FROM journal_entries je JOIN users u ON u.id = je.created_by
        WHERE je.business_id = $1 ORDER BY u.full_name`,
      [businessId],
    ),
    query<{ id: string; name: string }>(
      `SELECT DISTINCT p.id, p.name
         FROM journal_entries je JOIN ai_projects p ON p.id = je.project_id
        WHERE je.business_id = $1 ORDER BY p.name`,
      [businessId],
    ),
  ]);
  return {
    sourceTypes: sourceTypes.rows.map((r) => r.source_type).filter((s): s is string => !!s),
    locations: locations.rows,
    creators: creators.rows,
    projects: projects.rows,
  };
}
