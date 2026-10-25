import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
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

/** Read consent without widening rights: current domain permission is mandatory. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requirePermission(PERMISSIONS.aiUse);
  if (guard.error) return guard.error;
  const actionType = request.nextUrl.searchParams.get("actionType");
  const sessionId = sessionKey(guard.session);
  if (!sessionId || !canUseAction(actionType, guard.membership.permissions)) {
    return NextResponse.json({ allowed: false });
  }
  const { rows } = await query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_action_session_grants
       WHERE business_id = $1 AND actor_user_id = $2 AND employee_session_id = $3
         AND action_type = $4 AND revoked_at IS NULL AND expires_at > now()
     ) AS allowed`,
    [guard.session.businessId, guard.session.sub, sessionId, actionType],
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(auditId)) {
    return NextResponse.json({ error: "invalid_audit_id" }, { status: 400 });
  }
  const { rows } = await query<{ action_type: string }>(
    `SELECT action_type FROM ai_action_audit
      WHERE business_id = $1 AND actor_user_id = $2 AND id = $3 AND status = 'proposed'`,
    [guard.session.businessId, guard.session.sub, auditId],
  );
  const actionType = rows[0]?.action_type;
  if (!canUseAction(actionType, guard.membership.permissions)) {
    return NextResponse.json({ error: "consent_not_permitted" }, { status: 403 });
  }
  await query(
    `INSERT INTO ai_action_session_grants
       (business_id, actor_user_id, employee_session_id, action_type, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '2 hours')
       ON CONFLICT (business_id, actor_user_id, employee_session_id, action_type)
       DO UPDATE SET expires_at = LEAST(EXCLUDED.expires_at, now() + interval '2 hours'),
                     granted_at = now(), revoked_at = NULL`,
    [guard.session.businessId, guard.session.sub, sessionId, actionType],
  );
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
  await query(
    `UPDATE ai_action_session_grants SET revoked_at = now()
      WHERE business_id = $1 AND actor_user_id = $2 AND employee_session_id = $3 AND action_type = $4`,
    [guard.session.businessId, guard.session.sub, sessionId, body.actionType],
  );
  return NextResponse.json({ revoked: true });
});
