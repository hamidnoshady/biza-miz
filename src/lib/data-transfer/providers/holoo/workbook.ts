import { normaliseHeader, type ParsedWorkbookSheet, westernDigits } from "../../codecs";
import type { BaseImportInput } from "@/lib/integrations/holoo/import-service";
import {
  mapAccount,
  mapGoods,
  mapOpeningInventory,
  mapPerson,
  type MappedOpeningInventory,
} from "@/lib/integrations/holoo/mappers";
import { holooAmountToRial, type HolooCurrencyUnit } from "@/lib/integrations/holoo/holoo-money";
import type { HolooVoucher } from "@/lib/integrations/holoo/journal-plan";
import type { ProviderProfileSheet } from "../../types";
import { HOLOO_DATA_TRANSFER_PROFILE } from "./profile";

export interface HolooWorkbookIssue {
  code: "unknown_sheet" | "duplicate_sheet" | "header_mismatch" | "missing_required_value" | "missing_external_id";
  sheetName: string;
  rowNumber?: number;
  field?: string;
}

export interface HolooWorkbookSheetAnalysis {
  scope: string;
  sheetName: string;
  columns: string[];
  rows: string[][];
  importSupported: boolean;
  identityFields: string[];
  issues: HolooWorkbookIssue[];
}

export interface HolooWorkbookAnalysis {
  profileKey: string | null;
  profileVersion: number | null;
  recognizedSheets: HolooWorkbookSheetAnalysis[];
  issues: HolooWorkbookIssue[];
  warnings: HolooWorkbookIssue[];
  rowCounts: Record<string, number>;
}

export interface HolooWorkbookBaseInput {
  input: BaseImportInput;
  unresolvedGoodsReferences: { stockRemoteId: string; goodsRemoteId: string }[];
}

export interface HolooWorkbookImportInput extends HolooWorkbookBaseInput {
  journals: HolooVoucher[];
}

const normalise = (value: string) => normaliseHeader(value);

function sheetDefinitionsByName(): Map<string, ProviderProfileSheet> {
  return new Map(HOLOO_DATA_TRANSFER_PROFILE.sheets.map((sheet) => [normalise(sheet.sheetName), sheet]));
}

function missingRequiredIssues(
  sheet: ParsedWorkbookSheet,
  definition: ProviderProfileSheet,
  headerIndexes: Map<string, number>,
): HolooWorkbookIssue[] {
  const issues: HolooWorkbookIssue[] = [];
  const identityIndexes = definition.identityFields.map((name) => headerIndexes.get(normalise(name)) ?? -1);
  const requiredIndexes = definition.columns
    .filter((column) => column.required)
    .map((column) => ({ name: column.externalName, index: headerIndexes.get(normalise(column.externalName)) ?? -1 }));

  sheet.rows.forEach((row, offset) => {
    const rowNumber = offset + 2;
    if (identityIndexes.some((index) => index < 0 || !westernDigits(row[index] ?? "").trim())) {
      issues.push({ code: "missing_external_id", sheetName: sheet.name, rowNumber });
      return;
    }
    for (const required of requiredIndexes) {
      if (required.index < 0 || !westernDigits(row[required.index] ?? "").trim()) {
        issues.push({ code: "missing_required_value", sheetName: sheet.name, rowNumber, field: required.name });
      }
    }
  });
  return issues;
}

/**
 * Identify an exact internal Holoo workbook profile by sheet names and ordered
 * field signatures. Similar labels or a single familiar table name do not
 * authorize a migration. Unknown tabs are warnings and are never imported.
 */
export function analyzeHolooWorkbook(sheets: readonly ParsedWorkbookSheet[]): HolooWorkbookAnalysis {
  const definitions = sheetDefinitionsByName();
  const recognizedSheets: HolooWorkbookSheetAnalysis[] = [];
  const issues: HolooWorkbookIssue[] = [];
  const warnings: HolooWorkbookIssue[] = [];
  const seenScopes = new Set<string>();

  for (const source of sheets) {
    const definition = definitions.get(normalise(source.name));
    if (!definition) {
      warnings.push({ code: "unknown_sheet", sheetName: source.name });
      continue;
    }
    if (seenScopes.has(definition.scope)) {
      issues.push({ code: "duplicate_sheet", sheetName: source.name });
      continue;
    }
    seenScopes.add(definition.scope);

    const expected = definition.columns.map((column) => normalise(column.externalName));
    const actual = source.columns.map(normalise);
    const headerMatches = expected.length === actual.length && expected.every((name, index) => name === actual[index]);
    if (!headerMatches) {
      issues.push({ code: "header_mismatch", sheetName: source.name });
      continue;
    }

    const indexes = new Map(source.columns.map((column, index) => [normalise(column), index]));
    const sheetIssues = missingRequiredIssues(source, definition, indexes);
    issues.push(...sheetIssues);
    recognizedSheets.push({
      scope: definition.scope,
      sheetName: source.name,
      columns: [...source.columns],
      rows: source.rows.map((row) => [...row]),
      importSupported: definition.importSupported,
      identityFields: [...definition.identityFields],
      issues: sheetIssues,
    });
  }

  const rowCounts = Object.fromEntries(recognizedSheets.map((sheet) => [sheet.scope, sheet.rows.length]));
  const exactProfile = recognizedSheets.length > 0 && !issues.some((issue) => issue.code === "header_mismatch" || issue.code === "duplicate_sheet");
  return {
    profileKey: exactProfile ? HOLOO_DATA_TRANSFER_PROFILE.profileKey : null,
    profileVersion: exactProfile ? HOLOO_DATA_TRANSFER_PROFILE.profileVersion : null,
    recognizedSheets,
    issues,
    warnings,
    rowCounts,
  };
}

function cell(sheet: HolooWorkbookSheetAnalysis, fieldName: string, row: string[]): string {
  const index = sheet.columns.findIndex((column) => normalise(column) === normalise(fieldName));
  return index < 0 ? "" : westernDigits(row[index] ?? "").trim();
}

function parseHolooBoolean(value: string, field: string): boolean {
  const text = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "supplier", "بله", "آری"].includes(text)) return true;
  if (["", "0", "false", "no", "n", "customer", "خیر", "نه"].includes(text)) return false;
  throw new Error(`invalid_holoo_boolean:${field}`);
}

function assertUniqueRemoteIds(sheet: HolooWorkbookSheetAnalysis, keyField: string): void {
  const seen = new Set<string>();
  for (const row of sheet.rows) {
    const remoteId = cell(sheet, keyField, row);
    if (!remoteId) continue; // the analysis already reports it as an issue
    if (seen.has(remoteId)) throw new Error(`duplicate_holoo_remote_id:${sheet.scope}`);
    seen.add(remoteId);
  }
}

function sheetForScope(analysis: HolooWorkbookAnalysis, scope: string): HolooWorkbookSheetAnalysis | null {
  return analysis.recognizedSheets.find((sheet) => sheet.scope === scope) ?? null;
}

/**
 * Convert supported master/opening-stock sheets through the existing Holoo
 * mappers. Voucher sheets are deliberately handled by the document-grouping
 * converter below rather than flattened into independent row writes.
 */
export function holooWorkbookToBaseInput(
  analysis: HolooWorkbookAnalysis,
  selectedScopes: readonly string[],
  currencyUnit: HolooCurrencyUnit,
): HolooWorkbookBaseInput {
  if (analysis.profileKey !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) throw new Error("holoo_workbook_profile_unknown");

  const selected = new Set(selectedScopes);
  const selectedIssues = analysis.recognizedSheets
    .filter((sheet) => selected.has(sheet.scope))
    .flatMap((sheet) => sheet.issues);
  if (selectedIssues.length > 0) throw new Error("holoo_workbook_has_errors");
  const supportedScopes = new Set(HOLOO_DATA_TRANSFER_PROFILE.capabilities.readScopes);
  for (const scope of selected) {
    const definition = HOLOO_DATA_TRANSFER_PROFILE.sheets.find((sheet) => sheet.scope === scope);
    if (!definition || !supportedScopes.has(scope) || !definition.importSupported) {
      throw new Error("holoo_scope_not_supported");
    }
    if (!sheetForScope(analysis, scope)) throw new Error(`holoo_workbook_missing_scope:${scope}`);
    if (definition.dependencies.some((dependency) => !selected.has(dependency))) {
      throw new Error(`holoo_scope_dependency_missing:${scope}`);
    }
  }

  const goodsSheet = selected.has("goods") ? sheetForScope(analysis, "goods") : null;
  const personsSheet = selected.has("persons") ? sheetForScope(analysis, "persons") : null;
  const accountsSheet = selected.has("accounts") ? sheetForScope(analysis, "accounts") : null;
  const stockSheet = selected.has("openingInventory") ? sheetForScope(analysis, "openingInventory") : null;

  if (goodsSheet) assertUniqueRemoteIds(goodsSheet, "Code");
  if (personsSheet) assertUniqueRemoteIds(personsSheet, "Code");
  if (accountsSheet) assertUniqueRemoteIds(accountsSheet, "Code");
  if (stockSheet) assertUniqueRemoteIds(stockSheet, "Code");

  const goods = (goodsSheet?.rows ?? []).map((row) =>
    mapGoods({
      id: cell(goodsSheet!, "Code", row),
      name: cell(goodsSheet!, "Name", row),
      sku: cell(goodsSheet!, "BarCode", row) || null,
      price: cell(goodsSheet!, "SellPrice", row) || null,
      unit: cell(goodsSheet!, "UnitName", row) || null,
    }, currencyUnit),
  );
  const persons = (personsSheet?.rows ?? []).map((row) =>
    mapPerson({
      id: cell(personsSheet!, "Code", row),
      name: cell(personsSheet!, "Name", row),
      phone: cell(personsSheet!, "Tel", row) || null,
      address: cell(personsSheet!, "Address", row) || null,
      isSupplier: parseHolooBoolean(cell(personsSheet!, "IsSupplier", row), "IsSupplier"),
    }),
  );
  const accounts = (accountsSheet?.rows ?? []).map((row) => {
    const code = cell(accountsSheet!, "Code", row);
    return mapAccount({
      id: code,
      code,
      name: cell(accountsSheet!, "Name", row),
      nature: cell(accountsSheet!, "Nature", row) || null,
      parentCode: cell(accountsSheet!, "ParentCode", row) || null,
    });
  });

  const goodsByRemoteId = new Map(goods.map((entry) => [entry.remoteId, entry]));
  const unresolvedGoodsReferences: HolooWorkbookBaseInput["unresolvedGoodsReferences"] = [];
  const openingInventory: MappedOpeningInventory[] = (stockSheet?.rows ?? []).map((row) => {
    const remoteId = cell(stockSheet!, "Code", row);
    const goodsRemoteId = cell(stockSheet!, "GoodsCode", row);
    const goodsEntry = goodsByRemoteId.get(goodsRemoteId);
    if (!goodsEntry) unresolvedGoodsReferences.push({ stockRemoteId: remoteId, goodsRemoteId });
    return mapOpeningInventory({
      id: remoteId,
      goodsId: goodsRemoteId || null,
      name: goodsEntry?.name ?? goodsRemoteId,
      unit: goodsEntry?.unit ?? null,
      quantity: cell(stockSheet!, "Quantity", row),
      unitCost: cell(stockSheet!, "UnitCost", row) || null,
    }, currencyUnit);
  });

  return {
    input: {
      goods: selected.has("goods") ? goods : [],
      persons: selected.has("persons") ? persons : [],
      accounts: selected.has("accounts") ? accounts : [],
      openingInventory: selected.has("openingInventory") ? openingInventory : [],
    },
    unresolvedGoodsReferences,
  };
}

function parseHolooIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_holoo_date");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("invalid_holoo_date");
  }
  return value;
}

function parseJournalAmount(value: string, currencyUnit: HolooCurrencyUnit): string {
  if (!value) throw new Error("invalid_holoo_amount");
  return holooAmountToRial(value, currencyUnit).toString();
}

/**
 * Convert a complete voucher workbook through the existing journal import
 * service's manifest. A voucher header, all of its lines, and the account
 * sheet are selected together; no line is imported independently.
 */
export function holooWorkbookToImportInput(
  analysis: HolooWorkbookAnalysis,
  selectedScopes: readonly string[],
  currencyUnit: HolooCurrencyUnit,
): HolooWorkbookImportInput {
  if (analysis.profileKey !== HOLOO_DATA_TRANSFER_PROFILE.profileKey) throw new Error("holoo_workbook_profile_unknown");
  const selected = new Set(selectedScopes);
  const workbookSupported = new Set(HOLOO_DATA_TRANSFER_PROFILE.capabilities.workbookImportScopes);
  for (const scope of selected) {
    const definition = HOLOO_DATA_TRANSFER_PROFILE.sheets.find((sheet) => sheet.scope === scope);
    if (!definition || !definition.importSupported || !workbookSupported.has(scope)) {
      throw new Error("holoo_scope_not_supported");
    }
    if (definition.dependencies.some((dependency) => !selected.has(dependency))) {
      throw new Error(`holoo_scope_dependency_missing:${scope}`);
    }
  }
  const hasJournal = selected.has("journal");
  const hasJournalLines = selected.has("journalLines");
  if (hasJournal !== hasJournalLines) throw new Error("holoo_journal_sheets_required");

  const baseScopes = selectedScopes.filter((scope) =>
    HOLOO_DATA_TRANSFER_PROFILE.capabilities.readScopes.includes(scope),
  );
  const base = holooWorkbookToBaseInput(analysis, baseScopes, currencyUnit);
  if (!hasJournal) return { ...base, journals: [] };

  const headerSheet = sheetForScope(analysis, "journal");
  const lineSheet = sheetForScope(analysis, "journalLines");
  if (!headerSheet || !lineSheet) throw new Error("holoo_workbook_missing_scope:journal");
  for (const sheet of [headerSheet, lineSheet]) {
    if (sheet.issues.length > 0) throw new Error("holoo_workbook_has_errors");
  }
  assertUniqueRemoteIds(headerSheet, "Code");

  const vouchers = new Map<string, HolooVoucher>();
  for (const row of headerSheet.rows) {
    const remoteId = cell(headerSheet, "Code", row);
    vouchers.set(remoteId, {
      remoteId,
      entryDate: parseHolooIsoDate(cell(headerSheet, "Date", row)),
      memo: cell(headerSheet, "Description", row) || null,
      lines: [],
    });
  }

  const seenLineIdentities = new Set<string>();
  for (const row of lineSheet.rows) {
    const voucherId = cell(lineSheet, "SanadCode", row);
    const accountCode = cell(lineSheet, "AccountCode", row);
    const voucher = vouchers.get(voucherId);
    if (!voucher) throw new Error("holoo_journal_line_reference_missing");
    const identity = JSON.stringify([voucherId, accountCode]);
    if (seenLineIdentities.has(identity)) throw new Error("duplicate_holoo_remote_id:journalLines");
    seenLineIdentities.add(identity);
    voucher.lines.push({
      accountCode,
      debitRial: parseJournalAmount(cell(lineSheet, "Debit", row), currencyUnit),
      creditRial: parseJournalAmount(cell(lineSheet, "Credit", row), currencyUnit),
    });
  }

  return { ...base, journals: [...vouchers.values()] };
}
