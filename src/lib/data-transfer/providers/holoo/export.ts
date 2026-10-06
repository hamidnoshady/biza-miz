import { query } from "@/lib/db";
import { listAccounts } from "@/lib/accounts-service";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import type { Industry } from "@/lib/industries";
import { listParties } from "@/lib/parties-service";
import { rialToHolooAmount, type HolooCurrencyUnit } from "@/lib/integrations/holoo/holoo-money";
import { sheetsToXlsxBuffer, type SheetData } from "../../codecs";
import type { FieldType } from "../../types";
import { HOLOO_DATA_TRANSFER_PROFILE, holooTransferSheet } from "./profile";

export const HOLOO_EXPORT_SCOPES = ["goods", "persons", "accounts"] as const;
export type HolooExportScope = (typeof HOLOO_EXPORT_SCOPES)[number];

const MAX_PROVIDER_EXPORT_ROWS = 100_000;

export interface HolooWorkbookExportData {
  goods: Record<string, string>[];
  persons: Record<string, string>[];
  accounts: Record<string, string>[];
  skippedMultiRolePersons: number;
}

function profileWorkbookCell(value: string, type: FieldType): unknown {
  if (value === "") return "";
  if (type === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return value;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.toISOString().slice(0, 10) === value ? date : value;
  }
  if (type === "boolean") {
    if (value === "1" || value.toLowerCase() === "true") return true;
    if (value === "0" || value.toLowerCase() === "false") return false;
    return value;
  }
  if (type === "money" || type === "number" || type === "integer") {
    const normalized = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return value;
    const significantDigits = normalized.replace(".", "").replace(/^0+/, "").length || 1;
    const numeric = Number(normalized);
    // Excel numeric cells only retain about 15 significant digits. Keep larger
    // amounts as exact text rather than silently rounding legal values.
    if (significantDigits > 15 || !Number.isFinite(numeric)) return value;
    return numeric;
  }
  return value;
}

export function holooWorkbookSheets(data: HolooWorkbookExportData, scopes: readonly string[]): SheetData[] {
  const selected = new Set(scopes);
  return HOLOO_DATA_TRANSFER_PROFILE.sheets
    .filter((sheet) => selected.has(sheet.scope) && sheet.exportSupported)
    .map((sheet) => ({
      name: sheet.sheetName,
      columns: sheet.columns.map((column) => ({ key: column.key, label: column.externalName, type: column.type })),
      rows: data[sheet.scope as HolooExportScope].map((row) => Object.fromEntries(
        sheet.columns.map((column) => [
          column.key,
          profileWorkbookCell(row[column.key] ?? column.exportDefaultValue ?? "", column.type),
        ]),
      )),
    }));
}

export async function renderHolooWorkbook(data: HolooWorkbookExportData, scopes: readonly string[]): Promise<Buffer> {
  return sheetsToXlsxBuffer(holooWorkbookSheets(data, scopes));
}

function nonEmpty(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

async function remoteIdsForLocalRows(
  businessId: string,
  connectionId: string,
  entityTypes: readonly string[],
  localIds: readonly string[],
): Promise<Map<string, string>> {
  if (!localIds.length) return new Map();
  const { rows } = await query<{ local_id: string; remote_id: string }>(
    `SELECT local_id, remote_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2
        AND entity_type = ANY($3::text[]) AND local_id = ANY($4::uuid[])
      ORDER BY updated_at DESC`,
    [businessId, connectionId, [...entityTypes], [...localIds]],
  );
  const result = new Map<string, string>();
  for (const row of rows) if (!result.has(row.local_id)) result.set(row.local_id, row.remote_id);
  return result;
}

async function exportGoods(input: {
  businessId: string;
  connectionId: string;
  locationId: string | null;
  industry: Industry;
  currencyUnit: HolooCurrencyUnit;
}): Promise<Record<string, string>[]> {
  if (!input.locationId) throw new Error("location_required");
  const foodService = industryProfile(input.industry).salesModel === "order_ticket";
  const rows = foodService
    ? (await query<{
        id: string;
        name: string;
        sku: string | null;
        price_rial: string;
        updated_date: string | null;
      }>(
        `SELECT mi.id, mi.name, mi.sku, mi.price::text AS price_rial,
                mi.updated_at::date::text AS updated_date
           FROM menu_items mi
           JOIN locations l ON l.id = mi.location_id
          WHERE l.business_id = $1 AND mi.location_id = $2
          ORDER BY mi.sort_order, mi.name, mi.id
          LIMIT $3`,
        [input.businessId, input.locationId, MAX_PROVIDER_EXPORT_ROWS + 1],
      )).rows
    : (await query<{
        id: string;
        name: string;
        sku: string | null;
        price_rial: string | null;
        updated_date: string | null;
      }>(
        `SELECT i.id, i.name, i.sku, s.unit_price::text AS price_rial,
                greatest(i.updated_at, coalesce(s.updated_at, i.updated_at))::date::text AS updated_date
           FROM items i
           JOIN locations l ON l.id = i.location_id
           LEFT JOIN item_stock s ON s.item_id = i.id
          WHERE l.business_id = $1 AND i.location_id = $2
            AND i.kind <> 'variant_parent'
          ORDER BY i.name, i.id
          LIMIT $3`,
        [input.businessId, input.locationId, MAX_PROVIDER_EXPORT_ROWS + 1],
      )).rows;
  if (rows.length > MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");

  const ids = rows.map((row) => row.id);
  const remoteIds = await remoteIdsForLocalRows(input.businessId, input.connectionId, ["holoo_goods"], ids);
  return rows.map((row) => ({
    Code: remoteIds.get(row.id) ?? row.sku ?? row.id,
    Name: row.name,
    BarCode: row.sku ?? "",
    SellPrice: row.price_rial === null ? "" : rialToHolooAmount(BigInt(row.price_rial), input.currencyUnit),
    UnitName: "",
    ModifiedDate: row.updated_date ?? "",
  }));
}

async function exportPersons(input: {
  businessId: string;
  connectionId: string;
  locationId: string | null;
}): Promise<{ rows: Record<string, string>[]; skippedMultiRole: number }> {
  if (!input.locationId) throw new Error("location_required");
  const parties: Awaited<ReturnType<typeof listParties>>["parties"] = [];
  let total = 0;
  for (let page = 1; ; page += 1) {
    const result = await listParties(input.businessId, {
      roles: ["Customer", "Supplier"],
      includeInactive: false,
      locationId: input.locationId,
      page,
      pageSize: 100,
    });
    parties.push(...result.parties);
    total = result.total;
    if (parties.length >= total || result.parties.length === 0) break;
    if (parties.length >= MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");
  }
  if (total > MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");

  const suppliers = (await query<{ id: string; name: string; phone: string | null }>(
    `SELECT s.id, s.name, s.phone
       FROM suppliers s
       JOIN locations l ON l.id = s.location_id
      WHERE l.business_id = $1 AND s.location_id = $2 AND s.is_active
      ORDER BY s.name, s.id
      LIMIT $3`,
    [input.businessId, input.locationId, MAX_PROVIDER_EXPORT_ROWS + 1],
  )).rows;
  if (suppliers.length > MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");
  const partyIds = parties.map((party) => party.id);
  const supplierIds = suppliers.map((supplier) => supplier.id);
  const remoteIds = await remoteIdsForLocalRows(
    input.businessId,
    input.connectionId,
    ["holoo_customer"],
    [...partyIds, ...supplierIds],
  );

  let skippedMultiRole = 0;
  const mappedParties = parties.flatMap((party) => {
    const customer = party.roles.includes("Customer");
    const supplier = party.roles.includes("Supplier");
    if (customer && supplier) {
      // A single Holoo IsSupplier flag cannot round-trip two local roles.
      skippedMultiRole += 1;
      return [];
    }
    if (!customer && !supplier) return [];
    return [{
      Code: remoteIds.get(party.id) ?? party.accountingCode ?? party.id,
      Name: party.displayName,
      Tel: party.phone ?? "",
      Address: party.address ?? "",
      IsSupplier: supplier ? "1" : "0",
      ModifiedDate: "",
    }];
  });
  const mappedSuppliers = suppliers.map((supplier) => ({
    Code: remoteIds.get(supplier.id) ?? supplier.id,
    Name: supplier.name,
    Tel: supplier.phone ?? "",
    Address: "",
    IsSupplier: "1",
    ModifiedDate: "",
  }));
  return { rows: [...mappedParties, ...mappedSuppliers], skippedMultiRole };
}

async function exportAccounts(input: { businessId: string; connectionId: string }): Promise<Record<string, string>[]> {
  const accounts = await listAccounts(input.businessId);
  if (accounts.length > MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");
  const remoteIds = await remoteIdsForLocalRows(
    input.businessId,
    input.connectionId,
    ["holoo_account"],
    accounts.map((account) => account.id),
  );
  const externalCodeById = new Map(accounts.map((account) => [account.id, remoteIds.get(account.id) ?? account.code]));
  return accounts.map((account) => ({
    Code: externalCodeById.get(account.id) ?? account.code,
    Name: account.name,
    Nature: nonEmpty(account.normalBalance),
    ParentCode: account.parentId
      ? externalCodeById.get(account.parentId) ?? account.parentCode ?? ""
      : "",
    ModifiedDate: "",
  }));
}

/** Build a profile-exact, read-only Holoo workbook from canonical app services. */
export async function buildHolooWorkbookExport(input: {
  businessId: string;
  connectionId: string;
  locationId: string | null;
  currencyUnit: HolooCurrencyUnit;
  scopes: readonly string[];
}): Promise<{ body: Buffer; rowCount: number; skippedMultiRolePersons: number }> {
  if (input.scopes.length === 0 || input.scopes.some((scope) => !HOLOO_EXPORT_SCOPES.includes(scope as HolooExportScope))) {
    throw new Error("unsupported_scope");
  }
  if (new Set(input.scopes).size !== input.scopes.length) throw new Error("duplicate_scope");
  const profileSheetByScope = new Map(
    HOLOO_EXPORT_SCOPES.map((scope) => [scope, holooTransferSheet(scope)]),
  );
  if (input.scopes.some((scope) => !profileSheetByScope.get(scope as HolooExportScope)?.exportSupported)) throw new Error("unsupported_scope");

  const industry = ((await getBusinessIndustry(input.businessId)) ?? "food_service") as Industry;
  const data: HolooWorkbookExportData = { goods: [], persons: [], accounts: [], skippedMultiRolePersons: 0 };
  if (input.scopes.includes("goods")) {
    data.goods = await exportGoods({ ...input, industry });
  }
  if (input.scopes.includes("persons")) {
    const result = await exportPersons(input);
    data.persons = result.rows;
    data.skippedMultiRolePersons = result.skippedMultiRole;
  }
  if (input.scopes.includes("accounts")) {
    data.accounts = await exportAccounts(input);
  }
  const rowCount = input.scopes.reduce((total, scope) => total + data[scope as HolooExportScope].length, 0);
  if (rowCount > MAX_PROVIDER_EXPORT_ROWS) throw new Error("provider_export_too_large");
  const body = await renderHolooWorkbook(data, input.scopes);
  return { body, rowCount, skippedMultiRolePersons: data.skippedMultiRolePersons };
}
