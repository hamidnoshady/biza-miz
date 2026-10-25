/**
 * Per-service data retention and automatic destruction (issue #1041 §D).
 *
 * The policy is Superadmin-owned: one row per service in
 * `service_retention_policies`, optionally overridden for one business in
 * `business_service_retention_overrides`. Durations are days; "keep forever"
 * is the explicit `autoPurgeEnabled = false` choice, and it is the default — an
 * upgrade can never start deleting data that predates this feature.
 *
 * The clock only starts on a *customer* disable (`activation-service.ts`
 * `disableService`). A suspension — no credit, outage, maintenance, legal hold
 * — never sets a deadline and never queues a purge.
 *
 * The worker is deliberately conservative:
 *
 *   * it locks the queue row and the activation row, re-checks that the service
 *     is still disabled and the deadline has actually passed, and cancels
 *     itself if the customer re-enabled;
 *   * it deletes ONLY datasets the identity-specific ownership manifest
 *     classifies as `owned` and `delete`: wizard state for every service and a
 *     reviewed CRM-only subset whose exact tenant scope is verified;
 *   * it journals every planned target, including the ones it refuses to touch;
 *   * it records the run as `partial` while any dataset is blocked pending the
 *     reviewed ownership manifest (#926 media, #903 backups), because a purge
 *     may only claim completion for the scope it actually satisfied.
 *
 * Protected rows — the activation record, setup-paid evidence, wallet ledger,
 * invoices and usage events — are never deleted, so a later re-activation keeps
 * its once-paid commercial history.
 */
import type { PoolClient } from "pg";
import { query, withoutTenantScope, withTenant, withTenantTransaction } from "../db";
import {
  NO_AUTO_DELETE_POLICY,
  OWNED_PURGE_ENTRIES,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  isServiceKey,
  normalizeRetentionPolicy,
  purgeBlockReason,
  purgeManifestFor,
  purgePlanStatus,
  retentionWarningAt,
  serviceLabel,
  type PurgeScopeEntry,
  type RetentionPolicy,
  type ServiceKind,
  type ServiceState,
} from "./catalog";
import { recordNotification } from "../notification-events";

// ---------------------------------------------------------------------------
// Policy reads and writes
// ---------------------------------------------------------------------------

export interface RetentionPolicyRow extends RetentionPolicy {
  kind: ServiceKind;
  key: string;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface RetentionDbRow {
  [key: string]: unknown;
  service_kind: string;
  service_key: string;
  auto_purge_enabled: boolean;
  retention_days: number | null;
  notification_lead_days: number;
  export_grace_days: number;
  policy_version: number;
  note: string | null;
  updated_by: string | null;
  updated_at: Date | string | null;
}

function toPolicyRow(row: RetentionDbRow, source: RetentionPolicy["source"]): RetentionPolicyRow {
  return {
    kind: row.service_kind as ServiceKind,
    key: row.service_key,
    autoPurgeEnabled: row.auto_purge_enabled,
    retentionDays: row.retention_days,
    notificationLeadDays: row.notification_lead_days,
    exportGraceDays: row.export_grace_days,
    policyVersion: row.policy_version,
    source,
    note: row.note,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : new Date(row.updated_at).toISOString()
      : null,
  };
}

const POLICY_COLUMNS = `service_kind, service_key, auto_purge_enabled, retention_days,
       notification_lead_days, export_grace_days, policy_version, note,
       updated_by, updated_at`;

/**
 * The override table deliberately stores only what differs per business — the
 * window and its enabled state. Notification lead time and export grace stay a
 * platform decision, so an operator cannot shorten a customer's warning by
 * pinning a business.
 */
const OVERRIDE_COLUMNS = `service_kind, service_key, auto_purge_enabled, retention_days,
       policy_version, note, updated_by, updated_at`;

function toOverridePolicyRow(
  row: RetentionDbRow,
  platform: RetentionPolicyRow | null,
): RetentionPolicyRow {
  return {
    ...toPolicyRow(row, "business"),
    notificationLeadDays: platform?.notificationLeadDays ?? 7,
    exportGraceDays: platform?.exportGraceDays ?? 7,
  };
}

/** Every platform-wide policy row (the console's per-service table). */
export async function listRetentionPolicies(): Promise<RetentionPolicyRow[]> {
  const { rows } = await query<RetentionDbRow>(
    `SELECT ${POLICY_COLUMNS} FROM service_retention_policies
      ORDER BY service_kind, service_key`,
  );
  return rows.map((row) => toPolicyRow(row, "platform"));
}

export async function getPlatformRetentionPolicy(
  kind: ServiceKind,
  key: string,
): Promise<RetentionPolicyRow | null> {
  const { rows } = await query<RetentionDbRow>(
    `SELECT ${POLICY_COLUMNS} FROM service_retention_policies
      WHERE service_kind = $1 AND service_key = $2`,
    [kind, key],
  );
  return rows[0] ? toPolicyRow(rows[0], "platform") : null;
}

/**
 * The policy actually in force for one business + service: the audited
 * per-business override first, then the platform row, then "keep everything".
 */
export async function effectiveRetentionPolicy(
  businessId: string,
  kind: ServiceKind,
  key: string,
): Promise<RetentionPolicy> {
  return withTenant(businessId, async () => {
    const { rows: overrideRows } = await query<RetentionDbRow>(
      `SELECT ${OVERRIDE_COLUMNS} FROM business_service_retention_overrides
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3`,
      [businessId, kind, key],
    );
    const platform = await getPlatformRetentionPolicy(kind, key);
    if (overrideRows[0]) return toOverridePolicyRow(overrideRows[0], platform);
    return platform ?? NO_AUTO_DELETE_POLICY;
  });
}

export interface SaveRetentionPolicyInput {
  kind: ServiceKind;
  key: string;
  autoPurgeEnabled: boolean;
  retentionDays?: number | null;
  notificationLeadDays?: number;
  exportGraceDays?: number;
  note?: string | null;
  adminId?: string | null;
}

export class RetentionPolicyWriteError extends Error {
  constructor(public code: "unknown_service" | "invalid_retention_days" | "indefinite_requires_disabled_purge") {
    super(code);
  }
}

/** Publish the platform policy for one service (super-admin, audited). */
export async function saveRetentionPolicy(
  input: SaveRetentionPolicyInput,
): Promise<RetentionPolicyRow> {
  if (!isServiceKey(input.kind, input.key)) {
    throw new RetentionPolicyWriteError("unknown_service");
  }
  let policy: RetentionPolicy;
  try {
    policy = normalizeRetentionPolicy({
      autoPurgeEnabled: input.autoPurgeEnabled,
      retentionDays: input.retentionDays,
      notificationLeadDays: input.notificationLeadDays,
      exportGraceDays: input.exportGraceDays,
      source: "platform",
    });
  } catch (error) {
    const code =
      error instanceof Error && error.message === "invalid_retention_days"
        ? "invalid_retention_days"
        : "indefinite_requires_disabled_purge";
    throw new RetentionPolicyWriteError(code);
  }

  const { rows } = await query<RetentionDbRow>(
    `INSERT INTO service_retention_policies
       (service_kind, service_key, auto_purge_enabled, retention_days,
        notification_lead_days, export_grace_days, policy_version, note,
        updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8, now())
     ON CONFLICT (service_kind, service_key) DO UPDATE
       SET auto_purge_enabled = EXCLUDED.auto_purge_enabled,
           retention_days = EXCLUDED.retention_days,
           notification_lead_days = EXCLUDED.notification_lead_days,
           export_grace_days = EXCLUDED.export_grace_days,
           policy_version = service_retention_policies.policy_version + 1,
           note = EXCLUDED.note,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING ${POLICY_COLUMNS}`,
    [
      input.kind,
      input.key,
      policy.autoPurgeEnabled,
      policy.retentionDays,
      policy.notificationLeadDays,
      policy.exportGraceDays,
      input.note?.trim() || null,
      input.adminId ?? null,
    ],
  );
  return toPolicyRow(rows[0], "platform");
}

export interface SaveRetentionOverrideInput extends Omit<SaveRetentionPolicyInput, "adminId"> {
  businessId: string;
  adminId?: string | null;
}

/**
 * Pin one business's retention window for one service. This is the audited
 * override issue #1041 §D asks for; `clearRetentionOverride` returns the
 * business to the platform policy.
 */
export async function saveBusinessRetentionOverride(
  input: SaveRetentionOverrideInput,
): Promise<RetentionPolicyRow> {
  if (!isServiceKey(input.kind, input.key)) {
    throw new RetentionPolicyWriteError("unknown_service");
  }
  const policy = normalizeRetentionPolicy({
    autoPurgeEnabled: input.autoPurgeEnabled,
    retentionDays: input.retentionDays,
    notificationLeadDays: input.notificationLeadDays,
    exportGraceDays: input.exportGraceDays,
    source: "business",
  });
  const { rows } = await withoutTenantScope("platform", () =>
    query<RetentionDbRow>(
    `INSERT INTO business_service_retention_overrides
       (business_id, service_kind, service_key, auto_purge_enabled,
        retention_days, policy_version, note, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7, now())
     ON CONFLICT (business_id, service_kind, service_key) DO UPDATE
       SET auto_purge_enabled = EXCLUDED.auto_purge_enabled,
           retention_days = EXCLUDED.retention_days,
           policy_version = business_service_retention_overrides.policy_version + 1,
           note = EXCLUDED.note,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING ${OVERRIDE_COLUMNS}`,
    [
      input.businessId,
      input.kind,
      input.key,
      policy.autoPurgeEnabled,
      policy.retentionDays,
      input.note?.trim() || null,
      input.adminId ?? null,
    ],
    ),
  );
  const platform = await getPlatformRetentionPolicy(input.kind, input.key);
  return toOverridePolicyRow(rows[0], platform);
}

export async function clearBusinessRetentionOverride(
  businessId: string,
  kind: ServiceKind,
  key: string,
): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(
      `DELETE FROM business_service_retention_overrides
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3`,
      [businessId, kind, key],
    ),
  );
}

// ---------------------------------------------------------------------------
// Queue and journal reads
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pre-expiry warnings
// ---------------------------------------------------------------------------

export interface RetentionWarningRun {
  /** Activations whose deadline is inside the horizon and still ahead. */
  scanned: number;
  /** Notifications actually written this pass (new facts only). */
  notified: number;
}

/** How far ahead the scan bothers to look. Longest supported lead is a year. */
const WARNING_HORIZON_DAYS = 400;

/**
 * Tells the customer, once, that a disabled service's data is about to be
 * destroyed (issue #1041 §D: "Warn business owner before expiry").
 *
 * The warning instant is a *policy* fact — `retentionDeadline −
 * notificationLeadDays` — not a scheduler fact, so a policy change moves it and
 * a restart cannot lose it. Idempotency is the notification table's own
 * `(business_id, dedupe_key)` unique: the key names the fact
 * (`service-retention:<activation>:<deadline>`), so a re-run writes nothing, and
 * a *new* deadline after a re-disable is a new fact that may warn again.
 *
 * Only states a customer disable produces are scanned; a suspension never has a
 * deadline at all (see `disableService`), which is what keeps "low credit" from
 * ever looking like "your data is about to be deleted".
 */
export async function notifyRetentionWarnings(
  now: Date = new Date(),
  limit = 200,
): Promise<RetentionWarningRun> {
  const nowIso = now.toISOString();
  const { rows } = await withoutTenantScope("platform", () =>
    query<{
      id: string;
      business_id: string;
      service_kind: string;
      service_key: string;
      label: string | null;
      retention_deadline: Date | string;
    }>(
      `SELECT id, business_id, service_kind, service_key, label, retention_deadline
         FROM business_service_activations
        WHERE retention_deadline IS NOT NULL
          AND data_purged_at IS NULL
          AND state IN ('disabled_retained', 'eligible_for_purge')
          AND retention_deadline > $1::timestamptz
          AND retention_deadline <= $1::timestamptz + make_interval(days => $3)
        ORDER BY retention_deadline
        LIMIT $2`,
      [nowIso, limit, WARNING_HORIZON_DAYS],
    ),
  );

  let notified = 0;
  for (const row of rows) {
    const deadline =
      row.retention_deadline instanceof Date
        ? row.retention_deadline.toISOString()
        : new Date(row.retention_deadline).toISOString();
    const policy = await effectiveRetentionPolicy(
      row.business_id,
      row.service_kind as ServiceKind,
      row.service_key,
    );
    const warningAt = retentionWarningAt(deadline, policy);
    if (!warningAt || Date.parse(warningAt) > now.getTime()) continue;

    const label = row.label?.trim() || serviceLabel(row.service_kind as ServiceKind, row.service_key);
    const inserted = await withTenant(row.business_id, () =>
      recordNotification({
        businessId: row.business_id,
        locationId: null,
        eventKey: "service.retention_expiring",
        severity: "important",
        title: `مهلت نگهداری دادهٔ «${label}» رو به پایان است`,
        body: `داده‌های این سرویس در ${deadline.slice(0, 10)} پاک می‌شود. فعال‌سازی دوباره پیش از آن، حذف را لغو می‌کند.`,
        url: "/settings/services",
        dedupeKey: `service-retention:${row.id}:${deadline}`,
        payload: {
          activationId: row.id,
          kind: row.service_kind,
          key: row.service_key,
          deadline,
          policyVersion: policy.policyVersion,
          policySource: policy.source,
        },
      }),
    );
    if (inserted) notified += 1;
  }
  return { scanned: rows.length, notified };
}

export interface PurgeQueueRow {
  id: string;
  businessId: string;
  activationId: string;
  kind: ServiceKind;
  key: string;
  scheduledAt: string;
  state: "scheduled" | "running" | "cancelled" | "completed" | "partial" | "failed" | "blocked";
  policySource: "platform" | "business";
  policyVersion: number;
  attempts: number;
  lastError: string | null;
}

interface PurgeQueueDbRow {
  [key: string]: unknown;
  id: string;
  business_id: string;
  activation_id: string;
  service_kind: string;
  service_key: string;
  scheduled_at: Date | string;
  state: PurgeQueueRow["state"];
  policy_source: "platform" | "business";
  policy_version: number;
  attempts: number;
  last_error: string | null;
}

function toQueueRow(row: PurgeQueueDbRow): PurgeQueueRow {
  return {
    id: row.id,
    businessId: row.business_id,
    activationId: row.activation_id,
    kind: row.service_kind as ServiceKind,
    key: row.service_key,
    scheduledAt:
      row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : new Date(row.scheduled_at).toISOString(),
    state: row.state,
    policySource: row.policy_source,
    policyVersion: row.policy_version,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export async function listServicePurgeQueue(businessId: string): Promise<PurgeQueueRow[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<PurgeQueueDbRow>(
      `SELECT id, business_id, activation_id, service_kind, service_key,
              scheduled_at, state, policy_source, policy_version, attempts, last_error
         FROM service_purge_queue
        WHERE business_id = $1
        ORDER BY scheduled_at`,
      [businessId],
    );
    return rows.map(toQueueRow);
  });
}

export interface PurgeJournalRow {
  id: string;
  dryRun: boolean;
  status: string;
  scope: PurgeScopeEntry[];
  reclaimed: Record<string, unknown>;
  detail: string | null;
  startedAt: string;
  completedAt: string | null;
}

interface PurgeJournalDbRow {
  [key: string]: unknown;
  id: string;
  dry_run: boolean;
  status: string;
  scope: PurgeScopeEntry[];
  reclaimed: Record<string, unknown>;
  detail: string | null;
  started_at: Date | string;
  completed_at: Date | string | null;
}

function toJournalRow(row: PurgeJournalDbRow): PurgeJournalRow {
  return {
    id: row.id,
    dryRun: row.dry_run,
    status: row.status,
    scope: row.scope ?? [],
    reclaimed: row.reclaimed ?? {},
    detail: row.detail,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    completedAt: row.completed_at
      ? row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : String(row.completed_at)
      : null,
  };
}

export async function listServicePurgeJournal(businessId: string): Promise<PurgeJournalRow[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<PurgeJournalDbRow>(
      `SELECT id, dry_run, status, scope, reclaimed, detail, started_at, completed_at
         FROM service_purge_journal
        WHERE business_id = $1
        ORDER BY started_at DESC
        LIMIT 100`,
      [businessId],
    );
    return rows.map(toJournalRow);
  });
}

/** The dry-run plan the console and the customer can preview at any time. */
export function servicePurgePlan(kind: ServiceKind, key?: string): PurgeScopeEntry[] {
  return purgeManifestFor(kind, key);
}

// ---------------------------------------------------------------------------
// The destruction worker
// ---------------------------------------------------------------------------

export interface PurgeRunEntry {
  activationId: string;
  kind: ServiceKind;
  key: string;
  outcome: "planned" | "completed" | "partial" | "blocked" | "skipped" | "cancelled" | "failed";
  reason?: string;
  reclaimed?: Record<string, number>;
}

export interface PurgeRunResult {
  dryRun: boolean;
  scanned: number;
  planned: number;
  completed: number;
  partial: number;
  blocked: number;
  skipped: number;
  cancelled: number;
  failed: number;
  entries: PurgeRunEntry[];
}

interface ActivationSnapshot {
  [key: string]: unknown;
  id: string;
  business_id: string;
  service_kind: string;
  service_key: string;
  runtime_instance_id: string;
  state: string;
  retention_deadline: Date | string | null;
}

const CRM_ELIGIBLE_DEAL = `d.business_id = $1
  AND d.order_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM ai_projects p WHERE p.business_id = $1 AND p.source_deal_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM workspace_project_links w WHERE w.business_id = $1 AND w.link_kind = 'deal' AND w.linked_id = d.id::text)
  AND NOT EXISTS (SELECT 1 FROM crm_leads l WHERE l.business_id = $1 AND l.converted_deal_id = d.id)`;
const CRM_ELIGIBLE_LEAD = `l.business_id = $1
  AND l.converted_party_id IS NULL AND l.converted_deal_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM platform_company_web_leads w WHERE w.business_id = $1 AND w.lead_id = l.id)`;

async function deleteAndVerify(
  client: PoolClient,
  dataset: string,
  deleteSql: string,
  remainingSql: string,
  values: unknown[],
): Promise<number> {
  const deleted = await client.query(deleteSql, values);
  const { rows } = await client.query<{ count: string }>(remainingSql, values);
  if (Number(rows[0]?.count ?? 0) !== 0) {
    throw new Error(`purge_verification_failed:${dataset}`);
  }
  return deleted.rowCount ?? 0;
}

/**
 * Static SQL whitelist for reviewed, service-owned datasets only. Order follows
 * the foreign-key dependencies in the CRM schema. Never construct a table name
 * from a service key or manifest value.
 */
async function executeOwnedPurgeDataset(
  client: PoolClient,
  activation: ActivationSnapshot,
  dataset: string,
): Promise<number> {
  const businessId = activation.business_id;
  if (dataset === "service.wizard_state") {
    return deleteAndVerify(
      client,
      dataset,
      `DELETE FROM business_service_wizard_state
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
          AND runtime_instance_id = $4`,
      `SELECT count(*)::text AS count FROM business_service_wizard_state
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
          AND runtime_instance_id = $4`,
      [businessId, activation.service_kind, activation.service_key, activation.runtime_instance_id],
    );
  }
  if (activation.service_kind !== "app" || activation.service_key !== "crm") {
    throw new Error(`unreviewed_purge_dataset:${dataset}`);
  }

  const businessScope = "WHERE business_id = $1";
  switch (dataset) {
    case "crm.activities": {
      const eligible = `a.business_id = $1 AND a.case_id IS NULL
        AND (a.deal_id IS NULL OR EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = a.deal_id AND ${CRM_ELIGIBLE_DEAL}))
        AND (a.lead_id IS NULL OR EXISTS (SELECT 1 FROM crm_leads l WHERE l.id = a.lead_id AND ${CRM_ELIGIBLE_LEAD}))`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_activities AS a WHERE ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_activities AS a WHERE ${eligible}`,
        [businessId],
      );
    }
    case "crm.deal_stage_history": {
      const eligible = `h.business_id = $1 AND EXISTS
        (SELECT 1 FROM crm_deals d WHERE d.id = h.deal_id AND ${CRM_ELIGIBLE_DEAL})`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_deal_stage_history AS h WHERE ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_deal_stage_history AS h WHERE ${eligible}`,
        [businessId],
      );
    }
    case "crm.custom_field_values_for_leads_and_deals": {
      const eligible = `v.business_id = $1 AND (
        (v.lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm_leads l WHERE l.id = v.lead_id AND ${CRM_ELIGIBLE_LEAD}))
        OR (v.deal_id IS NOT NULL AND EXISTS (SELECT 1 FROM crm_deals d WHERE d.id = v.deal_id AND ${CRM_ELIGIBLE_DEAL}))
      )`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_custom_field_values AS v WHERE ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_custom_field_values AS v WHERE ${eligible}`,
        [businessId],
      );
    }
    case "crm.automotive_lead_preferences": {
      const eligible = `EXISTS (SELECT 1 FROM crm_leads l WHERE l.id = crm_lead_vehicle_preferences.lead_id AND ${CRM_ELIGIBLE_LEAD})`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_lead_vehicle_preferences WHERE business_id = $1 AND ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_lead_vehicle_preferences WHERE business_id = $1 AND ${eligible}`,
        [businessId],
      );
    }
    case "crm.automotive_lead_vehicle_links": {
      const eligible = `EXISTS (SELECT 1 FROM crm_leads l WHERE l.id = crm_lead_vehicle_links.lead_id AND ${CRM_ELIGIBLE_LEAD})`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_lead_vehicle_links WHERE business_id = $1 AND ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_lead_vehicle_links WHERE business_id = $1 AND ${eligible}`,
        [businessId],
      );
    }
    case "crm.deals":
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_deals AS d WHERE ${CRM_ELIGIBLE_DEAL}`,
        `SELECT count(*)::text AS count FROM crm_deals AS d WHERE ${CRM_ELIGIBLE_DEAL}`,
        [businessId],
      );
    case "crm.leads":
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_leads AS l WHERE ${CRM_ELIGIBLE_LEAD}`,
        `SELECT count(*)::text AS count FROM crm_leads AS l WHERE ${CRM_ELIGIBLE_LEAD}`,
        [businessId],
      );
    case "crm.pipeline_stages": {
      const eligible = `s.business_id = $1
        AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.business_id = $1 AND d.pipeline_id = s.pipeline_id)
        AND NOT EXISTS (SELECT 1 FROM crm_deal_stage_history h WHERE h.business_id = $1 AND (h.from_stage_id = s.id OR h.to_stage_id = s.id))`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_pipeline_stages AS s WHERE ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_pipeline_stages AS s WHERE ${eligible}`,
        [businessId],
      );
    }
    case "crm.pipelines": {
      const eligible = `p.business_id = $1
        AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.business_id = $1 AND d.pipeline_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM crm_pipeline_stages s WHERE s.business_id = $1 AND s.pipeline_id = p.id)`;
      return deleteAndVerify(
        client,
        dataset,
        `DELETE FROM crm_pipelines AS p WHERE ${eligible}`,
        `SELECT count(*)::text AS count FROM crm_pipelines AS p WHERE ${eligible}`,
        [businessId],
      );
    }
    case "crm.saved_views":
      return deleteAndVerify(client, dataset, `DELETE FROM crm_saved_views ${businessScope}`, `SELECT count(*)::text AS count FROM crm_saved_views ${businessScope}`, [businessId]);
    case "crm.scoring_state":
      return deleteAndVerify(client, dataset, `DELETE FROM crm_scoring_state ${businessScope}`, `SELECT count(*)::text AS count FROM crm_scoring_state ${businessScope}`, [businessId]);
    case "crm.automations":
      return deleteAndVerify(client, dataset, `DELETE FROM crm_automations ${businessScope}`, `SELECT count(*)::text AS count FROM crm_automations ${businessScope}`, [businessId]);
    default:
      throw new Error(`unreviewed_purge_dataset:${dataset}`);
  }
}

/**
 * Run the due purges.
 *
 * `dryRun` writes a `planned` journal row and changes nothing else, so an
 * operator can see exactly what would be touched. A live run deletes the
 * `owned` datasets, verifies they are empty, journals the full manifest and
 * records the activation as purged (or partial, when the manifest still has a
 * blocked dataset).
 */
export async function runDueServicePurges(
  options: { now?: Date; dryRun?: boolean; limit?: number } = {},
): Promise<PurgeRunResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const dryRun = options.dryRun === true;
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));

  // Enumerate under the documented platform bypass; every deletion and every
  // guard re-check below runs inside the owning business's withTenant scope.
  const { rows: due } = await withoutTenantScope("platform", () =>
    query<{
      id: string;
      business_id: string;
      service_kind: string;
      service_key: string;
    }>(
      `SELECT q.id, q.business_id, q.service_kind, q.service_key
         FROM service_purge_queue q
         JOIN business_service_activations a ON a.id = q.activation_id
        WHERE q.state IN ('scheduled', 'failed')
          AND q.scheduled_at <= $1::timestamptz
          AND a.state <> 'active'
        ORDER BY q.scheduled_at
        LIMIT $2`,
      [nowIso, limit],
    ),
  );

  const result: PurgeRunResult = {
    dryRun,
    scanned: due.length,
    planned: 0,
    completed: 0,
    partial: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
    failed: 0,
    entries: [],
  };

  for (const row of due) {
    try {
      const entry = await withTenantTransaction(row.business_id, async (client) => {
        const { rows: queueRows } = await client.query<PurgeQueueDbRow>(
          `SELECT id, business_id, activation_id, service_kind, service_key,
                  scheduled_at, state, policy_source, policy_version, attempts, last_error
             FROM service_purge_queue
            WHERE id = $1
            FOR UPDATE`,
          [row.id],
        );
        const queue = queueRows[0];
        if (!queue) return { outcome: "skipped" as const, reason: "queue_missing" };
        if (queue.state !== "scheduled" && queue.state !== "failed") {
          return { outcome: "skipped" as const, reason: `queue_${queue.state}` };
        }

        const { rows: activationRows } = await client.query<ActivationSnapshot>(
          `SELECT id, business_id, service_kind, service_key, runtime_instance_id,
                  state, retention_deadline
             FROM business_service_activations
            WHERE id = $1
            FOR UPDATE`,
          [queue.activation_id],
        );
        const activation = activationRows[0];
        if (!activation) return { outcome: "skipped" as const, reason: "activation_missing" };

        // The customer came back first: re-enable wins, nothing is deleted.
        if (activation.state === "active") {
          await client.query(
            `UPDATE service_purge_queue SET state = 'cancelled', updated_at = now() WHERE id = $1`,
            [queue.id],
          );
          return { outcome: "cancelled" as const, reason: "reenabled" };
        }

        const deadline =
          activation.retention_deadline == null
            ? null
            : activation.retention_deadline instanceof Date
              ? activation.retention_deadline.toISOString()
              : new Date(activation.retention_deadline).toISOString();
        const block = purgeBlockReason({
          state: activation.state as ServiceState,
          retentionDeadline: deadline,
          nowIso,
          legalHold: activation.state === "legal_hold",
        });
        if (block) {
          const blocked = block === "legal_hold";
          await client.query(
            `INSERT INTO service_purge_journal
               (business_id, activation_id, queue_id, dry_run, status, scope, detail, completed_at)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, now())`,
            [
              row.business_id,
              activation.id,
              queue.id,
              dryRun,
              blocked ? "blocked" : "skipped",
              JSON.stringify(purgeManifestFor(activation.service_kind as ServiceKind, activation.service_key)),
              `blocked:${block}`,
            ],
          );
          if (blocked) {
            await client.query(
              `UPDATE service_purge_queue SET state = 'blocked', updated_at = now() WHERE id = $1`,
              [queue.id],
            );
          } else {
            await client.query(
              `UPDATE service_purge_queue
                  SET attempts = attempts + 1, last_error = $2, updated_at = now()
                WHERE id = $1`,
              [queue.id, `waiting:${block}`],
            );
          }
          return { outcome: blocked ? ("blocked" as const) : ("skipped" as const), reason: block };
        }

        const manifest = purgeManifestFor(activation.service_kind as ServiceKind, activation.service_key);
        const plannedStatus = purgePlanStatus(manifest);

        if (dryRun) {
          await client.query(
            `INSERT INTO service_purge_journal
               (business_id, activation_id, queue_id, dry_run, status, scope, detail, completed_at)
             VALUES ($1,$2,$3,true,'planned',$4::jsonb,$5, now())`,
            [
              row.business_id,
              activation.id,
              queue.id,
              JSON.stringify(manifest),
              `dry_run:${plannedStatus}`,
            ],
          );
          return { outcome: "planned" as const, reclaimed: {} };
        }

        await client.query(
          `UPDATE service_purge_queue SET state = 'running', updated_at = now() WHERE id = $1`,
          [queue.id],
        );
        await client.query(
          `UPDATE business_service_activations
              SET state = CASE WHEN state = 'purge_failed' THEN 'eligible_for_purge' ELSE state END,
                  purge_state = 'running', updated_at = now()
            WHERE id = $1`,
          [activation.id],
        );

        // Execute exactly the reviewed owned/delete entries in manifest order.
        // Each static handler verifies its precise tenant scope immediately;
        // blocked/shared and protected rows are never sent to a delete handler.
        const reclaimed: Record<string, number> = {};
        for (const entry of manifest) {
          if (entry.classification !== "owned" || entry.action !== "delete") continue;
          reclaimed[entry.dataset] = await executeOwnedPurgeDataset(client, activation, entry.dataset);
        }

        const status = plannedStatus; // 'completed' only when nothing is blocked
        await client.query(
          `INSERT INTO service_purge_journal
             (business_id, activation_id, queue_id, dry_run, status, scope, reclaimed, detail, completed_at)
           VALUES ($1,$2,$3,false,$4,$5::jsonb,$6::jsonb,$7, now())`,
          [
            row.business_id,
            activation.id,
            queue.id,
            status,
            JSON.stringify(manifest),
            JSON.stringify(reclaimed),
            status === "partial" ? "partial: ownership review pending for blocked datasets" : null,
          ],
        );
        await client.query(
          `UPDATE service_purge_queue
              SET state = $2, attempts = attempts + 1, last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [queue.id, status === "completed" ? "completed" : "partial"],
        );
        await client.query(
          `UPDATE business_service_activations
              SET state = $2,
                  purge_state = $3,
                  data_purged_at = CASE WHEN $2 = 'data_purged' THEN now() ELSE data_purged_at END,
                  updated_at = now()
            WHERE id = $1`,
          [
            activation.id,
            status === "completed" ? "data_purged" : "eligible_for_purge",
            status === "completed" ? "completed" : "partial",
          ],
        );
        await client.query(
          `INSERT INTO service_activation_events
             (business_id, activation_id, service_kind, service_key, action, detail)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            row.business_id,
            activation.id,
            activation.service_kind,
            activation.service_key,
            status === "completed" ? "purge_completed" : "purge_partial",
            JSON.stringify({ manifest, reclaimed }),
          ],
        );

        return {
          outcome: status === "completed" ? ("completed" as const) : ("partial" as const),
          reclaimed,
        };
      });

      result.entries.push({
        activationId: row.id,
        kind: row.service_kind as ServiceKind,
        key: row.service_key,
        outcome: entry.outcome,
        reason: "reason" in entry ? entry.reason : undefined,
        reclaimed: "reclaimed" in entry ? entry.reclaimed : undefined,
      });
      if (entry.outcome === "completed") result.completed += 1;
      else if (entry.outcome === "partial") result.partial += 1;
      else if (entry.outcome === "blocked") result.blocked += 1;
      else if (entry.outcome === "cancelled") result.cancelled += 1;
      else if (entry.outcome === "planned") result.planned += 1;
      else result.skipped += 1;
    } catch (error) {
      result.failed += 1;
      result.entries.push({
        activationId: row.id,
        kind: row.service_kind as ServiceKind,
        key: row.service_key,
        outcome: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      await withTenant(row.business_id, async () => {
        const message = String(error instanceof Error ? error.message : error).slice(0, 500);
        await query(
          `UPDATE service_purge_queue
              SET state = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
            WHERE id = $1`,
          [row.id, message],
        );
        const { rows: queueRows } = await query<{ activation_id: string }>(
          `SELECT activation_id FROM service_purge_queue WHERE id = $1`,
          [row.id],
        );
        if (queueRows[0]) {
          await query(
            `UPDATE business_service_activations
                SET state = 'purge_failed', purge_state = 'failed', updated_at = now()
              WHERE id = $1`,
            [queueRows[0].activation_id],
          );
        }
      }).catch(() => undefined);
    }
  }

  return result;
}

/**
 * Retry one queued purge from the console (after a failure or a released
 * hold). It only re-arms the queue; the worker still re-checks every guard.
 */
export async function retryServicePurge(
  businessId: string,
  activationId: string,
  now: Date = new Date(),
): Promise<PurgeQueueRow> {
  return withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<PurgeQueueDbRow>(
      `UPDATE service_purge_queue
          SET state = 'scheduled',
              scheduled_at = $2::timestamptz,
              last_error = NULL,
              updated_at = now()
        WHERE business_id = $1 AND activation_id = $3
        RETURNING id, business_id, activation_id, service_kind, service_key,
                  scheduled_at, state, policy_source, policy_version, attempts, last_error`,
      [businessId, now.toISOString(), activationId],
    );
    if (!rows[0]) throw new Error("purge_not_queued");
    await client.query(
      `UPDATE business_service_activations
          SET state = CASE WHEN state = 'purge_failed' THEN 'eligible_for_purge' ELSE state END,
              purge_state = 'scheduled',
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [activationId, businessId],
    );
    return toQueueRow(rows[0]);
  });
}

/** Cancel a queued purge (console action; the customer path is re-enable). */
export async function cancelServicePurge(
  businessId: string,
  activationId: string,
): Promise<void> {
  await withTenantTransaction(businessId, async (client) => {
    await client.query(
      `UPDATE service_purge_queue
          SET state = 'cancelled', updated_at = now()
        WHERE business_id = $1 AND activation_id = $2
          AND state IN ('scheduled', 'failed', 'blocked')`,
      [businessId, activationId],
    );
    await client.query(
      `UPDATE business_service_activations
          SET purge_state = 'cancelled', retention_deadline = NULL, updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [activationId, businessId],
    );
  });
}

// Re-exported so the screens/tests do not need to reach into the pure module.
export { OWNED_PURGE_ENTRIES, RETENTION_MAX_DAYS, RETENTION_MIN_DAYS };

/** The audited per-business overrides in force, for the console's business page. */
export async function listBusinessRetentionOverrides(
  businessId: string,
): Promise<RetentionPolicyRow[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<RetentionDbRow>(
      `SELECT ${OVERRIDE_COLUMNS} FROM business_service_retention_overrides
        WHERE business_id = $1
        ORDER BY service_kind, service_key`,
      [businessId],
    );
    const platform = await listRetentionPolicies();
    return rows.map((row) =>
      toOverridePolicyRow(
        row,
        platform.find(
          (policy) => policy.kind === row.service_kind && policy.key === row.service_key,
        ) ?? null,
      ),
    );
  });
}
