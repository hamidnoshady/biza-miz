/**
 * The campaign as it ran — storage, lifecycle and the figures §C reports on
 * (issue #1128).
 *
 * Migration 0278's header argues for why this is its own table and not a column on
 * `growth_campaigns`; `agency-campaign.ts` holds the vocabulary and the arithmetic.
 * This file is the database half, in the shape of `agency-proposal-service.ts`.
 *
 * ## Every statement carries its own `business_id`
 *
 * `withTenant` establishes the RLS scope but does not inject a predicate, and the
 * role this service runs under in tests bypasses RLS entirely — so an omitted
 * `business_id` is not a style problem, it is a cross-tenant read. That includes
 * **inside every join and every subquery**: a `LEFT JOIN parties` without its own
 * predicate resolves another tenant's client into this screen's row, which is the
 * leak §E shipped with and only an integration test caught.
 *
 * ## The derived figures are computed here, once, from what was read
 *
 * A row carries its stored counts *and* the ratios `agencyCampaignMetrics` derives
 * from them, so a list and the record opened from it cannot disagree. Nothing is
 * stored twice and nothing is invented: a metric with no denominator arrives as
 * `null` and the screen renders «—».
 */

import { query, withTenantTransaction } from "./db";
import { isUuid } from "./uuid";
import { todayIsoDate } from "./jalali";
import { nextBusinessRegisterNumber } from "./register-numbering";
import {
  AGENCY_CAMPAIGN_ACTIONS,
  AGENCY_CAMPAIGN_ACTION_TARGET,
  AGENCY_CAMPAIGN_CHANNEL_LIMIT,
  AGENCY_CAMPAIGN_COUNT_MAX,
  AGENCY_CAMPAIGN_IMPRESSIONS_MAX,
  AGENCY_CAMPAIGN_METRICS_NOTE_LIMIT,
  AGENCY_CAMPAIGN_NOTE_LIMIT,
  AGENCY_CAMPAIGN_OBJECTIVE_LIMIT,
  AGENCY_CAMPAIGN_OWNER_NAME_LIMIT,
  AGENCY_CAMPAIGN_RIAL_MAX,
  AGENCY_CAMPAIGN_TITLE_LIMIT,
  CAMPAIGN_NUMBER_PREFIX,
  agencyCampaignActions,
  agencyCampaignBudget,
  agencyCampaignMetrics,
  agencyCampaignWindowProblem,
  campaignActionRequiresWindow,
  isAgencyCampaignAction,
  isAgencyCampaignClosed,
  isAgencyCampaignCurrent,
  isAgencyCampaignDeletable,
  isAgencyCampaignMetricsSource,
  isAgencyCampaignStatus,
  normalizeAgencyCampaignChannels,
  normalizeAgencyCampaignNullableDate,
  normalizeAgencyCampaignNullableRial,
  normalizeAgencyCampaignNumber,
  normalizeAgencyCampaignOptionalText,
  normalizeAgencyCampaignText,
  nullableFieldStored,
  type AgencyCampaignAction,
  type AgencyCampaignChannel,
  type AgencyCampaignMetrics,
  type AgencyCampaignMetricsSource,
  type AgencyCampaignStatus,
  type AgencyCampaignBudget,
} from "./agency-campaign";

export { AGENCY_CAMPAIGN_ACTIONS, isAgencyCampaignAction };

/**
 * Every refusal this service can make, as a closed list.
 *
 * So the route guard's status map can be exhaustive over it, and adding a refusal
 * here without deciding what a member should see is a compile error rather than a
 * silent 400.
 *
 * The split the map applies is the one every register in this product uses: a
 * record that does not exist is a 404, a field the member typed wrong is a 400,
 * and anything a record refuses *because of where it is in its life cycle* is a
 * 409 — the request was reasonable and the state is what says no. That is why
 * `start_date_required` and `end_date_required` are 409s beside `window_reversed`
 * and `clicks_exceed_impressions` as 400s: the first two are an unfinished record,
 * the second two are arithmetic the member got wrong.
 */
export const AGENCY_CAMPAIGN_ERROR_CODES = [
  "campaign_not_found",
  "client_required",
  "title_required",
  "text_too_long",
  "invalid_channel",
  "too_many_channels",
  "invalid_date",
  "window_reversed",
  "invalid_metric",
  "clicks_exceed_impressions",
  "invalid_metrics_source",
  "invalid_reference",
  "invalid_action",
  "invalid_transition",
  "campaign_closed",
  "start_date_required",
  "end_date_required",
  "campaign_not_deletable",
] as const;

export type AgencyCampaignErrorCode = (typeof AGENCY_CAMPAIGN_ERROR_CODES)[number];

export class AgencyCampaignError extends Error {
  constructor(readonly code: AgencyCampaignErrorCode) {
    super(code);
  }
}

/**
 * Everything a screen needs for one campaign: the stored record, the names its
 * references resolve to, and the two derived readings (ratios and budget state).
 */
export interface AgencyCampaign {
  id: string;
  campaignNumber: string;
  partyId: string;
  clientName: string;
  title: string;
  status: AgencyCampaignStatus;
  objective: string;
  channels: AgencyCampaignChannel[];
  startDate: string | null;
  endDate: string | null;
  budgetRial: number | null;
  spendRial: number;
  impressions: number;
  clicks: number;
  leadsGenerated: number;
  conversions: number;
  revenueRial: number | null;
  metricsSource: AgencyCampaignMetricsSource;
  metricsNote: string;
  note: string;
  ownerName: string;
  briefId: string | null;
  briefNumber: string | null;
  briefTitle: string | null;
  proposalId: string | null;
  proposalNumber: string | null;
  proposalTitle: string | null;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  contractId: string | null;
  contractTitle: string | null;
  createdBy: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  /** Derived, never stored: see `agencyCampaignMetrics`. */
  metrics: AgencyCampaignMetrics;
  /** Derived, never stored: an overrun is a state, not an error. */
  budget: AgencyCampaignBudget;
  /** On air today. Derived, because a stored flag goes stale at midnight. */
  current: boolean;
  actions: AgencyCampaignAction[];
  closed: boolean;
  editable: boolean;
  deletable: boolean;
}

/** What a list needs, which is the same row minus the long prose. */
export type AgencyCampaignSummary = AgencyCampaign;

/* The row as Postgres returns it. `bigint` and `numeric` arrive as strings and a
 * `date` arrives as a JS Date at local midnight, so both are converted on the way
 * out rather than trusted. */
type CampaignRow = Record<string, unknown> & {
  id: string;
  campaign_number: string;
  party_id: string;
  client_name: string | null;
  title: string;
  status: string;
  objective: string;
  channels: string[] | null;
  start_date: Date | string | null;
  end_date: Date | string | null;
  budget_rial: string | number | null;
  spend_rial: string | number;
  impressions: string | number;
  clicks: string | number;
  leads_generated: string | number;
  conversions: string | number;
  revenue_rial: string | number | null;
  metrics_source: string;
  metrics_note: string;
  note: string;
  owner_name: string;
  brief_id: string | null;
  brief_number: string | null;
  brief_title: string | null;
  proposal_id: string | null;
  proposal_number: string | null;
  proposal_title: string | null;
  deal_id: string | null;
  deal_title: string | null;
  project_id: string | null;
  project_name: string | null;
  contract_id: string | null;
  contract_title: string | null;
  created_by: string | null;
  created_by_name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

/* Factored into named pieces rather than assembled inline, because an aggregate
 * spliced into a SELECT by string replacement is how a list ends up printing a
 * figure it never read — 0276's decision, and the reason its SELECT is composed. */
const CAMPAIGN_COLUMNS = `c.id, c.campaign_number, c.party_id, c.title, c.status,
       c.objective, c.channels, c.start_date, c.end_date, c.budget_rial,
       c.spend_rial, c.impressions, c.clicks, c.leads_generated, c.conversions,
       c.revenue_rial, c.metrics_source, c.metrics_note, c.note, c.owner_name,
       c.brief_id, c.proposal_id, c.deal_id, c.project_id, c.contract_id,
       c.created_by, c.created_by_name, c.created_at, c.updated_at`;

/* Every join carries its own `business_id`. */
const CAMPAIGN_JOINS = `
     JOIN parties p
       ON p.id = c.party_id AND p.business_id = c.business_id
     LEFT JOIN agency_client_briefs b
       ON b.id = c.brief_id AND b.business_id = c.business_id
     LEFT JOIN agency_proposals pr
       ON pr.id = c.proposal_id AND pr.business_id = c.business_id
     LEFT JOIN crm_deals d
       ON d.id = c.deal_id AND d.business_id = c.business_id
     LEFT JOIN ai_projects pj
       ON pj.id = c.project_id AND pj.business_id = c.business_id
     LEFT JOIN workspace_contracts w
       ON w.id = c.contract_id AND w.business_id = c.business_id`;

const CAMPAIGN_JOINED_COLUMNS = `p.name AS client_name,
       b.brief_number, b.title AS brief_title,
       pr.proposal_number, pr.title AS proposal_title,
       d.title AS deal_title, pj.name AS project_name, w.title AS contract_title`;

const CAMPAIGN_SELECT = `SELECT ${CAMPAIGN_COLUMNS}, ${CAMPAIGN_JOINED_COLUMNS}
       FROM agency_client_campaigns c${CAMPAIGN_JOINS}`;

function readMoney(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function readCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function readDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 10);
  // node-postgres hands a `date` back as a JS Date at local midnight, so the ISO
  // string has to be taken from the local parts rather than from `toISOString`,
  // which would shift the day for any timezone east of Greenwich.
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readStamp(value: Date | string | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toCampaign(row: CampaignRow, todayIso: string): AgencyCampaign {
  const status = (isAgencyCampaignStatus(row.status) ? row.status : "planned") as AgencyCampaignStatus;
  const metricsSource = (
    isAgencyCampaignMetricsSource(row.metrics_source) ? row.metrics_source : "manual"
  ) as AgencyCampaignMetricsSource;
  const startDate = readDate(row.start_date);
  const endDate = readDate(row.end_date);
  const budgetRial = readMoney(row.budget_rial);
  const spendRial = readCount(row.spend_rial);
  const channels = Array.isArray(row.channels)
    ? (row.channels.filter((entry): entry is AgencyCampaignChannel =>
        typeof entry === "string",
      ) as AgencyCampaignChannel[])
    : [];

  return {
    id: row.id,
    campaignNumber: row.campaign_number,
    partyId: row.party_id,
    clientName: row.client_name ?? "",
    title: row.title,
    status,
    objective: row.objective ?? "",
    channels,
    startDate,
    endDate,
    budgetRial,
    spendRial,
    impressions: readCount(row.impressions),
    clicks: readCount(row.clicks),
    leadsGenerated: readCount(row.leads_generated),
    conversions: readCount(row.conversions),
    revenueRial: readMoney(row.revenue_rial),
    metricsSource,
    metricsNote: row.metrics_note ?? "",
    note: row.note ?? "",
    ownerName: row.owner_name ?? "",
    briefId: row.brief_id,
    briefNumber: row.brief_number,
    briefTitle: row.brief_title,
    proposalId: row.proposal_id,
    proposalNumber: row.proposal_number,
    proposalTitle: row.proposal_title,
    dealId: row.deal_id,
    dealTitle: row.deal_title,
    projectId: row.project_id,
    projectName: row.project_name,
    contractId: row.contract_id,
    contractTitle: row.contract_title,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? "",
    createdAt: readStamp(row.created_at),
    updatedAt: readStamp(row.updated_at),
    metrics: agencyCampaignMetrics({
      spendRial,
      budgetRial,
      impressions: readCount(row.impressions),
      clicks: readCount(row.clicks),
      leadsGenerated: readCount(row.leads_generated),
      conversions: readCount(row.conversions),
      revenueRial: readMoney(row.revenue_rial),
    }),
    budget: agencyCampaignBudget(budgetRial, spendRial),
    current: isAgencyCampaignCurrent(status, startDate, endDate, todayIso),
    actions: agencyCampaignActions(status),
    closed: isAgencyCampaignClosed(status),
    editable: !isAgencyCampaignClosed(status),
    deletable: isAgencyCampaignDeletable(status),
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export interface AgencyCampaignListFilters {
  /** Free text over the number, the title, the objective and the client's name. */
  q?: string;
  /** One status, or `null`/absent for all of them. An unknown value filters nothing. */
  status?: string | null;
  /** Only one client's campaigns — the brand whose file is open. */
  partyId?: string | null;
  /** Only campaigns on air today, which is the calendar §C asks for. */
  currentOnly?: boolean;
  /** Only campaigns that are not closed. */
  openOnly?: boolean;
  limit?: number;
}

/**
 * The campaigns list.
 *
 * A row carries the same derived figures as the record opened from it, so a list
 * showing «CPL ۳۳٬۳۳۳» and a detail showing something else is not possible. The
 * derivations are arithmetic over columns already selected — no extra query, and
 * no figure printed that was not read.
 */
export async function listAgencyCampaigns(
  businessId: string,
  filters: AgencyCampaignListFilters = {},
  options: { todayIso?: string } = {},
): Promise<AgencyCampaignSummary[]> {
  const todayIso = options.todayIso ?? todayIsoDate();
  const clauses = ["c.business_id = $1"];
  const params: unknown[] = [businessId];

  if (filters.q && filters.q.trim()) {
    params.push(`%${filters.q.trim()}%`);
    clauses.push(
      `(c.campaign_number ILIKE $${params.length} OR c.title ILIKE $${params.length}
        OR c.objective ILIKE $${params.length} OR p.name ILIKE $${params.length})`,
    );
  }
  if (filters.status && isAgencyCampaignStatus(filters.status)) {
    params.push(filters.status);
    clauses.push(`c.status = $${params.length}`);
  }
  if (filters.partyId && isUuid(filters.partyId)) {
    params.push(filters.partyId);
    clauses.push(`c.party_id = $${params.length}`);
  }
  if (filters.openOnly) clauses.push(`c.status NOT IN ('completed', 'cancelled')`);
  if (filters.currentOnly) {
    // The window is a range, not a flag: a stored "is current" column would be
    // wrong from midnight until somebody re-ran it.
    params.push(todayIso);
    clauses.push(
      `c.status IN ('running', 'paused') AND c.start_date IS NOT NULL
       AND c.start_date <= $${params.length}::date
       AND (c.end_date IS NULL OR c.end_date >= $${params.length}::date)`,
    );
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
  const { rows } = await query<CampaignRow>(
    `${CAMPAIGN_SELECT}
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.start_date DESC NULLS LAST, c.created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => toCampaign(row, todayIso));
}

export async function loadAgencyCampaign(
  businessId: string,
  campaignId: string,
  options: { todayIso?: string } = {},
): Promise<AgencyCampaign | null> {
  if (!isUuid(campaignId)) return null;
  const todayIso = options.todayIso ?? todayIsoDate();
  const { rows } = await query<CampaignRow>(
    `${CAMPAIGN_SELECT}
      WHERE c.id = $2 AND c.business_id = $1`,
    [businessId, campaignId],
  );
  const row = rows[0];
  return row ? toCampaign(row, todayIso) : null;
}

/**
 * How many campaigns each of a set of clients has, and how many are in flight.
 *
 * This is what the customer file's organisation card was missing when wave 8 had to
 * refuse to count campaigns at all: §A's "concurrent campaigns" per brand. Counted
 * in one grouped read rather than once per node, and restricted to the parties
 * asked about, so the scan is bounded by the group rather than by the tenant.
 */
export async function countCampaignsByParty(
  businessId: string,
  partyIds: readonly string[],
): Promise<Map<string, { total: number; inFlight: number }>> {
  const ids = partyIds.filter(isUuid);
  const counts = new Map<string, { total: number; inFlight: number }>();
  if (ids.length === 0) return counts;

  const { rows } = await query<{ party_id: string; total: string | number; in_flight: string | number }>(
    `SELECT party_id,
            count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('running', 'paused'))::int AS in_flight
       FROM agency_client_campaigns
      WHERE business_id = $1 AND party_id = ANY($2::uuid[])
      GROUP BY party_id`,
    [businessId, ids],
  );
  for (const row of rows) {
    counts.set(row.party_id, {
      total: readCount(row.total),
      inFlight: readCount(row.in_flight),
    });
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export interface AgencyCampaignInput {
  partyId?: unknown;
  title?: unknown;
  objective?: unknown;
  channels?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  budgetRial?: unknown;
  spendRial?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  leadsGenerated?: unknown;
  conversions?: unknown;
  revenueRial?: unknown;
  metricsSource?: unknown;
  metricsNote?: unknown;
  note?: unknown;
  ownerName?: unknown;
  briefId?: unknown;
  proposalId?: unknown;
  dealId?: unknown;
  projectId?: unknown;
  contractId?: unknown;
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && isUuid(value) ? value : null;
}

/** Validate everything the caller can get wrong, before any of it is written. */
function readCampaignInput(input: AgencyCampaignInput, options: { partial?: boolean } = {}) {
  const partial = options.partial ?? false;

  const partyId = partial
    ? optionalUuid(input.partyId)
    : typeof input.partyId === "string" && isUuid(input.partyId)
      ? input.partyId
      : null;
  if (!partial && !partyId) throw new AgencyCampaignError("client_required");
  if (partial && input.partyId !== undefined && !partyId) {
    throw new AgencyCampaignError("invalid_reference");
  }

  const title = normalizeAgencyCampaignText(input.title, AGENCY_CAMPAIGN_TITLE_LIMIT);
  // An overlong title and a blank one are different mistakes and get different
  // words, because only one of them is fixable by typing less. On a patch, an
  // absent title means "leave it alone" and must not be reported at all.
  const titleWasGiven = !partial || input.title !== undefined;
  if (!title && titleWasGiven) {
    throw new AgencyCampaignError(
      typeof input.title === "string" && input.title.trim().length > AGENCY_CAMPAIGN_TITLE_LIMIT
        ? "text_too_long"
        : "title_required",
    );
  }

  const objective = normalizeAgencyCampaignOptionalText(input.objective, AGENCY_CAMPAIGN_OBJECTIVE_LIMIT);
  if (objective === null) throw new AgencyCampaignError("text_too_long");
  const note = normalizeAgencyCampaignOptionalText(input.note, AGENCY_CAMPAIGN_NOTE_LIMIT);
  if (note === null) throw new AgencyCampaignError("text_too_long");
  const metricsNote = normalizeAgencyCampaignOptionalText(input.metricsNote, AGENCY_CAMPAIGN_METRICS_NOTE_LIMIT);
  if (metricsNote === null) throw new AgencyCampaignError("text_too_long");
  const ownerName = normalizeAgencyCampaignOptionalText(input.ownerName, AGENCY_CAMPAIGN_OWNER_NAME_LIMIT);
  if (ownerName === null) throw new AgencyCampaignError("text_too_long");

  // `null` here is a refusal rather than an empty list: dropping an unrecognised
  // channel would record a campaign that ran on fewer channels than it did.
  const channels = normalizeAgencyCampaignChannels(input.channels);
  if (channels === null) {
    throw new AgencyCampaignError(
      Array.isArray(input.channels) && input.channels.length > AGENCY_CAMPAIGN_CHANNEL_LIMIT
        ? "too_many_channels"
        : "invalid_channel",
    );
  }

  const start = normalizeAgencyCampaignNullableDate(input.startDate);
  const end = normalizeAgencyCampaignNullableDate(input.endDate);
  if (start.state === "invalid" || end.state === "invalid") {
    throw new AgencyCampaignError("invalid_date");
  }
  const windowProblem = agencyCampaignWindowProblem(
    nullableFieldStored(start),
    nullableFieldStored(end),
  );
  if (windowProblem) throw new AgencyCampaignError(windowProblem);

  const budget = normalizeAgencyCampaignNullableRial(input.budgetRial, AGENCY_CAMPAIGN_RIAL_MAX);
  const revenue = normalizeAgencyCampaignNullableRial(input.revenueRial, AGENCY_CAMPAIGN_RIAL_MAX);
  if (budget.state === "invalid" || revenue.state === "invalid") {
    throw new AgencyCampaignError("invalid_metric");
  }
  // A budget of exactly zero is refused by 0278's CHECK; saying so here is the
  // difference between «بودجه نمی‌تواند صفر باشد» and a database error. Clearing it
  // is not the same act and stays allowed.
  if (budget.state === "value" && budget.value === 0) throw new AgencyCampaignError("invalid_metric");

  const spend = normalizeAgencyCampaignNumber(input.spendRial, AGENCY_CAMPAIGN_RIAL_MAX, { absentIsZero: true });
  if (spend === null) throw new AgencyCampaignError("invalid_metric");
  const impressions = normalizeAgencyCampaignNumber(input.impressions, AGENCY_CAMPAIGN_IMPRESSIONS_MAX, { absentIsZero: true });
  if (impressions === null) throw new AgencyCampaignError("invalid_metric");
  const clicks = normalizeAgencyCampaignNumber(input.clicks, AGENCY_CAMPAIGN_IMPRESSIONS_MAX, { absentIsZero: true });
  if (clicks === null) throw new AgencyCampaignError("invalid_metric");
  const leadsGenerated = normalizeAgencyCampaignNumber(input.leadsGenerated, AGENCY_CAMPAIGN_COUNT_MAX, { absentIsZero: true });
  if (leadsGenerated === null) throw new AgencyCampaignError("invalid_metric");
  const conversions = normalizeAgencyCampaignNumber(input.conversions, AGENCY_CAMPAIGN_COUNT_MAX, { absentIsZero: true });
  if (conversions === null) throw new AgencyCampaignError("invalid_metric");
  // 0278 CHECKs clicks <= impressions because it is arithmetic, not attribution.
  // Reported here first so the member is told which two fields disagree.
  if (clicks > impressions) throw new AgencyCampaignError("clicks_exceed_impressions");

  let metricsSource: AgencyCampaignMetricsSource = "manual";
  if (input.metricsSource !== undefined && input.metricsSource !== null && input.metricsSource !== "") {
    if (!isAgencyCampaignMetricsSource(input.metricsSource)) {
      throw new AgencyCampaignError("invalid_metrics_source");
    }
    metricsSource = input.metricsSource;
  }

  // A reference that is present but not a uuid is a mistake worth naming, rather
  // than one worth quietly dropping: `optionalUuid` would turn «abc» into "no
  // brief", and the campaign would be created missing the link the member just
  // tried to make.
  for (const value of [
    input.briefId,
    input.proposalId,
    input.dealId,
    input.projectId,
    input.contractId,
  ]) {
    if (value !== undefined && value !== null && value !== "" && !isUuid(String(value))) {
      throw new AgencyCampaignError("invalid_reference");
    }
  }

  const briefId = optionalUuid(input.briefId);
  const proposalId = optionalUuid(input.proposalId);
  const dealId = optionalUuid(input.dealId);
  const projectId = optionalUuid(input.projectId);
  const contractId = optionalUuid(input.contractId);

  return {
    partyId,
    title,
    objective: objective ?? "",
    note: note ?? "",
    metricsNote: metricsNote ?? "",
    ownerName: ownerName ?? "",
    channels,
    startDate: nullableFieldStored(start),
    endDate: nullableFieldStored(end),
    budgetRial: nullableFieldStored(budget),
    revenueRial: nullableFieldStored(revenue),
    spendRial: spend,
    impressions,
    clicks,
    leadsGenerated,
    conversions,
    metricsSource,
    briefId,
    proposalId,
    dealId,
    projectId,
    contractId,
  };
}

export async function createAgencyCampaign(
  businessId: string,
  actor: { userId?: string | null; name: string },
  input: AgencyCampaignInput,
): Promise<AgencyCampaign> {
  const values = readCampaignInput(input);
  if (!values.partyId) throw new AgencyCampaignError("client_required");

  return withTenantTransaction(businessId, async (client) => {
    // The number is chosen inside this transaction, under the advisory lock
    // `nextBusinessRegisterNumber` takes: two campaigns created at once must not
    // be handed the same number, and the lock is only held for the length of the
    // insert that uses it.
    const campaignNumber = await nextBusinessRegisterNumber(
      "agency_client_campaigns",
      businessId,
      CAMPAIGN_NUMBER_PREFIX,
    );
    const { rows } = await client.query<CampaignRow>(
      `INSERT INTO agency_client_campaigns
         (business_id, campaign_number, party_id, title, objective, channels,
          start_date, end_date, budget_rial, spend_rial, impressions, clicks,
          leads_generated, conversions, revenue_rial, metrics_source, metrics_note,
          note, owner_name, brief_id, proposal_id, deal_id, project_id, contract_id,
          created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING id`,
      [
        businessId,
        campaignNumber,
        values.partyId,
        values.title,
        values.objective,
        values.channels,
        values.startDate,
        values.endDate,
        values.budgetRial,
        values.spendRial,
        values.impressions,
        values.clicks,
        values.leadsGenerated,
        values.conversions,
        values.revenueRial,
        values.metricsSource,
        values.metricsNote,
        values.note,
        values.ownerName,
        values.briefId,
        values.proposalId,
        values.dealId,
        values.projectId,
        values.contractId,
        actor.userId ?? null,
        actor.name,
      ],
    );
    const created = rows[0];
    if (!created) throw new AgencyCampaignError("campaign_not_found");
    const loaded = await loadAgencyCampaign(businessId, created.id);
    if (!loaded) throw new AgencyCampaignError("campaign_not_found");
    return loaded;
  });
}

/**
 * A patch. `undefined` means "leave it alone" throughout, which is why every
 * normaliser here distinguishes absent from empty — a PATCH carrying only a title
 * must not clear the budget, the window or the figures.
 *
 * An empty patch is a no-op that returns the record, not a `not_found`: "nothing to
 * do" and "nothing there" are different answers and only one of them is an error.
 */
export async function updateAgencyCampaign(
  businessId: string,
  campaignId: string,
  _actor: { userId?: string | null; name: string },
  input: AgencyCampaignInput,
  options: { todayIso?: string } = {},
): Promise<AgencyCampaign> {
  if (!isUuid(campaignId)) throw new AgencyCampaignError("campaign_not_found");
  const todayIso = options.todayIso ?? todayIsoDate();

  const existing = await loadAgencyCampaign(businessId, campaignId, { todayIso });
  if (!existing) throw new AgencyCampaignError("campaign_not_found");
  if (existing.closed) throw new AgencyCampaignError("campaign_closed");

  // No row lock, and that is deliberate rather than an oversight. The read here
  // exists to merge the patch over what is stored and to answer in words; the
  // *authority* on whether a closed record may change is 0278's trigger, which runs
  // inside the write. So a race — this request reads an editable campaign while
  // another completes it — is refused by the database, not lost. A FOR UPDATE here
  // would only change which of the two says no.

  const values = readCampaignInput(input, { partial: true });

  // Merge the patch over what is stored, so a window or a figure pair can be
  // validated as a whole: `clicks` arriving alone has to be checked against the
  // impressions already on the record, not against a default of zero.
  const startDate = input.startDate !== undefined ? values.startDate : existing.startDate;
  const endDate = input.endDate !== undefined ? values.endDate : existing.endDate;
  const windowProblem = agencyCampaignWindowProblem(startDate, endDate);
  if (windowProblem) throw new AgencyCampaignError(windowProblem);

  const impressions = input.impressions !== undefined ? values.impressions : existing.impressions;
  const clicks = input.clicks !== undefined ? values.clicks : existing.clicks;
  if (clicks > impressions) throw new AgencyCampaignError("clicks_exceed_impressions");

  const assignments: string[] = [];
  const params: unknown[] = [businessId, campaignId];
  const set = (column: string, value: unknown): void => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };

  if (input.partyId !== undefined && values.partyId) set("party_id", values.partyId);
  if (input.title !== undefined && values.title) set("title", values.title);
  if (input.objective !== undefined) set("objective", values.objective);
  if (input.note !== undefined) set("note", values.note);
  if (input.metricsNote !== undefined) set("metrics_note", values.metricsNote);
  if (input.ownerName !== undefined) set("owner_name", values.ownerName);
  if (input.channels !== undefined) set("channels", values.channels);
  if (input.startDate !== undefined) set("start_date", startDate);
  if (input.endDate !== undefined) set("end_date", endDate);
  if (input.budgetRial !== undefined) set("budget_rial", values.budgetRial);
  if (input.revenueRial !== undefined) set("revenue_rial", values.revenueRial);
  if (input.spendRial !== undefined) set("spend_rial", values.spendRial);
  if (input.impressions !== undefined) set("impressions", values.impressions);
  if (input.clicks !== undefined) set("clicks", values.clicks);
  if (input.leadsGenerated !== undefined) set("leads_generated", values.leadsGenerated);
  if (input.conversions !== undefined) set("conversions", values.conversions);
  if (input.metricsSource !== undefined && isAgencyCampaignMetricsSource(input.metricsSource)) {
    set("metrics_source", values.metricsSource);
  }
  if (input.briefId !== undefined) set("brief_id", values.briefId);
  if (input.proposalId !== undefined) set("proposal_id", values.proposalId);
  if (input.dealId !== undefined) set("deal_id", values.dealId);
  if (input.projectId !== undefined) set("project_id", values.projectId);
  if (input.contractId !== undefined) set("contract_id", values.contractId);

  if (assignments.length === 0) return existing;

  await query(
    `UPDATE agency_client_campaigns
        SET ${assignments.join(", ")}
      WHERE id = $2 AND business_id = $1`,
    params,
  );

  const loaded = await loadAgencyCampaign(businessId, campaignId, { todayIso });
  if (!loaded) throw new AgencyCampaignError("campaign_not_found");
  return loaded;
}

/**
 * Move a campaign through its lifecycle.
 *
 * The window a status implies is checked here in words before 0278's CHECK has to
 * refuse it: «آغاز اجرا» on a campaign with no start date is an unfinished record,
 * not a database error.
 */
export async function applyAgencyCampaignAction(
  businessId: string,
  campaignId: string,
  _actor: { userId?: string | null; name: string },
  action: string,
  options: { now?: Date; todayIso?: string } = {},
): Promise<AgencyCampaign> {
  if (!isAgencyCampaignAction(action)) throw new AgencyCampaignError("invalid_action");
  if (!isUuid(campaignId)) throw new AgencyCampaignError("campaign_not_found");
  const todayIso = options.todayIso ?? todayIsoDate();

  const existing = await loadAgencyCampaign(businessId, campaignId, { todayIso });
  if (!existing) throw new AgencyCampaignError("campaign_not_found");
  if (isAgencyCampaignClosed(existing.status)) throw new AgencyCampaignError("campaign_closed");
  if (!existing.actions.includes(action)) throw new AgencyCampaignError("invalid_transition");

  const needs = campaignActionRequiresWindow(action);
  if (needs === "start" && !existing.startDate) throw new AgencyCampaignError("start_date_required");
  if (needs === "end" && !existing.endDate) throw new AgencyCampaignError("end_date_required");

  const target = AGENCY_CAMPAIGN_ACTION_TARGET[action];
  await query(
    `UPDATE agency_client_campaigns
        SET status = $3, updated_at = COALESCE($4::timestamptz, now())
      WHERE id = $2 AND business_id = $1`,
    [businessId, campaignId, target, options.now ? options.now.toISOString() : null],
  );

  const loaded = await loadAgencyCampaign(businessId, campaignId, { todayIso });
  if (!loaded) throw new AgencyCampaignError("campaign_not_found");
  return loaded;
}

export async function deleteAgencyCampaign(
  businessId: string,
  campaignId: string,
): Promise<boolean> {
  if (!isUuid(campaignId)) throw new AgencyCampaignError("campaign_not_found");
  const existing = await loadAgencyCampaign(businessId, campaignId);
  if (!existing) throw new AgencyCampaignError("campaign_not_found");
  if (!isAgencyCampaignDeletable(existing.status)) {
    throw new AgencyCampaignError("campaign_not_deletable");
  }
  const { rowCount } = await query(
    `DELETE FROM agency_client_campaigns WHERE id = $2 AND business_id = $1`,
    [businessId, campaignId],
  );
  return (rowCount ?? 0) > 0;
}
