import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteConnection, updateConnection } from "@/lib/integrations/connections-service";
import type { SourceOfTruth } from "@/lib/integrations/outbox-policy";

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;
  const connection = await getAccessibleConnection(session, id);
  if (!connection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (connection.provider !== "woocommerce" && Object.keys(body).some((key) => !["name", "status", "locationId"].includes(key))) {
    return NextResponse.json({ error: "provider_mismatch" }, { status: 400 });
  }

  // Branch movement is subject to the same active-assignment contract as create.
  // Null may not turn a branch-scoped connection into a business-wide one.
  if (body.locationId !== undefined) {
    const location = await resolveActiveLocation(session);
    if (!location || body.locationId !== location.id) {
      return NextResponse.json({ error: "location_mismatch" }, { status: 403 });
    }
  }

  const result = await updateConnection(session.businessId, id, {
    name: typeof body.name === "string" ? body.name : undefined,
    locationId: typeof body.locationId === "string" ? body.locationId : body.locationId === null ? null : undefined,
    status: body.status === "active" || body.status === "paused" ? body.status : undefined,
    syncOrders: typeof body.syncOrders === "boolean" ? body.syncOrders : undefined,
    syncProducts: typeof body.syncProducts === "boolean" ? body.syncProducts : undefined,
    syncCustomers: typeof body.syncCustomers === "boolean" ? body.syncCustomers : undefined,
    pushStock: typeof body.pushStock === "boolean" ? body.pushStock : undefined,
    pushPrices: typeof body.pushPrices === "boolean" ? body.pushPrices : undefined,
    // Validated by the service: an unknown value is a 400, not silently dropped.
    sourceOfTruth: typeof body.sourceOfTruth === "string" ? (body.sourceOfTruth as SourceOfTruth) : undefined,
    manageStockOptIn: typeof body.manageStockOptIn === "boolean" ? body.manageStockOptIn : undefined,
    syncCategories: typeof body.syncCategories === "boolean" ? body.syncCategories : undefined,
    autoPullOrders: typeof body.autoPullOrders === "boolean" ? body.autoPullOrders : undefined,
    orderLookbackDays: typeof body.orderLookbackDays === "number" ? body.orderLookbackDays : undefined,
    consumerKey: typeof body.consumerKey === "string" && body.consumerKey ? body.consumerKey : undefined,
    consumerSecret: typeof body.consumerSecret === "string" && body.consumerSecret ? body.consumerSecret : undefined,
    wpUsername: typeof body.wpUsername === "string" && body.wpUsername ? body.wpUsername : undefined,
    wpApplicationPassword:
      typeof body.wpApplicationPassword === "string" && body.wpApplicationPassword ? body.wpApplicationPassword : undefined,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 400 });
  return NextResponse.json({ connection: result.connection });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;
  if (!(await getAccessibleConnection(session, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const deleted = await deleteConnection(session.businessId, id, session.sub);
  if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
