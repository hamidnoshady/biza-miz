# Phase 39 — LiteLLM-Only AI Platform (Global / Business / Branch)

**Depends on:** Phase 37 (the LiteLLM gateway as a provider), Phase 38b (gateway costing,
usage, prompt bindings and MCP), Phase 14 (multiple locations per business — the branch
dimension this phase adds to the gateway), Phase 18 (the Rial credit ledger, which this
phase does not touch).

## Status: shipped

This phase has been implemented: `AiProvider` has exactly one member (`"litellm"`),
`platform_ai_config` was dropped and merged into `platform_ai_gateway` (migration
`0124_ai_litellm_only.sql`), `ai_business_gateway` carries the branch dimension described
below, and `/platform/ai` is the single technical console (there is no separate
`/platform/ai/gateway` page — that path is only the API route backing this page). The rest of
this document is kept as the design record; see issue #757 / PR #756 for the follow-up
hardening pass (N+1 removal, scope-aware branch readiness, dead policy-mirror field cleanup)
that landed after the initial phase.

## Context: what exists today

Phases 37 and 38b put LiteLLM in front of the assistant as an *optional* third value of
`provider` (`openrouter` | `arvan` | `litellm`), on top of two configuration layers: a global
singleton (`platform_ai_config` + `platform_ai_gateway`) and one optional row per business
(`ai_business_gateway`, migration `0121`). That design was deliberately conservative for
introducing a new, unproven component next to a working system: a direct-vendor connection
still runs with zero gateway code, and `ai-runtime.ts`'s `decorate()` silently degrades back
to the direct connection on any gateway failure.

The gateway has now run long enough that the platform wants to commit to it fully, for two
reasons:

1. **Running two connection shapes forever is the cost, not the gateway itself.** Every AI
   surface still has to tolerate "no gateway, direct vendor" as a live configuration, which
   is exactly the shape Phase 37 introduced to be safe to roll out — not a shape worth
   keeping once the rollout is done.
2. **The gateway config has no branch dimension**, even though the rest of the product has
   treated "business default, branch override" as a first-class idea since Phase 14: the
   `settings` table has carried a nullable `location_id` since `migrations/0001_foundation.sql`
   (*"location_id NULL = business-wide setting"*), `locations.business_day_start_minutes`
   lets one branch override its trading-day boundary, and `ai_coworker_jobs` already carries
   a nullable `location_id`. `ai_business_gateway` is the one AI-adjacent table that stopped
   at the business boundary.

## Scope

### 1. Collapse the provider catalogue to one member

`src/lib/ai.ts`'s `AiProvider` union and `PROVIDERS` map drop `openrouter` and `arvan`
entirely; `litellm` is the only connection shape. `isGateway?: boolean` on `ProviderMeta`
is removed — every connection is a gateway now, so nothing downstream needs to branch on it.

### 2. Merge `platform_ai_config` into `platform_ai_gateway`

With one provider left, Phase 37 Decision 7's "two addresses, one wins" logic
(`resolveGatewayBaseUrl`) no longer means anything — there is exactly one address. Migration
`0124_ai_litellm_only.sql`:

- Adds `temperature` and `max_output_tokens` to `platform_ai_gateway`, backfilled from the
  existing `platform_ai_config` row.
- Drops `platform_ai_config`. If its `provider` was not already `'litellm'`, the new
  `platform_ai_gateway` row is left `enabled = false` rather than having a direct vendor's
  key/host silently copied into the gateway's master-key/address fields — a credential valid
  for one endpoint is not valid for another, and guessing would be worse than asking an
  operator to re-enter it once.
- `getPlatformAiConfig()` (`src/lib/ai-config.ts`) reads `platform_ai_gateway` directly.
  `isPlatformAiConfigured()` keeps its exact contract, so every existing caller that already
  gates on it needs no change.

### 3. Add the branch layer to `ai_business_gateway`

```sql
ALTER TABLE ai_business_gateway
    DROP CONSTRAINT ai_business_gateway_pkey,
    ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
    ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE CASCADE;
ALTER TABLE ai_business_gateway ADD PRIMARY KEY (id);
ALTER TABLE ai_business_gateway
    ADD CONSTRAINT ai_business_gateway_identity
        UNIQUE NULLS NOT DISTINCT (business_id, location_id);
```

`location_id IS NULL` means "the business default row" — the same convention `settings`
already uses. RLS stays keyed on `business_id` alone (unchanged from `0121`): a location
always belongs to exactly one business, so business-scoped RLS still fully isolates tenants;
*which* branches a given signed-in member may edit is an app-layer permission check
(`resolveActiveLocation`/`canAccessLocation`, `src/lib/setup-state.ts`), the same split every
other location-scoped screen already uses — RLS is not the place branch-level UI permissions
belong.

`ai_gateway_usage` (migration `0123`) gains a nullable `location_id`, resolved from the
branch's key alias at sync time exactly as `business_id` is resolved there today.

Resolution order, applied field-by-field (a branch may override just the model while
inheriting the business's budget): **branch row → business row (`location_id IS NULL`) →
platform defaults.**

### 4. `ai-gateway-service.ts` / `ai-gateway.ts` / `ai-runtime.ts`

- `getBusinessGateway`/`saveBusinessGateway`/`provisionVirtualKey`/`revokeVirtualKey`/
  `refreshKeySpend` all gain an optional `locationId` parameter and operate on the
  `(business_id, location_id)` row; add `getBranchGateway(businessId, locationId)` and
  `listBranchGateways(businessId)` beside the existing business-level reads.
- `resolveAiConfigFor(businessId, mode)` becomes
  `resolveAiConfigFor(businessId, locationId, mode)`. `decorate()` loses its "fall back to
  the direct connection" branch, because there is no other connection to fall back to.
  **"Degrade, never fail" is redefined**: it no longer means "switch providers," it means
  "fail closed into the `enabled: false` state every surface already checks via
  `isPlatformAiConfigured()`/`config.enabled`" — a gateway or database error while resolving
  config must never throw out of a request or a background tick, but it also must not pretend
  a working alternate connection exists.

### 5. Thread the branch id through every AI surface

The chat route, receipt OCR, invoice OCR, proactive digests, autopilot and the coworker all
currently call `resolveAiConfigFor(businessId, mode)`. Each needs its call site's location:

- Request-scoped surfaces (chat, OCR) already call `resolveActiveLocation(session)` for other
  reads in the same handler — reuse that value.
- Background surfaces iterate businesses under `withTenant(businessId, …)` per the existing
  "background work scopes itself" rule. `ai_coworker_jobs.location_id` (already nullable,
  `migrations/0100_ai_coworker.sql`) is passed straight through when a job has one, `null`
  (business default) otherwise. The proactive tick and autopilot are not currently
  per-location and stay that way — they pass `null`. Do not invent new per-location iteration
  for a surface that doesn't already have one; that is separate scope from this phase.

### 6. Console and dashboard

- `/platform/ai` and `/platform/ai/gateway` merge into one technical LiteLLM page — there is
  no longer a "connection" vs. "gateway" distinction to show separately. The page owns the
  gateway address, master key, aliases, staged diagnostics and per-business virtual-key
  lifecycle only. LiteLLM owns failover, routing, provider/MCP configuration and model access;
  Plan/Billing owns pricing, allowance, wallet and revenue.
- The platform console's business drill-down gains branch-aware virtual-key lifecycle: each
  location (from `businessLocations(businessId)`, the same helper `resolveActiveLocation`
  uses) can have its own key row, showing inherited/effective technical status without app-side
  model or budget controls.
- `/dashboard/ai/settings` must not reintroduce branch model/budget overrides. Tenant runtime
  resolves key + LiteLLM alias server-side; money stays in Plan/Billing and provider policy
  stays in LiteLLM.

### 7. Cleanup

Remove `OPENROUTER_API_KEY`/`ARVAN_AI_API_KEY` from `.env.example`; document
`LITELLM_MASTER_KEY`/gateway base URL as the only AI env vars. Update
`ai.test.ts`/`ai-gateway.test.ts`/`ai-service.test.ts`/`ai-config.test.ts` for the removed
providers and the technical-only branch/key merge order (add cases: branch key overrides
business key; no branch row falls back to the business row; no business row falls back to the
platform default key when tenant virtual keys are required).

## Out of scope

- **Per-branch prompt bindings or per-branch MCP server lists.** Stay in LiteLLM/global MCP
  configuration; this app page must not become an MCP management surface.
- **Splitting AI wallet/allowance billing per branch.** The Rial ledger a business is actually
  billed against stays business-level, matching every other billing surface in the app. The
  branch layer is virtual-key identity and diagnostics, never a second billing entity.
- **Changing the costing formula, the `/spend/logs` sync mechanism, or the answer-cache
  key.** Phase 38b's mechanisms are unchanged; only which config layer feeds them gains a
  branch dimension.
- **New per-location iteration for the proactive tick or autopilot.** They keep running
  per-business and use the business-default row.

## Rollout

Because the merged `platform_ai_gateway` row starts `enabled = false` whenever the prior
deployment wasn't already on `provider = 'litellm'`, this migration is not transparent to a
deployment still on a direct vendor: **the assistant goes dark until a platform admin
re-enters the gateway address and master key in the merged console page.** This is a one-time
manual step for the platform operator (there is exactly one global row), not per-tenant work,
and must be called out in the release notes the way any breaking migration is.

## Exit criteria (all met)

- `AiProvider` has exactly one member; nothing in the codebase references `openrouter` or
  `arvan` outside historical migration files.
- `platform_ai_config` no longer exists; `platform_ai_gateway` is the sole source of the
  global connection.
- A business with two branches — one with a branch virtual key and one inheriting the business
  key — authenticates each branch's calls with the right key while using the LiteLLM/platform
  model alias, verified end to end against a real gateway.
- Clearing the platform gateway's master key makes `isPlatformAiConfigured()` false and every
  AI entry point shows its existing "assistant unavailable" state rather than throwing.
- `ai_business_gateway` (widened) and `ai_gateway_usage.location_id` both pass the Phase 17
  generated tenant-isolation test.
- `npx tsc --noEmit`, `npm test`, `npm run test:db` and `npm run build` all pass.

## Follow-up (issue #757, PR #756 and after)

- Dead LiteLLM-policy-mirror fields (`fallbackModels`, `allowBusinessModels`,
  `publishedModels`, `modelOverride`, `mcpEnabled`, `mcpServers`) were removed from
  `src/lib/ai-gateway.ts` and their backing columns dropped from `platform_ai_gateway` /
  `ai_business_gateway` — the console never actually read or wrote them; LiteLLM's own config
  (`docker/litellm/config.yaml`) is the only place that policy lives.
- The admin fleet-readiness GET route (`/api/platform/ai/gateway`) no longer resolves each
  business's AI config one at a time (an N+1 query pattern); it now loads the gateway,
  business-gateway rows, locations and businesses once and decorates them in memory, with
  server-side search, status filtering (`ready` / `missing_key` / `key_sync_error` /
  `entitlement_disabled` / `branch_override` / `gateway_unavailable`) and pagination.
- Selecting a specific (business, branch) pair on `/platform/ai` now returns a distinct
  `branchReadiness` view scoped to that exact pair — credential source (branch vs. inherited
  business vs. none), whether the branch has its own key, the effective model alias, last
  verification time and any technical sync error — instead of only ever showing the
  business-default scope.
- **Deliberately left open:** the legacy plaintext `master_key`/`virtual_key` columns
  alongside their encrypted replacements were not dropped in this pass — that cutover needs a
  confirmed production backfill first and is unsafe to do blind.
