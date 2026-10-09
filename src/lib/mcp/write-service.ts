/**
 * What happens when an MCP client calls a write tool.
 *
 * The rule this file exists to keep: **an MCP write opens no new mutation
 * path.** It builds the same `ProposedAction` the chat assistant builds, and
 * hands it to the same Phase 31 executor a coworker job hands it to, which calls
 * the same service function the route handler calls. Nothing here knows how to
 * change a price; it only knows who asked and whether they may.
 *
 * Issue #883 added the second half of that sentence — *whether they may, right
 * now* (P0-5) — and the concurrency contract (P0-3):
 *
 *   * **Reauthorized at execution, not at grant.** The action's domain
 *     permission (`AI_ACTION_PERMISSION_MAP`) must sit inside the acting
 *     member's *current* effective permissions — the connection's authorizer
 *     for an immediate write, the human approver for a queued one. Unknown or
 *     unmapped actions fail closed.
 *   * **One winner.** A queued write is claimed `proposed → processing` in a
 *     single CAS before any side effect runs; two concurrent approvals cannot
 *     both execute, and a retry of a timed-out call cannot double-apply.
 *   * **Idempotent.** An apply-mode call may carry an idempotency key (MCP
 *     `_meta.idempotencyKey`), persisted with the audit row under a partial
 *     unique index scoped to the connection. A replay returns the durable
 *     outcome of the original instead of repeating the effect.
 *   * **No retained authority.** Approval revalidates that the connection
 *     still exists, is active and still holds `pos.write`; revoking or
 *     narrowing a connection dismisses its outstanding proposals (see
 *     `connections-service.ts`).
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
import { ACTION_CATALOG, type ActionType, type AutopilotExecutorKey, type ProposedAction } from "../ai";
import { aiActionPermission } from "../ai-capabilities";
import { AUTOPILOT_EXECUTORS, executorTargetLocation } from "../ai-autopilot-executors";
import { verifyUnattendedAuthority } from "../ai-unattended-authority";
import { resolveBranchRef } from "../branch-service";
import { createAiActionAudit } from "../ai-action-audit";
import type { McpAuthentication } from "./auth";
import { resolveMcpAuthority } from "./authority";
import { MCP_SCOPES } from "./scopes";

/**
 * Every row an MCP write creates says so, the way AUTOPILOT_NOTE_PREFIX does
 * for autopilot. Defined once in `src/lib/ai-provenance.ts` — see the note
 * there for why a pure module owns it — and re-exported so existing importers
 * are untouched.
 */
export { MCP_ACTOR_PREFIX } from "../ai-provenance";
import { MCP_ACTOR_PREFIX } from "../ai-provenance";

export interface McpWriteOutcome {
  status: "applied" | "pending_approval" | "in_flight" | "failed";
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

/** pg's unique-violation code, for the idempotency replay catch below. */
const UNIQUE_VIOLATION = "23505";

/**
 * The audit row's lifecycle, and which transitions each statement may make.
 * `processing` is the claimed, side-effect-in-flight state: only the claimant
 * may move a row out of it, and a crashed claimant's row becomes claimable
 * again only through the human decision surface (never silently retried).
 */
async function claimMcpProposal(businessId: string, auditId: string): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `UPDATE ai_action_audit
        SET status = 'processing', processing_started_at = now()
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'proposed'
      RETURNING id`,
    [auditId, businessId],
  );
  return Boolean(rows[0]);
}

async function finalizeClaimedProposal(
  businessId: string,
  auditId: string,
  status: "applied" | "failed",
  result: Record<string, unknown>,
  priorState: Record<string, unknown> | undefined,
): Promise<void> {
  await query(
    `UPDATE ai_action_audit
        SET status = $3, result = $4::jsonb, prior_state = $5::jsonb,
            applied_at = CASE WHEN $3 = 'applied' THEN now() ELSE applied_at END,
            processing_started_at = NULL
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'processing'`,
    [auditId, businessId, status, JSON.stringify(result), jsonOrNull(priorState)],
  );
}

/** Put a *claimed* row back on the queue — the decider was not permitted; a
 * privileged approver may still decide it. Never used to retry side effects. */
async function releaseClaimToProposed(businessId: string, auditId: string): Promise<void> {
  await query(
    `UPDATE ai_action_audit
        SET status = 'proposed', processing_started_at = NULL
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'processing'`,
    [auditId, businessId],
  );
}

/** A write whose authority has evaporated is terminal, with the reason kept. */
async function failClaimedProposal(
  businessId: string,
  auditId: string,
  errorCode: string,
): Promise<void> {
  await finalizeClaimedProposal(businessId, auditId, "failed", { error: errorCode }, undefined);
}

/**
 * One durable read of a replayed idempotency key: the original call's audit
 * row and its final (or in-flight) outcome.
 */
export interface StoredMcpWrite {
  auditId: string;
  actionType: ActionType;
  status: "proposed" | "processing" | "applied" | "failed" | "dismissed" | "reverted";
  result: Record<string, unknown> | null;
}

export async function findStoredMcpWrite(
  businessId: string,
  connectionId: string,
  idempotencyKey: string,
): Promise<StoredMcpWrite | null> {
  const { rows } = await query<{
    id: string;
    action_type: string;
    status: StoredMcpWrite["status"];
    result: Record<string, unknown> | null;
  }>(
    `SELECT id, action_type, status, result
       FROM ai_action_audit
      WHERE business_id = $1 AND mcp_connection_id = $2 AND mcp_idempotency_key = $3`,
    [businessId, connectionId, idempotencyKey],
  );
  const row = rows[0];
  return row
    ? {
        auditId: row.id,
        actionType: row.action_type as ActionType,
        status: row.status,
        result: row.result ?? null,
      }
    : null;
}

function outcomeOfStored(stored: StoredMcpWrite, actionType: ActionType): McpWriteOutcome {
  // A replayed key returns the original call's durable outcome. The audit id
  // is the original's, which is exactly what "same operation" means.
  switch (stored.status) {
    case "applied":
      return {
        status: "applied",
        auditId: stored.auditId,
        actionType,
        result: stored.result ?? undefined,
        message: "این درخواست قبلاً انجام شده است؛ تکرار اثر جدیدی ندارد.",
      };
    case "proposed":
      return {
        status: "pending_approval",
        auditId: stored.auditId,
        actionType,
        message: "این درخواست قبلاً ثبت شده و در انتظار تأیید است؛ دوباره ثبت نشد.",
      };
    case "processing":
      return {
        status: "in_flight",
        auditId: stored.auditId,
        actionType,
        message:
          "همین درخواست در حال انجام است؛ برای جلوگیری از اثر تکراری دوباره اجرا نشد. کمی بعد با همین کلید نتیجه را بپرسید.",
      };
    default:
      return {
        status: "failed",
        auditId: stored.auditId,
        actionType,
        error: (stored.result?.error as string) ?? "duplicate_of_failed",
        message: "این درخواست قبلاً انجام شد و ناموفق بود؛ دوباره اجرا نشد.",
      };
  }
}

/**
 * The gate every MCP write passes, in both modes (P0-5). Returns the Persian
 * refusal to relay, or null when the write may proceed.
 *
 * `permissions` are the acting member's current effective set: for the
 * immediate path the connection's authorizer (already resolved fresh by
 * `authenticateMcp`), for approval the human deciding the queue row.
 */
export function mcpWriteRefusal(
  actionType: ActionType,
  permissions: ReadonlySet<string>,
): { error: string; message: string } | null {
  if (!ACTION_CATALOG[actionType]) {
    return {
      error: "action_unknown",
      message: "این عملکرد برای اتصال هوش مصنوعی تعریف نشده است و اجرا نمی‌شود.",
    };
  }
  const required = aiActionPermission(actionType);
  // Fail closed: an action nobody mapped to a domain permission is not a
  // write an external connector may run — a new catalogue entry ships
  // inert until its mapping lands.
  if (required === null || !permissions.has(required)) {
    return {
      error: "action_not_permitted",
      message:
        "کاربری که این اتصال با مجوز او کار می‌کند در حال حاضر اجازهٔ این تغییر را ندارد؛ تغییر اعمال نشد.",
    };
  }
  return null;
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
  /** Optional client retry key (MCP `_meta.idempotencyKey`), deduped per connection. */
  idempotencyKey?: string | null;
}): Promise<McpWriteOutcome> {
  // P0-5 — the authorizer's CURRENT authority, resolved at authenticate time.
  // (`executeClaimedProposal` re-verifies it again at the executor boundary.)
  const refusal = mcpWriteRefusal(input.actionType, input.auth.permissions);
  if (refusal) {
    return {
      status: "failed",
      auditId: "",
      actionType: input.actionType,
      error: refusal.error,
      message: refusal.message,
    };
  }

  const meta = ACTION_CATALOG[input.actionType];
  const proposal: ProposedAction = {
    type: input.actionType,
    title: meta.label,
    summary: input.summary,
    payload: input.payload,
  };

  let auditId: string;
  try {
    auditId = await createAiActionAudit({
      businessId: input.auth.businessId,
      // The connection's authorizing owner, so the trail names a person even
      // though a machine made the call. Never anonymous.
      actorUserId: input.auth.authorizedByUserId,
      actorName: `${MCP_ACTOR_PREFIX}${input.auth.connectionName}`,
      prompt: `MCP: ${input.summary}`,
      proposal,
    });
    await query(
      `UPDATE ai_action_audit
          SET source = 'mcp', autopilot_category = $3, mcp_connection_id = $4,
              mcp_idempotency_key = $5
        WHERE id = $1 AND business_id = $2`,
      [
        auditId,
        input.auth.businessId,
        meta.autopilotCategory ?? null,
        input.auth.connectionId,
        input.idempotencyKey ?? null,
      ],
    );
  } catch (error) {
    // P0-3 — idempotent replay. The partial unique index on
    // (business, connection, key) makes the second writer lose; its fresh
    // audit row is removed and the ORIGINAL row's durable outcome is what the
    // client gets, whether that outcome is final or still in flight.
    if (
      input.idempotencyKey &&
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === UNIQUE_VIOLATION
    ) {
      await query(`DELETE FROM ai_action_audit WHERE id = $1 AND business_id = $2`, [
        auditId!,
        input.auth.businessId,
      ]).catch(() => undefined);
      const stored = await findStoredMcpWrite(
        input.auth.businessId,
        input.auth.connectionId,
        input.idempotencyKey,
      );
      if (stored) return outcomeOfStored(stored, input.actionType);
    }
    throw error;
  }

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

  const claimed = await claimMcpProposal(input.auth.businessId, auditId);
  if (!claimed) {
    return {
      status: "failed",
      auditId,
      actionType: input.actionType,
      error: "already_decided",
      message: "این درخواست قبلاً بررسی شده است و دوباره اجرا نمی‌شود.",
    };
  }

  return executeClaimedProposal({
    businessId: input.auth.businessId,
    auditId,
    actionType: input.actionType,
    payload: input.payload,
    authorizedByUserId: input.auth.authorizedByUserId,
    connectionLocationId: input.auth.locationId,
  });
}

/**
 * Run one claimed proposal through its executor and close out its audit row.
 * Shared by the `apply` path above (which claims right after recording) and by
 * an owner approving a queued write (which claims at decision time).
 *
 * The claim (`proposed → processing`, one statement, one winner) IS the mutual
 * exclusion: anything that fails to claim returns without side effects, and
 * only the claimant's finalize CAS can close the row out.
 *
 * Finally — and deliberately *inside* the privileged boundary, not only at the
 * edge (P0-5) — the write passes issue #812's central authority gate: the
 * acting member's current existence, active flag, business status, effective
 * permissions for this exact action, and reach over the target branch, resolved
 * from the payload by the executors' own `executorTargetLocation`. An MCP write
 * is held to exactly the authorization an autopilot or coworker write is.
 */
async function executeClaimedProposal(input: {
  businessId: string;
  auditId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  authorizedByUserId: string;
  /**
   * The connection's branch. A write whose target resolves to another branch
   * is refused (P0-2) — the connector minted for branch A never moves a row
   * whose branch is B, whatever its authorizer may see.
   */
  connectionLocationId: string | null;
}): Promise<McpWriteOutcome> {
  const meta = ACTION_CATALOG[input.actionType];
  const executorKey: AutopilotExecutorKey | undefined = meta.executor;
  const executor = executorKey ? AUTOPILOT_EXECUTORS[executorKey] : null;

  // An action with no executor should never have reached here — `tools.ts`
  // only exposes ones that have one — so this is a guard against a future
  // catalogue edit, not an expected branch.
  if (!executor) {
    await failClaimedProposal(input.businessId, input.auditId, "mcp_executor_missing");
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: "mcp_executor_missing",
      message: "این عملیات از طریق اتصال هوش مصنوعی قابل اجرا نیست.",
    };
  }

  let targetLocationId = await executorTargetLocation(executorKey, input.payload);
  if (targetLocationId === null && (executorKey === "expense" || executorKey === "journalDraft")) {
    // These two file under a *chosen* branch — the payload's `locationId` when
    // present, otherwise the business default — rather than one resolved from a
    // target row. What the executor would file under IS what the branch gate
    // must compare, or a payload naming another branch walks straight past it.
    // (`executorTargetLocation` leaves them null for the coworker path, which
    // has no branch constraint of its own to check.)
    const requested =
      typeof input.payload.locationId === "string" ? input.payload.locationId : null;
    const resolved = await resolveBranchRef(input.businessId, requested);
    if (resolved.ok) targetLocationId = resolved.locationId;
  }
  if (
    input.connectionLocationId !== null &&
    targetLocationId !== null &&
    targetLocationId !== input.connectionLocationId
  ) {
    await failClaimedProposal(input.businessId, input.auditId, "branch_forbidden");
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: "branch_forbidden",
      message: "هدف این تغییر در شعبهٔ این اتصال نیست؛ تغییر اعمال نشد.",
    };
  }

  const authority = await verifyUnattendedAuthority({
    businessId: input.businessId,
    authorizedByUserId: input.authorizedByUserId,
    actionType: input.actionType,
    targetLocationId,
  });
  if (!authority.ok) {
    await failClaimedProposal(input.businessId, input.auditId, authority.reasonCode ?? "unauthorized");
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: authority.reasonCode ?? "unauthorized",
      message: authority.reasonFa ?? "مجوز انجام این تغییر دیگر معتبر نیست؛ تغییر اعمال نشد.",
    };
  }

  const result = await executor({
    businessId: input.businessId,
    authorizedByUserId: input.authorizedByUserId,
    payload: input.payload,
  });

  await finalizeClaimedProposal(
    input.businessId,
    input.auditId,
    result.ok ? "applied" : "failed",
    result.result ?? {},
    result.priorState,
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
  | { ok: false; error: "not_found" | "unknown_action" | "approver_forbidden" };

/**
 * An owner's verdict on a queued MCP write.
 *
 * Approving runs the *stored* payload unchanged — the connection does not get a
 * second say, and the figure the owner read on screen is the figure that is
 * written. Rejecting marks it `dismissed`, which is the same terminal state a
 * dismissed chat proposal reaches.
 *
 * Issue #883's changes, in the order they now happen:
 *
 *   1. The row is *claimed* before anything is read or executed — two owners
 *      (or a retried double-click) racing the same proposal produce exactly
 *      one execution (P0-3);
 *   2. the connection behind the proposal is re-read and must still be
 *      active with `pos.write` in its scopes — a revoked or narrowed
 *      connector's queue retains no authority (P0-3);
 *   3. the *approver's own* current permissions must cover the action's
 *      domain permission (P0-5) — a refusal here releases the claim back to
 *      `proposed`, because another, privileged approver is the remedy, not a
 *      discarded change.
 */
export async function decideMcpPendingAction(input: {
  businessId: string;
  auditId: string;
  decision: McpDecision;
  deciderUserId: string;
}): Promise<DecidePendingResult> {
  if (input.decision === "reject") {
    const { rowCount } = await query(
      `UPDATE ai_action_audit
          SET status = 'dismissed', result = $3::jsonb
        WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'proposed'`,
      [input.auditId, input.businessId, JSON.stringify({ rejectedBy: input.deciderUserId })],
    );
    return (rowCount ?? 0) > 0
      ? { ok: true, decision: "reject" }
      : { ok: false, error: "not_found" };
  }

  // Approve: claim first, then read. A second claimant (parallel approval,
  // battered retry) finds the row no longer `proposed` and knows it lost.
  const { rows } = await query<{
    action_type: string;
    proposal_payload: Record<string, unknown>;
    mcp_connection_id: string | null;
  }>(
    `UPDATE ai_action_audit
        SET status = 'processing', processing_started_at = now()
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'proposed'
      RETURNING action_type, proposal_payload, mcp_connection_id`,
    [input.auditId, input.businessId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };

  const actionType = row.action_type as ActionType;
  if (!ACTION_CATALOG[actionType]) {
    await failClaimedProposal(input.businessId, input.auditId, "unknown_action");
    return { ok: false, error: "unknown_action" };
  }

  // The connection must still be entitled to write — no proposal executes on
  // a revoked or narrowed connector's retained authority.
  let connectionLocationId: string | null = null;
  if (row.mcp_connection_id) {
    const { rows: connectionRows } = await query<{
      status: string;
      scopes: unknown;
      location_id: string;
    }>(
      `SELECT status, scopes, location_id FROM mcp_connections
        WHERE id = $1 AND business_id = $2`,
      [row.mcp_connection_id, input.businessId],
    );
    const connection = connectionRows[0];
    const stillWritable =
      connection?.status === "active" &&
      Array.isArray(connection.scopes) &&
      connection.scopes.includes(MCP_SCOPES.write);
    if (!connection || !stillWritable) {
      const error = !connection ? "connection_revoked" : "connection_narrowed";
      await failClaimedProposal(input.businessId, input.auditId, error);
      return { ok: false, error: "not_found" };
    }
    connectionLocationId = connection.location_id;
  }

  // P0-5 — the approver's own CURRENT permissions gate the domain action.
  const decider = await resolveMcpAuthority(input.businessId, input.deciderUserId);
  const refusal = decider ? mcpWriteRefusal(actionType, decider.permissions) : {
    error: "approver_forbidden",
    message: "کاربر تأییدکننده دیگر فعال نیست؛ تغییر اعمال نشد.",
  };
  if (refusal) {
    await releaseClaimToProposed(input.businessId, input.auditId);
    return { ok: false, error: "approver_forbidden" };
  }

  const outcome = await executeClaimedProposal({
    businessId: input.businessId,
    auditId: input.auditId,
    actionType,
    payload: row.proposal_payload ?? {},
    // The approver's own authority, not the connection's: they are the human
    // in the loop, and this is the moment the write becomes theirs.
    authorizedByUserId: input.deciderUserId,
    connectionLocationId,
  });
  return { ok: true, decision: "approve", outcome };
}
