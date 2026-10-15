import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { isUuid } from "@/lib/uuid";
import { rowsToCsv } from "@/lib/report-export";
import { sheetsToXlsxBuffer } from "@/lib/data-transfer/codecs";
import type { MoneyUnit } from "@/lib/money";
import {
  financialAccountCard,
  type FinancialAccountCardResult,
} from "@/lib/financial-accounts-service";
import { accountCardTables, financialReportFilename } from "@/lib/financial-account-reports";
import { financialErrorResponse, limitFromSearch } from "../../../financial/support";
import { canViewSensitiveFinancialDetails, withRecordVisibility } from "../../visibility";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The account card (صورت حساب) — opening balance, every movement, closing.
 *
 * Every figure is a BigInt sum over `journal_lines` for the account's own GL
 * account, and the closing balance is checked against the ledger's own figure for
 * the same window: `reconciliationDifference` is what the screen shows if the two
 * ever disagree. There is no stored balance to disagree *with*, which is the point
 * of the issue's "no shadow balance table".
 *
 * `?format=csv|xlsx` renders the same card as a file, through the platform's one
 * export layer; the screen prints the same table with the browser's own print
 * dialog («چاپ / PDF»), exactly like the trial balance and the voucher register.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "financial_account_not_found" }, { status: 404 });

  const search = new URL(request.url).searchParams;
  const format = search.get("format");
  if (format !== null && format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const limit = limitFromSearch(search.get("limit"), 500, 2000);
  if (limit === null) return NextResponse.json({ error: "invalid_limit" }, { status: 400 });

  try {
    const card = await financialAccountCard(session.businessId, id, {
      from: search.get("from"),
      to: search.get("to"),
      projectId: search.get("projectId"),
      locationId: search.get("locationId"),
      includeReversed: search.get("includeReversed") !== "0",
      limit,
    });

    if (format) {
      const prefs = await getSetting<{ currencyDisplay?: MoneyUnit }>(
        session.businessId,
        SETTING_KEYS.businessPrefs,
      );
      const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
      const tables = accountCardTables(cardExportMeta(card), card.rows, unit);
      const header = rowsToCsv(tables.header).replace(/^\uFEFF/, "");
      const movements = rowsToCsv(tables.movements).replace(/^\uFEFF/, "");
      const filename = financialReportFilename("account-card", format, {
        accountCode: card.account.code ?? card.account.glAccountCode,
        from: card.from,
        to: card.to,
      });
      if (format === "xlsx") {
        // Two sheets, not one: the summary block has two columns and the
        // movements seven, so putting them in one sheet would either pad the
        // summary into a rectangle nobody can read or drop it entirely.
        const buffer = await sheetsToXlsxBuffer([
          { name: "خلاصه", columns: tables.header.columns, rows: tables.header.rows },
          { name: "گردش حساب", columns: tables.movements.columns, rows: tables.movements.rows },
        ]);
        return new NextResponse(new Uint8Array(buffer), {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${asciiFilename(filename)}"`,
            "Cache-Control": "no-store",
          },
        });
      }
      return new NextResponse(`\uFEFF${header}${movements}`, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${asciiFilename(filename)}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({
      ...card,
      ...withRecordVisibility(await canViewSensitiveFinancialDetails(session), card.account),
    });
  } catch (err) {
    return financialErrorResponse(err);
  }
});

/**
 * The card's own header block for a file.
 *
 * A downloaded card has to prove it agrees with the ledger it came from, so the
 * account's identity and the reconciliation travel with the movements rather than
 * being left behind on a screen the file's reader may never open.
 */
function cardExportMeta(card: FinancialAccountCardResult) {
  return {
    accountName: card.account.name,
    accountKind: card.account.kind,
    glAccountCode: card.account.glAccountCode,
    glAccountName: card.account.glAccountName,
    branchName: card.account.locationName ?? "کسب‌وکار (همهٔ شعبه‌ها)",
    currencyCode: card.account.currencyCode,
    from: card.from,
    to: card.to,
    opening: card.opening,
    totalDebit: card.totalDebit,
    totalCredit: card.totalCredit,
    closing: card.closing,
    ledgerBalance: card.ledgerBalance,
    reconciliationDifference: card.reconciliationDifference,
  };
}

/** Non-ASCII names in a `Content-Disposition` header are not portable; keep it simple. */
function asciiFilename(name: string): string {
  return name.replace(/[^\w.\-]/g, "_");
}
