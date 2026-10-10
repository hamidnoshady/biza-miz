/**
 * Phase 26 (issue #125) Wave 5 — accounting import (vouchers, general ledger,
 * opening balance, debit/credit tie-out).
 *
 * The ledger's exact writer and debit/credit constraint remain authoritative.
 * Every balanced voucher is posted through `postExactJournalEntry` (which
 * re-validates balance), with a `source_type` marking it imported; an
 * unbalanced voucher is reported as a discrepancy, never balanced with a
 * synthetic adjustment line. The opening
 * balance uses the app's own opening-equity offset, but posts through the exact
 * RialText path so large imported balances are not rounded by JavaScript numbers.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "../../db";
import { getConnection } from "../connections-service";
import { accountIdsByCode, postExactJournalEntry } from "../../ledger-service";
import { WELL_KNOWN_CODES } from "../../coa-template";
import { rialText, type RialText } from "../../inventory-exact";
import { upsertMappingOnClient } from "../mapping-service";
import { planJournalImport, type HolooVoucher, type NormalizedVoucher } from "./journal-plan";
import { writeIntegrationAudit } from "../audit";
import {
  DIMENSION_KINDS,
  type DimensionKind,
  type LineDimensions,
} from "../../accounting-dimensions";
import { findDimensionValueByCode } from "../../accounting-dimensions-service";

export const HOLOO_IMPORT_SOURCE_TYPE = "holoo_import";

/** Which code field on a NormalizedLine corresponds to each dimension kind. */
const DIMENSION_CODE_FIELD: Record<DimensionKind, "costCenterCode" | "profitCenterCode" | "departmentCode" | "detailCode"> = {
  cost_center: "costCenterCode",
  profit_center: "profitCenterCode",
  department: "departmentCode",
  detail: "detailCode",
};

async function accountIdForCode(
  businessId: string,
  code: string,
): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2 AND is_active`,
    [businessId, code],
  );
  return rows[0]?.id ?? null;
}

export interface JournalImportSummary {
  imported: number;
  alreadyMapped: number;
  unbalanced: { remoteId: string; difference: string }[];
  unmappedAccounts: { remoteId: string; accountCode: string }[];
  /** Rows refused because a dimension code named on a line was unknown or archived. */
  unmappedDimensions: { remoteId: string; kind: DimensionKind; code: string; reason: "unknown" | "inactive" }[];
  skippedEmpty: string[];
}

export interface JournalImportPreview {
  importable: number;
  alreadyMapped: number;
  unbalanced: { remoteId: string; difference: string }[];
  unmappedAccounts: { remoteId: string; accountCode: string }[];
  unmappedDimensions: JournalImportSummary["unmappedDimensions"];
  skippedEmpty: string[];
}

async function accountIdForHolooCode(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  remoteCode: string,
): Promise<string | null> {
  const mapped = await client.query<{ local_id: string }>(
    `SELECT m.local_id
       FROM integration_mappings m
       JOIN accounts a ON a.id = m.local_id AND a.business_id = m.business_id
      WHERE m.business_id = $1 AND m.connection_id = $2
        AND m.entity_type = 'holoo_account' AND m.remote_id = $3
        AND a.is_active
      LIMIT 1`,
    [businessId, connectionId, remoteCode],
  );
  if (mapped.rows[0]) return mapped.rows[0].local_id;
  const fallback = await client.query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2 AND is_active LIMIT 1`,
    [businessId, remoteCode],
  );
  return fallback.rows[0]?.id ?? null;
}

async function resolveVoucherLines(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  voucher: NormalizedVoucher,
  unmappedAccounts: JournalImportPreview["unmappedAccounts"],
  unmappedDimensions: JournalImportPreview["unmappedDimensions"],
  provisionalAccountCodes: ReadonlySet<string> = new Set(),
  allowProvisional = false,
): Promise<{ accountId: string; debit: RialText; credit: RialText; dimensions?: LineDimensions }[]> {
  const lines: { accountId: string; debit: RialText; credit: RialText; dimensions?: LineDimensions }[] = [];
  let hasUnmapped = false;
  for (const line of voucher.lines) {
    if (line.debit === 0n && line.credit === 0n) continue;
    const localAccountId = await accountIdForHolooCode(client, businessId, connectionId, line.accountCode);
    const accountId = localAccountId ?? (allowProvisional && provisionalAccountCodes.has(line.accountCode) ? "__preview_only__" : null);
    if (!accountId) {
      unmappedAccounts.push({ remoteId: voucher.remoteId, accountCode: line.accountCode });
      hasUnmapped = true;
      continue;
    }
    // Resolve optional dimension codes for the line (issue #868). A blank cell
    // leaves the kind unattributed; an unknown or archived code refuses the
    // row exactly the way the expense importer refuses it, so the mistake is
    // always surfaced on the sheet.
    const dimensions: LineDimensions = {};
    let lineHasBadDimension = false;
    for (const kind of DIMENSION_KINDS) {
      const codeKey = DIMENSION_CODE_FIELD[kind];
      const code = line[codeKey];
      if (!code) continue;
      const match = await findDimensionValueByCode(businessId, kind, code, client);
      if (!match) {
        unmappedDimensions.push({ remoteId: voucher.remoteId, kind, code, reason: "unknown" });
        lineHasBadDimension = true;
        continue;
      }
      if (!match.isActive) {
        unmappedDimensions.push({ remoteId: voucher.remoteId, kind, code, reason: "inactive" });
        lineHasBadDimension = true;
        continue;
      }
      dimensions[kind] = match.id;
    }
    if (lineHasBadDimension) {
      hasUnmapped = true;
      continue;
    }
    lines.push({
      accountId,
      debit: rialText(line.debit.toString()),
      credit: rialText(line.credit.toString()),
      dimensions: Object.keys(dimensions).length ? dimensions : undefined,
    });
  }
  return hasUnmapped ? [] : lines;
}

async function existingJournalIds(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  remoteIds: string[],
): Promise<Set<string>> {
  if (remoteIds.length === 0) return new Set();
  const { rows } = await client.query<{ remote_id: string }>(
    `SELECT remote_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2
        AND entity_type = 'holoo_journal' AND remote_id = ANY($3::text[])`,
    [businessId, connectionId, remoteIds],
  );
  return new Set(rows.map((row) => row.remote_id));
}

/** Validate a workbook before opening the provider import run. */
export async function previewJournalVouchers(
  businessId: string,
  connectionId: string,
  vouchers: HolooVoucher[],
  provisionalAccountCodes: readonly string[] = [],
): Promise<JournalImportPreview> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const { balanced, unbalanced } = planJournalImport(vouchers);
  const client = await getPool().connect();
  try {
    const mapped = await existingJournalIds(client, businessId, connectionId, vouchers.map((v) => v.remoteId));
    const result: JournalImportPreview = {
      importable: 0,
      alreadyMapped: 0,
      unbalanced: unbalanced.map((voucher) => ({
        remoteId: voucher.remoteId,
        difference: voucher.difference.toString(),
      })),
      unmappedAccounts: [],
      unmappedDimensions: [],
      skippedEmpty: [],
    };
    for (const voucher of balanced) {
      if (mapped.has(voucher.remoteId)) {
        result.alreadyMapped += 1;
        continue;
      }
      const lines = await resolveVoucherLines(
        client,
        businessId,
        connectionId,
        voucher,
        result.unmappedAccounts,
        result.unmappedDimensions,
        new Set(provisionalAccountCodes),
        true,
      );
      if (lines.length === 0) {
        if (!result.unmappedAccounts.some((row) => row.remoteId === voucher.remoteId)) {
          result.skippedEmpty.push(voucher.remoteId);
        }
        continue;
      }
      result.importable += 1;
    }
    return result;
  } finally {
    client.release();
  }
}

/**
 * Apply balanced vouchers one document per database transaction. The journal
 * and its stable Holoo mapping are committed atomically, with a transaction
 * advisory lock and a run-scoped mapping so retries cannot duplicate entries.
 */
export async function importJournalVouchers(
  businessId: string,
  connectionId: string,
  vouchers: HolooVoucher[],
  createdBy: string | null,
  importRunId?: string | null,
  locationId?: string | null,
): Promise<JournalImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");

  const { balanced, unbalanced } = planJournalImport(vouchers);
  const result: JournalImportSummary = {
    imported: 0,
    alreadyMapped: 0,
    unbalanced: unbalanced.map((voucher) => ({
      remoteId: voucher.remoteId,
      difference: voucher.difference.toString(),
    })),
    unmappedAccounts: [],
    unmappedDimensions: [],
    skippedEmpty: [],
  };
  const client = await getPool().connect();
  try {
    for (const voucher of balanced) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          connectionId,
          `holoo_journal:${voucher.remoteId}`,
        ]);
        const mapped = await existingJournalIds(client, businessId, connectionId, [voucher.remoteId]);
        if (mapped.has(voucher.remoteId)) {
          result.alreadyMapped += 1;
          await client.query("COMMIT");
          continue;
        }

        const lines = await resolveVoucherLines(
          client,
          businessId,
          connectionId,
          voucher,
          result.unmappedAccounts,
          result.unmappedDimensions,
        );
        if (lines.length === 0) {
          if (
            !result.unmappedAccounts.some((row) => row.remoteId === voucher.remoteId)
            && !result.unmappedDimensions.some((row) => row.remoteId === voucher.remoteId)
          ) {
            result.skippedEmpty.push(voucher.remoteId);
          }
          await client.query("ROLLBACK");
          continue;
        }

        const entryId = await postExactJournalEntry(client, {
          businessId,
          locationId: locationId ?? connection.location_id,
          entryDate: voucher.entryDate,
          memo: voucher.memo,
          sourceType: HOLOO_IMPORT_SOURCE_TYPE,
          sourceId: null,
          lines,
          createdBy,
        });
        if (entryId) {
          await upsertMappingOnClient(
            client,
            businessId,
            connectionId,
            "holoo_journal",
            voucher.remoteId,
            entryId,
            importRunId,
          );
          result.imported += 1;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "journal.imported",
      payload: {
        imported: result.imported,
        alreadyMapped: result.alreadyMapped,
        unbalanced: result.unbalanced.length,
        unmappedAccounts: result.unmappedAccounts.length,
        unmappedDimensions: result.unmappedDimensions.length,
      },
    });
    return result;
  } finally {
    client.release();
  }
}

export interface OpeningBalanceLine {
  accountCode: string;
  debitRial?: bigint | null;
  creditRial?: bigint | null;
}

/** Import the opening balance as the app's opening document (equity-offset). */
export async function importOpeningBalance(
  businessId: string,
  connectionId: string,
  lines: OpeningBalanceLine[],
  createdBy: string | null,
): Promise<{ entryId: string | null; unmappedAccounts: string[] }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");

  const openingLines: {
    accountId: string;
    debit: RialText;
    credit: RialText;
  }[] = [];
  const unmappedAccounts: string[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const line of lines) {
    const accountId = await accountIdForCode(businessId, line.accountCode);
    if (!accountId) {
      unmappedAccounts.push(line.accountCode);
      continue;
    }
    const debit = line.debitRial ?? 0n;
    const credit = line.creditRial ?? 0n;
    openingLines.push({
      accountId,
      debit: rialText(debit.toString()),
      credit: rialText(credit.toString()),
    });
    totalDebit += debit;
    totalCredit += credit;
  }

  // The app's own opening mechanism: balance against the equity offset account.
  const client = await getPool().connect();
  try {
    let offsetId: string;
    try {
      offsetId = (
        await accountIdsByCode(client, businessId, [
          WELL_KNOWN_CODES.openingEquity,
        ])
      ).get(WELL_KNOWN_CODES.openingEquity)!;
    } catch {
      return { entryId: null, unmappedAccounts };
    }

    const difference = totalDebit - totalCredit;
    if (difference > 0n) {
      openingLines.push({
        accountId: offsetId,
        debit: rialText("0"),
        credit: rialText(difference.toString()),
      });
    } else if (difference < 0n) {
      openingLines.push({
        accountId: offsetId,
        debit: rialText((-difference).toString()),
        credit: rialText("0"),
      });
    }

    await client.query("BEGIN");
    const entryId = await postExactJournalEntry(client, {
      businessId,
      locationId: connection.location_id,
      entryDate: null,
      memo: "ماندهٔ افتتاحیه (واردشده از هلو)",
      sourceType: "opening",
      sourceId: null,
      lines: openingLines,
      createdBy,
    });
    await client.query("COMMIT");
    return { entryId, unmappedAccounts };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
