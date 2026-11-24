/**
 * Issue #1431 — the application layer for a business lifecycle move.
 *
 * The transition TABLE (`platform-business-lifecycle.ts`) says what is legal
 * and which capability a move needs. The status SETTER (`setBusinessStatus`)
 * is the one service that writes `businesses.status`. This module joins them
 * for callers that need the whole mutation contract — an explicit target, a
 * stale-state expectation, a target-specific typed confirmation, an idempotent
 * retry and a durable audit row — without re-deriving any of those rules.
 *
 * Two properties matter for the MCP tools that call it:
 *
 *   1. **One write path.** The status update is still `setBusinessStatus(...,
 *      { expectFrom })`: the same conditional UPDATE the console route uses,
 *      so two operators (or a retry) cannot both win. This module adds no SQL
 *      that mutates `businesses.status`.
 *   2. **The audit trail is the idempotency ledger.** A successful lifecycle
 *      row records the caller's `idempotencyKey` and actor. A retry with the
 *      same actor/key/business/target reads that row and replays the recorded
 *      outcome; a key reused for another business or transition fails closed
 *      instead of silently acting twice.
 */
import type { PlatformAdminRole, PlatformCapability } from "./platform-admin";
import {
  businessLifecycleConfirmationPhrase,
  businessLifecycleTransition,
  isBusinessLifecycleStatus,
  type BusinessLifecycleConfirmationAction,
  type BusinessLifecycleStatus,
} from "./platform-business-lifecycle";
import type { BusinessSummary } from "./platform-service";
import { getBusiness, setBusinessStatus } from "./platform-service";
import { platformAudit } from "./platform-auth";
import { query, withoutTenantScope } from "./db";

export type BusinessLifecycleMutationErrorCode =
  | "business_not_found"
  | "protected_internal_business"
  | "invalid_transition"
  | "same_status"
  | "stale_state"
  | "transition_conflict"
  | "confirmation_mismatch"
  | "capability_denied"
  | "idempotency_key_invalid"
  | "correlation_id_invalid"
  | "idempotency_conflict";

/**
 * A refused lifecycle mutation. `code` is the stable machine token tool
 * callers branch on; `details` is deliberately limited to ids, states and
 * reasons — never database text, a phrase the caller guessed, or another
 * tenant's identity.
 */
export class BusinessLifecycleMutationError extends Error {
  readonly code: BusinessLifecycleMutationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: BusinessLifecycleMutationErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = "BusinessLifecycleMutationError";
    this.code = code;
    this.details = details;
  }
}

export interface BusinessLifecycleMutationActor {
  adminId: string;
  adminName?: string;
  adminRole?: PlatformAdminRole;
  /** The MCP connection the call arrived on, when the actor is a machine. */
  connectionId?: string;
  connectionName?: string;
  source: "platform_mcp" | "console";
}

export interface ApplyBusinessLifecycleInput {
  businessId: string;
  to: BusinessLifecycleStatus;
  /** The status the caller last observed. A mismatch is a stale screen. */
  expectedFrom: BusinessLifecycleStatus;
  action: BusinessLifecycleConfirmationAction;
  /** The target-specific phrase the operator typed. */
  confirmation: string;
  /** Stable per-attempt key; a replay returns the original outcome. */
  idempotencyKey: string;
  /** Audit correlation id shared by the lifecycle row and the MCP call row. */
  correlationId: string;
  actor: BusinessLifecycleMutationActor;
  /** The capability set that actually applies (credential ∩ current role). */
  effectiveCapabilities: readonly PlatformCapability[];
  reason?: string;
}

export interface BusinessLifecycleMutationResult {
  ok: true;
  businessId: string;
  action: BusinessLifecycleConfirmationAction;
  from: BusinessLifecycleStatus;
  to: BusinessLifecycleStatus;
  status: BusinessLifecycleStatus;
  capability: PlatformCapability;
  auditAction: string;
  correlationId: string;
  idempotencyKey: string;
  replayed: boolean;
  /** The lifecycle-relevant projection, never the directory's counts. */
  business: BusinessLifecycleBusinessView | null;
  currentStatus: BusinessLifecycleStatus | null;
}

/**
 * The subset of a business a lifecycle result may return. Deliberately not
 * `BusinessSummary`: a credential minted with `business.archive` alone must
 * not learn member/order/location counts it did not ask for.
 */
export interface BusinessLifecycleBusinessView {
  id: string;
  name: string;
  slug: string;
  status: BusinessLifecycleStatus;
  suspendedAt: string | null;
  archivedAt: string | null;
}

interface LifecycleAuditRow extends Record<string, unknown> {
  business_id: string | null;
  action: string;
  payload: Record<string, unknown> | null;
}

function normalizeIdempotencyKey(value: string): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key || key.length > 200) {
    throw new BusinessLifecycleMutationError("idempotency_key_invalid", { maxLength: 200 });
  }
  return key;
}

function normalizeCorrelationId(value: string, idempotencyKey: string): string {
  const supplied = typeof value === "string" ? value.trim() : "";
  const correlationId = supplied || `idem:${idempotencyKey}`;
  if (correlationId.length > 200) {
    throw new BusinessLifecycleMutationError("correlation_id_invalid", {
      maxLength: 200,
    });
  }
  return correlationId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lifecycleBusinessView(
  business: BusinessSummary | null,
): BusinessLifecycleBusinessView | null {
  if (!business) return null;
  return {
    id: business.id,
    name: business.name,
    slug: business.slug,
    status: business.status,
    suspendedAt: business.suspendedAt,
    archivedAt: business.archivedAt,
  };
}

/**
 * The previous successful outcome for this actor/key, if one exists.
 *
 * Scoped by platform admin so a retry keeps working across connection
 * rotation, while a key minted by a different actor can never read — or
 * replay — someone else's outcome. The partial expression index added by
 * migration 0319 makes this the cheap path rather than a full audit scan.
 */
async function findLifecycleReplay(
  adminId: string,
  idempotencyKey: string,
  source: BusinessLifecycleMutationActor["source"],
): Promise<LifecycleAuditRow | null> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<LifecycleAuditRow>(
      `SELECT business_id::text AS business_id, action, payload
         FROM platform_audit_log
        WHERE platform_admin_id = $1
          AND action IN ('business.archived', 'business.active')
          AND payload->>'source' = $3
          AND payload->>'idempotencyKey' = $2
          AND payload->>'outcome' = 'succeeded'
        ORDER BY id DESC
        LIMIT 1`,
      [adminId, idempotencyKey, source],
    );
    return rows[0] ?? null;
  });
}

async function replayOutcome(
  row: LifecycleAuditRow,
  input: ApplyBusinessLifecycleInput,
  idempotencyKey: string,
  requestCorrelationId: string,
): Promise<BusinessLifecycleMutationResult> {
  const payload = asRecord(row.payload);
  if (!payload) {
    throw new BusinessLifecycleMutationError("idempotency_conflict", {
      reason: "replay_payload_missing",
    });
  }
  if (row.business_id !== input.businessId) {
    // Never name the other tenant: the caller only needs to know the key is
    // not reusable here.
    throw new BusinessLifecycleMutationError("idempotency_conflict", {
      reason: "key_reused_across_businesses",
    });
  }

  const storedAction = payload.action;
  const storedFrom = payload.from;
  const storedTo = payload.to;
  const from = isBusinessLifecycleStatus(storedFrom) ? storedFrom : null;
  const to = isBusinessLifecycleStatus(storedTo) ? storedTo : null;
  const action =
    storedAction === "archive" || storedAction === "restore" ? storedAction : null;
  if (
    !from ||
    !to ||
    !action ||
    action !== input.action ||
    to !== input.to ||
    from !== input.expectedFrom
  ) {
    throw new BusinessLifecycleMutationError("idempotency_conflict", {
      reason: "key_reused_for_different_transition",
      from,
      to,
      action,
    });
  }

  const storedCapability =
    typeof payload.capability === "string"
      ? (payload.capability as PlatformCapability)
      : null;
  if (!storedCapability || !input.effectiveCapabilities.includes(storedCapability)) {
    throw new BusinessLifecycleMutationError("capability_denied", {
      capability: storedCapability,
    });
  }

  const current = await getBusiness(input.businessId);
  return {
    ok: true,
    businessId: input.businessId,
    action,
    from,
    to,
    status: to,
    capability: storedCapability,
    auditAction: row.action,
    correlationId:
      typeof payload.correlationId === "string" && payload.correlationId
        ? payload.correlationId
        : requestCorrelationId,
    idempotencyKey,
    replayed: true,
    // A replay never writes. The fresh read tells the caller what the tenant
    // looks like NOW, while from/to describe the historical mutation.
    business: lifecycleBusinessView(current),
    currentStatus: current?.status ?? null,
  };
}

/**
 * Apply one archive-boundary lifecycle move.
 *
 * Order is intentional: capability before state, state before the phrase, and
 * the conditional UPDATE last. An unauthorized caller learns nothing about a
 * tenant's current status through a phrase oracle, and a stale screen can
 * never overwrite a newer decision.
 */
export async function applyBusinessLifecycleTransition(
  input: ApplyBusinessLifecycleInput,
): Promise<BusinessLifecycleMutationResult> {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const correlationId = normalizeCorrelationId(input.correlationId, idempotencyKey);

  // A retry must be answered from the durable outcome even after the business
  // has left the pre-transition state, otherwise every retry looks like a
  // stale screen.
  const prior = await findLifecycleReplay(
    input.actor.adminId,
    idempotencyKey,
    input.actor.source,
  );
  if (prior) return replayOutcome(prior, input, idempotencyKey, correlationId);

  const business = await getBusiness(input.businessId);
  if (!business) {
    throw new BusinessLifecycleMutationError("business_not_found", {
      businessId: input.businessId,
    });
  }
  if (business.ownershipKind === "platform_internal") {
    throw new BusinessLifecycleMutationError("protected_internal_business", {
      businessId: business.id,
    });
  }

  const decision = businessLifecycleTransition(business.status, input.to);
  if (!decision.ok) {
    throw new BusinessLifecycleMutationError(decision.error, {
      from: business.status,
      to: input.to,
    });
  }
  const transition = decision.transition;

  // The declared action has to be the transition's own confirmation action:
  // a phrase for one direction can never authorize the other.
  if (transition.confirmationAction !== input.action) {
    throw new BusinessLifecycleMutationError("invalid_transition", {
      from: business.status,
      to: input.to,
      expectedAction: transition.confirmationAction ?? null,
      action: input.action,
    });
  }

  if (!input.effectiveCapabilities.includes(transition.capability)) {
    throw new BusinessLifecycleMutationError("capability_denied", {
      capability: transition.capability,
      from: business.status,
      to: input.to,
    });
  }

  if (business.status !== input.expectedFrom) {
    throw new BusinessLifecycleMutationError("stale_state", {
      from: business.status,
      expectedFrom: input.expectedFrom,
      to: input.to,
    });
  }

  const expectedPhrase = businessLifecycleConfirmationPhrase(
    transition.confirmationAction,
    business.slug,
  );
  const suppliedPhrase = typeof input.confirmation === "string" ? input.confirmation.trim() : "";
  if (suppliedPhrase !== expectedPhrase) {
    throw new BusinessLifecycleMutationError("confirmation_mismatch", {
      action: input.action,
      businessId: business.id,
    });
  }

  // The console's own setter: one conditional UPDATE, so a concurrent writer
  // that read the same `from` status cannot also win.
  const updated = await setBusinessStatus(business.id, input.to, {
    expectFrom: business.status,
  });
  if (!updated) {
    // A concurrent identical request may have completed between our read and
    // this UPDATE and already written its durable outcome. Re-read it; only a
    // genuinely different write is a conflict.
    const concurrent = await findLifecycleReplay(
      input.actor.adminId,
      idempotencyKey,
      input.actor.source,
    );
    if (concurrent) return replayOutcome(concurrent, input, idempotencyKey, correlationId);
    throw new BusinessLifecycleMutationError("transition_conflict", {
      from: business.status,
      to: input.to,
    });
  }

  const before = {
    status: business.status,
    suspendedAt: business.suspendedAt,
    archivedAt: business.archivedAt,
  };
  const after = {
    status: updated.status,
    suspendedAt: updated.suspendedAt,
    archivedAt: updated.archivedAt,
  };

  await platformAudit({
    adminId: input.actor.adminId,
    businessId: business.id,
    action: transition.auditAction,
    entity: "business",
    entityId: business.id,
    payload: {
      source: input.actor.source,
      action: input.action,
      from: business.status,
      to: updated.status,
      expectedFrom: input.expectedFrom,
      before,
      after,
      capability: transition.capability,
      actor: {
        adminId: input.actor.adminId,
        adminName: input.actor.adminName ?? null,
        adminRole: input.actor.adminRole ?? null,
        connectionId: input.actor.connectionId ?? null,
        connectionName: input.actor.connectionName ?? null,
      },
      business: { id: business.id, name: business.name, slug: business.slug },
      correlationId,
      idempotencyKey,
      reason: input.reason?.trim() || null,
      outcome: "succeeded",
    },
  });

  return {
    ok: true,
    businessId: business.id,
    action: input.action,
    from: business.status,
    to: updated.status,
    status: updated.status,
    capability: transition.capability,
    auditAction: transition.auditAction,
    correlationId,
    idempotencyKey,
    replayed: false,
    business: lifecycleBusinessView(updated),
    currentStatus: updated.status,
  };
}
