import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import {
  flushWpOutbox,
  resolveWpQueueReview,
  retryAllFailedWpQueue,
  retryWpQueueRow,
  verifyWpQueueReview,
  wpQueueMaxAttempts,
  wpQueuePage,
  wpQueueSummary,
  type WpQueueFilterOptions,
  type WpReviewResolution,
} from "@/lib/integrations/wp-manager-service";

/**
 * The operational queue for one connection: outbound outbox jobs (stock,
 * prices, product/order operations, export requests) plus inbound events.
 * The manager's «صف و رویدادها» section reads this so «چرا این سفارش نیامد؟»
 * has one place to look.
 *
 * The list is metadata-only — full payloads are per-row diagnostics
 * (`GET /queue/[id]`, sync permission, redacted) — and every action goes
 * through the same service-level guards (tenant scope, paused connection,
 * retryable state), so this route and `/queue/[id]/retry` cannot drift
 * apart (issue #942, F06/F13/F17).
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

  const [pageResult, summary] = await Promise.all([
    wpQueuePage(session.businessId, connectionId, {
      status: status || undefined,
      direction: direction || undefined,
      search,
      limit,
      page,
      pageSize,
    }),
    wpQueueSummary(session.businessId, connectionId),
  ]);

  return NextResponse.json({
    rows: pageResult.rows,
    summary,
    total: pageResult.total,
    page: pageResult.page,
    pageSize: pageResult.pageSize,
    totalPages: pageResult.totalPages,
    // The attempt cap actually in force for this connection's mode, so the
    // UI never quotes the other mode's policy (issue #942, F16).
    maxAttempts: wpQueueMaxAttempts(connection.link_mode),
    mode: connection.link_mode,
  });
});

/**
 * Service refusal → HTTP status (issue #942, F05): a state conflict (the row
 * is sent/processing/needs_review, or the connection is paused) is a 409, a
 * missing row a 404 — never a blanket 400 that reads as a client bug.
 */
function actionFailure(result: { error?: string; status?: string }): NextResponse {
  const error = result.error ?? "action_failed";
  const httpStatus =
    error === "not_found" || error === "connection_not_found"
      ? 404
      : error === "not_retryable" || error === "not_in_review" || error === "connection_paused"
        ? 409
        : 400;
  return NextResponse.json({ ok: false, error, status: result.status }, { status: httpStatus });
}

/** Action handler: retry single, resolve a needs_review row, retry a bounded batch, flush outbox. */
export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  let body: {
    action?: "retry" | "retry_all" | "flush" | "resolve_review" | "verify_review";
    connectionId?: string;
    id?: string;
    direction?: "out" | "in";
    resolution?: WpReviewResolution;
  } = {};

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { action, connectionId, id, direction, resolution } = body;
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // verify_review is a read-only probe (it never mutates the row), so it is
  // allowed even on a paused connection — pausing must not blind the
  // operator who is trying to resolve an ambiguous operation (F11).
  if (connection.status === "paused" && action !== "verify_review") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }

  if (action === "verify_review") {
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    const result = await verifyWpQueueReview(session.businessId, connectionId, id, session.sub);
    if (!result.ok) return actionFailure(result);
    return NextResponse.json({ ok: true, verdict: result.verdict, detail: result.detail });
  }

  if (action === "retry") {
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    const result = await retryWpQueueRow(session.businessId, connectionId, id, direction, session.sub);
    if (!result.ok) return actionFailure(result);
    return NextResponse.json({ ok: true, status: result.status });
  }

  if (action === "resolve_review") {
    if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
    if (resolution !== "mark_sent" && resolution !== "retry" && resolution !== "stop") {
      return NextResponse.json({ error: "missing_resolution" }, { status: 400 });
    }
    const result = await resolveWpQueueReview(session.businessId, connectionId, id, resolution, session.sub);
    if (!result.ok) return actionFailure(result);
    return NextResponse.json({ ok: true, status: result.status });
  }

  if (action === "retry_all") {
    const result = await retryAllFailedWpQueue(session.businessId, connectionId);
    if (!result.ok) return actionFailure(result);
    return NextResponse.json(result);
  }

  if (action === "flush") {
    const result = await flushWpOutbox(session.businessId, connectionId);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
});
