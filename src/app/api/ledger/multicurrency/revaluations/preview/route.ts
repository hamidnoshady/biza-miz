import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { MulticurrencyError, previewFxRevaluation } from "@/lib/multicurrency-service";

/**
 * The revaluation confirmation screen's preview: exactly what a run for this
 * currency and as-of date WOULD post — per-account restatement lines, gains
 * and losses — without posting it. The run itself is POST /revaluations; the
 * preview never writes.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const url = new URL(request.url);
  const currencyCode = url.searchParams.get("currency");
  const asOf = url.searchParams.get("asOf");
  const rateId = url.searchParams.get("rateId");
  if (!currencyCode || !asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || (rateId != null && rateId !== "")) {
    // A preview is always at the as-of rate: pinning a specific rate row is a
    // posting-time decision the preview surface does not offer.
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const preview = await previewFxRevaluation({
      businessId: session.businessId,
      currencyCode,
      asOf,
      rateId: null,
    });
    return NextResponse.json(preview);
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
