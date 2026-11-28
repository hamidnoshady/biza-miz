import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { playbookByKey } from "@/lib/playbooks/catalog";
import { resolveAdaptiveContextForMember } from "@/lib/adaptive-context-service";
import { evaluateEligibility } from "@/lib/playbooks/eligibility";
import { buildPreflightForTemplate } from "@/lib/playbooks/preflight-service";

/**
 * Safety + cost preflight (dry run). **Writes nothing, sends nothing.** Server
 * re-resolves authorization + eligibility; a blocked preflight is truthful, not
 * a fake Run. Permission to preview is separate from permission to launch.
 */
export const POST = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const { key } = await params;
  const template = playbookByKey(decodeURIComponent(key));
  if (!template || template.publicationState !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Preview permission = same view right as the owning app; launch re-checks separately.
  const previewPermission = template.executionBinding.executor === "crm"
    ? (await import("@/lib/permissions")).PERMISSIONS.crmView
    : (await import("@/lib/permissions")).PERMISSIONS.growthView;
  const { session, error } = await requirePermission(previewPermission);
  if (error) return error;

  const body = await request.json().catch(() => ({}));
  const ctx = await resolveAdaptiveContextForMember({ businessId: session.businessId, userId: session.sub });

  // Hard gate: invisible → 404; visible-but-not-launchable → truthful blocked preflight.
  const eligibility = evaluateEligibility(template, ctx);
  if (!eligibility.visible) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const preflight = await buildPreflightForTemplate(template, ctx, body?.inputs ?? {}, {
    hasOnline: body?.hasOnline !== false,
    businessId: session.businessId,
  });
  return NextResponse.json({ preflight, eligibility });
});
