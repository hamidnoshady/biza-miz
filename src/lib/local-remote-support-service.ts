/**
 * Issue #974 §5 — Outbound-initiated Superadmin Remote Support Sessions for
 * Full Offline (`local`) desktop installations.
 *
 * Security invariants:
 *   1. Zero inbound ports: the local desktop initiates all HTTPS polls to Cloud
 *      using its scoped `LOC1-…` installation credential.
 *   2. Explicit Local Owner consent by default before any session becomes `active`.
 *   3. Cannot bypass `locked_invalid` except in narrow owner-approved `recovery_only`
 *      mode (which still blocks operational data reads/mutations).
 *   4. Strict command allowlist — never arbitrary SQL/shell/file access, and all
 *      outputs pass through `redactLocalSupportDiagnostics`.
 *   5. Dual-side audit trail (Cloud + Local) and automatic pause/expiry on disconnect.
 */
import { randomBytes } from "node:crypto";
import { query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";
import { platformAudit } from "./platform-auth";
import {
  isRemoteSupportCommandAllowed,
  redactLocalSupportDiagnostics,
  REMOTE_SUPPORT_COMMANDS,
  type LocalSupportSessionMode,
  type RemoteSupportCommandType,
} from "./local-activation-contract";
import {
  openLocalCredential,
  validateCloudOriginForLocalActivation,
} from "./local-activation-crypto";
import {
  LOCAL_INSTALLATION_ONLINE_WINDOW_MS,
  type AuthenticatedLocalInstallation,
} from "./local-activation-cloud-service";
import { runLocalActivationValidationForBusiness } from "./local-activation-site-service";

const CLOUD_ENDPOINT_PATH = "/api/local-activation/cloud";
const HEARTBEAT_DISCONNECT_THRESHOLD_MS = 35_000;

export interface CloudLocalSupportSessionView {
  id: string;
  businessId: string;
  localInstallationId: string;
  installationPublicId: string;
  installationDisplayName: string;
  installationOnlineNow: boolean;
  adminId: string;
  isMine: boolean;
  operatorName: string;
  ticketId: string | null;
  reason: string;
  mode: LocalSupportSessionMode;
  state:
    | "pending_owner_consent"
    | "active"
    | "paused_disconnected"
    | "denied"
    | "ended"
    | "revoked"
    | "expired";
  requestedDurationMinutes: number;
  consentExpiresAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  lastSiteHeartbeatAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
}

export interface CloudLocalSupportCommandView {
  id: string;
  sessionId: string;
  commandType: RemoteSupportCommandType;
  state: "queued" | "delivered" | "completed" | "rejected" | "expired";
  result: unknown;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

async function sweepCloudSupportSessionTimers(businessId: string): Promise<void> {
  await query(
    `UPDATE local_support_sessions
        SET state = 'expired', ended_at = COALESCE(ended_at, now()),
            end_reason = COALESCE(end_reason, 'consent_timeout'), updated_at = now()
      WHERE business_id = $1
        AND state = 'pending_owner_consent'
        AND consent_expires_at <= now()`,
    [businessId],
  );
  await query(
    `UPDATE local_support_sessions
        SET state = 'expired', ended_at = COALESCE(ended_at, now()),
            end_reason = COALESCE(end_reason, 'session_expired'), updated_at = now()
      WHERE business_id = $1
        AND state IN ('active', 'paused_disconnected')
        AND expires_at IS NOT NULL
        AND expires_at <= now()`,
    [businessId],
  );
  await query(
    `UPDATE local_support_sessions
        SET state = 'paused_disconnected', updated_at = now()
      WHERE business_id = $1
        AND state = 'active'
        AND (
          last_site_heartbeat_at IS NULL
          OR last_site_heartbeat_at < now() - ($2::bigint * interval '1 millisecond')
        )`,
    [businessId, HEARTBEAT_DISCONNECT_THRESHOLD_MS],
  );
}

export async function listLocalSupportSessionsForBusiness(
  businessId: string,
  currentAdminId: string,
): Promise<{
  sessions: CloudLocalSupportSessionView[];
  commands: CloudLocalSupportCommandView[];
}> {
  return withTenant(businessId, async () => {
    await sweepCloudSupportSessionTimers(businessId);

    const [sessRes, cmdRes] = await Promise.all([
      query<{
        id: string;
        business_id: string;
        local_installation_id: string;
        public_id: string;
        display_name: string;
        inst_status: string;
        last_seen_at: Date | null;
        admin_id: string;
        operator_name: string;
        ticket_id: string | null;
        reason: string;
        mode: LocalSupportSessionMode;
        state: CloudLocalSupportSessionView["state"];
        requested_duration_minutes: number;
        consent_expires_at: Date;
        approved_at: Date | null;
        expires_at: Date | null;
        last_site_heartbeat_at: Date | null;
        ended_at: Date | null;
        end_reason: string | null;
        created_at: Date;
      }>(
        `SELECT s.id, s.business_id, s.local_installation_id,
                i.public_id, i.display_name, i.status AS inst_status, i.last_seen_at,
                s.admin_id, s.operator_name, s.ticket_id, s.reason, s.mode, s.state,
                s.requested_duration_minutes, s.consent_expires_at, s.approved_at,
                s.expires_at, s.last_site_heartbeat_at, s.ended_at, s.end_reason, s.created_at
           FROM local_support_sessions s
           JOIN local_installations i
             ON i.id = s.local_installation_id AND i.business_id = s.business_id
          WHERE s.business_id = $1
          ORDER BY s.created_at DESC
          LIMIT 30`,
        [businessId],
      ),
      query<{
        id: string;
        session_id: string;
        command_type: RemoteSupportCommandType;
        state: CloudLocalSupportCommandView["state"];
        result: unknown;
        error_code: string | null;
        created_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT id, session_id, command_type, state, result, error_code, created_at, completed_at
           FROM local_support_commands
          WHERE business_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [businessId],
      ),
    ]);

    const now = Date.now();
    return {
      sessions: sessRes.rows.map((r) => ({
        id: r.id,
        businessId: r.business_id,
        localInstallationId: r.local_installation_id,
        installationPublicId: r.public_id,
        installationDisplayName: r.display_name,
        installationOnlineNow:
          r.inst_status === "active" &&
          r.last_seen_at !== null &&
          now - r.last_seen_at.getTime() <= LOCAL_INSTALLATION_ONLINE_WINDOW_MS,
        adminId: r.admin_id,
        isMine: r.admin_id === currentAdminId,
        operatorName: r.operator_name,
        ticketId: r.ticket_id,
        reason: r.reason,
        mode: r.mode,
        state: r.state,
        requestedDurationMinutes: r.requested_duration_minutes,
        consentExpiresAt: r.consent_expires_at.toISOString(),
        approvedAt: r.approved_at?.toISOString() ?? null,
        expiresAt: r.expires_at?.toISOString() ?? null,
        lastSiteHeartbeatAt: r.last_site_heartbeat_at?.toISOString() ?? null,
        endedAt: r.ended_at?.toISOString() ?? null,
        endReason: r.end_reason,
        createdAt: r.created_at.toISOString(),
      })),
      commands: cmdRes.rows.map((c) => ({
        id: c.id,
        sessionId: c.session_id,
        commandType: c.command_type,
        state: c.state,
        result: c.result,
        errorCode: c.error_code,
        createdAt: c.created_at.toISOString(),
        completedAt: c.completed_at?.toISOString() ?? null,
      })),
    };
  });
}

export async function requestLocalSupportSessionOnCloud(input: {
  businessId: string;
  localInstallationId: string;
  adminId: string;
  operatorName: string;
  mode: LocalSupportSessionMode;
  reason: string;
  ticketId?: string | null;
  minutes: number;
}): Promise<
  | { ok: true; sessionId: string }
  | {
      ok: false;
      httpStatus: number;
      error:
        | "invalid_reason"
        | "invalid_duration"
        | "installation_not_found"
        | "installation_offline"
        | "installation_revoked"
        | "support_access_disabled"
        | "active_session_exists";
    }
> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) {
    return { ok: false, httpStatus: 400, error: "invalid_reason" };
  }
  if (!Number.isInteger(input.minutes) || input.minutes < 5 || input.minutes > 60) {
    return { ok: false, httpStatus: 400, error: "invalid_duration" };
  }

  const outcome = await withTenantTransaction(input.businessId, async () => {
    await sweepCloudSupportSessionTimers(input.businessId);

    const [bizRes, instRes] = await Promise.all([
      query<{ support_access_policy: string }>(
        `SELECT support_access_policy FROM businesses WHERE id = $1`,
        [input.businessId],
      ),
      query<{ status: string; last_seen_at: Date | null }>(
        `SELECT status, last_seen_at
           FROM local_installations
          WHERE id = $1 AND business_id = $2
          FOR UPDATE`,
        [input.localInstallationId, input.businessId],
      ),
    ]);

    if (bizRes.rows[0]?.support_access_policy === "disabled") {
      return { ok: false as const, httpStatus: 403, error: "support_access_disabled" as const };
    }
    const inst = instRes.rows[0];
    if (!inst) {
      return { ok: false as const, httpStatus: 404, error: "installation_not_found" as const };
    }
    if (inst.status !== "active" && input.mode !== "recovery_only") {
      return { ok: false as const, httpStatus: 409, error: "installation_revoked" as const };
    }
    const online =
      inst.last_seen_at !== null &&
      Date.now() - inst.last_seen_at.getTime() <= LOCAL_INSTALLATION_ONLINE_WINDOW_MS;
    if (!online) {
      return { ok: false as const, httpStatus: 409, error: "installation_offline" as const };
    }

    const existingOpen = await query<{ id: string }>(
      `SELECT id FROM local_support_sessions
        WHERE business_id = $1
          AND local_installation_id = $2
          AND state IN ('pending_owner_consent', 'active', 'paused_disconnected')
        LIMIT 1`,
      [input.businessId, input.localInstallationId],
    );
    if (existingOpen.rows[0]) {
      return { ok: false as const, httpStatus: 409, error: "active_session_exists" as const };
    }

    const nonce = randomBytes(24).toString("base64url");
    const { rows } = await query<{ id: string }>(
      `INSERT INTO local_support_sessions (
         business_id, local_installation_id, admin_id, operator_name, ticket_id,
         reason, mode, state, requested_duration_minutes, consent_expires_at,
         last_site_heartbeat_at, session_nonce
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, 'pending_owner_consent', $8, now() + interval '5 minutes',
         now(), $9
       ) RETURNING id`,
      [
        input.businessId,
        input.localInstallationId,
        input.adminId,
        input.operatorName,
        input.ticketId || null,
        reason,
        input.mode,
        input.minutes,
        nonce,
      ],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, 'local_support_session.requested', 'local_support_session', $2, $3)`,
      [
        input.businessId,
        rows[0].id,
        JSON.stringify({
          adminId: input.adminId,
          operatorName: input.operatorName,
          mode: input.mode,
          minutes: input.minutes,
          ticketId: input.ticketId || null,
        }),
      ],
    );
    return { ok: true as const, sessionId: rows[0].id };
  });

  if (outcome.ok) {
    await platformAudit({
      adminId: input.adminId,
      businessId: input.businessId,
      action: "local_support_session.requested",
      entity: "local_support_session",
      entityId: outcome.sessionId,
      payload: {
        localInstallationId: input.localInstallationId,
        mode: input.mode,
        minutes: input.minutes,
        ticketId: input.ticketId || null,
      },
    });
  }
  return outcome;
}

export async function queueLocalSupportCommandOnCloud(input: {
  businessId: string;
  sessionId: string;
  adminId: string;
  commandType: string;
}): Promise<
  | { ok: true; commandId: string }
  | {
      ok: false;
      httpStatus: number;
      error:
        | "invalid_command"
        | "session_not_found"
        | "not_session_owner"
        | "session_disconnected"
        | "session_not_active"
        | "command_forbidden_in_mode";
    }
> {
  if (!(REMOTE_SUPPORT_COMMANDS as readonly string[]).includes(input.commandType)) {
    return { ok: false, httpStatus: 400, error: "invalid_command" };
  }
  const commandType = input.commandType as RemoteSupportCommandType;

  const res = await withTenantTransaction(input.businessId, async () => {
    await sweepCloudSupportSessionTimers(input.businessId);
    const { rows } = await query<{
      id: string;
      local_installation_id: string;
      admin_id: string;
      mode: LocalSupportSessionMode;
      state: string;
      expires_at: Date | null;
    }>(
      `SELECT id, local_installation_id, admin_id, mode, state, expires_at
         FROM local_support_sessions
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [input.sessionId, input.businessId],
    );
    const s = rows[0];
    if (!s) return { ok: false as const, httpStatus: 404, error: "session_not_found" as const };
    if (s.admin_id !== input.adminId) {
      return { ok: false as const, httpStatus: 403, error: "not_session_owner" as const };
    }
    if (s.state === "paused_disconnected") {
      return { ok: false as const, httpStatus: 409, error: "session_disconnected" as const };
    }
    if (s.state !== "active" || !s.expires_at || s.expires_at.getTime() <= Date.now()) {
      return { ok: false as const, httpStatus: 409, error: "session_not_active" as const };
    }
    if (
      !isRemoteSupportCommandAllowed(
        s.mode,
        commandType,
        s.mode === "recovery_only",
      )
    ) {
      return { ok: false as const, httpStatus: 403, error: "command_forbidden_in_mode" as const };
    }

    const inserted = await query<{ id: string }>(
      `INSERT INTO local_support_commands
         (business_id, session_id, local_installation_id, admin_id, command_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.businessId, s.id, s.local_installation_id, input.adminId, commandType],
    );
    return { ok: true as const, commandId: inserted.rows[0].id };
  });

  if (res.ok) {
    await platformAudit({
      adminId: input.adminId,
      businessId: input.businessId,
      action: "local_support_session.command_queued",
      entity: "local_support_command",
      entityId: res.commandId,
      payload: { sessionId: input.sessionId, commandType },
    });
  }
  return res;
}

export async function endOrRevokeLocalSupportSessionOnCloud(input: {
  businessId: string;
  sessionId: string;
  adminId: string;
  revoke: boolean;
}): Promise<{ ok: true } | { ok: false; httpStatus: number; error: string }> {
  const res = await withTenantTransaction(input.businessId, async () => {
    const { rows } = await query<{ admin_id: string; state: string }>(
      `SELECT admin_id, state FROM local_support_sessions
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.sessionId, input.businessId],
    );
    if (!rows[0]) return { ok: false as const, httpStatus: 404, error: "session_not_found" };
    if (!input.revoke && rows[0].admin_id !== input.adminId) {
      return { ok: false as const, httpStatus: 403, error: "not_session_owner" };
    }
    const nextState = input.revoke ? "revoked" : "ended";
    await query(
      `UPDATE local_support_sessions
          SET state = $3,
              ended_at = COALESCE(ended_at, now()),
              ended_by = $4,
              end_reason = $5,
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [
        input.sessionId,
        input.businessId,
        nextState,
        `platform_admin:${input.adminId}`,
        input.revoke ? "revoked_by_admin" : "ended_by_operator",
      ],
    );
    await query(
      `UPDATE local_support_commands
          SET state = 'expired', completed_at = now()
        WHERE session_id = $1 AND business_id = $2 AND state IN ('queued', 'delivered')`,
      [input.sessionId, input.businessId],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, $2, 'local_support_session', $3, $4)`,
      [
        input.businessId,
        input.revoke ? "local_support_session.revoked" : "local_support_session.ended",
        input.sessionId,
        JSON.stringify({ adminId: input.adminId }),
      ],
    );
    return { ok: true as const };
  });

  if (res.ok) {
    await platformAudit({
      adminId: input.adminId,
      businessId: input.businessId,
      action: input.revoke ? "local_support_session.revoked" : "local_support_session.ended",
      entity: "local_support_session",
      entityId: input.sessionId,
      payload: {},
    });
  }
  return res;
}

// ── Cloud Outbound Relay Endpoints Called by the Full Offline Site ───────────

export async function handleSiteSupportPollOnCloud(inst: AuthenticatedLocalInstallation) {
  return withTenantTransaction(inst.businessId, async () => {
    const now = new Date();
    await query(
      `UPDATE local_installations SET last_seen_at = $3, updated_at = $3
        WHERE id = $1 AND business_id = $2`,
      [inst.localInstallationId, inst.businessId, now],
    );

    // Expire past-deadline sessions BEFORE reviving any paused session!
    await sweepCloudSupportSessionTimers(inst.businessId);

    // Resume `paused_disconnected -> active` ONLY when the session has NOT expired or been revoked.
    await query(
      `UPDATE local_support_sessions
          SET state = CASE WHEN state = 'paused_disconnected' THEN 'active' ELSE state END,
              last_site_heartbeat_at = $3,
              updated_at = $3
        WHERE local_installation_id = $1 AND business_id = $2
          AND state IN ('pending_owner_consent', 'active', 'paused_disconnected')
          AND (expires_at IS NULL OR expires_at > $3)`,
      [inst.localInstallationId, inst.businessId, now],
    );

    const sessRes = await query<{
      id: string;
      operator_name: string;
      ticket_id: string | null;
      reason: string;
      mode: LocalSupportSessionMode;
      state: string;
      requested_duration_minutes: number;
      consent_expires_at: Date;
      approved_at: Date | null;
      expires_at: Date | null;
      ended_at: Date | null;
      end_reason: string | null;
      session_nonce: string;
      created_at: Date;
    }>(
      `SELECT id, operator_name, ticket_id, reason, mode, state,
              requested_duration_minutes, consent_expires_at, approved_at,
              expires_at, ended_at, end_reason, session_nonce, created_at
         FROM local_support_sessions
        WHERE local_installation_id = $1 AND business_id = $2
          AND (
            state IN ('pending_owner_consent', 'active')
            OR (ended_at IS NOT NULL AND ended_at > now() - interval '2 minutes')
          )
        ORDER BY created_at DESC
        LIMIT 3`,
      [inst.localInstallationId, inst.businessId],
    );

    const activeSession = sessRes.rows.find((s) => s.state === "active");
    let commands: Array<{ id: string; sessionId: string; commandType: RemoteSupportCommandType }> = [];
    if (activeSession) {
      const cmdRes = await query<{
        id: string;
        session_id: string;
        command_type: RemoteSupportCommandType;
      }>(
        `UPDATE local_support_commands
            SET state = 'delivered', delivered_at = COALESCE(delivered_at, now())
          WHERE session_id = $1 AND business_id = $2 AND state IN ('queued', 'delivered')
          RETURNING id, session_id, command_type`,
        [activeSession.id, inst.businessId],
      );
      commands = cmdRes.rows.map((c) => ({
        id: c.id,
        sessionId: c.session_id,
        commandType: c.command_type,
      }));
    }

    return {
      serverNow: now.toISOString(),
      sessions: sessRes.rows.map((s) => ({
        id: s.id,
        operatorName: s.operator_name,
        ticketId: s.ticket_id,
        reason: s.reason,
        mode: s.mode,
        state: s.state,
        requestedDurationMinutes: s.requested_duration_minutes,
        consentExpiresAt: s.consent_expires_at.toISOString(),
        approvedAt: s.approved_at?.toISOString() ?? null,
        expiresAt: s.expires_at?.toISOString() ?? null,
        endedAt: s.ended_at?.toISOString() ?? null,
        endReason: s.end_reason,
        sessionNonce: s.session_nonce,
        createdAt: s.created_at.toISOString(),
      })),
      commands,
    };
  });
}

export async function handleSiteSupportConsentOnCloud(
  inst: AuthenticatedLocalInstallation,
  input: {
    sessionId: string;
    sessionNonce: string;
    approved: boolean;
    approvedByLocalUserId: string;
    installationLocked?: boolean;
  },
) {
  return withTenantTransaction(inst.businessId, async () => {
    await sweepCloudSupportSessionTimers(inst.businessId);
    const { rows } = await query<{
      id: string;
      admin_id: string;
      mode: LocalSupportSessionMode;
      state: string;
      requested_duration_minutes: number;
      session_nonce: string;
    }>(
      `SELECT id, admin_id, mode, state, requested_duration_minutes, session_nonce
         FROM local_support_sessions
        WHERE id = $1 AND local_installation_id = $2 AND business_id = $3
        FOR UPDATE`,
      [input.sessionId, inst.localInstallationId, inst.businessId],
    );
    const s = rows[0];
    if (!s || s.session_nonce !== input.sessionNonce) {
      return { ok: false as const, error: "session_not_found" };
    }
    if (s.state !== "pending_owner_consent") {
      return { ok: false as const, error: "session_no_longer_pending" };
    }
    if (input.approved && input.installationLocked && s.mode !== "recovery_only") {
      return { ok: false as const, error: "locked_requires_recovery_mode" };
    }

    if (!input.approved) {
      await query(
        `UPDATE local_support_sessions
            SET state = 'denied', ended_at = now(), ended_by = 'local_owner',
                end_reason = 'owner_denied', updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [s.id, inst.businessId],
      );
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_support_session.denied', 'local_support_session', $2, $3)`,
        [inst.businessId, s.id, JSON.stringify({ localUserId: input.approvedByLocalUserId })],
      );
      return { ok: true as const, state: "denied" as const, expiresAt: null };
    }

    const updated = await query<{ approved_at: Date; expires_at: Date }>(
      `UPDATE local_support_sessions
          SET state = 'active',
              approved_at = now(),
              approved_by_local_user_id = $3::uuid,
              expires_at = now() + ($4::int || ' minutes')::interval,
              last_site_heartbeat_at = now(),
              updated_at = now()
        WHERE id = $1 AND business_id = $2
        RETURNING approved_at, expires_at`,
      [s.id, inst.businessId, input.approvedByLocalUserId, s.requested_duration_minutes],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, NULL, 'local_support_session.approved', 'local_support_session', $2, $3)`,
      [
        inst.businessId,
        s.id,
        JSON.stringify({
          localUserId: input.approvedByLocalUserId,
          expiresAt: updated.rows[0].expires_at.toISOString(),
        }),
      ],
    );
    return {
      ok: true as const,
      state: "active" as const,
      approvedAt: updated.rows[0].approved_at.toISOString(),
      expiresAt: updated.rows[0].expires_at.toISOString(),
    };
  });
}

export async function handleSiteSupportRevokeOnCloud(
  inst: AuthenticatedLocalInstallation,
  input: { sessionId: string },
) {
  return withTenantTransaction(inst.businessId, async () => {
    const { rowCount } = await query(
      `UPDATE local_support_sessions
          SET state = 'revoked', ended_at = COALESCE(ended_at, now()),
              ended_by = 'local_owner', end_reason = 'revoked_by_local_owner', updated_at = now()
        WHERE id = $1 AND local_installation_id = $2 AND business_id = $3`,
      [input.sessionId, inst.localInstallationId, inst.businessId],
    );
    if (rowCount) {
      await query(
        `UPDATE local_support_commands
            SET state = 'expired', completed_at = now()
          WHERE session_id = $1 AND business_id = $2 AND state IN ('queued', 'delivered')`,
        [input.sessionId, inst.businessId],
      );
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_support_session.revoked_by_local_owner', 'local_support_session', $2, '{}'::jsonb)`,
        [inst.businessId, input.sessionId],
      );
    }
    return { ok: true as const };
  });
}

export async function handleSiteSupportCommandResultOnCloud(
  inst: AuthenticatedLocalInstallation,
  input: {
    sessionId: string;
    commandId: string;
    ok: boolean;
    result?: unknown;
    errorCode?: string | null;
  },
) {
  const sanitizedResult = redactLocalSupportDiagnostics(input.result ?? null);
  return withTenantTransaction(inst.businessId, async () => {
    const { rows } = await query<{ admin_id: string; command_type: string }>(
      `UPDATE local_support_commands
          SET state = $4,
              result = $5::jsonb,
              error_code = $6,
              completed_at = now()
        WHERE id = $1 AND session_id = $2 AND local_installation_id = $3 AND business_id = $7
        RETURNING admin_id, command_type`,
      [
        input.commandId,
        input.sessionId,
        inst.localInstallationId,
        input.ok ? "completed" : "rejected",
        JSON.stringify(sanitizedResult),
        input.errorCode ?? null,
        inst.businessId,
      ],
    );
    if (rows[0]) {
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_support_session.command_completed', 'local_support_command', $2, $3)`,
        [
          inst.businessId,
          input.commandId,
          JSON.stringify({
            sessionId: input.sessionId,
            commandType: rows[0].command_type,
            ok: input.ok,
          }),
        ],
      );
    }
    return { ok: true as const };
  });
}

// ── Site-Side Consent, Active Banner, Scoped Command Execution & Outbound Poll

export interface LocalRemoteSupportUiSession {
  id: string;
  operatorName: string;
  ticketId: string | null;
  reason: string;
  mode: LocalSupportSessionMode;
  state: "pending_owner_consent" | "active" | "paused_disconnected";
  requestedDurationMinutes: number;
  consentExpiresAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

async function sweepLocalSupportTimers(businessId: string): Promise<void> {
  await query(
    `UPDATE local_remote_support_sessions
        SET state = 'expired', ended_at = COALESCE(ended_at, now()),
            end_reason = COALESCE(end_reason, 'consent_timeout'), updated_at = now()
      WHERE business_id = $1
        AND state = 'pending_owner_consent'
        AND consent_expires_at <= now()`,
    [businessId],
  );
  await query(
    `UPDATE local_remote_support_sessions
        SET state = 'expired', ended_at = COALESCE(ended_at, now()),
            end_reason = COALESCE(end_reason, 'session_expired'), updated_at = now()
      WHERE business_id = $1
        AND state IN ('active', 'paused_disconnected')
        AND expires_at IS NOT NULL
        AND expires_at <= now()`,
    [businessId],
  );
  await query(
    `UPDATE local_remote_support_sessions
        SET state = 'paused_disconnected', updated_at = now()
      WHERE business_id = $1
        AND state = 'active'
        AND last_cloud_contact_at IS NOT NULL
        AND last_cloud_contact_at < now() - ($2::bigint * interval '1 millisecond')`,
    [businessId, HEARTBEAT_DISCONNECT_THRESHOLD_MS],
  );
}

export async function getLocalRemoteSupportStateForUi(businessId: string): Promise<{
  pendingConsent: LocalRemoteSupportUiSession | null;
  activeSession: LocalRemoteSupportUiSession | null;
  serverNow: string;
}> {
  if (deploymentRole() !== "site") {
    return { pendingConsent: null, activeSession: null, serverNow: new Date().toISOString() };
  }
  await sweepLocalSupportTimers(businessId);
  const { rows } = await query<{
    id: string;
    operator_name: string;
    ticket_id: string | null;
    reason: string;
    mode: LocalSupportSessionMode;
    state: "pending_owner_consent" | "active" | "paused_disconnected";
    requested_duration_minutes: number;
    consent_expires_at: Date;
    approved_at: Date | null;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, operator_name, ticket_id, reason, mode, state,
            requested_duration_minutes, consent_expires_at, approved_at, expires_at, created_at
       FROM local_remote_support_sessions
      WHERE business_id = $1
        AND state IN ('pending_owner_consent', 'active', 'paused_disconnected')
      ORDER BY created_at DESC
      LIMIT 5`,
    [businessId],
  );

  const mapSession = (r: (typeof rows)[number]): LocalRemoteSupportUiSession => ({
    id: r.id,
    operatorName: r.operator_name,
    ticketId: r.ticket_id,
    reason: r.reason,
    mode: r.mode,
    state: r.state,
    requestedDurationMinutes: r.requested_duration_minutes,
    consentExpiresAt: r.consent_expires_at.toISOString(),
    approvedAt: r.approved_at?.toISOString() ?? null,
    expiresAt: r.expires_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  });

  const pending = rows.find((r) => r.state === "pending_owner_consent");
  const active = rows.find((r) => r.state === "active" || r.state === "paused_disconnected");
  return {
    pendingConsent: pending ? mapSession(pending) : null,
    activeSession: active ? mapSession(active) : null,
    serverNow: new Date().toISOString(),
  };
}

export async function respondToLocalRemoteSupportConsent(input: {
  businessId: string;
  sessionId: string;
  approve: boolean;
  ownerUserId: string;
}): Promise<{ ok: true } | { ok: false; httpStatus: number; error: string }> {
  const actRes = await query<{
    installation_id: string;
    cloud_origin: string;
    credential_ciphertext: string | null;
    state: string;
  }>(
    `SELECT installation_id, cloud_origin, credential_ciphertext, state
       FROM local_cloud_activations WHERE business_id = $1`,
    [input.businessId],
  );
  const act = actRes.rows[0];
  if (!act || !act.credential_ciphertext) {
    return { ok: false, httpStatus: 503, error: "cloud_enrollment_required" };
  }
  const bearer = openLocalCredential(act.credential_ciphertext);
  if (!bearer) return { ok: false, httpStatus: 503, error: "cloud_validation_failed" };

  const urlCheck = await validateCloudOriginForLocalActivation(act.cloud_origin);
  if (!urlCheck.ok) return { ok: false, httpStatus: 503, error: "cloud_support_offline" };

  const localSess = await query<{
    id: string;
    mode: LocalSupportSessionMode;
    state: string;
    requested_duration_minutes: number;
    session_nonce: string;
  }>(
    `SELECT id, mode, state, requested_duration_minutes, session_nonce
       FROM local_remote_support_sessions
      WHERE id = $1 AND business_id = $2`,
    [input.sessionId, input.businessId],
  );
  const s = localSess.rows[0];
  if (!s || s.state !== "pending_owner_consent") {
    return { ok: false, httpStatus: 409, error: "session_no_longer_pending" };
  }
  const installationLocked = act.state === "locked_invalid";
  if (input.approve && installationLocked && s.mode !== "recovery_only") {
    return { ok: false, httpStatus: 403, error: "locked_requires_recovery_mode" };
  }

  let cloudRes: Response;
  try {
    cloudRes = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        action: "support_consent",
        installationId: act.installation_id,
        sessionId: s.id,
        sessionNonce: s.session_nonce,
        approved: input.approve,
        approvedByLocalUserId: input.ownerUserId,
        installationLocked,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, httpStatus: 503, error: "cloud_support_offline" };
  }

  const payload = (await cloudRes.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    approvedAt?: string;
    expiresAt?: string;
  };
  if (!cloudRes.ok || !payload.ok) {
    return {
      ok: false,
      httpStatus: cloudRes.status || 502,
      error: payload.error ?? "cloud_support_offline",
    };
  }

  await withTenantTransaction(input.businessId, async () => {
    if (input.approve) {
      await query(
        `UPDATE local_remote_support_sessions
            SET state = 'active',
                approved_at = COALESCE($3::timestamptz, now()),
                approved_by_user_id = $4::uuid,
                expires_at = COALESCE($5::timestamptz, now() + ($6::int || ' minutes')::interval),
                last_cloud_contact_at = now(),
                updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [
          s.id,
          input.businessId,
          payload.approvedAt ?? null,
          input.ownerUserId,
          payload.expiresAt ?? null,
          s.requested_duration_minutes,
        ],
      );
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'local_support_session.approved', 'local_remote_support_session', $3, $4)`,
        [
          input.businessId,
          input.ownerUserId,
          s.id,
          JSON.stringify({ mode: s.mode, expiresAt: payload.expiresAt }),
        ],
      );
    } else {
      await query(
        `UPDATE local_remote_support_sessions
            SET state = 'denied', ended_at = now(), end_reason = 'owner_denied', updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [s.id, input.businessId],
      );
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'local_support_session.denied', 'local_remote_support_session', $3, '{}'::jsonb)`,
        [input.businessId, input.ownerUserId, s.id],
      );
    }
  });

  return { ok: true };
}

export async function revokeLocalRemoteSupportSessionLocally(input: {
  businessId: string;
  sessionId: string;
  actorUserId: string;
}): Promise<{ ok: true }> {
  // Always terminate locally FIRST so revocation takes effect instantaneously even if offline!
  await withTenantTransaction(input.businessId, async () => {
    await query(
      `UPDATE local_remote_support_sessions
          SET state = 'revoked', ended_at = COALESCE(ended_at, now()),
              end_reason = 'revoked_by_local_owner', updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [input.sessionId, input.businessId],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'local_support_session.revoked_locally', 'local_remote_support_session', $3, '{}'::jsonb)`,
      [input.businessId, input.actorUserId, input.sessionId],
    );
  });

  // Best-effort outbound notification to Cloud.
  const actRes = await query<{
    installation_id: string;
    cloud_origin: string;
    credential_ciphertext: string | null;
  }>(
    `SELECT installation_id, cloud_origin, credential_ciphertext
       FROM local_cloud_activations WHERE business_id = $1`,
    [input.businessId],
  );
  const act = actRes.rows[0];
  const bearer = openLocalCredential(act?.credential_ciphertext);
  if (act && bearer) {
    const urlCheck = await validateCloudOriginForLocalActivation(act.cloud_origin);
    if (urlCheck.ok) {
      await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          action: "support_revoke",
          installationId: act.installation_id,
          sessionId: input.sessionId,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      }).catch(() => {});
    }
  }

  return { ok: true };
}

async function executeAllowlistedSupportCommandLocally(
  businessId: string,
  commandType: RemoteSupportCommandType,
): Promise<unknown> {
  switch (commandType) {
    case "inspect_system_diagnostics": {
      const [actRes, migRes, locCount, userCount, unsentCount] = await Promise.all([
        query<{
          state: string;
          lock_reason: string | null;
          last_verified_at: Date | null;
          business_revision: string | null;
          cloud_installation_public_id: string;
        }>(
          `SELECT state, lock_reason, last_verified_at, business_revision, cloud_installation_public_id
             FROM local_cloud_activations WHERE business_id = $1`,
          [businessId],
        ),
        query<{ version: string }>(
          `SELECT filename AS version FROM schema_migrations ORDER BY filename DESC LIMIT 1`,
        ),
        query<{ c: string }>(`SELECT count(*)::text AS c FROM locations WHERE business_id = $1`, [
          businessId,
        ]),
        query<{ c: string }>(`SELECT count(*)::text AS c FROM users WHERE business_id = $1`, [
          businessId,
        ]),
        query<{ c: string }>(
          `SELECT count(*)::text AS c FROM cloud_exception_outbox WHERE business_id = $1`,
          [businessId],
        ),
      ]);
      return {
        appVersion: process.env.DESKTOP_APP_VERSION ?? "dev",
        latestMigration: migRes.rows[0]?.version ?? null,
        deploymentProfile: "local",
        activation: actRes.rows[0] ?? null,
        locationsCount: Number(locCount.rows[0]?.c ?? 0),
        usersCount: Number(userCount.rows[0]?.c ?? 0),
        unsentSupportDrafts: Number(unsentCount.rows[0]?.c ?? 0),
        checkedAt: new Date().toISOString(),
      };
    }
    case "inspect_audit_log": {
      const { rows } = await query<{
        action: string;
        entity: string | null;
        created_at: Date;
        payload: unknown;
      }>(
        `SELECT action, entity, created_at, payload
           FROM audit_log
          WHERE business_id = $1
          ORDER BY created_at DESC
          LIMIT 30`,
        [businessId],
      );
      return {
        entries: rows.map((r) => ({
          action: r.action,
          entity: r.entity,
          createdAt: r.created_at.toISOString(),
          payload: redactLocalSupportDiagnostics(r.payload),
        })),
      };
    }
    case "inspect_printer_and_hardware_status": {
      const [printers, jobs] = await Promise.all([
        query<{ id: string; name: string; kind: string; is_active: boolean }>(
          `SELECT p.id, p.name, p.kind::text AS kind, p.is_active
             FROM printers p
             JOIN locations l ON l.id = p.location_id
            WHERE l.business_id = $1`,
          [businessId],
        ),
        query<{ status: string; c: string }>(
          `SELECT pj.status, count(*)::text AS c
             FROM print_jobs pj
             JOIN locations l ON l.id = pj.location_id
            WHERE l.business_id = $1 AND pj.created_at > now() - interval '24 hours'
            GROUP BY pj.status`,
          [businessId],
        ),
      ]);
      return {
        printers: printers.rows,
        recentPrintJobsByStatus: jobs.rows.map((r) => ({
          status: r.status,
          count: Number(r.c),
        })),
      };
    }
    case "inspect_operational_summary": {
      const [shifts, orders] = await Promise.all([
        query<{ c: string }>(
          `SELECT count(*)::text AS c
             FROM employee_shifts
            WHERE business_id = $1 AND ended_at IS NULL`,
          [businessId],
        ),
        query<{ c: string }>(
          `SELECT count(*)::text AS c
             FROM orders o
             JOIN locations l ON l.id = o.location_id
            WHERE l.business_id = $1 AND o.status IN ('open', 'held')`,
          [businessId],
        ),
      ]);
      return {
        openShiftsCount: Number(shifts.rows[0]?.c ?? 0),
        openOrdersCount: Number(orders.rows[0]?.c ?? 0),
        checkedAt: new Date().toISOString(),
      };
    }
    case "trigger_cloud_revalidation": {
      return runLocalActivationValidationForBusiness(businessId, { force: true });
    }
    case "clear_stuck_print_jobs": {
      const { rowCount } = await query(
        `UPDATE print_jobs pj
            SET status = 'failed', error_code = 'cleared_by_remote_support'
           FROM locations l
          WHERE l.id = pj.location_id
            AND l.business_id = $1
            AND pj.status IN ('created', 'preparing', 'routing', 'sending')
            AND pj.created_at < now() - interval '30 minutes'`,
        [businessId],
      );
      return { clearedJobsCount: rowCount ?? 0 };
    }
    case "run_local_backup_check": {
      const { rows } = await query<{
        status: string;
        started_at: Date;
        finished_at: Date | null;
      }>(
        `SELECT status, started_at, finished_at
           FROM backup_runs
          WHERE business_id = $1
          ORDER BY started_at DESC
          LIMIT 5`,
        [businessId],
      );
      return {
        recentBackups: rows.map((r) => ({
          status: r.status,
          startedAt: r.started_at.toISOString(),
          completedAt: r.finished_at?.toISOString() ?? null,
        })),
      };
    }
  }
}

export async function pollAndProcessLocalSupportSessionForBusiness(
  businessId: string,
): Promise<{ hasActiveOrPending: boolean }> {
  return withTenant(businessId, async () => {
    const actRes = await query<{
    installation_id: string;
    cloud_origin: string;
    credential_ciphertext: string | null;
    state: string;
  }>(
    `SELECT installation_id, cloud_origin, credential_ciphertext, state
       FROM local_cloud_activations WHERE business_id = $1`,
    [businessId],
  );
  const act = actRes.rows[0];
  if (!act || act.state === "not_enrolled" || !act.credential_ciphertext) {
    return { hasActiveOrPending: false };
  }

  await sweepLocalSupportTimers(businessId);
  const bearer = openLocalCredential(act.credential_ciphertext);
  if (!bearer) return { hasActiveOrPending: false };
  const urlCheck = await validateCloudOriginForLocalActivation(act.cloud_origin);
  if (!urlCheck.ok) return { hasActiveOrPending: false };

  let res: Response;
  try {
    res = await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        action: "support_poll",
        installationId: act.installation_id,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    await sweepLocalSupportTimers(businessId);
    return { hasActiveOrPending: false };
  }

  if (!res.ok) return { hasActiveOrPending: false };

  const payload = (await res.json().catch(() => ({}))) as {
    sessions?: Array<{
      id: string;
      operatorName: string;
      ticketId: string | null;
      reason: string;
      mode: LocalSupportSessionMode;
      state: string;
      requestedDurationMinutes: number;
      consentExpiresAt: string;
      approvedAt: string | null;
      expiresAt: string | null;
      endedAt: string | null;
      endReason: string | null;
      sessionNonce: string;
      createdAt: string;
    }>;
    commands?: Array<{
      id: string;
      sessionId: string;
      commandType: RemoteSupportCommandType;
    }>;
  };

  const installationLocked = act.state === "locked_invalid";
  let hasActiveOrPending = false;

  for (const s of payload.sessions ?? []) {
    // Reject non-recovery sessions while `locked_invalid`!
    if (installationLocked && s.mode !== "recovery_only" && s.state === "pending_owner_consent") {
      continue;
    }

    const existing = await query<{ state: string }>(
      `SELECT state FROM local_remote_support_sessions WHERE id = $1 AND business_id = $2`,
      [s.id, businessId],
    );
    const localState = existing.rows[0]?.state ?? null;

    // Never allow Cloud to revive a session the Local Owner already revoked or denied!
    if (localState === "revoked" || localState === "denied" || localState === "expired") {
      continue;
    }

    if (s.state === "pending_owner_consent" || s.state === "active") {
      hasActiveOrPending = true;
    }

    // Only transition into `active` locally if the local row ALREADY recorded local Owner approval!
    const effectiveState =
      s.state === "active" && localState !== "active" && localState !== "paused_disconnected"
        ? "pending_owner_consent"
        : s.state;

    await query(
      `INSERT INTO local_remote_support_sessions (
         id, business_id, operator_name, ticket_id, reason, mode, state,
         requested_duration_minutes, consent_expires_at, approved_at, expires_at,
         last_cloud_contact_at, ended_at, end_reason, session_nonce, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9::timestamptz, $10::timestamptz, $11::timestamptz,
         now(), $12::timestamptz, $13, $14, $15::timestamptz, now()
       )
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         expires_at = COALESCE(EXCLUDED.expires_at, local_remote_support_sessions.expires_at),
         last_cloud_contact_at = now(),
         ended_at = COALESCE(EXCLUDED.ended_at, local_remote_support_sessions.ended_at),
         end_reason = COALESCE(EXCLUDED.end_reason, local_remote_support_sessions.end_reason),
         updated_at = now()`,
      [
        s.id,
        businessId,
        s.operatorName,
        s.ticketId,
        s.reason,
        s.mode,
        effectiveState,
        s.requestedDurationMinutes,
        s.consentExpiresAt,
        s.approvedAt,
        s.expiresAt,
        s.endedAt,
        s.endReason,
        s.sessionNonce,
        s.createdAt,
      ],
    );

    if (!localState && effectiveState === "pending_owner_consent") {
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_support_session.requested', 'local_remote_support_session', $2, $3)`,
        [
          businessId,
          s.id,
          JSON.stringify({ operatorName: s.operatorName, mode: s.mode, reason: s.reason }),
        ],
      );
    }
  }

  // Process any delivered commands ONLY against locally-approved, non-expired `active` sessions!
  for (const cmd of payload.commands ?? []) {
    const sessCheck = await query<{
      id: string;
      mode: LocalSupportSessionMode;
      state: string;
      expires_at: Date | null;
      executed_command_ids: string[];
    }>(
      `SELECT id, mode, state, expires_at, executed_command_ids
         FROM local_remote_support_sessions
        WHERE id = $1 AND business_id = $2`,
      [cmd.sessionId, businessId],
    );
    const localSess = sessCheck.rows[0];
    if (
      !localSess ||
      localSess.state !== "active" ||
      !localSess.expires_at ||
      localSess.expires_at.getTime() <= Date.now()
    ) {
      continue;
    }

    const executedIds = Array.isArray(localSess.executed_command_ids)
      ? localSess.executed_command_ids
      : [];
    if (executedIds.includes(cmd.id)) continue; // Anti-replay!

    const allowed = isRemoteSupportCommandAllowed(
      localSess.mode,
      cmd.commandType,
      installationLocked,
    );

    let ok = false;
    let result: unknown = null;
    let errorCode: string | null = null;

    if (!allowed) {
      errorCode = "command_forbidden_in_mode";
    } else {
      try {
        result = redactLocalSupportDiagnostics(
          await executeAllowlistedSupportCommandLocally(businessId, cmd.commandType),
        );
        ok = true;
      } catch {
        errorCode = "command_execution_failed";
      }
    }

    const nextIds = [...executedIds.slice(-99), cmd.id];
    await withTenantTransaction(businessId, async () => {
      await query(
        `UPDATE local_remote_support_sessions
            SET executed_command_ids = $3::jsonb, updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [localSess.id, businessId, JSON.stringify(nextIds)],
      );
      await query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, NULL, 'local_support_session.command_executed', 'local_remote_support_session', $2, $3)`,
        [
          businessId,
          localSess.id,
          JSON.stringify({ commandId: cmd.id, commandType: cmd.commandType, ok, errorCode }),
        ],
      );
    });

    await fetch(`${urlCheck.origin}${CLOUD_ENDPOINT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        action: "support_command_result",
        installationId: act.installation_id,
        sessionId: localSess.id,
        commandId: cmd.id,
        ok,
        result,
        errorCode,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    }).catch(() => {});
  }

    return { hasActiveOrPending };
  });
}

export async function runLocalSupportRelayTick(): Promise<{ hasActiveOrPending: boolean }> {
  if (deploymentRole() !== "site") return { hasActiveOrPending: false };
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string }>(
      `SELECT business_id FROM local_cloud_activations
        WHERE state <> 'not_enrolled'
        ORDER BY updated_at DESC
        LIMIT 10`,
    ),
  );
  let anyActive = false;
  for (const row of rows) {
    try {
      const deployment = await withTenant(row.business_id, () =>
        readDeploymentProfile(row.business_id),
      );
      if (deployment.profile !== "local") continue;
      const res = await withTenant(row.business_id, () =>
        pollAndProcessLocalSupportSessionForBusiness(row.business_id),
      );
      if (res.hasActiveOrPending) anyActive = true;
    } catch {
      // Isolate per-tenant outbound poll errors cleanly.
    }
  }
  return { hasActiveOrPending: anyActive };
}
