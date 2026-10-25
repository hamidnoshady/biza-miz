-- Superadmin-managed Thinking chat profile: distinct from cost-approved Deep Research.
-- The gateway owns deployments/fallbacks; only the mode-to-alias mapping lives here.
ALTER TABLE platform_ai_modes DROP CONSTRAINT IF EXISTS platform_ai_modes_mode_key_check;
ALTER TABLE platform_ai_modes ADD CONSTRAINT platform_ai_modes_mode_key_check
  CHECK (mode_key IN ('auto', 'instant', 'thinking', 'deep_research'));
INSERT INTO platform_ai_modes (mode_key, model_alias, is_active, prompt_scope_key)
VALUES ('thinking', '', true, 'mode:thinking')
ON CONFLICT (mode_key) DO NOTHING;
