import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool, query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { createItemSupplierReturn, RetailStockError } from "@/lib/retail-stock-service";
import { RetailReturnError } from "@/lib/retail-return-errors";
import {
  isReturnSettlementMethod,
  parseSupplierReturnBody,
} from "@/lib/retail-return-validation";

/**
 * Issue #918 — the «حواله بازگشت» voucher register: the posted return
 * vouchers of this business, server-paginated, with their supplier, original
 * purchase, warehouse, amounts, settlement and actor.
 *
 * `canWrite` tells the workspace whether to render the voucher editor or a
 * read-only register: writers hold `inventory.adjust`, everyone else reads.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryView);
  if (error) return error;

  const writer = await requirePermission(PERMISSIONS.inventoryAdjust);

  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId") || "";
  const supplierId = url.searchParams.get("supplierId") || "";
  const purchaseId = url.searchParams.get("purchaseId") || "";
  const settlement = url.searchParams.get("settlement") || "";
  const search = (url.searchParams.get("search") ?? "").trim();
  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "20");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize = Math.min(
    Math.max(Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.floor(pageSizeRaw) : 20, 1),
    100,
  );

  // Malformed ids would surface as Postgres uuid-syntax 500s; a foreign
  // tenant's id simply matches nothing (business_id is always fenced).
  for (const [value, code] of [
    [locationId, "locationId"],
    [supplierId, "supplierId"],
    [purchaseId, "purchaseId"],
  ] as const) {
    if (value && !isUuid(value)) {
      return NextResponse.json({ error: "bad_request", field: code }, { status: 400 });
    }
  }
  if (settlement && !isReturnSettlementMethod(settlement)) {
    return NextResponse.json({ error: "bad_request", field: "settlement" }, { status: 400 });
  }

  const clauses = ["r.business_id = $1"];
  const params: unknown[] = [session.businessId];
  if (locationId) {
    params.push(locationId);
    clauses.push(`r.location_id = $${params.length}`);
  }
  if (supplierId) {
    // Linked returns inherit the purchase's supplier; purchase-less returns
    // carry their own — the same COALESCE the AP attribution reads.
    params.push(supplierId);
    clauses.push(`COALESCE(p.supplier_id, r.supplier_id) = $${params.length}`);
  }
  if (purchaseId) {
    params.push(purchaseId);
    clauses.push(`r.purchase_id = $${params.length}`);
  }
  if (settlement) {
    params.push(settlement);
    clauses.push(`r.settlement_method = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const ref = `$${params.length}`;
    // A bare number searches the voucher number too ("۱۲۳" is digits the
    // operator typed — match the Arabic-Indic forms as well as ASCII).
    const asciiSearch = search.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d).toString());
    if (/^\d+$/.test(asciiSearch)) {
      params.push(Number(asciiSearch));
      clauses.push(
        `(r.reason ILIKE ${ref} OR s.name ILIKE ${ref} OR r.return_number = $${params.length})`,
      );
    } else {
      clauses.push(`(r.reason ILIKE ${ref} OR s.name ILIKE ${ref})`);
    }
  }

  const where = clauses.join(" AND ");
  const [{ rows: countRows }, { rows }] = await Promise.all([
    query<{ total: string }>(
      `SELECT count(*)::text AS total
         FROM item_supplier_returns r
         LEFT JOIN item_purchases p ON p.id = r.purchase_id
         LEFT JOIN suppliers s ON s.id = COALESCE(p.supplier_id, r.supplier_id)
        WHERE ${where}`,
      params,
    ),
    query<{
      id: string;
      return_number: string;
      purchase_id: string | null;
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
      line_count: number;
    }>(
      `SELECT r.id, r.return_number::text AS return_number,
              r.purchase_id, COALESCE(p.supplier_id, r.supplier_id) AS supplier_id,
              s.name AS supplier_name,
              r.location_id, l.name AS location_name,
              r.settlement_method::text AS settlement_method,
              r.total_value_rial::text, r.supplier_credit_rial::text, r.variance_rial::text,
              r.reason, r.status::text AS status, r.created_at,
              u.full_name AS created_by_name,
              (SELECT count(*) FROM item_supplier_return_items li WHERE li.return_id = r.id)::int AS line_count
         FROM item_supplier_returns r
         JOIN locations l ON l.id = r.location_id
         LEFT JOIN item_purchases p ON p.id = r.purchase_id
         LEFT JOIN suppliers s ON s.id = COALESCE(p.supplier_id, r.supplier_id)
         LEFT JOIN users u ON u.id = r.created_by
        WHERE ${where}
        ORDER BY r.created_at DESC, r.return_number DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ]);

  return NextResponse.json({
    returns: rows,
    page,
    pageSize,
    total: Number(countRows[0]?.total ?? 0),
    canWrite: !writer.error,
  });
});

/** Posts one supplier-return voucher: stock out, settlement debited, inventory relieved. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseSupplierReturnBody(body);
  } catch (err) {
    if (err instanceof RetailReturnError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await createItemSupplierReturn(client, {
      businessId: session.businessId,
      locationId: location.id,
      purchaseId: parsed.purchaseId,
      supplierId: parsed.supplierId,
      settlementMethod: parsed.settlementMethod,
      reason: parsed.reason,
      idempotencyKey: parsed.idempotencyKey,
      createdBy: session.sub,
      lines: parsed.lines,
    });
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      id: result.id,
      value: result.value,
      supplierCredit: result.supplierCredit,
      variance: result.variance,
      returnNumber: result.returnNumber,
      duplicate: result.duplicate,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof RetailReturnError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    }
    if (err instanceof RetailStockError) {
      return NextResponse.json({ error: "return_failed", message: err.message }, { status: 400 });
    }
    // A unique violation that escaped the service's race handling is still a
    // key conflict, never a 500 with a constraint name.
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.json({ error: "idempotency_conflict" }, { status: 409 });
    }
    throw err;
  } finally {
    client.release();
  }
});
