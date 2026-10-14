import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createRuleSet, listRuleSets } from "@/lib/payroll-engine-setup";
import { IRAN_RULE_TEMPLATE } from "@/lib/payroll-engine-calc";
import { badRequest, payrollErrorResponse, readJsonObject } from "@/lib/payroll-http";

/** Issue #865 — the versioned statutory rule sets, newest first, plus the Iranian template. `payroll.view`. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  return NextResponse.json({ ruleSets: await listRuleSets(session.businessId), template: IRAN_RULE_TEMPLATE });
});

/** Enters a new rule-set version (`title`, `effectiveFrom`, `rules`). Never edits an old one. `payroll.manage`. */
export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;
  const body = await readJsonObject(request);
  if (!body) return badRequest();
  try {
    const ruleSet = await createRuleSet({ businessId: session.businessId, actorId: session.sub, title: body.title, effectiveFrom: body.effectiveFrom, rules: body.rules });
    return NextResponse.json({ ruleSet }, { status: 201 });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
