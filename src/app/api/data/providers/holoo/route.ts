import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getConnection, listConnections } from "@/lib/integrations/connections-service";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { getHolooSettings } from "@/lib/integrations/holoo/connection-service";
import { rollbackImportRun } from "@/lib/integrations/holoo/rollback-service";
import { listImportRuns } from "@/lib/integrations/holoo/migration-run-service";
import { HolooProfileError, readHolooBaseForMigration } from "@/lib/integrations/holoo/pull-service";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { recordDataTransferAudit } from "@/lib/data-transfer/audit";
import { finishProviderImportJob, markProviderImportJobRolledBack, startProviderImportJob } from "@/lib/data-transfer/provider-job-service";
import {
  applyHolooBaseMigration,
  HOLOO_WORKBOOK_SCOPES,
  previewHolooBaseMigration,
  unresolvedHolooStockReferences,
  holooBaseInputFingerprint,
  validateHolooScopes,
} from "@/lib/data-transfer/providers/holoo/service";
import { HOLOO_DATA_TRANSFER_PROFILE } from "@/lib/data-transfer/providers/holoo/profile";
import { issueHolooPreviewToken, verifyHolooPreviewToken } from "@/lib/data-transfer/providers/holoo/preview-token";
import type { ProviderJobMetadata } from "@/lib/data-transfer/types";
import { availableHolooExportScopes, availableHolooScopes, canAccessHolooConnectionLocation, canManageHolooConnections, canSendHolooDocuments, canUseHolooDataExport, canUseHolooDataImport, checkHolooScopePermissions, holooLocationAccess, holooProviderReadOwner, holooTransferOwner } from "./guard";
import { readBody } from "../../guard";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeRunSummary(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return safeRunSummary(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await holooProviderReadOwner();
  if (error) return error;

  const [availableScopes, availableExportScopes, canConfigureConnections, canSendConnected, canUseDataExport, canUseDataImport, allConnections, locationAccess] = await Promise.all([
    availableHolooScopes(owner),
    availableHolooExportScopes(owner),
    canManageHolooConnections(owner),
    canSendHolooDocuments(owner),
    canUseHolooDataExport(owner),
    canUseHolooDataImport(owner),
    listConnections(owner.businessId),
    holooLocationAccess(owner),
  ]);
  const holooConnections = allConnections.filter((connection) =>
    connection.provider === "holoo" && canAccessHolooConnectionLocation(locationAccess, connection.locationId),
  );
  const connections = await Promise.all(holooConnections.map(async (connection) => {
    const settings = await getHolooSettings(owner.businessId, connection.id);
    return {
      id: connection.id,
      name: connection.name,
      status: connection.status,
      profileKey: settings?.schemaProfile ?? null,
      version: settings?.holooVersion ?? null,
      currencyUnit: settings?.currencyUnit ?? null,
      hasSqlCredentials: settings?.hasSqlCredentials ?? false,
      hasWebServiceCredentials: settings?.hasWebServiceCredentials ?? false,
      companionActive: Boolean(settings?.companionActivatedAt),
      writeMode: settings?.writeMode ?? "none",
    };
  }));

  const connectionId = request.nextUrl.searchParams.get("connectionId");
  let runs: Record<string, unknown>[] = [];
  if (canUseDataImport && connectionId && UUID_RE.test(connectionId) && holooConnections.some((connection) => connection.id === connectionId)) {
    const history = await listImportRuns(owner.businessId, connectionId);
    const visibleRuns: Record<string, unknown>[] = [];
    for (const run of history) {
      const summary = safeRunSummary(run.summary);
      if (summary?.provider !== "holoo") continue;
      const selectedScopes = stringArray(summary.selectedScopes);
      if (!selectedScopes.length || selectedScopes.some((scope) => !HOLOO_WORKBOOK_SCOPES.includes(scope as (typeof HOLOO_WORKBOOK_SCOPES)[number]))) continue;
      const scopeAccess = await checkHolooScopePermissions(owner, selectedScopes);
      if (!scopeAccess.ok) continue;
      visibleRuns.push({
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        profileKey: summary.profileKey ?? null,
        profileVersion: summary.profileVersion ?? null,
        selectedScopes,
        outcome: summary.outcome ?? "completed",
        counts: summary.counts ?? null,
        journalSummary: summary.journalSummary ?? null,
        discrepancies: summary.discrepancies ?? null,
        rollbackState: summary.rollbackState ?? null,
      });
    }
    runs = visibleRuns;
  }

  return NextResponse.json({
    provider: "holoo",
    profile: {
      key: HOLOO_DATA_TRANSFER_PROFILE.profileKey,
      version: HOLOO_DATA_TRANSFER_PROFILE.profileVersion,
      label: HOLOO_DATA_TRANSFER_PROFILE.label,
      dateRepresentation: HOLOO_DATA_TRANSFER_PROFILE.dateRepresentation,
      moneyRepresentation: HOLOO_DATA_TRANSFER_PROFILE.moneyRepresentation,
      scopes: HOLOO_DATA_TRANSFER_PROFILE.sheets.map((sheet) => ({
        key: sheet.scope,
        label: sheet.tableName,
        dependencies: sheet.dependencies,
        importSupported: sheet.importSupported,
        exportSupported: sheet.exportSupported,
      })),
    },
    availableScopes,
    availableExportScopes,
    canImport: canUseDataImport,
    canExport: canUseDataExport && availableExportScopes.length > 0,
    canConfigureConnections,
    canSendConnected: canUseDataExport && canSendConnected,
    connections,
    runs,
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await holooTransferOwner();
  if (error) return error;
  const body = await readBody(request);
  const action = typeof body.action === "string" ? body.action : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: "invalid_connection_id" }, { status: 400 });

  const connection = await getConnection(owner.businessId, connectionId);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const locationAccess = await holooLocationAccess(owner);
  if (!canAccessHolooConnectionLocation(locationAccess, connection.location_id ?? null)) {
    return NextResponse.json({ error: "location_scope_mismatch" }, { status: 403 });
  }

  if (action === "rollback") {
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!UUID_RE.test(runId)) return NextResponse.json({ error: "invalid_run_id" }, { status: 400 });
    const history = await listImportRuns(owner.businessId, connectionId);
    const run = history.find((candidate) => candidate.id === runId);
    const summary = safeRunSummary(run?.summary);
    if (!run || !summary || summary.provider !== "holoo") return NextResponse.json({ error: "run_not_found" }, { status: 404 });
    if (run.status !== "completed" || summary.rollbackState !== "available") {
      return NextResponse.json({ error: "run_not_rollbackable" }, { status: 409 });
    }
    const selectedScopes = stringArray(summary.selectedScopes);
    if (!selectedScopes.length || selectedScopes.some((scope) => !HOLOO_WORKBOOK_SCOPES.includes(scope as (typeof HOLOO_WORKBOOK_SCOPES)[number]))) {
      return NextResponse.json({ error: "run_not_rollbackable" }, { status: 409 });
    }
    const scopeAccess = await checkHolooScopePermissions(owner, selectedScopes);
    if (!scopeAccess.ok) return NextResponse.json({ error: "forbidden", requires: scopeAccess.missing }, { status: 403 });

    const result = await rollbackImportRun(owner.businessId, runId, connectionId);
    await markProviderImportJobRolledBack(owner.businessId, runId);
    await recordDataTransferAudit({
      businessId: owner.businessId,
      action: "data.import.rolled_back",
      entityKey: "holoo.provider",
      entityId: runId,
      actorUserId: owner.actorUserId,
      payload: { provider: "holoo", connectionId, profileKey: summary.profileKey ?? null, selectedScopes, reverted: result.reverted },
    });
    await writeIntegrationAudit({
      businessId: owner.businessId,
      connectionId,
      action: "holoo.data_transfer.import_rolled_back",
      remoteId: runId,
      payload: { selectedScopes, reverted: result.reverted },
    });
    return NextResponse.json({ ok: true, runId, reverted: result.reverted });
  }

  if (action !== "preview" && action !== "apply") return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  const scopeInput = stringArray(body.scopes);
  const scopeValidation = validateHolooScopes(scopeInput);
  if (!scopeValidation.ok) return NextResponse.json({ error: scopeValidation.error }, { status: 400 });
  const scopeAccess = await checkHolooScopePermissions(owner, scopeValidation.scopes);
  if (!scopeAccess.ok) return NextResponse.json({ error: "forbidden", requires: scopeAccess.missing }, { status: 403 });

  let providerJobId: string | null = null;
  let providerJobMetadata: ProviderJobMetadata | null = null;
  if (connection.status !== "active") return NextResponse.json({ error: "holoo_connection_inactive" }, { status: 409 });
  const targetLocationId = connection.location_id ?? (await resolveActiveLocation(owner.session))?.id ?? null;
  if (!targetLocationId) return NextResponse.json({ error: "location_required" }, { status: 409 });

  try {
    const source = await readHolooBaseForMigration(owner.businessId, connectionId, scopeValidation.scopes);
    const supported = new Set(source.profile.capabilities.read);
    if (scopeValidation.scopes.some((scope) => !supported.has(scope))) {
      return NextResponse.json({ error: "holoo_scope_not_supported_by_profile" }, { status: 409 });
    }
    const base = {
      goods: source.input.goods,
      persons: source.input.persons,
      accounts: source.input.accounts,
      openingInventory: source.input.openingInventory,
    };
    const profile = {
      key: source.profile.key,
      version: source.profile.profileVersion,
      fingerprint: {
        productVersion: source.fingerprint.productVersion,
        productLevel: source.fingerprint.productLevel,
        edition: source.fingerprint.edition,
        databaseCollation: source.fingerprint.databaseCollation,
      },
    };
    const preview = await previewHolooBaseMigration({
      businessId: owner.businessId,
      connectionId,
      scopes: scopeValidation.scopes,
      base,
      profile,
    });
    const tokenClaims = {
      businessId: owner.businessId,
      actorUserId: owner.actorUserId,
      connectionId,
      locationId: targetLocationId,
      source: "connected_sql" as const,
      profileKey: profile.key,
      profileVersion: profile.version,
      scopes: scopeValidation.scopes,
      inputFingerprint: holooBaseInputFingerprint(base, scopeValidation.scopes),
    };
    if (action === "preview") {
      return NextResponse.json({
        ok: true,
        provider: "holoo",
        source: "connected_sql",
        preview,
        previewToken: issueHolooPreviewToken(tokenClaims),
      });
    }
    const previewToken = typeof body.previewToken === "string" ? body.previewToken : "";
    if (!verifyHolooPreviewToken(previewToken, tokenClaims)) {
      return NextResponse.json({ error: "preview_expired_or_changed" }, { status: 409 });
    }
    const unresolvedGoodsReferences = unresolvedHolooStockReferences({
      goods: scopeValidation.scopes.includes("goods") ? source.input.goods : [],
      persons: [],
      accounts: [],
      openingInventory: scopeValidation.scopes.includes("openingInventory") ? source.input.openingInventory : [],
    });
    const selectedRowCount =
      (scopeValidation.scopes.includes("goods") ? base.goods.length : 0) +
      (scopeValidation.scopes.includes("persons") ? base.persons.length : 0) +
      (scopeValidation.scopes.includes("accounts") ? base.accounts.length : 0) +
      (scopeValidation.scopes.includes("openingInventory") ? (base.openingInventory?.length ?? 0) : 0);
    const initialMetadata: ProviderJobMetadata = {
      provider: "holoo",
      direction: "import",
      sourceFormat: "connected_sql",
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
      fileName: `هلو · ${connection.name}`,
      fileSizeBytes: 0,
      totalRows: selectedRowCount,
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
      base,
      profile,
      source: "connected_sql",
      locationId: targetLocationId,
      unresolvedGoodsReferences,
    });
    const createdRows = applied.summary
      ? Object.values(applied.summary.created).reduce((total, count) => total + count, 0)
      : 0;
    const updatedRows = applied.summary?.accounts.mappedToSeed ?? 0;
    const skippedRows = applied.summary
      ? applied.summary.goods.skipped + applied.summary.persons.skipped + applied.summary.accounts.skipped + applied.summary.accounts.orphaned + applied.summary.openingInventory.skipped
      : 0;
    const discrepancyCount = applied.discrepancies && typeof applied.discrepancies === "object" && "entities" in applied.discrepancies && Array.isArray(applied.discrepancies.entities)
      ? applied.discrepancies.entities.length
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
        counts: applied.summary ?? null,
      },
    });
    return NextResponse.json({ ok: true, provider: "holoo", dataTransferJobId: providerJobId, ...applied });
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
        console.error("failed to finalize Holoo Data Transfer job:", jobError instanceof Error ? jobError.message : "unknown");
      }
    }
    if (caught instanceof HolooProfileError) {
      return NextResponse.json(
        { error: caught.code, diagnostics: caught.diagnostics },
        { status: caught.code === "holoo_source_too_large" ? 413 : 409 },
      );
    }
    const code = caught instanceof Error ? caught.message.split(":", 1)[0] : "holoo_transfer_failed";
    const known = new Set(["holoo_connection_not_found", "unresolved_references", "holoo_source_too_large"]);
    return NextResponse.json({ error: known.has(code) ? code : "holoo_transfer_failed" }, { status: 400 });
  }
});
