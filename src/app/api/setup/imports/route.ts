import { NextResponse } from "next/server";
import type { CatalogueEntity } from "@/app/(app)/settings/transfer/data-transfer-ui";
import { withTenantScope } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireManager } from "@/lib/setup-state";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import type { Industry } from "@/lib/industries";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { normalizeSelectedApps } from "@/lib/setup-apps";
import {
  DATA_MODULE_LABELS,
} from "@/lib/data-transfer/types";
import {
  defaultExportFields,
  entitiesForIndustry,
  findEntity,
  isImportable,
} from "@/lib/data-transfer/registry";
import { listImportJobs } from "@/lib/data-transfer/import-service";
import { importAccessForTargets } from "@/lib/import-access-service";
import {
  setupImportCandidates,
  setupImportSessionState,
  setupImportSummary,
  type SetupImportsData,
  type SetupImportSession,
} from "@/lib/setup-imports";

/**
 * The optional «ورود اطلاعات» step's read model (#1535 / ESH-218, #1580).
 *
 * GET only. There is deliberately no write here: uploading, mapping, previewing
 * and approving all go through the existing `/api/data/*` Data Transfer routes,
 * which already own validation, reconciliation, idempotency and permissions.
 * The wizard composes that engine; it does not wrap it in a second one.
 *
 * Three facts are computed here rather than trusted from the client:
 *  - which registered types this business/member may import, from the same
 *    registry and permission set the settings screen uses;
 *  - the **effective service access** for each type (#1580): activation state,
 *    an active complimentary grant (#1579), Workspace eligibility/service
 *    (#1110), deployment and operator availability — never the draft selection
 *    alone;
 *  - each stored job's *onboarding* state, so a staged or partial import can
 *    never be reported as applied.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const [industry, selectionRecord, access] = await Promise.all([
    getBusinessIndustry(session.businessId),
    getSetting<unknown>(session.businessId, SETTING_KEYS.setupSelectedApps),
    memberAccessFor(session),
  ]);
  const granted = access?.permissions ?? new Set<string>();
  const selectedApps =
    selectionRecord == null ? null : normalizeSelectedApps(selectionRecord);
  const canImport = granted.has(PERMISSIONS.dataImport);

  const definitions = entitiesForIndustry(industry ?? null);
  // Issue #1239 / ESH-90 — "do not show restaurant configuration to unrelated
  // industries". `requiresModule` is the registry's own declaration (menu
  // categories/items/modifiers); it is applied here, for the wizard's list,
  // rather than globally, so the settings transfer catalogue is unchanged.
  const industryKey = (industry ?? "food_service") as Industry;
  const industryModules = new Set<string>(industryProfile(industryKey).modules);

  const targetInputs = definitions.map((entity) => ({
    module: entity.module,
    requiredPermission: entity.importPermission ?? null,
    importable: isImportable(entity),
    industryEligible: entity.requiresModule
      ? industryModules.has(entity.requiresModule)
      : true,
  }));

  const decisions = await importAccessForTargets(
    session.businessId,
    targetInputs,
    granted,
  );

  const candidates = setupImportCandidates(
    definitions.map((entity, index) => ({
      key: entity.key,
      module: entity.module,
      label: entity.label,
      description: entity.description,
      importable: isImportable(entity),
      granted:
        canImport &&
        (!entity.importPermission || granted.has(entity.importPermission)),
      industryEligible: targetInputs[index].industryEligible,
      access: decisions[index],
    })),
    selectedApps,
  );

  // The catalogue handed to the shared ImportSection: types that may be
  // applied now, plus types whose only blocker is a temporary service state
  // (they can be staged and previewed; the engine refuses the queue).
  const writableKeys = new Set(
    candidates
      .filter((candidate) => candidate.available || candidate.stagingAllowed)
      .map((candidate) => candidate.key),
  );
  const entities: CatalogueEntity[] = definitions
    .filter((entity) => writableKeys.has(entity.key))
    .map((entity) => ({
      key: entity.key,
      module: entity.module,
      moduleLabel: DATA_MODULE_LABELS[entity.module],
      label: entity.label,
      description: entity.description,
      locationScoped: entity.locationScoped === true,
      canExport: granted.has(entity.exportPermission),
      canImport: true,
      defaultExportFields: defaultExportFields(entity),
      duplicateRules: (entity.duplicateRules ?? []).map((rule) => ({
        key: rule.key,
        label: rule.label,
        fields: [...rule.fields],
      })),
      fields: entity.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required === true,
        readOnly: field.readOnly === true,
        exportDefault: field.exportDefault === true,
        hint: field.hint ?? null,
        options: field.options
          ? field.options.map((option) => ({ value: option.value, label: option.label }))
          : null,
        relation: field.relation
          ? {
              entity: field.relation.entity,
              label: field.relation.label,
              onMissing: field.relation.onMissing,
            }
          : null,
      })),
    }));

  const jobs = canImport
    ? await listImportJobs(session.businessId, { limit: 50 })
    : [];
  const sessions: SetupImportSession[] = jobs.map((job) => ({
    id: job.id,
    entityKey: job.entityKey,
    entityLabel: findEntity(job.entityKey)?.label ?? job.entityKey,
    state: setupImportSessionState(job),
    status: job.status,
    fileName: job.fileName,
    createdAt: job.createdAt,
    totalRows: job.totalRows,
    validRows: job.validRows,
    errorRows: job.errorRows,
    createdRows: job.createdRows,
    updatedRows: job.updatedRows,
    skippedRows: job.skippedRows,
    failedRows: job.failedRows,
    error: job.error,
  }));

  const body: SetupImportsData & { entities: CatalogueEntity[] } = {
    selectedApps,
    canImport,
    candidates,
    entities,
    sessions,
    summary: setupImportSummary(sessions.map((entry) => entry.state)),
  };
  return NextResponse.json(body);
});
