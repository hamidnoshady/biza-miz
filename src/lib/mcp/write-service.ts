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
import { createHash } from "crypto";
import { query } from "../db";
import { ACTION_CATALOG, type ActionType, type AutopilotExecutorKey, type ProposedAction } from "../ai";
import { aiActionPermission } from "../ai-capabilities";
import { AUTOPILOT_EXECUTORS, executorTargetLocation } from "../ai-autopilot-executors";
import { verifyUnattendedAuthority } from "../ai-unattended-authority";
import { resolveBranchRef } from "../branch-service";
import { createAiActionAudit } from "../ai-action-audit";
import { isFeatureEnabled } from "../features";
import type { McpAuthentication } from "./auth";
import { resolveMcpAuthority } from "./authority";
import { isLegacyGrants, mcpBrancheIds, mcpCanWriteApp, parseMcpGrants, type McpGrants } from "./grants";
import { mcpWriteRegistryEntry } from "./registry";
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
 * Issue #883 A5 — the payload of the call, in a form two calls with the same
 * intent always agree on. Key order of the *request* JSON must not change the
 * hash (clients serialize differently), so objects are sorted recursively
 * before hashing. Used ONLY for conflict detection on idempotency replay —
 * never for caching, never for dedupe decisions of its own.
 */
export function mcpPayloadHash(actionType: ActionType, payload: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === "object" && value !== null) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify({ actionType, payload: canonical(payload) }))
    .digest("hex");
}

/**
 * Issue #883 A4 — a `processing` row's maximum lease: if the claimant died
 * (process crash, hard network drop) between the claim and the finalize CAS,
 * the row is reconciled to `failed` after this window instead of sitting in
 * `processing` forever. Fifteen minutes is generous by design: a legitimate
 * executor is seconds at worst, and no finalize can "lose" to the window —
 * the finalize CAS matches only `status='processing'`, so a reconciled row
 * can never be double-finalized.
 */
export const MCP_PROCESSING_STALE_MINUTES = 15;

/**
 * Reconcile rows whose claimant vanished (A4). Called lazily from the pending
 * list and count endpoints so a crashed execution is surfaced to the owner as
 * an actionable failure ("interrupted, review needed"), never silently
 * retried: the executor may have partially run, and re-running it would be a
 * blind replay — which issue #883 explicitly forbids. Reconciliation is one
 * statement, and its result row marks `requiresReview` so the UI shows the
 * owner exactly where to look rather than guessing whether "processing" is
 * alive.
 */
export async function reconcileStaleMcpClaims(businessId: string): Promise<number> {
  const { rowCount } = await query(
    `UPDATE ai_action_audit
        SET status = 'failed',
            result = $2::jsonb,
            processing_started_at = NULL
      WHERE business_id = $1
        AND source = 'mcp'
        AND status = 'processing'
        AND processing_started_at < now() - make_interval(mins => $3)
      RETURNING id`,
    [
      businessId,
      JSON.stringify({
        error: "interrupted",
        requiresReview: true,
        note: "اجرای درخواست ناتمام ماند (سرویس متوقف شد یا پاسخ نیامد) و خودبارانجام دوباره انجام نشد. وضعیت مورد را بررسی کنید.",
      }),
      MCP_PROCESSING_STALE_MINUTES,
    ],
  );
  return rowCount ?? 0;
}

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
  /** Issue #883 A5 — hash of the ORIGINAL call's canonical action+payload, so
   * a replayed key carrying a DIFFERENT request can fail visibly instead of
   * returning an answer to a question the client never asked. */
  payloadHash: string | null;
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
    mcp_idempotency_payload_hash: string | null;
  }>(
    `SELECT id, action_type, status, result, mcp_idempotency_payload_hash
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
        payloadHash: row.mcp_idempotency_payload_hash,
      }
    : null;
}

/**
 * Issue #883 §7 — look up the outcome of a write THROUGH the connection that
 * submitted it, for the dispatcher-native `get_write_status` tool. Returns
 * null when the row does not exist OR belongs to a different connection:
 * a connection may never probe another connection's traffic, and "not found"
 * must not let the tool tell the difference.
 */
export async function findMcpWriteStatus(
  businessId: string,
  connectionId: string,
  auditId: string,
): Promise<{
  status: "pending_approval" | "processing" | "applied" | "failed" | "dismissed";
  actionType: ActionType;
  message: string;
  result: Record<string, unknown> | null;
  requiresReview: boolean;
} | null> {
  const { rows } = await query<{
    action_type: string;
    status: string;
    result: Record<string, unknown> | null;
  }>(
    `SELECT action_type, status, result
       FROM ai_action_audit
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND mcp_connection_id = $3`,
    [auditId, businessId, connectionId],
  );
  const row = rows[0];
  if (!row) return null;
  const actionType = row.action_type as ActionType;
  const meta = ACTION_CATALOG[actionType];
  const title = meta?.label ?? actionType;
  const requiresReview = row.result?.requiresReview === true;
  switch (row.status) {
    case "applied":
      return {
        status: "applied",
        actionType,
        message: `«${title}» انجام شد.`,
        result: row.result,
        requiresReview,
      };
    case "failed":
      return {
        status: "failed",
        actionType,
        message: requiresReview
          ? `اجرای «${title}» ناتمام ماند؛ لطفاً وضعیت مورد را دستی بررسی کنید.`
          : `«${title}» انجام نشد: ${(row.result?.error as string) ?? "خطای نامشخص"}`,
        result: row.result,
        requiresReview,
      };
    case "dismissed":
      return {
        status: "dismissed",
        actionType,
        message: `«${title}» توسط صاحب کسب‌وکار رد شد.`,
        result: row.result,
        requiresReview,
      };
    case "processing":
      // A claimant holds it right now. If the claimant crashed, reconciliation
      // will move it to failed once it goes stale (A4) — until then, the
      // honest answer is "in flight", not a guess.
      return {
        status: "processing",
        actionType,
        message: `«${title}» در حال انجام است.`,
        result: null,
        requiresReview: false,
      };
    default:
      return {
        status: "pending_approval",
        actionType,
        message: `«${title}» در انتظار تأیید صاحب کسب‌وکار است؛ تا تأیید، هیچ تغییری اعمال نشده است.`,
        result: null,
        requiresReview: false,
      };
  }
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

  /**
   * Issue #883 step-up: the registry's risk registry is stronger than the
   * connection's write_mode. `always_approve` actions go to the queue even on
   * an `apply` connection — the human must step up for a financial posting,
   * same as on any apply connection. (Nothing here ever takes an
   * approve-mode write and applies it; step-up only ADDS the human back.)
   */
  const registryStepUp = mcpWriteRegistryEntry(input.actionType)?.approval === "always_approve";
  // Hash BEFORE the row lands so the durable and replay comparisons agree
  // even if a later edit normalizes payloads at store time (A5).
  const payloadHash = input.idempotencyKey
    ? mcpPayloadHash(input.actionType, input.payload)
    : null;

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
              mcp_idempotency_key = $5, mcp_idempotency_payload_hash = $6
        WHERE id = $1 AND business_id = $2`,
      [
        auditId,
        input.auth.businessId,
        meta.autopilotCategory ?? null,
        input.auth.connectionId,
        input.idempotencyKey ?? null,
        payloadHash,
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
      if (stored) {
        // A5 — same key + same payload = the replay the contract was built
        // for. Same key + DIFFERENT payload is a client bug: answer it
        // loudly rather than returning an outcome that belongs to another
        // request. The comparison is null-safe: a row from before the column
        // existed has nothing to compare, which under the forward-only rule
        // is the "same request" case (only a brand-new client can hit it).
        if (
          payloadHash !== null &&
          stored.payloadHash !== null &&
          stored.payloadHash !== payloadHash
        ) {
          return {
            status: "failed",
            auditId: stored.auditId,
            actionType: input.actionType,
            error: "idempotency_conflict",
            message:
              "کلید تکرارنمایی با درخواست متفاوتی دوباره استفاده شده است؛ چیزی انجام نشد. برای فرمان جدید، کلید جدید بفرستید.",
          };
        }
        return outcomeOfStored(stored, input.actionType);
      }
    }
    throw error;
  }

  if (input.auth.writeMode === "approve" || registryStepUp) {
    return {
      status: "pending_approval",
      auditId,
      actionType: input.actionType,
      message:
        input.auth.writeMode === "approve"
          ? `این تغییر ثبت نشد و در انتظار تأیید است. صاحب کسب‌وکار باید آن را در ` +
            `«اتصال‌ها ← دستیارهای هوش مصنوعی» تأیید کند. تا آن زمان هیچ چیزی تغییر نکرده است.`
          : // Step-up: the apply-mode connection asked for a write the risk
            // registry keeps human-confirmed. Say WHY, or the client will just
            // call it again expecting "apply" to mean apply.
            `این تغییر از نوع مالیِ حساس است و حتی با اتصال «بدون تأیید» باید اول توسط صاحب کسب‌وکار ` +
            `در «اتصال‌ها ← دستیارهای هوش مصنوعی» تأیید شود. تا آن زمان هیچ چیزی تغییر نکرده است.`,
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
    allowedBranchIds: mcpWriteAllowedBranches(input.auth),
  });
}

/**
 * The branches a write may target through this connection.
 *
 *   * The legacy `{}` grant document pins the write to the connection's own
 *     branch — the conservative migration the issue demands: pre-wave-2
 *     connections wrote exactly where their pinned branch was, so they keep
 *     doing exactly that.
 *   * "all" means no branch gate beyond the authorizer's own reach (the
 *     owner consented to a business-write credential).
 *   * An explicit array means writes where the TARGET branch is in the
 *     consent — never a branch the owner did not name, regardless of the
 *     pinned branch the connection authenticates on.
 */
export function mcpWriteAllowedBranches(auth: McpAuthentication): string[] | null {
  if (isLegacyGrants(auth.grants)) {
    // A pre-wave-2 row keeps its old meaning: the write gate stays pinned to
    // the connection's own branch, exactly as P0-2 enforced.
    return [auth.locationId];
  }
  return mcpBrancheIds(auth.grants);
}

/**
 * The same rule for a row read from `mcp_connections` at approval time —
 * `decideMcpPendingAction` re-reads the connection (grants may have narrowed
 * since the proposal landed) and must derive the identical answer without an
 * `McpAuthentication` in hand.
 */
function mcpWriteAllowedBranchesFromRow(
  connectionLocationId: string,
  grants: McpGrants,
): string[] | null {
  if (isLegacyGrants(grants)) return [connectionLocationId];
  return mcpBrancheIds(grants);
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
   * The branches the write may touch (issue #883 §1). null = consent "all",
   * which is also what a business-wide write executor needs to run at all;
   * an array = the target branch must be in the array. A write whose target
   * resolves to another branch is refused — the connector minted for one set
   * of branches never moves a row belonging to branches outside it, whatever
   * its authorizer may see (P0-2, reused verbatim for the grant set).
   */
  allowedBranchIds: string[] | null;
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
    input.allowedBranchIds !== null &&
    targetLocationId !== null &&
    !input.allowedBranchIds.includes(targetLocationId)
  ) {
    await failClaimedProposal(input.businessId, input.auditId, "branch_forbidden");
    return {
      status: "failed",
      auditId: input.auditId,
      actionType: input.actionType,
      error: "branch_forbidden",
      message: "هدف این تغییر در شعبه‌های مجاز این اتصال نیست؛ تغییر اعمال نشد.",
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
 *      active with `pos.write` in its scopes, unexpired, and its app-grant
 *      still covering the action's app — a revoked, lapsed or narrowed
 *      connector's queue retains no authority (P0-3, A3);
 *   3. the *authorizer of record* must still exist, be active, and still hold
 *      the action's domain permission — write authority is never retained
 *      past a role change (A3);
 *   4. the *approver's own* current permissions must cover the action's
 *      domain permission (P0-5) — a refusal here releases the claim back to
 *      `proposed`, because another, privileged approver is the remedy, not a
 *      discarded change;
 *   5. for risky actions, the pending row is *only* reachable because
 *      step-up put it there — high-risk apply connections can never skip the
 *      human by switching modes after the fact (registry: `always_approve`).
 *
 * The `proposed → processing` transition is one CAS, because two hits must
 * produce exactly one execution, never two. Anything after the claim either
 * leaves a `failed` terminal (lapsed authority) or returns the claim to
 * `proposed` (the approver's permissions need widening).
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
    actor_user_id: string;
  }>(
    `UPDATE ai_action_audit
        SET status = 'processing', processing_started_at = now()
      WHERE id = $1 AND business_id = $2 AND source = 'mcp' AND status = 'proposed'
      RETURNING action_type, proposal_payload, mcp_connection_id, actor_user_id`,
    [input.auditId, input.businessId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };

  const actionType = row.action_type as ActionType;
  if (!ACTION_CATALOG[actionType]) {
    await failClaimedProposal(input.businessId, input.auditId, "unknown_action");
    return { ok: false, error: "unknown_action" };
  }

  // A3 — the entitlement that lets MCP reach this business must still be on.
  // If A/B testing or plan gating switched `api_platform` off between propose
  // and approve, the credential's right to exist lapses with it.
  if (!(await isFeatureEnabled(input.businessId, "api_platform"))) {
    await failClaimedProposal(input.businessId, input.auditId, "feature_disabled");
    return { ok: false, error: "not_found" };
  }

  // A3 — the complete originating grant is revalidated at approval, not at
  // submit time: connection active AND unexpired AND still holding `pos.write`
  // AND (for its stored grants) still holding the action's app-write grant.
  let allowedBranchIds: string[] | null = null;
  if (row.mcp_connection_id) {
    const { rows: connectionRows } = await query<{
      status: string;
      scopes: unknown;
      location_id: string;
      grants: unknown;
      expires_at: string | null;
    }>(
      `SELECT status, scopes, location_id, grants, expires_at FROM mcp_connections
        WHERE id = $1 AND business_id = $2`,
      [row.mcp_connection_id, input.businessId],
    );
    const connection = connectionRows[0];
    if (!connection) {
      await failClaimedProposal(input.businessId, input.auditId, "connection_revoked");
      return { ok: false, error: "not_found" };
    }
    if (connection.status !== "active") {
      await failClaimedProposal(input.businessId, input.auditId, "connection_revoked");
      return { ok: false, error: "not_found" };
    }
    if (
      !Array.isArray(connection.scopes) ||
      !connection.scopes.includes(MCP_SCOPES.write)
    ) {
      await failClaimedProposal(input.businessId, input.auditId, "connection_narrowed");
      return { ok: false, error: "not_found" };
    }
    // A connection that expired while its proposal sat in the queue lapsed:
    // the owner chose a finite lifetime at mint time and the queue must not
    // spend the credential past it.
    if (connection.expires_at !== null) {
      const { rows: expired } = await query<{ expired: boolean }>(
        `SELECT ($1::timestamptz <= now()) AS expired`,
        [connection.expires_at],
      );
      if (expired[0]?.expired) {
        await failClaimedProposal(input.businessId, input.auditId, "connection_expired");
        return { ok: false, error: "not_found" };
      }
    }
    const grants = parseMcpGrants(connection.grants);
    const entry = mcpWriteRegistryEntry(actionType);
    if (entry && !mcpCanWriteApp(grants, entry.app)) {
      await failClaimedProposal(input.businessId, input.auditId, "grant_revoked");
      return { ok: false, error: "not_found" };
    }
    allowedBranchIds = mcpWriteAllowedBranchesFromRow(connection.location_id, grants);
  }

  // A3 — the authorizer of record must still hold the authority the write was
  // proposed under. The audit row's actor_user_id IS the authorizer for MCP
  // writes (see createAiActionAudit in performMcpWrite): re-read fresh.
  {
    const authorizer = await resolveMcpAuthority(input.businessId, row.actor_user_id);
    const authorizerRefusal = authorizer
      ? mcpWriteRefusal(actionType, authorizer.permissions)
      : { error: "authorizer_ineligible" };
    if (authorizerRefusal) {
      await failClaimedProposal(input.businessId, input.auditId, authorizerRefusal.error);
      return { ok: false, error: "not_found" };
    }
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
    allowedBranchIds,
  });
  return { ok: true, decision: "approve", outcome };
}
