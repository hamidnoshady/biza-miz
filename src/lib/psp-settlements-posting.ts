import type { PoolClient } from "pg";
import { classifyAccounts, type ClassifiableAccount } from "./account-classification";
import { query } from "./db";
import type { FinancialAccountRecord } from "./financial-accounts-service";
import type { PspSettlementMetadata } from "./psp-settlements";

/** Called after acquiring the transfer lock and locking both account mappings. */
export async function pspSettlementPostingProblem(client: PoolClient, params: {
  businessId: string;
  source: FinancialAccountRecord;
  destination: FinancialAccountRecord;
  baseCurrency: string;
  locationId: string | null;
  transferDate: string;
  amount: string;
  settlement: PspSettlementMetadata;
}): Promise<string | null> {
  const { businessId, source, destination, baseCurrency, locationId, transferDate, amount, settlement } = params;
  if (source.kind !== "pos_psp" || destination.kind !== "bank" || source.settlementAccountId !== destination.id) {
    return "psp_settlement_bank_mismatch";
  }
  if (source.currencyCode !== "IRR" || baseCurrency !== "IRR") return "psp_settlement_requires_irr";

  const { rows: terminals } = await client.query<{ ready: boolean }>(
    `SELECT nullif(btrim(psp_provider), '') IS NOT NULL AND nullif(btrim(terminal_number), '') IS NOT NULL
          AND nullif(btrim(merchant_number), '') IS NOT NULL AS ready
       FROM financial_accounts WHERE business_id = $1 AND id = $2`,
    [businessId, source.id],
  );
  if (!terminals[0]?.ready) return "psp_terminal_not_configured";

  const { rows: accounts } = await client.query<{
    id: string; code: string; parent_id: string | null; type: ClassifiableAccount["type"]; is_active: boolean;
  }>("SELECT id, code, parent_id, type, is_active FROM accounts WHERE business_id = $1", [businessId]);
  const roles = classifyAccounts(accounts.map(({ id, code, parent_id, type }) => ({ id, code, parentId: parent_id, type })));
  const parentIds = new Set(accounts.map(({ parent_id }) => parent_id));
  const activeLeafIds = new Set(accounts.filter(({ id, is_active }) => is_active && !parentIds.has(id)).map(({ id }) => id));
  if (roles.get(source.glAccountId) !== "payment_clearing" || roles.get(destination.glAccountId) !== "bank" ||
      !activeLeafIds.has(source.glAccountId) || !activeLeafIds.has(destination.glAccountId)) {
    return "psp_settlement_gl_mismatch";
  }

  const { rows: batches } = await client.query<{ inconsistent: boolean | null; posted: string }>(
    `SELECT BOOL_OR(psp_batch_gross_amount <> $4::bigint OR destination_account_id <> $5::uuid
                   OR psp_expected_on IS DISTINCT FROM $6::date OR location_id IS DISTINCT FROM $7::uuid) AS inconsistent,
            COALESCE(SUM(amount) FILTER (WHERE status = 'posted'), 0)::text AS posted
       FROM financial_transfers
      WHERE business_id = $1 AND source_account_id = $2 AND psp_batch_reference = $3`,
    [businessId, source.id, settlement.batchReference, settlement.batchGrossAmount,
      destination.id, settlement.expectedOn, locationId],
  );
  if (batches[0]?.inconsistent) return "psp_batch_conflict";
  if (BigInt(batches[0]?.posted ?? "0") + BigInt(amount) > BigInt(settlement.batchGrossAmount)) {
    return "psp_batch_amount_exceeded";
  }

  // A backdated installment must not spend amounts that only arrived later,
  // or make any later already-booked closing balance negative.
  const { rows: balances } = await client.query<{ available: string }>(
    `WITH daily AS (
       SELECT GREATEST(e.entry_date, $3::date) AS day, SUM(jl.debit - jl.credit) AS movement
         FROM journal_lines jl JOIN journal_entries e ON e.id = jl.entry_id
        WHERE e.business_id = $1 AND jl.account_id = $2
        GROUP BY 1
       UNION ALL SELECT $3::date, 0
     ), running AS (
       SELECT SUM(movement) OVER (ORDER BY day) AS balance FROM daily
     ) SELECT MIN(balance)::text AS available FROM running`,
    [businessId, source.glAccountId, transferDate],
  );
  if (BigInt(balances[0]?.available ?? "0") < BigInt(amount)) return "psp_insufficient_clearing";
  return null;
}

export type PspSettlementMovement = {
  transferId: string;
  transferNumber: string;
  journalEntryId: string;
  terminalName: string;
  bankName: string;
  batchReference: string;
  movementReference: string;
  batchGrossAmount: string;
  grossAmount: string;
  netAmount: string;
  feeAmount: string;
  remainingAmount: string;
  expectedOn: string | null;
  settledOn: string;
  status: "posted" | "reversed";
};

/** Batch remainders are computed over every in-scope installment, before pagination. */
export async function listPspSettlements(
  businessId: string,
  allowedLocationIds: readonly string[] | null,
  limit: number,
  cursor: string | null,
): Promise<{ movements: PspSettlementMovement[]; nextCursor: string | null }> {
  const { rows } = await query<PspSettlementMovement & { sequenceNo: string }>(
    `WITH movements AS (
       SELECT t.id AS "transferId", t.transfer_number AS "transferNumber", t.journal_entry_id AS "journalEntryId",
              s.name AS "terminalName", d.name AS "bankName", t.psp_batch_reference AS "batchReference",
              t.psp_movement_reference AS "movementReference", t.psp_batch_gross_amount::text AS "batchGrossAmount",
              t.amount::text AS "grossAmount", (t.amount - t.fee_amount)::text AS "netAmount",
              t.fee_amount::text AS "feeAmount",
              (t.psp_batch_gross_amount - COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'posted') OVER
               (PARTITION BY t.source_account_id, t.psp_batch_reference), 0))::text AS "remainingAmount",
              t.psp_expected_on::text AS "expectedOn", t.transfer_date::text AS "settledOn", t.status,
              t.sequence_no AS "sequenceNo"
         FROM financial_transfers t
         JOIN financial_accounts s ON s.id = t.source_account_id AND s.business_id = t.business_id
         JOIN financial_accounts d ON d.id = t.destination_account_id AND d.business_id = t.business_id
        WHERE t.business_id = $1 AND t.psp_batch_reference IS NOT NULL AND
              ($2::uuid[] IS NULL OR ((t.location_id IS NULL OR t.location_id = ANY($2))
                AND (s.location_id IS NULL OR s.location_id = ANY($2)) AND (d.location_id IS NULL OR d.location_id = ANY($2))))
     ) SELECT * FROM movements
        WHERE ($4::bigint IS NULL OR "sequenceNo" < $4::bigint) ORDER BY "sequenceNo" DESC LIMIT $3`,
    [businessId, allowedLocationIds, limit + 1, cursor],
  );
  const page = rows.slice(0, limit);
  return {
    movements: page.map(({ sequenceNo: _sequenceNo, ...movement }) => movement),
    nextCursor: rows.length > limit ? page.at(-1)?.sequenceNo ?? null : null,
  };
}
