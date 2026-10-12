import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getOpeningSet } from "@/lib/opening-balances-service";
import { rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { isUuid } from "@/lib/uuid";

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
  const rowOf = (line: {
    code: string;
    name: string;
    debit: string;
    credit: string;
    attribution: string;
    note: string;
  }) => ({
    year: set.fiscalYearLabel,
    effective: set.effectiveDate,
    status: set.status,
    source: set.source,
    code: line.code,
    account: line.name,
    debit: line.debit,
    credit: line.credit,
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
      { key: "debit", label: "بدهکار" },
      { key: "credit", label: "بستانکار" },
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
      ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "ترازات افتتاحیه")), {
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
