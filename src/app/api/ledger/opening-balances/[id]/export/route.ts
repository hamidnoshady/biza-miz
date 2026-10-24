import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOpeningSet } from "@/lib/opening-balances-service";
import { businessXlsxBranding, moneyColumnLabel, moneyExportCell, rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { isUuid } from "@/lib/uuid";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { MoneyUnit } from "@/lib/money";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The opening balance report for one set (issue #867 report): every line,
 * its account, its attribution and the set totals — as csv or xlsx, the same
 * exporter the journal register uses.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "set_not_found" }, { status: 404 });

  const format = request.nextUrl.searchParams.get("format");
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const result = await getOpeningSet(session.businessId, id);
  if (!result) return NextResponse.json({ error: "set_not_found" }, { status: 404 });

  const { set, lines } = result;
  const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
    session.businessId,
    SETTING_KEYS.businessPrefs,
  );
  const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
  const money = (rialText: string) => moneyExportCell(rialText, unit, format === "xlsx" ? "excel" : "csv");
  const rowOf = (line: {
    code: string;
    name: string;
    debit: string;
    credit: string;
    attribution: string;
    note: string;
  }) => ({
    year: set.fiscalYearLabel,
    // A Date object: the shared exporter renders it Jalali, Persian digits.
    effective: new Date(`${set.effectiveDate}T00:00:00Z`),
    status: set.status,
    source: set.source,
    code: line.code,
    account: line.name,
    debit: money(line.debit),
    credit: money(line.credit),
    attribution: line.attribution,
    note: line.note,
  });
  const table = {
    columns: [
      { key: "year", label: "سال مالی" },
      { key: "effective", label: "تاریخ مؤثر" },
      { key: "status", label: "وضعیت" },
      { key: "source", label: "منبع" },
      { key: "code", label: "کد حساب" },
      { key: "account", label: "حساب" },
      { key: "debit", label: moneyColumnLabel("بدهکار", unit) },
      { key: "credit", label: moneyColumnLabel("بستانکار", unit) },
      { key: "attribution", label: "مشخصه" },
      { key: "note", label: "توضیح" },
    ],
    rows: [
      rowOf({ code: "", name: "", debit: "", credit: "", attribution: "", note: "" }),
      ...lines.map((l) =>
        rowOf({
          code: l.accountCode,
          name: l.accountName,
          debit: l.debit,
          credit: l.credit,
          attribution: l.partyName ? `${l.partyType ?? ""} ${l.partyName}`.trim() : (l.reference ?? ""),
          note: l.sourceNote ?? "",
        }),
      ),
      rowOf({ code: "", name: "مجموع", debit: set.totalDebit, credit: set.totalCredit, attribution: "", note: set.note ?? "" }),
    ],
  };

  const filename = `opening-balances-${set.fiscalYearLabel}.${format}`;
  const response =
    format === "xlsx"
      ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "ترازات افتتاحیه", await businessXlsxBranding(session.businessId, session.locationId))), {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        })
      : new NextResponse(rowsToCsv(table), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename}"`,
          },
        });
  return response;
});
