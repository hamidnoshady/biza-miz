import { query } from "./db";
import { PERMISSIONS } from "./permissions";

export function aiConsentSessionKey(session: { employeeSessionId?: string | null; imp?: unknown }): string | null {
  return !session.imp && session.employeeSessionId ? session.employeeSessionId : null;
}

/** Rechecked by the apply endpoint, not just by the browser's earlier GET. */
export async function hasAiSessionConsent(input: {
  businessId: string; actorUserId: string; sessionId: string | null;
  auditId: string; permissions: ReadonlySet<string>;
}): Promise<boolean> {
  if (!input.sessionId || !input.permissions.has(PERMISSIONS.workspaceManage) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.auditId)) return false;
  const { rows } = await query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_action_session_grants g
       JOIN ai_action_audit a ON a.business_id = g.business_id AND a.actor_user_id = g.actor_user_id
         AND a.action_type = g.action_type AND a.proposal_payload->>'taskId' = g.scope_ref
       WHERE g.business_id = $1 AND g.actor_user_id = $2 AND g.employee_session_id = $3
         AND a.id = $4 AND a.status = 'proposed' AND g.action_type = 'task.status'
         AND g.revoked_at IS NULL AND g.expires_at > now()
     ) AS allowed`,
    [input.businessId, input.actorUserId, input.sessionId, input.auditId],
  );
  return rows[0]?.allowed === true;
}
