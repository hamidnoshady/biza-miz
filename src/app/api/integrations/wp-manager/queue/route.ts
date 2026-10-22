import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import {
  flushWpOutbox,
  retryAllFailedWpQueue,
  retryWpQueueRow,
  wpQueue,
  wpQueueSummary,
  type WpQueueFilterOptions,
} from "@/lib/integrations/wp-manager-service";

/**
 * The operational queue for one connection: outbound outbox jobs (stock,
 * prices, product/order operations, export requests) that are pending/failed/
 * dead, plus inbound events that failed to apply. The manager's «صف و
 * رویدادها» section reads this so «چرا این سفارش نیامد؟» has one place to look.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const status = url.searchParams.get("status") as WpQueueFilterOptions["status"] | null;
  const direction = url.searchParams.get("direction") as WpQueueFilterOptions["direction"] | null;
  const search = url.searchParams.get("search") || undefined;
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
  const limit = parsedLimit && Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, parsedLimit)) : undefined;
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(parsedPage) ? Math.max(1, parsedPage) : 1;
  const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? String(limit ?? 25), 10);
  const pageSize = Number.isFinite(parsedPageSize) ? Math.min(100, Math.max(10, parsedPageSize)) : limit ?? 25;

  const [rows, summary] = await Promise.all([
    wpQueue(session.businessId, connectionId, {
      status: status || undefined,
      direction: direction || undefined,
      search,
      limit,
      page,
      pageSize,
    }),
    wpQueueSummary(session.businessId, connectionId),
  ]);

  return NextResponse.json({ rows, summary, page, pageSize });
});

/** Action handler: retry single, retry all failed, flush outbox queue. */
export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  let body: {
    action?: "retry" | "retry_all" | "flush";
    connectionId?: string;
    id?: string;
    direction?: "out" | "in";
  } = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { action, connectionId, id, direction } = body;
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }

  if (action === "retry") {
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    const result = await retryWpQueueRow(session.businessId, connectionId, id, direction);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error ?? "retry_failed" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, status: result.status });
  }

  if (action === "retry_all") {
    const result = await retryAllFailedWpQueue(session.businessId, connectionId);
    return NextResponse.json({ ok: true, outboxRetried: result.outboxRetried, inboxRetried: result.inboxRetried });
  }

  if (action === "flush") {
    const result = await flushWpOutbox(session.businessId, connectionId);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
