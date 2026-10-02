import { NextRequest, NextResponse } from "next/server";
import { withPlatformScope } from "@/lib/platform-auth";
import { withPlatformCompany } from "@/lib/platform-company";
import { createCompanyProjectFromDeal } from "@/lib/platform-company-projects";
import { PERMISSIONS } from "@/lib/permissions";

export const POST = withPlatformScope(async (request: NextRequest) => {
  const body = await request.json().catch(() => null) as { dealId?: string } | null;
  if (!body?.dealId) return NextResponse.json({ error: "deal_id_required" }, { status: 400 });
  try {
    const result = await withPlatformCompany(PERMISSIONS.workspaceManage, (actor) =>
      createCompanyProjectFromDeal({ businessId: actor.businessId, actorUserId: actor.userId, actorName: actor.fullName }, body.dealId!),
    );
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ project: result.value }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown_error";
    const status = code === "deal_not_found" ? 404 : 409;
    return NextResponse.json({ error: code }, { status });
  }
});
