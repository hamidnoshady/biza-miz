import { NextRequest, NextResponse } from "next/server";
import { searchConversations } from "@/lib/ai-conversations";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { standardReportsFor } from "@/lib/reports";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";

const MAX_RESULTS = 8;

/**
 * AI Hub Wave 5 (issue #145) — the composer's restricted search, replacing a
 * general web-browsing icon per Phase 18b's own out-of-scope decision: it
 * only ever searches this business's own standard reports (static labels,
 * no query execution here) and the caller's own past conversations
 * (ownership-scoped exactly like GET /api/ai/conversations).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const session = guard.session;

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);
  if (!q) return NextResponse.json({ conversations: [], reports: [] });

  const needle = q.toLowerCase();
  const industry = await getBusinessIndustry(session.businessId);
  const reports = standardReportsFor(industry).filter(
    (report) => report.label.toLowerCase().includes(needle) || report.key.toLowerCase().includes(needle),
  )
    .slice(0, MAX_RESULTS)
    .map((report) => ({ key: report.key, label: report.label }));

  const conversations = await searchConversations(
    { businessId: session.businessId, actorUserId: session.sub },
    q,
    MAX_RESULTS,
    { mode: "dashboard" },
  );

  return NextResponse.json({ conversations, reports });
});
