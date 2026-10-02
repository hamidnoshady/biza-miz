import { NextRequest, NextResponse } from "next/server";
import { billingReconciliation, retryBillingEvent, runPlatformCompanyBillingTick } from "@/lib/platform-company-billing";
import { withPlatformCompany } from "@/lib/platform-company";
import { withPlatformScope } from "@/lib/platform-auth";
import { PERMISSIONS } from "@/lib/permissions";

export const GET = withPlatformScope(async () => {
  const result = await withPlatformCompany(PERMISSIONS.ledgerView, (actor) => billingReconciliation(actor.businessId));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ events: result.value });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const body = await request.json().catch(() => null) as { eventId?: string } | null;
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
