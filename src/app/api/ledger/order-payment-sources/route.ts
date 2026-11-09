import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, requirePermission, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { deploymentRole } from "@/lib/deployment-role";
import {
  ORDER_PAYMENT_ROUTING_SETTING,
  orderPaymentSources,
  readOrderPaymentRouting,
  resolveExplicitOrderSource,
  OrderPaymentRoutingError,
  type WebsitePaymentRoute,
} from "@/lib/order-payment-routing-service";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/uuid";

function websiteRoutesOf(value: unknown): WebsitePaymentRoute[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const routes: WebsitePaymentRoute[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || !isUuid(row.connectionId) || !isUuid(row.financialAccountId) ||
        (row.provider !== "cms" && row.provider !== "woocommerce") ||
        typeof row.gateway !== "string" || !/^[\w.-]{1,100}$/.test(row.gateway) ||
        (row.settlement !== "online" && row.settlement !== "card_to_card" && row.settlement !== "cash")) return null;
    const key = `${row.provider}:${row.connectionId}:${row.gateway}`;
    if (seen.has(key)) return null;
    seen.add(key);
    routes.push({ provider: row.provider, connectionId: row.connectionId, gateway: row.gateway,
      settlement: row.settlement, financialAccountId: row.financialAccountId });
  }
  return routes;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const forRefund = request.nextUrl.searchParams.get("refund") === "1";
  const { session, error } = forRefund
    ? await requirePermission(PERMISSIONS.paymentsRefund)
    : await requireAnyPermission(PERMISSIONS.paymentsTake, PERMISSIONS.financeAccountsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  try {
    const mode = await readOrderPaymentRouting(client, session.businessId, location.id);
    const sources = mode === "enabled" || (forRefund && mode === "disabled")
      ? await orderPaymentSources(client, session.businessId, location.id) : [];
    return NextResponse.json({
      mode,
      sources: sources.map(({ id, name, kind }) => ({ id, name, kind })),
    });
  } finally {
    client.release();
  }
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean" ||
      !("approvalReference" in body) || typeof body.approvalReference !== "string" ||
      !body.approvalReference.trim() || body.approvalReference.length > 240) {
    return NextResponse.json({ error: "payment_routing_approval_required" }, { status: 400 });
  }
  const { enabled } = body;
  const approvalReference = body.approvalReference.trim();
  const providedRoutes = "websiteRoutes" in body ? websiteRoutesOf(body.websiteRoutes) : undefined;
  if (providedRoutes === null) return NextResponse.json({ error: "invalid_website_payment_routes" }, { status: 400 });
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [branch] } = await client.query<{ id: string }>(
      "SELECT id FROM locations WHERE id = $1 AND business_id = $2 FOR UPDATE",
      [location.id, session.businessId],
    );
    const { rows: [peer] } = await client.query<{ paired: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM site_devices
          WHERE location_id = $1 AND business_id = $2 AND status IN ('pending','active')
            AND revoked_at IS NULL) AS paired`,
      [location.id, session.businessId],
    );
    if (!branch || (enabled && (peer?.paired || deploymentRole() !== "central"))) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "payment_routing_peer_unsupported" }, { status: 409 });
    }
    if (enabled && (await orderPaymentSources(client, session.businessId, location.id)).length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "payment_source_required" }, { status: 409 });
    }
    const { rows: [prior] } = await client.query<{ routes: WebsitePaymentRoute[] | null }>(
      "SELECT value->'websiteRoutes' AS routes FROM settings WHERE business_id = $1 AND location_id = $2 AND key = $3",
      [session.businessId, location.id, ORDER_PAYMENT_ROUTING_SETTING],
    );
    const websiteRoutes = providedRoutes ?? prior?.routes ?? [];
    if (enabled || providedRoutes) {
      for (const route of websiteRoutes) {
        const lookup = route.provider === "cms"
          ? "SELECT id FROM eshobe_cms_connections WHERE business_id=$1 AND id=$2 AND (sync_location_id IS NULL OR sync_location_id=$3)"
          : "SELECT id FROM integration_connections WHERE business_id=$1 AND id=$2 AND (location_id IS NULL OR location_id=$3)";
        const { rows } = await client.query(lookup, [session.businessId, route.connectionId, location.id]);
        if (!rows[0]) throw new OrderPaymentRoutingError("invalid_website_payment_routes");
        await resolveExplicitOrderSource(client, session.businessId, location.id, route.settlement, route.financialAccountId);
      }
    }
    const value = JSON.stringify({ enabled, approvalReference, actorId: session.sub, websiteRoutes });
    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [session.businessId, location.id, ORDER_PAYMENT_ROUTING_SETTING, value],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1,$2,$3,'order_payment_routing.changed','location',$2,$4::jsonb)`,
      [session.businessId, location.id, session.sub, value],
    );
    await client.query("COMMIT");
    return NextResponse.json({ enabled });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof OrderPaymentRoutingError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  } finally {
    client.release();
  }
});
