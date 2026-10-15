import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { branchAccessForSession } from "@/lib/automotive-access";
import { isFinancialAccountKind, type FinancialAccountKind } from "@/lib/financial-accounts";
import { createFinancialAccount, listFinancialAccounts } from "@/lib/financial-accounts-service";
import { financialErrorResponse, MalformedBodyError, readJsonObjectBody } from "../financial/support";
import {
  canViewSensitiveFinancialDetails,
  withListVisibility,
  withRecordVisibility,
} from "./visibility";

/**
 * The register of the business's financial accounts (issue #862).
 *
 * Reading is the app's own door (`ledger.view`): an accountant has to know which
 * bank an account is at, and the register is the screen that answers "how much is
 * in each container" — a question the ledger already answers. The *full* bank
 * identifiers are narrower and are masked for a caller without
 * `finance.accounts_manage` (see `financial-accounts.ts`): the register tells an
 * accountant which account a row is without handing over a number that routes
 * money.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const kind = search.get("kind");
  if (kind && !isFinancialAccountKind(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  const status = search.get("status");
  if (status && status !== "active" && status !== "archived" && status !== "all") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  try {
    /*
     * Branch scope, from live membership rather than the session's claim: a
     * member restricted to one branch sees that branch's accounts and the
     * business-wide ones, and never another branch's. It is the same list the
     * service enforces on a write, so a screen can never offer a row the write
     * would refuse.
     */
    const access = await branchAccessForSession(session);
    const result = await listFinancialAccounts(session.businessId, {
      kind: kind ? (kind as FinancialAccountKind) : undefined,
      status: status ? (status as "active" | "archived" | "all") : undefined,
      locationId: search.get("locationId"),
      defaultOnly: search.get("defaultOnly") === "1",
      q: search.get("q") ?? undefined,
      restrictToLocationIds: access.allowedLocationIds,
    });
    return NextResponse.json(withListVisibility(await canViewSensitiveFinancialDetails(session), result));
  } catch (err) {
    return financialErrorResponse(err);
  }
});

interface FinancialAccountBody {
  kind?: unknown;
  name?: unknown;
  code?: unknown;
  glAccountId?: unknown;
  currencyCode?: unknown;
  locationId?: unknown;
  isDefault?: unknown;
  description?: unknown;
  notes?: unknown;
  bankName?: unknown;
  bankBranchName?: unknown;
  accountNumber?: unknown;
  cardNumber?: unknown;
  iban?: unknown;
  accountHolder?: unknown;
  settlementReference?: unknown;
  pspProvider?: unknown;
  terminalNumber?: unknown;
  merchantNumber?: unknown;
  settlementAccountId?: unknown;
  settlementDelayDays?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Registers one financial account.
 *
 * The branch the account belongs to is the caller's active one unless the body
 * names another — the same rule cheque capture uses, and for the same reason: an
 * account registered by mistake into the wrong branch is a container nobody
 * reconciles. `locationId: null` (or omitted, for a member with no active
 * branch) is a business-wide account, which is how a business with one bank
 * operates.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeAccountsManage);
  if (error) return error;

  let body: FinancialAccountBody;
  try {
    const parsed = await readJsonObjectBody(request);
    if (!isObject(parsed)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    body = parsed as FinancialAccountBody;
  } catch (err) {
    if (err instanceof MalformedBodyError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw err;
  }

  try {
    const access = await branchAccessForSession(session);
    const requested =
      typeof body.locationId === "string" && body.locationId.trim() ? body.locationId.trim() : null;
    const locationId = requested ?? access.activeLocationId;
    const result = await createFinancialAccount({
      businessId: session.businessId,
      actorId: session.sub,
      locationId,
      input: body,
      allowedLocationIds: access.allowedLocationIds,
    });
    return NextResponse.json(
      withRecordVisibility(await canViewSensitiveFinancialDetails(session), result.account),
      { status: 201 },
    );
  } catch (err) {
    return financialErrorResponse(err);
  }
});
