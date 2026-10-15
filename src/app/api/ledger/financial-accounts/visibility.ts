/**
 * Who may see a financial account's identifying numbers (issue #862).
 *
 * The register is readable under `ledger.view`, but `account_number`, `card_number`,
 * `iban`, `settlement_reference` and `merchant_number` are the fields an insider
 * uses to *route money*, so the issue asks for them to stay behind the master-data
 * capability. This module is the one place that decision is made: every route in
 * this directory answers with masked rows for a caller who may read the register
 * but not the numbers in it.
 *
 * It is a separate module rather than helpers inside `route.ts` because a Next.js
 * route file may only export its HTTP handlers — and because three routes (the
 * list, the detail and the write responses) must mask identically.
 */
import { memberAccessFor } from "@/lib/member-access";
import type { SessionPayload } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { maskSensitiveFinancialDetails } from "@/lib/financial-accounts";
import type { FinancialAccountListResult, FinancialAccountRecord } from "@/lib/financial-accounts-service";

/**
 * Whether this member holds `finance.accounts_manage`.
 *
 * Read from the canonical membership — never from a role name, which would be a
 * second authorization system beside the permission registry.
 */
export async function canViewSensitiveFinancialDetails(session: SessionPayload): Promise<boolean> {
  const access = await memberAccessFor(session);
  return access?.permissions.has(PERMISSIONS.financeAccountsManage) ?? false;
}

/**
 * The register, masked for this caller. `canViewSensitive` travels with the
 * payload so the screen can say *why* a number is masked instead of drawing a
 * broken field.
 */
export function withListVisibility(
  canViewSensitive: boolean,
  payload: FinancialAccountListResult,
): FinancialAccountListResult & { canViewSensitive: boolean } {
  return {
    ...payload,
    accounts: payload.accounts.map((account) =>
      maskSensitiveFinancialDetails(account, { canViewSensitive }),
    ),
    canViewSensitive,
  };
}

/** One account, masked for this caller. */
export function withRecordVisibility(
  canViewSensitive: boolean,
  account: FinancialAccountRecord,
): { account: FinancialAccountRecord; canViewSensitive: boolean } {
  return {
    account: maskSensitiveFinancialDetails(account, { canViewSensitive }),
    canViewSensitive,
  };
}
