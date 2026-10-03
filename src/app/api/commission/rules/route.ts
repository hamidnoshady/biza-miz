import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listCommissionRules,
  listSalesStaff,
  setCommissionRuleActive,
  upsertCommissionRule,
  type CommissionRuleInput,
} from "@/lib/commission-service";

/** The business's commission rules (all employees) plus the staff picker for the editor. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;
  const [rules, staff] = await Promise.all([
    listCommissionRules(session.businessId, undefined, true),
    listSalesStaff(session.businessId),
  ]);
  return NextResponse.json({ rules, staff });
});

/** Creates one commission rule for a selling employee. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionManage);
  if (error) return error;

  let body: CommissionRuleInput;
  try {
    body = (await request.json()) as CommissionRuleInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.employeeId || !body.kind || !body.basis) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const rule = await upsertCommissionRule(session.businessId, body);
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});

/** Activates or retires one rule. History is kept; a deactivated rule simply stops earning. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionManage);
  if (error) return error;

  let body: { ruleId?: string; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.ruleId || typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    await setCommissionRuleActive(session.businessId, body.ruleId, body.isActive);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "not_found", message: (err as Error).message }, { status: 404 });
  }
});
