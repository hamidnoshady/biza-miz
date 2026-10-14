import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isValidIsoDate } from "@/lib/iso-date";
import { isDimensionKind, parseDimensionFilter, type DimensionFilter } from "@/lib/accounting-dimensions";
import { getAccountDimensionMatrix, getProfitAndLossByDimension } from "@/lib/accounting-dimension-reports-service";
import { getAccountStatement } from "@/lib/reports-service";

const MATRIX_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

/**
 * The dimension reports, one endpoint, three views:
 *
 *   ?view=matrix&kind=…&dateFrom=…&dateTo=…[&accountType=expense]
 *       account × dimension matrix — every line in exactly one column
 *   ?view=profit&kind=…&dateFrom=…&dateTo=…
 *       profit and loss per value of one kind (the profit-centre P&L)
 *   ?view=card&accountId=…&kind=…&value=<id|unassigned>&dateFrom=…&dateTo=…
 *       the cost-centre account card: one account, one value's lines
 *
 * All three are `ledger.view`. Each one takes its scope from the query string
 * and refuses anything malformed with a 400 naming the parameter — no view ever
 * falls back to «all time» or «all kinds».
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const view = params.get("view");
  const kind = params.get("kind");
  const dateFrom = params.get("dateFrom");
  const dateTo = params.get("dateTo");

  if (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo) || dateFrom > dateTo) {
    return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
  }

  try {
    if (view === "matrix" || view === "profit") {
      if (!isDimensionKind(kind)) return NextResponse.json({ error: "unknown_dimension_kind" }, { status: 400 });
      if (view === "profit") {
        const report = await getProfitAndLossByDimension(session.businessId, { kind, dateFrom, dateTo });
        return NextResponse.json(report);
      }
      const accountType = params.get("accountType");
      if (accountType !== null && !(MATRIX_ACCOUNT_TYPES as readonly string[]).includes(accountType)) {
        return NextResponse.json({ error: "invalid_account_type" }, { status: 400 });
      }
      const report = await getAccountDimensionMatrix(session.businessId, {
        kind,
        dateFrom,
        dateTo,
        accountType,
      });
      return NextResponse.json(report);
    }

    if (view === "card") {
      const accountId = params.get("accountId");
      if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
        return NextResponse.json({ error: "invalid_account_id" }, { status: 400 });
      }
      const filter = parseDimensionFilter(kind, params.get("value"));
      if (!filter.ok || !filter.filter) return NextResponse.json({ error: "invalid_dimension" }, { status: 400 });
      const statement = await getAccountStatement(session.businessId, accountId, { dateFrom, dateTo }, filter.filter as DimensionFilter);
      if (!statement) return NextResponse.json({ error: "account_not_found" }, { status: 404 });
      return NextResponse.json({ statement, dimension: filter.filter });
    }

    return NextResponse.json({ error: "unknown_view" }, { status: 400 });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "invalid_dimension_report_scope") {
      return NextResponse.json({ error: "invalid_report_scope" }, { status: 400 });
    }
    throw cause;
  }
});
