import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  accountStatement,
  currencyExposure,
  foreignBankBalances,
  foreignPartyBalances,
  foreignTrialBalance,
  gainLossReport,
} from "@/lib/multicurrency-reports-service";
import { MulticurrencyError } from "@/lib/multicurrency-service";
import { isUuid } from "@/lib/uuid";

/**
 * The six multicurrency reports, one route, `?kind=` selects:
 *
 *   - `trial_balance`      — foreign-currency trial balance view (per account × currency).
 *   - `statement`          — one account's lines, foreign + base side by side (`?accountId=`).
 *   - `party_balances`     — open foreign A/R / A/P per party per currency.
 *   - `gain_loss`          — realized (settlements) and unrealized (revaluations) FX results.
 *   - `exposure`           — per-currency foreign position and what today's rate makes of it.
 *   - `foreign_banks`      — the foreign-currency accounts' book vs restated value.
 *
 * Every kind answers with the business's base currency named; amounts are
 * exact text in minor units, exactly as stored. Historical figures never
 * consult the current rate — only the explicitly restating views (exposure,
 * foreign banks, the restated columns of party balances) do, and they show
 * rather than post.
 */
const KINDS = ["trial_balance", "statement", "party_balances", "gain_loss", "exposure", "foreign_banks"] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: string | null): value is Kind {
  return value !== null && (KINDS as readonly string[]).includes(value);
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const kind = params.get("kind");
  if (!isKind(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");
  const currencyCode = params.get("currency") ? params.get("currency")!.toUpperCase() : null;
  if (currencyCode && !/^[A-Z]{3}$/.test(currencyCode)) {
    return NextResponse.json({ error: "invalid_currency" }, { status: 400 });
  }

  try {
    switch (kind) {
      case "trial_balance":
        return NextResponse.json(await foreignTrialBalance(session.businessId, { dateFrom, dateTo }));
      case "statement": {
        const accountId = params.get("accountId");
        if (!accountId || !isUuid(accountId)) {
          return NextResponse.json({ error: "invalid_account_id" }, { status: 400 });
        }
        return NextResponse.json(
          await accountStatement(session.businessId, accountId, { currencyCode, dateFrom, dateTo }),
        );
      }
      case "party_balances": {
        const directionParam = params.get("direction");
        const direction =
          directionParam === "receivable" || directionParam === "payable" ? directionParam : "both";
        return NextResponse.json(await foreignPartyBalances(session.businessId, { direction, currencyCode }));
      }
      case "gain_loss":
        return NextResponse.json(await gainLossReport(session.businessId, { dateFrom, dateTo }));
      case "exposure":
        return NextResponse.json(await currencyExposure(session.businessId));
      case "foreign_banks":
        return NextResponse.json(await foreignBankBalances(session.businessId));
    }
  } catch (err) {
    if (err instanceof MulticurrencyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
