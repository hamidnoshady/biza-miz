/**
 * Salary advances (مساعده) — audit F11, hardened by issue #835.
 *
 * An advance is money paid to a member before payday: Debit 1260 staff advances
 * / Credit the payout account. The next payroll run recovers it from the
 * member's pay. What a member still owes is *derived* — their standing advances
 * minus the recoveries of standing (not voided) runs — never a mutable balance
 * column, so voiding a run gives its recovery back by construction.
 *
 * The same three rules as the run itself (#835):
 *
 *   - **Business-wide.** The advance's entry carries no branch (it used to take
 *     the caller's active one), because the run that later recovers it posts
 *     business-wide; a per-branch debit with a business-wide credit would leave
 *     account 1260 permanently unbalanced by branch. A void mirrors the
 *     original entry with that entry's own location.
 *   - **A canonical payout account.** The credit side is a cash/bank/petty-cash
 *     account of the business's own chart — chosen with `paymentAccountId`, or
 *     `method` (cash → 1100, bank → 1110) — never the card-clearing account.
 *   - **Exact money.** `bigint` end to end, integer text on the wire.
 *
 * DB-touching, so per repo convention it has no direct unit test; covered by
 * integration/payroll.integration.test.ts.
 */
import { query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { normalizeOptionalIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { accountIdsByCode, postExactJournalEntry, postExactMirrorEntry } from "./ledger-service";
import type { RialText } from "./inventory-exact";
import { parseRialInput } from "./payroll-amounts";
import { asRial, clientRunner, inTransaction, lockPayroll, type Runner } from "./payroll-db";
import { resolvePayoutAccount } from "./payroll-accounts";
import { PayrollError } from "./payroll-errors";
import type { PayrollAdvance } from "./payroll-types";

/** The longest advance note — a line, not a document. */
export const ADVANCE_NOTE_MAX = 200;

/**
 * Per member: what they still owe the business through payroll, never below
 * zero — the one source of truth for both payroll paths:
 *
 *   salary advances (active)
 *   + payroll debts from downward #865 supplemental corrections (approved+ runs)
 *   − recoveries by #835 runs that are not voided
 *   − recoveries by #865 engine runs that are not cancelled
 *
 * `excludeEngineRunId` leaves one engine run's own recovery out, for that run's
 * recalculation. Run on the caller's client so an accrual reads it under its
 * own lock.
 */
export async function outstandingAdvances(
  run: Runner,
  businessId: string,
  options: { excludeEngineRunId?: string | null } = {},
): Promise<Map<string, bigint>> {
  const { rows } = await run<{ user_id: string; outstanding: string }>(
    `WITH owed AS (
        SELECT user_id, amount AS owed, 0::bigint AS recovered FROM payroll_advances
         WHERE business_id = $1 AND status = 'active'
        UNION ALL
        SELECT ps.user_id, ps.employee_debt, 0 FROM payroll_payslips ps JOIN payroll_engine_runs er ON er.id = ps.run_id
         WHERE er.business_id = $1 AND er.status IN ('approved', 'posted', 'paid', 'closed')
           AND ps.employee_debt > 0 AND ps.user_id IS NOT NULL
        UNION ALL
        SELECT rl.user_id, 0, rl.advance_recovery FROM payroll_run_lines rl JOIN payroll_runs r ON r.id = rl.run_id
         WHERE r.business_id = $1 AND r.status <> 'voided' AND rl.user_id IS NOT NULL AND rl.advance_recovery > 0
        UNION ALL
        SELECT ps.user_id, 0, ps.advance_recovery FROM payroll_payslips ps JOIN payroll_engine_runs er ON er.id = ps.run_id
         WHERE er.business_id = $1 AND er.status <> 'cancelled' AND ps.user_id IS NOT NULL AND ps.advance_recovery > 0
           AND er.id IS DISTINCT FROM $2::uuid
     )
     SELECT user_id, GREATEST(sum(owed) - sum(recovered), 0)::text AS outstanding
       FROM owed GROUP BY user_id HAVING sum(owed) > 0`,
    [businessId, options.excludeEngineRunId ?? null],
  );
  return new Map(rows.map((r) => [r.user_id, BigInt(r.outstanding)]));
}

interface AdvanceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  full_name: string | null;
  amount: string;
  method: "cash" | "bank";
  advance_date: string;
  note: string | null;
  status: "active" | "voided";
  created_by_name: string | null;
}

function toAdvance(r: AdvanceRow): PayrollAdvance {
  return {
    id: r.id,
    userId: r.user_id,
    fullName: r.full_name,
    amount: r.amount,
    method: r.method,
    advanceDate: r.advance_date,
    note: r.note,
    status: r.status,
    createdByName: r.created_by_name,
  };
}

const ADVANCE_SELECT = `SELECT a.id, a.user_id, m.full_name, a.amount::text AS amount, a.method,
            a.advance_date::text AS advance_date, a.note, a.status, c.full_name AS created_by_name
       FROM payroll_advances a
       LEFT JOIN users m ON m.id = a.user_id
       LEFT JOIN users c ON c.id = a.created_by`;

/** The business's most recent advances, newest first — a bounded list, not the whole history. */
export async function listAdvances(businessId: string): Promise<PayrollAdvance[]> {
  const { rows } = await query<AdvanceRow>(
    `${ADVANCE_SELECT}
      WHERE a.business_id = $1
      ORDER BY a.advance_date DESC, a.created_at DESC, a.id DESC
      LIMIT 200`,
    [businessId],
  );
  return rows.map(toAdvance);
}

async function getAdvance(businessId: string, id: string): Promise<PayrollAdvance> {
  const { rows } = await query<AdvanceRow>(`${ADVANCE_SELECT} WHERE a.business_id = $1 AND a.id = $2`, [businessId, id]);
  if (!rows[0]) throw new PayrollError("advance_not_found", 404);
  return toAdvance(rows[0]);
}

/**
 * Pays a salary advance to a member: Debit 1260 staff advances / Credit the
 * payout account — the same cash/bank choice, and the same posting path, a run's
 * payment uses. The next run recovers it. The fiscal-period lock applies to the
 * advance's date.
 */
export async function recordAdvance(params: {
  businessId: string;
  userId: string;
  /** A safe-integer number or integer text of Rial; more than zero. */
  amount: unknown;
  method?: "cash" | "bank";
  /** An account from `listPaymentAccounts`; takes precedence over `method`. */
  paymentAccountId?: string | null;
  advanceDate?: string | null;
  note?: string | null;
  createdBy: string | null;
}): Promise<PayrollAdvance> {
  if (!isUuid(params.userId)) throw new PayrollError("user_not_found", 404);
  const amount = parseRialInput(params.amount);
  if (amount === 0n) throw new PayrollError("invalid_amount");

  // Cash and bank are different accounts: an unknown method is refused rather
  // than defaulted into one of them.
  const method = params.method ?? "cash";
  if (method !== "cash" && method !== "bank") throw new PayrollError("invalid_method");
  const paymentAccountId = params.paymentAccountId ?? null;
  if (paymentAccountId !== null && !isUuid(paymentAccountId)) throw new PayrollError("invalid_payment_account");

  const date = normalizeOptionalIsoDate(params.advanceDate);
  if (!date.ok) throw new PayrollError("invalid_advance_date");
  const note = params.note?.trim() || null;
  if (note && note.length > ADVANCE_NOTE_MAX) throw new PayrollError("note_too_long");

  const id = await inTransaction(async (client) => {
    const { rows: member } = await client.query<{ full_name: string }>(
      `SELECT full_name FROM users WHERE id = $1 AND business_id = $2 AND is_active`,
      [params.userId, params.businessId],
    );
    if (!member[0]) throw new PayrollError("user_not_found", 404);

    const payout = await resolvePayoutAccount(client, params.businessId, { method, paymentAccountId });
    const accounts = await accountIdsByCode(client, params.businessId, [WELL_KNOWN_CODES.staffAdvances]);

    const { rows } = await client.query<{ id: string; advance_date: string }>(
      `INSERT INTO payroll_advances (business_id, location_id, user_id, amount, method, advance_date, note, created_by)
       VALUES ($1, NULL, $2, $3, $4, COALESCE($5::date, CURRENT_DATE), $6, $7)
       RETURNING id, advance_date::text AS advance_date`,
      [params.businessId, params.userId, amount.toString(), payout.method, date.value, note, params.createdBy],
    );

    await postExactJournalEntry(client, {
      businessId: params.businessId,
      locationId: null,
      entryDate: rows[0].advance_date,
      memo: `مساعده — ${member[0].full_name}`,
      sourceType: "payroll_advance",
      sourceId: rows[0].id,
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.staffAdvances)!, debit: asRial(amount), credit: "0" as RialText },
        { accountId: payout.accountId, debit: "0" as RialText, credit: asRial(amount) },
      ],
    });
    return rows[0].id;
  });
  return getAdvance(params.businessId, id);
}

/**
 * Voids an advance recorded by mistake: mirrors its entry (dated today, the
 * fiscal lock applies; each mirror carries its original's own location) and
 * stops it counting. Refused once a run has recovered any of it — that recovery
 * is in a posted run, which is voided first.
 */
export async function voidAdvance(params: {
  businessId: string;
  advanceId: string;
  actorId: string | null;
}): Promise<PayrollAdvance> {
  if (!isUuid(params.advanceId)) throw new PayrollError("advance_not_found", 404);

  await inTransaction(async (client) => {
    await lockPayroll(client, params.businessId);

    const { rows } = await client.query<{ id: string; user_id: string; amount: string; status: string }>(
      `SELECT id, user_id, amount::text AS amount, status FROM payroll_advances
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.advanceId, params.businessId],
    );
    const advance = rows[0];
    if (!advance) throw new PayrollError("advance_not_found", 404);
    if (advance.status === "voided") throw new PayrollError("already_voided", 409);

    const outstanding = await outstandingAdvances(clientRunner(client), params.businessId);
    if ((outstanding.get(advance.user_id) ?? 0n) < BigInt(advance.amount)) {
      throw new PayrollError("advance_already_recovered", 409);
    }

    const { rows: entries } = await client.query<{ id: string; location_id: string | null }>(
      `SELECT id, location_id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'payroll_advance' AND source_id = $2
          AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
      [params.businessId, advance.id],
    );
    for (const entry of entries) {
      await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: entry.location_id,
        originalEntryId: entry.id,
        sourceType: "payroll_advance_void",
        sourceId: advance.id,
        postingKind: "payroll_void",
        memo: "ابطال مساعده",
        createdBy: params.actorId,
      });
    }
    await client.query(`UPDATE payroll_advances SET status = 'voided', voided_at = now(), voided_by = $2 WHERE id = $1`, [
      advance.id,
      params.actorId,
    ]);
  });
  return getAdvance(params.businessId, params.advanceId);
}
