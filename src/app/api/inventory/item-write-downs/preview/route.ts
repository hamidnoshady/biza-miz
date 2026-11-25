/**
 * GH #1567 F3 — read-only preview of an items-model NRV write-down: carrying
 * value, NRV, the amount it would post and the fingerprint to post it with.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import {
  itemWriteDownIndustryError,
  readWriteDownBody,
  withItemWriteDownClient,
} from "@/lib/item-write-down-http";
import { previewItemWriteDown } from "@/lib/item-nrv-write-down-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryView, PERMISSIONS.ledgerView);
  if (error) return error;
  const industryError = await itemWriteDownIndustryError(session.businessId);
  if (industryError) return industryError;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const body = await readWriteDownBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return withItemWriteDownClient(async (client) => {
    const preview = await previewItemWriteDown(client, {
      businessId: session.businessId,
      locationId: location.id,
      itemId: typeof body.itemId === "string" ? body.itemId : "",
      nrvUnitValue: typeof body.nrvUnitValue === "string" || typeof body.nrvUnitValue === "number" ? body.nrvUnitValue : "",
    });
    return NextResponse.json(preview);
  }, { transaction: false });
});
