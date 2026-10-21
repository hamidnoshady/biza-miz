import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";
import { businessDateSql } from "@/lib/warehouse-document-register";
import { loadWarehouseDocumentHistory } from "@/lib/warehouse-document-history";


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
 * Phase 42 — one warehouse document with its lines, for the detail panel of
 * the «رسید و حواله‌های انبار» list.
 *
 * Issue #923 (register reading):
 *   * Branch scope (P0): the document's location is resolved and the
 *     member's access to it is verified *before* either the header or the
 *     lines are returned — a branch-restricted user cannot probe another
 *     branch's voucher by ID.
 *   * Immutable identity (P1): lines read their snapshotted item name/unit
 *     (`item_name`, `item_unit`) and fall back to the live join only for
 *     legacy documents, which are clearly legacy data, not a snapshot.
 *   * Accounting traceability (P1): the linked GL journal entry (via the
 *     domain event the posting emitted) is exposed — entry id, posting time,
 *     DR/CR accounts and amounts — plus a `not_posted` status when the
 *     source-linked posting is missing, instead of silently presenting a
 *     complete voucher.
 *
 * P0 branch security: authorizes the document's actual branch before returning
 * header or lines, including requests without location ID.

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
    supplier_name: string | null;
    recipient: string | null;
    document_number: string | null;
    internal_voucher_number: string | null;
    /** The register's display identity: internal voucher, else external number. */
    voucher_number: string | null;
    business_date: string;
    /** The branch's IANA zone — the dialog shows timestamps in branch time. */
    location_timezone: string;
    reversed_of: string | null;
    reversal_reason: string | null;
    is_reversal: boolean;
    note: string | null;
    total_value_rial: string;
    created_at: string;
    created_by_name: string | null;
  }>(
    `SELECT d.id, d.kind, d.location_id, l.name AS location_name,
            COALESCE(p.name, s.name) AS supplier_name,
            d.recipient, d.document_number, d.internal_voucher_number,
            COALESCE(d.internal_voucher_number, d.document_number) AS voucher_number,
            ${businessDateSql("d", "l")}::text AS business_date,
            l.timezone AS location_timezone,
            d.reversed_of, d.reversal_reason, d.is_reversal,
            d.note, d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name
       FROM warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = $2 AND d.business_id = $1`,
    [session.businessId, id],
  );
  const doc = docs[0];
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Authorize the document's branch before returning any data — the header
  // itself names the warehouse, so returning it to an unauthorized branch
  // leaks branch-level information.
  const decision = await authorize(session, { locationId: doc.location_id });
  if (!decision.ok) return denialResponse(decision);

  const { rows: lines } = await query<{
    id: string;
    item_name: string;
    unit: string;
    quantity: string;
    unit_cost: string;
    value_rial: string;
    note: string | null;
    item_snapshot: boolean;
  }>(
    `SELECT l2.id,
            COALESCE(l2.item_name, ii.name) AS item_name,
            COALESCE(l2.item_unit, ii.unit) AS unit,
            l2.quantity::text AS quantity, l2.unit_cost::text AS unit_cost,
            l2.value_rial::text AS value_rial, l2.note,
            (l2.item_name IS NOT NULL) AS item_snapshot
       FROM warehouse_document_lines l2
       JOIN warehouse_documents d ON d.id = l2.document_id
       JOIN inventory_items ii ON ii.id = l2.inventory_item_id
      WHERE d.id = $1 AND d.business_id = $2
      ORDER BY l2.item_name, l2.id`,
    [id, session.businessId],
  );

  const ledger = await documentLedger(session.businessId, doc.location_id, id);

  // The correction/reversal chain, read after the branch check above: the
  // panel shows the linked original/replacement with its reason and actor
  // instead of only the `reversed_of` uuid (#923).
  const history = await loadWarehouseDocumentHistory({
    businessId: session.businessId,
    locationId: doc.location_id,
    documentId: id,
    family: "fnb",
  });

  return NextResponse.json({
    document: { ...doc, ledger, history },
    lines,
  });
});

async function documentLedger(
  businessId: string,
  locationId: string,
  documentId: string,
): Promise<DocumentLedger> {
  const { rows: events } = await query<{
    entry_id: string | null;
    source_type: string | null;
  }>(
    `SELECT de.entry_id, de.source_type
       FROM domain_events de
      WHERE de.business_id = $1
        AND de.source_type = ANY($2)
        AND de.source_id = $3
      ORDER BY de.created_at DESC
      LIMIT 1`,
    [businessId, ["warehouse_receipt", "warehouse_issue"], documentId],
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
