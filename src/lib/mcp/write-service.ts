/**
 * What happens when an MCP client calls a write tool.
 *
 * The rule this file exists to keep: **an MCP write opens no new mutation
 * path.** It builds the same `ProposedAction` the chat assistant builds, and
 * hands it to the same Phase 31 executor a coworker job hands it to, which calls
 * the same service function the route handler calls. Nothing here knows how to
 * change a price; it only knows who asked and whether they may.
 *
 * Two modes, chosen per connection when the owner created it (see
 * `scopes.ts`):
 *
 *   * `apply` — the write happens now. The owner pressed "trust this connector"
 *     once instead of pressing Apply every time; the audit row records which
 *     connection did it, and the connections screen can revoke it in one click.
 *   * `approve` — the write becomes a `proposed` row in `ai_action_audit` and
 *     changes nothing. The tool result says so in as many words, because a model
 *     that reports "done" for a change that is merely queued is worse than one
 *     that refuses.
 *
 * DB-touching; covered by `integration/mcp-connector.integration.test.ts`.
 */
import { query } from "../db";
import { ACTION_CATALOG, type ActionType, type ProposedAction } from "../ai";
import { AUTOPILOT_EXECUTORS } from "../ai-autopilot-executors";
import { createAiActionAudit } from "../ai-action-audit";
import type { McpAuthentication } from "./auth";

/**
 * Every row an MCP write creates says so, the way AUTOPILOT_NOTE_PREFIX does
 * for autopilot. Defined once in `src/lib/ai-provenance.ts` — see the note
 * there for why a pure module owns it — and re-exported so existing importers
 * are untouched.
 */
export { MCP_ACTOR_PREFIX } from "../ai-provenance";
import { MCP_ACTOR_PREFIX } from "../ai-provenance";

export interface McpWriteOutcome {
  status: "applied" | "pending_approval" | "failed";
  auditId: string;
  actionType: ActionType;
  /** Persian, for the owner; the model relays it. */
  message: string;
  error?: string;
  result?: Record<string, unknown>;
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * Record the proposal, then either run it or leave it standing.
 *
 * The audit row is created *before* the executor runs, not after, so a write
 * that throws mid-way still leaves a trace of what was attempted. That ordering
 * is the same one the coworker's `applyAction` uses and matters for the same
 * reason: the interesting failures are the ones that half-happened.
 */
export async function performMcpWrite(input: {
  auth: McpAuthentication;
  actionType: ActionType;
  payload: Record<string, unknown>;
  /** A one-line description of what the model asked for, for the audit trail. */
  summary: string;
}): Promise<McpWriteOutcome> {
  const meta = ACTION_CATALOG[input.actionType];
  const proposal: ProposedAction = {
    type: input.actionType,
    title: meta.label,
    summary: input.summary,
    payload: input.payload,
  };

  const auditId = await createAiActionAudit({
    businessId: input.auth.businessId,
    // The connection's authorizing owner, so the trail names a person even
    // though a machine made the call. Never anonymous.
    actorUserId: input.auth.authorizedByUserId ?? "mcp",
    actorName: `${MCP_ACTOR_PREFIX}${input.auth.connectionName}`,
    prompt: `MCP: ${input.summary}`,
    proposal,
  });
  await query(
    `UPDATE ai_action_audit
        SET source = 'mcp', autopilot_category = $3, mcp_connection_id = $4
      WHERE id = $1 AND business_id = $2`,
    [auditId, input.auth.businessId, meta.autopilotCategory ?? null, input.auth.connectionId],
  );

  if (input.auth.writeMode === "approve") {
    return {
      status: "pending_approval",
      auditId,
      actionType: input.actionType,
      message:
        `این تغییر ثبت نشد و در انتظار تأیید است. صاحب کسب‌وکار باید آن را در ` +
        `«اتصال‌ها ← دستیارهای هوش مصنوعی» تأیید کند. تا آن زمان هیچ چیزی تغییر نکرده است.`,
    };
  }

  return runProposedAction({
    businessId: input.auth.businessId,
    auditId,
    actionType: input.actionType,
    payload: input.payload,
    authorizedByUserId: input.auth.authorizedByUserId,
  });
}

/**
 * Run one already-audited proposal through its executor and close out its audit
 * row. Shared by the `apply` path above and by an owner approving a queued write.
 */
async function runProposedAction(input: {
  businessId: string;
  auditId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  authorizedByUserId: string | null;
}): Promise<McpWriteOutcome> {
  const meta = ACTION_CATALOG[input.actionType];
  const executor = meta.executor ? AUTOPILOT_EXECUTORS[meta.executor] : null;

  // An action with no executor should never have reached here — `tools.ts`
  // only exposes ones that have one — so this is a guard against a future
  // catalogue edit, not an expected branch.
  if (!executor) {
    await query(
      `UPDATE ai_action_audit SET status = 'failed', result = $3::jsonb
        WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
      [input.auditId, input.businessId, JSON.stringify({ error: "mcp_executor_missing" })],
    );
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: "mcp_executor_missing",
      message: "این عملیات از طریق اتصال هوش مصنوعی قابل اجرا نیست.",
    };
  }

  // A write runs under the authorizing owner's identity, and a connection
  // whose authorizer has been deleted may read but not write.
  if (!input.authorizedByUserId) {
    await query(
      `UPDATE ai_action_audit SET status = 'failed', result = $3::jsonb
        WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
      [input.auditId, input.businessId, JSON.stringify({ error: "mcp_unauthorized_writer" })],
    );
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: "mcp_unauthorized_writer",
      message:
        "کاربری که این اتصال را مجاز کرده بود دیگر وجود ندارد، بنابراین این اتصال فقط می‌تواند بخواند. یک اتصال تازه بسازید.",
    };
  }

  const result = await executor({
    businessId: input.businessId,
    authorizedByUserId: input.authorizedByUserId,
    payload: input.payload,
  });

  await query(
    `UPDATE ai_action_audit
        SET status = $3, result = $4::jsonb, prior_state = $5::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
    [
      input.auditId,
      input.businessId,
      result.ok ? "applied" : "failed",
      JSON.stringify(result.result ?? {}),
      jsonOrNull(result.priorState),
    ],
  );

  return result.ok
    ? {
        status: "applied",
        auditId: input.auditId,
        actionType: input.actionType,
        result: result.result,
        message: "انجام شد.",
      }
    : {
        status: "failed",
        auditId: input.auditId,
        actionType: input.actionType,
        error: result.errorCode ?? "execution_failed",
        message: `انجام نشد: ${result.errorCode ?? "execution_failed"}`,
      };
}

export type McpDecision = "approve" | "reject";

export type DecidePendingResult =
  | { ok: true; decision: "approve"; outcome: McpWriteOutcome }
  | { ok: true; decision: "reject" }
  | { ok: false; error: "not_found" | "unknown_action" };

/**
 * An owner's verdict on a queued MCP write.
 *
 * Approving runs the *stored* payload unchanged — the connection does not get a
 * second say, and the figure the owner read on screen is the figure that is
 * written. Rejecting marks it `dismissed`, which is the same terminal state a
 * dismissed chat proposal reaches.
 */
export async function decideMcpPendingAction(input: {
  businessId: string;
  auditId: string;
  decision: McpDecision;
  deciderUserId: string;
}): Promise<DecidePendingResult> {
  const { rows } = await query<{ action_type: string; proposal_payload: Record<string, unknown> }>(
    `SELECT action_type, proposal_payload
       FROM ai_action_audit
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'proposed'`,
    [input.auditId, input.businessId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };

  if (input.decision === "reject") {
    await query(
      `UPDATE ai_action_audit SET status = 'dismissed', result = $3::jsonb
        WHERE id = $1 AND business_id = $2 AND status = 'proposed'`,
      [input.auditId, input.businessId, JSON.stringify({ rejectedBy: input.deciderUserId })],
    );
    return { ok: true, decision: "reject" };
  }

  const actionType = row.action_type as ActionType;
  if (!ACTION_CATALOG[actionType]) return { ok: false, error: "unknown_action" };

  const outcome = await runProposedAction({
    businessId: input.businessId,
    auditId: input.auditId,
    actionType,
    payload: row.proposal_payload ?? {},
    // The approver's own authority, not the connection's: they are the human
    // in the loop, and this is the moment the write becomes theirs.
    authorizedByUserId: input.deciderUserId,
  });
  return { ok: true, decision: "approve", outcome };
}
