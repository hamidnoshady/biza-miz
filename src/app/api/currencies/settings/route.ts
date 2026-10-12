import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  getBusinessCurrencyConfig,
  MulticurrencyError,
  setBusinessCurrencies,
} from "@/lib/multicurrency-service";

/**
 * This business's currency configuration: the base currency and the allowed
 * transaction currencies. Reading is a ledger-level view; changing it is an
 * owner/manager settings act, because the base currency is the unit every
 * balance sheet in the platform is denominated in.
 *
 * The write replaces the allowed set atomically: currencies dropped from the
 * list are switched off (`is_active = false`), never deleted — their posted
 * documents and rates keep meaning what they meant.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  return NextResponse.json(await getBusinessCurrencyConfig(session.businessId));
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const input = body as { baseCurrencyCode?: unknown; transactionCurrencyCodes?: unknown };
  if (!Array.isArray(input.transactionCurrencyCodes)) {
    return NextResponse.json({ error: "invalid_currency_code" }, { status: 400 });
  }

  try {
    const config = await setBusinessCurrencies(session.businessId, {
      baseCurrencyCode: String(input.baseCurrencyCode ?? ""),
      transactionCurrencyCodes: input.transactionCurrencyCodes,
    });
    return NextResponse.json(config);
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
