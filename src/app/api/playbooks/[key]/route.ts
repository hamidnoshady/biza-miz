import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { playbookByKey } from "@/lib/playbooks/catalog";
import { resolveAdaptiveContextForMember } from "@/lib/adaptive-context-service";
import { evaluateEligibility } from "@/lib/playbooks/eligibility";

/** One template + real eligibility for this member. */
export const GET = withTenantScope(async (_req: NextRequest, { params }: { params: Promise<{ key: string }> }) => {
  const { session, error } = await requireAnyPermission(PERMISSIONS.crmView, PERMISSIONS.growthView);
  if (error) return error;
  const { key } = await params;
  const template = playbookByKey(decodeURIComponent(key));
  if (!template || template.publicationState !== "published") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ctx = await resolveAdaptiveContextForMember({ businessId: session.businessId, userId: session.sub });
  const eligibility = evaluateEligibility(template, ctx);
  if (!eligibility.visible) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ template, eligibility });
});
