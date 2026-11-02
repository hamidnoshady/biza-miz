/**
 * Issue #1128 §D — the register of money an agency spends on a client's behalf.
 *
 * This is the file that makes account 1270 reachable, and the ordering is the point:
 * the cost side has to exist before the recharge side, because crediting an asset
 * nothing ever debited would drive it to a credit balance and report a *negative*
 * claim on the client. Until the recharge arrives (the next wave), a debit balance
 * here is exactly the true statement "we have spent this on clients and not yet
 * asked them for it".
 *
 * ## What only a service can do
 *
 *   * **ANOTHER INDUSTRY IS REFUSED, NOT DEFAULTED.** Every entry point checks the
 *     trade, as `agency-commercial-service.ts` does for its own: a café has no
 *     reimbursable client cost and must not be served a register that silently means
 *     something else.
 *   * **THE POSTING HAPPENS IN THE SAME TRANSACTION AS THE ROW.** The number is
 *     chosen under the register's advisory lock, the row is written, and the domain
 *     event is emitted against the transaction's own client — so a cost and its entry
 *     commit together or neither does. A row whose entry failed to write would be a
 *     claim on a client that the books do not know about, which is the one state this
 *     register must never be in.
 *   * **THE PRESENTATION IS CARRIED INTO THE ENTRY, NEVER RE-DERIVED.** The rule in
 *     `agency-reimbursable-cost-posting.ts` reads the stored choice; nothing here
 *     decides it a second time, because two places deciding the same accounting
 *     question is how a register and its ledger come apart.
 *   * **WHAT IS OUTSTANDING IS READ, NOT STORED.** A member asking "how much have we
 *     spent for this client that we have not recharged" gets `sumCostsByParty`, one
 *     grouped read over the register. Storing a running balance would be a second,
 *     staler answer to a question the rows already answer — the same rule
 *     `agency-commercial-service.ts` applies to §D's cost side.
 */
import {
  COST_NUMBER_PREFIX,
  AGENCY_COST_DESCRIPTION_LIMIT,
  AGENCY_COST_NOTE_LIMIT,
  AGENCY_COST_SETTLEMENTS,
  AGENCY_COST_VENDOR_NAME_LIMIT,
  AGENCY_PASS_THROUGH_PRESENTATIONS,
  isAgencyCostSettlement,
  isAgencyPassThroughPresentation,
  isPassThroughToClient,
  isReimbursableCostPosted,
  normalizeAgencyCostAmount,
  normalizeAgencyCostDate,
  normalizeAgencyCostOptionalText,
  normalizeAgencyCostText,
  reimbursableCostAccounts,
  type AgencyCostSettlement,
  type AgencyPassThroughPresentation,
} from "./agency-reimbursable-cost";
// Imported for its side effect: registering the posting rule before anything here
// can emit the event it handles, which is the convention `retail-invoice-service.ts`
// follows for `service-posting-rules`.
import "./agency-reimbursable-cost-posting";
import { AGENCY_INDUSTRY } from "./agency";
import { query, withTenantTransaction } from "./db";
import { getBusinessIndustry } from "./industry-guard";
import { postgresDateToIso } from "./jalali";
import { nextBusinessRegisterNumber } from "./register-numbering";
import { emitDomainEvent } from "./posting-engine";
import type { RialText } from "./inventory-exact";
import type { PoolClient } from "pg";

/**
 * Every refusal this service can make, as a closed list.
 *
 * So the route guard's status map can be exhaustive over it, and adding a refusal
 * here without deciding what a member should see is a compile error rather than a
 * silent 400.
 */
export const AGENCY_REIMBURSABLE_COST_ERROR_CODES = [
  "cost_not_found",
  "not_agency",
  "client_required",
  "description_required",
  "amount_required",
  "invalid_amount",
  "date_required",
  "invalid_date",
  "invalid_presentation",
  "invalid_settlement",
  "text_too_long",
  "cost_posted",
] as const;

export type AgencyReimbursableCostErrorCode = (typeof AGENCY_REIMBURSABLE_COST_ERROR_CODES)[number];

export class AgencyReimbursableCostError extends Error {
  constructor(readonly code: AgencyReimbursableCostErrorCode) {
    super(code);
  }
}

/** One recorded cost, with the names resolved and the accounting choice applied. */
export interface AgencyReimbursableCost {
  id: string;
  costNumber: string;
  partyId: string;
  clientName: string;
  projectId: string | null;
  projectName: string | null;
  vendorName: string;
  description: string;
  amountRial: number;
  spentOn: string;
  presentation: AgencyPassThroughPresentation;
  settledBy: AgencyCostSettlement;
  note: string;
  entryId: string | null;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** The ledger already carries it, so 0280 freezes it. Derived, never stored. */
  posted: boolean;
  /** The two accounts the entry landed in — read off the stored choice, not guessed. */
  accounts: { debitCode: string; creditCode: string };
  /** §D's question: is this the client's money rather than the agency's cost? */
  passThrough: boolean;
}

export interface AgencyReimbursableCostFilters {
  q?: string;
  partyId?: string | null;
  projectId?: string | null;
  presentation?: string | null;
  /** `true` for posted, `false` for the queue still awaiting an entry. */
  posted?: boolean | null;
  limit?: number;
}

const COST_COLUMNS = `c.id, c.cost_number, c.party_id, c.project_id, c.vendor_name,
       c.description, c.amount_rial, c.spent_on, c.presentation, c.settled_by,
       c.note, c.entry_id, c.created_by, c.created_by_name, c.created_at, c.updated_at`;

// Every join carries its own `business_id`: `withTenant` establishes the RLS scope
// but never injects one, and against the superuser test role a join without it is a
// cross-tenant read.
const COST_JOINS = `FROM agency_reimbursable_costs c
       JOIN parties p ON p.id = c.party_id AND p.business_id = c.business_id
  LEFT JOIN ai_projects pr ON pr.id = c.project_id AND pr.business_id = c.business_id`;

const COST_JOINED_COLUMNS = `p.name AS client_name, pr.name AS project_name`;

type CostRow = Record<string, unknown> & {
  id: string;
  cost_number: string;
  party_id: string;
  client_name: string | null;
  project_id: string | null;
  project_name: string | null;
  vendor_name: string;
  description: string;
  amount_rial: string | number;
  spent_on: Date | string;
  presentation: string;
  settled_by: string;
  note: string;
  entry_id: string | null;
  created_by: string | null;
  created_by_name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(value: Date | string): string {
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function toTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toCost(row: CostRow): AgencyReimbursableCost {
  // The vocabulary is validated on the way out as well as on the way in: a row whose
  // presentation is not one of the two would otherwise reach a screen that has no
  // label for it, and `reimbursableCostAccounts` has no answer for it.
  const presentation = isAgencyPassThroughPresentation(row.presentation)
    ? row.presentation
    : "net";
  const settledBy = isAgencyCostSettlement(row.settled_by) ? row.settled_by : "payable";
  return {
    id: row.id,
    costNumber: row.cost_number,
    partyId: row.party_id,
    clientName: row.client_name ?? "",
    projectId: row.project_id,
    projectName: row.project_name,
    vendorName: row.vendor_name ?? "",
    description: row.description,
    // bigint arrives as a string.
    amountRial: Number(row.amount_rial),
    // A `date` arrives as a JS Date at local midnight, so it is read from its local
    // parts rather than from `toISOString`, which would shift it a day.
    spentOn: toIso(row.spent_on),
    presentation,
    settledBy,
    note: row.note ?? "",
    entryId: row.entry_id,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    posted: isReimbursableCostPosted(row.entry_id),
    accounts: reimbursableCostAccounts({ presentation, settledBy }),
    passThrough: isPassThroughToClient(presentation),
  };
}

/**
 * The columns 0280 leaves writable on a row the ledger already carries.
 *
 * One entry, and a Set rather than an inline comparison so the rule is stated once
 * and can be read against the trigger's own list. `entry_id` is not here because a
 * member never writes it — the engine does, and the trigger exempts that separately.
 */
const POSTED_ROW_EDITABLE_COLUMNS: ReadonlySet<string> = new Set(["note"]);

async function assertAgency(businessId: string): Promise<void> {
  const industry = await getBusinessIndustry(businessId);
  if (industry !== AGENCY_INDUSTRY) throw new AgencyReimbursableCostError("not_agency");
}

/* ------------------------------------------------------------------------- */
/* Reads                                                                      */
/* ------------------------------------------------------------------------- */

export async function listAgencyReimbursableCosts(
  businessId: string,
  filters: AgencyReimbursableCostFilters = {},
): Promise<AgencyReimbursableCost[]> {
  const where: string[] = ["c.business_id = $1"];
  const params: unknown[] = [businessId];

  const q = filters.q?.trim();
  if (q) {
    params.push(`%${q}%`);
    const at = params.length;
    where.push(
      `(c.description ILIKE $${at} OR c.vendor_name ILIKE $${at} OR c.cost_number ILIKE $${at} OR p.name ILIKE $${at})`,
    );
  }
  if (filters.partyId) {
    params.push(filters.partyId);
    where.push(`c.party_id = $${params.length}`);
  }
  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`c.project_id = $${params.length}`);
  }
  // An unknown presentation filters nothing rather than matching nothing, so a stale
  // bookmark shows the list instead of an empty screen that reads as data loss.
  if (isAgencyPassThroughPresentation(filters.presentation)) {
    params.push(filters.presentation);
    where.push(`c.presentation = $${params.length}`);
  }
  if (filters.posted === true) where.push("c.entry_id IS NOT NULL");
  else if (filters.posted === false) where.push("c.entry_id IS NULL");

  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 200) || 200, 1), 500);
  params.push(limit);

  const { rows } = await query<CostRow>(
    `SELECT ${COST_COLUMNS}, ${COST_JOINED_COLUMNS}
       ${COST_JOINS}
      WHERE ${where.join(" AND ")}
      ORDER BY c.spent_on DESC, c.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toCost);
}

export async function loadAgencyReimbursableCost(
  businessId: string,
  id: string,
): Promise<AgencyReimbursableCost | null> {
  const { rows } = await query<CostRow>(
    `SELECT ${COST_COLUMNS}, ${COST_JOINED_COLUMNS}
       ${COST_JOINS}
      WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, id],
  );
  const row = rows[0];
  return row ? toCost(row) : null;
}

/**
 * What each of a group's brands is owed back, in one grouped read.
 *
 * The two figures are different questions and both are asked: `total` is everything
 * spent for that client, `passThrough` is the part that is *the client's money* —
 * §D's distinction, and the one a margin report has to be able to make without
 * re-deriving which account a row landed in.
 */
export interface CostTotalsByParty {
  total: number;
  passThrough: number;
  unposted: number;
}

export async function sumCostsByParty(
  businessId: string,
  partyIds: string[],
): Promise<Map<string, CostTotalsByParty>> {
  const out = new Map<string, CostTotalsByParty>();
  if (partyIds.length === 0) return out;
  const { rows } = await query<Record<string, unknown> & {
    party_id: string;
    total: string | number;
    pass_through: string | number;
    unposted: string | number;
  }>(
    `SELECT party_id,
            COALESCE(sum(amount_rial), 0)::bigint AS total,
            COALESCE(sum(amount_rial) FILTER (WHERE presentation = 'net'), 0)::bigint AS pass_through,
            count(*) FILTER (WHERE entry_id IS NULL)::int AS unposted
       FROM agency_reimbursable_costs
      WHERE business_id = $1 AND party_id = ANY($2::uuid[])
      GROUP BY party_id`,
    [businessId, partyIds],
  );
  for (const row of rows) {
    out.set(row.party_id, {
      total: Number(row.total),
      passThrough: Number(row.pass_through),
      unposted: Number(row.unposted),
    });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Writes                                                                     */
/* ------------------------------------------------------------------------- */

export interface ReimbursableCostInput {
  partyId?: unknown;
  projectId?: unknown;
  vendorName?: unknown;
  description?: unknown;
  amountRial?: unknown;
  spentOn?: unknown;
  presentation?: unknown;
  settledBy?: unknown;
  note?: unknown;
}

function normalizeVendorName(input: ReimbursableCostInput): string {
  const text = normalizeAgencyCostOptionalText(input.vendorName, AGENCY_COST_VENDOR_NAME_LIMIT);
  if (text.tooLong) throw new AgencyReimbursableCostError("text_too_long");
  return text.value;
}

/**
 * Record a cost, and post it, in one transaction.
 *
 * The number is chosen inside the transaction under the register's advisory lock so
 * two members recording a platform charge at the same moment cannot be handed the
 * same one. The entry is emitted against the transaction's own client, so the row and
 * its ledger document commit together or neither does.
 */
export async function createAgencyReimbursableCost(
  businessId: string,
  actor: { userId: string; name: string },
  input: ReimbursableCostInput,
): Promise<AgencyReimbursableCost> {
  await assertAgency(businessId);

  const partyId = typeof input.partyId === "string" ? input.partyId.trim() : "";
  if (!partyId) throw new AgencyReimbursableCostError("client_required");

  const description = normalizeAgencyCostText(input.description, AGENCY_COST_DESCRIPTION_LIMIT);
  if (description.tooLong) throw new AgencyReimbursableCostError("text_too_long");
  if (!description.present) throw new AgencyReimbursableCostError("description_required");

  const note = normalizeAgencyCostOptionalText(input.note, AGENCY_COST_NOTE_LIMIT);
  if (note.tooLong) throw new AgencyReimbursableCostError("text_too_long");

  const amount = normalizeAgencyCostAmount(input.amountRial);
  if (input.amountRial === undefined || input.amountRial === null || input.amountRial === "") {
    throw new AgencyReimbursableCostError("amount_required");
  }
  // Distinguished from `amount_required` on purpose: a member who typed 1000.5 or
  // -5 needs to hear that the figure is unusable, not that it is missing. The bound
  // is inside the normaliser, so it is not checked twice here.
  if (amount === null) throw new AgencyReimbursableCostError("invalid_amount");

  const spentOn = normalizeAgencyCostDate(input.spentOn);
  if (input.spentOn === undefined || input.spentOn === null || input.spentOn === "") {
    throw new AgencyReimbursableCostError("date_required");
  }
  if (spentOn === null) throw new AgencyReimbursableCostError("invalid_date");

  const presentation = input.presentation === undefined || input.presentation === null || input.presentation === ""
    ? "net"
    : input.presentation;
  if (!isAgencyPassThroughPresentation(presentation)) {
    throw new AgencyReimbursableCostError("invalid_presentation");
  }
  const settledBy = input.settledBy === undefined || input.settledBy === null || input.settledBy === ""
    ? "payable"
    : input.settledBy;
  if (!isAgencyCostSettlement(settledBy)) {
    throw new AgencyReimbursableCostError("invalid_settlement");
  }

  const projectId = typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;

  return withTenantTransaction(businessId, async (client: PoolClient) => {
    // `nextBusinessRegisterNumber` returns the formatted number (`RC-001`) and takes
    // the advisory lock itself, so two costs recorded at once cannot be handed the
    // same one. The shared formatter pads to three digits — the same reason a
    // campaign is `CA-001` and not `CA-0001`.
    const costNumber = await nextBusinessRegisterNumber(
      "agency_reimbursable_costs",
      businessId,
      COST_NUMBER_PREFIX,
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO agency_reimbursable_costs
         (business_id, cost_number, party_id, project_id, vendor_name, description,
          amount_rial, spent_on, presentation, settled_by, note, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        businessId, costNumber, partyId, projectId, normalizeVendorName(input), description.value,
        amount, spentOn, presentation, settledBy, note.value, actor.userId, actor.name,
      ],
    );
    const inserted = rows[0];
    if (!inserted) throw new AgencyReimbursableCostError("cost_not_found");

    const { entryId } = await emitDomainEvent(client, {
      businessId,
      eventType: "agency.reimbursable_cost",
      payload: {
        amount: String(amount) as RialText,
        presentation,
        settledBy,
        spentOn,
        projectId,
      },
      sourceType: "agency_reimbursable_cost",
      sourceId: inserted.id,
      createdBy: actor.userId,
    });

    // The engine may route the entry to the human-approval queue instead of posting
    // it — a locked fiscal period does not stop a real spend being recognised — so a
    // null entry id is a state, not a failure, and the row stays in the queue.
    if (entryId) {
      await query(`UPDATE agency_reimbursable_costs SET entry_id = $2
                    WHERE business_id = $1 AND id = $3`, [businessId, entryId, inserted.id]);
    }

    const cost = await loadAgencyReimbursableCost(businessId, inserted.id);
    if (!cost) throw new AgencyReimbursableCostError("cost_not_found");
    return cost;
  });
}

/**
 * Correct a cost, within what the ledger allows.
 *
 * An unposted row is ordinary editable. A **posted** row is frozen except for `note`,
 * and that exception is 0280's rather than this function's: the columns the entry was
 * built from — amount, presentation, settlement, client, project, day, description,
 * vendor — decide which two accounts the money landed in, so editing one would leave
 * the register stating something the ledger contradicts. What a member learned
 * *afterwards* desyncs nothing, so the note stays open; refusing it would be a freeze
 * wider than the reason for freezing.
 *
 * This check exists so the member is told in words rather than by a SQLSTATE. It is
 * deliberately the same shape as the trigger's, because a service and a schema that
 * each look self-consistent and disagree are only caught by an integration test —
 * which is what caught this one.
 *
 * Takes no row lock: the read is here to answer in words and to merge an empty patch
 * into a no-op, but the authority on a posted row is the trigger inside the write.
 */
export async function updateAgencyReimbursableCost(
  businessId: string,
  id: string,
  _actor: { userId: string; name: string },
  input: ReimbursableCostInput,
): Promise<AgencyReimbursableCost> {
  await assertAgency(businessId);

  const existing = await loadAgencyReimbursableCost(businessId, id);
  if (!existing) throw new AgencyReimbursableCostError("cost_not_found");

  const sets: string[] = [];
  const touched: string[] = [];
  const params: unknown[] = [businessId, id];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
    touched.push(column);
  };

  if (input.description !== undefined) {
    const description = normalizeAgencyCostText(input.description, AGENCY_COST_DESCRIPTION_LIMIT);
    if (description.tooLong) throw new AgencyReimbursableCostError("text_too_long");
    if (!description.present) throw new AgencyReimbursableCostError("description_required");
    add("description", description.value);
  }
  if (input.vendorName !== undefined) add("vendor_name", normalizeVendorName(input));
  if (input.note !== undefined) {
    const note = normalizeAgencyCostOptionalText(input.note, AGENCY_COST_NOTE_LIMIT);
    if (note.tooLong) throw new AgencyReimbursableCostError("text_too_long");
    add("note", note.value);
  }
  if (input.amountRial !== undefined) {
    const amount = normalizeAgencyCostAmount(input.amountRial);
    if (amount === null) throw new AgencyReimbursableCostError("invalid_amount");
    add("amount_rial", amount);
  }
  if (input.spentOn !== undefined) {
    const spentOn = normalizeAgencyCostDate(input.spentOn);
    if (spentOn === null) throw new AgencyReimbursableCostError("invalid_date");
    add("spent_on", spentOn);
  }
  if (input.presentation !== undefined) {
    if (!isAgencyPassThroughPresentation(input.presentation)) {
      throw new AgencyReimbursableCostError("invalid_presentation");
    }
    add("presentation", input.presentation);
  }
  if (input.settledBy !== undefined) {
    if (!isAgencyCostSettlement(input.settledBy)) {
      throw new AgencyReimbursableCostError("invalid_settlement");
    }
    add("settled_by", input.settledBy);
  }
  if (input.partyId !== undefined) {
    const partyId = typeof input.partyId === "string" ? input.partyId.trim() : "";
    if (!partyId) throw new AgencyReimbursableCostError("client_required");
    add("party_id", partyId);
  }
  if (input.projectId !== undefined) {
    add("project_id", typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null);
  }

  // An empty patch is a no-op returning the row, not a `cost_not_found`: a form that
  // saved without changing anything should say so by showing the row it has.
  if (sets.length === 0) return existing;

  // Checked after the patch is built rather than before, so the refusal can be about
  // what this request actually touches: a note on a posted cost is allowed, and
  // anything else on it is not.
  if (existing.posted && touched.some((column) => !POSTED_ROW_EDITABLE_COLUMNS.has(column))) {
    throw new AgencyReimbursableCostError("cost_posted");
  }

  await query(
    `UPDATE agency_reimbursable_costs SET ${sets.join(", ")} WHERE business_id = $1 AND id = $2`,
    params,
  );
  const updated = await loadAgencyReimbursableCost(businessId, id);
  if (!updated) throw new AgencyReimbursableCostError("cost_not_found");
  return updated;
}

/**
 * Delete a cost that never posted.
 *
 * A posted one is refused by 0280 as well as here, and the refusal is the point: the
 * entry exists in the ledger, so deleting the row would leave an entry with no source
 * document and a register that no longer explains its own account balance.
 */
export async function deleteAgencyReimbursableCost(
  businessId: string,
  id: string,
): Promise<void> {
  await assertAgency(businessId);
  const existing = await loadAgencyReimbursableCost(businessId, id);
  if (!existing) throw new AgencyReimbursableCostError("cost_not_found");
  if (existing.posted) throw new AgencyReimbursableCostError("cost_posted");
  await query(`DELETE FROM agency_reimbursable_costs WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
}

export { AGENCY_PASS_THROUGH_PRESENTATIONS, AGENCY_COST_SETTLEMENTS };
