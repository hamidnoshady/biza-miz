import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { enqueueOperation, storeOrderFacetsFor, storeOrderKnownFor, storeOrdersPageFor } from "@/lib/integrations/woo-ops-service";

/**
 * The store's orders, and the two operations an owner asks for against one:
 * change its status, or refund it.
 *
 * Both are queued, never applied inline. In plugin mode the app cannot reach
 * the store at all, so an inline call would simply fail there; going through
 * the outbox means the same button works for both connection modes and gets
 * retry, backoff and a visible trail for free.
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const url = new URL(request.url);
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const page = Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1);
  const pageSize = Math.min(50, Math.max(10, Number.isFinite(parsedPageSize) ? parsedPageSize : 25));
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const status = (url.searchParams.get("status") ?? "").trim().slice(0, 80);
  const ingestStatus = (url.searchParams.get("ingestStatus") ?? "").trim().slice(0, 80);
  const viewParam = (url.searchParams.get("view") ?? "").trim();
  const view = ["imported", "unrecorded", "queued", "attention"].includes(viewParam)
    ? (viewParam as "imported" | "unrecorded" | "queued" | "attention")
    : "";
  const result = await storeOrdersPageFor(session.businessId, id, { page, pageSize, search, status, ingestStatus, view });
  return NextResponse.json(result);
});

/**
 * One operation against one remote order.
 *
 * `action: "status"` and `action: "refund"` are the whole surface. A refund
 * never moves money through the payment gateway — `api_refund` is forced
 * false on the way in and again in the drain — because recording that a
 * refund was agreed is this app's business and crediting a card is the
 * store's.
 */
export const POST = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;

  const connection = await getAccessibleConnection(session, id);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (connection.status === "paused") return NextResponse.json({ error: "connection_paused" }, { status: 409 });

  let body: { action?: string; remoteId?: string; status?: string; amount?: string; reason?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const remoteId = String(body.remoteId ?? "").trim();
  if (!remoteId) return NextResponse.json({ error: "missing_remote_id" }, { status: 400 });
  if (!(await storeOrderKnownFor(session.businessId, id, remoteId))) {
    return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  }

  try {
    if (body.action === "status") {
      const { sanitizeOrderStatus } = await import("@/lib/integrations/woo-ops-service");
      // A custom status is accepted only when the store has already reported
      // it on one of its orders; the seven canonical ones always are.
      const requested = String(body.status ?? "");
      const known = (await storeOrderFacetsFor(session.businessId, id)).statuses.map((entry) => entry.value);
      const status = sanitizeOrderStatus(requested, known);
      await enqueueOperation(session.businessId, id, "order_status", remoteId, { status });
      return NextResponse.json({ ok: true, queued: true });
    }
    if (body.action === "refund") {
      const { sanitizeRefund } = await import("@/lib/integrations/woo-ops-service");
      const refund = sanitizeRefund({ amount: body.amount, reason: body.reason });
      await enqueueOperation(session.businessId, id, "refund_create", remoteId, refund);
      return NextResponse.json({ ok: true, queued: true });
    }
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    const message = (err as Error).message;
    const known = ["invalid_order_status", "invalid_refund_amount"];
    return NextResponse.json({ error: message }, { status: known.includes(message) ? 400 : 500 });
  }
});
