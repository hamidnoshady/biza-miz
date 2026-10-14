import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { SETTING_KEYS, getSetting } from "@/lib/settings";
import { rowsToCsv } from "@/lib/report-export";
import { buildTaxRegisterExport } from "@/lib/tax-invoice-queries";
import { registerFiltersFromSearch, taxErrorResponse } from "@/lib/tax-invoice-http";

/**
 * The register as CSV, in the business's display unit. Export is its own door
 * (`tax.export`) because it is the one place the buyers' names and the amounts
 * leave the system as a file.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.taxExport);
  if (error) return error;
  try {
    const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(session.businessId, SETTING_KEYS.businessPrefs);
    const unit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    const table = await buildTaxRegisterExport(session.businessId, registerFiltersFromSearch(request.nextUrl.searchParams), unit);
    return new NextResponse(rowsToCsv(table), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="tax-invoices.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return taxErrorResponse(err);
  }
});
