/**
 * GH #1567 F2 — opening-stock documents for the active branch.
 *
 *  GET  — the branch's documents (draft / posted / cancelled).
 *  POST — create a draft: cutover date, lines (SKU, quantity, unit cost) and an
 *         idempotency key. A draft moves no stock and posts nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requirePermissions, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  openingStockIndustryError,
  readJsonBody,
  withOpeningStockTransaction,
} from "@/lib/item-opening-stock-http";
import {
  createOpeningStockDraft,
  listOpeningStockDocuments,
  type OpeningStockLineInput,
} from "@/lib/item-opening-stock-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryView, PERMISSIONS.ledgerView);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  try {
    const documents = await listOpeningStockDocuments(client, { businessId: session.businessId, locationId: location.id });
    return NextResponse.json({ documents });
  } finally {
    client.release();
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return withOpeningStockTransaction(async (client) => {
    const result = await createOpeningStockDraft(client, {
      businessId: session.businessId,
      locationId: location.id,
      cutoverDate: typeof body.cutoverDate === "string" ? body.cutoverDate : null,
      source: "manual",
      note: typeof body.note === "string" ? body.note : null,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      lines: Array.isArray(body.lines) ? (body.lines as OpeningStockLineInput[]) : [],
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  });
});
