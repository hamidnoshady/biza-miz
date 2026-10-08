# Phase 37 — LiteLLM gateway (historical phase, current state)

Phase 37 introduced LiteLLM as the platform's shared OpenAI-compatible proxy. Its early design
allowed direct vendors alongside LiteLLM and proposed application-side policy mirrors. That
rollout design is historical: Phase 39 made LiteLLM the only supported provider, and issue #757
completed the console/schema hardening. Use [Phase 39](Phase-39-LiteLLM-Only-AI-Platform.md)
and [the current AI architecture guide](../ai-subsystem-architecture.md) for today's behavior.

## Current state

- `AiProvider` is LiteLLM-only. The app does not fall back to OpenRouter, Arvan, `AI_API_KEY`,
  or any direct provider if the proxy is unavailable; AI fails closed.
- The global gateway settings are in `platform_ai_gateway`. App deployment variables use the
  `LITELLM_*` namespace and are bootstrap defaults only while that singleton row is absent.
  Upstream provider credentials belong to the LiteLLM deployment, not to the POS app.
- Business and optional branch virtual keys live in `ai_business_gateway`. Branch keys override
  the business key; absent branch keys inherit the business key. When virtual keys are required,
  tenant requests never fall back to the shared master key.
- The Superadmin connection/fleet page is `/platform/ai`; `/api/platform/ai/gateway` is its API.
  The old page bookmark `/platform/ai/gateway` redirects to `/platform/ai`. Other control-plane
  areas are separate current pages under `/platform/ai/modes`, `/prompts`, `/agents`, `/research`
  and `/widgets`.
- LiteLLM owns upstream deployments, provider routing, retry/fallback policy, provider-side
  limits and proxy budgets. The app owns tenant permissions/tools, prompt versions, runtime
  orchestration and Rial settlement; Plan/Billing remains the product money source of truth.
- App-side fallback, model-list, per-business model, budget and MCP mirror fields are retired.
  Migration 0184 drops the obsolete policy columns. The assistant sends app-owned system prompts
  and permission-filtered OpenAI function tools; it does not send LiteLLM prompt IDs or proxy MCP
  declarations. The separate POS `/api/mcp` connector is not connected to proxy MCP.
- Gateway master and tenant virtual keys are encrypted at rest. Migration 0209 drops the legacy
  plaintext columns only after an operator runs and verifies `db:encrypt-ai-secrets` on every
  deployment and confirms a production ciphertext-backed read. See the secret-cutover runbook in
  Phase 39; production verification cannot be inferred from this repository.

## Deployment notes

The bundled `litellm` service is optional in Compose so offline installations can run without
AI; a deployment can instead point at a separately managed LiteLLM proxy. Leaving the profile
off does not activate a direct-provider alternative. The bundled service is private to the
Compose network and consumes its own upstream provider secrets. See `.env.example`,
`docker-compose.yml` and `docker/litellm/config.yaml` for the deployment contract.
