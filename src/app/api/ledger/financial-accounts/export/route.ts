import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { businessXlsxBranding, rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import type { MoneyUnit } from "@/lib/money";
import { isFinancialAccountKind, type FinancialAccountKind } from "@/lib/financial-accounts";
import { financialAccountBalanceSummary } from "@/lib/financial-accounts-service";
import { balanceSummaryTable, financialReportFilename } from "@/lib/financial-account-reports";
import { financialErrorResponse } from "../../financial/support";

/**
 * The balance summary as a file: what each container holds, per kind, per branch.
 *
 * It is the one report that answers «چقدر پول داریم و کجاست؟» without the reader
 * having to be a ledger user, which is exactly why it leaves the building as a
 * file. The numbers are the same BigInt sums over `journal_lines` the screen
 * shows — a spreadsheet and the screen can never disagree, because neither of
 * them is the source.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const format = search.get("format") ?? "csv";
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const kind = search.get("kind");
  if (kind && !isFinancialAccountKind(kind)) {
    return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
  }
  const asOf = search.get("asOf");

  try {
    const prefs = await getSetting<{ currencyDisplay?: MoneyUnit }>(
      session.businessId,
      SETTING_KEYS.businessPrefs,
    );
    const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    const summary = await financialAccountBalanceSummary(session.businessId, {
      kind: kind ? (kind as FinancialAccountKind) : undefined,
      status: (search.get("status") as "active" | "archived" | "all" | null) ?? "active",
      locationId: search.get("locationId"),
    });
    const table = balanceSummaryTable(
      summary.accounts.map((account) => ({
        kind: account.kind,
        name: account.name,
        code: account.code,
        glAccountCode: account.glAccountCode,
        glAccountName: account.glAccountName,
        branchName: account.locationName ?? "کسب‌وکار",
        currencyCode: account.currencyCode,
        isDefault: account.isDefault,
        isActive: account.isActive,
        balance: account.balance,
      })),
      unit,
    );
    const filename = financialReportFilename("balance-summary", format, { to: asOf });
    return format === "xlsx"
      ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "مانده حساب‌ها", await businessXlsxBranding(session.businessId, session.locationId))), {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
          },
        })
      : new NextResponse(rowsToCsv(table), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Cache-Control": "no-store",
          },
        });
  } catch (err) {
    return financialErrorResponse(err);
  }
});
