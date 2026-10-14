import { createHash } from "node:crypto";
import { applyBaseImport, previewBaseImport, previewableHolooAccountCodes, type BaseImportInput, type BaseImportSummary } from "@/lib/integrations/holoo/import-service";
import { buildMigrationDiscrepancyReport } from "@/lib/integrations/holoo/migration-discrepancy-service";
import { completeImportRun, beginImportRun } from "@/lib/integrations/holoo/migration-run-service";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { importJournalVouchers, previewJournalVouchers, type JournalImportPreview, type JournalImportSummary } from "@/lib/integrations/holoo/journal-import-service";
import type { HolooVoucher } from "@/lib/integrations/holoo/journal-plan";
import type { HolooSchemaFingerprint } from "@/lib/integrations/holoo/schema-profile";
import { recordDataTransferAudit } from "../../audit";
import type { HolooWorkbookBaseInput } from "./workbook";

export const HOLOO_BASE_SCOPES = ["goods", "persons", "accounts", "openingInventory"] as const;
export const HOLOO_WORKBOOK_SCOPES = [...HOLOO_BASE_SCOPES, "journal", "journalLines"] as const;
export type HolooBaseScope = (typeof HOLOO_BASE_SCOPES)[number];
export type HolooWorkbookScope = (typeof HOLOO_WORKBOOK_SCOPES)[number];
export type HolooTransferSource = "connected_sql" | "xlsx";

export interface HolooTransferProfileInfo {
  key: string;
  version: number;
  fingerprint?: Pick<HolooSchemaFingerprint, "productVersion" | "productLevel" | "edition" | "databaseCollation">;
}

export function isHolooBaseScope(scope: string): scope is HolooBaseScope {
  return (HOLOO_BASE_SCOPES as readonly string[]).includes(scope);
}

export function isHolooWorkbookScope(scope: string): scope is HolooWorkbookScope {
  return (HOLOO_WORKBOOK_SCOPES as readonly string[]).includes(scope);
}

export function validateHolooScopes(scopes: readonly string[]): { ok: true; scopes: HolooBaseScope[] } | { ok: false; error: string };
export function validateHolooScopes(scopes: readonly string[], source: "xlsx"): { ok: true; scopes: HolooWorkbookScope[] } | { ok: false; error: string };
export function validateHolooScopes(
  scopes: readonly string[],
  source: "connected_sql" | "xlsx" = "connected_sql",
): { ok: true; scopes: (HolooBaseScope | HolooWorkbookScope)[] } | { ok: false; error: string } {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) return { ok: false, error: "no_scopes_selected" };
  if (source === "xlsx" ? unique.some((scope) => !isHolooWorkbookScope(scope)) : unique.some((scope) => !isHolooBaseScope(scope))) {
    return { ok: false, error: "unsupported_scope" };
  }
  if (unique.includes("openingInventory") && !unique.includes("goods")) {
    return { ok: false, error: "scope_dependency_missing" };
  }
  const hasJournal = unique.includes("journal");
  const hasJournalLines = unique.includes("journalLines");
  if (source === "xlsx" && hasJournal !== hasJournalLines) {
    return { ok: false, error: "scope_dependency_missing" };
  }
  return { ok: true, scopes: unique as (HolooBaseScope | HolooWorkbookScope)[] };
}

export function selectHolooBaseScopes(input: BaseImportInput, scopes: readonly HolooBaseScope[]): BaseImportInput {
  const selected = new Set(scopes);
  return {
    goods: selected.has("goods") ? input.goods : [],
    persons: selected.has("persons") ? input.persons : [],
    accounts: selected.has("accounts") ? input.accounts : [],
    openingInventory: selected.has("openingInventory") ? (input.openingInventory ?? []) : [],
  };
}

/** Stable digest of the actual provider values approved in a dry-run. */
export function holooBaseInputFingerprint(
  input: BaseImportInput,
  scopes: readonly HolooWorkbookScope[],
  journals: readonly HolooVoucher[] = [],
): string {
  const baseScopes = scopes.filter(isHolooBaseScope);
  const selected = selectHolooBaseScopes(input, baseScopes);
  const compareId = (a: { remoteId: string }, b: { remoteId: string }) => a.remoteId < b.remoteId ? -1 : a.remoteId > b.remoteId ? 1 : 0;
  const canonical = {
    goods: selected.goods
      .map((row) => ({ remoteId: row.remoteId, name: row.name, sku: row.sku, priceRial: row.priceRial?.toString() ?? null, unit: row.unit }))
      .sort(compareId),
    persons: selected.persons
      .map((row) => ({ remoteId: row.remoteId, name: row.name, phone: row.phone, address: row.address, isSupplier: row.isSupplier }))
      .sort(compareId),
    accounts: selected.accounts
      .map((row) => ({ remoteId: row.remoteId, code: row.code, name: row.name, nature: row.nature, parentCode: row.parentCode }))
      .sort(compareId),
    openingInventory: (selected.openingInventory ?? [])
      .map((row) => ({ remoteId: row.remoteId, goodsRemoteId: row.goodsRemoteId, name: row.name, unit: row.unit, quantity: row.quantity, unitCostRial: row.unitCostRial.toString() }))
      .sort(compareId),
    journals: scopes.includes("journal")
      ? journals
        .map((voucher) => ({
          remoteId: voucher.remoteId,
          entryDate: voucher.entryDate,
          memo: voucher.memo ?? null,
          lines: voucher.lines.map((line) => ({
            accountCode: line.accountCode,
            debitRial: line.debitRial?.toString() ?? null,
            creditRial: line.creditRial?.toString() ?? null,
          })),
        }))
        .sort(compareId)
      : [],
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function unresolvedHolooStockReferences(input: BaseImportInput): HolooWorkbookBaseInput["unresolvedGoodsReferences"] {
  const goodsIds = new Set(input.goods.map((row) => row.remoteId));
  return (input.openingInventory ?? [])
    .filter((row) => row.goodsRemoteId && !goodsIds.has(row.goodsRemoteId))
    .map((row) => ({ stockRemoteId: row.remoteId, goodsRemoteId: row.goodsRemoteId! }));
}

export interface HolooBasePreview {
  profile: HolooTransferProfileInfo;
  scopes: HolooWorkbookScope[];
  counts: Awaited<ReturnType<typeof previewBaseImport>>;
  unresolvedGoodsReferences: HolooWorkbookBaseInput["unresolvedGoodsReferences"];
  journal?: JournalImportPreview;
}

export async function previewHolooBaseMigration(input: {
  businessId: string;
  connectionId: string;
  scopes: readonly HolooWorkbookScope[];
  base: BaseImportInput;
  journals?: HolooVoucher[];
  profile: HolooTransferProfileInfo;
}): Promise<HolooBasePreview> {
  const baseScopes = input.scopes.filter(isHolooBaseScope);
  const selected = selectHolooBaseScopes(input.base, baseScopes);
  const counts = await previewBaseImport(input.businessId, input.connectionId, selected);
  let journal: JournalImportPreview | undefined;
  if (input.scopes.includes("journal")) {
    const provisionalAccountCodes = await previewableHolooAccountCodes(
      input.businessId,
      input.connectionId,
      selected.accounts,
    );
    journal = await previewJournalVouchers(
      input.businessId,
      input.connectionId,
      input.journals ?? [],
      provisionalAccountCodes,
    );
  }
  return {
    profile: input.profile,
    scopes: [...input.scopes],
    counts,
    unresolvedGoodsReferences: unresolvedHolooStockReferences(selected),
    journal,
  };
}

export interface HolooBaseApplyResult {
  runId: string;
  outcome: "completed" | "partial_failure";
  summary?: BaseImportSummary;
  journalSummary?: JournalImportSummary;
  profile: HolooTransferProfileInfo;
  scopes: HolooWorkbookScope[];
  discrepancies?: unknown;
}

function safeErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : "apply_failed";
  const candidate = raw.split(":", 1)[0];
  return /^[a-z0-9_]{1,80}$/i.test(candidate) ? candidate : "apply_failed";
}

/**
 * Apply a previewed provider manifest through the existing Holoo domain
 * importer. Run IDs, integration mappings, reconciliation and both audit
 * streams stay owned by their existing services.
 */
export async function applyHolooBaseMigration(input: {
  businessId: string;
  connectionId: string;
  actorUserId: string;
  actorName: string;
  scopes: readonly HolooWorkbookScope[];
  base: BaseImportInput;
  journals?: HolooVoucher[];
  profile: HolooTransferProfileInfo;
  source: HolooTransferSource;
  locationId?: string | null;
  fileName?: string | null;
  unresolvedGoodsReferences?: HolooWorkbookBaseInput["unresolvedGoodsReferences"];
}): Promise<HolooBaseApplyResult> {
  if (input.unresolvedGoodsReferences?.length) throw new Error("unresolved_references");
  const baseScopes = input.scopes.filter(isHolooBaseScope);
  const selected = selectHolooBaseScopes(input.base, baseScopes);
  if (input.scopes.includes("journal") && !input.journals) throw new Error("holoo_journal_manifest_missing");
  const runId = await beginImportRun(input.businessId, input.connectionId, input.actorUserId);
  const runMetadata = {
    provider: "holoo",
    source: input.source,
    connectionId: input.connectionId,
    profileKey: input.profile.key,
    profileVersion: input.profile.version,
    fingerprint: input.profile.fingerprint ?? null,
    selectedScopes: [...input.scopes],
    fileName: input.fileName ?? null,
    migrationRunId: runId,
  };

  try {
    const summary = baseScopes.length > 0
      ? await applyBaseImport(input.businessId, input.connectionId, selected, runId, input.locationId)
      : undefined;
    const journalSummary = input.scopes.includes("journal")
      ? await importJournalVouchers(
        input.businessId,
        input.connectionId,
        input.journals ?? [],
        input.actorUserId,
        runId,
        input.locationId,
      )
      : undefined;
    const discrepancies = await buildMigrationDiscrepancyReport(input.businessId, input.connectionId, {
      base: selected,
      selectedScopes: input.scopes,
      journals: input.scopes.includes("journal") ? input.journals ?? [] : undefined,
    });
    const fullSummary = {
      ...runMetadata,
      outcome: "completed",
      counts: summary ?? null,
      journalSummary: journalSummary ?? null,
      unresolvedGoodsReferences: [],
      discrepancies,
      rollbackState: "available",
    };
    await completeImportRun(input.businessId, runId, fullSummary);
    await writeIntegrationAudit({
      businessId: input.businessId,
      connectionId: input.connectionId,
      action: "holoo.data_transfer.import_applied",
      remoteId: runId,
      payload: {
        source: input.source,
        profileKey: input.profile.key,
        profileVersion: input.profile.version,
        scopes: input.scopes,
        counts: summary?.created ?? {},
        journalSummary,
      },
    });
    await recordDataTransferAudit({
      businessId: input.businessId,
      action: "data.import.completed",
      entityKey: "holoo.provider",
      entityId: runId,
      actorUserId: input.actorUserId,
      payload: {
        ...runMetadata,
        counts: summary?.created ?? {},
        journalSummary,
        discrepancyCount: discrepancies.entities.length,
        trialBalanceDiscrepancyCount: discrepancies.trialBalance.length,
      },
    });
    return {
      runId,
      outcome: "completed",
      summary,
      journalSummary,
      profile: input.profile,
      scopes: [...input.scopes],
      discrepancies,
    };
  } catch (error) {
    // The master-data importer has row/domain-level writes. Preserve a rollback
    // handle even if one later row failed after earlier rows committed.
    const errorCode = safeErrorCode(error);
    await completeImportRun(input.businessId, runId, {
      ...runMetadata,
      outcome: "partial_failure",
      errorCode,
      rollbackState: "available",
    });
    await writeIntegrationAudit({
      businessId: input.businessId,
      connectionId: input.connectionId,
      action: "holoo.data_transfer.import_partial_failure",
      remoteId: runId,
      error: errorCode,
      payload: { source: input.source, profileKey: input.profile.key, profileVersion: input.profile.version, scopes: input.scopes },
    });
    await recordDataTransferAudit({
      businessId: input.businessId,
      action: "data.import.failed",
      entityKey: "holoo.provider",
      entityId: runId,
      actorUserId: input.actorUserId,
      payload: { ...runMetadata, errorCode, rollbackState: "available" },
    });
    return {
      runId,
      outcome: "partial_failure",
      profile: input.profile,
      scopes: [...input.scopes],
    };
  }
}
