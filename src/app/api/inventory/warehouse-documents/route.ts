import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { authorize, denialResponse, actionableLocationIds } from "@/lib/authorize";
import {
  createWarehouseDocument,
  listWarehouseDocuments,
  isWarehouseDocumentKind,
  parseWarehouseDocumentLines,
} from "@/lib/warehouse-document-service";
import { createHash } from "node:crypto";

/**
 * Phase 42 — warehouse documents (رسید/حواله انبار).
 *
 * GET lists the documents a business has posted (optionally by kind and
 * warehouse); POST creates and posts one. Creation runs the exact-costing
 * path and the ledger entry in one transaction (warehouse-document-service),
 * so a document never exists without its stock movement and journal lines.
 *
 * P0 branch security: GET scopes to the caller's allowed branches and
 * explicitly authorizes a requested locationId (403 if forbidden). POST
 * authorizes the target warehouse using live membership scope.
 *
 * P1 idempotency: POST accepts an Idempotency-Key header or body
 * idempotencyKey (UUID). Same key+same payload returns the original
 * voucher; same key+changed payload returns 409. Includes atomic
 * reservation via unique index and payload hash.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryView);
  if (guard.error) return guard.error;
  const session = guard.session;

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const locationId = url.searchParams.get("locationId");
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500);

  if (locationId !== null && locationId !== "") {
    if (!isUuid(locationId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const decision = await authorize(session, { locationId });
    if (!decision.ok) return denialResponse(decision);
  }

  const allowedIds = await actionableLocationIds(guard.membership);
  if (allowedIds.length === 0) {
    return NextResponse.json({ documents: [] });
  }

  if (kind !== null && kind !== "") {
    if (!isWarehouseDocumentKind(kind)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  const documents = await listWarehouseDocuments(session.businessId, {
    kind: kind === null || kind === "" ? undefined : kind,
    locationId: locationId === null || locationId === "" ? undefined : locationId,
    allowedLocationIds: allowedIds,
    limit,
  });
  return NextResponse.json({ documents });
});

function canonicalPayloadHash(payload: unknown): string {
  const str = JSON.stringify(payload, Object.keys(payload as Record<string, unknown>).sort());
  return createHash("sha256").update(str).digest("hex");
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (guard.error) return guard.error;
  const session = guard.session;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // P2 strict schema: root must be plain object
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = rawBody as {
    kind?: unknown;
    locationId?: unknown;
    supplierId?: unknown;
    recipient?: unknown;
    documentNumber?: unknown;
    note?: unknown;
    idempotencyKey?: unknown;
    internalVoucherNumber?: unknown;
    freeGoodsReason?: unknown;
    postingDate?: unknown;
    allowNegativeStock?: unknown;
    lines?: unknown;
  };

  // Body size / max lines guard (P2)
  const rawLines = body.lines;
  if (rawLines !== undefined) {
    if (!Array.isArray(rawLines)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (rawLines.length > 200) {
      return NextResponse.json({ error: "too_many_lines" }, { status: 400 });
    }
    if (rawLines.some((l) => l == null || typeof l !== "object" || Array.isArray(l))) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }

  if (!isWarehouseDocumentKind(body.kind)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.locationId !== "string" || !body.locationId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!isUuid(body.locationId)) {
    return NextResponse.json({ error: "location_not_found" }, { status: 404 });
  }
  // Branch authorization using live membership scope, not client-provided permissions
  const locationDecision = await authorize(session, { locationId: body.locationId });
  if (!locationDecision.ok) return denialResponse(locationDecision);

  if (body.supplierId != null && body.supplierId !== "" && (typeof body.supplierId !== "string" || !isUuid(body.supplierId))) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }
  // Validate optional text fields are strings when present (P2)
  for (const field of ["recipient", "documentNumber", "note", "internalVoucherNumber"] as const) {
    const v = (body as Record<string, unknown>)[field];
    if (v != null && typeof v !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof v === "string" && v.length > 500) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  const typedLines = (body.lines ?? []) as Array<{ inventoryItemId?: unknown; quantity?: unknown; unitCost?: unknown }>;
  if (
    typedLines.some(
      (line) => line?.inventoryItemId != null && line.inventoryItemId !== "" && (typeof line.inventoryItemId !== "string" || !isUuid(line.inventoryItemId)),
    )
  ) {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }

  // Idempotency key: header takes precedence, then body, otherwise null (no dedup)
  const headerKey = request.headers.get("idempotency-key") ?? request.headers.get("Idempotency-Key");
  let idempotencyKey: string | null = null;
  const rawKey = (headerKey ?? (body.idempotencyKey as string | undefined) ?? null) as string | null;
  if (rawKey != null && rawKey !== "") {
    if (typeof rawKey !== "string" || !isUuid(rawKey)) {
      return NextResponse.json({ error: "idempotency_key_invalid" }, { status: 400 });
    }
    idempotencyKey = rawKey;
  }

  let parsed;
  try {
    parsed = parseWarehouseDocumentLines(body.kind as never, typedLines as never);
  } catch (err) {
    const code = err instanceof Error ? err.message : "bad_request";
    return NextResponse.json({ error: code }, { status: 400 });
  }

  // Build canonical payload for hash (stable ordering)
  const canonicalLines = parsed.lines.map((l) => ({ inventoryItemId: l.inventoryItemId, quantity: l.quantity, unitCost: l.unitCost }));
  const payloadHash = canonicalPayloadHash({
    kind: parsed.kind,
    locationId: body.locationId,
    lines: canonicalLines,
    supplierId: (body.supplierId as string) ?? null,
  });

  // Optional fields for P2 hardening
  if (body.freeGoodsReason != null && typeof body.freeGoodsReason !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.postingDate != null && (typeof body.postingDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.postingDate))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.allowNegativeStock != null && typeof body.allowNegativeStock !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const created = await createWarehouseDocument({
      businessId: session.businessId,
      locationId: body.locationId,
      kind: parsed.kind,
      supplierId: (body.supplierId as string) ?? null,
      recipient: typeof body.recipient === "string" ? body.recipient.trim() || null : null,
      documentNumber: typeof body.documentNumber === "string" ? body.documentNumber.trim() || null : null,
      note: typeof body.note === "string" ? body.note.trim() || null : null,
      createdBy: session.sub,
      lines: parsed.lines,
      idempotencyKey,
      payloadHash,
      internalVoucherNumber: typeof body.internalVoucherNumber === "string" ? body.internalVoucherNumber.trim() || null : null,
      freeGoodsReason: typeof body.freeGoodsReason === "string" ? body.freeGoodsReason.trim() || null : null,
      postingDate: typeof body.postingDate === "string" ? body.postingDate : null,
      allowNegativeStock: body.allowNegativeStock === true,
    });
    // If duplicate key returned same document, signal it
    if ((created as unknown as { duplicate?: boolean }).duplicate) {
      return NextResponse.json({ ok: true, id: created.id, totalValue: created.totalValue, duplicate: true });
    }
    return NextResponse.json({ ok: true, id: created.id, totalValue: created.totalValue });
  } catch (err) {
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    if (err instanceof Error) {
      if (err.message.startsWith("inventory_exact_cutover_required")) {
        return NextResponse.json({ error: "inventory_exact_cutover_required" }, { status: 409 });
      }
      if (err.message === "idempotency_key_conflict") {
        return NextResponse.json({ error: "idempotency_key_conflict" }, { status: 409 });
      }
      if (err.message === "document_number_taken") {
        return NextResponse.json({ error: "document_number_taken" }, { status: 409 });
      }
      const known: Record<string, number> = {
        location_not_found: 404,
        location_inactive: 409,
        supplier_not_found: 404,
        item_not_found: 404,
        no_items: 400,
        invalid_line: 400,
        invalid_quantity: 400,
        quantity_precision_exceeded: 400,
        invalid_rial: 400,
        rial_out_of_range: 400,
        receipt_value_required: 400,
        periodic_system_unsupported: 409,
        idempotency_key_invalid: 400,
        too_many_lines: 400,
        fiscal_period_locked: 409,
        fiscal_period_soft_closed: 409,
        fiscal_period_not_defined: 409,
        negative_stock_requires_confirm: 409,
        bad_request: 400,
      };
      const status = known[err.message];
      if (status) return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
});
