-- Short-lived, member- and browser-session-bound consent for explicitly low-risk AI actions.
-- No action executes from this table; the existing audited proposal apply endpoint
-- continues to recheck permissions, target state and idempotency at execution.
CREATE TABLE IF NOT EXISTS ai_action_session_grants (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  employee_session_id text NOT NULL,
  action_type text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (business_id, actor_user_id, employee_session_id, action_type)
);
CREATE INDEX IF NOT EXISTS ai_action_session_grants_expiry
  ON ai_action_session_grants(expires_at)
  WHERE revoked_at IS NULL;
ALTER TABLE ai_action_session_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_session_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_action_session_grants FOR ALL
  USING (app_rls_bypass() OR business_id = app_current_business())
  WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
