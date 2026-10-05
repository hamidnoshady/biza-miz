/**
 * The CRM's audit trail — a narrow log of decisions a person may have to
 * explain.
 *
 * ## What this is not
 *
 * It is **not** a generic event bus, and it is deliberately not a second copy
 * of the timeline. The customer timeline is a *mapping* over the tables that
 * already own each fact (`customer-timeline-service.ts`), and that stays true:
 * an order is shown by reading `orders`, not by reading a copy of an order.
 *
 * What the timeline cannot answer is "who decided this, and why". A stage
 * moved from Proposal to Lost; a lead was converted onto an existing customer
 * rather than a new one; an ambiguous WooCommerce identity was resolved onto
 * this party. Those are *judgements*, they leave no natural row behind, and
 * six months later somebody will ask. That is the whole scope of this table.
 *
 * ## The rules
 *
 * - **Append-only.** Nothing in the app issues an UPDATE or DELETE against it.
 * - **Stable actor ids where they exist.** `actor_user_id` is the membership;
 *   `actor_name` is the display-name snapshot beside it, because a name may be
 *   corrected later and the audit must still read as it did.
 * - **Never on the critical path.** `recordCrmAudit` swallows its own failure.
 *   A merge, a conversion or a consent change must not fail because the audit
 *   insert did — the operation is what the user asked for, and losing an audit
 *   row is a smaller harm than losing the operation. Consent is the one
 *   exception, and it has its own dedicated append-only table
 *   (`crm_consent_events`) written transactionally with the change.
 *
 * This module is the write half **and**, since the «سابقهٔ تصمیم‌ها» screen
 * shipped, the read half too. The reader below is deliberately narrow: it
 * returns the appended rows, filtered, newest first. It cannot edit them, for
 * the same reason nothing else can — the table is evidence.
 *
 * The consent register remains its own thing. `crm_consent_events` is the legal
 * history of who may be contacted and it is served by the consent screen; this
 * log records *decisions about records*, and folding the two together would
 * bury a legal record inside a support tool.
 */

import { query } from "./db";
import { CRM_AUDIT_ENTITY_TYPES } from "./crm-shared";
import { isUuid } from "./uuid";

/**
 * The kinds of decision worth recording. A closed vocabulary rather than free
 * text so reports and filters can be written against it.
 */
const CRM_AUDIT_KINDS = [
  "lead.created",
  "lead.status_changed",
  "lead.converted",
  "deal.created",
  "deal.stage_changed",
  "deal.owner_changed",
  "deal.sales_document_linked",
  "case.created",
  "case.status_changed",
  "case.assigned",
  "case.reopened",
  "consent.changed",
  "party.merged",
  "party.owner_changed",
  "external.reconciled",
  "external.conflict_resolved",
  "segment.changed",
  "import.committed",
  "export.generated",
  // Configuration decisions. A field definition shapes what every record can
  // record, and archiving one stops a question being asked of anybody — worth
  // a name against it even though no customer data moves.
  "custom_field.created",
  "custom_field.archived",
  // Shaping the pipeline changes what every open deal is measured against, and
  // the stage vocabulary is the spine of the whole forecast — a decision at
  // least as consequential as renaming a field, and recorded as its own kind
  // rather than as the `deal.stage_changed` of a deal that does not exist.
  "pipeline.created",
  "pipeline.updated",
  "pipeline.stages_changed",
  "relationship.linked",
  "relationship.unlinked",
  // An automation is a rule that acts on records without being watched. Writing
  // one is at least as consequential as reshuffling the pipeline, and telling
  // Growth that a customer's state changed is a decision made about a person —
  // both are worth a name and a date against them. The firing of a rule is not
  // logged here: `crm_automation_runs` is the append-only record of that, and
  // duplicating every run into the audit trail would bury the judgements.
  "automation.config_changed",
  "automation.signal_growth",
] as const;

export type CrmAuditKind = (typeof CRM_AUDIT_KINDS)[number];

export interface CrmAuditInput {
  businessId: string;
  kind: CrmAuditKind;
  entityType: CrmAuditEntityType;
  entityId?: string | null;
  /** The customer this decision was about, when there is one. */
  partyId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  actorUserId?: string | null;
  actorName?: string;
}

/**
 * Append one audit event.
 *
 * Never throws: see the file comment. The caller's operation has already
 * happened (or is about to) and must not be undone by a logging failure.
 */
export async function recordCrmAudit(input: CrmAuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO crm_audit_events
         (business_id, kind, entity_type, entity_id, party_id, summary, detail, actor_user_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        input.businessId,
        input.kind,
        input.entityType,
        input.entityId ?? null,
        input.partyId ?? null,
        input.summary.slice(0, 500),
        JSON.stringify(input.detail ?? {}),
        input.actorUserId ?? null,
        (input.actorName ?? "").slice(0, 120),
      ],
    );
  } catch (error) {
    // Logged, not raised. An audit row is evidence about an operation, not the
    // operation — and a merge that rolled back because its log line failed
    // would be a far worse bug than a missing log line.
    console.error("crm audit write failed", input.kind, error);
  }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface CrmAuditEvent extends Record<string, unknown> {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  partyId: string | null;
  partyName: string | null;
  summary: string;
  detail: Record<string, unknown>;
  actorUserId: string | null;
  actorName: string;
  createdAt: string;
}

/** The filters the audit screen offers. Every one is optional. */
export interface CrmAuditQuery {
  /** Closed vocabulary — an unknown kind is ignored rather than passed through. */
  kind?: string;
  entityType?: string;
  entityId?: string;
  /** A membership id. `unattributed` selects rows with no actor. */
  actorUserId?: string;
  partyId?: string;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  /** Free-text search over the summary. */
  q?: string;
  limit?: number;
}

export interface CrmAuditPage {
  events: CrmAuditEvent[];
  /** `count(*)` for the same filters, not the page length. */
  total: number;
  /** The distinct actors that appear in this business's log, for the filter menu. */
  actors: { userId: string; name: string; count: number }[];
  /** The kinds actually present, with counts — a menu of what happened, not of what could. */
  kinds: { kind: string; count: number }[];
}

/**
 * Entity types the reader will filter on. Unknown values are dropped.
 *
 * The list itself lives in `crm-shared.ts`, because the *reader*'s filter menu
 * must offer exactly the types the *writer* may record — two lists that drifted
 * meant a decision could be logged under a type nobody could filter for.
 */
export type CrmAuditEntityType = (typeof CRM_AUDIT_ENTITY_TYPES)[number];

export function isCrmAuditEntityType(value: string): value is CrmAuditEntityType {
  return (CRM_AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Kinds the reader will filter on. The write half owns this list. */
export function isCrmAuditKind(value: string): value is CrmAuditKind {
  return (CRM_AUDIT_KINDS as readonly string[]).includes(value);
}

/**
 * Read the decision log, newest first.
 *
 * `total` is a separate `count(*)` rather than `events.length`: the screen
 * prints «۲۴۰ رویداد» next to the page it is showing, and reporting the page
 * length as the total is the exact bug the CRM overview's segment counter had.
 *
 * The filter values are compared, never interpolated — an unrecognised `kind`
 * or `entityType` is dropped rather than handed to the database, so a caller
 * cannot use this reader to widen its own query.
 */
export async function listCrmAuditEvents(
  businessId: string,
  filters: CrmAuditQuery = {},
): Promise<CrmAuditPage> {
  const params: unknown[] = [businessId];
  const where: string[] = ["a.business_id = $1"];

  if (filters.kind && isCrmAuditKind(filters.kind)) {
    params.push(filters.kind);
    where.push(`a.kind = $${params.length}`);
  }
  if (filters.entityType && isCrmAuditEntityType(filters.entityType)) {
    params.push(filters.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (filters.entityId && isUuid(filters.entityId)) {
    params.push(filters.entityId);
    where.push(`a.entity_id = $${params.length}`);
  }
  if (filters.partyId && isUuid(filters.partyId)) {
    params.push(filters.partyId);
    where.push(`a.party_id = $${params.length}`);
  }
  if (filters.actorUserId === "unattributed") {
    where.push("a.actor_user_id IS NULL");
  } else if (filters.actorUserId && isUuid(filters.actorUserId)) {
    params.push(filters.actorUserId);
    where.push(`a.actor_user_id = $${params.length}`);
  }
  const from = isIsoDate(filters.from) ? filters.from : null;
  if (from) {
    params.push(from);
    where.push(`a.created_at >= $${params.length}::date`);
  }
  // `to` is inclusive of the whole day, which is why this is a `< next day`
  // rather than a `<=`: a timestamp is never equal to a bare date.
  const to = isIsoDate(filters.to) ? filters.to : null;
  if (to) {
    params.push(to);
    where.push(`a.created_at < ($${params.length}::date + interval '1 day')`);
  }
  const q = filters.q?.trim().slice(0, 120);
  if (q) {
    params.push(`%${q}%`);
    where.push(`(a.summary ILIKE $${params.length} OR a.actor_name ILIKE $${params.length})`);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const filterSql = where.join(" AND ");

  params.push(limit);
  const limitIndex = params.length;

  const [{ rows: eventRows }, { rows: countRows }, { rows: actorRows }, { rows: kindRows }] =
    await Promise.all([
      query<CrmAuditEvent>(
        `SELECT a.id, a.kind, a.entity_type AS "entityType", a.entity_id AS "entityId",
                a.party_id AS "partyId", p.name AS "partyName", a.summary, a.detail,
                a.actor_user_id AS "actorUserId", a.actor_name AS "actorName",
                a.created_at AS "createdAt"
           FROM crm_audit_events a
           LEFT JOIN parties p ON p.id = a.party_id
          WHERE ${filterSql}
          ORDER BY a.created_at DESC, a.id
          LIMIT $${limitIndex}`,
        params,
      ),
      query<{ total: string }>(
        `SELECT count(*)::text AS total FROM crm_audit_events a WHERE ${filterSql}`,
        params.slice(0, limitIndex - 1),
      ),
      // Deliberately unfiltered by the date/kind filters: they are the menus
      // that let somebody else *reach* a filter, and a menu that shrinks to the
      // selection already made cannot be used to change it.
      query<{ userId: string | null; name: string; count: string }>(
        `SELECT a.actor_user_id AS "userId",
                coalesce(nullif(max(a.actor_name), ''), 'بی‌نام') AS name,
                count(*)::text AS count
           FROM crm_audit_events a
          WHERE a.business_id = $1
          GROUP BY a.actor_user_id
          ORDER BY count DESC
          LIMIT 40`,
        [businessId],
      ),
      query<{ kind: string; count: string }>(
        `SELECT a.kind, count(*)::text AS count
           FROM crm_audit_events a
          WHERE a.business_id = $1
          GROUP BY a.kind
          ORDER BY count DESC
          LIMIT 60`,
        [businessId],
      ),
    ]);

  return {
    events: eventRows,
    total: Number(countRows[0]?.total ?? 0),
    actors: actorRows.map((row) => ({
      userId: row.userId ?? "unattributed",
      name: row.name,
      count: Number(row.count),
    })),
    kinds: kindRows.map((row) => ({ kind: row.kind, count: Number(row.count) })),
  };
}

function isIsoDate(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
