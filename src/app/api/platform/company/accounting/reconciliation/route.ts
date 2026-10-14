import { NextRequest, NextResponse } from "next/server";
import {
  billingReconciliation,
  retryBillingEvent,
  runPlatformCompanyBillingTick,
  type ReconciliationFilter,
} from "@/lib/platform-company-billing";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { PERMISSIONS } from "@/lib/permissions";
import type { BillingEventStatus } from "@/lib/platform-company-types";

const STATUSES: BillingEventStatus[] = ["pending", "processing", "posted", "failed", "ignored"];

function filterFrom(url: URL): ReconciliationFilter {
  const status = url.searchParams.get("status");
  const kind = url.searchParams.get("kind");
  const limit = Number(url.searchParams.get("limit"));
  const offset = Number(url.searchParams.get("offset"));
  return {
    status:
      status && (STATUSES as string[]).includes(status)
        ? (status as BillingEventStatus)
        : status === "needs_attention"
          ? "needs_attention"
          : undefined,
    kind: kind && kind.length <= 64 ? kind : undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
    offset: Number.isFinite(offset) ? offset : undefined,
  };
}

export const GET = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  const result = await withPlatformCompany(PERMISSIONS.ledgerView, (actor) =>
    billingReconciliation(actor.businessId, filterFrom(request.nextUrl)),
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ...result.value });
});

/**
 * Requeue one failed event and run a single-item tick so the operator sees the
 * outcome immediately instead of waiting for the next scheduled pass.
 *
 * The retry is refused for events the bridge knows cannot succeed on a blind
 * retry (`failure_kind = 'permanent'`); the reconciliation UI explains what is
 * missing instead of offering a button that will only fail again.
 */
export const POST = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json().catch(() => null)) as { eventId?: string } | null;
  if (!body?.eventId) return NextResponse.json({ error: "event_id_required" }, { status: 400 });
  const result = await withPlatformCompany(PERMISSIONS.ledgerPost, async (actor) => {
    const retried = await retryBillingEvent(actor.businessId, body.eventId!);
    if (retried) await runPlatformCompanyBillingTick(1);
    return retried;
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.value) return NextResponse.json({ error: "failed_event_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
