/**
 * Phase 18b Wave 5 — tenant-scoped audit records for the human-confirmed
 * proposal path. The record is created server-side when a proposal is returned,
 * then the UI marks its final human decision after the already-guarded endpoint
 * succeeds or is dismissed.
 */
import { query } from "./db";
import type { ProposedAction } from "./ai";

export type AiActionAuditStatus =
  | "proposed"
  | "processing"
  | "applied"
  | "failed"
  | "dismissed"
  | "reverted";
export type AiActionAuditTerminalStatus = Exclude<AiActionAuditStatus, "proposed" | "processing">;

export interface AiActionAuditEntry extends Record<string, unknown> {
  id: string;
  actorUserId: string;
  actorName: string;
  promptExcerpt: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  status: AiActionAuditStatus;
  /** Phase 31 — whether a human clicked apply or autopilot ran it unattended. */
  source: "manual" | "autopilot";
  result: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
  conversationId?: string | null;
}

function compactAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 500);
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactAuditValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [key.slice(0, 100), compactAuditValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, 500);
}

function jsonValue(value: unknown): string {
  return JSON.stringify(compactAuditValue(value));
}

export async function createAiActionAudit(input: {
  businessId: string;
  actorUserId: string;
  actorName: string | null | undefined;
  prompt: string;
  proposal: ProposedAction;
  conversationId?: string | null;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_action_audit
       (business_id, actor_user_id, actor_name, prompt_excerpt, action_type, action_title, action_summary, proposal_payload, conversation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id`,
    [
      input.businessId,
      input.actorUserId,
      input.actorName?.trim().slice(0, 200) ?? "",
      input.prompt.trim().slice(0, 1_500),
      input.proposal.type,
      input.proposal.title.trim().slice(0, 500),
      input.proposal.summary.trim().slice(0, 2_000),
      jsonValue(input.proposal.payload),
      input.conversationId ?? null,
    ],
  );
  if (!rows[0]) throw new Error("ai_action_audit_create_failed");
  return rows[0].id;
}

export async function listAiActionAudit(
  businessId: string,
  limit = 30,
  actorUserId?: string,
): Promise<AiActionAuditEntry[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const { rows } = await query<AiActionAuditEntry>(
    `SELECT id,
            actor_user_id AS "actorUserId",
            actor_name AS "actorName",
            prompt_excerpt AS "promptExcerpt",
            action_type AS "actionType",
            action_title AS "actionTitle",
            action_summary AS "actionSummary",
            proposal_payload AS payload,
            status,
            source,
            result,
            created_at AS "createdAt",
            applied_at AS "appliedAt",
            conversation_id AS "conversationId"
       FROM ai_action_audit
      WHERE business_id = $1
        AND ($2::text IS NULL OR actor_user_id = $2::text)
      ORDER BY created_at DESC
      LIMIT $3`,
    [businessId, actorUserId ?? null, safeLimit],
  );
  return rows;
}

export async function finishAiActionAudit(input: {
  businessId: string;
  id: string;
  status: AiActionAuditTerminalStatus;
  result?: Record<string, unknown>;
  actorUserId?: string;
}): Promise<boolean> {
  const allowedPrevious = input.status === "dismissed" ? ["proposed"] : ["proposed", "processing"];
  const actorClause = input.actorUserId ? " AND actor_user_id = $5" : "";
  const { rowCount } = await query(
    `UPDATE ai_action_audit
        SET status = $3,
            result = $4::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END,
            processing_started_at = NULL
      WHERE id = $1 AND business_id = $2 AND status = ANY($6::text[])${actorClause}`,
    // $5 is the actor when provided and $6 is the previous-state array. Keep
    // both placeholders stable so the SQL remains easy to audit.
    input.actorUserId
      ? [input.id, input.businessId, input.status, jsonValue(input.result ?? {}), input.actorUserId, allowedPrevious]
      : [input.id, input.businessId, input.status, jsonValue(input.result ?? {}), null, allowedPrevious],
  );
  return (rowCount ?? 0) > 0;
}

export interface ClaimedAiActionAudit {
  id: string;
  actorUserId: string;
  source: string;
  actionType: string;
  actionTitle: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  conversationId: string | null;
}

/**
 * Atomically claims a proposed action before its business endpoint is called.
 * A crashed request can be reclaimed after five minutes; an active claim is
 * never re-entered, so double-clicks remain safe while a dead worker does not
 * strand a proposal forever.
 */
export async function claimAiActionAudit(input: {
  businessId: string;
  id: string;
  actorUserId: string;
  canManage: boolean;
}): Promise<ClaimedAiActionAudit | null> {
  const { rows } = await query<{
    id: string;
    actor_user_id: string;
    source: string;
    action_type: string;
    action_title: string;
    action_summary: string;
    proposal_payload: Record<string, unknown>;
    conversation_id: string | null;
  }>(
    `UPDATE ai_action_audit
        SET status = 'processing', processing_started_at = now()
      WHERE id = $1 AND business_id = $2
        AND (
          status = 'proposed'
          OR (status = 'processing' AND processing_started_at < now() - interval '5 minutes')
        )
        AND (actor_user_id = $3 OR $4 = true)
      RETURNING id, actor_user_id, source, action_type, action_title, action_summary,
                proposal_payload, conversation_id`,
    [input.id, input.businessId, input.actorUserId, input.canManage],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        actorUserId: row.actor_user_id,
        source: row.source,
        actionType: row.action_type,
        actionTitle: row.action_title,
        actionSummary: row.action_summary,
        payload: row.proposal_payload,
        conversationId: row.conversation_id,
      }
    : null;
}

export async function getAiActionAuditStatus(
  businessId: string,
  id: string,
  actorUserId?: string,
  canManage = false,
): Promise<AiActionAuditStatus | null> {
  const { rows } = await query<{ status: AiActionAuditStatus }>(
    `SELECT status FROM ai_action_audit
      WHERE id = $1 AND business_id = $2
        AND (actor_user_id = $3 OR $4 = true)`,
    [id, businessId, actorUserId ?? null, canManage],
  );
  return rows[0]?.status ?? null;
}
