import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query, withTenantTransaction } from "@/lib/db";
import { aiActionPermission } from "@/lib/ai-capabilities";
import { canGrantAiSessionConsent } from "@/lib/ai-session-consent-shared";

function sessionKey(session: { employeeSessionId?: string | null; imp?: unknown }): string | null {
  // No automatic session consent for old/non-revocable sessions or impersonation.
  return !session.imp && session.employeeSessionId ? session.employeeSessionId : null;
}

function canUseAction(actionType: unknown, permissions: ReadonlySet<string>): actionType is "task.status" {
  if (!canGrantAiSessionConsent(actionType)) return false;
  const required = aiActionPermission(actionType);
  return !!required && permissions.has(required);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the target from a *current* audited proposal, never from a caller
 * selected featureId, taskId, URL or stale credential. */
async function auditedTaskScope(
  businessId: string,
  actorUserId: string,
  auditId: string,
): Promise<{ actionType: string; scopeRef: string } | null> {
  if (!UUID.test(auditId)) return null;
  const { rows } = await query<{ action_type: string; proposal_payload: { taskId?: unknown } }>(
    `SELECT action_type, proposal_payload FROM ai_action_audit
      WHERE business_id = $1 AND actor_user_id = $2 AND id = $3
        AND status = 'proposed'`,
    [businessId, actorUserId, auditId],
  );
  const row = rows[0];
  if (!row || row.action_type !== "task.status") return null;
  const taskId = row.proposal_payload?.taskId;
  if (typeof taskId !== "string" || !UUID.test(taskId)) return null;
  return { actionType: row.action_type, scopeRef: taskId };
}

/** Read consent without widening rights: current domain permission is mandatory. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const actionType = request.nextUrl.searchParams.get("actionType");
  const auditId = request.nextUrl.searchParams.get("auditId") ?? "";
  const sessionId = sessionKey(guard.session);
  if (!sessionId || !canUseAction(actionType, guard.membership.permissions)) {
    return NextResponse.json({ allowed: false });
  }
  const target = await auditedTaskScope(guard.session.businessId, guard.session.sub, auditId);
  if (!target || target.actionType !== actionType) return NextResponse.json({ allowed: false });
  const { rows } = await query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_action_session_grants
       WHERE business_id = $1 AND actor_user_id = $2 AND employee_session_id = $3
         AND action_type = $4 AND scope_ref = $5
         AND revoked_at IS NULL AND expires_at > now()
     ) AS allowed`,
    [guard.session.businessId, guard.session.sub, sessionId, actionType, target.scopeRef],
  );
  return NextResponse.json({ allowed: rows[0]?.allowed === true });
});

/** Explicit in-chat consent to one narrowly allowlisted action type. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const sessionId = sessionKey(guard.session);
  if (!sessionId) return NextResponse.json({ error: "session_consent_unavailable" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { auditId?: unknown } | null;
  const auditId = typeof body?.auditId === "string" ? body.auditId.trim() : "";
  if (!UUID.test(auditId)) return NextResponse.json({ error: "invalid_audit_id" }, { status: 400 });
  const target = await auditedTaskScope(guard.session.businessId, guard.session.sub, auditId);
  if (!target || !canUseAction(target.actionType, guard.membership.permissions)) {
    return NextResponse.json({ error: "consent_not_permitted" }, { status: 403 });
  }
  // This grant is limited to this audited task, NOT all task.status mutations
  // in the business. /proposals/apply performs live domain permission checks.
  await withTenantTransaction(guard.session.businessId, async () => {
    await query(
    `INSERT INTO ai_action_session_grants
       (business_id, actor_user_id, employee_session_id, action_type, scope_ref, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '2 hours')
       ON CONFLICT (business_id, actor_user_id, employee_session_id, action_type, scope_ref)
       DO UPDATE SET expires_at = LEAST(EXCLUDED.expires_at, now() + interval '2 hours'),
                     granted_at = now(), revoked_at = NULL`,
    [guard.session.businessId, guard.session.sub, sessionId, target.actionType, target.scopeRef],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'ai.session_consent.granted', 'ai_action', $3, $4::jsonb)`,
      [guard.session.businessId, guard.session.sub, auditId, JSON.stringify({
        actionType: target.actionType, scopeRef: target.scopeRef, maxDurationHours: 2,
      })],
    );
  });
  const actionType = target.actionType;
  return NextResponse.json({ allowed: true, actionType });
});

/** Manual revocation of an action family's remaining session consent. */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const sessionId = sessionKey(guard.session);
  const body = (await request.json().catch(() => null)) as { actionType?: unknown } | null;
  if (!sessionId || !canGrantAiSessionConsent(body?.actionType)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  await withTenantTransaction(guard.session.businessId, async () => {
    await query(
    `UPDATE ai_action_session_grants SET revoked_at = now()
      WHERE business_id = $1 AND actor_user_id = $2 AND employee_session_id = $3 AND action_type = $4`,
    [guard.session.businessId, guard.session.sub, sessionId, body.actionType],
    );
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'ai.session_consent.revoked', 'ai_action', $3, $4::jsonb)`,
      [guard.session.businessId, guard.session.sub, body.actionType,
        JSON.stringify({ actionType: body.actionType, employeeSessionId: sessionId })],
    );
  });
  return NextResponse.json({ revoked: true });
});
