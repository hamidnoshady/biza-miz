import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { VOUCHER_DOCUMENT_TYPES, VOUCHER_DOCUMENT_TYPE_SPECS } from "@/lib/voucher-numbering";
import {
  VoucherError,
  fetchAllVoucherRegisterRows,
  listVoucherRegister,
  type VoucherRegisterFilters,
} from "@/lib/voucher-numbering-service";
import { isValidIsoDate } from "@/lib/jalali";
import { journalMemoForDisplay } from "@/lib/journal-memo";
import { moneyColumnLabel, moneyExportCell, rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { MoneyUnit } from "@/lib/money";

/**
 * «دفتر اسناد» — the voucher register (issue #867 report "voucher register
 * by number/date/source"): every posted entry with its stable fiscal-year
 * number, in number order, filterable by date, book, source and free text,
 * with `?format=csv|xlsx` exporting the complete filtered result through the
 * same exporter the journal register uses.
 *
 * The book is backfilled before it is read (the service does it), so the
 * register and its export number the same rows — entries posted before this
 * feature get their numbers in journal order on first read.
 *
 * The export speaks the business's selected unit like every other report:
 * amount columns are converted to it and labelled with it («بدهکار (تومان)»),
 * and dates come out Jalali — the file a human opens is the screen's shape.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const format = params.get("format");
  if (format !== null && format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const documentType = params.get("documentType");
  if (documentType !== null && !VOUCHER_DOCUMENT_TYPES.includes(documentType as never)) {
    return NextResponse.json({ error: "unknown_document_type" }, { status: 400 });
  }
  const from = params.get("from");
  const to = params.get("to");
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to))) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }

  let cursor: VoucherRegisterFilters["cursor"];
  const cursorParam = params.get("cursor");
  if (cursorParam) {
    try {
      const parsed = JSON.parse(cursorParam);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof parsed.entryDate !== "string" ||
        typeof parsed.id !== "string" ||
        (parsed.voucherNumber !== null && typeof parsed.voucherNumber !== "string")
      ) {
        throw new Error("bad cursor");
      }
      cursor = parsed as VoucherRegisterFilters["cursor"];
    } catch {
      return NextResponse.json({ error: "invalid_cursor" }, { status: 400 });
    }
  }

  const filters: Omit<VoucherRegisterFilters, "cursor" | "limit"> = {
    from: from ?? undefined,
    to: to ?? undefined,
    documentType: documentType as VoucherRegisterFilters["documentType"],
    sourceType: params.get("sourceType") ?? undefined,
    search: params.get("search") ?? undefined,
  };

  try {
    if (format) {
      // The complete filtered result, not one page: keyset pagination in the
      // service until the cursor runs out.
      const rows = await fetchAllVoucherRegisterRows(session.businessId, filters);
      const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
        session.businessId,
        SETTING_KEYS.businessPrefs,
      );
      const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
      const table = {
        columns: [
          { key: "number", label: "شماره سند" },
          { key: "year", label: "سال مالی" },
          { key: "book", label: "دفتر" },
          // A Date object: the shared exporter renders it Jalali, Persian
          // digits — the ISO string is the storage form, not the file form.
          { key: "date", label: "تاریخ" },
          { key: "source", label: "منبع" },
          { key: "memo", label: "شرح" },
          { key: "reference", label: "شماره مرجع" },
          { key: "debit", label: moneyColumnLabel("بدهکار", unit) },
          { key: "credit", label: moneyColumnLabel("بستانکار", unit) },
          { key: "createdBy", label: "ثبت‌کننده" },
          { key: "state", label: "وضعیت" },
        ],
        rows: rows.map((r) => ({
          number: r.voucherNumber ?? "",
          year: r.fiscalYearLabel,
          book: VOUCHER_DOCUMENT_TYPE_SPECS[r.documentType].label,
          date: new Date(`${r.entryDate}T00:00:00Z`),
          source: r.sourceType ?? "",
          // Issue #1060: the exported شرح is the displayed one (the JSON
          // list below keeps the raw stored memo for API/audit readers).
          memo: journalMemoForDisplay(r.memo, r.sourceType) ?? "",
          reference: r.voucherReference ?? "",
          debit: moneyExportCell(r.totalDebit, unit, format === "xlsx" ? "excel" : "csv"),
          credit: moneyExportCell(r.totalCredit, unit, format === "xlsx" ? "excel" : "csv"),
          createdBy: r.createdByName ?? "",
          state: r.reversedAt ? "برگشته" : "فعال",
        })),
      };
      const filename = `voucher-register.${format}`;
      return format === "xlsx"
        ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "دفتر اسناد")), {
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
    }

    const result = await listVoucherRegister(session.businessId, { ...filters, cursor, limit: params.get("limit") ? Number(params.get("limit")) : undefined });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VoucherError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
