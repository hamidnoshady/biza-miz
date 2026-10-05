import { NextRequest, NextResponse } from "next/server";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  resolveActiveLocation,
  requireManager,
  requireSetupStepForIndustry,
  syncMenuStepProgress,
  type TaxSetting,
} from "@/lib/setup-state";
import {
  parseMenuCsv,
  rowsToImport,
  type ImportResult,
} from "@/lib/menu-import";
import {
  applyMenuImport,
  menuImportConsistencyErrors,
} from "@/lib/menu-import-apply";
import { xlsxToRows } from "@/lib/data-transfer/codecs";
import { withTenantScope } from "@/lib/auth";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * The wizard's menu step — CSV/Excel import (multipart form, field "file").
 *
 * The write itself is the shared upsert (menu-import-apply.ts) the Settings
 * import uses: categories are matched by name (created with the default tax
 * rate), an item that already exists in its category gets its price updated,
 * otherwise it is created. The wizard's file has no modifier or tax columns,
 * so those branches of the apply simply never fire here — but they no longer
 * drift behind Settings' copy.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;
  const stepError = await requireSetupStepForIndustry(session.businessId, "menu");
  if (stepError) return stepError;

  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file)
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }

  const name = file.name.toLowerCase();
  let result: ImportResult;
  try {
    if (name.endsWith(".xlsx")) {
      result = rowsToImport(await xlsxToRows(await file.arrayBuffer()));
    } else if (
      name.endsWith(".csv") ||
      name.endsWith(".txt") ||
      name.endsWith(".tsv")
    ) {
      result = parseMenuCsv(await file.text());
    } else {
      return NextResponse.json(
        { error: "unsupported_format" },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: "parse_failed" }, { status: 400 });
  }

  if (result.items.length === 0) {
    return NextResponse.json(
      { error: "nothing_to_import", messages: result.errors },
      { status: 400 },
    );
  }

  // The wizard's file carries no modifier/tax columns, so these checks are
  // all no-ops today — but running them costs nothing and keeps both doors
  // on the same validation.
  result.errors.push(...menuImportConsistencyErrors(result));

  const tax = await getSetting<TaxSetting>(
    session.businessId,
    SETTING_KEYS.tax,
  );

  const counts = await applyMenuImport(
    location.id,
    result,
    tax?.defaultRate ?? 0,
    session.sub,
  );

  // The marker follows the imported data: import counts as menu progress only
  // when at least one active item now exists at this branch (issue #808 §3).
  const progress = await syncMenuStepProgress(session.businessId, location.id);
  return NextResponse.json({
    ok: true,
    createdCategories: counts.createdCategories,
    createdItems: counts.createdItems,
    updatedItems: counts.updatedItems,
    createdGroups: counts.createdGroups,
    createdModifiers: counts.createdModifiers,
    reactivatedCategories: counts.reactivatedCategories,
    errors: result.errors,
    progress,
  });
});
