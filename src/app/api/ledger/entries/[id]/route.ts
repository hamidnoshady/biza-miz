import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One posted journal entry with its lines — the document behind a subledger
 * row.
 *
 * The A/R and A/P statements drill into their source records, and for most
 * lines the source *is* a journal entry: a receipt, a cheque movement or a
 * closed-order amendment has no screen of its own, and the entry is the
 * document an accountant reads to see what was posted, against which
 * accounts, and under which memo. Without it the statement could only show a
 * description, which is written for a person and is not an address.
 *
 * Read-only and `ledger.view`, like the two lists it is opened from. The
 * tenant scope comes from `withTenantScope`, so another business's entry id
 * answers 404 — the same answer as an id that does not exist, which is the
 * point.
 */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  // A non-UUID raises `invalid input syntax for type uuid` inside PostgreSQL
  // rather than returning no row, so it is answered here with the 404 the
  // caller is entitled to (the same guard the reverse route uses).
  if (!isUuid(id)) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });

  const { rows: entryRows } = await query<{
    id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    source_id: string | null;
    posted_at: string;
    created_by_name: string | null;
    reverses_entry_id: string | null;
    reversed_at: string | null;
  }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.source_type, je.source_id,
            je.posted_at, u.full_name AS created_by_name,
            je.reverses_entry_id, je.reversed_at
       FROM journal_entries je
       LEFT JOIN users u ON u.id = je.created_by
      WHERE je.id = $1 AND je.business_id = $2`,
    [id, session.businessId],
  );
  const entry = entryRows[0];
  if (!entry) return NextResponse.json({ error: "entry_not_found" }, { status: 404 });

  const { rows: lines } = await query<{
    id: string;
    account_id: string;
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }>(
    `SELECT jl.id::text AS id, jl.account_id, a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1
      ORDER BY jl.id`,
    [id],
  );

  return NextResponse.json({
    entry: {
      ...entry,
      lines: lines.map((l) => ({
        id: l.id,
        accountId: l.account_id,
        accountCode: l.account_code,
        accountName: l.account_name,
        // Integer Rial, as the rest of the ledger's JSON speaks it — the
        // client formats through the business's own money unit.
        debit: Number(l.debit),
        credit: Number(l.credit),
      })),
    },
  });
});
