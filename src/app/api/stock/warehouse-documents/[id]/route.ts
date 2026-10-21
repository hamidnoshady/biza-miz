import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { authorize, denialResponse } from "@/lib/authorize";

type Context = { params: Promise<{ id: string }> };

/**
 * Phase 42b — one retail warehouse document with its lines, for the detail
 * dialog of the «رسید و حواله‌های انبار» list. Each line shows the lot via
 * COALESCE(line.lot, batch.lot) and the expiry the same way, so a line stays
 * readable even after the batch row it touched has been emptied or removed.
 *
 * P0 branch security: authorizes the document's actual branch before returning.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: docs } = await query<{
    id: string;
    kind: string;
    location_id: string;
    location_name: string;
    recipient: string | null;
    document_number: string | null;
    internal_voucher_number: string | null;
    reversed_of: string | null;
    is_reversal: boolean;
    note: string | null;
    total_value_rial: string;
    created_at: string;
    created_by_name: string | null;
  }>(
    `SELECT d.id, d.kind::text AS kind, d.location_id, l.name AS location_name,
            d.recipient, d.document_number, d.internal_voucher_number,
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
  }>(
    `SELECT l2.id, i.name AS item_name, i.tracking::text AS tracking,
            COALESCE(l2.lot_number, b.batch_number) AS lot_number,
            COALESCE(l2.expiry_date, b.expiry_date)::text AS expiry_date,
            l2.quantity::text AS quantity, l2.unit_cost::text AS unit_cost,
            l2.value_rial::text AS value_rial
       FROM retail_warehouse_document_lines l2
       JOIN retail_warehouse_documents d ON d.id = l2.document_id
       JOIN items i ON i.id = l2.item_id
       LEFT JOIN item_batches b ON b.id = l2.batch_id
      WHERE d.id = $1 AND d.business_id = $2
      ORDER BY i.name`,
    [id, session.businessId],
  );

  return NextResponse.json({ document: doc, lines });
});
