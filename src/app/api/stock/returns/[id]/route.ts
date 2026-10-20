import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { canActInLocation } from "@/lib/authorize";
import { RetailReturnError } from "@/lib/retail-return-errors";
import { reverseItemSupplierReturn } from "@/lib/retail-stock-service";

type Context = { params: Promise<{ id: string }> };

/** Read a return voucher and its original/reversal journal, within branch scope. */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "return_not_found" }, { status: 404 });

  const { rows: docs } = await query<{
    id: string;
    return_number: string;
    purchase_id: string | null;
    purchase_note: string | null;
    purchase_received_at: string | null;
    supplier_id: string | null;
    supplier_name: string | null;
    location_id: string;
    location_name: string;
    settlement_method: string;
    total_value_rial: string;
    supplier_credit_rial: string;
    variance_rial: string;
    reason: string;
    status: string;
    created_at: string;
    created_by_name: string | null;
    reversal_entry_id: string | null;
    reversal_reason: string | null;
    reversed_at: string | null;
    reversed_by: string | null;
  }>(
    `SELECT r.id, r.return_number::text AS return_number,
            r.purchase_id, p.note AS purchase_note, p.received_at AS purchase_received_at,
            COALESCE(p.supplier_id, r.supplier_id) AS supplier_id, s.name AS supplier_name,
            r.location_id, l.name AS location_name,
            r.settlement_method::text AS settlement_method,
            r.total_value_rial::text, r.supplier_credit_rial::text, r.variance_rial::text,
            r.reason, r.status::text AS status, r.created_at, u.full_name AS created_by_name,
            r.reversal_entry_id, r.reversal_reason, r.reversed_at, r.reversed_by
       FROM item_supplier_returns r
       JOIN locations l ON l.id = r.location_id
       LEFT JOIN item_purchases p ON p.id = r.purchase_id
       LEFT JOIN suppliers s ON s.id = COALESCE(p.supplier_id, r.supplier_id)
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $2 AND r.business_id = $1`,
    [session.businessId, id],
  );
  const doc = docs[0];
  if (!doc || !(await canActInLocation(membership, doc.location_id))) {
    return NextResponse.json({ error: "return_not_found" }, { status: 404 });
  }

  const { rows: lines } = await query<{
    id: string;
    item_id: string;
    item_name: string;
    tracking: string;
    batch_id: string | null;
    batch_number: string | null;
    expiry_date: string | null;
    serial_id: string | null;
    serial_number: string | null;
    purchase_item_id: string | null;
    purchase_unit_cost: string | null;
    quantity: string;
    value_rial: string;
    supplier_credit_rial: string;
  }>(
    `SELECT li.id, li.item_id, i.name AS item_name, i.tracking::text AS tracking,
            li.batch_id, b.batch_number, b.expiry_date::text AS expiry_date,
            li.serial_id, sn.serial_number,
            li.purchase_item_id, pi.unit_cost::text AS purchase_unit_cost,
            li.quantity::text AS quantity,
            li.value_rial::text AS value_rial,
            li.supplier_credit_rial::text AS supplier_credit_rial
       FROM item_supplier_return_items li
       JOIN item_supplier_returns r ON r.id = li.return_id
       JOIN items i ON i.id = li.item_id
       LEFT JOIN item_batches b ON b.id = li.batch_id
       LEFT JOIN item_serials sn ON sn.id = li.serial_id
       LEFT JOIN item_purchase_items pi ON pi.id = li.purchase_item_id
      WHERE r.id = $1 AND r.business_id = $2
      ORDER BY i.name, li.id`,
    [id, session.businessId],
  );

  const { rows: entries } = await query<{
    id: string;
    entry_date: string;
    memo: string | null;
    posting_kind: string | null;
  }>(
    `SELECT je.id, je.entry_date::text AS entry_date, je.memo, je.posting_kind
       FROM journal_entries je
      WHERE je.business_id = $1 AND je.source_type = 'item_supplier_return' AND je.source_id = $2
      ORDER BY (je.posting_kind = 'item_supplier_return_reversal'), je.created_at`,
    [session.businessId, id],
  );
  const journals = await Promise.all(entries.map(async (entry) => {
    const { rows } = await query<{
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
        ORDER BY jl.debit DESC, a.code`,
      [entry.id],
    );
    return { ...entry, lines: rows };
  }));
  const journal = journals.find((entry) => entry.posting_kind !== "item_supplier_return_reversal") ?? null;
  const reversalJournal = journals.find((entry) => entry.posting_kind === "item_supplier_return_reversal") ?? null;

  return NextResponse.json({
    document: doc,
    lines,
    journal,
    reversalJournal,
    corrections: doc.status === "reversed"
      ? [{ kind: "reversal", reason: doc.reversal_reason, entryId: doc.reversal_entry_id, reversedAt: doc.reversed_at }]
      : [],
  });
});

/** Post an audited compensating reversal; no edit/delete path is provided. */
export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "return_not_found" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.reason !== "string" || typeof input.idempotencyKey !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { rows: documents } = await query<{ location_id: string }>(
    `SELECT location_id FROM item_supplier_returns WHERE id = $2 AND business_id = $1`,
    [session.businessId, id],
  );
  const document = documents[0];
  if (!document || !(await canActInLocation(membership, document.location_id))) {
    return NextResponse.json({ error: "return_not_found" }, { status: 404 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await reverseItemSupplierReturn(client, {
      businessId: session.businessId,
      returnId: id,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      actorId: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err instanceof RetailReturnError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
