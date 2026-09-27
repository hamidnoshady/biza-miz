-- ============================================================================
-- 0184_ai_gateway_dead_column_cleanup.sql — issue #748 P2-7/P2-8: drop the
-- retired LiteLLM-policy-mirror columns.
--
-- `/platform/ai` used to keep local copies of things LiteLLM already owns:
-- fallback chains, a business/model allowlist, the published model catalogue,
-- MCP server declarations, and a per-business/branch model override. Every
-- one of these has been hardcoded dead in the application for several phases
-- (`fallbackModels: []`, `allowBusinessModels: false`, `mcpEnabled: false`,
-- `resolveChatModel` ignoring `business`/`branch` overrides entirely — see
-- migration 0168's header and src/lib/ai-gateway.ts). Nothing reads or writes
-- these columns any more as of this migration; `ai-gateway-service.ts` no
-- longer selects, inserts or updates them.
--
-- `prompt_bindings` (migration 0123) never had an application reader or
-- writer at all — it was added for a prompt-manager feature that was never
-- built on top of `/platform/ai`.
--
-- Safe for a fresh install (the columns are simply never created) and for an
-- upgraded one (DROP COLUMN IF EXISTS on an already-unused, non-FK'd column
-- is a fast metadata-only change; no data anywhere depends on these values,
-- and this migration file is immutable history — a deployment that has not
-- yet cut over its application code to stop referencing them must not run
-- this migration until it has).
-- ============================================================================

ALTER TABLE platform_ai_gateway
    DROP COLUMN IF EXISTS fallback_models,
    DROP COLUMN IF EXISTS allow_business_models,
    DROP COLUMN IF EXISTS published_models,
    DROP COLUMN IF EXISTS prompt_bindings,
    DROP COLUMN IF EXISTS mcp_enabled,
    DROP COLUMN IF EXISTS mcp_servers;

ALTER TABLE ai_business_gateway
    DROP COLUMN IF EXISTS model_override;
