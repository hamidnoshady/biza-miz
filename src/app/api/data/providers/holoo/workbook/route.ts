import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getConnection } from "@/lib/integrations/connections-service";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { getHolooSettings } from "@/lib/integrations/holoo/connection-service";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/data-transfer/import-service";
import { xlsxToWorkbook } from "@/lib/data-transfer/codecs";
import {
  applyHolooBaseMigration,
  previewHolooBaseMigration,
  holooBaseInputFingerprint,
  validateHolooScopes,
} from "@/lib/data-transfer/providers/holoo/service";
import { HOLOO_DATA_TRANSFER_PROFILE } from "@/lib/data-transfer/providers/holoo/profile";
import { finishProviderImportJob, startProviderImportJob } from "@/lib/data-transfer/provider-job-service";
import type { ProviderJobMetadata } from "@/lib/data-transfer/types";
import { analyzeHolooWorkbook, holooWorkbookToImportInput } from "@/lib/data-transfer/providers/holoo/workbook";
import { canAccessHolooConnectionLocation, checkHolooScopePermissions, holooLocationAccess, holooTransferOwner } from "../guard";
import { issueHolooPreviewToken, verifyHolooPreviewToken } from "@/lib/data-transfer/providers/holoo/preview-token";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HOLOO_WORKBOOK_ROWS = 50_000;

function stringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Analyze/apply a versioned Holoo XLSX workbook through existing domain services. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await holooTransferOwner();
  if (error) return error;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const file = form.get("file");
  const action = String(form.get("action") ?? "preview");
  const connectionId = String(form.get("connectionId") ?? "");
  const scopes = stringArray(String(form.get("scopes") ?? ""));
  if (action !== "preview" && action !== "apply") return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_IMPORT_FILE_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  if (!file.name.toLowerCase().endsWith(".xlsx")) return NextResponse.json({ error: "unsupported_format" }, { status: 415 });
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });

  const scopeValidation = validateHolooScopes(scopes, "xlsx");
  if (!scopeValidation.ok) return NextResponse.json({ error: scopeValidation.error }, { status: 400 });
  const scopeAccess = await checkHolooScopePermissions(owner, scopeValidation.scopes);
  if (!scopeAccess.ok) return NextResponse.json({ error: "forbidden", requires: scopeAccess.missing }, { status: 403 });

  const connection = await getConnection(owner.businessId, connectionId);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const locationAccess = await holooLocationAccess(owner);
  if (!canAccessHolooConnectionLocation(locationAccess, connection.location_id ?? null)) {
    return NextResponse.json({ error: "location_scope_mismatch" }, { status: 403 });
  }
  const settings = await getHolooSettings(owner.businessId, connectionId);
  if (!settings) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (settings.schemaProfile !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) {
    return NextResponse.json({ error: "holoo_profile_not_verified" }, { status: 409 });
  }
  const targetLocationId = connection.location_id ?? (await resolveActiveLocation(owner.session))?.id ?? null;
  if (!targetLocationId) return NextResponse.json({ error: "location_required" }, { status: 409 });

  let providerJobId: string | null = null;
  let providerJobMetadata: ProviderJobMetadata | null = null;
  try {
    const fileBuffer = await file.arrayBuffer();
    const workbook = await xlsxToWorkbook(fileBuffer);
    const workbookRowCount = workbook.reduce((total, sheet) => total + sheet.rows.length, 0);
    if (workbookRowCount > MAX_HOLOO_WORKBOOK_ROWS) throw new Error("holoo_source_too_large");
    const analysis = analyzeHolooWorkbook(workbook);
    if (analysis.profileKey !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) {
      return NextResponse.json({
        error: "holoo_workbook_profile_unknown",
        analysis: {
          profileKey: analysis.profileKey,
          profileVersion: analysis.profileVersion,
          issues: analysis.issues,
          warnings: analysis.warnings,
          sheets: workbook.map((sheet) => ({ name: sheet.name, columns: sheet.columns.length, rows: sheet.rows.length })),
        },
      }, { status: 409 });
    }

    const parsed = holooWorkbookToImportInput(analysis, scopeValidation.scopes, settings.currencyUnit);
    const profile = { key: HOLOO_DATA_TRANSFER_PROFILE.profileKey, version: HOLOO_DATA_TRANSFER_PROFILE.profileVersion };
    const preview = await previewHolooBaseMigration({
      businessId: owner.businessId,
      connectionId,
      scopes: scopeValidation.scopes,
      base: parsed.input,
      journals: parsed.journals,
      profile,
    });
    const tokenClaims = {
      businessId: owner.businessId,
      actorUserId: owner.actorUserId,
      connectionId,
      locationId: targetLocationId,
      source: "xlsx" as const,
      profileKey: profile.key,
      profileVersion: profile.version,
      scopes: scopeValidation.scopes,
      inputFingerprint: holooBaseInputFingerprint(parsed.input, scopeValidation.scopes, parsed.journals),
    };
    const result = {
      ...preview,
      source: "xlsx",
      fileName: file.name,
      workbook: {
        profileKey: analysis.profileKey,
        profileVersion: analysis.profileVersion,
        recognizedSheets: analysis.recognizedSheets.map((sheet) => ({
          scope: sheet.scope,
          name: sheet.sheetName,
          rowCount: sheet.rows.length,
          importSupported: sheet.importSupported,
        })),
        warnings: analysis.warnings,
      },
      unresolvedGoodsReferences: parsed.unresolvedGoodsReferences,
    };
    if (action === "preview") {
      return NextResponse.json({ ok: true, provider: "holoo", preview: result, previewToken: issueHolooPreviewToken(tokenClaims) });
    }
    const previewToken = String(form.get("previewToken") ?? "");
    if (!verifyHolooPreviewToken(previewToken, tokenClaims)) {
      return NextResponse.json({ error: "preview_expired_or_changed" }, { status: 409 });
    }
    const totalRows =
      (scopeValidation.scopes.includes("goods") ? parsed.input.goods.length : 0) +
      (scopeValidation.scopes.includes("persons") ? parsed.input.persons.length : 0) +
      (scopeValidation.scopes.includes("accounts") ? parsed.input.accounts.length : 0) +
      (scopeValidation.scopes.includes("openingInventory") ? (parsed.input.openingInventory?.length ?? 0) : 0) +
      (scopeValidation.scopes.includes("journal")
        ? parsed.journals.reduce((total, voucher) => total + 1 + voucher.lines.length, 0)
        : 0);
    const initialMetadata: ProviderJobMetadata = {
      provider: "holoo",
      direction: "import",
      sourceFormat: "xlsx",
      connectionId,
      connectionName: connection.name,
      locationId: targetLocationId,
      profileKey: profile.key,
      profileVersion: profile.version,
      selectedScopes: [...scopeValidation.scopes],
    };
    providerJobMetadata = initialMetadata;
    providerJobId = await startProviderImportJob({
      businessId: owner.businessId,
      fileName: file.name,
      fileSizeBytes: file.size,
      totalRows,
      actorUserId: owner.actorUserId,
      actorName: owner.actorName,
      providerMetadata: initialMetadata,
    });
    const applied = await applyHolooBaseMigration({
      businessId: owner.businessId,
      connectionId,
      actorUserId: owner.actorUserId,
      actorName: owner.actorName,
      scopes: scopeValidation.scopes,
      base: parsed.input,
      journals: parsed.journals,
      profile,
      source: "xlsx",
      locationId: targetLocationId,
      fileName: file.name,
      unresolvedGoodsReferences: parsed.unresolvedGoodsReferences,
    });
    const baseCreatedRows = applied.summary
      ? Object.values(applied.summary.created).reduce((total, count) => total + count, 0)
      : 0;
    const createdRows = baseCreatedRows + (applied.journalSummary?.imported ?? 0);
    const updatedRows = applied.summary?.accounts.mappedToSeed ?? 0;
    const baseSkippedRows = applied.summary
      ? applied.summary.goods.skipped + applied.summary.persons.skipped + applied.summary.accounts.skipped + applied.summary.accounts.orphaned + applied.summary.openingInventory.skipped
      : 0;
    const journalSkippedRows = applied.journalSummary
      ? applied.journalSummary.alreadyMapped + applied.journalSummary.unbalanced.length + applied.journalSummary.unmappedAccounts.length + applied.journalSummary.skippedEmpty.length
      : 0;
    const skippedRows = baseSkippedRows + journalSkippedRows;
    const discrepancyCount = applied.discrepancies && typeof applied.discrepancies === "object" && "entities" in applied.discrepancies && Array.isArray(applied.discrepancies.entities)
      ? applied.discrepancies.entities.length
      : null;
    const trialBalanceDiscrepancyCount = applied.discrepancies && typeof applied.discrepancies === "object" && "trialBalance" in applied.discrepancies && Array.isArray(applied.discrepancies.trialBalance)
      ? applied.discrepancies.trialBalance.length
      : null;
    await finishProviderImportJob(owner.businessId, providerJobId, owner.actorUserId, {
      status: applied.outcome === "completed" ? "completed" : "failed",
      createdRows,
      updatedRows,
      skippedRows,
      failedRows: applied.outcome === "partial_failure" ? 1 : 0,
      error: applied.outcome === "partial_failure" ? "provider_partial_failure" : null,
      providerMetadata: {
        ...initialMetadata,
        outcome: applied.outcome,
        migrationRunId: applied.runId,
        rollbackState: "available",
        discrepancyCount,
        trialBalanceDiscrepancyCount,
        counts: applied.summary ?? null,
        journalSummary: applied.journalSummary ?? null,
      },
    });
    return NextResponse.json({ ok: true, provider: "holoo", dataTransferJobId: providerJobId, ...applied, preview: result });
  } catch (caught) {
    if (providerJobId && providerJobMetadata) {
      try {
        await finishProviderImportJob(owner.businessId, providerJobId, owner.actorUserId, {
          status: "failed",
          createdRows: 0,
          updatedRows: 0,
          skippedRows: 0,
          failedRows: 1,
          error: "provider_apply_failed",
          providerMetadata: { ...providerJobMetadata, outcome: "failed", rollbackState: "unknown" },
        });
      } catch (jobError) {
        console.error("failed to finalize Holoo workbook Data Transfer job:", jobError instanceof Error ? jobError.message : "unknown");
      }
    }
    const message = caught instanceof Error ? caught.message : "holoo_transfer_failed";
    const code = message.split(":", 1)[0];
    const known = new Set([
      "holoo_workbook_profile_unknown",
      "xlsx_unsafe_numeric_value",
      "holoo_source_too_large",
      "holoo_workbook_has_errors",
      "holoo_scope_not_supported",
      "holoo_workbook_missing_scope",
      "holoo_scope_dependency_missing",
      "holoo_journal_sheets_required",
      "holoo_journal_line_reference_missing",
      "holoo_journal_manifest_missing",
      "duplicate_holoo_remote_id",
      "invalid_holoo_date",
      "invalid_holoo_boolean",
      "invalid_holoo_amount",
      "invalid_holoo_quantity",
      "unresolved_references",
    ]);
    return NextResponse.json(
      { error: known.has(code) ? code : "holoo_transfer_failed" },
      { status: code === "holoo_source_too_large" ? 413 : 400 },
    );
  }
});
