/**
 * Issue #984 — attended remote assistance sessions, requested from the ticket.
 *
 * Request/consent/state/outcome live on the same ticket; approval happens
 * locally in the companion and stays capability-specific (view approval never
 * authorises input, file transfer, clipboard, recording or elevation).
 * Capture/input leases expire within 30 seconds without renewal; local Stop,
 * admin revoke, offline transition and lease expiry all terminate through
 * here with an honest recorded reason.
 *
 * This module owns the request/consent/lease/revoke records. The media/input
 * transport is the broker in ./remote-broker (self-hosted MeshCentral,
 * device share links): `operatorJoinSession` binds a short-lived share,
 * termination revokes it best-effort with the share's own expiry as the
 * backstop. Until a share is bound, a session can never reach an active
 * media state — there are no fake “connected” sessions.
 */
import { getPool, query } from "../db";
import {
  createBrokerShare,
  resolveRemoteBrokerConfig,
  revokeBrokerShare,
  shareParamsForCaps,
  type BrokerTransport,
  type ResolvedRemoteBroker,
} from "./remote-broker";
import {
  SUPPORT_LEASE_SECONDS,
  SUPPORT_SESSION_DEFAULT_MINUTES,
  SUPPORT_SESSION_MAX_MINUTES,
  isSupportAssistanceCap,
  isSupportAssistanceState,
  isTerminalAssistanceState,
  type SupportAssistanceCap,
  type SupportAssistanceState,
} from "./types";
import { getInstallation } from "./installations";

export interface AssistanceSession {
  id: string;
  businessId: string;
  ticketId: string;
  installationId: string;
  operatorAdminId: string;
  requestedCaps: SupportAssistanceCap[];
  approvedCaps: SupportAssistanceCap[];
  state: SupportAssistanceState;
  reason: string;
  consentProof: Record<string, unknown>;
  policyVersion: string;
  engineBinding: Record<string, unknown>;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  participants: unknown[];
  createdAt: string;
  updatedAt: string;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  ticket_id: string;
  installation_id: string;
  operator_admin_id: string;
  requested_caps: SupportAssistanceCap[];
  approved_caps: SupportAssistanceCap[];
  state: SupportAssistanceState;
  reason: string;
  consent_proof: Record<string, unknown>;
  policy_version: string;
  engine_binding: Record<string, unknown>;
  lease_epoch: number;
  lease_expires_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  participants: unknown[];
  created_at: string;
  updated_at: string;
}

const SESSION_SELECT = `
  SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
         installation_id::text AS installation_id, operator_admin_id::text AS operator_admin_id,
         requested_caps, approved_caps, state, reason, consent_proof, policy_version,
         engine_binding, lease_epoch, lease_expires_at, started_at, ended_at, end_reason,
         participants, created_at, updated_at
    FROM support_assistance_sessions
`;

function toSession(row: SessionRow): AssistanceSession {
  return {
    id: row.id,
    businessId: row.business_id,
    ticketId: row.ticket_id,
    installationId: row.installation_id,
    operatorAdminId: row.operator_admin_id,
    requestedCaps: (row.requested_caps ?? []).filter(isSupportAssistanceCap),
    approvedCaps: (row.approved_caps ?? []).filter(isSupportAssistanceCap),
    state: row.state,
    reason: row.reason,
    consentProof: row.consent_proof ?? {},
    policyVersion: row.policy_version,
    engineBinding: row.engine_binding ?? { provider: "none" },
    leaseEpoch: row.lease_epoch,
    leaseExpiresAt: row.lease_expires_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    participants: Array.isArray(row.participants) ? row.participants : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AssistanceEvent {
  id: string;
  sessionId: string;
  seq: number;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

async function ticketBusinessId(ticketId: string): Promise<string | null> {
  const { rows } = await query<{ business_id: string }>(
    `SELECT business_id::text AS business_id FROM support_tickets WHERE id = $1::uuid`,
    [ticketId],
  );
  return rows[0]?.business_id ?? null;
}

async function appendEvent(
  businessId: string,
  sessionId: string,
  kind: string,
  actor: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Lock the session row so concurrent writers cannot mint the same seq.
    await client.query(`SELECT id FROM support_assistance_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
    const { rows } = await client.query<{ next: string }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM support_assistance_events WHERE session_id = $1`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO support_assistance_events (business_id, session_id, seq, kind, actor, payload)
       VALUES ($1, $2::uuid, $3, $4, $5, $6)`,
      [businessId, sessionId, Number(rows[0].next), kind.slice(0, 80), actor.slice(0, 80), JSON.stringify(payload)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type RequestSessionResult =
  | { ok: true; session: AssistanceSession }
  | {
      ok: false;
      error:
        | "ticket_not_found"
        | "installation_not_found"
        | "installation_not_active"
        | "reason_required"
        | "caps_required"
        | "session_already_live";
    };

/**
 * Persists an assistance request for one verified ticket + installation.
 * Only one live session per installation: a second request while one is
 * live is refused instead of queuing silent parallel control.
 */
export async function requestAssistanceSession(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  operatorAdminId: string;
  requestedCaps: unknown;
  reason: string;
  durationMinutes?: number;
}): Promise<RequestSessionResult> {
  if (!input.reason.trim()) return { ok: false, error: "reason_required" };
  const caps = (Array.isArray(input.requestedCaps) ? input.requestedCaps : []).filter(
    isSupportAssistanceCap,
  );
  const uniqueCaps = [...new Set(caps)];
  if (uniqueCaps.length === 0) return { ok: false, error: "caps_required" };
  const ownerBusinessId = await ticketBusinessId(input.ticketId);
  if (!ownerBusinessId || ownerBusinessId !== input.businessId) {
    return { ok: false, error: "ticket_not_found" };
  }
  const installation = await getInstallation(input.businessId, input.installationId);
  if (!installation) return { ok: false, error: "installation_not_found" };
  if (installation.enrollmentState !== "active") return { ok: false, error: "installation_not_active" };

  const { rows: live } = await query<{ id: string }>(
    `SELECT id FROM support_assistance_sessions
      WHERE business_id = $1 AND installation_id = $2::uuid
        AND state IN ('requested', 'awaiting_local_consent', 'approved', 'connecting', 'active_view', 'active_control')
      LIMIT 1`,
    [input.businessId, input.installationId],
  );
  if (live[0]) return { ok: false, error: "session_already_live" };

  const minutes = Math.min(
    Math.max(Math.floor(input.durationMinutes ?? SUPPORT_SESSION_DEFAULT_MINUTES), 1),
    SUPPORT_SESSION_MAX_MINUTES,
  );
  const { rows } = await query<SessionRow>(
    `INSERT INTO support_assistance_sessions
       (business_id, ticket_id, installation_id, operator_admin_id,
        requested_caps, reason, lease_expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, now() + make_interval(mins => $7))
     RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
       installation_id::text AS installation_id, operator_admin_id::text AS operator_admin_id,
       requested_caps, approved_caps, state, reason, consent_proof, policy_version,
       engine_binding, lease_epoch, lease_expires_at, started_at, ended_at, end_reason,
       participants, created_at, updated_at`,
    [
      input.businessId,
      input.ticketId,
      input.installationId,
      input.operatorAdminId,
      uniqueCaps,
      input.reason.trim().slice(0, 2000),
      minutes,
    ],
  );
  const session = toSession(rows[0]);
  await appendEvent(input.businessId, session.id, "requested", `operator:${input.operatorAdminId}`, {
    requestedCaps: uniqueCaps,
    durationMinutes: minutes,
  });
  return { ok: true, session };
}

export async function getAssistanceSession(
  businessId: string,
  sessionId: string,
): Promise<AssistanceSession | null> {
  const { rows } = await query<SessionRow>(`${SESSION_SELECT} WHERE id = $1::uuid AND business_id = $2`, [
    sessionId,
    businessId,
  ]);
  return rows[0] ? toSession(rows[0]) : null;
}

export async function listTicketAssistanceSessions(
  businessId: string,
  ticketId: string,
): Promise<AssistanceSession[]> {
  const { rows } = await query<SessionRow>(
    `${SESSION_SELECT} WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toSession);
}

/** What a verified companion polls: its installation's sessions awaiting local consent. */
export async function listSessionsAwaitingConsent(
  businessId: string,
  installationId: string,
): Promise<AssistanceSession[]> {
  const { rows } = await query<SessionRow>(
    `${SESSION_SELECT}
      WHERE business_id = $1 AND installation_id = $2::uuid
        AND state IN ('requested', 'awaiting_local_consent')
      ORDER BY created_at ASC`,
    [businessId, installationId],
  );
  return rows.map(toSession);
}

export async function listAssistanceEvents(
  businessId: string,
  sessionId: string,
): Promise<AssistanceEvent[]> {
  const { rows } = await query<
    { id: string; session_id: string; seq: string; kind: string; actor: string; payload: Record<string, unknown>; created_at: string } & Record<string, unknown>
  >(
    `SELECT id::text AS id, session_id::text AS session_id, seq::text AS seq, kind, actor, payload, created_at
       FROM support_assistance_events
      WHERE business_id = $1 AND session_id = $2::uuid ORDER BY seq ASC`,
    [businessId, sessionId],
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    seq: Number(row.seq),
    kind: row.kind,
    actor: row.actor,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  }));
}

export type SessionTransitionResult =
  | { ok: true; session: AssistanceSession }
  | { ok: false; error: "session_not_found" | "terminal_state" | "invalid_transition" };

async function setSessionState(
  businessId: string,
  sessionId: string,
  to: SupportAssistanceState,
  patch: Record<string, unknown> = {},
): Promise<AssistanceSession> {
  const sets: string[] = ["state = $3", "updated_at = now()"];
  const values: unknown[] = [sessionId, businessId, to];
  let index = 4;
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = $${index}`);
    values.push(value);
    index += 1;
  }
  const { rows } = await query<SessionRow>(
    `UPDATE support_assistance_sessions SET ${sets.join(", ")}
      WHERE id = $1::uuid AND business_id = $2
      RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
        installation_id::text AS installation_id, operator_admin_id::text AS operator_admin_id,
        requested_caps, approved_caps, state, reason, consent_proof, policy_version,
        engine_binding, lease_epoch, lease_expires_at, started_at, ended_at, end_reason,
        participants, created_at, updated_at`,
    values as string[],
  );
  return toSession(rows[0]);
}

/** The companion fetched the request: it is now visibly awaiting the customer. */
export async function markSessionDelivered(
  businessId: string,
  sessionId: string,
): Promise<SessionTransitionResult> {
  const current = await getAssistanceSession(businessId, sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (current.state !== "requested") return { ok: true, session: current };
  const session = await setSessionState(businessId, sessionId, "awaiting_local_consent");
  await appendEvent(businessId, sessionId, "delivered", "companion");
  return { ok: true, session };
}

export type RecordConsentResult =
  | { ok: true; session: AssistanceSession }
  | { ok: false; error: "session_not_found" | "terminal_state" | "invalid_transition" | "caps_required" };

/**
 * Records the customer's local decision. Approved caps are intersected with
 * the requested caps — the customer can narrow, never widen — and a denied
 * decision ends the session as `revoked` with the customer's reason.
 */
export async function recordLocalConsent(input: {
  businessId: string;
  sessionId: string;
  approved: boolean;
  approvedCaps?: unknown;
  proof?: Record<string, unknown>;
}): Promise<RecordConsentResult> {
  const current = await getAssistanceSession(input.businessId, input.sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (current.state !== "requested" && current.state !== "awaiting_local_consent") {
    return { ok: false, error: "invalid_transition" };
  }
  if (!input.approved) {
    const session = await setSessionState(input.businessId, input.sessionId, "revoked", {
      end_reason: "customer_declined",
      ended_at: new Date().toISOString(),
    });
    await appendEvent(input.businessId, input.sessionId, "consent_denied", "customer");
    return { ok: true, session };
  }
  const approved = (Array.isArray(input.approvedCaps) ? input.approvedCaps : []).filter(
    isSupportAssistanceCap,
  );
  const narrowed = [...new Set(approved)].filter((cap) => current.requestedCaps.includes(cap));
  if (narrowed.length === 0) return { ok: false, error: "caps_required" };
  const session = await setSessionState(input.businessId, input.sessionId, "approved", {
    approved_caps: narrowed,
    consent_proof: JSON.stringify({
      ...(input.proof ?? {}),
      decidedBy: "customer",
      approvedCaps: narrowed,
      decidedAt: new Date().toISOString(),
    }),
  });
  await appendEvent(input.businessId, input.sessionId, "consent_granted", "customer", {
    approvedCaps: narrowed,
  });
  return { ok: true, session };
}

export type OperatorJoinResult =
  | { ok: true; session: AssistanceSession; operatorUrl: string }
  | {
      ok: false;
      error:
        | "session_not_found"
        | "terminal_state"
        | "invalid_transition"
        | "provider_not_configured"
        | "agent_not_linked"
        | "provider_unreachable"
        | "provider_error";
    };

export interface BrokerOverrides {
  broker?: ResolvedRemoteBroker;
  transport?: BrokerTransport;
}

/**
 * The privileged operator joins from the browser ticket UI. Admission moves
 * `approved → connecting`; reaching a live media state additionally requires
 * a qualified engine binding, so an unconfigured provider can never show a
 * fake active session.
 */
export async function operatorJoinSession(
  businessId: string,
  sessionId: string,
  operatorAdminId: string,
  overrides: BrokerOverrides = {},
): Promise<OperatorJoinResult> {
  const current = await getAssistanceSession(businessId, sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (current.state !== "approved") return { ok: false, error: "invalid_transition" };
  if (current.operatorAdminId !== operatorAdminId) return { ok: false, error: "invalid_transition" };

  let broker = overrides.broker;
  if (!broker) {
    try {
      broker = resolveRemoteBrokerConfig();
    } catch {
      return { ok: false, error: "provider_not_configured" };
    }
  }
  if (broker.provider === "none") return { ok: false, error: "provider_not_configured" };

  const installation = await getInstallation(businessId, current.installationId);
  const nodeId = installation?.meshNodeId?.trim() || "";
  if (!nodeId) return { ok: false, error: "agent_not_linked" };

  const share = await createBrokerShare(
    broker,
    {
      nodeId,
      guestName: `support-${current.ticketId.slice(0, 8)}-${sessionId.slice(0, 8)}`,
      viewOnly: shareParamsForCaps(current.approvedCaps).viewOnly,
      minutes: SUPPORT_SESSION_MAX_MINUTES,
    },
    overrides.transport,
  );
  if (!share.ok) {
    // The session stays `approved`: a failed bind is retryable, never a
    // fake "connected" session.
    await appendEvent(businessId, sessionId, "engine_bind_failed", `operator:${operatorAdminId}`, {
      error: share.error,
      ...(share.detail ? { detail: share.detail } : {}),
    }).catch(() => {});
    return { ok: false, error: share.error };
  }

  // The binding stores the share id (what revoke needs) — never the guest
  // URL, which is returned once to the operator. Companion-facing session
  // reads must never see it.
  const session = await setSessionState(businessId, sessionId, "connecting", {
    engine_binding: JSON.stringify({ ...share.binding, boundAt: new Date().toISOString() }),
    started_at: new Date().toISOString(),
  });
  await appendEvent(businessId, sessionId, "operator_joined", `operator:${operatorAdminId}`, {
    shareId: share.binding.shareId,
    viewOnly: share.binding.viewOnly,
    endsAt: share.binding.endsAt,
  });
  return { ok: true, session, operatorUrl: share.operatorUrl };
}

export type OperatorRejoinResult =
  | { ok: true; session: AssistanceSession; operatorUrl: string }
  | {
      ok: false;
      error:
        | "session_not_found"
        | "terminal_state"
        | "invalid_transition"
        | "lease_expired"
        | "provider_not_configured"
        | "agent_not_linked"
        | "provider_unreachable"
        | "provider_error";
    };

/**
 * The operator's media dropped (closed tab, dead share) while the session
 * is still live: revoke the old binding best-effort and bind a fresh
 * share for the same operator and approved caps. Only from a live media
 * state (`connecting`/`active_view`/`active_control`) with a live lease —
 * first joins stay on `operatorJoinSession`, and a lapsed lease expires
 * the session instead of silently resuming remote input.
 */
export async function operatorRejoinSession(
  businessId: string,
  sessionId: string,
  operatorAdminId: string,
  overrides: BrokerOverrides = {},
): Promise<OperatorRejoinResult> {
  const current = await getAssistanceSession(businessId, sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (current.state !== "connecting" && current.state !== "active_view" && current.state !== "active_control") {
    return { ok: false, error: "invalid_transition" };
  }
  if (current.operatorAdminId !== operatorAdminId) return { ok: false, error: "invalid_transition" };
  if (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() <= Date.now()) {
    await setSessionState(businessId, sessionId, "expired", {
      end_reason: "lease_expired",
      ended_at: new Date().toISOString(),
    });
    await appendEvent(businessId, sessionId, "lease_expired", "system");
    await revokeEngineBinding(businessId, current, "system", overrides);
    return { ok: false, error: "lease_expired" };
  }

  let broker = overrides.broker;
  if (!broker) {
    try {
      broker = resolveRemoteBrokerConfig();
    } catch {
      return { ok: false, error: "provider_not_configured" };
    }
  }
  if (broker.provider === "none") return { ok: false, error: "provider_not_configured" };

  const installation = await getInstallation(businessId, current.installationId);
  const nodeId = installation?.meshNodeId?.trim() || "";
  if (!nodeId) return { ok: false, error: "agent_not_linked" };

  // Best-effort unbind of the stale share first (already-gone tolerant);
  // the fresh bind below replaces the engine_binding row wholesale.
  const oldShareId =
    typeof (current.engineBinding as { shareId?: unknown }).shareId === "string"
      ? ((current.engineBinding as { shareId: string }).shareId)
      : "";
  await revokeEngineBinding(businessId, current, `operator:${operatorAdminId}`, overrides);

  const share = await createBrokerShare(
    broker,
    {
      nodeId,
      guestName: `support-${current.ticketId.slice(0, 8)}-${sessionId.slice(0, 8)}`,
      viewOnly: shareParamsForCaps(current.approvedCaps).viewOnly,
      minutes: SUPPORT_SESSION_MAX_MINUTES,
    },
    overrides.transport,
  );
  if (!share.ok) {
    await appendEvent(businessId, sessionId, "engine_bind_failed", `operator:${operatorAdminId}`, {
      error: share.error,
      rejoin: true,
      ...(share.detail ? { detail: share.detail } : {}),
    }).catch(() => {});
    return { ok: false, error: share.error };
  }

  const session = await setSessionState(businessId, sessionId, "connecting", {
    engine_binding: JSON.stringify({ ...share.binding, boundAt: new Date().toISOString() }),
  });
  await appendEvent(businessId, sessionId, "operator_rejoined", `operator:${operatorAdminId}`, {
    shareId: share.binding.shareId,
    previousShareId: oldShareId,
    viewOnly: share.binding.viewOnly,
    endsAt: share.binding.endsAt,
  });
  return { ok: true, session, operatorUrl: share.operatorUrl };
}

export type RenewLeaseResult =
  | { ok: true; session: AssistanceSession }
  | {
      ok: false;
      error: "session_not_found" | "terminal_state" | "invalid_transition" | "lease_expired";
    };

/**
 * Renews a live capture/input lease by one 30-second epoch. A lapsed lease
 * ends the session as `expired` — reconnect never silently resumes remote
 * input; it needs a live lease and renewed consent.
 */
export async function renewSessionLease(
  businessId: string,
  sessionId: string,
): Promise<RenewLeaseResult> {
  const current = await getAssistanceSession(businessId, sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (current.state !== "active_view" && current.state !== "active_control") {
    return { ok: false, error: "invalid_transition" };
  }
  if (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() <= Date.now()) {
    const session = await setSessionState(businessId, sessionId, "expired", {
      end_reason: "lease_expired",
      ended_at: new Date().toISOString(),
    });
    await appendEvent(businessId, sessionId, "lease_expired", "system");
    return { ok: false, error: "lease_expired" };
  }
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<SessionRow>(
      `UPDATE support_assistance_sessions
          SET lease_epoch = lease_epoch + 1,
              lease_expires_at = now() + make_interval(secs => $3),
              updated_at = now()
        WHERE id = $1::uuid AND business_id = $2
        RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
          installation_id::text AS installation_id, operator_admin_id::text AS operator_admin_id,
          requested_caps, approved_caps, state, reason, consent_proof, policy_version,
          engine_binding, lease_epoch, lease_expires_at, started_at, ended_at, end_reason,
          participants, created_at, updated_at`,
      [sessionId, businessId, SUPPORT_LEASE_SECONDS],
    );
    return { ok: true, session: toSession(rows[0]) };
  } finally {
    client.release();
  }
}

export type EndSessionResult =
  | { ok: true; session: AssistanceSession }
  | { ok: false; error: "session_not_found" | "terminal_state" };

/**
 * Best-effort engine unbind after a session reaches a terminal state. Local
 * termination is authoritative (Stop/revoke always wins immediately); the
 * broker revoke kills the operator's transport, and a failure is journaled
 * honestly — the share's own `end` remains the backstop, so a failed call
 * still dies at expiry.
 */
async function revokeEngineBinding(
  businessId: string,
  session: AssistanceSession,
  actor: string,
  overrides: BrokerOverrides = {},
): Promise<void> {
  const binding = session.engineBinding as {
    provider?: unknown;
    nodeId?: unknown;
    shareId?: unknown;
    revokedAt?: unknown;
  };
  if (binding.provider !== "meshcentral" || typeof binding.shareId !== "string" ||
      typeof binding.nodeId !== "string" || typeof binding.revokedAt === "string") {
    return;
  }
  let broker = overrides.broker;
  if (!broker) {
    try {
      broker = resolveRemoteBrokerConfig();
    } catch {
      broker = { provider: "none" };
    }
  }
  const revoked = await revokeBrokerShare(
    broker,
    { nodeId: binding.nodeId, shareId: binding.shareId },
    overrides.transport,
  ).catch((err: unknown) => ({
    ok: false as const,
    error: "provider_unreachable" as const,
    detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
  }));
  if (revoked.ok) {
    await query(
      `UPDATE support_assistance_sessions
          SET engine_binding = engine_binding || $3::jsonb, updated_at = now()
        WHERE id = $1::uuid AND business_id = $2`,
      [session.id, businessId, JSON.stringify({ revokedAt: new Date().toISOString() })],
    ).catch(() => {});
    await appendEvent(businessId, session.id, "engine_unbound", actor, {
      shareId: binding.shareId,
    }).catch(() => {});
  } else {
    await appendEvent(businessId, session.id, "engine_revoke_failed", actor, {
      shareId: binding.shareId,
      error: revoked.error,
      ...(revoked.detail ? { detail: revoked.detail } : {}),
    }).catch(() => {});
  }
}

async function terminateSession(
  businessId: string,
  sessionId: string,
  to: "ended" | "revoked" | "expired" | "failed",
  actor: string,
  reason: string,
  overrides: BrokerOverrides = {},
): Promise<EndSessionResult> {
  const current = await getAssistanceSession(businessId, sessionId);
  if (!current) return { ok: false, error: "session_not_found" };
  if (isTerminalAssistanceState(current.state)) return { ok: false, error: "terminal_state" };
  if (!isSupportAssistanceState(to)) return { ok: false, error: "terminal_state" };
  const session = await setSessionState(businessId, sessionId, to, {
    end_reason: reason.slice(0, 200),
    ended_at: new Date().toISOString(),
  });
  await appendEvent(businessId, sessionId, to, actor, { reason });
  await revokeEngineBinding(businessId, current, actor, overrides);
  return { ok: true, session };
}

/** The operator (or engine) ends a session normally. */
export async function endAssistanceSession(
  businessId: string,
  sessionId: string,
  actor: string,
  reason: string,
  overrides: BrokerOverrides = {},
): Promise<EndSessionResult> {
  return terminateSession(businessId, sessionId, "ended", actor, reason || "operator_ended", overrides);
}

/** Admin revoke or the customer's local Stop: immediate, from any live state. */
export async function revokeAssistanceSession(
  businessId: string,
  sessionId: string,
  actor: string,
  reason: string,
  overrides: BrokerOverrides = {},
): Promise<EndSessionResult> {
  return terminateSession(businessId, sessionId, "revoked", actor, reason || "revoked", overrides);
}

/**
 * Marks live sessions whose lease lapsed as `expired`. Routes call this
 * opportunistically so expiry never depends on a cron job existing.
 */
export async function expireStaleSessions(overrides: BrokerOverrides = {}): Promise<number> {
  const { rows } = await query<{ id: string; business_id: string }>(
    `UPDATE support_assistance_sessions
        SET state = 'expired', end_reason = 'lease_expired', ended_at = now(), updated_at = now()
      WHERE state IN ('connecting', 'active_view', 'active_control')
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= now()
      RETURNING id::text AS id, business_id::text AS business_id`,
  );
  for (const row of rows) {
    await appendEvent(row.business_id, row.id, "lease_expired", "system").catch(() => {});
    const session = await getAssistanceSession(row.business_id, row.id);
    if (session) await revokeEngineBinding(row.business_id, session, "system", overrides);
  }
  return rows.length;
}
