/**
 * Cheques (چک) — the DB-touching half.
 *
 * Records a cheque, walks it through its life, and posts the entry each step
 * owes. Shaped like `ap-service.ts`'s `payBill`: one transaction that writes the
 * subledger row and its journal entry together, so a cheque can never be in a
 * state the ledger disagrees with.
 *
 * Where the money goes, per step:
 *
 *   receivable
 *     received    Debit چک‌های نزد صندوق      / Credit حساب‌های دریافتنی
 *     deposit     Debit چک‌های در جریان وصول  / Credit چک‌های نزد صندوق
 *     clear       Debit بانک                  / Credit چک‌های در جریان وصول
 *     endorse     Debit حساب‌های پرداختنی     / Credit چک‌های نزد صندوق
 *     bounce      Debit چک‌های برگشتی         / Credit wherever it was
 *
 *   payable
 *     issued      Debit حساب‌های پرداختنی     / Credit چک‌های صادرشده در جریان
 *     present     Debit چک‌های صادرشده        / Credit بانک
 *     bounce      Debit چک‌های صادرشده        / Credit چک‌های پرداختنی برگشتی
 *     cancel      Debit چک‌های صادرشده        / Credit حساب‌های پرداختنی
 *
 * Two of those are worth reading twice.
 *
 * **Clearing an endorsed cheque posts nothing.** The supplier was paid at the
 * moment of endorsement — that entry already moved the debt — so the cheque
 * clearing at their bank is news, not a transaction. The status still advances,
 * because the register has to stop showing it as outstanding.
 *
 * **Bouncing an endorsed cheque credits accounts payable**, putting the supplier
 * back in the money we owe them and the bad cheque back on our books. That is
 * the whole reason `endorsed` is a status rather than an account: the
 * contingency is real, and it resolves into a real entry either way.
 *
 * DB-touching, so per repo convention it has no direct unit test — the pure half
 * is `cheques.ts`, and this is covered by integration/cheques.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isUuid } from "./uuid";
import { accountIdsByCode, postJournalEntry } from "./ledger-service";
import {
  CHEQUE_ACTIONS,
  CHEQUE_DIRECTIONS,
  initialStatus,
  nextStatus,
  normalizeSayadId,
  type ChequeAction,
  type ChequeDirection,
  type ChequeStatus,
} from "./cheques";
import { isValidIsoDate, isoDateInTimeZone } from "./jalali";
import { PARTY_ROLE_STORAGE } from "./parties";

export class ChequeError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Tehran's calendar day, matching the Jalali date picker rather than UTC. */
function todayIso(): string {
  return isoDateInTimeZone(new Date()) ?? new Date().toISOString().slice(0, 10);
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ChequeError(code);
  return value.trim();
}

function optionalText(value: unknown, code = "bad_request"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ChequeError(code);
  return value.trim() || null;
}

function optionalIsoDate(value: unknown, code: string): string | null {
  const date = optionalText(value);
  if (!date) return null;
  if (!isValidIsoDate(date)) throw new ChequeError(code);
  return date;
}

function requiredIsoDate(value: unknown, missingCode: string, invalidCode: string): string {
  const date = requiredText(value, missingCode);
  if (!isValidIsoDate(date)) throw new ChequeError(invalidCode);
  return date;
}

export interface Cheque {
  id: string;
  /** The branch that owns the instrument — every entry of its life posts here. */
  locationId: string | null;
  locationName: string | null;
  direction: ChequeDirection;
  status: ChequeStatus;
  serialNumber: string;
  sayadId: string | null;
  bankName: string;
  accountNumber: string | null;
  amount: number;
  issueDate: string;
  dueDate: string;
  counterpartyName: string;
  customerId: string | null;
  supplierId: string | null;
  memo: string | null;
  createdAt: string;
}

interface ChequeRow extends Record<string, unknown> {
  id: string;
  location_id: string | null;
  location_name?: string | null;
  direction: ChequeDirection;
  status: ChequeStatus;
  serial_number: string;
  sayad_id: string | null;
  bank_name: string;
  account_number: string | null;
  amount: string;
  issue_date: string;
  due_date: string;
  counterparty_name: string;
  customer_id: string | null;
  supplier_id: string | null;
  memo: string | null;
  created_at: string;
}

function toCheque(r: ChequeRow): Cheque {
  return {
    id: r.id,
    locationId: r.location_id,
    locationName: r.location_name ?? null,
    direction: r.direction,
    status: r.status,
    serialNumber: r.serial_number,
    sayadId: r.sayad_id,
    bankName: r.bank_name,
    accountNumber: r.account_number,
    amount: Number(r.amount),
    issueDate: r.issue_date,
    dueDate: r.due_date,
    counterpartyName: r.counterparty_name,
    customerId: r.customer_id,
    supplierId: r.supplier_id,
    memo: r.memo,
    createdAt: r.created_at,
  };
}

const CHEQUE_COLUMNS = `id, location_id, direction, status, serial_number, sayad_id, bank_name, account_number,
                        amount::text AS amount, issue_date::text AS issue_date, due_date::text AS due_date,
                        counterparty_name, customer_id, supplier_id, memo, created_at`;

/** The same columns read through the register's `cheques c` alias. */
const CHEQUE_COLUMNS_PREFIXED = CHEQUE_COLUMNS.split(",")
  .map((col) => `c.${col.trim()}`)
  .join(", ");

/** Every cheque of one direction, the ones still alive first and then by due date. */
export async function listCheques(
  businessId: string,
  direction?: ChequeDirection,
  locationId?: string | null,
): Promise<Cheque[]> {
  if (direction && !CHEQUE_DIRECTIONS.includes(direction)) {
    throw new ChequeError("invalid_direction");
  }
  const params: unknown[] = [businessId];
  let where = "c.business_id = $1";
  if (direction) {
    params.push(direction);
    where += ` AND c.direction = $${params.length}`;
  }
  if (locationId) {
    if (!isUuid(locationId)) throw new ChequeError("invalid_location");
    params.push(locationId);
    where += ` AND c.location_id = $${params.length}`;
  }
  const { rows } = await query<ChequeRow>(
    `SELECT ${CHEQUE_COLUMNS_PREFIXED},
            l.name AS location_name
       FROM cheques c
       LEFT JOIN locations l ON l.id = c.location_id
      WHERE ${where}
      ORDER BY (c.status IN ('cleared', 'bounced', 'cancelled', 'resolved')), c.due_date, c.created_at`,
    params,
  );
  return rows.map(toCheque);
}

export interface ChequeEvent {
  id: string;
  event: string;
  occurredOn: string;
  entryId: string | null;
  endorsedToSupplierId: string | null;
  memo: string | null;
  createdAt: string;
}

/**
 * One cheque's history — what happened to it, when, and which entry each step
 * posted.
 *
 * Ordered `occurred_on, created_at, id`: the timeline a treasurer reads is
 * accounting chronology, and since `transitionCheque` refuses an event dated
 * before the latest one, insertion order and accounting order now agree —
 * `created_at, id` is only the tie-break for same-day steps.
 */
export async function getChequeHistory(businessId: string, chequeId: string): Promise<ChequeEvent[]> {
  if (!isUuid(chequeId)) throw new ChequeError("cheque_not_found", 404);
  const { rows: chequeRows } = await query<{ id: string }>(
    "SELECT id FROM cheques WHERE business_id = $1 AND id = $2",
    [businessId, chequeId],
  );
  if (!chequeRows[0]) throw new ChequeError("cheque_not_found", 404);

  const { rows } = await query<{
    id: string;
    event: string;
    occurred_on: string;
    entry_id: string | null;
    endorsed_to_supplier_id: string | null;
    memo: string | null;
    created_at: string;
  }>(
    `SELECT id, event, occurred_on::text AS occurred_on, entry_id, endorsed_to_supplier_id, memo, created_at
       FROM cheque_events WHERE business_id = $1 AND cheque_id = $2
      ORDER BY occurred_on, created_at, id`,
    [businessId, chequeId],
  );
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    occurredOn: r.occurred_on,
    entryId: r.entry_id,
    endorsedToSupplierId: r.endorsed_to_supplier_id,
    memo: r.memo,
    createdAt: r.created_at,
  }));
}

/** A supplier belongs to this business through its (mandatory) location — `suppliers` has no business_id. */
async function assertSupplier(client: PoolClient, businessId: string, supplierId: string): Promise<void> {
  // `suppliers.id` is a uuid: a non-uuid raises a Postgres syntax error rather
  // than matching nothing, so it has to be answered before the query (see
  // `isUuid`). The A/P balance list's «بدون تأمین‌کننده مشخص» bucket carries the
  // id `"unknown"`, and a picker built from that list could submit it.
  if (!isUuid(supplierId)) throw new ChequeError("supplier_not_found", 404);
  const { rows } = await client.query(
    `SELECT 1 FROM suppliers s JOIN locations l ON l.id = s.location_id
      WHERE s.id = $1 AND l.business_id = $2`,
    [supplierId, businessId],
  );
  if (!rows[0]) throw new ChequeError("supplier_not_found", 404);
}

async function assertCustomer(client: PoolClient, businessId: string, customerId: string): Promise<void> {
  if (!isUuid(customerId)) throw new ChequeError("customer_not_found", 404);
  const { rows } = await client.query(
    `SELECT 1 FROM parties
      WHERE id = $1 AND business_id = $2 AND roles @> ARRAY[$3]::text[] AND is_active AND merged_into_id IS NULL`,
    [customerId, businessId, PARTY_ROLE_STORAGE.Customer],
  );
  if (!rows[0]) throw new ChequeError("customer_not_found", 404);
}

export interface RecordChequeParams {
  businessId: string;
  locationId: string | null;
  direction: ChequeDirection;
  serialNumber: string;
  sayadId?: string | null;
  bankName: string;
  accountNumber?: string | null;
  amount: number;
  issueDate?: string | null;
  dueDate: string;
  counterpartyName: string;
  customerId?: string | null;
  supplierId?: string | null;
  memo?: string | null;
  createdBy: string | null;
}

/**
 * Records a cheque and posts the entry that puts it on the books: a receivable
 * settles the customer's balance, a payable settles the supplier's.
 *
 * Both sides post against the *account*, not the invoice — a cheque is trade
 * credit, and which of a customer's open bills it eventually covers is the AR
 * subledger's question, answered when the cheque clears and their balance moves.
 */
export async function recordCheque(params: RecordChequeParams): Promise<Cheque> {
  if (!CHEQUE_DIRECTIONS.includes(params.direction)) throw new ChequeError("invalid_direction");
  if (!Number.isSafeInteger(params.amount) || params.amount <= 0) throw new ChequeError("invalid_amount");

  const serialNumber = requiredText(params.serialNumber, "serial_number_required");
  const bankName = requiredText(params.bankName, "bank_name_required");
  const counterpartyName = requiredText(params.counterpartyName, "counterparty_name_required");
  const issueDate = optionalIsoDate(params.issueDate, "invalid_issue_date") ?? todayIso();
  const dueDate = requiredIsoDate(params.dueDate, "due_date_required", "invalid_due_date");
  if (dueDate < issueDate) throw new ChequeError("due_date_before_issue");

  const sayadInput = optionalText(params.sayadId, "invalid_sayad_id");
  const sayadId = sayadInput ? normalizeSayadId(sayadInput) : null;
  if (sayadInput && !sayadId) throw new ChequeError("invalid_sayad_id");

  const customerId = optionalText(params.customerId, "customer_not_found");
  const supplierId = optionalText(params.supplierId, "supplier_not_found");
  if (params.direction === "receivable" && supplierId) {
    throw new ChequeError("invalid_counterparty_for_direction");
  }
  if (params.direction === "payable" && customerId) {
    throw new ChequeError("invalid_counterparty_for_direction");
  }
  const accountNumber = optionalText(params.accountNumber);
  const memo = optionalText(params.memo);

  const status = initialStatus(params.direction);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (customerId) await assertCustomer(client, params.businessId, customerId);
    if (supplierId) await assertSupplier(client, params.businessId, supplierId);

    // A receivable lands in چک‌های نزد صندوق against the customer's account; a
    // payable clears down what we owe the supplier into چک‌های صادرشده.
    const [debitCode, creditCode] =
      params.direction === "receivable"
        ? [WELL_KNOWN_CODES.chequesOnHand, WELL_KNOWN_CODES.accountsReceivable]
        : [WELL_KNOWN_CODES.accountsPayable, WELL_KNOWN_CODES.chequesIssued];
    const accounts = await accountIdsByCode(client, params.businessId, [debitCode, creditCode]);

    const { rows } = await client.query<ChequeRow>(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, sayad_id, bank_name,
                            account_number, amount, issue_date, due_date, counterparty_name, customer_id,
                            supplier_id, memo, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, CURRENT_DATE), $11, $12, $13, $14, $15, $16)
       RETURNING ${CHEQUE_COLUMNS}`,
      [
        params.businessId,
        params.locationId,
        params.direction,
        status,
        serialNumber,
        sayadId,
        bankName,
        accountNumber,
        params.amount,
        issueDate,
        dueDate,
        counterpartyName,
        customerId,
        supplierId,
        memo,
        params.createdBy,
      ],
    );
    const cheque = rows[0];

    // The entry dates on the day the cheque changed hands, not its due date —
    // that is when the obligation moved, and it is what the fiscal-period lock
    // should be looking at.
    const entryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: cheque.issue_date,
      memo:
        params.direction === "receivable"
          ? `دریافت چک ${cheque.serial_number} از ${cheque.counterparty_name}`
          : `صدور چک ${cheque.serial_number} در وجه ${cheque.counterparty_name}`,
      sourceType: "cheque",
      sourceId: cheque.id,
      createdBy: params.createdBy,
      postingKind: params.direction === "receivable" ? "cheque_received" : "cheque_issued",
      lines: [
        { accountId: accounts.get(debitCode)!, debit: params.amount, credit: 0 },
        { accountId: accounts.get(creditCode)!, debit: 0, credit: params.amount },
      ],
    });

    await recordChequeEvent(client, {
      businessId: params.businessId,
      chequeId: cheque.id,
      event: params.direction === "receivable" ? "received" : "issued",
      occurredOn: cheque.issue_date,
      entryId,
      memo,
      createdBy: params.createdBy,
    });

    await client.query("COMMIT");
    return toCheque(cheque);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function recordChequeEvent(
  client: PoolClient,
  params: {
    businessId: string;
    chequeId: string;
    event: string;
    occurredOn: string;
    entryId: string | null;
    endorsedToSupplierId?: string | null;
    memo: string | null;
    createdBy: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO cheque_events (business_id, cheque_id, event, occurred_on, entry_id, endorsed_to_supplier_id, memo, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.businessId,
      params.chequeId,
      params.event,
      params.occurredOn,
      params.entryId,
      params.endorsedToSupplierId ?? null,
      params.memo,
      params.createdBy,
    ],
  );
}

/** One posting a transition owes: an amount moved between two accounts. */
interface ChequePosting {
  debitCode: string;
  creditCode: string;
  amount: number;
}

/**
 * Which accounts a transition moves the cheque's money between — an empty list
 * when it moves none.
 *
 * `amount` is the cheque's, except for the returned-cheque fee, which is the
 * bank's charge and rides along on the bounce that caused it.
 */
function linesFor(
  direction: ChequeDirection,
  from: ChequeStatus,
  action: ChequeAction,
  amount: number,
  feeAmount: number,
): ChequePosting[] {
  const postings: ChequePosting[] = [];
  const move = (debitCode: string, creditCode: string) => {
    postings.push({ debitCode, creditCode, amount });
  };

  if (direction === "receivable") {
    if (action === "deposit") {
      move(WELL_KNOWN_CODES.chequesInCollection, WELL_KNOWN_CODES.chequesOnHand);
    } else if (action === "endorse") {
      move(WELL_KNOWN_CODES.accountsPayable, WELL_KNOWN_CODES.chequesOnHand);
    } else if (action === "clear") {
      // An endorsed cheque clearing at the supplier's bank moves no money of
      // ours: the endorsement already settled the debt. The status advances so
      // the register stops calling it outstanding, and that is all.
      if (from !== "endorsed") {
        move(WELL_KNOWN_CODES.bank, WELL_KNOWN_CODES.chequesInCollection);
      }
    } else if (action === "bounce") {
      // Wherever it was, it comes back to چک‌های برگشتی. From `endorsed` the
      // credit is accounts payable: the supplier is owed again.
      const creditCode =
        from === "in_collection"
          ? WELL_KNOWN_CODES.chequesInCollection
          : from === "endorsed"
            ? WELL_KNOWN_CODES.accountsPayable
            : WELL_KNOWN_CODES.chequesOnHand;
      move(WELL_KNOWN_CODES.chequesReturned, creditCode);
    } else if (action === "settle") {
      // The customer paid the returned cheque another way; چک‌های برگشتی empties
      // into the bank rather than sitting there forever.
      move(WELL_KNOWN_CODES.bank, WELL_KNOWN_CODES.chequesReturned);
    } else if (action === "restore") {
      // Back to the customer's account. A replacement cheque is then an
      // ordinary registration, whose own entry credits حساب‌های دریافتنی again —
      // the two net out, so A/R is never settled twice.
      move(WELL_KNOWN_CODES.accountsReceivable, WELL_KNOWN_CODES.chequesReturned);
    }
  } else if (action === "present") {
    move(WELL_KNOWN_CODES.chequesIssued, WELL_KNOWN_CODES.bank);
  } else if (action === "bounce") {
    move(WELL_KNOWN_CODES.chequesIssued, WELL_KNOWN_CODES.chequesIssuedReturned);
  } else if (action === "cancel") {
    // Undoing the issue: the supplier is owed again and the outstanding cheque
    // is gone. A reversal, not an edit — the original entry stays.
    move(WELL_KNOWN_CODES.chequesIssued, WELL_KNOWN_CODES.accountsPayable);
  } else if (action === "settle") {
    // We paid our returned cheque by bank/cash instead of replacing it.
    move(WELL_KNOWN_CODES.chequesIssuedReturned, WELL_KNOWN_CODES.bank);
  } else if (action === "restore") {
    // The liability goes back to the supplier's account, ready for a
    // replacement cheque or an ordinary payment.
    move(WELL_KNOWN_CODES.chequesIssuedReturned, WELL_KNOWN_CODES.accountsPayable);
  }

  // The bank's returned-cheque charge is ours either way, and the chart has an
  // account for exactly it («۵۸۶۰ هزینه چک برگشتی و جرایم بانکی»).
  if (feeAmount > 0 && action === "bounce") {
    postings.push({
      debitCode: WELL_KNOWN_CODES.bouncedChequeExpense,
      creditCode: WELL_KNOWN_CODES.bank,
      amount: feeAmount,
    });
  }

  return postings;
}

const EVENT_FOR_ACTION: Record<ChequeAction, string> = {
  deposit: "deposited",
  endorse: "endorsed",
  clear: "cleared",
  present: "cleared",
  bounce: "bounced",
  cancel: "cancelled",
  settle: "settled",
  restore: "restored",
};

const MEMO_FOR_ACTION: Record<ChequeAction, string> = {
  deposit: "واگذاری چک به بانک",
  endorse: "ظهرنویسی و واگذاری چک",
  clear: "وصول چک",
  present: "پاس شدن چک صادرشده",
  bounce: "برگشت چک",
  cancel: "ابطال چک صادرشده",
  settle: "تسویه چک برگشتی",
  restore: "بازگشت چک برگشتی به حساب طرف",
};

export interface TransitionChequeParams {
  businessId: string;
  chequeId: string;
  action: ChequeAction;
  occurredOn?: string | null;
  /** Required for `endorse`: who the cheque was passed to. */
  endorsedToSupplierId?: string | null;
  /** Optional on `bounce`: the bank's returned-cheque charge, posted to 5860. */
  feeAmount?: number | null;
  memo?: string | null;
  createdBy: string | null;
}

/**
 * Moves a cheque one step along its life and posts what that step owes.
 *
 * The cheque row is locked FOR UPDATE before the transition is checked, so two
 * cashiers clearing the same cheque at once cannot both post: the second one
 * finds the status already advanced and is refused by the transition table
 * rather than double-crediting چک‌های در جریان وصول.
 *
 * Two invariants the lock also buys, both of which used to be missing:
 *
 * **The branch is the cheque's, not the operator's.** The entry posts to
 * `cheques.location_id`, so switching the active location between a deposit and
 * its clearing cannot split one instrument across two branches' books. Moving a
 * cheque between branches is a different operation and would need its own
 * workflow and audit event.
 *
 * **Time only moves forward.** A step may not be dated before the latest event
 * already on the cheque, so "deposited on ۱۰ بهمن, cleared on ۲۰ دی" is refused
 * (`action_before_previous_event`) instead of being written as accounting
 * history that could not have happened — and so a transition cannot sneak into
 * a fiscal period earlier than one the cheque has already posted into. Same-day
 * steps stay legal: a cheque deposited in the morning can clear that afternoon.
 */
export async function transitionCheque(params: TransitionChequeParams): Promise<Cheque> {
  if (!isUuid(params.chequeId)) throw new ChequeError("cheque_not_found", 404);
  if (!CHEQUE_ACTIONS.includes(params.action)) throw new ChequeError("invalid_action");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: current } = await client.query<ChequeRow>(
      `SELECT ${CHEQUE_COLUMNS} FROM cheques WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.chequeId],
    );
    const cheque = current[0];
    if (!cheque) throw new ChequeError("cheque_not_found", 404);

    const target = nextStatus(cheque.direction, cheque.status, params.action);
    if (!target) throw new ChequeError("invalid_cheque_transition", 409);

    const endorsedToSupplierId = optionalText(params.endorsedToSupplierId, "supplier_not_found");
    if (params.action === "endorse") {
      if (!endorsedToSupplierId) throw new ChequeError("supplier_required");
      await assertSupplier(client, params.businessId, endorsedToSupplierId);
    }

    const occurredOn = optionalIsoDate(params.occurredOn, "invalid_occurred_on") ?? todayIso();
    if (occurredOn < cheque.issue_date) throw new ChequeError("action_before_issue");

    // Still under the row lock: the latest event is the floor for this one.
    const { rows: latest } = await client.query<{ occurred_on: string }>(
      `SELECT occurred_on::text AS occurred_on FROM cheque_events
        WHERE business_id = $1 AND cheque_id = $2
        ORDER BY occurred_on DESC, created_at DESC, id DESC LIMIT 1`,
      [params.businessId, params.chequeId],
    );
    if (latest[0] && occurredOn < latest[0].occurred_on) {
      throw new ChequeError("action_before_previous_event");
    }

    let feeAmount = 0;
    if (params.feeAmount !== undefined && params.feeAmount !== null) {
      const fee = Number(params.feeAmount);
      if (!Number.isSafeInteger(fee) || fee < 0) throw new ChequeError("invalid_fee_amount");
      if (fee > 0 && params.action !== "bounce") throw new ChequeError("fee_not_supported_for_action");
      feeAmount = fee;
    }

    const memo = optionalText(params.memo);
    const amount = Number(cheque.amount);
    const postings = linesFor(cheque.direction, cheque.status, params.action, amount, feeAmount);

    let entryId: string | null = null;
    if (postings.length > 0) {
      const codes = [...new Set(postings.flatMap((p) => [p.debitCode, p.creditCode]))];
      const accounts = await accountIdsByCode(client, params.businessId, codes);
      entryId = await postJournalEntry(client, {
        businessId: params.businessId,
        // The cheque's own branch, never the operator's current one.
        locationId: cheque.location_id,
        entryDate: occurredOn,
        memo: `${MEMO_FOR_ACTION[params.action]} ${cheque.serial_number}`,
        sourceType: "cheque",
        sourceId: cheque.id,
        createdBy: params.createdBy,
        postingKind: `cheque_${EVENT_FOR_ACTION[params.action]}`,
        lines: postings.flatMap((posting) => [
          { accountId: accounts.get(posting.debitCode)!, debit: posting.amount, credit: 0 },
          { accountId: accounts.get(posting.creditCode)!, debit: 0, credit: posting.amount },
        ]),
      });
    }

    const { rows: updated } = await client.query<ChequeRow>(
      `UPDATE cheques SET status = $3, updated_at = now() WHERE business_id = $1 AND id = $2
       RETURNING ${CHEQUE_COLUMNS}`,
      [params.businessId, params.chequeId, target],
    );

    await recordChequeEvent(client, {
      businessId: params.businessId,
      chequeId: cheque.id,
      event: EVENT_FOR_ACTION[params.action],
      // A step with no entry still happened on a day. Keep the event and its
      // possible journal entry on the same Tehran calendar date.
      occurredOn,
      entryId,
      endorsedToSupplierId: params.action === "endorse" ? endorsedToSupplierId : null,
      memo,
      createdBy: params.createdBy,
    });

    await client.query("COMMIT");
    return toCheque(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
