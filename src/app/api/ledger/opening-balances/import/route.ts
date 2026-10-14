import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  OpeningBalanceError,
  parseOpeningImportFile,
  previewOpeningImport,
} from "@/lib/opening-balances-service";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import type { MoneyUnit } from "@/lib/money";

/**
 * Import preview (issue #867: "import/preview"): the same validation the
 * create endpoint applies, answered as a preview — totals, per-account
 * grouping, the first problem found — with nothing persisted. The screen
 * shows it and only sends a real create when the accountant confirms.
 *
 * Two shapes, one preview:
 *  - a **file** (multipart `file`, CSV or XLSX) — parsed server-side through
 *    the product's one codec layer, amounts read in the business's selected
 *    unit, accounts resolved by code then name;
 *  - a **JSON array** of lines (the legacy shape the textarea path uses).
 *
 * The preview answers with the normalized lines too: the file's account
 * names were resolved server-side, so the confirmed create resends exactly
 * what the preview validated — the screen never re-parses a file.
 */

/** A reviewable document, not a data dump: the same cap the set itself has. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return NextResponse.json({ error: "missing_file" }, { status: 400 });
      }
      const filename = file.name ?? "";
      if (!/\.(csv|txt|xlsx)$/i.test(filename)) {
        return NextResponse.json({ error: "unsupported_format" }, { status: 400 });
      }
      if (file.size > MAX_FILE_BYTES) {
        return NextResponse.json({ error: "file_too_large" }, { status: 413 });
      }
      const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
        session.businessId,
        SETTING_KEYS.businessPrefs,
      );
      const unit: MoneyUnit = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
      const buffer = Buffer.from(await file.arrayBuffer());

      const { lines, problems } = await parseOpeningImportFile({
        businessId: session.businessId,
        filename,
        buffer,
        unit,
      });
      if (problems.length > 0) {
        return NextResponse.json({
          valid: false,
          problems,
          lines: [],
          totalDebit: "0",
          totalCredit: "0",
          lineCount: 0,
          accounts: [],
        });
      }

      const preview = await previewOpeningImport({
        businessId: session.businessId,
        fiscalYearLabel: form.get("fiscalYearLabel") ? String(form.get("fiscalYearLabel")) : "",
        effectiveDate: form.get("effectiveDate") ? String(form.get("effectiveDate")) : null,
        lines,
      });
      return NextResponse.json({ ...preview, problems: [], lines });
    }

    let body: { fiscalYearLabel?: string; effectiveDate?: string | null; lines?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const preview = await previewOpeningImport({
      businessId: session.businessId,
      fiscalYearLabel: body.fiscalYearLabel ?? "",
      effectiveDate: body.effectiveDate,
      lines: body.lines,
    });
    const lines = Array.isArray(body.lines)
      ? body.lines.filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === "object")
      : [];
    return NextResponse.json({ ...preview, problems: [], lines });
  } catch (err) {
    if (err instanceof OpeningBalanceError) {
      return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
    }
    throw err;
  }
});
