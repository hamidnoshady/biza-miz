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
import { businessToday } from "./business-day-service";
import { SETTING_KEYS, getSetting, setSetting } from "./settings";
import {
  AGENCY_DEFAULT_PRESENTATION,
  isCostRecharged,
  parseAgencyCostPolicySetting,
  type AgencyCostPolicySetting,
} from "./agency-reimbursable-cost";
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
import {
  PASS_THROUGH_DEFAULT_VAT_PERCENT,
  SERVICE_DESCRIPTION_MAX_LENGTH,
} from "./service-invoice";
import { resolveActiveLocationForUser } from "./setup-state";
import {
  createRetailInvoice,
  type CreateRetailInvoiceTenderInput,
} from "./retail-invoice-service";
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
  // Recharging — the act that credits 1270 and asks the client for the money.
  "recharge_empty",
  "invalid_cost_id",
  "cost_not_found_for_recharge",
  "cost_already_recharged",
  "cost_not_posted",
  "costs_from_different_clients",
  "location_required",
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
  /** The invoice that billed this back, if there is one — voided or not. */
  rechargedOrderId: string | null;
  rechargedBy: string | null;
  rechargedByName: string;
  /**
   * Whether that invoice still counts, derived from its live status rather than
   * stored: voiding flips `orders.status` and writes a reversing entry without
   * touching this register, so a stored flag would be a second answer that disagrees
   * with the ledger the first time somebody voided an invoice.
   */
  recharged: boolean;
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
       c.note, c.entry_id, c.created_by, c.created_by_name, c.created_at, c.updated_at,
       c.recharged_order_id, c.recharged_by, c.recharged_by_name`;

// Every join carries its own `business_id`: `withTenant` establishes the RLS scope
// but never injects one, and against the superuser test role a join without it is a
// cross-tenant read.
const COST_JOINS = `FROM agency_reimbursable_costs c
       JOIN parties p ON p.id = c.party_id AND p.business_id = c.business_id
  LEFT JOIN ai_projects pr ON pr.id = c.project_id AND pr.business_id = c.business_id
  LEFT JOIN orders ro ON ro.id = c.recharged_order_id`;

// `ro.status` is read so `recharged` can be *derived* rather than stored: voiding an
// invoice flips the order and writes a reversing entry without touching this register,
// so a stored flag would disagree with the ledger the first time somebody voided one.
const COST_JOINED_COLUMNS = `p.name AS client_name, pr.name AS project_name, ro.status AS recharged_order_status`;

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
  recharged_order_id: string | null;
  recharged_by: string | null;
  recharged_by_name: string;
  recharged_order_status: string | null;
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
    rechargedOrderId: row.recharged_order_id,
    rechargedBy: row.recharged_by,
    rechargedByName: row.recharged_by_name ?? "",
    recharged: isCostRecharged({
      rechargedOrderId: row.recharged_order_id,
      orderStatus: row.recharged_order_status,
    }),
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
  /** Not yet billed back, which is what the client still owes. */
  unrechargedRial: number;
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
    unrecharged: string | number;
  }>(
    `SELECT c.party_id,
            COALESCE(sum(c.amount_rial), 0)::bigint AS total,
            COALESCE(sum(c.amount_rial) FILTER (WHERE c.presentation = 'net'), 0)::bigint AS pass_through,
            count(*) FILTER (WHERE c.entry_id IS NULL)::int AS unposted,
            -- The outstanding claim, computed the same way the row's own flag is: a
            -- link to a voided invoice does not count, so voiding puts the money back
            -- into what the client owes without anything being written here.
            -- orders.status is an enum, so a missing order is handled with IS NULL
            -- rather than by comparing it to an empty string, which is not one of its
            -- values and would raise instead of reading as "not recharged".
            COALESCE(sum(c.amount_rial) FILTER (
              WHERE NOT (c.recharged_order_id IS NOT NULL
                         AND ro.status IS NOT NULL
                         AND ro.status <> 'voided')
            ), 0)::bigint AS unrecharged
       FROM agency_reimbursable_costs c
  LEFT JOIN orders ro ON ro.id = c.recharged_order_id
      WHERE c.business_id = $1 AND c.party_id = ANY($2::uuid[])
      GROUP BY c.party_id`,
    [businessId, partyIds],
  );
  for (const row of rows) {
    out.set(row.party_id, {
      total: Number(row.total),
      passThrough: Number(row.pass_through),
      unposted: Number(row.unposted),
      unrechargedRial: Number(row.unrecharged),
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

  // §D: the treatment follows the business's *chosen* policy, and is never inferred
  // from the row. Absent an explicit choice on this cost, the policy answers; absent
  // a policy, the documented fallback does. An explicit choice always wins, and an
  // explicit *garbage* choice is still refused rather than quietly replaced by the
  // policy — otherwise a typo would change which account the money lands in.
  const presentation =
    input.presentation === undefined || input.presentation === null || input.presentation === ""
      ? await resolveAgencyCostPresentation(businessId)
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

/* ------------------------------------------------------------------------- */
/* The recharge — the act that credits 1270                                   */
/* ------------------------------------------------------------------------- */

export interface AgencyRechargeInput {
  /** The costs to bill back. One invoice line each; they must share a client. */
  costIds: unknown;
  /** How the client pays. Defaults to on account, because a recharge is usually owed. */
  tenders?: CreateRetailInvoiceTenderInput[];
  locationId?: string | null;
  note?: unknown;
}

export interface AgencyRechargeResult {
  orderId: string;
  orderNumber: number;
  /** The costs the invoice now stands behind, in the order they were given. */
  rechargedCostIds: string[];
  totalRial: number;
}

/**
 * Bill a client back for money the agency spent on their behalf.
 *
 * One invoice, one pass-through line per cost, each crediting **1270** rather than a
 * revenue account — which is the whole of §D's net presentation on the recharge side,
 * and the reason 0280 had to exist first: crediting an asset nothing ever debited
 * would drive it past zero and report a *negative* claim on the client.
 *
 * The invoice and the marks on the cost rows are written in one transaction, so a
 * recharge cannot half-happen: either the client is billed and every cost points at
 * that invoice, or neither does. That matters more here than for an ordinary sale,
 * because the failure mode of a half-written recharge is billing the same media buy
 * twice.
 *
 * Three refusals are the point of this function rather than incidental validation:
 *
 *   * **already recharged** — 0284 refuses it at the trigger too, but a member is
 *     told in words first, and the words say which invoice to void;
 *   * **not posted** — a cost whose own entry has not landed has not debited 1270 yet,
 *     so crediting it would clear a balance that was never there;
 *   * **different clients** — one invoice bills one client, and `orders.customer_id`
 *     is a single party. Costs from two clients are two recharges.
 */
export async function rechargeAgencyCosts(
  businessId: string,
  actor: { userId: string; name: string },
  input: AgencyRechargeInput,
): Promise<AgencyRechargeResult> {
  await assertAgency(businessId);

  const rawIds = Array.isArray(input.costIds) ? input.costIds : [];
  const costIds = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()))];
  if (costIds.length === 0) throw new AgencyReimbursableCostError("recharge_empty");
  if (rawIds.length !== costIds.length && new Set(rawIds).size === costIds.length) {
    // Duplicates of a real id are collapsed rather than refused: asking for the same
    // cost twice in one request is one recharge, not an error worth a round trip.
  } else if (rawIds.some((id) => typeof id !== "string" || (id as string).trim().length === 0)) {
    throw new AgencyReimbursableCostError("invalid_cost_id");
  }

  // Read the costs *with* the invoice status that decides whether each counts as
  // recharged, in one query — the derived flag of `isCostRecharged` needs both halves
  // and reading them separately would be a race against somebody voiding an invoice.
  const { rows } = await query<Record<string, unknown> & {
    id: string;
    cost_number: string;
    party_id: string;
    project_id: string | null;
    description: string;
    vendor_name: string;
    amount_rial: string | number;
    entry_id: string | null;
    recharged_order_id: string | null;
    order_status: string | null;
  }>(
    `SELECT c.id, c.cost_number, c.party_id, c.project_id, c.description, c.vendor_name,
            c.amount_rial, c.entry_id, c.recharged_order_id, o.status AS order_status
       FROM agency_reimbursable_costs c
  LEFT JOIN orders o ON o.id = c.recharged_order_id
      WHERE c.business_id = $1 AND c.id = ANY($2::uuid[])`,
    [businessId, costIds],
  );
  if (rows.length !== costIds.length) {
    throw new AgencyReimbursableCostError("cost_not_found_for_recharge");
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const selected = costIds.map((id) => byId.get(id)!);

  for (const row of selected) {
    if (isReimbursableCostPosted(row.entry_id) === false) {
      throw new AgencyReimbursableCostError("cost_not_posted");
    }
    if (isCostRecharged({ rechargedOrderId: row.recharged_order_id, orderStatus: row.order_status })) {
      throw new AgencyReimbursableCostError("cost_already_recharged");
    }
  }
  const clients = new Set(selected.map((row) => row.party_id));
  if (clients.size !== 1) throw new AgencyReimbursableCostError("costs_from_different_clients");
  const partyId = selected[0].party_id;

  // One invoice can only carry one project dimension, so it is tagged when every cost
  // agrees and left untagged when they do not. Guessing one of several would put the
  // whole recharge in a single project's P&L and quietly take it out of the others'.
  const projects = new Set(selected.map((row) => row.project_id));
  const projectId = projects.size === 1 ? [...projects][0] : null;

  const locationId =
    (typeof input.locationId === "string" && input.locationId.trim() ? input.locationId.trim() : null) ??
    (await resolveActiveLocationForUser(businessId, actor.userId))?.id ??
    null;
  if (!locationId) throw new AgencyReimbursableCostError("location_required");

  const totalRial = selected.reduce((sum, row) => sum + Number(row.amount_rial), 0);
  const note = normalizeAgencyCostOptionalText(input.note, AGENCY_COST_NOTE_LIMIT);
  if (note.tooLong) throw new AgencyReimbursableCostError("text_too_long");

  const tenders: CreateRetailInvoiceTenderInput[] =
    input.tenders && input.tenders.length > 0 ? input.tenders : [{ method: "credit" }];

  return withTenantTransaction(businessId, async (client: PoolClient) => {
    const invoice = await createRetailInvoice(client, {
      businessId,
      locationId,
      industry: AGENCY_INDUSTRY,
      lines: selected.map((row) => ({
        kind: "service" as const,
        // The agency's own cost number leads, so the client's invoice points back at
        // the record the agency holds and a disputed line can be found in one step.
        // Truncated to the service line's own limit rather than the cost's, because
        // the two differ and this is the one that is printed.
        description: `${row.cost_number} — ${row.description}`.slice(0, SERVICE_DESCRIPTION_MAX_LENGTH),
        quantity: "1",
        unitPrice: Number(row.amount_rial),
        // Zero by default, and a member may say otherwise: whether recovering a
        // disbursement is a taxable supply depends on the jurisdiction and the
        // contract, and software that picked one would be asserting a tax position it
        // cannot know. Zero is the conservative direction — it cannot create a
        // liability the business does not owe.
        vatPercent: PASS_THROUGH_DEFAULT_VAT_PERCENT,
        passThrough: true,
      })),
      tenders,
      // `orders.customer_id` references `parties`, so the cost's client *is* the
      // invoice's customer and no mapping is needed or wanted.
      customerId: partyId,
      note: note.value || `بازدریافت ${selected.length} هزینهٔ کارفرما`,
      businessDate: await businessToday(businessId),
      createdBy: actor.userId,
      projectId,
    });

    // Marking the rows is what stops the same media buy being billed twice, and it
    // happens in the same transaction as the invoice so a recharge cannot half-happen.
    for (const row of selected) {
      await query(
        `UPDATE agency_reimbursable_costs
            SET recharged_order_id = $2, recharged_by = $3, recharged_by_name = $4
          WHERE business_id = $1 AND id = $5`,
        [businessId, invoice.orderId, actor.userId, actor.name, row.id],
      );
    }

    return {
      orderId: invoice.orderId,
      orderNumber: invoice.orderNumber,
      rechargedCostIds: selected.map((row) => row.id),
      totalRial,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* §D's business-level presentation policy                                     */
/* ------------------------------------------------------------------------- */

export interface AgencyCostPolicyState {
  /** The presentation new reimbursable costs default to. */
  presentation: AgencyPassThroughPresentation;
  /**
   * Whether a human actually chose it. `false` means `presentation` is the
   * documented fallback, and a screen must say «هنوز انتخاب نشده» rather than show
   * a default as though it were a decision — the difference between a policy the
   * business adopted and one the software supplied.
   */
  stored: boolean;
  updatedAt: string | null;
}

const UNSTORED_POLICY: AgencyCostPolicyState = {
  presentation: AGENCY_DEFAULT_PRESENTATION,
  stored: false,
  updatedAt: null,
};

/**
 * The presentation a new cost falls back to: the business's stored policy, or the
 * documented default while it has none.
 *
 * Kept private and separate from `loadAgencyCostPolicy` because the create path
 * must never throw `not_agency` from a policy read — `createAgencyReimbursableCost`
 * has already asserted the industry by the time it gets here, and a second
 * assertion would be a second query answering a question already settled.
 */
async function resolveAgencyCostPresentation(
  businessId: string,
): Promise<AgencyPassThroughPresentation> {
  const stored = parseAgencyCostPolicySetting(
    await getSetting<unknown>(businessId, SETTING_KEYS.agencyCostPolicy),
  );
  return stored ? stored.presentation : AGENCY_DEFAULT_PRESENTATION;
}

/** What «تنظیمات» shows for this register: the policy, and whether it was chosen. */
export async function loadAgencyCostPolicy(businessId: string): Promise<AgencyCostPolicyState> {
  await assertAgency(businessId);
  const stored = parseAgencyCostPolicySetting(
    await getSetting<unknown>(businessId, SETTING_KEYS.agencyCostPolicy),
  );
  return stored ? { ...stored, stored: true } : UNSTORED_POLICY;
}

/**
 * Choose the business's presentation policy.
 *
 * Writes the setting and its audit row in one transaction, because this is the one
 * agency setting that moves money: it decides whether a client's media buy debits
 * 1270 (a claim on the client) or 5197 (the agency's own cost of sale), so "who
 * changed it, from what, to what, and when" has to have an answer.
 *
 * **The policy is a default for new costs and is never retroactive.** Changing it
 * does not touch a single existing row, and cannot: 0280's trigger freezes
 * `presentation` on any cost whose entry has landed, because the value decided which
 * two accounts that entry used and the register may not contradict the ledger. The
 * correction for a cost recorded under the wrong treatment is a reversal and a new
 * record, not a policy change reaching backwards.
 *
 * A member's explicit choice on a row still beats the policy, which is the point of
 * storing a policy rather than a mandate: §D's treatment varies by contract, and a
 * business that mostly buys media in a client's name may still buy some in its own.
 */
export async function saveAgencyCostPolicy(
  actor: { businessId: string; locationId?: string | null; userId?: string | null; name?: string | null },
  body: unknown,
): Promise<AgencyCostPolicyState> {
  await assertAgency(actor.businessId);

  const current = await loadAgencyCostPolicy(actor.businessId);
  const saved = normalizeCostPolicyBody(body, current);
  if (!saved) throw new AgencyReimbursableCostError("invalid_presentation");

  const before = { presentation: current.presentation, stored: current.stored };
  const value: AgencyCostPolicySetting = { presentation: saved.presentation, updatedAt: saved.updatedAt };
  await withTenantTransaction(
    actor.businessId,
    async () => {
      await setSetting(actor.businessId, SETTING_KEYS.agencyCostPolicy, value);
      await query(
        `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
         VALUES ($1,$2,$3,'settings.agency_cost_policy.update','settings',$4,$5::jsonb)`,
        [
          actor.businessId,
          actor.locationId ?? null,
          actor.userId ?? null,
          SETTING_KEYS.agencyCostPolicy,
          JSON.stringify({ before, after: value }),
        ],
      );
    },
    { locationId: actor.locationId ?? undefined, userId: actor.userId ?? undefined },
  );
  return { ...value, stored: true };
}

/**
 * Pure: the policy a save request asks for, or null when the request is not one.
 * An omitted `presentation` keeps the current choice, so a client may re-save
 * without restating it; an unrecognised one is a refusal rather than a default.
 *
 * Unknown keys are refused outright, mirroring the operating-profile save: a body
 * carrying a field this code does not know is a body written against a newer
 * contract, and storing half of it would silently drop the half that mattered.
 */
function normalizeCostPolicyBody(
  body: unknown,
  current: AgencyCostPolicyState,
): { presentation: AgencyPassThroughPresentation; updatedAt: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "presentation")) return null;
  const parsed = parseAgencyCostPolicySetting({
    presentation: raw.presentation === undefined ? current.presentation : raw.presentation,
    updatedAt: null,
  });
  if (!parsed) return null;
  return { presentation: parsed.presentation, updatedAt: new Date().toISOString() };
}

export { AGENCY_PASS_THROUGH_PRESENTATIONS, AGENCY_COST_SETTLEMENTS };
