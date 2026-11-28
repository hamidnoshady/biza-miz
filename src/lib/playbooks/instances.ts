/**
 * `playbook_instances` persistence + idempotent launch + lifecycle (issue #1590).
 * Tenant-scoped via RLS; `withTenantTransaction`. Retry/replay safe via
 * `UNIQUE (business_id, idempotency_key)`. A published template change never
 * mutates a launched instance (immutable `template_version` + `config`).
 */
import { query, withTenant, withTenantTransaction } from "../db";
import { canTransition, type InstanceState, type PlaybookTemplate } from "./types";
import { executePlaybook, type ExecutorContext, type ExecutorResult } from "./executor";

export interface PlaybookInstance {
  id: string;
  businessId: string;
  branchId: string | null;
  templateKey: string;
  templateVersion: string;
  schemaVersion: number;
  config: Record<string, unknown>;
  initiatorUserId: string | null;
  approverUserId: string | null;
  executorApp: "crm" | "growth";
  executorRef: Record<string, unknown>;
  idempotencyKey: string;
  status: InstanceState;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  retryCount: number;
  audit: AuditEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  at: string;
  actorUserId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

interface InstanceRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  branch_id: string | null;
  template_key: string;
  template_version: string;
  schema_version: number;
  config: unknown;
  initiator_user_id: string | null;
  approver_user_id: string | null;
  executor_app: "crm" | "growth";
  executor_ref: unknown;
  idempotency_key: string;
  status: InstanceState;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  retry_count: number;
  audit: unknown;
  created_at: string;
  updated_at: string;
}

const COLS = `id, business_id, branch_id, template_key, template_version, schema_version, config,
  initiator_user_id, approver_user_id, executor_app, executor_ref, idempotency_key, status,
  scheduled_at::text AS scheduled_at, started_at::text AS started_at, completed_at::text AS completed_at,
  last_error, retry_count, audit, created_at::text AS created_at, updated_at::text AS updated_at`;

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toInstance(r: InstanceRow): PlaybookInstance {
  return {
    id: r.id,
    businessId: r.business_id,
    branchId: r.branch_id,
    templateKey: r.template_key,
    templateVersion: r.template_version,
    schemaVersion: r.schema_version,
    config: obj(r.config),
    initiatorUserId: r.initiator_user_id,
    approverUserId: r.approver_user_id,
    executorApp: r.executor_app,
    executorRef: obj(r.executor_ref),
    idempotencyKey: r.idempotency_key,
    status: r.status,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    lastError: r.last_error,
    retryCount: r.retry_count,
    audit: Array.isArray(r.audit) ? (r.audit as AuditEntry[]) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface LaunchInput {
  businessId: string;
  template: PlaybookTemplate;
  branchId?: string | null;
  config: Record<string, unknown>;
  initiatorUserId: string | null;
  approverUserId?: string | null;
  /** Required; caller derives a stable key (e.g. template+config+member+minute). Retry-safe. */
  idempotencyKey: string;
  /** Validated quick inputs for the executor. */
  executorInputs: Record<string, string | number | boolean | null>;
  actorName: string;
  /** When true, executor runs; when false, a draft instance is stored (approval/scheduling first). */
  execute: boolean;
  /** CRM/Growth executor re-checks nothing here; caller already enforced preflight + permissions. */
}

export interface LaunchResult {
  instance: PlaybookInstance;
  /** true if an existing instance with the same idempotency key was returned (no double-exec). */
  duplicate: boolean;
  execution?: ExecutorResult;
}

export async function launchPlaybookInstance(input: LaunchInput): Promise<LaunchResult> {
  return withTenantTransaction(input.businessId, async () => {
    const key = input.idempotencyKey.trim();
    if (!key) throw new Error("idempotency_key_required");

    // Atomic idempotent insert. ON CONFLICT → return existing, do NOT re-execute.
    const inserted = await query<InstanceRow>(
      `INSERT INTO playbook_instances
         (business_id, branch_id, template_key, template_version, schema_version, config,
          initiator_user_id, approver_user_id, executor_app, idempotency_key, status, audit)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb)
       ON CONFLICT (business_id, idempotency_key) DO NOTHING
       RETURNING ${COLS}`,
      [
        input.businessId,
        input.branchId ?? null,
        input.template.key,
        input.template.version, // immutable published version snapshot
        input.template.schemaVersion,
        JSON.stringify(input.config ?? {}),
        input.initiatorUserId,
        input.approverUserId ?? null,
        input.template.executionBinding.executor,
        key,
        input.execute ? "running" : "draft",
        JSON.stringify([{ at: new Date().toISOString(), actorUserId: input.initiatorUserId, action: "created", detail: { execute: input.execute } }]),
      ],
    );

    if (inserted.rows.length === 0) {
      const existing = await query<InstanceRow>(
        `SELECT ${COLS} FROM playbook_instances WHERE business_id = $1 AND idempotency_key = $2`,
        [input.businessId, key],
      );
      return { instance: toInstance(existing.rows[0]), duplicate: true };
    }

    let instance = toInstance(inserted.rows[0]);

    if (!input.execute) return { instance, duplicate: false };

    // Execute canonical executor; idempotent because we only reach here on a fresh insert.
    const execCtx: ExecutorContext = {
      businessId: input.businessId,
      actorUserId: input.initiatorUserId,
      actorName: input.actorName,
      inputs: input.executorInputs,
      branchId: input.branchId ?? null,
    };

    let execution: ExecutorResult;
    try {
      execution = await executePlaybook(input.template, execCtx);
    } catch (error) {
      execution = { ok: false, executorRef: {}, affected: 0, summaryFa: "", error: error instanceof Error ? error.message : "execution_error" };
    }

    const status: InstanceState = execution.ok ? (input.template.executionBinding.action === "growth.message_campaign_launch" ? "running" : "completed") : "failed";
    const audit = [
      ...instance.audit,
      { at: new Date().toISOString(), actorUserId: input.initiatorUserId, action: execution.ok ? "executed" : "failed", detail: { summaryFa: execution.summaryFa, affected: execution.affected, error: execution.error } },
    ];

    const updated = await query<InstanceRow>(
      `UPDATE playbook_instances SET
         status = $3, executor_ref = $4::jsonb, last_error = $5,
         started_at = COALESCE(started_at, now()),
         completed_at = CASE WHEN $3 IN ('completed','failed') THEN now() ELSE completed_at END,
         audit = $6::jsonb, updated_at = now()
       WHERE business_id = $1 AND id = $2
       RETURNING ${COLS}`,
      [input.businessId, instance.id, status, JSON.stringify(execution.executorRef ?? {}), execution.error ?? null, JSON.stringify(audit)],
    );
    instance = toInstance(updated.rows[0]);
    return { instance, duplicate: false, execution };
  });
}

/** Validated lifecycle transition with audit. */
export async function transitionPlaybookInstance(
  businessId: string,
  id: string,
  to: InstanceState,
  actorUserId: string | null,
  detail?: Record<string, unknown>,
): Promise<PlaybookInstance> {
  return withTenant(businessId, async () => {
    const cur = await query<InstanceRow>(`SELECT ${COLS} FROM playbook_instances WHERE business_id = $1 AND id = $2 FOR UPDATE`, [businessId, id]);
    if (cur.rows.length === 0) throw new Error("not_found");
    const instance = toInstance(cur.rows[0]);
    if (!canTransition(instance.status, to)) throw new Error(`invalid_transition:${instance.status}->${to}`);

    const audit = [...instance.audit, { at: new Date().toISOString(), actorUserId, action: `transition:${to}`, detail }];
    const updated = await query<InstanceRow>(
      `UPDATE playbook_instances SET status=$3, audit=$4::jsonb, updated_at=now(),
         completed_at = CASE WHEN $3 IN ('completed','canceled') THEN now() ELSE completed_at END,
         started_at = CASE WHEN $3='running' THEN COALESCE(started_at, now()) ELSE started_at END,
         retry_count = CASE WHEN $3='running' AND status='failed' THEN retry_count + 1 ELSE retry_count END
       WHERE business_id=$1 AND id=$2 RETURNING ${COLS}`,
      [businessId, id, to, JSON.stringify(audit)],
    );
    return toInstance(updated.rows[0]);
  });
}

export async function listPlaybookInstances(businessId: string, opts: { status?: InstanceState; templateKey?: string; limit?: number } = {}): Promise<PlaybookInstance[]> {
  return withTenant(businessId, async () => {
    const params: unknown[] = [businessId];
    let where = `business_id = $1`;
    if (opts.status) { params.push(opts.status); where += ` AND status = $${params.length}`; }
    if (opts.templateKey) { params.push(opts.templateKey); where += ` AND template_key = $${params.length}`; }
    params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
    const { rows } = await query<InstanceRow>(`SELECT ${COLS} FROM playbook_instances WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(toInstance);
  });
}

export async function getPlaybookInstance(businessId: string, id: string): Promise<PlaybookInstance | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<InstanceRow>(`SELECT ${COLS} FROM playbook_instances WHERE business_id=$1 AND id=$2`, [businessId, id]);
    return rows.length ? toInstance(rows[0]) : null;
  });
}
