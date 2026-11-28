import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveAdaptiveContextForMember } from "@/lib/adaptive-context-service";
import { PLAYBOOK_CATALOG } from "@/lib/playbooks/catalog";
import { rankPlaybooks } from "@/lib/playbooks/eligibility";
import { listPlaybookInstances } from "@/lib/playbooks/instances";

/**
 * Playbook discovery (issue #1590). Deterministic; no AI call. Returns only
 * templates visible to this member; `launchable` reflects server-resolved
 * authorization + readiness; nothing here writes. Tenant/branch isolation by
 * session + RLS. App/module/permission enforced again on launch.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireAnyPermission(PERMISSIONS.crmView, PERMISSIONS.growthView);
  if (error) return error;

  const app = request.nextUrl.searchParams.get("app"); // crm | growth | null
  const ctx = await resolveAdaptiveContextForMember({ businessId: session.businessId, userId: session.sub });

  const ranked = rankPlaybooks(
    PLAYBOOK_CATALOG.filter((t) => (app ? t.owningApp === app : true)),
    ctx,
  );

  // Active instances per template (real state; no fabricated results).
  const instances = await listPlaybookInstances(session.businessId, { limit: 500 });
  const activeByTemplate = new Map<string, number>();
  for (const i of instances) {
    if (i.status === "running" || i.status === "paused" || i.status === "scheduled" || i.status === "pending_approval" || i.status === "draft") {
      activeByTemplate.set(i.templateKey, (activeByTemplate.get(i.templateKey) ?? 0) + 1);
    }
  }

  return NextResponse.json({
    context: {
      size: ctx.profile.size,
      industry: ctx.profile.industry,
      goals: ctx.profile.goals,
      density: ctx.presentation.density,
      toolsView: ctx.presentation.toolsView,
    },
    templates: ranked.map((r) => ({
      ...r.template,
      eligibility: r.eligibility,
      score: r.score,
      reasonsFa: r.reasonsFa,
      activeInstances: activeByTemplate.get(r.template.key) ?? 0,
    })),
  });
});
