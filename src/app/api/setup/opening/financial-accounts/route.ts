import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { branchAccessForSession } from "@/lib/automotive-access";
import { requireManager } from "@/lib/setup-state";
import { createFinancialAccount } from "@/lib/financial-accounts-service";
import { accountingSetupEnabled } from "@/lib/setup-opening-service";
import { canViewSensitiveFinancialDetails, withRecordVisibility } from "@/app/api/ledger/financial-accounts/visibility";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Registers a bank, till, petty-cash float or POS terminal from inside the
 * opening step (issue #1583, workstream B).
 *
 * It is a thin wizard door in front of the canonical writer — not a second
 * financial-account registry. What it adds over `POST /api/ledger/financial-accounts`
 * is the onboarding guard the issue asks for: the Accounting app must actually
 * be enabled for this business, and the caller must hold
 * `finance.accounts_manage`. Everything else (GL eligibility, one-to-one
 * linkage, tenant/branch ownership, masking, audit) stays in
 * `createFinancialAccount`.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  const access = await memberAccessFor(session);
  if (!access?.permissions.has(PERMISSIONS.financeAccountsManage)) {
    return NextResponse.json({ error: "permission_denied" }, { status: 403 });
  }
  if (!(await accountingSetupEnabled(session.businessId))) {
    return NextResponse.json(
      { error: "accounting_not_enabled", state: "accounting_not_enabled" },
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!isObject(parsed)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const branchAccess = await branchAccessForSession(session);
    const requested = typeof body.locationId === "string" && body.locationId.trim() ? body.locationId.trim() : null;
    const result = await createFinancialAccount({
      businessId: session.businessId,
      actorId: session.sub,
      locationId: requested ?? branchAccess.activeLocationId,
      input: body,
      allowedLocationIds: branchAccess.allowedLocationIds,
    });
    const canViewSensitive = await canViewSensitiveFinancialDetails(session);
    return NextResponse.json(withRecordVisibility(canViewSensitive, result.account), { status: 201 });
  } catch (err) {
    if (err instanceof Error && "status" in err) {
      const status = Number((err as { status?: number }).status ?? 400);
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
});
