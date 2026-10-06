import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAiUsageSummary } from "@/lib/ai-usage-service";
import { normalizeWindowDays } from "@/lib/ai-usage-shared";

/**
 * AI Usage — a read-only lens over the wallet settlements every AI turn writes.
 *
 * A manager may read their business's own AI spend over a bounded window
 * (`?days=7|30|90`, clamped so a hand-typed query can't run an unbounded scan).
 * It writes nothing and calls no provider — the numbers are the billing the
 * wallet already recorded, sliced by origin.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireAnyPermission(PERMISSIONS.aiUsageView, PERMISSIONS.aiManage);
  if (guard.error) return guard.error;

  const url = new URL(request.url);
  const windowDays = normalizeWindowDays(url.searchParams.get("days"));
  const summary = await getAiUsageSummary(guard.session.businessId, windowDays);
  return NextResponse.json({ summary });
});
