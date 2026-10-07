import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface EntryRow extends Record<string, unknown> {
  id: string;
  entry_date: string;
  memo: string | null;
  source_type: string | null;
  location_name: string | null;
  created_by_name: string | null;
  posted_at: string;
  reverses_entry_id: string | null;
  reversed_at: string | null;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
}

/**
 * One posted journal entry with its lines — the drill-down a source history
 * needs (issue #833): the fixed-asset register's history opens the exact
 * entry a depreciation/reversal/disposal caused, by its stored id, never by
 * guessing at memo text. The list view (`/api/ledger/entries`) stays the
 * book; this is «show me this document».
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const { rows } = await query<EntryRow>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            l.name AS location_name, u.full_name AS created_by_name,
            je.posted_at::text AS posted_at, je.reverses_entry_id, je.reversed_at::text AS reversed_at
       FROM journal_entries je
       LEFT JOIN locations l ON l.id = je.location_id
       LEFT JOIN users u ON u.id = je.created_by
      WHERE je.business_id = $1 AND je.id = $2`,
    [session.businessId, id],
  );
  if (!rows[0]) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });

  const { rows: lines } = await query<LineRow>(
    `SELECT jl.id, a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1
      ORDER BY jl.id`,
    [id],
  );

  const entry = rows[0];
  return NextResponse.json({
    entry: {
      id: entry.id,
      entryDate: entry.entry_date,
      memo: entry.memo,
      sourceType: entry.source_type,
      locationName: entry.location_name,
      createdByName: entry.created_by_name,
      postedAt: entry.posted_at,
      reversesEntryId: entry.reverses_entry_id,
      reversedAt: entry.reversed_at,
      lines: lines.map((l) => ({
        id: l.id,
        accountCode: l.account_code,
        accountName: l.account_name,
        debit: Number(l.debit),
        credit: Number(l.credit),
      })),
    },
  });
});
