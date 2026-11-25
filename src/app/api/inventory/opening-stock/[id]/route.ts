/**
 * GH #1567 F2 — one opening-stock document.
 *
 *  GET    — the review: every line with its blocking issues, totals, the
 *           accounts it will post to and the fingerprint to post with.
 *  PATCH  — edit a draft (lines upserted, `removeItemIds`, cutover date, note).
 *  DELETE — cancel a draft. A posted document is corrected with a stock count.
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
  cancelOpeningStockDraft,
  OpeningStockError,
  previewOpeningStock,
  updateOpeningStockDraft,
  type OpeningStockLineInput,
} from "@/lib/item-opening-stock-service";
import { PERMISSIONS } from "@/lib/permissions";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withTenantScope(async (_request: NextRequest, context: RouteContext) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryView, PERMISSIONS.ledgerView);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const { id } = await context.params;
  const client = await getPool().connect();
  try {
    return NextResponse.json(await previewOpeningStock(client, { businessId: session.businessId, documentId: id }));
  } catch (err) {
    if (err instanceof OpeningStockError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  } finally {
    client.release();
  }
});

export const PATCH = withTenantScope(async (request: NextRequest, context: RouteContext) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return withOpeningStockTransaction(async (client) => {
    const document = await updateOpeningStockDraft(client, {
      businessId: session.businessId,
      documentId: id,
      lines: Array.isArray(body.lines) ? (body.lines as OpeningStockLineInput[]) : [],
      removeItemIds: Array.isArray(body.removeItemIds) ? body.removeItemIds.map(String) : [],
      ...(body.cutoverDate !== undefined ? { cutoverDate: typeof body.cutoverDate === "string" ? body.cutoverDate : null } : {}),
      ...(body.note !== undefined ? { note: typeof body.note === "string" ? body.note : null } : {}),
    });
    return NextResponse.json({ ok: true, document });
  });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: RouteContext) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const { id } = await context.params;
  return withOpeningStockTransaction(async (client) => {
    const document = await cancelOpeningStockDraft(client, {
      businessId: session.businessId,
      documentId: id,
      cancelledBy: session.sub,
    });
    return NextResponse.json({ ok: true, document });
  });
});
