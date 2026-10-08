# Phase 38b — LiteLLM costing and usage (historical phase, current state)

This phase added LiteLLM usage-cost capture and spend reconciliation while retaining the app's
Rial billing ledger. Early prompt/MCP experiments described below in older release notes are
not the current architecture: prompts, runtime modes and system agents are now app-owned
Superadmin control-plane features, and the assistant does not use LiteLLM's proxy-MCP tool
format. Current behavior is in [Phase 39](Phase-39-LiteLLM-Only-AI-Platform.md) and
[docs/ai-subsystem-architecture.md](../ai-subsystem-architecture.md).

## Current state

- **Provider and deployment policy:** LiteLLM is the only supported provider. LiteLLM owns
  upstream deployments, provider routing, retries, fallbacks, provider-side limits and optional
  proxy budgets. The app requests configured model aliases but does not maintain a local copy of
  those provider policies.
- **Cost capture:** the runtime reads LiteLLM's reported response cost when present. The
  application settles turns through its own Rial wallet/plan allowance flow; gateway spend is a
  reconciliation diagnostic, not the amount billed to the tenant by itself. Platform Billing
  owns prices, allowances, wallet operations and revenue.
- **Usage:** app-side settlement and usage reporting remain the billing source of truth. Any
  synchronized LiteLLM spend data is diagnostic and does not replace the application ledger.
- **Prompts:** `ai_prompt_versions` and the single app prompt resolver own platform/mode/agent/
  business-type/app prompt layers. The app sends its system message; it does not send
  `prompt_id` or `prompt_variables` to LiteLLM. There is no active prompt-binding mirror column.
- **Tools and MCP:** the app's assistant loop sends permission-filtered OpenAI function tools.
  It does not send `tools: [{type: "mcp"}]` declarations from a local or LiteLLM MCP roster.
  The POS MCP server at `/api/mcp` is an independent connector for external clients, not a
  LiteLLM upstream tool. No proxy MCP configuration is shipped in the bundled template.
- **Policy schema:** migration 0184 drops retired `fallback_models`, `allow_business_models`,
  `published_models`, `prompt_bindings`, `mcp_enabled`, `mcp_servers` and `model_override`
  columns. Do not add app-side mirrors for a policy LiteLLM already owns.
- **Tenant secrets:** LiteLLM master and business/branch virtual keys use ciphertext-only
  application reads and writes. Migration 0209 removes the legacy plaintext columns after the
  guarded backfill and production verification documented in Phase 39.

## Deployment

The bundled proxy's provider/model list, router/fallback configuration and upstream credentials
are in `docker/litellm/config.yaml` and its secret environment. The POS app's connection defaults
are `LITELLM_*`; once a `platform_ai_gateway` row exists, that persisted row is authoritative.
The Compose profile is optional because some deployments use a separately managed LiteLLM
instance or intentionally keep AI unavailable (for example an offline site). There is no
supported direct-provider mode behind that choice.
