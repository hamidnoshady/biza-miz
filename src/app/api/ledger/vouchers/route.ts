import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { VOUCHER_DOCUMENT_TYPES, VOUCHER_DOCUMENT_TYPE_SPECS } from "@/lib/voucher-numbering";
import {
  VoucherError,
  listVoucherRegister,
  type VoucherRegisterFilters,
} from "@/lib/voucher-numbering-service";
import { isValidIsoDate } from "@/lib/jalali";
import { rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";

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

  const filters: VoucherRegisterFilters = {
    from: from ?? undefined,
    to: to ?? undefined,
    documentType: documentType as VoucherRegisterFilters["documentType"],
    sourceType: params.get("sourceType") ?? undefined,
    search: params.get("search") ?? undefined,
    cursor,
    limit: params.get("limit") ? Number(params.get("limit")) : undefined,
  };

  try {
    const result = await listVoucherRegister(session.businessId, filters);

    if (format) {
      const table = {
        columns: [
          { key: "number", label: "شماره سند" },
          { key: "year", label: "سال مالی" },
          { key: "book", label: "دفتر" },
          { key: "date", label: "تاریخ" },
          { key: "source", label: "منبع" },
          { key: "memo", label: "شرح" },
          { key: "reference", label: "شماره مرجع" },
          { key: "debit", label: "بدهکار" },
          { key: "credit", label: "بستانکار" },
          { key: "createdBy", label: "ثبت‌کننده" },
          { key: "state", label: "وضعیت" },
        ],
        rows: result.rows.map((r) => ({
          number: r.voucherNumber ?? "",
          year: r.fiscalYearLabel,
          book: VOUCHER_DOCUMENT_TYPE_SPECS[r.documentType].label,
          date: r.entryDate,
          source: r.sourceType ?? "",
          memo: r.memo ?? "",
          reference: r.voucherReference ?? "",
          debit: r.totalDebit,
          credit: r.totalCredit,
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

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VoucherError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
