/**
 * Session-long consent is deliberately available to a small, reviewed set
 * of non-financial, non-destructive action types only.
 *
 * All other proposals retain per-operation approval, regardless of role.
 * A grant never changes aiActionPermission or the domain endpoint's policies.
 */
export const AI_SESSION_CONSENT_ACTIONS = ["task.status"] as const;

export function canGrantAiSessionConsent(actionType: unknown): actionType is (typeof AI_SESSION_CONSENT_ACTIONS)[number] {
  return typeof actionType === "string" &&
    (AI_SESSION_CONSENT_ACTIONS as readonly string[]).includes(actionType);
}
