import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";
import { businessXlsxBranding } from "@/lib/report-export-branding";
import type { MoneyUnit } from "@/lib/money";
import { TRANSFER_FEE_PAYER_LABELS, TRANSFER_STATUSES, type TransferStatus } from "@/lib/financial-transfers";
import {
  iterateTransfersForExport,
  type FinancialTransferRecord,
} from "@/lib/financial-transfers-service";
import { financialReportFilename, transferRegisterTable } from "@/lib/financial-account-reports";
import { financialErrorResponse } from "../../financial/support";

/**
 * The transfer register as a file — the whole filtered result, not the page.
 *
 * A register export is how a transfer is handed to somebody outside the ledger
 * (an auditor, a bank, the branch's own file), so it carries the document number,
 * both sides, the fee and its payer, the project and the entry id — everything a
 * reader needs to trace the row back to the journal without asking.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const search = new URL(request.url).searchParams;
  const format = search.get("format") ?? "csv";
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const status = search.get("status");
  if (status && !TRANSFER_STATUSES.includes(status as TransferStatus)) {
    return NextResponse.json({ error: "invalid_transfer_status" }, { status: 400 });
  }

  try {
    const prefs = await getSetting<{ currencyDisplay?: MoneyUnit }>(
      session.businessId,
      SETTING_KEYS.businessPrefs,
    );
    const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    // Every page of the filtered register, not the first one: an export that
    // stops at 200 rows while calling itself «فهرست انتقال‌ها» is a file that
    // lies. The generator refuses past its own ceiling instead of truncating.
    const transfers: FinancialTransferRecord[] = [];
    for await (const transfer of iterateTransfersForExport(session.businessId, {
      from: search.get("from"),
      to: search.get("to"),
      sourceAccountId: search.get("sourceAccountId"),
      destinationAccountId: search.get("destinationAccountId"),
      accountId: search.get("accountId"),
      kind: search.get("kind"),
      locationId: search.get("locationId"),
      projectId: search.get("projectId"),
      status: status ? (status as TransferStatus) : null,
      q: search.get("q"),
    })) {
      transfers.push(transfer);
    }
    const table = transferRegisterTable(
      transfers.map((transfer) => ({
        transferNumber: transfer.transferNumber,
        transferDate: transfer.transferDate,
        sourceAccountName: transfer.sourceAccountName,
        destinationAccountName: transfer.destinationAccountName,
        amount: transfer.amount,
        feeAmount: transfer.feeAmount,
        feePayerLabel: TRANSFER_FEE_PAYER_LABELS[transfer.feePayer] ?? transfer.feePayer,
        currencyCode: transfer.currencyCode,
        status: transfer.status,
        referenceNumber: transfer.referenceNumber,
        description: transfer.description,
        projectName: transfer.projectName,
        branchName: transfer.locationName,
        createdByName: transfer.createdByName,
        journalEntryId: transfer.journalEntryId,
      })),
      unit,
    );
    const filename = financialReportFilename("transfer-register", format, {
      from: search.get("from"),
      to: search.get("to"),
    });
    return format === "xlsx"
      ? new NextResponse(new Uint8Array(await rowsToXlsxBuffer(table, "انتقال وجه", await businessXlsxBranding(session.businessId, session.locationId))), {
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
