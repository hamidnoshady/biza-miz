/**
 * Phase 26 Wave 6 — DB-backed Holoo migration discrepancy report.
 *
 * The pure functions in discrepancy.ts name the differences; this service is
 * the route-facing half that gathers app-side counts/balances and converts the
 * result into JSON-safe strings.
 */
import { query } from "../../db";
import { entityDiscrepancies, trialBalanceDiscrepancies, type AccountBalance, type EntityComparison } from "./discrepancy";
import type { BaseImportInput } from "./import-service";
import type { HolooTransaction } from "./transaction-plan";
import type { HolooVoucher } from "./journal-plan";
import type { OpeningBalanceLine } from "./journal-import-service";

export interface MigrationDiscrepancyManifest {
  base?: BaseImportInput;
  /** Limit base-data comparisons to the domains selected in this migration. */
  selectedScopes?: readonly string[];
  transactions?: HolooTransaction[];
  journals?: HolooVoucher[];
  openingBalance?: OpeningBalanceLine[];
}

export interface JsonEntityDiscrepancy {
  entityType: string;
  countDiff: number;
  balanceDiffRial: string;
}

export interface JsonAccountDiscrepancy {
  code: string;
  debitDiffRial: string;
  creditDiffRial: string;
}

export interface MigrationDiscrepancyReport {
  entities: JsonEntityDiscrepancy[];
  trialBalance: JsonAccountDiscrepancy[];
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim()) return BigInt(value.trim());
  return 0n;
}

async function mappingCount(businessId: string, connectionId: string, entityType: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return Number(rows[0]?.count ?? 0);
}

async function openingInventoryMappingCount(businessId: string, connectionId: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM integration_mappings m
       JOIN inventory_events event
         ON event.id = m.local_id::uuid AND event.business_id = m.business_id
      WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'holoo_stock'
        AND event.event_type = 'opening' AND event.source_type = 'holoo_import'`,
    [businessId, connectionId],
  );
  return Number(rows[0]?.count ?? 0);
}

function transactionTotal(transactions: readonly HolooTransaction[] | undefined, type: HolooTransaction["type"]): bigint {
  return (transactions ?? [])
    .filter((tx) => tx.type === type)
    .reduce((sum, tx) => sum + toBigInt(tx.amountRial), 0n);
}

async function appDocumentTotal(businessId: string, connectionId: string, entityType: string): Promise<bigint> {
  const { rows } = await query<{ total: string }>(
    `SELECT COALESCE(SUM(CASE
        WHEN $3 = 'holoo_invoice' THEN o.total
        WHEN $3 = 'holoo_purchase' THEN COALESCE(p.total, ip.total)
        WHEN $3 = 'holoo_receipt' THEN COALESCE(ar.amount, ap.amount)
        ELSE 0 END), 0)::text AS total
       FROM integration_mappings m
       LEFT JOIN orders o ON $3 = 'holoo_invoice' AND o.id = m.local_id
       LEFT JOIN purchases p ON $3 = 'holoo_purchase' AND p.id = m.local_id
       LEFT JOIN item_purchases ip ON $3 = 'holoo_purchase' AND ip.id = m.local_id
       LEFT JOIN ar_receipts ar ON $3 = 'holoo_receipt' AND ar.id = m.local_id
       LEFT JOIN ap_payments ap ON $3 = 'holoo_receipt' AND ap.id = m.local_id
      WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = $3`,
    [businessId, connectionId, entityType],
  );
  return BigInt(rows[0]?.total ?? "0");
}

function holooTrialBalance(manifest: MigrationDiscrepancyManifest): Map<string, { debit: bigint; credit: bigint }> {
  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  const add = (code: string, debit: bigint, credit: bigint) => {
    const current = totals.get(code) ?? { debit: 0n, credit: 0n };
    current.debit += debit;
    current.credit += credit;
    totals.set(code, current);
  };
  for (const voucher of manifest.journals ?? []) {
    for (const line of voucher.lines) {
      const net = toBigInt(line.debitRial) - toBigInt(line.creditRial);
      add(line.accountCode, net > 0n ? net : 0n, net < 0n ? -net : 0n);
    }
  }
  for (const line of manifest.openingBalance ?? []) add(line.accountCode, toBigInt(line.debitRial), toBigInt(line.creditRial));
  return totals;
}

export async function buildMigrationDiscrepancyReport(
  businessId: string,
  connectionId: string,
  manifest: MigrationDiscrepancyManifest,
): Promise<MigrationDiscrepancyReport> {
  const comparisons: EntityComparison[] = [];
  const selected = manifest.selectedScopes ? new Set(manifest.selectedScopes) : null;
  const includesScope = (scope: string) => !selected || selected.has(scope);

  if (manifest.base) {
    if (includesScope("goods")) {
      comparisons.push({
        entityType: "goods",
        holooCount: manifest.base.goods.length,
        appCount: await mappingCount(businessId, connectionId, "holoo_goods"),
        holooBalanceRial: 0n,
        appBalanceRial: 0n,
      });
    }
    if (includesScope("persons")) {
      comparisons.push({
        entityType: "persons",
        holooCount: manifest.base.persons.length,
        appCount: await mappingCount(businessId, connectionId, "holoo_customer"),
        holooBalanceRial: 0n,
        appBalanceRial: 0n,
      });
    }
    if (includesScope("accounts")) {
      comparisons.push({
        entityType: "accounts",
        holooCount: manifest.base.accounts.length,
        appCount: await mappingCount(businessId, connectionId, "holoo_account"),
        holooBalanceRial: 0n,
        appBalanceRial: 0n,
      });
    }
    if (manifest.base.openingInventory && includesScope("openingInventory")) {
      comparisons.push({
        entityType: "openingInventory",
        holooCount: manifest.base.openingInventory.length,
        appCount: await openingInventoryMappingCount(businessId, connectionId),
        holooBalanceRial: 0n,
        appBalanceRial: 0n,
      });
    }
  }

  if (manifest.journals && includesScope("journal")) {
    comparisons.push({
      entityType: "journals",
      holooCount: manifest.journals.length,
      appCount: await mappingCount(businessId, connectionId, "holoo_journal"),
      holooBalanceRial: 0n,
      appBalanceRial: 0n,
    });
  }

  if (manifest.transactions) {
    comparisons.push(
      {
        entityType: "sales",
        holooCount: manifest.transactions.filter((tx) => tx.type === "sale").length,
        appCount: await mappingCount(businessId, connectionId, "holoo_invoice"),
        holooBalanceRial: transactionTotal(manifest.transactions, "sale"),
        appBalanceRial: await appDocumentTotal(businessId, connectionId, "holoo_invoice"),
      },
      {
        entityType: "purchases",
        holooCount: manifest.transactions.filter((tx) => tx.type === "purchase").length,
        appCount: await mappingCount(businessId, connectionId, "holoo_purchase"),
        holooBalanceRial: transactionTotal(manifest.transactions, "purchase"),
        appBalanceRial: await appDocumentTotal(businessId, connectionId, "holoo_purchase"),
      },
      {
        entityType: "receipts_payments",
        holooCount: manifest.transactions.filter((tx) => tx.type === "receipt" || tx.type === "payment").length,
        appCount: await mappingCount(businessId, connectionId, "holoo_receipt"),
        holooBalanceRial: transactionTotal(manifest.transactions, "receipt") + transactionTotal(manifest.transactions, "payment"),
        appBalanceRial: await appDocumentTotal(businessId, connectionId, "holoo_receipt"),
      },
    );
  }

  const holoo = holooTrialBalance(manifest);
  const accountCodes = [...holoo.keys()];
  let appRows: Array<{ code: string; debit: string; credit: string }> = [];
  if (accountCodes.length > 0) {
    ({ rows: appRows } = await query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code,
              COALESCE(SUM(jl.debit), 0)::text AS debit,
              COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
        WHERE a.business_id = $1 AND a.code = ANY($2::text[])
        GROUP BY a.code`,
      [businessId, accountCodes],
    ));
  }
  const appByCode = new Map(appRows.map((row) => [row.code, row]));
  const trial: AccountBalance[] = accountCodes.map((code) => {
    const h = holoo.get(code)!;
    const app = appByCode.get(code);
    return {
      code,
      holooDebitRial: h.debit,
      holooCreditRial: h.credit,
      appDebitRial: BigInt(app?.debit ?? "0"),
      appCreditRial: BigInt(app?.credit ?? "0"),
    };
  });

  return {
    entities: entityDiscrepancies(comparisons).map((row) => ({
      entityType: row.entityType,
      countDiff: row.countDiff,
      balanceDiffRial: row.balanceDiffRial.toString(),
    })),
    trialBalance: trialBalanceDiscrepancies(trial).map((row) => ({
      code: row.code,
      debitDiffRial: row.debitDiffRial.toString(),
      creditDiffRial: row.creditDiffRial.toString(),
    })),
  };
}
