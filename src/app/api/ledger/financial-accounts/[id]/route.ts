import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { branchAccessForSession } from "@/lib/automotive-access";
import {
  getFinancialAccount,
  reactivateFinancialAccount,
  refuseFinancialAccountDelete,
  updateFinancialAccount,
  type FinancialAccountRecord,
} from "@/lib/financial-accounts-service";
import { financialErrorResponse, MalformedBodyError, readJsonObjectBody } from "../../financial/support";
import { canViewSensitiveFinancialDetails, withRecordVisibility } from "../visibility";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One account, with its ledger-derived balance. A malformed id is the same 404 as an unknown one. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });
  try {
    const account = await getFinancialAccount(session.businessId, id);
    if (!account) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });
    return NextResponse.json(withRecordVisibility(await canViewSensitiveFinancialDetails(session), account));
  } catch (err) {
    return financialErrorResponse(err);
  }
});

/**
 * One edit is one request.
 *
 * `isActive` is refused here on purpose: retiring an account is
 * `POST …/archive` (and coming back is `POST …/restore`), because archiving has
 * a rule attached — an account holding money cannot be retired — and a PATCH
 * that flipped the flag would be that rule's back door. The identity fields
 * (GL account, kind, currency) are writable only until the account has history;
 * the service says so and the database's trigger enforces it.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await readJsonObjectBody(request);
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }

  try {
    const access = await branchAccessForSession(session);
    const result = await updateFinancialAccount({
      businessId: session.businessId,
      accountId: id,
      actorId: session.sub,
      input: body,
      allowedLocationIds: access.allowedLocationIds,
    });
    return NextResponse.json(withRecordVisibility(await canViewSensitiveFinancialDetails(session), result.account));
  } catch (err) {
    return financialErrorResponse(err);
  }
});

/**
 * DELETE always fails, with a sentence.
 *
 * A financial account is the only record of which GL account held which money in
 * which branch; deleting it would erase accounting evidence. The answer is a
 * named 409 (`financial_account_delete_forbidden`) rather than a 405 so the
 * screen can explain «بایگانی کنید» instead of showing an unsupported-method
 * error, and so an integration that tried to delete learns what to do instead.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });
  try {
    // The existence check comes first so an unknown id is still a 404 — the
    // refusal is about *this* account, not about the method.
    const account: FinancialAccountRecord | null = await getFinancialAccount(session.businessId, id);
    if (!account) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });
    refuseFinancialAccountDelete();
  } catch (err) {
    return financialErrorResponse(err);
  }
});

/**
 * Bring an archived account back.
 *
 * Its own small endpoint rather than a PATCH field, so the audit trail says
 * «بازگردانی» and the register's restore button does not have to send the whole
 * record back to flip one boolean.
 */
export const PUT = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });
  try {
    const access = await branchAccessForSession(session);
    const result = await reactivateFinancialAccount({
      businessId: session.businessId,
      accountId: id,
      actorId: session.sub,
      allowedLocationIds: access.allowedLocationIds,
    });
    return NextResponse.json(withRecordVisibility(await canViewSensitiveFinancialDetails(session), result.account));
  } catch (err) {
    return financialErrorResponse(err);
  }
});
