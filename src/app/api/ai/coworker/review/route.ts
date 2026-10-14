import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requirePermission } from "@/lib/auth";
import { runAccountingReview } from "@/lib/accounting-review-service";

/**
 * Phase 32 — «بازبینی حساب‌ها» on demand. Deterministic: no provider call, no
 * credits, and the same findings the scheduled job would produce from the same
 * books. See accounting-review.ts for why this is a rule engine, not a prompt.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  const asOfDate = request.nextUrl.searchParams.get("asOfDate") ?? undefined;
  const windowParam = Number(request.nextUrl.searchParams.get("windowDays"));
  const windowDays = Number.isFinite(windowParam) && windowParam > 0 ? Math.min(365, windowParam) : undefined;

  const review = await runAccountingReview(guard.session.businessId, { asOfDate, windowDays });
  return NextResponse.json(review);
});
