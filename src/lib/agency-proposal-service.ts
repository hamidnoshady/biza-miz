/**
 * §A's proposals — the half that talks to Postgres.
 *
 * Split from `agency-proposal.ts` for the reason the brief and media-review
 * services are split: that module is imported by a client component, and this one
 * imports `pg`. A panel that reached through this file would drag the driver into
 * the browser bundle.
 *
 * Three rules this file follows everywhere, the first two learned on §E and the
 * third specific to an offer:
 *
 *   * **Every statement carries its own `business_id` predicate**, including
 *     inside every `LEFT JOIN`. `withTenant` establishes the RLS scope and does
 *     not rewrite SQL, so under a superuser role — which is what the integration
 *     harness and any maintenance script connect as — a join on id alone would
 *     resolve another tenant's client into this proposal's name.
 *   * **A PATCH that says nothing about a field leaves it alone.** `"x" in patch`
 *     rather than `patch.x ?? current`, because collapsing absent and null would
 *     let a caller who omitted `discountRial` silently delete a discount.
 *   * **The header and its lines are written in one transaction.** An offer is one
 *     statement about a price; a half-written one — header committed, lines
 *     refused — is a quote for nothing at a figure nobody agreed to.
 *
 * What this service refuses and what migration `0276` refuses overlap on purpose.
 * The service answers in Persian, early, with the field named; the database
 * answers with a `23514` if something gets past it. Two rules exist *only* here,
 * because neither is expressible as a CHECK: a discount larger than the subtotal
 * it discounts compares two rows' figures, and accepting a lapsed offer needs the
 * current date. Both are documented at the point they are enforced.
 */

import { query, withTenantTransaction } from "./db";
import { postgresDateToIso } from "./jalali";
import { nextBusinessRegisterNumber } from "./register-numbering";
import {
  AGENCY_PROPOSAL_NAME_MAX_LENGTH,
  AGENCY_PROPOSAL_SCOPE_MAX_LENGTH,
  AGENCY_PROPOSAL_TERMS_MAX_LENGTH,
  AGENCY_PROPOSAL_TITLE_MAX_LENGTH,
  AGENCY_PROPOSAL_TAX_MAX,
  PROPOSAL_NUMBER_PREFIX,
  agencyProposalActionBlocked,
  agencyProposalActionTarget,
  agencyProposalActionsFrom,
  agencyProposalDecisionNeedsName,
  agencyProposalClientView,
  agencyProposalDiscountAllowed,
  agencyProposalLineAmountRial,
  agencyProposalMargin,
  canPerformAgencyProposalAction,
  isAgencyProposalAction,
  isAgencyProposalDeletable,
  isAgencyProposalEditable,
  isAgencyProposalFrozen,
  isAgencyProposalLapsed,
  isAgencyProposalStatus,
  normalizeAgencyProposalDate,
  normalizeAgencyProposalLines,
  normalizeAgencyProposalRial,
  normalizeAgencyProposalText,
  type AgencyProposalAction,
  type AgencyProposalClientView,
  type AgencyProposalLine,
  type AgencyProposalLineInput,
  type AgencyProposalMargin,
  type AgencyProposalStatus,
  type AgencyProposalTotals,
  agencyProposalTotals,
} from "./agency-proposal";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const AGENCY_PROPOSAL_ERROR_CODES = [
  "proposal_not_found",
  "client_required",
  "title_required",
  "lines_required",
  "invalid_line",
  "invalid_discount",
  "invalid_date",
  "invalid_reference",
  "text_too_long",
  "decider_required",
  "invalid_action",
  "invalid_transition",
  "proposal_frozen",
  "proposal_lapsed",
  "proposal_not_deletable",
] as const;

export type AgencyProposalErrorCode = (typeof AGENCY_PROPOSAL_ERROR_CODES)[number];

export class AgencyProposalError extends Error {
  constructor(
    readonly code: AgencyProposalErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AgencyProposalError";
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Who is writing. The member's name is snapshotted, as 0260's registers do. */
export interface AgencyProposalActor {
  userId?: string | null;
  name?: string | null;
}

/**
 * A proposal as the CRM hands it over — the *internal* shape.
 *
 * It carries `margin` and every line's cost, and it is what the member-facing
 * screen reads. It is not what a client reads: `agencyProposalClientView` in the
 * pure module is the only shape that may cross that line, and it cannot name a
 * cost.
 *
 * `totals` and `margin` are computed on every read rather than stored, which is
 * why they can never disagree with the lines. `lapsed` is likewise computed, and
 * is a different fact from `status === "expired"`: the status is a decision
 * somebody recorded, lapsing is true the moment the date passes.
 */
export interface AgencyProposal {
  id: string;
  proposalNumber: string;
  partyId: string;
  partyName: string;
  briefId: string | null;
  briefNumber: string | null;
  briefTitle: string | null;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  contractId: string | null;
  contractTitle: string | null;
  title: string;
  status: AgencyProposalStatus;
  scopeOfWork: string;
  terms: string;
  discountRial: number;
  taxRial: number;
  validUntil: string | null;
  clientContactPartyId: string | null;
  clientContactName: string;
  sentAt: string | null;
  decidedAt: string | null;
  decidedByName: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  lines: AgencyProposalLine[];
  totals: AgencyProposalTotals;
  margin: AgencyProposalMargin;
  lapsed: boolean;
  actions: AgencyProposalAction[];
  frozen: boolean;
  editable: boolean;
}

export interface AgencyProposalListFilters {
  partyId?: string;
  briefId?: string;
  dealId?: string;
  projectId?: string;
  contractId?: string;
  status?: AgencyProposalStatus;
  openOnly?: boolean;
  /** Only offers whose validity date has already passed. */
  lapsedOnly?: boolean;
  q?: string;
  limit?: number;
}

/** A create or a PATCH. Every field optional; presence is what a PATCH means. */
export interface AgencyProposalInput {
  partyId?: unknown;
  briefId?: unknown;
  dealId?: unknown;
  projectId?: unknown;
  contractId?: unknown;
  title?: unknown;
  scopeOfWork?: unknown;
  terms?: unknown;
  discountRial?: unknown;
  taxRial?: unknown;
  validUntil?: unknown;
  clientContactPartyId?: unknown;
  clientContactName?: unknown;
  lines?: unknown;
}

// A `type`, not an `interface`: `query<T>` constrains `T` to
// `Record<string, unknown>`, which an interface does not satisfy.
type ProposalRow = {
  id: string;
  proposal_number: string;
  party_id: string;
  party_name: string | null;
  brief_id: string | null;
  brief_number: string | null;
  brief_title: string | null;
  deal_id: string | null;
  deal_title: string | null;
  project_id: string | null;
  project_name: string | null;
  contract_id: string | null;
  contract_title: string | null;
  title: string;
  status: string;
  scope_of_work: string;
  terms: string;
  discount_rial: string | number;
  tax_rial: string | number;
  valid_until: Date | string | null;
  client_contact_party_id: string | null;
  client_contact_name: string;
  sent_at: Date | string | null;
  decided_at: Date | string | null;
  decided_by_name: string;
  created_by_name: string;
  created_at: Date | string;
  updated_at: Date | string;
  /** Only the list selects these five; a single read carries its own lines. */
  subtotal_rial?: string | number | null;
  cost_rial?: string | number | null;
  pass_through_rial?: string | number | null;
  costed_line_count?: string | number | null;
  line_count?: string | number | null;
};

type LineRow = {
  id: string;
  line_number: string | number;
  description: string;
  quantity: string | number;
  unit_price_rial: string | number;
  amount_rial: string | number;
  revenue_code: string;
  cost_rial: string | number | null;
  pass_through: boolean;
  note: string;
};

/** The columns every read selects. */
const PROPOSAL_COLUMNS = `
         p.id, p.proposal_number, p.party_id, c.name AS party_name,
         p.brief_id, b.brief_number, b.title AS brief_title,
         p.deal_id, d.title AS deal_title,
         p.project_id, pr.name AS project_name,
         p.contract_id, w.title AS contract_title,
         p.title, p.status, p.scope_of_work, p.terms,
         p.discount_rial, p.tax_rial, p.valid_until,
         p.client_contact_party_id, p.client_contact_name,
         p.sent_at, p.decided_at, p.decided_by_name, p.created_by_name,
         p.created_at, p.updated_at`;

/**
 * The six names a proposal is read by.
 *
 * Each join is `LEFT` and filtered on `business_id` as well as on id: joining a
 * party by id alone would resolve another tenant's client into this proposal's
 * name, which is the leak the predicate exists to prevent.
 */
const PROPOSAL_JOINS = `
    FROM agency_proposals p
    LEFT JOIN parties c
           ON c.id = p.party_id AND c.business_id = p.business_id
    LEFT JOIN agency_client_briefs b
           ON b.id = p.brief_id AND b.business_id = p.business_id
    LEFT JOIN crm_deals d
           ON d.id = p.deal_id AND d.business_id = p.business_id
    LEFT JOIN ai_projects pr
           ON pr.id = p.project_id AND pr.business_id = p.business_id
    LEFT JOIN workspace_contracts w
           ON w.id = p.contract_id AND w.business_id = p.business_id
    LEFT JOIN parties cc
           ON cc.id = p.client_contact_party_id AND cc.business_id = p.business_id`;

const PROPOSAL_SELECT = `SELECT ${PROPOSAL_COLUMNS} ${PROPOSAL_JOINS}`;

/**
 * The same read, plus the five figures a list shows, from ONE lateral aggregate.
 *
 * A lateral join rather than five correlated subqueries because they all describe
 * the same set of rows: five subqueries would scan each offer's lines five times
 * to produce five numbers about one thing.
 *
 * The aggregate carries its own `business_id` predicate. It is a subquery, and the
 * rule about predicates applies inside one exactly as it applies outside: summing
 * another tenant's lines into this offer's subtotal would be a leak with a
 * currency symbol on it.
 *
 * The cost is summed here too, so a list can show a margin that is *true* rather
 * than a zero that merely looks like one. `costed_line_count` is what lets the
 * screen say whether that margin is complete: an offer with three lines and one
 * cost is a guess with two missing inputs, and printing it as a figure would be
 * the more dangerous kind of wrong, because it would look like an answer.
 */
const PROPOSAL_LIST_AGGREGATE = `
    CROSS JOIN LATERAL (
           SELECT COALESCE(SUM(l.amount_rial), 0) AS subtotal_rial,
                  COALESCE(SUM(l.cost_rial), 0) AS cost_rial,
                  COALESCE(SUM(l.amount_rial) FILTER (WHERE l.pass_through), 0) AS pass_through_rial,
                  count(*) FILTER (WHERE l.cost_rial IS NOT NULL)::int AS costed_line_count,
                  count(*)::int AS line_count
             FROM agency_proposal_lines l
            WHERE l.proposal_id = p.id AND l.business_id = p.business_id
         ) agg`;

const PROPOSAL_LIST_SELECT = `SELECT agg.subtotal_rial, agg.cost_rial, agg.pass_through_rial,
         agg.costed_line_count, agg.line_count,
         ${PROPOSAL_COLUMNS} ${PROPOSAL_JOINS} ${PROPOSAL_LIST_AGGREGATE}`;

// ---------------------------------------------------------------------------
// Reading what Postgres hands back
// ---------------------------------------------------------------------------

/**
 * A `date` column arrives as a JS `Date` at local midnight, so typing it
 * `string | null` would compile and be a lie. The same three readers the brief
 * service has; they are private to it, and importing them would pull a 700-line
 * module in for three five-line helpers.
 */
function readDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : postgresDateToIso(value);
  if (typeof value === "string") return value.slice(0, 10) || null;
  return null;
}

function readInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

/** `bigint` and `numeric` both arrive as strings; a price rendered as `"1500"` breaks arithmetic. */
function readMoney(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNullableMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toLine(row: LineRow): AgencyProposalLine {
  return {
    id: row.id,
    lineNumber: Number(row.line_number),
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceRial: readMoney(row.unit_price_rial),
    amountRial: readMoney(row.amount_rial),
    revenueCode: row.revenue_code,
    costRial: readNullableMoney(row.cost_rial),
    passThrough: row.pass_through === true,
    note: row.note,
  };
}

/**
 * The narrowest slice of a connection this file reads lines with: both the pooled
 * `query` and the `PoolClient` a surrounding transaction hands over satisfy it, so
 * one function serves a single read and a read inside a write.
 */
type LineReader = {
  query(sql: string, params?: unknown[]): Promise<{ rows: LineRow[] }>;
};

const pooledReader: LineReader = {
  query: (sql, params) => query<LineRow>(sql, params),
};

/** The lines of one proposal, in printed order. */
async function readLines(
  runner: LineReader,
  businessId: string,
  proposalId: string,
): Promise<AgencyProposalLine[]> {
  const { rows } = await runner.query(
    `SELECT l.id, l.line_number, l.description, l.quantity, l.unit_price_rial,
            l.amount_rial, l.revenue_code, l.cost_rial, l.pass_through, l.note
       FROM agency_proposal_lines l
      WHERE l.proposal_id = $1 AND l.business_id = $2
      ORDER BY l.line_number`,
    [proposalId, businessId],
  );
  return rows.map(toLine);
}

function toAgencyProposal(row: ProposalRow, lines: AgencyProposalLine[], now: Date): AgencyProposal {
  const status: AgencyProposalStatus = isAgencyProposalStatus(row.status) ? row.status : "draft";
  const validUntil = readDate(row.valid_until);
  const discountRial = readMoney(row.discount_rial);
  const taxRial = readMoney(row.tax_rial);
  return {
    id: row.id,
    proposalNumber: row.proposal_number,
    partyId: row.party_id,
    partyName: row.party_name ?? "",
    briefId: row.brief_id,
    briefNumber: row.brief_number,
    briefTitle: row.brief_title,
    dealId: row.deal_id,
    dealTitle: row.deal_title,
    projectId: row.project_id,
    projectName: row.project_name,
    contractId: row.contract_id,
    contractTitle: row.contract_title,
    title: row.title,
    status,
    scopeOfWork: row.scope_of_work,
    terms: row.terms,
    discountRial,
    taxRial,
    validUntil,
    clientContactPartyId: row.client_contact_party_id,
    clientContactName: row.client_contact_name,
    sentAt: readInstant(row.sent_at),
    decidedAt: readInstant(row.decided_at),
    decidedByName: row.decided_by_name,
    createdByName: row.created_by_name,
    createdAt: readInstant(row.created_at) ?? "",
    updatedAt: readInstant(row.updated_at) ?? "",
    lines,
    totals: agencyProposalTotals(lines, discountRial, taxRial),
    margin: agencyProposalMargin(lines, discountRial, taxRial),
    lapsed: isAgencyProposalLapsed(status, validUntil, now),
    actions: agencyProposalActionsFrom(status),
    frozen: isAgencyProposalFrozen(status),
    editable: isAgencyProposalEditable(status),
  };
}

// ---------------------------------------------------------------------------
// Validating what an HTTP body hands us
// ---------------------------------------------------------------------------

function requireClientId(input: AgencyProposalInput): string {
  const raw = input.partyId;
  if (typeof raw !== "string" || raw.trim() === "") throw new AgencyProposalError("client_required");
  return raw.trim();
}

/**
 * A nullable id from a body: absent means "leave it", `null`/`""` means "clear
 * it", and anything else has to be a non-empty string.
 */
function readOptionalId(
  input: AgencyProposalInput,
  key: keyof AgencyProposalInput,
): string | null | undefined {
  if (!(key in input)) return undefined;
  const raw = input[key];
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.trim() === "") throw new AgencyProposalError("invalid_reference", String(key));
  return raw.trim();
}

function readTextField(
  input: AgencyProposalInput,
  key: keyof AgencyProposalInput,
  maxLength: number,
): string | undefined {
  if (!(key in input)) return undefined;
  const value = normalizeAgencyProposalText(input[key], maxLength);
  if (value === null) throw new AgencyProposalError("text_too_long", String(key));
  return value;
}

/**
 * Reads a rial figure from a body, distinguishing "absent" from "stated but
 * unusable".
 *
 * The three cases have to stay apart or a PATCH becomes destructive: an absent
 * `discountRial` must leave the discount alone, a stated `0` must set it to zero,
 * and a stated `"abc"` must be refused rather than quietly read as no discount.
 */
function readRialField(
  input: AgencyProposalInput,
  key: keyof AgencyProposalInput,
  max: number,
): number | undefined {
  if (!(key in input)) return undefined;
  const raw = input[key];
  if (raw === null || raw === undefined || raw === "") return 0;
  const value = normalizeAgencyProposalRial(raw, max);
  // One code for both money inputs: a negative tax and an unusable discount are
  // the same kind of mistake from the member's side, and a code per field would
  // be a vocabulary the screen has to translate anyway.
  if (value === null) throw new AgencyProposalError("invalid_discount", String(key));
  return value;
}

function readDateField(
  input: AgencyProposalInput,
  key: keyof AgencyProposalInput,
): string | null | undefined {
  if (!(key in input)) return undefined;
  const raw = input[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = normalizeAgencyProposalDate(raw);
  if (value === null) throw new AgencyProposalError("invalid_date", String(key));
  return value;
}

/**
 * The lines a write wants to store, or a refusal.
 *
 * `null` from the normaliser becomes `invalid_line` rather than a dropped row: an
 * offer that silently lost a line would understate its own price, and the member
 * would send it believing it was complete.
 */
function readLinesInput(input: AgencyProposalInput): AgencyProposalLineInput[] | undefined {
  if (!("lines" in input)) return undefined;
  const lines = normalizeAgencyProposalLines(input.lines);
  if (lines === null) throw new AgencyProposalError("invalid_line");
  return lines;
}

/**
 * Writes a set of lines, replacing whatever was there.
 *
 * Numbering is the array's order, so a replace is the honest operation: keeping
 * the old rows and merging would leave gaps in the printed sequence, and a quote
 * whose lines run ۱، ۲، ۵ invites the client to ask what ۳ and ۴ were.
 */
async function replaceLines(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  businessId: string,
  proposalId: string,
  lines: AgencyProposalLineInput[],
): Promise<void> {
  await client.query(
    `DELETE FROM agency_proposal_lines WHERE proposal_id = $1 AND business_id = $2`,
    [proposalId, businessId],
  );
  for (const [index, entry] of lines.entries()) {
    await client.query(
      `INSERT INTO agency_proposal_lines (
         business_id, proposal_id, line_number, description, quantity,
         unit_price_rial, revenue_code, cost_rial, pass_through, note
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        businessId,
        proposalId,
        index + 1,
        entry.description,
        entry.quantity,
        entry.unitPriceRial,
        entry.revenueCode,
        entry.costRial,
        entry.passThrough,
        entry.note,
      ],
    );
  }
}

/**
 * Refuses a discount larger than the offer it discounts.
 *
 * One of the two rules the database does not enforce, because it compares the
 * header against the sum of its lines and no CHECK on one row can see the other.
 * A discount past the subtotal would make the total negative — the agency paying
 * the client to accept the work. Equal is allowed: zero-rial work is a real thing
 * an agency offers, a pro-bono campaign or a first month free to win a retainer.
 */
function assertDiscountAllowed(lines: AgencyProposalLineInput[], discountRial: number): void {
  const subtotal = lines.reduce(
    (sum, entry) => sum + agencyProposalLineAmountRial(entry.quantity, entry.unitPriceRial),
    0,
  );
  if (!agencyProposalDiscountAllowed(subtotal, discountRial)) {
    throw new AgencyProposalError("invalid_discount");
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The proposals a screen lists, newest first.
 *
 * Each row carries a subtotal and a line count from a correlated aggregate rather
 * than its lines, so a list of fifty offers costs fifty small sums instead of
 * loading every line of every one. The aggregate is filtered on `business_id`
 * too: it is a subquery, and the rule about predicates applies inside one exactly
 * as it applies outside.
 */
export async function listAgencyProposals(
  businessId: string,
  filters: AgencyProposalListFilters = {},
  now: Date = new Date(),
): Promise<AgencyProposal[]> {
  const where: string[] = ["p.business_id = $1"];
  const params: unknown[] = [businessId];

  for (const [key, column] of [
    ["partyId", "p.party_id"],
    ["briefId", "p.brief_id"],
    ["dealId", "p.deal_id"],
    ["projectId", "p.project_id"],
    ["contractId", "p.contract_id"],
  ] as const) {
    const value = filters[key];
    if (value) {
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`p.status = $${params.length}`);
  }
  if (filters.openOnly) where.push("p.status IN ('draft', 'sent')");
  if (filters.lapsedOnly) {
    // A lapsed offer is a live one whose clock has run out, which is a fact about
    // a date rather than a status anybody maintains: this finds the quotes that
    // quietly stopped being offers last week, which a `status = 'expired'` filter
    // would miss entirely.
    params.push(postgresDateToIso(now));
    where.push(
      `p.status = 'sent' AND p.valid_until IS NOT NULL AND p.valid_until < $${params.length}::date`,
    );
  }
  if (filters.q && filters.q.trim()) {
    // One search across the offer's own words and its client's name, so a member
    // who remembers the client but not the title still finds it.
    params.push(`%${filters.q.trim()}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.scope_of_work ILIKE $${params.length}
                 OR p.proposal_number ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  params.push(Math.min(Math.max(filters.limit ?? 100, 1), 200));
  const limit = params.length;

  const { rows } = await query<ProposalRow>(
    `${PROPOSAL_LIST_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC, p.proposal_number DESC
      LIMIT $${limit}`,
    params,
  );

  // A list does not carry its lines — a row opened from it is read in full — but
  // it does carry the figures the aggregate produced, so its totals and its margin
  // are real rather than placeholders. Keeping the same `AgencyProposal` shape
  // means the screen has one type to render.
  //
  // The margin is computed from the summed cost, which is the same arithmetic the
  // per-line path performs: subtotal − discount − cost. It agrees with an opened
  // row by construction, and `costedLineCount` against `lineCount` is what tells
  // the reader how much of that cost was actually stated.
  return rows.map((row) => {
    const base = toAgencyProposal(row, [], now);
    const totals = agencyProposalTotals(
      [{ amountRial: readMoney(row.subtotal_rial) }],
      base.discountRial,
      base.taxRial,
    );
    const costRial = readMoney(row.cost_rial);
    const margin: AgencyProposalMargin = {
      ...totals,
      costRial,
      marginRial: totals.subtotalRial - totals.discountRial - costRial,
      passThroughRial: readMoney(row.pass_through_rial),
      lineCount: Number(row.line_count ?? 0),
      costedLineCount: Number(row.costed_line_count ?? 0),
    };
    return { ...base, totals, margin };
  });
}

/** One proposal with every line, or `proposal_not_found` — never another tenant's. */
export async function loadAgencyProposal(
  businessId: string,
  proposalId: string,
  now: Date = new Date(),
): Promise<AgencyProposal> {
  const { rows } = await query<ProposalRow>(
    `${PROPOSAL_SELECT} WHERE p.id = $1 AND p.business_id = $2`,
    [proposalId, businessId],
  );
  const row = rows[0];
  if (!row) throw new AgencyProposalError("proposal_not_found");
  return toAgencyProposal(row, await readLines(pooledReader, businessId, proposalId), now);
}

/**
 * The offer as the client is entitled to see it, read from real rows.
 *
 * This is the *only* door through which a proposal reaches a client-facing
 * screen, and its return type is what makes the cost invisible: `AgencyProposal`
 * carries `margin` and every line's `costRial`, and this returns a type in which
 * neither exists. The projection lives in the pure module so a print template and
 * a review portal can share it; it is assembled here because only this half can
 * read the rows.
 *
 * It refuses a `draft` with `invalid_transition`. A client must never be shown an
 * offer the agency has not finished pricing: a draft is a calculation, not a
 * proposal, and a figure the client has seen is a figure the agency owes them.
 */
export async function loadAgencyProposalClientView(
  businessId: string,
  proposalId: string,
): Promise<AgencyProposalClientView> {
  const proposal = await loadAgencyProposal(businessId, proposalId);
  if (proposal.status === "draft") {
    throw new AgencyProposalError("invalid_transition", "draft_not_shareable");
  }
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM businesses WHERE id = $1`,
    [businessId],
  );
  return agencyProposalClientView(
    {
      proposalNumber: proposal.proposalNumber,
      title: proposal.title,
      scopeOfWork: proposal.scopeOfWork,
      terms: proposal.terms,
      validUntilIso: proposal.validUntil,
      discountRial: proposal.discountRial,
      taxRial: proposal.taxRial,
      clientName: proposal.partyName,
      agencyName: rows[0]?.name ?? "",
    },
    proposal.lines,
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Writes a new proposal as a draft, header and lines together.
 *
 * The number comes from `nextBusinessRegisterNumber`, which takes an advisory
 * *transaction* lock — hence the transaction, and hence this being the only place
 * a proposal's number is ever chosen. Numbering outside a transaction would hand
 * two concurrent requests the same `PR-` number and let the unique index turn the
 * race into a 500.
 */
export async function createAgencyProposal(
  businessId: string,
  actor: AgencyProposalActor,
  input: AgencyProposalInput,
): Promise<AgencyProposal> {
  const partyId = requireClientId(input);
  const title = readTextField(input, "title", AGENCY_PROPOSAL_TITLE_MAX_LENGTH);
  if (!title || title.trim() === "") throw new AgencyProposalError("title_required");

  const scopeOfWork = readTextField(input, "scopeOfWork", AGENCY_PROPOSAL_SCOPE_MAX_LENGTH) ?? "";
  const terms = readTextField(input, "terms", AGENCY_PROPOSAL_TERMS_MAX_LENGTH) ?? "";
  const clientContactName =
    readTextField(input, "clientContactName", AGENCY_PROPOSAL_NAME_MAX_LENGTH) ?? "";

  const discountRial = readRialField(input, "discountRial", Number.MAX_SAFE_INTEGER) ?? 0;
  const taxRial = readRialField(input, "taxRial", AGENCY_PROPOSAL_TAX_MAX) ?? 0;
  const validUntil = readDateField(input, "validUntil") ?? null;
  const lines = readLinesInput(input) ?? [];
  assertDiscountAllowed(lines, discountRial);

  const briefId = readOptionalId(input, "briefId") ?? null;
  const dealId = readOptionalId(input, "dealId") ?? null;
  const projectId = readOptionalId(input, "projectId") ?? null;
  const clientContactPartyId = readOptionalId(input, "clientContactPartyId") ?? null;

  const id = await withTenantTransaction(businessId, async (client) => {
    const proposalNumber = await nextBusinessRegisterNumber(
      "agency_proposals",
      businessId,
      PROPOSAL_NUMBER_PREFIX,
    );
    const { rows } = await client.query(
      `INSERT INTO agency_proposals (
         business_id, proposal_number, party_id, brief_id, deal_id, project_id,
         title, scope_of_work, terms, discount_rial, tax_rial, valid_until,
         client_contact_party_id, client_contact_name, created_by, created_by_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        businessId,
        proposalNumber,
        partyId,
        briefId,
        dealId,
        projectId,
        title,
        scopeOfWork,
        terms,
        discountRial,
        taxRial,
        validUntil,
        clientContactPartyId,
        clientContactName,
        actor.userId ?? null,
        actor.name ?? "",
      ],
    );
    const proposalId = String(rows[0].id);
    // Same transaction as the header: an offer whose lines failed to write would
    // be a quote for nothing at a figure nobody agreed to.
    await replaceLines(client, businessId, proposalId, lines);
    return proposalId;
  });

  return loadAgencyProposal(businessId, id);
}

/**
 * Edits what is still editable.
 *
 * A frozen proposal is refused field by field rather than partially applied: the
 * caller asked for a change and the answer is that nothing changed. The database
 * would refuse the same write, but answering here means the member gets
 * `proposal_frozen` in Persian instead of a constraint violation.
 *
 * `contract_id` is absent from the frozen set for the reason the migration gives:
 * it records what the offer *became*, which by definition happens after the offer
 * was sent, and freezing it would make the outcome unrecordable.
 */
export async function updateAgencyProposal(
  businessId: string,
  proposalId: string,
  _actor: AgencyProposalActor,
  patch: AgencyProposalInput,
): Promise<AgencyProposal> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, discount_rial, valid_until
         FROM agency_proposals
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [proposalId, businessId],
    );
    const current = rows[0] as
      | { status: string; discount_rial: unknown; valid_until: unknown }
      | undefined;
    if (!current) throw new AgencyProposalError("proposal_not_found");
    const status: AgencyProposalStatus = isAgencyProposalStatus(current.status) ? current.status : "draft";

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if ("title" in patch) {
      const title = readTextField(patch, "title", AGENCY_PROPOSAL_TITLE_MAX_LENGTH);
      if (!title || title.trim() === "") throw new AgencyProposalError("title_required");
      push("title", title);
    }
    for (const [key, column, max] of [
      ["scopeOfWork", "scope_of_work", AGENCY_PROPOSAL_SCOPE_MAX_LENGTH],
      ["terms", "terms", AGENCY_PROPOSAL_TERMS_MAX_LENGTH],
      ["clientContactName", "client_contact_name", AGENCY_PROPOSAL_NAME_MAX_LENGTH],
    ] as const) {
      const value = readTextField(patch, key, max);
      if (value !== undefined) push(column, value);
    }

    const discountRial = readRialField(patch, "discountRial", Number.MAX_SAFE_INTEGER);
    const taxRial = readRialField(patch, "taxRial", AGENCY_PROPOSAL_TAX_MAX);
    if (discountRial !== undefined) push("discount_rial", discountRial);
    if (taxRial !== undefined) push("tax_rial", taxRial);

    const validUntil = readDateField(patch, "validUntil");
    if (validUntil !== undefined) push("valid_until", validUntil);

    for (const [key, column] of [
      ["partyId", "party_id"],
      ["briefId", "brief_id"],
      ["dealId", "deal_id"],
      ["projectId", "project_id"],
      ["contractId", "contract_id"],
      ["clientContactPartyId", "client_contact_party_id"],
    ] as const) {
      const value = readOptionalId(patch, key);
      if (value !== undefined) push(column, value);
    }

    const lines = readLinesInput(patch);

    // The freeze is enforced here as well as by the trigger, so the answer names
    // the state rather than arriving as a constraint violation. Lines are part of
    // the frozen substance — they *are* the price — so replacing them on a sent
    // offer is the same refusal as changing the discount.
    const frozenColumns = new Set([
      "title", "scope_of_work", "terms", "discount_rial", "tax_rial", "valid_until",
      "party_id", "brief_id", "client_contact_party_id", "client_contact_name",
    ]);
    if (isAgencyProposalFrozen(status)) {
      const attempted = sets
        .map((set) => set.split(" = ")[0])
        .filter((column) => frozenColumns.has(column));
      if (attempted.length > 0 || lines !== undefined) {
        throw new AgencyProposalError("proposal_frozen");
      }
    }

    // The discount is checked against the lines that will exist *after* this
    // write, so patching only one of the two still cannot produce a negative
    // offer.
    if (lines !== undefined || discountRial !== undefined) {
      const effectiveLines =
        lines ?? (await readLines(client, businessId, proposalId)).map((row) => ({
          description: row.description,
          quantity: row.quantity,
          unitPriceRial: row.unitPriceRial,
          revenueCode: row.revenueCode,
          costRial: row.costRial,
          passThrough: row.passThrough,
          note: row.note,
        }));
      const effectiveDiscount = discountRial ?? readMoney(current.discount_rial);
      assertDiscountAllowed(effectiveLines, effectiveDiscount);
    }

    // An empty PATCH is a no-op rather than an error: a form that sends back
    // every field it did not change should not be told the proposal is missing.
    if (sets.length > 0) {
      params.push(proposalId, businessId);
      await client.query(
        `UPDATE agency_proposals
            SET ${sets.join(", ")}
          WHERE id = $${params.length - 1} AND business_id = $${params.length}`,
        params,
      );
    }
    if (lines !== undefined) await replaceLines(client, businessId, proposalId, lines);
  }).then(() => loadAgencyProposal(businessId, proposalId));
}

/**
 * Moves a proposal along its chain.
 *
 * Separate from the PATCH above because a transition is not a field edit: it
 * stamps `sent_at` or `decided_at`, and a decision is attributed to a name.
 * Routing it through "save the whole proposal" would lose both, which is the
 * argument the case, milestone and brief status routes all make.
 */
export async function applyAgencyProposalAction(
  businessId: string,
  proposalId: string,
  _actor: AgencyProposalActor,
  action: unknown,
  input: { decidedByName?: unknown; now?: Date } = {},
): Promise<AgencyProposal> {
  if (!isAgencyProposalAction(action)) throw new AgencyProposalError("invalid_action");
  const now = input.now ?? new Date();

  await withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, valid_until, client_contact_name
         FROM agency_proposals
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [proposalId, businessId],
    );
    const current = rows[0] as
      | { status: string; valid_until: unknown; client_contact_name: string }
      | undefined;
    if (!current) throw new AgencyProposalError("proposal_not_found");
    const from: AgencyProposalStatus = isAgencyProposalStatus(current.status) ? current.status : "draft";
    const act = action as AgencyProposalAction;

    if (!canPerformAgencyProposalAction(from, act)) {
      throw new AgencyProposalError("invalid_transition");
    }
    const to = agencyProposalActionTarget(act);
    const validUntil = readDate(current.valid_until);

    // The second rule the database cannot enforce: `valid_until < now()` is not an
    // immutable expression, so no CHECK can express it. Left unenforced, a client
    // could accept a six-month-old quote at the old price — the exact mistake a
    // validity date exists to prevent. Declining and expiring are *not* blocked:
    // both are accurate statements about the past.
    const blocked = agencyProposalActionBlocked(act, from, validUntil, now);
    if (blocked) throw new AgencyProposalError(blocked);

    // An offer with nothing on it is not an offer. The migration enforces the same
    // rule by counting the lines, and answering here first is what makes the
    // refusal a sentence rather than a constraint violation.
    if (from === "draft" && to !== "draft" && to !== "withdrawn") {
      const { rows: counted } = await client.query(
        `SELECT count(*)::int AS n FROM agency_proposal_lines
          WHERE proposal_id = $1 AND business_id = $2`,
        [proposalId, businessId],
      );
      if (Number(counted[0]?.n ?? 0) === 0) throw new AgencyProposalError("lines_required");
    }

    const sets: string[] = [`status = $1`];
    const params: unknown[] = [to];

    if (to === "sent" && from === "draft") {
      params.push(now.toISOString());
      sets.push(`sent_at = COALESCE(sent_at, $${params.length})`);
    }
    if (agencyProposalDecisionNeedsName(act)) {
      // §A asks that the stakeholder be recorded, so a decision is attributed. It
      // falls back to the contact the offer already names: that person is who the
      // agency recorded as the client's decision-maker, and accepting without
      // naming anyone else is recording their acceptance.
      const raw = input.decidedByName ?? current.client_contact_name;
      const name = normalizeAgencyProposalText(raw, AGENCY_PROPOSAL_NAME_MAX_LENGTH);
      if (!name) throw new AgencyProposalError("decider_required");
      params.push(now.toISOString(), name);
      sets.push(`decided_at = COALESCE(decided_at, $${params.length - 1})`);
      sets.push(`decided_by_name = $${params.length}`);
    }

    params.push(proposalId, businessId);
    await client.query(
      `UPDATE agency_proposals
          SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND business_id = $${params.length}`,
      params,
    );
  });

  return loadAgencyProposal(businessId, proposalId, now);
}

/**
 * Deletes a draft proposal — the escape hatch for one written by mistake.
 *
 * Anything the client has seen is a record and is withdrawn instead, so this
 * throws for a status the database would also refuse.
 */
export async function deleteAgencyProposal(businessId: string, proposalId: string): Promise<boolean> {
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM agency_proposals WHERE id = $1 AND business_id = $2`,
    [proposalId, businessId],
  );
  const current = rows[0];
  if (!current) return false;
  const status: AgencyProposalStatus = isAgencyProposalStatus(current.status) ? current.status : "draft";
  if (!isAgencyProposalDeletable(status)) throw new AgencyProposalError("proposal_not_deletable");

  const { rowCount } = await query(
    `DELETE FROM agency_proposals WHERE id = $1 AND business_id = $2`,
    [proposalId, businessId],
  );
  return (rowCount ?? 0) > 0;
}
