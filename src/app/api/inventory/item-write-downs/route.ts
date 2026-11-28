/**
 * GH #1567 F3 — net-realisable-value write-downs for the items model.
 *
 *  GET  — the active branch's write-downs (and reversals).
 *  POST — the reviewed write-down: inventory.adjust + ledger.approve,
 *         `confirm: true`, a reason, the fingerprint from `…/preview` and an
 *         idempotency key. Lowers carrying value (never quantity) and posts
 *         Dr 5170 / Cr inventory. Refused unless NRV < carrying value.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import {
  itemWriteDownIndustryError,
  readWriteDownBody,
  withItemWriteDownClient,
} from "@/lib/item-write-down-http";
import { createItemWriteDown, listItemWriteDowns } from "@/lib/item-nrv-write-down-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryView, PERMISSIONS.ledgerView);
  if (error) return error;
  const industryError = await itemWriteDownIndustryError(session.businessId);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const itemId = request.nextUrl.searchParams.get("itemId");
  return withItemWriteDownClient(async (client) => {
    const writeDowns = await listItemWriteDowns(client, {
      businessId: session.businessId,
      locationId: location.id,
      itemId: itemId && /^[0-9a-f-]{36}$/i.test(itemId) ? itemId : null,
    });
    return NextResponse.json({ writeDowns });
  }, { transaction: false });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerApprove);
  if (error) return error;
  const industryError = await itemWriteDownIndustryError(session.businessId);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const body = await readWriteDownBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  return withItemWriteDownClient(async (client) => {
    const result = await createItemWriteDown(client, {
      businessId: session.businessId,
      locationId: location.id,
      itemId: typeof body.itemId === "string" ? body.itemId : "",
      nrvUnitValue: typeof body.nrvUnitValue === "string" || typeof body.nrvUnitValue === "number" ? body.nrvUnitValue : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : "",
      reviewedFingerprint: typeof body.fingerprint === "string" ? body.fingerprint : "",
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, ...result }, { status: result.duplicate ? 200 : 201 });
  }, { transaction: true });
});
