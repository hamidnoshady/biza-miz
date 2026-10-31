/**
 * §A's client briefs — the half that talks to Postgres.
 *
 * Split from `agency-brief.ts` for the reason `media-review.ts` is split from its
 * service: that module is imported by a client component, and this one imports
 * `pg`. A panel that reached through this file would drag the driver into the
 * browser bundle.
 *
 * Two rules this file follows everywhere, both learned the hard way on §E:
 *
 *   * **Every statement carries its own `business_id` predicate.** `withTenant`
 *     establishes the RLS scope and nothing more — it does not rewrite SQL. Under
 *     a superuser role, which is what the integration harness and any maintenance
 *     script connect as, a query without that predicate is a cross-tenant read.
 *     The service must be correct without RLS holding it up.
 *   * **A PATCH that says nothing about a field leaves it alone.** `"x" in patch`
 *     rather than `patch.x ?? current`, because collapsing absent and null would
 *     let a caller who omitted `budgetRial` silently delete the client's budget.
 *
 * What the service refuses and what the database refuses overlap on purpose. The
 * service answers in Persian, early, with the field named; migration 0274 answers
 * with a `23514` if something gets past it. Neither is a substitute for the
 * other, and the integration suite checks the database's half independently.
 */

import { query, withTenantTransaction } from "./db";
import { postgresDateToIso } from "./jalali";
import { nextBusinessRegisterNumber } from "./register-numbering";
import {
  AGENCY_BRIEF_NOTE_MAX_LENGTH,
  AGENCY_BRIEF_TEXT_MAX_LENGTH,
  AGENCY_BRIEF_TITLE_MAX_LENGTH,
  AGENCY_BRIEF_NAME_MAX_LENGTH,
  BRIEF_NUMBER_PREFIX,
  agencyBriefActionTarget,
  agencyBriefActionsFrom,
  agencyBriefConfirmationNeedsName,
  agencyBriefObjectiveRequired,
  canPerformAgencyBriefAction,
  isAgencyBriefAction,
  isAgencyBriefDeletable,
  isAgencyBriefFrozen,
  isAgencyBriefStatus,
  normalizeAgencyBriefBudget,
  normalizeAgencyBriefChannels,
  normalizeAgencyBriefDeliverables,
  normalizeAgencyBriefText,
  type AgencyBriefAction,
  type AgencyBriefDeliverable,
  type AgencyBriefStatus,
} from "./agency-brief";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const AGENCY_BRIEF_ERROR_CODES = [
  "brief_not_found",
  "client_required",
  "title_required",
  "objective_required",
  "confirmer_required",
  "invalid_channel",
  "invalid_deliverable",
  "invalid_budget",
  "invalid_date",
  "invalid_period",
  "text_too_long",
  "invalid_action",
  "invalid_transition",
  "brief_frozen",
  "brief_not_deletable",
] as const;

export type AgencyBriefErrorCode = (typeof AGENCY_BRIEF_ERROR_CODES)[number];

export class AgencyBriefError extends Error {
  constructor(
    readonly code: AgencyBriefErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AgencyBriefError";
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Who is writing. The member's name is snapshotted, as 0260's registers do. */
export interface AgencyBriefActor {
  userId?: string | null;
  name?: string | null;
}

/**
 * A brief as the API hands it over.
 *
 * `actions` is derived from `status` by the same function the panel's buttons are
 * rendered from, so the member-facing side can never offer an act this service
 * would refuse. That is §E's decision 30: one contract, two readers.
 */
export interface AgencyBrief {
  id: string;
  briefNumber: string;
  partyId: string;
  partyName: string;
  dealId: string | null;
  dealTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  status: AgencyBriefStatus;
  objective: string;
  audience: string;
  channels: string[];
  deliverables: AgencyBriefDeliverable[];
  budgetRial: number | null;
  startDate: string | null;
  deliveryDate: string | null;
  acceptanceCriteria: string;
  note: string;
  approverPartyId: string | null;
  approverName: string;
  sentAt: string | null;
  confirmedAt: string | null;
  confirmedByName: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  actions: AgencyBriefAction[];
  frozen: boolean;
}

export interface AgencyBriefListFilters {
  partyId?: string | null;
  dealId?: string | null;
  projectId?: string | null;
  status?: AgencyBriefStatus | null;
  openOnly?: boolean;
  q?: string | null;
  limit?: number;
}

/** What a POST or PATCH may carry. Every field is `unknown` on purpose: the body
 * arrives from HTTP and nothing about it is trusted until normalised below. */
export interface AgencyBriefInput {
  partyId?: unknown;
  dealId?: unknown;
  projectId?: unknown;
  title?: unknown;
  objective?: unknown;
  audience?: unknown;
  channels?: unknown;
  deliverables?: unknown;
  budgetRial?: unknown;
  startDate?: unknown;
  deliveryDate?: unknown;
  acceptanceCriteria?: unknown;
  note?: unknown;
  approverPartyId?: unknown;
  approverName?: unknown;
}

// A `type`, not an `interface`: `query<T>` constrains `T` to
// `Record<string, unknown>`, which an interface does not satisfy.
type BriefRow = {
  id: string;
  brief_number: string;
  party_id: string;
  party_name: string | null;
  deal_id: string | null;
  deal_title: string | null;
  project_id: string | null;
  project_name: string | null;
  title: string;
  status: string;
  objective: string;
  audience: string;
  channels: string[];
  deliverables: unknown;
  budget_rial: string | number | null;
  start_date: Date | string | null;
  delivery_date: Date | string | null;
  acceptance_criteria: string;
  note: string;
  approver_party_id: string | null;
  approver_name: string;
  sent_at: Date | string | null;
  confirmed_at: Date | string | null;
  confirmed_by_name: string;
  created_by_name: string;
  created_at: Date | string;
  updated_at: Date | string;
};

/**
 * The columns every read selects, with the three names a brief is read by.
 *
 * The joins are `LEFT` and filtered on `business_id` as well as on id: joining a
 * party by id alone would resolve another tenant's party into this brief's name,
 * which is the leak the predicate exists to prevent.
 */
const BRIEF_SELECT = `
  SELECT b.id, b.brief_number, b.party_id, p.name AS party_name,
         b.deal_id, d.title AS deal_title,
         b.project_id, pr.name AS project_name,
         b.title, b.status, b.objective, b.audience, b.channels, b.deliverables,
         b.budget_rial, b.start_date, b.delivery_date, b.acceptance_criteria,
         b.note, b.approver_party_id, b.approver_name,
         b.sent_at, b.confirmed_at, b.confirmed_by_name, b.created_by_name,
         b.created_at, b.updated_at
    FROM agency_client_briefs b
    LEFT JOIN parties p
           ON p.id = b.party_id AND p.business_id = b.business_id
    LEFT JOIN crm_deals d
           ON d.id = b.deal_id AND d.business_id = b.business_id
    LEFT JOIN ai_projects pr
           ON pr.id = b.project_id AND pr.business_id = b.business_id`;

// ---------------------------------------------------------------------------
// Reading what Postgres hands back
// ---------------------------------------------------------------------------

/**
 * A `date` column arrives as a JS `Date` at local midnight, so typing it
 * `string | null` would compile and be a lie. Same pair of readers §D uses; they
 * are private to that service, and importing them would pull a large module in
 * for two five-line helpers.
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

/** `bigint` arrives as a string; a budget rendered as `"1500"` breaks arithmetic. */
function readMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readDeliverables(value: unknown): AgencyBriefDeliverable[] {
  // The column is CHECKed to be a json array, so anything else here means the row
  // predates the constraint or was written around it. An empty list is the honest
  // reading; throwing would make one bad row hide every brief in the list.
  const normalised = normalizeAgencyBriefDeliverables(value);
  return normalised ?? [];
}

function toAgencyBrief(row: BriefRow): AgencyBrief {
  const status: AgencyBriefStatus = isAgencyBriefStatus(row.status) ? row.status : "draft";
  return {
    id: row.id,
    briefNumber: row.brief_number,
    partyId: row.party_id,
    partyName: row.party_name ?? "",
    dealId: row.deal_id,
    dealTitle: row.deal_title,
    projectId: row.project_id,
    projectName: row.project_name,
    title: row.title,
    status,
    objective: row.objective,
    audience: row.audience,
    channels: Array.isArray(row.channels) ? row.channels : [],
    deliverables: readDeliverables(row.deliverables),
    budgetRial: readMoney(row.budget_rial),
    startDate: readDate(row.start_date),
    deliveryDate: readDate(row.delivery_date),
    acceptanceCriteria: row.acceptance_criteria,
    note: row.note,
    approverPartyId: row.approver_party_id,
    approverName: row.approver_name,
    sentAt: readInstant(row.sent_at),
    confirmedAt: readInstant(row.confirmed_at),
    confirmedByName: row.confirmed_by_name,
    createdByName: row.created_by_name,
    createdAt: readInstant(row.created_at) ?? "",
    updatedAt: readInstant(row.updated_at) ?? "",
    actions: agencyBriefActionsFrom(status),
    frozen: isAgencyBriefFrozen(status),
  };
}

// ---------------------------------------------------------------------------
// Validating what an HTTP body hands us
// ---------------------------------------------------------------------------

/**
 * A `YYYY-MM-DD` date, or `null`, or a refusal.
 *
 * Refused rather than coerced: `new Date("1403-01-02")` is a perfectly valid
 * parse of something nobody meant, and a brief's dates are what a proposal's
 * schedule is built from.
 */
function readDateInput(value: unknown, field: "start_date" | "delivery_date"): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new AgencyBriefError("invalid_date", field);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) throw new AgencyBriefError("invalid_date", field);
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new AgencyBriefError("invalid_date", field);
  // A date that round-trips is a date that exists: `2026-02-30` parses and then
  // resolves to 1 March, which is not what was typed.
  if (parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new AgencyBriefError("invalid_date", field);
  }
  return trimmed;
}

function readTextField(
  patch: AgencyBriefInput,
  key: keyof AgencyBriefInput,
  maxLength: number,
  code: "text_too_long",
): string | undefined {
  if (!(key in patch)) return undefined;
  const value = normalizeAgencyBriefText(patch[key], maxLength);
  if (value === null) throw new AgencyBriefError(code, String(key));
  return value;
}

/**
 * The one reference a brief cannot do without.
 *
 * Checked here rather than left to the column's NOT NULL so that a missing client
 * arrives as `client_required` in Persian instead of a database error.
 */
function requireClientId(patch: AgencyBriefInput): string {
  const raw = patch.partyId;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AgencyBriefError("client_required");
  }
  return raw.trim();
}

/**
 * A nullable id from a body: absent means "leave it", `null`/`""` means "clear
 * it", and anything else has to be a non-empty string.
 */
function readOptionalId(patch: AgencyBriefInput, key: keyof AgencyBriefInput): string | null | undefined {
  if (!(key in patch)) return undefined;
  const raw = patch[key];
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new AgencyBriefError("invalid_transition", String(key));
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The briefs a screen lists, newest first. */
export async function listAgencyBriefs(
  businessId: string,
  filters: AgencyBriefListFilters = {},
): Promise<AgencyBrief[]> {
  const where: string[] = ["b.business_id = $1"];
  const params: unknown[] = [businessId];

  if (filters.partyId) {
    params.push(filters.partyId);
    where.push(`b.party_id = $${params.length}`);
  }
  if (filters.dealId) {
    params.push(filters.dealId);
    where.push(`b.deal_id = $${params.length}`);
  }
  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`b.project_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    where.push(`b.status = $${params.length}`);
  }
  if (filters.openOnly) {
    where.push("b.status IN ('draft', 'sent')");
  }
  if (filters.q && filters.q.trim()) {
    // One search across the brief's own words and its client's name, so a member
    // who remembers the client but not the title still finds it.
    params.push(`%${filters.q.trim()}%`);
    where.push(`(b.title ILIKE $${params.length} OR b.objective ILIKE $${params.length}
                 OR b.brief_number ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }

  params.push(Math.min(Math.max(filters.limit ?? 100, 1), 200));
  const limit = params.length;

  const { rows } = await query<BriefRow>(
    `${BRIEF_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY b.created_at DESC, b.brief_number DESC
      LIMIT $${limit}`,
    params,
  );
  return rows.map(toAgencyBrief);
}

/** One brief, or `brief_not_found` — never another tenant's. */
export async function loadAgencyBrief(businessId: string, briefId: string): Promise<AgencyBrief> {
  const { rows } = await query<BriefRow>(
    `${BRIEF_SELECT}
      WHERE b.id = $1 AND b.business_id = $2`,
    [briefId, businessId],
  );
  const row = rows[0];
  if (!row) throw new AgencyBriefError("brief_not_found");
  return toAgencyBrief(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Writes a new brief as a draft.
 *
 * The number comes from `nextBusinessRegisterNumber`, which takes an advisory
 * transaction lock — hence the transaction, and hence this being the only place a
 * brief's number is ever chosen. Numbering outside a transaction would hand two
 * concurrent requests the same `BR-` number and let the unique index turn the
 * race into a 500.
 */
export async function createAgencyBrief(
  businessId: string,
  actor: AgencyBriefActor,
  input: AgencyBriefInput,
): Promise<AgencyBrief> {
  const partyId = requireClientId(input);
  const title = readTextField(input, "title", AGENCY_BRIEF_TITLE_MAX_LENGTH, "text_too_long");
  if (!title || title.trim() === "") throw new AgencyBriefError("title_required");

  const objective = readTextField(input, "objective", AGENCY_BRIEF_TEXT_MAX_LENGTH, "text_too_long") ?? "";
  const audience = readTextField(input, "audience", AGENCY_BRIEF_TEXT_MAX_LENGTH, "text_too_long") ?? "";
  const acceptanceCriteria =
    readTextField(input, "acceptanceCriteria", AGENCY_BRIEF_TEXT_MAX_LENGTH, "text_too_long") ?? "";
  const note = readTextField(input, "note", AGENCY_BRIEF_NOTE_MAX_LENGTH, "text_too_long") ?? "";
  const approverName =
    readTextField(input, "approverName", AGENCY_BRIEF_NAME_MAX_LENGTH, "text_too_long") ?? "";

  const channels = normalizeAgencyBriefChannels(input.channels);
  if (channels === null) throw new AgencyBriefError("invalid_channel");
  const deliverables = normalizeAgencyBriefDeliverables(input.deliverables);
  if (deliverables === null) throw new AgencyBriefError("invalid_deliverable");

  const budgetRial = "budgetRial" in input ? normalizeAgencyBriefBudget(input.budgetRial) : null;
  if ("budgetRial" in input && input.budgetRial !== null && input.budgetRial !== undefined
      && input.budgetRial !== "" && budgetRial === null) {
    throw new AgencyBriefError("invalid_budget");
  }

  const startDate = readDateInput(input.startDate, "start_date");
  const deliveryDate = readDateInput(input.deliveryDate, "delivery_date");
  if (startDate && deliveryDate && deliveryDate < startDate) {
    throw new AgencyBriefError("invalid_period");
  }

  const dealId = readOptionalId(input, "dealId") ?? null;
  const projectId = readOptionalId(input, "projectId") ?? null;
  const approverPartyId = readOptionalId(input, "approverPartyId") ?? null;

  const id = await withTenantTransaction(businessId, async (client) => {
    const briefNumber = await nextBusinessRegisterNumber(
      "agency_client_briefs",
      businessId,
      BRIEF_NUMBER_PREFIX,
    );
    const { rows } = await client.query(
      `INSERT INTO agency_client_briefs (
         business_id, brief_number, party_id, deal_id, project_id, title,
         objective, audience, channels, deliverables, budget_rial,
         start_date, delivery_date, acceptance_criteria, note,
         approver_party_id, approver_name, created_by, created_by_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        businessId,
        briefNumber,
        partyId,
        dealId,
        projectId,
        title,
        objective,
        audience,
        channels,
        JSON.stringify(deliverables),
        budgetRial,
        startDate,
        deliveryDate,
        acceptanceCriteria,
        note,
        approverPartyId,
        approverName,
        actor.userId ?? null,
        actor.name ?? "",
      ],
    );
    return String(rows[0].id);
  });

  return loadAgencyBrief(businessId, id);
}

/**
 * Edits what is still editable.
 *
 * A frozen brief is refused field by field rather than partially applied: the
 * caller asked for a change and the answer is that nothing changed. The database
 * would refuse the same write, but answering here means the member gets
 * `brief_frozen` instead of a constraint violation.
 */
export async function updateAgencyBrief(
  businessId: string,
  briefId: string,
  _actor: AgencyBriefActor,
  patch: AgencyBriefInput,
): Promise<AgencyBrief> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, start_date, delivery_date
         FROM agency_client_briefs
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [briefId, businessId],
    );
    const current = rows[0] as { status: string; start_date: unknown; delivery_date: unknown } | undefined;
    if (!current) throw new AgencyBriefError("brief_not_found");
    const status: AgencyBriefStatus = isAgencyBriefStatus(current.status) ? current.status : "draft";

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if ("title" in patch) {
      const title = readTextField(patch, "title", AGENCY_BRIEF_TITLE_MAX_LENGTH, "text_too_long");
      if (!title || title.trim() === "") throw new AgencyBriefError("title_required");
      push("title", title);
    }
    for (const [key, column, max] of [
      ["objective", "objective", AGENCY_BRIEF_TEXT_MAX_LENGTH],
      ["audience", "audience", AGENCY_BRIEF_TEXT_MAX_LENGTH],
      ["acceptanceCriteria", "acceptance_criteria", AGENCY_BRIEF_TEXT_MAX_LENGTH],
      ["note", "note", AGENCY_BRIEF_NOTE_MAX_LENGTH],
      ["approverName", "approver_name", AGENCY_BRIEF_NAME_MAX_LENGTH],
    ] as const) {
      const value = readTextField(patch, key, max, "text_too_long");
      if (value !== undefined) push(column, value);
    }

    if ("channels" in patch) {
      const channels = normalizeAgencyBriefChannels(patch.channels);
      if (channels === null) throw new AgencyBriefError("invalid_channel");
      push("channels", channels);
    }
    if ("deliverables" in patch) {
      const deliverables = normalizeAgencyBriefDeliverables(patch.deliverables);
      if (deliverables === null) throw new AgencyBriefError("invalid_deliverable");
      push("deliverables", JSON.stringify(deliverables));
    }
    if ("budgetRial" in patch) {
      const budgetRial = normalizeAgencyBriefBudget(patch.budgetRial);
      if (patch.budgetRial !== null && patch.budgetRial !== undefined && patch.budgetRial !== ""
          && budgetRial === null) {
        throw new AgencyBriefError("invalid_budget");
      }
      push("budget_rial", budgetRial);
    }

    // Dates are validated against each other using the *resulting* pair, so
    // patching only one of them still cannot produce an impossible window.
    let startDate = readDate(current.start_date);
    let deliveryDate = readDate(current.delivery_date);
    if ("startDate" in patch) {
      startDate = readDateInput(patch.startDate, "start_date");
      push("start_date", startDate);
    }
    if ("deliveryDate" in patch) {
      deliveryDate = readDateInput(patch.deliveryDate, "delivery_date");
      push("delivery_date", deliveryDate);
    }
    if (startDate && deliveryDate && deliveryDate < startDate) {
      throw new AgencyBriefError("invalid_period");
    }

    for (const [key, column] of [
      ["dealId", "deal_id"],
      ["projectId", "project_id"],
      ["approverPartyId", "approver_party_id"],
    ] as const) {
      const value = readOptionalId(patch, key);
      if (value !== undefined) push(column, value);
    }
    if ("partyId" in patch) push("party_id", requireClientId(patch));

    if (sets.length === 0) return loadAgencyBrief(businessId, briefId);

    // The freeze is enforced here as well as by the trigger, so the answer is a
    // Persian sentence naming the state rather than a constraint violation. The
    // pointers are excluded for the reason the migration gives: they say where the
    // work lives, and the project normally arrives after confirmation.
    const frozenColumns = new Set([
      "title", "objective", "audience", "channels", "deliverables", "budget_rial",
      "start_date", "delivery_date", "acceptance_criteria", "approver_party_id",
      "approver_name", "party_id",
    ]);
    if (isAgencyBriefFrozen(status)) {
      const attempted = sets
        .map((set) => set.split(" = ")[0])
        .filter((column) => frozenColumns.has(column));
      if (attempted.length > 0) throw new AgencyBriefError("brief_frozen");
    }

    params.push(briefId, businessId);
    await client.query(
      `UPDATE agency_client_briefs
          SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND business_id = $${params.length}`,
      params,
    );
  }).then(() => loadAgencyBrief(businessId, briefId));
}

/**
 * Moves a brief along its chain.
 *
 * Separate from the PATCH above because a transition is not a field edit: it
 * stamps `sent_at` or `confirmed_at`, and confirming attributes the confirmation
 * to a name. Routing it through "save the whole brief" would lose both, which is
 * the same argument the case and milestone status routes make.
 */
export async function applyAgencyBriefAction(
  businessId: string,
  briefId: string,
  _actor: AgencyBriefActor,
  action: unknown,
  input: { confirmedByName?: unknown } = {},
): Promise<AgencyBrief> {
  if (!isAgencyBriefAction(action)) throw new AgencyBriefError("invalid_action");

  await withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, status, objective, approver_name
         FROM agency_client_briefs
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [briefId, businessId],
    );
    const current = rows[0] as
      | { status: string; objective: string; approver_name: string }
      | undefined;
    if (!current) throw new AgencyBriefError("brief_not_found");
    const from: AgencyBriefStatus = isAgencyBriefStatus(current.status) ? current.status : "draft";
    const act = action as AgencyBriefAction;

    if (!canPerformAgencyBriefAction(from, act)) {
      throw new AgencyBriefError("invalid_transition");
    }
    const to = agencyBriefActionTarget(act);

    // Mirrors the table's own CHECK: sending a client a brief with no objective
    // asks them to confirm nothing.
    if (agencyBriefObjectiveRequired(to) && current.objective.trim() === "") {
      throw new AgencyBriefError("objective_required");
    }

    const sets: string[] = [`status = $1`];
    const params: unknown[] = [to];

    if (to === "sent" && from === "draft") {
      params.push(new Date().toISOString());
      sets.push(`sent_at = COALESCE(sent_at, $${params.length})`);
    }
    if (agencyBriefConfirmationNeedsName(act)) {
      // §A asks that the stakeholder be recorded, so a confirmation is attributed.
      // It falls back to the approver the brief already names: that person is who
      // the agency recorded as the client's decision-maker, and confirming without
      // naming anyone else is recording their confirmation.
      const raw = input.confirmedByName ?? current.approver_name;
      const name = normalizeAgencyBriefText(raw, AGENCY_BRIEF_NAME_MAX_LENGTH);
      if (!name) throw new AgencyBriefError("confirmer_required");
      params.push(new Date().toISOString(), name);
      sets.push(`confirmed_at = COALESCE(confirmed_at, $${params.length - 1})`);
      sets.push(`confirmed_by_name = $${params.length}`);
    }

    params.push(briefId, businessId);
    await client.query(
      `UPDATE agency_client_briefs
          SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND business_id = $${params.length}`,
      params,
    );
  });

  return loadAgencyBrief(businessId, briefId);
}

/**
 * Deletes a draft brief — the escape hatch for one written by mistake.
 *
 * Anything the client has seen is a record and is withdrawn instead, so this
 * returns `false` for a status the database would also refuse.
 */
export async function deleteAgencyBrief(businessId: string, briefId: string): Promise<boolean> {
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM agency_client_briefs WHERE id = $1 AND business_id = $2`,
    [briefId, businessId],
  );
  const current = rows[0];
  if (!current) return false;
  const status: AgencyBriefStatus = isAgencyBriefStatus(current.status) ? current.status : "draft";
  if (!isAgencyBriefDeletable(status)) throw new AgencyBriefError("brief_not_deletable");

  const { rowCount } = await query(
    `DELETE FROM agency_client_briefs WHERE id = $1 AND business_id = $2`,
    [briefId, businessId],
  );
  return (rowCount ?? 0) > 0;
}
