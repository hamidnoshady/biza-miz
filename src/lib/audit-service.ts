/**
 * Phase 20 Wave 6 — audit trail: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why;
 * the pure label/lookup rules it uses live in audit.ts and are covered by
 * audit.test.ts).
 *
 * `audit_log` (Phase 0) and its RLS policy already exist and already cover
 * every business — this wave only adds a reader, so it needs no migration.
 */
import { query } from "./db";

export interface AuditEntry {
  id: number;
  businessId: string;
  locationId: string | null;
  locationName: string | null;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
  /** Resolved from the payload's credentialId, for an `employee.session_created` row (Wave 5's first open question). */
  credentialType: string | null;
  /** Resolved from the payload's deviceId, for a row whose payload names one. */
  deviceLabel: string | null;
  /** Resolved from entity_id for an `entity = 'employee'` row (e.g. `employee.login_failed`, Wave 7) — the actor column is null for a pre-authentication failure, so this is the only way to say whose attempt it was. Also resolved for `entity = 'account'` rows (Wave 11), to "code — name" of the account the change was about, live off its *current* code/name (it may have been renamed again since). */
  entityName: string | null;
  /** Only meaningful when `action === "account.reparented"`: the account's parent immediately before/after the move, resolved live off `payload.beforeParentId`/`afterParentId` — null when that side had no parent (a top-level group account) or for any other row. */
  accountBeforeParentLabel: string | null;
  accountAfterParentLabel: string | null;
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  location_name: string | null;
  user_id: string | null;
  actor_name: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  payload: unknown;
  created_at: Date;
  credential_type: string | null;
  device_label: string | null;
  entity_name: string | null;
  account_before_parent_label: string | null;
  account_after_parent_label: string | null;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id),
    businessId: row.business_id,
    locationId: row.location_id,
    locationName: row.location_name,
    actorId: row.user_id,
    actorName: row.actor_name,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    credentialType: row.credential_type,
    deviceLabel: row.device_label,
    entityName: row.entity_name,
    accountBeforeParentLabel: row.account_before_parent_label,
    accountAfterParentLabel: row.account_after_parent_label,
  };
}

export interface AuditLogFilters {
  entity?: string;
  /** Narrows to one entity's own history — e.g. one account's rename/reparent/archive trail (Wave 11). */
  entityId?: string;
  actorId?: string;
  /** Wave 7 — narrows to one action, e.g. `employee.login_failed` for the security center's failed-attempts list, without the caller needing the broader entity filter's noise. */
  action?: string;
  /** Rows with id strictly less than this — the same "most recent first" cursor listShifts's LIMIT gets away without, but a security log is expected to grow past 200 rows quickly. */
  before?: number;
  limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * A text column cast to uuid for a join, answering NULL when the text is not
 * a uuid instead of raising `invalid input syntax for type uuid`.
 *
 * `audit_log.entity_id` is a **text** column, and not every writer puts a uuid
 * in it: `settings.mfa_policy.update` logs `'mfa.policy'` and
 * `settings.business.update` logs `'business'`. The joins below used to cast
 * it bare (`nullif(a.entity_id, '')::uuid`), and one such row — from a single
 * toggle of the manager-MFA switch — made `listAuditLog` throw, so the whole
 * audit tab 500'd on businesses that had one. The entity guard on the other
 * side of the `AND` does not save it: Postgres guarantees evaluation order
 * only inside a `CASE`, never across `AND` operands.
 */
function uuidOrNull(expression: string): string {
  return `CASE WHEN ${expression} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${expression}::uuid END`;
}

/**
 * The business's audit trail, most recent first — every action any wave of
 * this phase (and team-service.ts/branch-service.ts from earlier phases)
 * already writes to `audit_log`, now actually readable by an owner/manager.
 *
 * `credential_type`/`device_label` are resolved live via a join keyed off the
 * ids embedded in `payload` (only `employee.session_created` rows carry
 * them) rather than duplicated at write time, so a credential revoked or a
 * device renamed after the fact is reflected here without a backfill.
 *
 * `entity_name` (Wave 7) is resolved the same live way, but off `entity_id`
 * directly rather than a payload field — it's what lets the security
 * center's failed-login list say *whose* attempt it was even though
 * `employee.login_failed` rows have no actor (nothing was authenticated yet).
 */
export async function listAuditLog(
  businessId: string,
  filters: AuditLogFilters = {},
): Promise<AuditEntry[]> {
  const params: unknown[] = [businessId];
  const conditions: string[] = ["a.business_id = $1"];
  if (filters.entity) {
    params.push(filters.entity);
    conditions.push(`a.entity = $${params.length}`);
  }
  if (filters.entityId) {
    params.push(filters.entityId);
    conditions.push(`a.entity_id = $${params.length}`);
  }
  if (filters.actorId) {
    params.push(filters.actorId);
    conditions.push(`a.user_id = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    conditions.push(`a.action = $${params.length}`);
  }
  if (filters.before) {
    params.push(filters.before);
    conditions.push(`a.id < $${params.length}`);
  }
  const requestedLimit = Number.isFinite(filters.limit) ? (filters.limit as number) : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
  params.push(limit);

  const { rows } = await query<AuditRow>(
    `SELECT a.id, a.business_id, a.location_id, l.name AS location_name,
            a.user_id, u.full_name AS actor_name,
            a.action, a.entity, a.entity_id, a.payload, a.created_at,
            ec.credential_type::text AS credential_type,
            d.label AS device_label,
            /* entity_name falls back to the snapshot stored in the payload when
               the account row no longer exists (hard delete — issue #824 §5).
               account.deleted always carries code+name in its payload; rename/
               reparent/archive records still resolve live names. */
            COALESCE(
              eu.full_name,
              ea.code || ' — ' || ea.name,
              CASE
                WHEN a.entity = 'account' AND a.payload IS NOT NULL AND jsonb_typeof(a.payload) = 'object'
                THEN COALESCE(a.payload->>'code', '') || CASE WHEN a.payload->>'code' IS NOT NULL AND a.payload->>'name' IS NOT NULL THEN ' — ' ELSE '' END || COALESCE(a.payload->>'name', '')
                ELSE NULL
              END
            ) AS entity_name,
            /* Parent labels also fall back to the payload's parentLabel when
               the parent row has been deleted or never existed. */
            COALESCE(
              ebp.code || ' — ' || ebp.name,
              a.payload->>'beforeParentLabel'
            ) AS account_before_parent_label,
            COALESCE(
              eap.code || ' — ' || eap.name,
              a.payload->>'afterParentLabel'
            ) AS account_after_parent_label
       FROM audit_log a
       LEFT JOIN locations l ON l.id = a.location_id AND l.business_id = a.business_id
       LEFT JOIN users u ON u.id = a.user_id AND u.business_id = a.business_id
       LEFT JOIN employee_credentials ec
              ON ec.business_id = a.business_id
             AND ec.id = ${uuidOrNull("nullif(a.payload->>'credentialId', '')")}
       LEFT JOIN pos_devices d
              ON d.business_id = a.business_id
             AND d.id = ${uuidOrNull("nullif(a.payload->>'deviceId', '')")}
       LEFT JOIN users eu
              ON a.entity = 'employee'
             AND eu.id = ${uuidOrNull("nullif(a.entity_id, '')")}
       LEFT JOIN accounts ea
              ON a.entity = 'account'
             AND ea.business_id = a.business_id
             AND ea.id = ${uuidOrNull("nullif(a.entity_id, '')")}
       LEFT JOIN accounts ebp
              ON a.entity = 'account'
             AND ebp.business_id = a.business_id
             AND ebp.id = ${uuidOrNull("nullif(a.payload->>'beforeParentId', '')")}
       LEFT JOIN accounts eap
              ON a.entity = 'account'
             AND eap.business_id = a.business_id
             AND eap.id = ${uuidOrNull("nullif(a.payload->>'afterParentId', '')")}
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toEntry);
}
