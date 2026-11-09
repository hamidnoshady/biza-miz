import type { PoolClient } from "pg";
import type { FinancialAccountKind } from "./financial-accounts";
import { isUuid } from "./uuid";

export async function resolveRegisteredPaymentAccount(client: PoolClient, params: {
  businessId: string;
  locationId: string | null;
  financialAccountId: string;
  allowedKinds: readonly FinancialAccountKind[];
  invalid: () => Error;
}): Promise<{ accountId: string; financialAccountId: string }> {
  if (!isUuid(params.financialAccountId)) throw params.invalid();
  const { rows: [row] } = await client.query<{ gl_account_id: string }>(
    `SELECT fa.gl_account_id FROM financial_accounts fa
       JOIN accounts a ON a.id = fa.gl_account_id AND a.business_id = fa.business_id AND a.is_active
      WHERE fa.business_id = $1 AND fa.id = $2 FOR SHARE OF a`,
    [params.businessId, params.financialAccountId],
  );
  if (!row) throw params.invalid();
  const financialAccountId = await resolvePaymentFinancialAccountId(client, {
    ...params, accountId: row.gl_account_id, explicit: true, expectedFinancialAccountId: params.financialAccountId,
  });
  if (!financialAccountId) throw params.invalid();
  return { accountId: row.gl_account_id, financialAccountId };
}

/** The workflow still owns its GL eligibility and write permission rules. */
export async function resolvePaymentFinancialAccountId(client: PoolClient, params: {
  businessId: string;
  locationId: string | null;
  accountId: string | null;
  explicit: boolean;
  invalid: () => Error;
  expectedFinancialAccountId?: string | null;
  /** An unconfirmed pooled payment is ambiguous once several real choices exist. */
  fallbackKind?: FinancialAccountKind;
  requireRegisteredChoice?: boolean;
  allowedKinds?: readonly FinancialAccountKind[];
}): Promise<string | null> {
  if (params.explicit && params.accountId) {
    const { rows } = await client.query<{
      id: string; location_id: string | null; currency_code: string; is_active: boolean; kind: FinancialAccountKind;
    }>(
      `SELECT id, location_id, currency_code, is_active, kind FROM financial_accounts
        WHERE business_id = $1 AND gl_account_id = $2 FOR SHARE`,
      [params.businessId, params.accountId],
    );
    const account = rows[0];
    if (account) {
      if (!account.is_active || account.currency_code !== "IRR" ||
          (account.location_id !== null && account.location_id !== params.locationId) ||
          (params.allowedKinds && !params.allowedKinds.includes(account.kind)) ||
          (params.expectedFinancialAccountId && params.expectedFinancialAccountId !== account.id)) {
        throw params.invalid();
      }
      return account.id;
    }
  }
  if (params.expectedFinancialAccountId) throw params.invalid();
  if (params.fallbackKind) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM financial_accounts
        WHERE business_id = $1 AND kind = $2 AND is_active AND currency_code = 'IRR'
          AND (location_id IS NULL OR location_id = $3)
        ORDER BY id LIMIT 2`,
      [params.businessId, params.fallbackKind, params.locationId],
    );
    if (rows.length > (params.requireRegisteredChoice ? 0 : 1)) throw params.invalid();
  }
  // A legacy GL is still a valid journal leg. It supplies no evidence of a
  // real container, even when the tenant registers an account later.
  return null;
}

export async function resolvePurchasePaymentAccount(client: PoolClient, params: {
  businessId: string;
  locationId: string;
  settlementMethod: "cash" | "bank" | "credit";
  financialAccountId?: string | null;
  enforceChoice?: boolean;
  invalid: () => Error;
}): Promise<{ accountId: string; financialAccountId: string } | null> {
  if (params.settlementMethod === "credit") {
    if (params.financialAccountId != null) throw params.invalid();
    return null;
  }
  if (params.financialAccountId != null) {
    return resolveRegisteredPaymentAccount(client, {
      ...params, financialAccountId: params.financialAccountId, allowedKinds: [params.settlementMethod],
    });
  }
  if (params.enforceChoice) {
    await resolvePaymentFinancialAccountId(client, {
      ...params, accountId: null, explicit: false, fallbackKind: params.settlementMethod, requireRegisteredChoice: true,
    });
  }
  return null;
}
