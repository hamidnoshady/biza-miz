import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isValidIsoDate } from "@/lib/iso-date";
import { isUuid } from "@/lib/uuid";

/**
 * Journal entries (auto-posted + manual), newest first, with their lines.
 * Manual entries are no longer posted directly from this route — see
 * /api/ledger/entries/drafts for the draft -> review -> post workflow, and
 * /api/ledger/entries/[id]/reverse for reversing a posted one — but every
 * entry, however it was posted, still shows up here, including its reversal
 * linkage (reversesEntryId / reversedAt) so the UI can show both sides of a
 * reversal.
 *
 * Filters, because «دفتر روزنامه» is a book an accountant *searches*: a date
 * range (`dateFrom`/`dateTo`, ISO — the storage contract; the screen shows
 * Shamsi), one `sourceType`, and a free-text `q` over the memo, the poster's
 * name and the account codes/names of its lines. Without them the screen was
 * a silent «آخرین ۱۰۰ سند» with no way to reach the 101st. `hasMore` says
 * whether the window is cutting anything off, so the UI can say so instead of
 * pretending the book ends there.
 *
 * Ordering is `entry_date DESC, posted_at DESC` — the document's own date
 * first, then when it was recorded. A journal is read by document date, and an
 * entry whose document belongs to an earlier day (an amendment, an imported
 * sale) carries the date it happened, so ordering purely by `posted_at` filed
 * it at the top of today instead of on its own day. The accounting dashboard's «اسناد اخیر» still
 * orders by `posted_at`: that list answers "what was entered last", which is a
 * different question.
 */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const rawDateFrom = params.get("dateFrom");
  const rawDateTo = params.get("dateTo");
  const dateFrom = rawDateFrom && isValidIsoDate(rawDateFrom) ? rawDateFrom : null;
  const dateTo = rawDateTo && isValidIsoDate(rawDateTo) ? rawDateTo : null;
  if ((rawDateFrom && !dateFrom) || (rawDateTo && !dateTo)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_date_range" }, { status: 400 });
  }
  const rawEntryId = params.get("entryId")?.trim() || null;
  if (rawEntryId && !isUuid(rawEntryId)) return NextResponse.json({ error: "invalid_entry_id" }, { status: 400 });
  const sourceType = params.get("sourceType")?.trim() || null;
  const q = params.get("q")?.trim() || null;
  const requestedLimit = Number(params.get("limit"));
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const requestedOffset = Number(params.get("offset"));
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? Math.min(requestedOffset, 50_000) : 0;

  interface EntryRow extends Record<string, unknown> {
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    posted_at: string;
    created_by_name: string | null;
    reverses_entry_id: string | null;
    reversed_at: string | null;
  }
  interface LineRow extends Record<string, unknown> {
    entry_id: string;
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }

  // One row over the window, so "there is more" is a fact rather than a guess
  // from `length === limit`.
  const { rows: entries } = await query<EntryRow>(
    `SELECT je.id, je.entry_date, je.memo, je.source_type, je.source_id, je.posted_at,
            u.full_name AS created_by_name, je.reverses_entry_id, je.reversed_at
       FROM journal_entries je LEFT JOIN users u ON u.id = je.created_by
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
        AND ($6::uuid IS NULL OR je.id = $6::uuid)
      ORDER BY je.entry_date DESC, je.posted_at DESC, je.id DESC
      LIMIT $7 OFFSET $8`,
    [session.businessId, dateFrom, dateTo, sourceType, q, rawEntryId, limit + 1, offset],
  );
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  if (page.length === 0) return NextResponse.json({ entries: [], hasMore: false });

  const { rows: lines } = await query<LineRow>(
    `SELECT jl.entry_id, jl.account_id, a.code AS account_code, a.name AS account_name, jl.debit, jl.credit
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = ANY($1::uuid[]) ORDER BY jl.id`,
    [page.map((e) => e.id)],
  );
  const linesByEntry = new Map<string, LineRow[]>();
  for (const l of lines) {
    const list = linesByEntry.get(l.entry_id) ?? [];
    list.push(l);
    linesByEntry.set(l.entry_id, list);
  }

  return NextResponse.json({
    entries: page.map((e) => ({ ...e, lines: linesByEntry.get(e.id) ?? [] })),
    hasMore,
  });
});
