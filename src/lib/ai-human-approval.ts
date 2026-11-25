/**
 * GH #1567 F7 — the DB half of mandatory human approval for AI-initiated
 * financial and stock writes (policy: `ai-approval-policy.ts`).
 *
 * Two functions, and every AI executor call in the codebase goes through the
 * second one (`ai-human-approval.test.ts` fails on any direct
 * `AUTOPILOT_EXECUTORS[...]` lookup elsewhere):
 *
 *   * `recordHumanApproval` — a human's approval of ONE claimed proposal row,
 *     bound to the stored payload hash (and, from the approval screen, to the
 *     hash the human was shown), the approver, the tenant and the proposal's
 *     deadline;
 *   * `runAiExecutor` — the executor boundary. A gated action runs only after
 *     one CAS spends a fresh approval whose approver is the authority the
 *     executor runs under and whose payload hash equals the payload being run.
 *     Without it the executor is never called: MCP `apply` mode, autopilot,
 *     automations and coworker jobs cannot reach a financial write.
 */
import { query } from "./db";
import type { ActionType } from "./ai";
import { ACTION_CATALOG } from "./ai";
import { AUTOPILOT_EXECUTORS, type AutopilotExecutionResult } from "./ai-autopilot-executors";
import {
  AI_APPROVAL_EXECUTION_WINDOW_SECONDS,
  AI_APPROVAL_TTL_HOURS,
  requiresHumanApproval,
} from "./ai-approval-policy";
import { aiApprovalPayloadHash } from "./ai-approval-hash";

export type HumanApprovalRefusal =
  | "approval_not_claimed"
  | "approval_expired"
  | "approval_payload_mismatch"
  | "approval_stale"
  | "approval_binding_required";

export const HUMAN_APPROVAL_REFUSAL_FA: Record<HumanApprovalRefusal, string> = {
  approval_not_claimed: "این درخواست در وضعیت قابل تأیید نیست؛ چیزی تغییر نکرد.",
  approval_expired: `مهلت تأیید این درخواست (${AI_APPROVAL_TTL_HOURS} ساعت) گذشته است؛ چیزی تغییر نکرد. در صورت نیاز درخواست تازه بدهید.`,
  approval_payload_mismatch: "محتوای ذخیره‌شدهٔ این درخواست با نسخهٔ ثبت‌شده یکی نیست؛ برای امنیت اجرا نشد.",
  approval_stale: "آنچه تأیید کردید با درخواست فعلی یکی نیست؛ صفحه را تازه کنید و دوباره بررسی کنید.",
  approval_binding_required: "برای تأیید این عملیات مالی/انباری، نسخهٔ بررسی‌شدهٔ درخواست لازم است؛ صفحه را تازه کنید.",
};

/**
 * Record a human's approval on a proposal the caller has ALREADY claimed
 * (`status = 'processing'`). A no-op success for ungated actions.
 *
 * `presentedPayloadHash` is the hash the approval screen displayed; when the
 * action is gated and `requirePresentedHash` is set, it must be present and
 * equal the stored one — the human approves what they saw, not whatever the
 * row holds by the time the click lands.
 */
export async function recordHumanApproval(input: {
  businessId: string;
  auditId: string;
  approverUserId: string;
  presentedPayloadHash: string | null;
  requirePresentedHash: boolean;
}): Promise<{ ok: true; gated: boolean } | { ok: false; error: HumanApprovalRefusal }> {
  const { rows } = await query<{
    action_type: string;
    proposal_payload: Record<string, unknown> | null;
    proposal_payload_hash: string | null;
    expired: boolean;
    status: string;
  }>(
    `SELECT action_type, proposal_payload, proposal_payload_hash, status,
            (coalesce(approval_expires_at, created_at + make_interval(hours => $3::int)) <= now()) AS expired
       FROM ai_action_audit
      WHERE id = $1 AND business_id = $2`,
    [input.auditId, input.businessId, AI_APPROVAL_TTL_HOURS],
  );
  const row = rows[0];
  if (!row || row.status !== "processing") return { ok: false, error: "approval_not_claimed" };
  if (!requiresHumanApproval(row.action_type)) return { ok: true, gated: false };
  if (row.expired) return { ok: false, error: "approval_expired" };

  const storedHash = aiApprovalPayloadHash(row.action_type, row.proposal_payload ?? {});
  // A row stamped at proposal time must still hash to its stamp; a row from
  // before the stamp existed is bound to its stored payload from now on.
  if (row.proposal_payload_hash !== null && row.proposal_payload_hash !== storedHash) {
    return { ok: false, error: "approval_payload_mismatch" };
  }
  if (input.presentedPayloadHash === null) {
    if (input.requirePresentedHash) return { ok: false, error: "approval_binding_required" };
  } else if (input.presentedPayloadHash !== storedHash) {
    return { ok: false, error: "approval_stale" };
  }

  const { rowCount } = await query(
    `UPDATE ai_action_audit
        SET approved_by = $3, approved_at = now(), approved_payload_hash = $4,
            proposal_payload_hash = coalesce(proposal_payload_hash, $4)
      WHERE id = $1 AND business_id = $2 AND status = 'processing' AND approval_consumed_at IS NULL`,
    [input.auditId, input.businessId, input.approverUserId, storedHash],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, error: "approval_not_claimed" };
  return { ok: true, gated: true };
}

/**
 * The single AI executor boundary. Ungated actions run as before. A gated
 * action runs only when one CAS spends the approval recorded on `auditId`:
 * same tenant, same action, approver == `authorizedByUserId`, approved
 * payload hash == hash of the `payload` about to run, approval fresh and
 * not yet spent. The executor gets `operationId = auditId`, so an executor
 * with its own idempotency replays instead of doubling.
 */
export async function runAiExecutor(input: {
  actionType: ActionType;
  businessId: string;
  authorizedByUserId: string | null;
  payload: Record<string, unknown>;
  auditId: string | null;
}): Promise<AutopilotExecutionResult> {
  const meta = ACTION_CATALOG[input.actionType];
  const executor = meta?.executor ? AUTOPILOT_EXECUTORS[meta.executor] : null;
  if (!executor) return { ok: false, result: {}, errorCode: "executor_missing" };

  if (requiresHumanApproval(input.actionType)) {
    if (!input.auditId || !input.authorizedByUserId) {
      return { ok: false, result: { reason: "human_approval_required" }, errorCode: "human_approval_required" };
    }
    const { rows } = await query<{ id: string }>(
      `UPDATE ai_action_audit
          SET approval_consumed_at = now()
        WHERE id = $1 AND business_id = $2 AND action_type = $3
          AND status = 'processing'
          AND approved_by = $4
          AND approved_payload_hash = $5
          AND approval_consumed_at IS NULL
          AND approved_at > now() - make_interval(secs => $6::int)
        RETURNING id`,
      [
        input.auditId,
        input.businessId,
        input.actionType,
        input.authorizedByUserId,
        aiApprovalPayloadHash(input.actionType, input.payload),
        AI_APPROVAL_EXECUTION_WINDOW_SECONDS,
      ],
    );
    if (!rows[0]) {
      return { ok: false, result: { reason: "human_approval_required" }, errorCode: "human_approval_required" };
    }
  }

  return executor({
    businessId: input.businessId,
    authorizedByUserId: input.authorizedByUserId,
    operationId: input.auditId ?? undefined,
    payload: input.payload,
  });
}
