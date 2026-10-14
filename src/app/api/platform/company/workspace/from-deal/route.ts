import { NextRequest, NextResponse } from "next/server";
import { withPlatformScope } from "@/lib/platform-auth";
import { withPlatformCompany } from "@/lib/platform-company";
import { createCompanyProjectFromDeal } from "@/lib/platform-company-projects";
import { PERMISSIONS } from "@/lib/permissions";
import { platformAudit } from "@/lib/platform-auth";

/**
 * CRM deal → My Workspace project.
 *
 * Called from the Platform Business CRM page's «ایجاد پروژه» action. The deal
 * is looked up inside the internal company's own tenant scope, so a deal id
 * belonging to a customer tenant is not reachable here at all. The handoff is
 * idempotent by `creation_key`: a retry — a double click, a network replay, a
 * worker restart — returns the existing project instead of creating a second
 * one, and the response says which happened.
 *
 * It never posts revenue. The deal's value is carried across as
 * `forecast_revenue_rial`, a project figure, and stays out of the ledger until
 * Accounting records the real thing.
 */
export const POST = withPlatformScope(async (request: NextRequest): Promise<NextResponse> => {
  const body = (await request.json().catch(() => null)) as { dealId?: string } | null;
  if (!body?.dealId) return NextResponse.json({ error: "deal_id_required" }, { status: 400 });
  try {
    const result = await withPlatformCompany(PERMISSIONS.workspaceManage, async (actor) => {
      const project = await createCompanyProjectFromDeal(
        { businessId: actor.businessId, actorUserId: actor.userId, actorName: actor.fullName },
        body.dealId!,
      );
      await platformAudit({
        adminId: actor.platformAdminId,
        businessId: actor.businessId,
        action: "platform_company.project.from_deal",
        entity: "ai_project",
        entityId: project.projectId,
        payload: { dealId: project.dealId, created: project.created },
      });
      return project;
    });
    if (!result.ok || !result.value) {
      return NextResponse.json(
        { error: result.error ?? "unknown_error" },
        { status: result.status },
      );
    }
    return NextResponse.json({ project: result.value }, { status: result.value.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown_error";
    const status =
      code === "deal_not_found"
        ? 404
        : code === "deal_not_won"
          ? 409
          : code === "invalid_project_link" || code === "project_not_found"
            ? 400
            : 500;
    return NextResponse.json({ error: code }, { status });
  }
});
