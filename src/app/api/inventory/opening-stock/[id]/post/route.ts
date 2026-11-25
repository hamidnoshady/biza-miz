/**
 * GH #1567 F2 — post a reviewed opening-stock draft: receive every line and
 * post Dr inventory / Cr opening equity in one transaction, exactly once.
 *
 * Needs inventory.adjust + ledger.approve, `confirm: true` and the fingerprint
 * returned by the review (GET …/[id]); a draft edited since the review is
 * refused with `review_stale`. A replay of the same post returns the original
 * result with `duplicate: true`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import {
  openingStockIndustryError,
  readJsonBody,
  withOpeningStockTransaction,
} from "@/lib/item-opening-stock-http";
import { postOpeningStock } from "@/lib/item-opening-stock-service";
import { PERMISSIONS } from "@/lib/permissions";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withTenantScope(async (request: NextRequest, context: RouteContext) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerApprove);
  if (error) return error;
  const industryError = await openingStockIndustryError(session.businessId);
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  return withOpeningStockTransaction(async (client) => {
    const result = await postOpeningStock(client, {
      businessId: session.businessId,
      documentId: id,
      reviewedFingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "",
      postedBy: session.sub,
    });
    return NextResponse.json({ ok: true, ...result });
  });
});
