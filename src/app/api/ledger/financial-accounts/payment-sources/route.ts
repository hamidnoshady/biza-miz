import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { classifyAccounts, EXPENSE_PAYMENT_SOURCE_ROLES, type AccountRole } from "@/lib/account-classification";
import { isUuid } from "@/lib/uuid";
import { loadFinancialAccountsForPayments } from "@/lib/financial-accounts-service";
import { paymentSourceOptions } from "@/lib/financial-payment-sources";
import { financialErrorResponse } from "../../financial/support";
import { branchAccessForSession } from "@/lib/automotive-access";
import { financialAccountDisplayLabel } from "@/lib/financial-accounts";

/**
 * The payment-source contract (issue #862, §7).
 *
 * Every workflow that already pays money out of one of the business's own
 * accounts — expenses (#832), supplier payments, payroll payouts, receipt
 * settlement (#829/#830) — asks the same question: which GL accounts may this
 * payment come out of? That rule already exists per workflow (`expense-accounts.ts`
 * and its siblings). What this endpoint adds is the *annotation*: for each of
 * those accounts, which registered financial account backs it.
 *
 * It changes nobody's posting. The journal entry still names the chart account,
 * exactly as before; a business that never opens «حساب‌های مالی» gets the same
 * list it always had, with the financial-account columns empty. That is what
 * makes the integration additive rather than a rewrite of four other issues'
 * work.
 *
 * `role=expense` is the one rule implemented here (the expense payment source,
 * `EXPENSE_PAYMENT_SOURCE_ROLES`), because it is the rule four of those
 * workflows share; a caller with its own rule passes none and gets every active
 * GL account annotated instead.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const search = new URL(request.url).searchParams;
  const role = search.get("role");
  const { session, error } = await requirePermission(role === "bank" ? PERMISSIONS.financeChequesManage : role === "purchase" ? PERMISSIONS.purchasesManage : PERMISSIONS.ledgerView);
  if (error) return error;

  const requestedLocation = search.get("locationId");
  if (requestedLocation && !isUuid(requestedLocation)) {
    return NextResponse.json({ error: "invalid_location" }, { status: 400 });
  }
  if (role !== null && role !== "expense" && role !== "any" && role !== "bank" && role !== "purchase") {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  try {
    const access = await branchAccessForSession(session);
    const locationId = requestedLocation === null ? access.activeLocationId : requestedLocation || null;
    if (locationId && !access.allowedLocationIds.includes(locationId)) {
      return NextResponse.json({ error: "location_not_found" }, { status: 404 });
    }
    const { rows } = await query<{
      id: string;
      code: string;
      name: string;
      parent_id: string | null;
      type: "asset" | "liability" | "equity" | "revenue" | "expense";
      currency_code: string | null;
    }>(
      `SELECT id, code, name, parent_id, type, currency_code
         FROM accounts
        WHERE business_id = $1 AND is_active
        ORDER BY code`,
      [session.businessId],
    );
    const roles = classifyAccounts(
      rows.map((row) => ({ id: row.id, code: row.code, parentId: row.parent_id, type: row.type })),
    );
    const useExpenseRule = role === null || role === "expense";
    const candidates = rows.filter((row) => {
      if (row.type !== "asset") return false;
      const classified: AccountRole | null = roles.get(row.id) ?? null;
      if (role === "bank") return classified === "bank";
      if (role === "purchase") return classified === "bank" || classified === "cash";
      return useExpenseRule
        ? classified != null && EXPENSE_PAYMENT_SOURCE_ROLES.has(classified)
        : true;
    });

    const { accounts } = await loadFinancialAccountsForPayments(session.businessId);
    const inaccessibleGlIds = new Set(accounts.filter((account) => account.locationId && account.locationId !== locationId).map((account) => account.glAccountId));
    const options = paymentSourceOptions({
      accounts: candidates.filter((row) => !inaccessibleGlIds.has(row.id)).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        parentId: row.parent_id,
        type: row.type,
      })),
      financialAccounts: accounts.map((account) => ({
        id: account.id,
        name: financialAccountDisplayLabel(account),
        kind: account.kind,
        glAccountId: account.glAccountId,
        currencyCode: account.currencyCode,
        locationId: account.locationId,
        isActive: account.isActive,
        isDefault: account.isDefault,
        bankName: account.bankName,
        pspProvider: account.pspProvider,
        terminalNumber: account.terminalNumber,
      })),
      locationId,
    });
    const registeredOnly = role === "bank" || role === "purchase";
    const eligibleOptions = registeredOnly ? options.filter((option) => option.currencyCode === "IRR" &&
      (option.kind === "bank" || (role === "purchase" && option.kind === "cash"))) : options;
    return NextResponse.json({ options: eligibleOptions });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
