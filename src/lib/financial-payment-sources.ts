/**
 * The shared payment-source contract (issue #862, phase 7).
 *
 * Every existing money-moving workflow already answers one question — "which of
 * the business's own accounts may this payment come out of?" — and each of them
 * answered it by classifying the chart itself (`expense-accounts.ts`, the A/R
 * and A/P settlement pickers, the payroll payment pickers). Issue #862 adds the
 * missing half: which of those GL accounts is *also* a registered financial
 * account, and therefore a real bank/cash/petty-cash/POS container a business
 * can reason about, transfer between and reconcile.
 *
 * This module is that join, as one pure function. It does not replace the
 * existing eligibility rules — it composes them:
 *
 *   eligible GL accounts  = the caller's own role rule (unchanged)
 *   payment sources       = those, annotated with the financial account that
 *                           backs each one, when the business registered one
 *
 * A business that never opens «حساب‌های مالی» therefore keeps exactly the
 * behaviour it has today: every eligible GL account is still offered, and the
 * financial-account columns are simply empty. That is what makes the
 * integration backward-compatible rather than a rewrite — and the reverse
 * direction (a financial account whose GL account is not eligible for this
 * workflow) is refused by the caller's existing rule, not by this file.
 *
 * Framework-free and database-free, like `account-classification.ts`, so the
 * browser picker and the server check can read the same function.
 */
import type { AccountRole } from "./account-classification";
import type { FinancialAccountKind } from "./financial-accounts";
import { FINANCIAL_ACCOUNT_KIND_ROLE } from "./financial-accounts";

/** The shape of a financial-account row this contract needs. */
export interface FinancialAccountShape {
  id: string;
  name: string;
  kind: FinancialAccountKind;
  glAccountId: string;
  currencyCode: string;
  locationId: string | null;
  isActive: boolean;
  isDefault: boolean;
  bankName?: string | null;
  pspProvider?: string | null;
  terminalNumber?: string | null;
}

/** The shape of a GL account this contract needs. */
export interface PaymentGlAccountShape {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}

export interface PaymentSourceOption {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The registered financial account backing this GL account, when there is one. */
  financialAccountId: string | null;
  financialAccountName: string | null;
  kind: FinancialAccountKind | null;
  /** The financial account's currency, when registered. */
  currencyCode: string | null;
  /** Whether the business marked this account as the default of its kind/scope. */
  isDefault: boolean;
  branchScoped: boolean;
}

/**
 * Which financial account backs each GL account of a tenant.
 *
 * Only ACTIVE rows are considered, and a GL account backing two registered
 * accounts is impossible by construction (`uq_financial_accounts_gl_account`),
 * so this is a plain map rather than a "best match" search.
 */
export function financialAccountByGlAccount(
  financialAccounts: readonly FinancialAccountShape[],
): Map<string, FinancialAccountShape> {
  const map = new Map<string, FinancialAccountShape>();
  for (const account of financialAccounts) {
    if (!account.isActive) continue;
    map.set(account.glAccountId, account);
  }
  return map;
}

/**
 * Annotate a caller's own eligible GL accounts with the financial account that
 * backs each one, in the order the caller gave them (the chart's code order at
 * every call site).
 */
export function paymentSourceOptions(params: {
  accounts: readonly PaymentGlAccountShape[];
  financialAccounts: readonly FinancialAccountShape[];
  /**
   * The branch a payment is being made in, when the caller has one. A
   * branch-scoped financial account belonging to another branch is not offered
   * — the same rule the transfer engine enforces server-side.
   */
  locationId?: string | null;
}): PaymentSourceOption[] {
  const byGl = financialAccountByGlAccount(params.financialAccounts);
  return params.accounts.map((account) => {
    const financial = byGl.get(account.id) ?? null;
    if (financial && financial.locationId && params.locationId && financial.locationId !== params.locationId) {
      return {
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        financialAccountId: null,
        financialAccountName: null,
        kind: null,
        currencyCode: financial.currencyCode,
        isDefault: false,
        branchScoped: true,
      };
    }
    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      financialAccountId: financial?.id ?? null,
      financialAccountName: financial?.name ?? null,
      kind: financial?.kind ?? null,
      currencyCode: financial?.currencyCode ?? null,
      isDefault: financial?.isDefault ?? false,
      branchScoped: financial?.locationId != null,
    };
  });
}

/**
 * The account a form should preselect: the business's declared default for the
 * kind in this branch, else the business-wide default, else nothing (the
 * caller's own first eligible account).
 */
export function defaultFinancialAccountForKind(
  financialAccounts: readonly FinancialAccountShape[],
  kind: FinancialAccountKind,
  locationId: string | null = null,
): FinancialAccountShape | null {
  const candidates = financialAccounts.filter(
    (account) => account.isActive && account.isDefault && account.kind === kind,
  );
  if (locationId) {
    const branchDefault = candidates.find((account) => account.locationId === locationId);
    if (branchDefault) return branchDefault;
  }
  return candidates.find((account) => account.locationId === null) ?? candidates[0] ?? null;
}

/**
 * Which kind of financial account a role's payments belong to — the reverse of
 * `FINANCIAL_ACCOUNT_KIND_ROLE`, for callers that ask "show me my bank accounts"
 * by role rather than by kind.
 */
export function financialAccountKindsForRole(role: AccountRole): FinancialAccountKind[] {
  return (Object.keys(FINANCIAL_ACCOUNT_KIND_ROLE) as FinancialAccountKind[]).filter(
    (kind) => FINANCIAL_ACCOUNT_KIND_ROLE[kind] === role,
  );
}

/**
 * Resolve the financial account a payment's GL account corresponds to, or null
 * for a plain chart account the business has not registered.
 *
 * This is the one lookup the existing workflows need in order to *attribute* a
 * payment to a container without changing where the money posts: the ledger
 * entry still names the GL account, exactly as before.
 */
export function resolveFinancialAccountForPayment(
  financialAccounts: readonly FinancialAccountShape[],
  glAccountId: string,
): FinancialAccountShape | null {
  return financialAccountByGlAccount(financialAccounts).get(glAccountId) ?? null;
}
