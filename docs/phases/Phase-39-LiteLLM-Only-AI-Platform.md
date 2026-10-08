# Phase 39 — LiteLLM-only AI platform

**Status:** implemented. Current behavior and the remaining operational cutover are summarized
here; the initial direct-provider/gateway design has been retired.

## Current connection and ownership

LiteLLM is the application's only supported provider. `AiProvider` has one value (`litellm`),
`platform_ai_config` was merged into the global `platform_ai_gateway` singleton by migration
0124, and there is no direct-vendor fallback. A missing/invalid gateway or database state fails
closed instead of selecting another provider. Platform and runtime settings are read from the
persisted gateway row; `LITELLM_*` connection values are bootstrap defaults only when that row
does not exist. `AI_API_KEY`, `AI_PROVIDER`, `AI_BASE_URL` and `AI_MODEL` do not configure a
provider connection.

| Area | Owner | Where it is configured |
| --- | --- | --- |
| Upstream provider deployments, model aliases, routing, retries, failover, provider-side limits and proxy budgets | LiteLLM | `docker/litellm/config.yaml` or the separately managed proxy |
| Global gateway URL, master key, default chat/embedding alias, virtual-key toggle | Platform | `/platform/ai` → `platform_ai_gateway` |
| Runtime mode → model-alias mapping | Platform | `/platform/ai/modes` → `platform_ai_modes`; each alias must exist in LiteLLM |
| Prompt versions and system-agent assignments | Platform | `/platform/ai/prompts` and `/platform/ai/agents` |
| Deep Research limits and platform widgets | Platform | `/platform/ai/research` and `/platform/ai/widgets` |
| Business/branch identity keys and gateway readiness | Platform | `/platform/ai` fleet/branch panel; `ai_business_gateway` |
| Tenant tools, permissions, context, orchestration and audit | Application | app runtime and permission-filtered function tools |
| Prices, Rial allowance, wallet settlement and revenue | Plan/Billing | billing control plane; LiteLLM spend is a diagnostic/technical backstop |

There is no per-business model picker, budget editor, routing control, fallback field or MCP
server roster in the application. LiteLLM owns its own policy. The app's prompts are versioned
in `ai_prompt_versions`; it sends its system message and permission-filtered OpenAI function
tools, not LiteLLM prompt IDs or proxy MCP declarations. The separate POS MCP connector at
`/api/mcp` serves external MCP clients and is not wired through LiteLLM's MCP feature.

## Business and branch credentials

`ai_business_gateway` stores one optional business-default row and optional branch rows. A
branch key is preferred for that exact location; otherwise the business key is inherited. When
virtual keys are required, a tenant call never falls back to the shared master key. Branch rows
are identity/diagnostic state only: local model overrides, budgets, fallback, and rate-limit
mirrors are retired. The model requested comes from the platform/runtime-mode alias.

The fleet GET route is `/api/platform/ai/gateway`; `/platform/ai/gateway` is only a legacy UI
bookmark and redirects to `/platform/ai`. The fleet query joins entitlement state and
pre-aggregates key/branch error state in SQL, then loads one singleton snapshot and one batch
of visible business keys. Search, status filters and pagination are server-side; focused branch
locations are separately paginated. The selected business's branch readiness is calculated for
the exact `(businessId, locationId)` pair and is shown separately from business-default
readiness. It includes:

- AI entitlement and gateway readiness;
- effective credential source (`branch`, inherited `business`, `master`, or `none`);
- business-key and selected-branch-key status, including whether the branch inherits;
- effective model alias and last key verification/sync timestamp; and
- distinct business and branch synchronization errors.

Supported fleet filters are `all`, `ready`, `missing_key`, `key_sync_error`,
`entitlement_disabled`, `branch_override` and `gateway_unavailable`. The row set is paginated;
no per-business `resolveAiConfigFor()` calls are made by the console.

## Retired policy mirrors and routes

`AiGatewayConfig` and `BusinessGateway` no longer carry LiteLLM policy mirrors. Migration
0184 uses `DROP COLUMN IF EXISTS` for `fallback_models`, `allow_business_models`,
`published_models`, `prompt_bindings`, `mcp_enabled`, `mcp_servers` and `model_override`; its
`DROP COLUMN IF EXISTS` statements work across the full migration sequence on clean installs and
upgraded schemas. The active prompt version console at `/platform/ai/prompts` is not the old
prompt-fragment manager and must remain reachable.

There are no active per-business model/budget APIs or old tenant prompt-manager routes. The
former tenant provider endpoint `/api/ai/config` is a `410 ai_configuration_platform_managed`
compatibility tombstone; `/api/platform/ai/prompts` is the separate, active platform-owned
version console. `/dashboard/ai/settings` and `/ai/settings` are compatibility redirects to
`/dashboard`; `/platform/ai/gateway` redirects to the current console page. The live business AI
workspace is inside `/dashboard`, not a provider-settings page.

## Secret cutover and required rollout

Migration 0183 added `master_key_ciphertext` and `virtual_key_ciphertext` while retaining
plaintext for the transition. The current gateway readers and writers use ciphertext only.
Migration 0209 drops `platform_ai_gateway.master_key` and `ai_business_gateway.virtual_key` in a
separate forward step. It refuses both unbackfilled plaintext and stored credentials without an
explicit post-verification confirmation. The database guard cannot prove that an AES-GCM value
decrypts with the current deployment key or that a running release successfully reads it.

**Do not apply migration 0209 until all prerequisites have been completed on every deployment
database and runtime:**

1. Run `npm run db:encrypt-ai-secrets -- --dry-run` and review the affected row counts.
2. Run `npm run db:encrypt-ai-secrets`; it is resumable, decrypt-verifies each ciphertext against
   the configured encryption key, then clears the legacy plaintext copies.
3. Run `npm run db:encrypt-ai-secrets -- --verify-only`; it must pass with no legacy plaintext.
4. Deploy the ciphertext-only application. While any credential is stored and
   `AI_GATEWAY_SECRET_CUTOVER_VERIFIED` is not `true`, the migration runner defers 0209 on its own
   (as it always does with `AI_GATEWAY_SECRET_CUTOVER_DEFER=true`) and still applies every later
   migration that does not name a legacy column, so the new runtime starts while the old columns
   still exist. Before starting the server the container entrypoint runs
   `encrypt-ai-gateway-secrets.ts --keep-plaintext`, which writes and decrypt-verifies any missing
   ciphertext with the container's own key and leaves plaintext alone; a failure there is logged,
   not fatal. (Before this, a deployment that skipped steps 1–3 restarted forever on 0209's
   `ai_gateway_secret_backfill_required`, and the defer flag could not help because migrations
   `0209_online_sale_facts` onward sort after the cutover.)
5. Verify a production runtime read/probe using ciphertext-backed credentials and the current
   `INTEGRATIONS_ENCRYPTION_KEY` (or `JWT_SECRET`) on every deployment/instance. Do not advance
   if any probe fails.
6. Drain older app instances that could still select the plaintext columns.
7. Only after those checks, remove the defer setting and run
   `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate` (or set that flag for the
   controlled entrypoint run). The runner scopes a confirmation setting to its DB session, and
   migration 0209 independently checks it before dropping either column. Remove the temporary
   flags after it is recorded in `schema_migrations`.

The local checkout cannot establish that production backfill, key consistency, or runtime
verification has happened. The migration fails closed without the backfill and explicit
confirmation; do not bypass either guard or treat them as substitutes for the production-read
checks above.

## Current related documentation

- `docs/ai-subsystem-architecture.md` — prompt, mode, agent, memory, tool and billing ownership.
- `docs/phases/Phase-37-LiteLLM-Gateway.md` and `Phase-38b-LiteLLM-Platform.md` — historical
  phase notes with a current-state summary at the top.
- `.env.example`, `docker-compose.yml` and `docker/litellm/config.yaml` — deployment defaults
  and proxy-side policy ownership.
