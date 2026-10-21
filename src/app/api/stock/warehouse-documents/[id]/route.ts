import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";


type Context = { params: Promise<{ id: string }> };

interface DocumentLedger {
  entryId: string | null;
  postedAt: string | null;
  memo: string | null;
  status: "posted" | "not_posted";
  lines: Array<{
    accountCode: string;
    accountName: string;
    debit: string;
    credit: string;
  }>;
}

/**
 * Phase 42b — one retail warehouse document with its lines, for the detail
 * Issue #923 (register reading):
 *   * Branch scope (P0): the document's location is resolved and the
 *     member's access to it is verified *before* either the header or the
 *     lines are returned.
 *   * Immutable identity (P1): lines read their snapshotted item name and
 *     tracking (`item_name`, `item_tracking`) and fall back to the live join
 *     only for legacy documents, clearly legacy data, not a snapshot.
 *   * Retail lot/expiry stability (P1): `lot_number`/`expiry_date` are what
 *     the line actually carried (generated lot numbers included — the posting
 *     service saves them), so a later batch re-average, expiry change or
 *     deletion cannot rewrite what this issue recorded.
 *   * Accounting traceability (P1): the linked GL journal entry is exposed,
 *     plus a `not_posted` status when the source-linked posting is missing.
 *
 * P0 branch security: authorizes the document's actual branch before returning.

 */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;
  const { id } = await context.params;
  // A non-uuid id is simply a document that cannot exist — not a 500.
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: docs } = await query<{
    id: string;
    kind: string;
    location_id: string;
    location_name: string;
    recipient: string | null;
    document_number: string | null;
    internal_voucher_number: string | null;
    /** The register's display identity: internal voucher, else external number. */
    voucher_number: string | null;
    business_date: string | null;
    reversed_of: string | null;
    is_reversal: boolean;
    note: string | null;
    total_value_rial: string;
    created_at: string;
    created_by_name: string | null;
  }>(
    `SELECT d.id, d.kind::text AS kind, d.location_id, l.name AS location_name,
            d.recipient, d.document_number, d.internal_voucher_number,
            COALESCE(d.internal_voucher_number, d.document_number) AS voucher_number,
            d.business_date,
            d.reversed_of, d.is_reversal, d.note,
            d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name
       FROM retail_warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = $2 AND d.business_id = $1`,
    [session.businessId, id],
  );
  const doc = docs[0];
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Authorize the document's branch before returning any data.
  const decision = await authorize(session, { locationId: doc.location_id });
  if (!decision.ok) return denialResponse(decision);

  const { rows: lines } = await query<{
    id: string;
    item_name: string;
    tracking: string;
    lot_number: string | null;
    expiry_date: string | null;
    quantity: string;
    unit_cost: string;
    value_rial: string;
    item_snapshot: boolean;
  }>(
    `SELECT l2.id,
            COALESCE(l2.item_name, i.name) AS item_name,
            COALESCE(l2.item_tracking, i.tracking)::text AS tracking,
            l2.lot_number,
            l2.expiry_date::text AS expiry_date,
            l2.quantity::text AS quantity, l2.unit_cost::text AS unit_cost,
            l2.value_rial::text AS value_rial,
            (l2.item_name IS NOT NULL) AS item_snapshot
       FROM retail_warehouse_document_lines l2
       JOIN retail_warehouse_documents d ON d.id = l2.document_id
       JOIN items i ON i.id = l2.item_id
      WHERE d.id = $1 AND d.business_id = $2
      ORDER BY l2.item_name, l2.id`,
    [id, session.businessId],
  );

  const ledger = await retailDocumentLedger(session.businessId, doc.location_id, id);

  return NextResponse.json({
    document: { ...doc, ledger },
    lines,
  });
});

async function retailDocumentLedger(
  businessId: string,
  locationId: string,
  documentId: string,
): Promise<DocumentLedger> {
  const { rows: events } = await query<{
    entry_id: string | null;
  }>(
    `SELECT de.entry_id
       FROM domain_events de
      WHERE de.business_id = $1
        AND de.source_type = $2
        AND de.source_id = $3
      ORDER BY de.created_at DESC
      LIMIT 1`,
    [businessId, "retail_warehouse_document", documentId],
  );
  const event = events[0];
  if (!event || !event.entry_id) {
    return {
      entryId: null,
      postedAt: null,
      memo: null,
      status: "not_posted",
      lines: [],
    };
  }

  const { rows: entries } = await query<{
    id: string;
    posted_at: string;
    memo: string | null;
  }>(
    `SELECT id, posted_at::text AS posted_at, memo FROM journal_entries WHERE id = $1`,
    [event.entry_id],
  );
  const entry = entries[0];
  if (!entry) {
    return {
      entryId: event.entry_id,
      postedAt: null,
      memo: null,
      status: "not_posted",
      lines: [],
    };
  }

  const { rows: lines } = await query<{
    account_code: string;
    account_name: string;
    debit: string;
    credit: string;
  }>(
    `SELECT a.code AS account_code, a.name AS account_name,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1
      ORDER BY jl.id`,
    [event.entry_id],
  );

  return {
    entryId: entry.id,
    postedAt: entry.posted_at,
    memo: entry.memo,
    status: "posted",
    lines: lines.map((l) => ({
      accountCode: l.account_code,
      accountName: l.account_name,
      debit: l.debit,
      credit: l.credit,
    })),
  };
}
