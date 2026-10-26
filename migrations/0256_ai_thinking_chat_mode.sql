-- Superadmin-managed Thinking chat profile: distinct from cost-approved Deep Research.
-- The gateway owns deployments/fallbacks; only the mode-to-alias mapping lives here.
ALTER TABLE platform_ai_modes DROP CONSTRAINT IF EXISTS platform_ai_modes_mode_key_check;
ALTER TABLE platform_ai_modes ADD CONSTRAINT platform_ai_modes_mode_key_check
  CHECK (mode_key IN ('auto', 'instant', 'thinking', 'deep_research'));
INSERT INTO platform_ai_modes (mode_key, model_alias, is_active, prompt_scope_key)
VALUES ('thinking', '', true, 'mode:thinking')
ON CONFLICT (mode_key) DO NOTHING;

-- Preserve model-mode billing attribution without weakening its closed allowlist.
ALTER TABLE ai_wallet_settlements
  DROP CONSTRAINT IF EXISTS ai_wallet_settlements_runtime_mode_check;
ALTER TABLE ai_wallet_settlements
  ADD CONSTRAINT ai_wallet_settlements_runtime_mode_check
  CHECK (runtime_mode IS NULL OR runtime_mode IN ('auto', 'instant', 'thinking', 'deep_research'));
