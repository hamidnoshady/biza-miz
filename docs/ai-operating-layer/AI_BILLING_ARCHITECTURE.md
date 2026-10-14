# AI Billing Architecture — single-billing cutover (historical migration 0168)

> This document records the 0168 billing/key cutover and remains useful for the Rial settlement
> invariants, but its early route/schema examples have since evolved. LiteLLM is now the only
> provider; issue #757 added exact branch readiness, retired app-side policy columns in migration
> 0184, and documented the guarded plaintext-secret removal in migration 0209. Use
> [Phase 39](../phases/Phase-39-LiteLLM-Only-AI-Platform.md) for current provider ownership and
> rollout prerequisites, and [the AI architecture guide](../ai-subsystem-architecture.md) for the
> current control-plane routes.

## The one-sentence rule

**The platform wallet (`business_wallets`) is the single billing stop for every
AI turn, a plan's «اعتبار ماهانهٔ هوش مصنوعی» is real spendable credit that the
settlement consumes before the wallet, and the LiteLLM virtual key is an
identity — it mirrors no budget, no rate limit and no model list.**

## The money story of one turn

```
tenant request (chat / vision / ocr / rag / media)
  │
  ├─ resolveAiConfigFor(businessId, locationId, { ensureVirtualKey: true })
  │     └─ lazily mints the business key when virtual keys are on        (ai-runtime.ts)
  │
  ├─ checkAiAffordability(businessId, maxTurnRial)                       (wallet-service.ts)
  │     ├─ reconcileAiDebtTx: any balance pays down AI debt first
  │     └─ affordable ⇔ debt ≤ 0 AND balance + allowanceRemaining ≥ ceiling
  │           402 ai_credit_required ← the ONLY pre-request money gate
  │
  ├─ provider call through the gateway (ai-service.ts)
  │     ├─ 429 → ai_rate_limited («پرکاربرد است؛ کمی بعد…»)
  │     └─ failure → no settlement call at all — the wallet is untouched
  │
  └─ settleAiWalletCharge({ requestId, chargedRial, … })                 (wallet-service.ts)
        ├─ idempotent by (business_id, request_id) — retries are no-ops
        ├─ allowanceAppliedRial = consumePlanAllowanceTx(cost)   ← allowance FIRST
        ├─ walletCost = cost − allowanceAppliedRial
        ├─ debitedRial  = min(walletCost, balance)               ← one ledger row
        ├─ debtAddedRial = walletCost − debitedRial              ← never hidden
        └─ charged_rial = FULL cost on the settlement row
```

### What each number means

| Field | Meaning |
|---|---|
| `chargedRial` (settlement) | The full settled cost of the turn — provider cost + platform margin. Never discounted. |
| `allowanceAppliedRial` | The part the plan's monthly credit covered. Recorded in the settlement metadata and (when the wallet was also debited) the wallet ledger metadata. |
| `debitedRial` | What actually left the wallet. A fully allowance-covered turn debits **0** and writes **no** wallet ledger row — the allowance row is the record. |
| `debtAddedRial` | A post-request cost the wallet could not cover. Booked in `ai_wallet_debt`, shown in the console, blocks the next turn until a recharge pays it down. |
| `feature_usage.spent_rial` | Wallet money only (`debitedRial`) — usage reporting and the wallet agree by construction. |

### The affordability gate

The gate runs BEFORE the request and uses the configured per-turn ceiling
(`maxTurnRial`) as a minimum-cover guard:

- **debt must be 0** — a business carrying AI debt is blocked at the door, and
  any balance it does have is applied to the debt inside the same locked
  transaction;
- **balance + allowanceRemaining ≥ ceiling** — so a business on a plan with
  credit may start a turn with an *empty wallet*, as long as the month's
  unused allowance covers the ceiling. Plan credit is spendable credit, not a
  hint.

The refusal is the one code `ai_credit_required` with the message
«اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید.».

## The plan allowance (Plan Builder's «سقف هوش مصنوعی این پلن»)

- `billing_plans.monthly_ai_credit_rial` — NULL means "no included credit"
  (0 normalises to NULL on save; an update can therefore *clear* the credit).
- One usage row per (business, calendar month) in `ai_plan_allowance_usage`.
  The month key is computed in **Asia/Tehran** (`periodMonthFor`), so an
  Iranian business's month flips at the Iranian midnight.
- `granted_rial` snapshots the plan's allowance at the month's first use; the
  effective cap for the rest of the month is `min(granted_rial, plan's current
  value)` — **lowering a plan bites immediately, raising it only next month,
  and history is never rewritten.**
- Consumption happens INSIDE the wallet settlement's locked transaction
  (`consumePlanAllowanceTx`); it needs no lock of its own because every writer
  already holds the per-business `business_wallets` lock.

## What the gateway key is — and is not

`provisionVirtualKey` mints a LiteLLM virtual key whose body is exactly:

```json
{ "key_alias": "pos-<business>", "metadata": { "business_id": "…", "source": "cafe-pos" } }
```

- **No `models` allowlist** — changing the platform's chat alias must not
  orphan every existing key against the new model. Model choice is the request
  path's decision (`resolveChatModel`), not the key's.
- **No app-mirrored `max_budget` / `budget_duration` / `tpm_limit` / `rpm_limit`** — migration
  0184 removes the retired app-side policy columns. LiteLLM may be configured with proxy limits
  separately, but the bundled `docker/litellm/config.yaml` does not make them a second product
  wallet. The app's Plan/Billing ledger remains the product billing source of truth.
- Keys are minted **lazily** (`ensureTenantVirtualKey`) on the first request
  that authenticates as the business; console read paths never mint. A branch
  key is optional and rides the business key when absent.
- Console `sync_key` pre-flights `ai_gateway_disabled`,
  `ai_gateway_missing_master_key`, `ai_gateway_virtual_keys_disabled` (400) and
  maps `GatewayProvisioningError` → 502 with the proxy's own detail.

## Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Rial billing, affordability, debt, allowance | `wallet-service.ts` + `ai-plan-allowance.ts` | The single stop. |
| Routing strategy, per-model RPM/TPM, per-key budgets | `docker/litellm/config.yaml` | The platform console mirrors none of them (migration 0168 dropped the columns and the env knobs). |
| Model aliases served | LiteLLM deployment catalogue; app defaults and mode mappings are stored in `platform_ai_gateway` / `platform_ai_modes` | Alias names must exist in the proxy; the app does not mirror deployment policy. |
| Per-business model override | None | Retired app-side `model_override` column dropped by migration 0184; runtime uses platform/mode aliases. |
| Platform revenue | `ai_wallet_settlements` aggregation | Billing/finance reporting only; not shown on `/platform/ai`. |

## Console surfaces (current routes)

- **`/platform/ai`** — gateway connection diagnostics, global defaults and the batched business/
  branch virtual-key fleet. The selected `(businessId, locationId)` readiness is distinct from
  business-default readiness and includes entitlement, key source/status, alias and sync errors.
  The old UI bookmark `/platform/ai/gateway` redirects here; `/api/platform/ai/gateway` remains
  the active API.
- **`/platform/ai/modes`, `/platform/ai/prompts`, `/platform/ai/agents`, `/platform/ai/research`
  and `/platform/ai/widgets`** — current runtime mode mappings, prompt versions, system-agent
  assignments, research caps and platform widgets. `/platform/ai/prompts` is active; it is not the
  retired prompt-fragment manager.
- **Plan/Billing** — customer price, monthly AI allowance, wallet balance, top-ups, overage and
  monetisation. AI settlements still flow through `ai_wallet_settlements`, `business_wallets` and
  `ai_plan_allowance_usage`.
- **LiteLLM** — upstream provider deployments, aliases, routing, retries, fallbacks and any
  independently configured proxy-side limits. LiteLLM's MCP/prompt features are not wired into
  the app's assistant runtime; the POS `/api/mcp` server is a separate external-client connector.

Legacy note: earlier builds showed per-business usage on `/platform/ai` and local
routing/budget/duration/TPM/RPM controls. Those console mirrors are retired; Plan/Billing owns
product prices and allowances, while the active technical fleet remains at `/platform/ai`.

## Error vocabulary (user-facing)

| Code | Message |
|---|---|
| `ai_credit_required` | اعتبار هوش مصنوعی کافی نیست. کیف پول کسب‌وکار را شارژ کنید. |
| `ai_rate_limited` | سرویس هوش مصنوعی در حال حاضر پرکاربرد است؛ کمی بعد دوباره تلاش کنید. |
| `ai_unavailable` | سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است. |
| `feature_disabled` | دستیار هوشمند برای این کسب‌وکار فعال نیست. |

The client (`errorMessage` in `use-ai-chat.ts`) prefers the server's own
message when one arrived and falls back to this table.

## The smoke suite

`integration/ai-billing-flow.integration.test.ts` walks the seven flows
end-to-end on a real Postgres:

1. allowance-first — a plan-covered turn writes no wallet debit;
2. mixed — the allowance absorbs part, the wallet pays the rest;
3. no-credit gate — no wallet and no allowance blocks the turn; an
   allowance-covered turn on an empty wallet is admitted;
4. recharge — a top-up unblocks the gate and pays down AI debt;
5. duplicate settlement — the same request id settles exactly once;
6. provider failure — the turn never settles, the wallet is untouched;
7. partial settlement — the shortfall is booked as debt that blocks the next
   turn until a recharge clears it.
