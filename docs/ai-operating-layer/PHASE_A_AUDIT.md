# Phase A — AI Operating Layer: Real Codebase Audit & Migration Map (historical snapshot)

> **Historical design audit, not current architecture or a source of truth.** This document was
> written against branch `arena/01a0b6ab-cafe-restaurant-pos` (base `6ba5931`) before the
> LiteLLM-only consolidation. It contains obsolete direct-provider, model/fallback, prompt/MCP
> and route assumptions. Use [Phase 39](../phases/Phase-39-LiteLLM-Only-AI-Platform.md) and
> [the current AI subsystem architecture](../ai-subsystem-architecture.md) for implementation.
>
> The inventory below records the files and state that existed at the time of that audit; later
> migrations and code may have removed or changed them.

## 0. Executive reality check

This is **not** a greenfield or a thin AI subsystem. The platform already has a
large, mature AI stack that has itself been through ~15 documented "phases"
(18 → 39). Concretely, `src/lib` alone has **640 files**, of which ~70 are
`ai-*`, and there are **182 SQL migrations**, ~30 AI/wallet/media related.

Much of what the brief asks for as "new" is **already partially built**:

- **LiteLLM is already integrated** as a first-class provider and increasingly
  as a control plane (migrations `0121`, `0123`, `0124`, `0125`; the app already
  reads `x-litellm-response-cost` and can price a turn from the gateway's real
  USD cost — see `ai-service.ts:155 responseCostUsd`, `ai-gateway-service.ts:878
  resolveGatewayTurnPricing`).
- Virtual keys, per-business/branch gateway rows, spend refresh, model routing,
  fallbacks, RAG-on-gateway-embeddings, and prompt-management scaffolding all
  exist to varying degrees.

So the work is genuinely an **evolution/consolidation**, exactly as the brief's
"IMPORTANT ENGINEERING PRINCIPLE" states — not a rebuild.

The brief (42 parts, 21 done-criteria) is, realistically, a **multi-month,
multi-engineer program**. It touches billing correctness, tenant isolation,
accounting invariants, a full UI redesign, and destructive schema migration.
Doing it as one blind mega-commit would be reckless. This document defines the
target architecture and a safe, phased, test-backed sequence, and the
implementation proceeds in reviewable increments on this branch.

---

## 1. What actually exists today (component inventory)

### 1.1 AI runtime & gateway
| File | Role | LiteLLM-aware? |
|---|---|---|
| `src/lib/ai.ts` (57k) | `ACTION_CATALOG`, `ActionType`, prompt assembly, agent modes | — |
| `src/lib/ai-service.ts` (28k) | chat/vision/extract calls, reads `x-litellm-response-cost` | **yes** |
| `src/lib/ai-gateway.ts` (38k) | pure gateway math: `rialFromGatewayUsd`, `gatewayTurnPricing` | **yes** |
| `src/lib/ai-gateway-service.ts` (36k) | LiteLLM mgmt API: `provisionVirtualKey`, `refreshKeySpend`, `probeGateway`, `readProxyRouterSettings`, `listGatewayModels`, `resolveGatewayTurnPricing` | **yes** |
| `src/lib/ai-tools.ts` (61k) | 36 read tools (`READ_TOOL_NAMES`), `runReadTool` | — |
| `src/lib/ai-tool-routing.ts` | which tools a surface may call | — |
| `src/lib/ai-prompts.ts` (19k) | prompt templates (DB-backed, migration `0112`/`0115`) | partial |
| `src/lib/ai-config.ts` | model/temperature config | — |

### 1.2 Billing (the central conflict — Parts 2/3)
Two parallel money systems currently coexist:

1. **AI-specific credit ledger** (`ai_business_billing.balance_rial`,
   `ai_credit_ledger`), driven by **reserve→settle→cancel**:
   - `reserveAiTurn` / `settleAiTurn` / `cancelAiTurnReservation`
     (`ai-billing-service.ts:292/363/444`).
   - Callers: `api/ai/chat/route.ts`, `api/ai/inventory-vision/route.ts`,
     `api/ai/invoice-ocr/route.ts`, `api/media/[id]/detect/route.ts`,
     `ai-autopilot-service.ts`, `ai-proactive-service.ts`.
   - Reservation debits the AI balance up-front (`max_turn_rial`), settles to
     real cost, refunds the remainder. This is exactly the "reserve the maximum
     turn" pattern Part 2 says to retire.
2. **Canonical platform wallet** (`business_wallets`, `wallet_ledger`,
   `wallet-service.ts`), with row-locked `writeLedger`, `chargeFeatureUse`,
   `getWallet`, top-ups & Zarinpal (migration `0130`). Used by media, website,
   billing-service. `featureKey`/`feature_key` column already exists.

**Gap:** AI does **not** debit the canonical wallet. It debits a second balance.
`business_wallets` is referenced by 2 files; `ai_business_billing` by 1
(the AI billing service). This is the duplicate-money-system the brief targets.

### 1.3 Local AI infra that duplicates LiteLLM (Parts 4/5)
| Concern | Local impl | Migration | LiteLLM replacement status |
|---|---|---|---|
| Semantic answer cache | `ai-answer-cache.ts`, `ai_answer_cache` | `0114` | Not yet on gateway; app-owned embedding match |
| Embeddings / RAG | `ai-embeddings.ts`, `ai-rag.ts`, `ai-rag-indexer.ts`, `ai_embeddings` (pgvector) | `0113` | Embeddings already go **through** the gateway alias `pos-embed`; vectors stored locally |
| Per-token pricing | `ai-billing.ts calculateAiUsageCostRial` + `platform_ai_gateway.*_cost_rial_per_million` | `0116`,`0124` | Gateway real cost already available; token rates are the **fallback** |

### 1.4 Entity model (Parts 7–10) — overlap confirmed
- **Automation:** *No dedicated generic automation engine.* The closest is
  `ai_proactive_jobs` (`0040`) + `ai-agents.ts` (5 hard-coded background agent
  keys) + `ai-proactive-service.ts`. Triggers are schedule-only.
- **Coworker:** real subsystem — `ai_coworker_jobs`/`_events`/`_runs` (`0100`),
  `ai-coworker-service.ts` (47k), templates (`ai-coworker-templates.ts` 28k),
  triggers: schedule/event/manual.
- **Agent:** `ai-agents.ts` = 5 fixed keys (`financial_report_builder`,
  `sales_analyzer`, `receivables_follow_up`, `reconciliation_assistant`,
  `service_reminders`) with only `enabled`+`scheduleHour` (migration `0047`).
  **No custom agents, no tool allowlist per agent, no per-agent prompt.**
- **Autopilot:** `ai-autopilot.ts` (guardrail engine — categories, per-category
  Rial limits, `alwaysConfirm`, revertibility), `ai-autopilot-executors.ts`
  (30k), `ai-autopilot-service.ts` (26k). Migration `0097`. **This is the
  valuable safety engine** the brief says to preserve and turn into an
  execution/approval policy.

### 1.5 Projects (Parts 17–20)
`ai_projects` + `ai_project_notes` (`0111`) + `ai_conversations.project_id`.
Columns today: id, business_id, name, instructions, created_by, archived_at.
UI: `(app)/projects/page.tsx`, `(app)/projects/[id]/page.tsx`. This matches the
brief's "too simple" description exactly: name + instructions + notes +
conversation list. **No project memory table, no files, no tasks, no attached
agents/coworkers/automations, no project-native chat.**

### 1.6 Media (Parts 21–23)
`media_assets`/`media_folders` (`0149`), `media-service.ts`, object storage,
`storeMediaAsset`/`readMediaObject`/`deleteMediaAsset`, `ai_status`,
`source_asset_id`/`variant` for AI-refined images. **But AI chat attachments
are deliberately non-persistent** (`ai-attachment.ts`: "nothing here touches a
table or object storage"). So AI uploads/generated files do **not** land in the
Media Library yet — the Part 21 gap.
`media_assets` has no `source`/`conversation_id`/`project_id`/`created_by_ai`
provenance columns yet.

### 1.7 Chat UI (Parts 12–13, 25–28)
- `(app)/ai/page.tsx` → `dashboard/ai/ai-workspace.tsx` (rail + thread +
  composer). Components in `src/components/ai/` (~14). No structured interactive
  cards (single/multi choice, form, entity picker, approval card) as a typed
  protocol — proposals exist via `ai-proposal-card.tsx` but input requests do
  not.

### 1.8 Platform AI admin (Part 33)
`src/app/platform/ai/page.tsx` (805 lines) — super-admin AI console (pricing,
gateway, costing, routing). Candidate for trimming once LiteLLM owns pricing.

### 1.9 Test harness (Part 37) — VERIFIED WORKING
- Unit: `vitest run` (no DB). ✅ ran `ai-billing`+`ai-autopilot` (46 tests pass).
- DB integration: `vitest run --config vitest.db.config.ts`, needs
  `DATABASE_URL`. Embedded Postgres via `scripts/dev-postgres.mjs`
  (`@embedded-postgres/linux-x64`). ✅ verified: `ai-agent-settings.integration`
  passes against local PG on :5433. Existing AI integration tests:
  `ai-gateway`, `ai-coworker`, `ai-conversations`, `ai-autopilot`,
  `ai-virtual-key-provisioning`, `ai-orientation-tools`, `ai-tools-wave13`, etc.

---

## 2. Capability / gap matrix (business ops vs AI)

Legend: R=read tool exists, A=write action exists (`ACTION_CATALOG`),
C=needs confirm, Auto=can autopilot. Write actions from `ai.ts ActionType`.

| Capability | Manual UI | AI read | AI act (action) | Confirm | Autopilot | Gap / missing tool |
|---|---|---|---|---|---|---|
| Accounting: reports | ✅ | `list_reports`,`run_report`,`run_accounting_review` | `journal.manual.propose`,`expense.categorize` | ✅ | money | No P&L-explain tool; no reconcile action |
| Accounting: AR/AP | ✅ | `get_ar_aging`,`get_ap_upcoming`,`get_unreconciled_bank_lines` | — | — | — | **No "record payment/allocate receipt" action** |
| Accounting: tax/VAT | ✅ | `get_vat_liability` | `setup.tax` | ✅ | — | No VAT filing prep |
| Sales/POS | ✅ | `get_menu_performance`,`get_void_pattern`,`get_bill_split_preview` | `order.discount.apply` | ✅ | — | No create-order draft |
| Menu/catalog | ✅ | `get_menu_item_details` | `menu.item.*`,`setup.menu.*` | ✅ | pricing | Good coverage |
| Inventory | ✅ | `get_stock_valuation`,`get_near_expiry_items`,`get_waste_history`,`forecast_demand`,`find_items` | `inventory.reorder.draftPO`,`inventory.adjustment.propose`,`inventory.waste.log`,`inventory.production.run` | ✅ | inventory | Good coverage |
| Suppliers | ✅ | `get_supplier_performance` | — | — | — | **No create/update supplier action** |
| Customers/CRM | ✅ | `find_customers`,`get_customer_profile`,`get_customer_timeline`,`get_at_risk_customers`,`list/preview_customer_segment`,`get_repurchase_candidates` | `customer.note.add`,`crm.customer.tag`,`crm.customer.note` | some | customer | **No create/update customer action** |
| Growth/Marketing | ✅ | — | `messaging.campaign.trigger`(coworker-only) | ✅ | messaging | **No campaign create/schedule action; no read tool for campaigns** |
| Website CMS | ✅ | `list_website_posts`,`list_website_products`,`get_website_status` | `website.post.draft/update/publish`,`website.product.upsert` | publish=alwaysConfirm | website | Good coverage |
| WooCommerce | partial | via website tools | website.product.upsert | ✅ | website | Depends on Woo sync; verify |
| Reservations/Tables | ✅ | `get_reservation_conflicts`,`get_table_turnover_rate` | `reservation.create/reschedule`,`table.merge/split`,`courier.assign` | ✅ | — | Good coverage |
| Payroll | ✅ | `get_payroll_summary`,`get_staff_commission` | — | — | — | Read-only (appropriate) |
| Projects | ✅(basic) | — | — | — | — | **No AI tool to create/attach project objects** |
| Media | ✅ | — | — | — | — | **No AI media tools; uploads not persisted** |
| Team/users | ✅ | — | — | — | — | Intentionally excluded (safety) |

**Highest-value genuine gaps** (Part 16): supplier create/update, customer
create/update, AR receipt/payment allocation, campaign create/schedule +
campaign read tool, project object management, media persistence + media tools.

---

## 3. LiteLLM capability verification (Part 1 CRITICAL RULE)

Deployed image: `ghcr.io/berriai/litellm:main-stable` (docker-compose.yml).
Config: `docker/litellm/config.yaml`. Before deleting any local impl, each
LiteLLM capability must be verified **against this image's API**, with an
integration test, per the brief. Status of what the app already relies on:

| LiteLLM feature | Used by app today | Verified in tests | Safe to lean on |
|---|---|---|---|
| Virtual keys (`/key/generate`,`/key/info`) | `provisionVirtualKey`,`refreshKeySpend` | `ai-virtual-key-provisioning.integration` | yes |
| Per-response cost header `x-litellm-response-cost` | `responseCostUsd` | `ai-gateway` tests | yes |
| `/spend/logs` rollup | `ai_gateway_usage` | partial | verify before relying for billing |
| Routing/fallbacks/`router_settings` | config + `readProxyRouterSettings` (read-only) | `ai-gateway` | yes (config-owned) |
| Prompt management (dotprompt/`prompt_id`) | scaffolding only, **not wired** | no | **must verify before migrating prompts** |
| Caching (proxy-side) | not used | no | **must verify before deleting `ai_answer_cache`** |
| Managed vector store / RAG | not used (app owns pgvector) | no | **must verify support in this image before moving RAG** |

**Conclusion for Parts 4/5:** The brief's own CRITICAL RULE forbids deleting the
local cache/RAG until the LiteLLM replacement is verified *in this image* and
tested. `main-stable` moves fast; proxy-side caching (Redis) exists, but a
managed vector-store RAG that fully replaces app-owned pgvector + tenant
permission-scoped indexing is **not** something to assume. The safe path:
verify empirically (integration test against a real proxy) first; keep the app
as the owner of *what* content is retrievable (it owns permissions), and only
delegate execution where proven.

---

## 4. Target architecture (the north star)

```
                 ┌──────────────── AI Workspace (UI) ───────────────┐
User ─┬─ AI ─────┤ Chat · Projects · Agents · Coworkers · Automations │
      │          │ Approvals/Activity · Files/Knowledge · Usage       │
      │          └───────────────┬───────────────────────────────────┘
      │                          │  structured input protocol / proposals
      │                          ▼
      │            Agent orchestration  ──►  LiteLLM (control plane)
      │                          │            providers·models·routing·cost·
      │                          │            cache·prompts·virtual keys·spend
      │                          ▼
      │            Typed tools / ACTION_CATALOG  (risk-classified)
      │                          │
      └─ Manual App UI ──────────┤
                                 ▼
                     Existing application services  (validation, RLS, audit)
                                 ▼
                              PostgreSQL
                                 ▲
     wallet-service (money) ─────┘   media-service (files)   projects (context)
```

Ownership contract: **LiteLLM owns AI infra · platform owns business truth ·
wallet owns money · Media Library owns files · Projects own long-running
context · typed tools/actions connect AI to the business.**

---

## 5. Migration map (safe, additive-first — Part 34)

Every destructive step follows: deploy replacement → migrate data → verify →
stop reads/writes → later drop schema. Nothing is dropped in the same migration
that introduces its replacement.

| # | Change | Type | Depends on |
|---|---|---|---|
| M1 | `wallet_ledger.feature_key='ai'` settlement path; `ai_wallet_settlements` metadata table (LiteLLM call id, model, tokens, conv/project/agent ids, cost usd/rial) | additive | wallet-service |
| M2 | Backfill: reconcile `ai_business_billing` → freeze; route all new AI debits to `business_wallets` | data | M1 |
| M3 | `media_assets` provenance columns (`source`, `conversation_id`, `project_id`, `run_id`, `created_by_ai`, `model`) | additive | media |
| M4 | Project workspace tables: `ai_project_memory`, `ai_project_files`(link table), `ai_project_tasks`, `ai_project_members`, entity `project_id` FKs on agents/coworkers/automations | additive | projects |
| M5 | Unified AI entity model: `ai_automations` (trigger/action/conditions), extend agents to custom (`ai_agent_defs` with prompt ref + tool allowlist), coworker prompt refs | additive | — |
| M6 | Prompt bindings: `ai_prompt_bindings` (surface/entity → prompt id + version + scope) | additive | LiteLLM prompt verify |
| M7 | Structured input protocol: `ai_input_requests` (id, run/conv id, type, schema, response, status) | additive | — |
| M8 | (LATE) drop `ai_answer_cache` after LiteLLM cache verified+tested | destructive | Part 4 verify |
| M9 | (LATE) migrate/retire `ai_embeddings` local RAG if/after LiteLLM RAG verified | destructive | Part 5 verify |
| M10 | (LATE) drop `ai_business_billing`/`ai_credit_ledger` after wallet cutover proven | destructive | M2 |

---

## 6. Recommended implementation sequence (matches brief Part 39)

- **B — Wallet cutover (Parts 2/3):** highest correctness value, self-contained,
  testable. Make AI debit the canonical wallet from real LiteLLM cost; retire
  reserve/settle. *Start here.*
- **C — Capability gaps (Part 16):** add supplier/customer/AR/campaign write
  actions + campaign read tool through existing services.
- **D — Unified entity model (Parts 7–10):** Automation engine + custom Agents +
  autopilot-as-policy, preserving the guardrail engine.
- **E — Structured chat protocol (Parts 13/14):** typed input requests + UI cards.
- **F — Projects as workspaces (Parts 17–20):** memory, files, project chat,
  attached objects.
- **G — Media persistence (Parts 21–23).**
- **H — Cache/RAG to LiteLLM (Parts 4/5):** *only after empirical verification.*
- **I — UI redesign + IA (Parts 11/24–28).**
- **J — Cleanup + drop legacy schema (Parts 33/35).**

---

## 6b. Phase B — DELIVERED (wallet billing cutover)

Status: **done, test-backed.** AI turns now bill the canonical
`business_wallets` and the reserve/settle/cancel dance is retired at every live
call site.

What changed:
- **Migration `0153_ai_wallet_billing.sql`** (additive): `feature_flags('ai')`,
  `ai_wallet_settlements` (AI detail + idempotency behind each wallet debit,
  unique on `(business_id, request_id)`), `ai_wallet_debt` (affordability
  backstop). Both new tables are FORCE-RLS tenant-isolated and are
  auto-verified by the generated tenant-isolation suite.
- **`wallet-service.ts`**: `checkAiAffordability` (pre-request gate, pays down
  debt opportunistically), `settleAiWalletCharge` (post-request debit,
  idempotent, partial-debit-into-debt when a real cost can't be covered — never
  negative balance), `getAiDebtRial`, `AI_FEATURE_KEY`. Reuses the existing
  row-locked `withWalletTx`/`writeLedger`, so the no-negative-balance and
  no-double-spend guarantees are unchanged.
- **`ai-wallet-billing.ts`** (new orchestration): `gateAiTurn`,
  `newAiRequestId`, `settleAiTurn`. Prefers LiteLLM's reported USD cost
  (`resolveGatewayTurnPricing`) and falls back to the token rates only when the
  gateway didn't price the turn. Emits `AiWalletInsufficientError`.
- **6 call sites migrated**: `api/ai/chat`, `api/ai/inventory-vision`,
  `api/ai/invoice-ocr`, `api/media/[id]/detect`, `ai-proactive-service`,
  `ai-autopilot-service`. All now gate → run → settle against the wallet; no
  reservation, no refund path (a turn that never reached the provider costs
  nothing).
- **Tests**: `integration/ai-wallet-billing.integration.test.ts` (7 cases:
  real-cost debit, affordability block, idempotency, zero-cost/cache,
  partial→debt→unblock, project attribution, tenant isolation). Existing AI
  suites (autopilot, coworker, conversations, gateway, billing, estimate) still
  green. Full `tsc` clean.

Deliberately **not** done yet (safe migration window, Part 34): the legacy
`ai_business_billing` / `ai_credit_ledger` tables and the now-dead
reserve/settle/cancel functions in `ai-billing-service.ts` remain in place for
reconciliation. They are removed in a later destructive migration (M10) once
the cutover is proven, together with the dead platform AI-subscription code.

## 7. Risks / non-negotiables

- Do not weaken `business_wallets` row-locking / no-negative-balance.
- Do not break accounting posting invariants, RLS, or action audit.
- Do not delete local cache/RAG on faith — verify against `main-stable` first.
- Do not create generic `execute_sql`/`update_table`/`run_javascript` tools.
- Keep both money systems reconciled during the cutover window; never
  double-charge.

## 6c. Phase C — DELIVERED (capability gaps)

Four write actions the assistant was missing, each wired to an **existing**
role-guarded route — no new business logic, no new endpoints — plus the two
read tools that make the campaign write usable.

**New `ACTION_CATALOG` entries** (`src/lib/ai.ts`):

| Action | Endpoint (existing) | Guard | Safety |
| --- | --- | --- | --- |
| `party.customer.create` | `POST /api/parties` (`roles:["Customer"]`) | `parties.view` + `parties.manage` | payload avoids accounting fields, so no `ledger.view` gate |
| `party.supplier.create` | `POST /api/parties` (`roles:["Supplier"]`) | same | same |
| `messaging.campaign.create` | `POST /api/messaging` (`action:"campaign"`) | `requireRole(owner,manager)` | draft only — never launches/sends |
| `ar.receipt.record` | `POST /api/ledger/ar/receipts` | `requireRole(owner,manager,accountant)` | `alwaysConfirm` (moves money) |

- `/api/parties` is the only party write door (migration 0137 removed
  `/api/customers`); customer vs supplier differ only in `roles`, so one
  endpoint serves both catalogue entries. The payload hints deliberately steer
  the model away from accounting fields (`accountingCode`, `taxPercentage`,
  `financial_info`) so the write never trips the route's extra `ledger.view`
  gate — a person's name and phone is the CRM's half, not the ledger's.
- Campaign **create** materialises a draft only. **Launch/send** is
  deliberately *absent* from the catalogue — a message that reaches a real
  person stays a human's click on the growth screen, the same line
  `messaging.campaign.trigger` (coworker-only) already draws.
- None of the four carries an `autopilotCategory` or `executor`: creating a
  person or moving money is a human-confirmed decision, never an unattended
  tick's. They flow through the browser apply path
  (`src/components/ai/apply-proposal.ts`) with the user's own session cookie.
- `ar.receipt.record` is the second `alwaysConfirm` action (after
  `website.post.publish`).

**New read tools** (`src/lib/ai-tools.ts`, `runReadTool` + `READ_TOOL_NAMES`,
MCP summaries in `src/lib/mcp/tools.ts`):

- `list_message_templates` (optional `channel` filter) → `listMessageTemplates`.
- `list_message_campaigns` → `listMessageCampaigns`.
  These give the model a `templateId` (and `segmentId` from the existing
  `list_customer_segments`) before it proposes `messaging.campaign.create`, and
  campaign status for "how did my campaign do" questions.

**Tests**: `src/lib/ai.test.ts` gains a Phase C block (four actions present,
both party creates share `/api/parties`, campaign create is a draft with no
send action, receipt is `alwaysConfirm`, all four out of every unattended
path, both read tools offered in dashboard mode). The `alwaysConfirm` invariant
now pins the two-entry set. `integration/ai-phase-c-tools.integration.test.ts`
exercises both read tools against real rows and asserts per-business scoping.
All 4760 unit tests + AI integration suites (wallet-billing, wave13, phase-c)
green; `tsc` clean.

Deliberately **not** added: `crm.customer.consent`, `crm.customer.merge`,
campaign launch/send — the Phase 36 hard lines still hold (irreversible
promises/judgements about a real person stay a named human's action).

## 6d. Phase D — IN PROGRESS (unified entity model)

Phase D is a three-part program (Parts 7–10): **custom Agents**, a generic
**Automation engine**, and turning **autopilot into a reusable policy**.
Delivered depth-first, one part per turn.

### Part 1 of 3 — Custom Agents — DELIVERED (test-backed)

The sharpest documented gap: until now an "agent" was one of five hard-coded
keys (`ai_agent_settings`, migration 0047) a business could only enable and
reschedule — no custom agents, no per-agent prompt, no per-agent tool
allowlist. This adds a business-defined agent that is a **lens over the same
dashboard assistant**, not a new brain or a new mutation path.

What changed:
- **Migration `0154_ai_custom_agents.sql`** (additive): `ai_custom_agents`
  (name, instructions, `tool_allowlist text[]`, `action_allowlist text[]`,
  enabled, created_by) — FORCE-RLS tenant-isolated, unique name per business,
  auto-verified by the generated tenant-isolation suite. Also widens
  `ai_action_audit.source` to include `'agent'` (joins manual/autopilot/
  coworker) so an agent-produced proposal's later apply is attributable.
- **`ai-custom-agents.ts`** (pure, framework-free): `validateCustomAgent`
  (rejects — never silently drops — an unknown tool/action; a coworker-only
  action is not allowlistable), `selectableAgentTools` (the dashboard read
  surface minus `propose_action`, derived from `toolDefinitions` so it can't
  drift), `selectableAgentActions` (`ACTION_CATALOG` minus coworker-only),
  `agentTurnScope`, `customAgentErrorMessage`.
- **`ai-custom-agents-service.ts`**: CRUD over the table, tenant-scoped,
  unique-name (`23505` → `name_taken`).
- **Runtime wiring — the agent genuinely narrows a turn**:
  - `toolDefinitions("dashboard", { toolAllowlist, actionTypes })` intersects
    the read tools with the allowlist and scopes `propose_action` to the
    agent's action list (empty ⇒ no propose tool at all — a read-only agent).
  - `buildSystemPrompt` appends the agent's instructions **on top of** the
    grounding rules (Persian/Toman/Jalali/never-invent-a-number always stand)
    and scopes the catalogue dump to the agent's actions.
  - `runAgentTurn` accepts `toolAllowlist` and re-checks proposals against the
    scoped action set, so a hand-crafted out-of-scope proposal is refused.
  - `POST /api/ai/chat` accepts `agentId` (dashboard only); a disabled/unknown
    id is a 404, never a silent fallback. An agent turn never shares the
    general assistant's answer cache.
- **Routes**: `GET/POST /api/ai/agents`, `GET/PUT/DELETE /api/ai/agents/[id]`
  (manager-guarded; GET also returns `selectableTools`/`selectableActions` so a
  future editor renders from the live catalogue).

Tests: `src/lib/ai-custom-agents.test.ts` (13 — validation + that scoping
actually narrows tools/actions/prompt and leaves an un-agented turn unchanged);
`integration/ai-custom-agents.integration.test.ts` (4 — CRUD, unknown-tool
rejection, duplicate-name, cross-tenant not_found). All 4775 unit tests and the
AI integration suites green; `tsc` clean; tenant-isolation suite covers 0154.

A management **UI** is deliberately deferred to Phase I (UI redesign); the REST
API is complete and usable now.

Phase D is now COMPLETE across all three parts (custom Agents, Automation
engine, autopilot-as-policy) — see Parts 1–3 below. Nothing dropped or rewrote
the existing coworker/autopilot schema.

### Part 2 of 3 — Automation engine — DELIVERED (test-backed)

The coworker (0100) fills a fixed TEMPLATE; an automation is a free
composition the owner assembles themselves:

    WHEN  <trigger>      (manual | schedule | event)
    IF    <conditions>   (a typed rule document over run-time facts)
    THEN  <action>       (one ACTION_CATALOG action + payload)

What it adds over everything before it is the **condition** — a typed,
deterministic rule document evaluated against facts read from the database at
fire time. It opens **no new mutation path**: a fired automation proposes
exactly what the chat could, through the same role-guarded executor; the
conditions only decide *whether* to propose.

What changed:
- **Migration `0155_ai_automations.sql`** (additive): `ai_automations`
  (trigger + `conditions jsonb` + `action_type` + `action_payload` +
  ask/auto). Trigger vocabulary and the shape CHECK mirror `ai_coworker_jobs`
  exactly, so one tick can drive both later without a schema change. FORCE-RLS,
  unique name per business, auto-verified by the tenant-isolation suite. Widens
  `ai_action_audit.source` with `'automation'` (now manual/autopilot/coworker/
  agent/automation).
- **`ai-automations.ts`** (pure): a small bounded condition DSL over five
  deterministic facts (`receivableTotalRial`, `payableTotalRial`,
  `stockValuationRial`, `weekday`, `hour`) with `gte`/`lte`/`eq`;
  `evaluateConditions` (empty ⇒ matches, all-of AND any-of); `validateAutomation`
  (rejects — never ignores — an unknown field/operator/action and every
  coworker-only action; enforces the trigger shape); `selectableAutomationActions`.
- **`ai-automations-service.ts`**: tenant-scoped CRUD; `gatherAutomationFacts`
  (reads the same numbers the chat's report tools return — A/R aging total,
  A/P aging total, inventory valuation, business-clock weekday/hour);
  `previewAutomation` (a dry run that reports whether the conditions hold *right
  now* and what it would propose, proposing nothing). `authorized_by` is stored
  only for an `auto` automation.
- **Routes**: `GET/POST /api/ai/automations`, `GET/PUT/DELETE
  /api/ai/automations/[id]`, `GET /api/ai/automations/[id]/preview`
  (manager-guarded; `auto` requires owner; GET list returns the selectable
  fields/operators/event-kinds/actions so a future editor renders from the live
  vocabulary).

Tests: `src/lib/ai-automations.test.ts` (11 — evaluator AND/OR semantics +
validation), `integration/ai-automations.integration.test.ts` (5 — CRUD,
auto authority, unknown-action rejection, real-fact gathering + preview
fires/doesn't-fire, duplicate-name + cross-tenant). All 4789 unit tests + AI
integration suites green; `tsc` clean; tenant-isolation covers 0155.

UI deferred to Phase I; the engine's firing hook (wiring `previewAutomation` +
`gatherAutomationFacts` into the existing coworker/proactive tick to actually
enqueue proposals) lands with **Part 3 — autopilot-as-policy**, which unifies
the ask/auto approval ceiling across coworker, autopilot and automations.

### Part 3 of 3 — autopilot-as-policy + firing hook — DELIVERED (test-backed)

The final Phase D part turns the guardrail engine into ONE named
unattended-execution ceiling shared by every feature that can write without a
person watching, and wires the Automation engine's firing into the existing
tick so a fired automation actually enqueues a proposal on that same guarded
path.

**One named ceiling.** `evaluateUnattendedAction` (in the pure `ai-autopilot.ts`)
is now the single gate every unattended write funnels through — autopilot, the
coworker AND automations. It applies four ordered gates, none of which a
caller's own `approvalMode` can override and none of which is ever a *drop*
(a "no" holds the proposal for a human on the identical manual apply path):
(1) a real action with an unattended executor; (2) the owner chose `auto` for
this work; (3) a real user's authority backs it; (4) the per-category caps admit
this specific payload (delegated to `evaluateAutopilotProposal`, unchanged). The
coworker's `planCoworkerActions` was refactored to a thin adapter over it, so
its four hand-rolled copies of the same reasoning are gone — an owner who set
"money: at most 5,000,000 ﷼ unattended" said that about their *business*, and
there is now exactly one place that rule lives.

**Firing hook.** `ai-automations-service.ts` gained the runtime:
`fireAutomation`/`runAutomationNow`/`runAutomationsTick` plus a claimed
`ai_automation_runs` ledger (migration **0156**, RLS like every tenant table,
`UNIQUE (automation_id, dedupe_key)` mirroring `ai_coworker_runs`). A firing
gathers the same facts `previewAutomation` shows, evaluates the typed
conditions, and only if they hold records the action in the shared
`ai_action_audit` (`source = 'automation'`) and either applies it through the
same `AUTOPILOT_EXECUTORS` (when the shared ceiling admits an `auto`
automation) or leaves it `proposed` with a `deferred_reason` — held, never
dropped, never forced. The daily category counter is shared across
autopilot + coworker + automation, so an automation cannot be a way around the
day's allowance either.

**Riding the tick.** `runBusinessProactiveJobs` now runs `runAutomationsTick`
BEFORE the coworker (the coworker clears the lifecycle-event queue on finish, so
automations must read the unprocessed rows first); its per-event/per-schedule
run claim, not the processed flag, is what keeps it idempotent across ticks.
Like the coworker it uses no provider and spends no credit, needs no opt-in, and
never takes the digests down. A `POST /api/ai/automations/[id]/run` endpoint
fires one on demand (owner required for an `auto` automation).

Tests: `src/lib/ai-autopilot.test.ts` (+6 for `evaluateUnattendedAction`),
`integration/ai-automations.integration.test.ts` (+5 firing: in-cap applies &
audits as `automation` with prior-state; over-cap held as clickable proposal
with the price unmoved; `ask` always held; conditions-not-met ⇒ `skipped`,
proposes nothing; dedupe-key idempotency). Full suite **4796 unit tests / 325
files**; AI integration suites green (automations 10/10, coworker 15/15,
autopilot 10/10, tenant-isolation 20/20 — the last covers 0156); `tsc` clean.

**Phase D COMPLETE** (Parts 1–3: custom Agents, Automation engine,
autopilot-as-policy). UI for all three deferred to Phase I. Next in the agreed
sequence: **Phase E — structured chat input protocol**.

## 6e. Phase E — COMPLETE (structured chat input protocol)

Phase E turns "the AI asks a question" from a free-text guessing game into a
typed round-trip. Instead of the model writing "which supplier — Aram Coffee or
Pak Dairy?" and hoping the human types one back verbatim, it emits a
`request_input` tool call carrying a **spec**, the turn ends (exactly like
`propose_action`), the UI renders a card, and the human's answer is
re-validated server-side against the *stored* spec before it re-enters the
model as plain text.

**Three input kinds** (`src/lib/ai-input-protocol.ts`, the pure validation
core, 15 unit tests):

- `choice` — pick exactly one of N labelled options (optionally an "other"
  free-text escape hatch).
- `multi_choice` — pick zero-or-more, with optional `min`/`max`.
- `form` — a small set of typed fields (`text` / `number`), each
  required-or-not.

`InputRequestSpec` is what the model emits; `InputResponse` is what the human
sends back; `validateInputRequest(spec, response)` is the single gate both the
client (to enable Submit) and the server (as the real authority) run.

**Why `request_input` is read-shaped.** Asking a typed question opens no write
path, so the tool is declared on **every** dashboard turn — including scoped
and read-only custom agents. It is declared LAST in `toolDefinitions`, after
`propose_action`, and the service loop short-circuits on it the same way
(`AgentReply.inputRequest`, `src/lib/ai-service.ts`). Over **MCP** it is
excluded (`EXCLUDED_READ_TOOLS` in `src/lib/mcp/tools.ts`): there is no card
and no human to answer it, so it has no meaning for an external client.

**The answer path never trusts the client.** The card sends back ids
(`{ choice: "s1" }`), but the model is fed **labels**, never ids — the id
"s1" is an implementation detail the model never sees. The answer is
re-validated against the spec that was stored when the request was created, so
a hand-crafted POST naming an option that was never offered is refused
(`invalid_response`). Answering is idempotent: a second submit reports
`already_answered` and does not overwrite the recorded response. A pending
request can be dismissed (`cancelled`).

**Storage & isolation.** `migrations/0157_ai_input_requests.sql` adds
`ai_input_requests`, which reaches tenant scope only through its parent
`ai_conversations` row (the same shape as `ai_messages`) and carries RLS from
it. `src/lib/ai-input-requests-service.ts` is the tenant-scoped DB half
(`createInputRequest`, `answerInputRequest` → returns the model message,
`cancelInputRequest`, plus read helpers). The route
`api/ai/conversations/[id]/input-requests/[requestId]` (POST answer / DELETE
cancel) re-checks `ownsConversation` before doing anything — ownership is the
authorization, the same pattern as the conversation routes (recorded in
`api-guards.test.ts`'s self-guarding list).

**Wiring.** `getConversationMessages` LEFT JOINs the request so a reloaded
conversation shows a still-pending card; `chat/route.ts` creates the row and
includes `inputRequest:{id,spec}|null` on the `done` event, and treats a turn
that asks for input as non-cacheable. Client:
`src/components/ai/use-ai-chat.ts` (`AiInputRequestState`,
`AiChatMessage.inputRequest`, `submitInputRequest`, `dismissInputRequest`),
the new `ai-input-request-card.tsx` (choice / multi_choice / form, with the
"other" escape hatch and client-side `canSubmit`), rendered by
`chat-bubble.tsx` and threaded through `ai-chat-messages.tsx`,
`ai-assistant.tsx`, and `ai-chat-hub.tsx`.

**Tests.** `ai-input-protocol.test.ts` 15/15; the AI unit files that enumerate
tools updated (`request_input` present on dashboard + scoped agents, absent
from MCP read tools, `propose_action` still present); new
`integration/ai-input-requests.integration.test.ts` (create/read pending,
valid answer → label-based model message, refused unknown option, idempotent
double submit, dismiss); `tenant-isolation.integration.test.ts` now covers
0157 (20/20). Full suite **4812 unit tests / 326 files**; `tsc` clean.

**Phase E COMPLETE.** Next in the agreed sequence: **Phase F — Projects as
workspaces (memory / files / project chat).**

## 6f. Phase F — Part 1 DELIVERED (projects become workspaces: live context + memory)

Phase F turns a project from a folder that merely *groups* threads into a
WORKSPACE that *shapes* them. Part 1 closes the gap the audit named in §1.5 and
adds the first new workspace surface.

**The dead-code gap, closed.** `buildProjectPromptContext`,
`getConversationProjectId` and `listConversationsByProject` were all written
"for prompt injection" at Phase 35 Wave 3 and then never called — a project's
standing instruction and notes never reached the model, so a project could not
influence a single reply. Part 1 wires them into the live chat turn:

- `ai-projects.ts` gains `getProjectPromptContext` (loads instruction + notes +
  memory for a business's project in one tenant-scoped pass) and
  `buildProjectPromptContext` now renders the whole `ProjectContext` — project
  NAME, instruction, note titles, and memory — while staying backward
  compatible with its old `(instructions, notes)` signature (existing
  tests/callers unchanged).
- `PromptContext.projectContext` (in `ai.ts`) carries the rendered block;
  `buildSystemPrompt` appends it on dashboard/wizard turns AFTER the grounding
  rules and action catalogue. It INFORMS the assistant; it never widens what the
  assistant may DO — the catalogue is still gated by mode and agent scope.
- `api/ai/chat/route.ts`: accepts `projectId` (used only when a NEW conversation
  is created — resuming keeps the conversation's existing project), resolves the
  conversation's project via `getConversationProjectId`, loads and renders the
  context, and **excludes project-scoped turns from the shared answer cache**
  (a project-shaped answer must not be served to a project-less turn, and vice
  versa) — the same reasoning already applied to agent-scoped turns.
- UI: `useAiChat({ projectId })` sends it on new conversations only;
  `ai-workspace.tsx` and the dashboard `ai-chat-hub.tsx` read `?project=<id>`;
  the project page's Conversations card gains a "چت در این پروژه" link.

**Project memory (new surface).** `migrations/0158_ai_project_memory.sql` adds
`ai_project_memory` — short, standing FACTS the assistant carries for a project
("the owner rounds Toman to the nearest thousand", "this campaign targets lapsed
lunch customers"), distinct from human-authored NOTES. It reaches tenant scope
through its parent `ai_projects` row (same shape as `ai_project_notes`, 0111) and
so is automatically covered by the tenant-isolation suite (20/20). It carries a
`source` column ('user' | 'ai') so AI-authored memory (a Part 2 concern) has a
home without a schema change. Bounds enforced server-side
(`PROJECT_MEMORY_CHAR_LIMIT` 500, `PROJECT_MEMORY_MAX_ENTRIES` 50) so the prompt
context it feeds can never grow without limit. Service:
`addMemory`/`listMemory`/`deleteMemory`. Routes:
`api/ai/projects/[id]/memory` (GET/POST) and `.../memory/[memoryId]` (DELETE),
ownership-as-authorization through the parent project (recorded in the
api-guards self-guarding list). UI: a memory panel on the project page.

**Incidental fix.** `createProject` bound one placeholder (`$4`) to both a text
column (`created_by`) and a uuid column (`owner_user_id`), which Postgres
refuses to type-deduce ("inconsistent types deduced for parameter $4"); the path
had no test. Split into two placeholders, behaviour preserved (owner defaults to
the creator).

**Tests.** `ai-projects.test.ts` extended (23/23: the ProjectContext form, the
memory block, the name line, backward compat, bounds constants); new
`integration/ai-project-memory.integration.test.ts` (8/8: create/read,
char-limit + empty + full bounds, delete, and the prompt-context round-trip that
proves a project finally shapes a turn, plus cross-tenant null);
`tenant-isolation` covers 0158; `api-guards` extended. Full suite **4820 unit
tests / 326 files**; `tsc` clean.

**Deferred to Phase F Part 2+:** AI-authored memory through a confirmed action,
project files (link table to the Media Library — waits on Phase G provenance
columns), project tasks, project members, and entity `project_id` FKs on
agents/coworkers/automations. Part 1 deliberately keeps memory human-curated so
the write path and the prompt-context path could land, reviewed, without also
introducing a new catalogue action in the same step.

## 6f (cont.) — Phase F Part 2 DELIVERED (AI-authored project memory)

Part 1 added the `ai_project_memory.source` column ('user' | 'ai') but nothing
wrote 'ai' — memory was human-curated only. Part 2 closes that loop: the
assistant can now propose a standing fact for the CURRENT project, and it
establishes the **ambient project-id injection** pattern that project files and
tasks will reuse.

**A new, project-scoped action.** `project.memory.add` joins the catalogue
(`endpoint: /api/ai/projects/{projectId}/memory`, `alwaysConfirm`, no executor /
category / coworkerOnly — it never runs unattended and is never an MCP write).
It is the first action tagged `projectScoped`: an action addressed by an ambient
id the model must never see. The mechanics that keep it safe:

- **Kept out of the default enum.** `BASE_ACTION_TYPES` (every non-project-scoped
  action) is what `propose_action` offers on a plain dashboard/wizard turn;
  `PROJECT_ACTION_TYPES` (base + project-scoped) is offered only when
  `toolDefinitions`/`buildSystemPrompt` are told the turn is `projectScoped`.
  This mirrors how `coworkerOnly` already keeps waste out of the model's enum.
- **Offered only inside a project, never to an agent.** The chat route sets
  `projectScoped` only when it resolved an `activeProjectId` AND there is no
  scoped custom agent (an agent's action list is its own and a project does not
  widen it).
- **The model never names the id.** The payload hint asks for `content` only;
  the route injects the resolved `activeProjectId` (and `source: "ai"`) into the
  proposal payload after the turn, so the confirm card, the audit and the apply
  call all target this project and no other.
- **Server-side backstop.** `runAgentTurn` refuses a parsed proposal whose
  action is `projectScoped` when the turn was not project-scoped — a hand-crafted
  response naming `project.memory.add` on a project-less turn is dropped, not
  applied, the same shape as the existing agent-allowlist backstop.
- **Apply path unchanged.** `resolveActionEndpoint` fills `{projectId}` from the
  injected payload; a proposal missing the id resolves to null and cannot fire.

**Tests.** `ai.test.ts` +9 (catalogue shape, BASE vs PROJECT enums, offered
only when project-scoped, never to a read-only/scoped agent, prompt-catalogue
naming, endpoint resolution) and the `alwaysConfirm` set now pins three entries;
`ai-service.test.ts` +2 (a project turn accepts `project.memory.add` with no id
in the payload; a non-project turn refuses a crafted one). Full suite **4830
unit tests / 326 files**; `tsc` clean; project-memory + tenant-isolation
integration green.

**Still deferred to Phase F Part 3+:** project files (link table to the Media
Library — waits on Phase G provenance columns), project tasks, project members,
and entity `project_id` FKs on agents/coworkers/automations.

## 6f (cont.) — Phase F Part 3 DELIVERED (project tasks — a lifecycle, not just facts)

Notes and memory are STATELESS (a fact is simply true). Part 3 adds the one
thing a workspace lacks: a unit of work with a LIFECYCLE. A **task** is
"something to do for this project", open until done — two states, no assignee /
due date / priority yet (the same restraint 0111 showed deferring those columns).

**Schema.** Migration `0159_ai_project_tasks.sql` — `ai_project_tasks`
(title, `status` open|done, `source` user|ai, `completed_at` nullable),
CASCADE off ai_projects, RLS `tenant_isolation` via the parent project row
(mirrors 0158/0111), plus a partial index on open tasks (the hot read).

**Service (`ai-projects.ts`).** `addTask` (title trim + `PROJECT_TASK_CHAR_LIMIT`
bound + `PROJECT_TASK_MAX_OPEN` cap counting only OPEN tasks, so completing one
frees a slot and the prompt context can't grow without bound), `listTasks`
(open-first), `setTaskStatus` (stamps/clears `completed_at` via an ownership
join, returns null cross-tenant), `deleteTask`. `ProjectContext.openTasks` and
`buildProjectPromptContext` render only OPEN tasks under
`کارهای باز پروژه (هنوز انجام‌نشده):`; `getProjectPromptContext` loads them in
the same one-pass Promise.all — so completing a task drops it from every future
turn.

**Action + routes.** `project.task.add` — project-scoped, `alwaysConfirm`,
ambient project id injected server-side (model supplies only `title`); rides the
generic chat-route projectScoped injection unchanged. REST:
`/api/ai/projects/[id]/tasks` (GET/POST) and `.../[taskId]` (PATCH toggle,
DELETE). Project page gets a tasks list (toggle/add/delete) above memory.

**Tests.** `ai.test.ts` +3 and the `alwaysConfirm` set now pins **four** entries
(`ar.receipt.record`, `project.memory.add`, `project.task.add`,
`website.post.publish`); `ai-projects.test.ts` +2 (open-task rendering, bounds);
`api-guards.test.ts` covers the two new routes; new
`ai-project-tasks.integration.test.ts` (10 tests) proves the round-trip
open-task → prompt-context → complete → drops-out, plus bounds and cross-tenant
null. Full suite **4837 unit tests / 326 files**; `tsc` clean; task +
tenant-isolation integration green. Commit `503dca9`.

**Still deferred to Phase F Part 4+:** project files (Media Library link — waits
on Phase G), project members, and entity `project_id` FKs on
agents/coworkers/automations.

## 6f (cont.) — Phase F Part 4 DELIVERED (a project's conversation list, scoped in SQL)

`listConversationsByProject` (ai-conversations.ts) was written at Phase 35 Wave 3
and never called — the **last** piece of the projects-are-workspaces dead code
§1.5 named. The project page instead pulled the caller's most recent 50
conversations across ALL projects and filtered client-side by `projectId`, so a
project with more threads than that page limit silently lost its older ones.

- `/api/ai/conversations` now accepts `?project=<id>`, routing to
  `listConversationsByProject` (ownership-scoped in SQL, same ownership rule as
  the unfiltered list) instead of fetch-then-filter.
- The project page requests `?project=<id>&limit=100` and drops the client
  filter.
- `ai-conversations.integration.test.ts` +2 (only the caller's own threads for
  that project, newest-active first — not other projects, not project-less
  threads, not another member's; and the limit is honoured). 6/6 in that file.

Only `getConversationProjectId` and `buildProjectPromptContext` remained live
from that Wave; both are wired (Part 1). **No Phase-35 project dead code
remains.** Commit `ef9be91`.

**Still deferred to Phase F Part 5+:** project files (Media Library link — waits
on Phase G provenance columns), project members, and entity `project_id` FKs on
agents/coworkers/automations.

## 6f (cont.) — Phase F Part 5 DELIVERED (a project pins a default agent)

Parts 1–4 let a project INFORM a turn (instruction, notes, memory, tasks, its
own thread list). Part 5 lets it SCOPE one — closing the "attached agents" gap
§1.5 named. A project can pin a Phase-D custom agent (0154) as its default, and
every conversation opened in the project runs as that agent (its tone, and only
the actions it may propose) without the caller re-selecting it.

**Safety inherited, not re-invented.** Pinning can only NARROW a turn — an
agent's tool/action allowlists are a validated subset of the catalogue
(ai-custom-agents.ts). A request-level `agentId` still wins over the project
default; a project-scoped turn that runs as an agent does NOT also gain the
project-scoped write actions (an agent's action list is its own — the existing
"`projectScoped` only when there is no agent" rule in the chat route). So it
never widens anyone's authority.

**Schema.** `migrations/0160_ai_project_default_agent.sql` — one nullable column
`ai_projects.default_agent_id` → `ai_custom_agents(id)` **ON DELETE SET NULL**:
deleting or disabling the agent falls back to the full assistant, never orphans
the project. No new table, no default → every existing project behaves exactly
as before.

**Service (`ai-projects.ts`).** `defaultAgentId` on `AiProject` and
`ProjectContext`; `updateProject` validates the pin is a real, ENABLED agent of
this business (else `project_default_agent_not_found`; clearing with null is
always allowed) and threads it through every project SELECT.
`getProjectPromptContext` carries the pin so the chat route resolves the agent
in the same pass it loads the rest.

**Chat route.** In the project-context block, when the project pins an agent and
the request named none, the turn is run as the pinned agent
(`getCustomAgent` + `agentTurnScope`, both already tested) and
`promptContext.agent` is set; `projectScoped` stays false in that case, as
before.

**Routes + UI.** Project PATCH accepts `defaultAgentId`; project GET returns the
pinnable (enabled) agents; the project page's operations card gains an agent
picker ("دستیار کامل" = none) and a read-mode line.

**Tests.** `ai-projects.test.ts` fixtures extended for the new field; new
`ai-project-default-agent.integration.test.ts` (7: pin/read/clear,
omit-preserves-pin, disabled + cross-tenant refused, ON DELETE SET NULL,
ProjectContext carries the pin). Full suite **4837 unit / 326 files**; `tsc`
clean; default-agent + tenant-isolation + project-memory integration green.
Commit `f1cc000`.

**Still deferred to Phase F Part 6+:** project files (Media Library link — waits
on Phase G provenance columns), project members, and `project_id` FKs on
coworkers/automations (agents are now reachable from a project via the pin).

## 6f (cont.) — Phase F CAPSTONE DELIVERED + Phase F CLOSED (project files)

The last deferred Phase F item, unblocked once Phase G pt.1 gave `media_assets`
a `project_id` and pt.2 tagged chat images with it: a project shows its own
files.

- `GET /api/ai/projects/[id]/files` — ownership through the parent project (the
  same shape as notes/memory/tasks), then `listMediaAssets` scoped by business +
  `project_id`. Read-only: files are authored through the chat/media write paths
  and tagged with provenance there.
- Project page: a read-only files panel (image thumbnails / document icons,
  «ساختهٔ دستیار» / «از گفت‌وگو» provenance badges, links to
  `/api/media/[id]/file`). api-guards covers the route. Commit `a24a775`.

**Phase F (Projects as workspaces) is COMPLETE.** A project now: shapes every
turn with its instruction + notes + memory + open tasks (pt.1–3, live prompt
context); owns its conversation list scoped in SQL (pt.4); can pin a default
agent that scopes those turns (pt.5); and holds its own files (capstone). Still
genuinely out of scope for later phases (not blocking): project members, and
`project_id` FKs on coworkers/automations.

## 6g. Phase G — Parts 1–2 DELIVERED (media persistence: the Part 21 gap)

The audit named it in §1.6: AI chat attachments were deliberately non-persistent
(`ai-attachment.ts`: "nothing here touches a table or object storage"), and
`media_assets` had no provenance columns, so a receipt pasted into chat or an
image the assistant made vanished when the turn ended.

**Part 1 — provenance vocabulary (`migrations/0161`).** `media_assets` gains
`source` ('upload'|'ai_attachment'|'ai_generated', CHECK-pinned),
`created_by_ai`, `conversation_id` → ai_conversations and `project_id` →
ai_projects, both **ON DELETE SET NULL** (a file outlives the thread/project that
made it). Partial indexes on the two workspace reads. Every column is
backfill-safe (existing assets stay "human upload, no workspace"). No RLS change
— media_assets is already tenant-isolated (0149). `media-service`:
`MediaAssetRecord` + `storeMediaAsset` carry provenance (`createdByAi` derived
from `source` — an ai_attachment is the user's own file, only ai_generated is
AI-authored); `listMediaAssets` gains `conversationId`/`projectId` filters.
Commit `bfbcf5c`.

**Part 2 — the write path (`ai-media-persist.ts`).** Pure `decodeImageDataUrl`
(validates + decodes a base64 image data URL, fail-closed on MIME/byte-signature
mismatch — a script mislabeled as PNG is refused) + `chatAttachmentFileName`;
and best-effort `persistChatImageAttachments` (reads media config, stores each
valid image with `source='ai_attachment'` + conversation/project, never throws).
PDFs are not stored — their value is the extracted text, not a document-library
entry per upload. The chat route fires it non-blocking after the turn's
conversation + project resolve (dashboard/wizard only). Commit `7b7d0aa`.

**Tests.** `ai-media-persist.test.ts` (10, pure decode + filename);
media-library integration +8 (provenance defaults, ai_attachment/ai_generated,
conversation/project filters, ON DELETE SET NULL keeps the asset, and the
persist round-trip incl. skipping a same-turn PDF, skipping when storage is off,
refusing a mislabeled image). Full suite **4848 unit / 327 files**; `tsc` clean.

**Still to do in Phase G:** persist AI-*generated* images (needs an image-
generation call site to exist in the chat flow first — auto-tagging/enhance
already persist through the library's own upload path); a media provenance badge
on the main library page. **Deferred, blocked:** Phase H (cache/RAG → LiteLLM)
still requires empirical verification against the deployed
`ghcr.io/berriai/litellm:main-stable` image before any local removal — no prod
access in this environment, so it stays untouched per the standing rule.

## 6h. Phase G Part 3 + M4 remainder — project labels on background entities

**Phase G Part 3 (media provenance badge, `df919d6`).** The main Media Library
page (`dashboard/media/media-manager.tsx`) now shows the provenance the columns
record: an «ساختهٔ دستیار» / «از گفت‌وگو» badge on AI-originated assets, using the
`neutral` StatusBadge tone. The project files panel already carried the same
badges (Phase F capstone); this brings the parity to the library's own view.

**M4 remainder — `project_id` on ai_automations and ai_coworker_jobs (`0162`).**
The migration map (§5, M4) named "entity project_id FKs on
agents/coworkers/automations" as part of Projects owning long-running context.
Phase F already gave a project its instruction/notes/memory/tasks, its
conversation list, a pinned default agent, and its files. This closes the last
two: the scheduled/event **coworker jobs** (0100) and the WHEN/IF/THEN
**automations** (0155) can now belong to a project.

- **Schema (`migrations/0162`).** Both tables gain a nullable `project_id`
  → `ai_projects(id)` **ON DELETE SET NULL** — identical to the media-library
  shape (0161): archiving/deleting a project never deletes the rule that
  referenced it, the rule simply loses its project label. A partial (non-null)
  index on each serves the "the automations/jobs in this project" read.
  Backfill-safe: every existing row keeps NULL (a business-wide rule). No RLS
  change — both tables already carry `business_id` with a tenant_isolation
  policy covering every column.
- **Ownership check.** New `projectExistsForBusiness(businessId, projectId)` in
  `ai-projects.ts` (cheap existence probe). `createAutomation`/`updateAutomation`
  and the coworker `validateForTemplate` refuse a project id that is null-shaped-
  OK but foreign or made-up — `project_not_found` / `coworker_project_not_found`
  — rather than writing a silently-null label. Same reasoning the pinned default
  agent already uses in `updateProject`.
- **Plumbing.** `AutomationInput`/`NormalizedAutomation` + `CoworkerJobInput`
  gain `projectId`; the service `Automation`/`CoworkerJob` records, row types,
  `toX` mappers, `COLUMNS`/`JOB_COLUMNS`, and every INSERT/UPDATE carry it. The
  dashboard and v1 API routes pass their bodies through unchanged, so the field
  flows without route edits (validation lives in the service, where the tenant
  scope is).
- **Tests.** `ai-coworker.test.ts` fixture carries `projectId: null`; both
  integration suites gain a project-scoping case (label with an owned project
  sticks; a foreign project id is refused with the right error; deleting the
  project SET-NULLs the label but keeps the entity). Full suite **4848 unit /
  327 files**; AI automations + coworker integration **27 tests**; `tsc` clean.

**Program status after this turn.** Phases B–G done (G Parts 1–3 + this M4
remainder). **Phase H** (cache/RAG → LiteLLM) and **Phase J** (drop legacy AI
billing schema, M10) both remain **blocked on production access** and are filed
as GitHub issues **#682** and **#683** with verification checklists — neither is
safe to do from the sandbox under the standing "verify against the deployed
image / prove the cutover before removing" rule. The remaining sandbox-doable
work is **Phase I** (UI redesign / IA, Parts 11/24–28) plus the optional Phase G
AI-generated-image persistence (waits on an image-generation call site in chat).

## 6i. Phase I — Part 1 DELIVERED (the AI Workspace becomes a real IA)

The audit's north star (§4) draws the AI Workspace as one product with several
sections — Chat · Coworkers · Automations · Activity · Projects — over the same
business services. Until now `/ai` was a single ChatGPT-like chat page, and two
whole engines that had already *shipped* were unreachable from the UI: the
coworker inbox/jobs/review (`AiCoworkerPanel`, Phase 32) was mounted by no
route, and the automation engine (Phase D) had its management UI explicitly
deferred to Phase I. Part 1 turns `/ai` into that workspace and closes both
gaps.

- **Framework-free section registry (`(app)/ai/ai-workspace-nav.ts`).** One
  source of truth — keys, labels, help lines, hrefs, named icons, the
  owner/manager role gate, and the active-section rule — read by both the chat
  rail and every management page, the same shape `growth-routes.ts`/`apps.ts`
  use. No `next`, no `db`, no JSX, so the unit tests and the server pages share
  it. **10 unit tests** cover the list shape, the role gate (owner/manager in,
  cashier/accountant out), and active-section resolution (incl. the regression
  that `/ai/coworkers` must not resolve to the chat root just because it starts
  with `/ai`).
- **The chat surface is now *only* the chat (`assistant-route.ts`).**
  `isAssistantSurface` matched every `/ai/*` path, which would have forced the
  new scrolling management pages into the pinned-composer full-height chat
  layout. Tightened to the exact chat root (`/ai`, and `/dashboard` under the
  workspace shell); **4 new unit tests** pin it, including that the three
  management sections are NOT chat surfaces.
- **Shared chrome.** `AiWorkspaceSubnav` (client) maps the registry's named
  icons back to lucide and draws the section strip; `AiWorkspacePage` (server)
  wraps each management page in the `ai_assistant` FeatureLock + shell + strip +
  header, so a new section is a page plus a registry entry and the chrome never
  drifts. The chat rail (`ai-sidebar.tsx`) now links out to the other sections.
- **New reachable sections.** `/ai/coworkers` mounts the shipped-but-orphaned
  `AiCoworkerPanel`; `/ai/activity` mounts `AiAutopilotActivity`; `/ai/automations`
  is a **new** management UI (`automations-manager.tsx`) — list, create
  (trigger · optional single condition · action · approval · optional project
  label), enable/disable, run-now, delete — every write through the same
  `/api/ai/automations` the assistant proposes through, so a rule made by hand
  and one the AI proposes are one object under one guard. Owner-only for the
  `auto` approval mode, mirroring the route's `owner_required`.
- **Verification.** `tsc` clean; full suite **4862 unit / 329 files** (+14/+2).
  Live smoke test against embedded PG (migrations through 0162 applied, seeded
  owner, `ai_assistant` enabled): all four routes return 200 authenticated and
  render the section strip; the automations API round-trips create → list with
  `projectId` present (the Phase F/M4 wiring confirmed end-to-end too).

**Still to do in Phase I** (later parts): fold the workspace sections into the
main navigation/rail as a first-class app (they are reachable from the chat rail
and by URL now, not yet from the global nav); a
Files/Knowledge and Usage section; and the richer structured-card chat polish
(Parts 25–28). Phases **H** (#682) and **J** (#683) remain blocked on production
access.

### Phase I Part 2 — custom-Agents management surface (COMPLETE)

The custom-Agents engine shipped in Phase D (`ai_custom_agents` table,
`ai-custom-agents.ts` / `-service.ts`, `/api/ai/agents` CRUD) had no UI. This
part gives it a first-class workspace section, built the same way as Part 1 so
the chrome never drifts.

- **New section, same registry.** Added an `agents` entry to
  `ai-workspace-nav.ts` (label «ایجنت‌ها», Sparkles icon, owner/manager gate,
  ordered before coworkers) and its key to `AI_WORKSPACE_SECTION_KEYS` /
  `AiWorkspaceIconName`; `ai-workspace-subnav.tsx` maps the icon to lucide
  `SparklesIcon`. So the section strip, active-section rule, and role gate all
  update from one data change. The chat rail (`ai-sidebar.tsx`) links to
  `/ai/agents` too.
- **Management UI.** `agents/agents-manager.tsx` (new client) + `agents/page.tsx`
  (new server, owner/manager gate + `ai_assistant` FeatureLock + `AiWorkspacePage`
  chrome): list, create, edit, enable/disable, delete. The form is
  name + instructions + a tool-allowlist (checkboxes labelled via the new
  `agentToolLabel()`) + an action-allowlist (checkboxes labelled from
  `ACTION_CATALOG`). Every write goes through the same `/api/ai/agents` the
  engine already exposed, so an agent defined by hand and one referenced by the
  chat route (`agentId`) are one object under one `requireManager` guard.
- **Tool labels.** `ai-custom-agents.ts` gained `AGENT_TOOL_LABELS` +
  `agentToolLabel()` covering all ~42 selectable read tools (filled in the ~22
  that were missing, e.g. `get_menu_performance`, `get_void_pattern`,
  `get_stock_valuation`), falling back to the raw name; a unit test enforces that
  every `selectableAgentTools()` entry has a non-raw label.
- **Scope decisions.** (a) The in-chat agent *picker* is deferred to Part 3 (it
  landed there — see below); the management surface lands first. (b) The classic
  workspace-shell flat nav is left as-is (single «دستیار هوشمند» → `/ai`); the
  in-workspace sub-nav + chat rail are the section navigator, so the flat-nav
  disclosure logic was not touched.
- **Verification.** `tsc` clean; full suite **4863 unit / 329 files**. Live smoke
  against embedded PG (migrations through 0162, seeded owner, `ai_assistant`
  enabled): `/ai/agents` returns 200 and renders the section strip; the agents API
  round-trips create (201) → update-with-action (200) → list (correct state) →
  delete (200), and rejects an unknown tool (400). All five workspace routes
  (`/ai`, `/ai/agents`, `/ai/coworkers`, `/ai/automations`, `/ai/activity`) return
  200 authenticated with no render errors.

### Phase I Part 3 — in-chat agent picker (COMPLETE)

Part 2 gave agents a management surface but nothing in chat *selected* one — the
chat route resolved a request-level `agentId` (and a project's pinned default),
but no UI sent one. This part closes that loop: a composer picker so an owner can
run any turn as a chosen agent, changing the lens mid-conversation.

- **One state, both surfaces.** `useAiChat` gains `agentId`/`setAgentId`; the send
  path attaches it through the new pure `agentIdForTurn(mode, agentId)` helper in
  `ai-custom-agents.ts` — which sends the id **only in dashboard mode** (the floor
  and wizard surfaces never run as a custom agent, matching the route's own scope)
  and resolves an empty/whitespace/null pick to the full assistant. So the same
  rule governs the /dashboard/ai hub and the floating launcher, and it is
  unit-tested rather than re-implemented per composer.
- **The picker.** `ai-agent-selector.tsx` (new) sits in the shared `ChatComposer`
  next to the task lens: a rounded pill (Bot icon + name when scoped, Sparkles +
  «دستیار کامل» when not), a dropdown listing the business's **enabled** agents
  plus a «دستیار کامل» reset. It fetches once from the same `/api/ai/agents` the
  management UI uses, renders a `Skeleton` while loading (so the composer row never
  jumps), and hides itself entirely when the business has no enabled agents or the
  surface isn't dashboard mode. Threaded through `chat-composer.tsx`,
  `ai-chat-input.tsx` (launcher) and both callers.
- **The backend was already right.** No route change: a request-level `agentId`
  always wins over a project's pinned default and can only NARROW a turn; a
  disabled/unknown id is refused (`agent_unavailable`, 404) rather than silently
  widening. The picker only ever *narrows* what it sends.
- **Verification.** `tsc` clean; full suite **4866 unit / 329 files** (+3
  `agentIdForTurn` tests). Live smoke against embedded PG: `/ai` renders (200); a
  chat turn scoped to a valid enabled agent passes the agent gate (reaching the
  provider check — the sandbox has no AI provider, so 503, which proves the gate
  admitted it), while an unknown agent id is refused at the gate (404
  `agent_unavailable`); the picker's data source lists only enabled agents.

### Phase I Part 4 — Usage section (COMPLETE)

The north-star IA (§4) names *Usage* as a workspace surface: "what is AI costing
us, and where is it going." The billing was already there — every AI turn writes
an `ai_wallet_settlements` row (migration 0153) with charged/provider Rial, the
origin (`request_type`), model, token counts, cache-hit flag and correlation ids
— but nothing read it back to the business. This part adds that read-only lens,
built the same registry-driven way as the other sections so the chrome never
drifts.

- **Framework-free core (`ai-usage-shared.ts`).** The settled `request_type`
  values and their Persian labels, `normalizeRequestType` (coalesces an unknown/
  legacy type into `other` so a settlement is always counted), the offered
  windows (۷/۳۰/۹۰ روز) with `normalizeWindowDays` (clamps a hand-typed
  `?days=` so the API can't run an unbounded scan), and `cacheHitRate` (guards
  the zero-turn divide). Pure, so the service, the API route, the client and the
  unit tests share one source of truth. **5 unit tests.**
- **Service (`ai-usage-service.ts`).** `getAiUsageSummary(businessId, windowDays)`
  runs one window predicate across three reads — totals, per-origin breakdown,
  recent-turns list — so the cards, the chart and the table always describe the
  exact same window. Wallet balance and outstanding AI debt come from the wallet
  service (the one owner of that truth), not recomputed. Tenant-scoped through
  `query` (RLS + explicit `business_id`). No write path, no provider call.
- **Read-only route (`/api/ai/usage`).** `requireManager`, `?days=` clamped;
  returns `{ summary }`. Registers no mutation and passes the api-guards scan
  automatically (manager guard). The section adds no migration.
- **Section UI.** New `usage` entry in the registry (label «مصرف و هزینه»,
  `WalletIcon`, owner/manager gate); `usage/page.tsx` + `usage-dashboard.tsx`
  (client): a window switch, four headline cards (spend · turns · cache-hit rate
  · balance/debt), a per-origin breakdown with proportional bars, and a recent-
  turns table (origin · model · tokens · cost · pricing tone · time). The debt
  line is the same affordability backstop the pre-request gate enforces, surfaced
  rather than hidden. Renders `LoadingSkeleton` (loading-coverage) and composes
  `cardClass` (design-lint). Linked from the sub-nav strip and the chat rail.
- **Verification.** `tsc` clean; full unit suite **4872 / 330 files**; a new DB
  integration test (`integration/ai-usage.integration.test.ts`, **6 tests**)
  proves totals, richest-first breakdown, newest-first recent turns, the trailing
  window, unknown-type coalescing, and tenant isolation against a real database.
  Live smoke against embedded PG (four seeded settlements): `/ai/usage` renders
  (200); `GET /api/ai/usage?days=30` returns the right totals/breakdown/recent
  turns, and `?days=999` clamps to 7; all six workspace routes return 200
  authenticated with no render errors.

### Phase I Part 5 — Knowledge section (COMPLETE)

The north-star IA (§4) names *Files/Knowledge* as a workspace surface. The
retrieval engine was already there — the assistant recalls over a business's own
slow-moving text via pgvector embeddings (`ai_embeddings`, migration 0113;
menu/item descriptions, item/customer names, project notes, help/policy/
procedure), and numbers are deliberately NEVER embedded (they stay live behind
tools) — but nothing made that index visible to the business. This part adds the
Knowledge section: what the assistant can recall, by kind, whether retrieval
infra is even available, and a manual reindex. Built the same registry-driven
way as the other sections.

- **Framework-free core (`ai-knowledge-shared.ts`).** The embeddable-kind Persian
  labels + hints, `knowledgeKind` (resolves a stored kind, rejecting the
  numbers-bearing kinds that are never embeddable), `knowledgeKindLabel`
  (raw-name fallback), and the `AiKnowledgeStatus`/`AiKnowledgeKindCount` shapes.
  Pure, shared by the service, route, client and tests. **3 unit tests.**
- **Service (`ai-knowledge-service.ts`).** `getAiKnowledgeStatus(businessId,
  aiConfigured)` reads `ai_embeddings` grouped by kind into a per-kind breakdown
  (every embeddable kind present, count 0 when empty), a total, and the latest
  index time. Gated by `isRetrievalAvailable()`: when pgvector is absent it
  returns a truthful `retrievalAvailable:false` empty state and touches no table
  (RAG is optional infra — a café desktop may not have the extension at all).
  An unknown/legacy kind is dropped rather than shown. **3 unit tests** (mocked
  db) cover the unavailable path, the folded/totalled available path, and
  unknown-kind coalescing.
- **Read-only route (`/api/ai/knowledge`).** `requireManager`, resolves the AI
  config to report `aiConfigured`, returns `{ status }`. The manual reindex
  reuses the existing `/api/ai/rag/reindex` (the same bounded tick the platform
  schedules) — no new mutation path. The section adds no migration.
- **Section UI.** New `knowledge` registry entry (label «دانش دستیار»,
  `LibraryBigIcon`, owner/manager gate); `knowledge/page.tsx` +
  `knowledge-manager.tsx` (client): a retrieval-unavailable banner when pgvector
  is absent, a headline card (total chunks + last-indexed + «به‌روزرسانی نمایه»
  button, disabled when infra/AI is unavailable), a per-kind breakdown with
  proportional bars, and an explicit note that numbers are never embedded and are
  always read live through tools. Renders `LoadingSkeleton`, composes `cardClass`,
  no `animate-spin` (busy label instead). Linked from the sub-nav strip and chat
  rail.
- **Verification.** `tsc` clean; full unit suite **4879 / 332 files**. Live smoke
  against embedded PG (which has NO pgvector, exercising the real
  retrieval-unavailable path): `/ai/knowledge` renders (200); `GET
  /api/ai/knowledge` returns `retrievalAvailable:false`, `aiConfigured:false`,
  7 kinds listed at 0; all seven workspace routes return 200 authenticated with
  no render errors.

### Phase I — global-nav first-class integration

The Phase I section work (Parts 1–5) gave the AI Workspace its own shell and
sub-nav under `/ai`, but the workspace was still reachable only from inside
`/ai` and by typing the address bar. In the workspace shell the flat business
nav deliberately drops the `ai` module (`item.module !== "ai"`) — the AI
Workspace is a *product launched from the rail*, like Growth, not a page of the
accounting suite — but no rail launcher had ever replaced that dropped entry.
The engines and the shell existed; the front door did not.

- **The fix.** One data entry: an `ai` launcher in `WORKSPACE_APP_LAUNCHERS`
  (`dashboard-sidebar.tsx`), label «دستیار هوشمند», `SparklesIcon`, `hrefs:
  ["/ai"]`. It mirrors the existing non-app `connections` launcher — `ai` is not
  an `AppKey` (its module is unassigned in `apps.ts`, so it is never gated or
  badged by app availability), so the key union carries it explicitly. The
  launcher resolves its href by matching `/ai` against the flat nav's hrefs, and
  the `دستیار هوشمند` door survives there because `ai_assistant` is a lockable
  feature (a business without it sees the launcher and the FeatureLock page, not
  a dead end). No new route, no migration, no change to the sub-nav or sections.
- **Regression test.** `workspace-rail-ai-launcher.test.ts` greps the two source
  files (the source-of-truth approach `app-shell-nav-doors.test.ts` uses, so it
  never imports the DB-backed component): the launcher lists `key: "ai"` with
  `hrefs: ["/ai"]`, and the flat nav still carries `href: "/ai"` for it to
  resolve against. If either half ever drifts, the workspace vanishes from the
  rail and this fails.
- **Verification.** `tsc` clean; full unit suite **4881 tests / 333 files**
  (+2 / +1 file). Live smoke against embedded PG: authenticated `/dashboard`
  renders the rail with «دستیار هوشمند» as the first «برنامه‌ها» launcher (href
  `/ai`), ahead of حسابداری; all seven `/ai/*` routes return 200.

## 6j. Phase J — DELIVERED (drop legacy AI billing schema + code, M10)

Phase B's wallet cutover (migration 0153) replaced the Phase 18 AI credit
system with debits against the canonical `business_wallets` from LiteLLM's real
reported cost. 0153 was additive by design — it kept the legacy tables readable
so the cutover could be reconciled in production before anything was destroyed
(migration map row **M10** gated the drop on "wallet cutover proven"). With that
sign-off given, Phase J retires the legacy schema and its now-dead code.

- **Destructive migration 0164.** Drops `ai_top_up_requests`,
  `ai_credit_ledger`, `ai_credit_packages`, `ai_business_billing`,
  `ai_subscription_plans` (from 0039). A DB-level audit first confirmed all five
  had **zero rows**, **no inbound foreign keys from any surviving table** (the
  only FKs point among the five themselves), and **no dependent views**. CASCADE
  resolves the intra-group FKs. Never dropped in the same step as its
  replacement — the wallet arrived 11 migrations earlier (0153).
- **Dead code removed.** `src/lib/ai-billing-service.ts` is deleted in full:
  `reserveAiTurn` / `cancelAiTurnReservation` / the legacy `settleAiTurn`,
  `getAiBusinessBilling`, `listRecentAiLedger`, `createAiTopUpRequest`,
  `grantAiCredits`, `assignAiSubscription`, `runAiSubscriptionRenewalTick`,
  `listAiSubscriptionPlans` / `saveAiSubscriptionPlan`,
  `listPlatformAiBusinesses` / `listPlatformAiTopUpRequests` /
  `reviewAiTopUpRequest` / `listPlatformAiCosting`, and the
  `AiInsufficientCreditError` / `AiTopUpStateError` classes — all verified to
  have no live callers on the merged tree (the live `settleAiTurn` callers
  import the wallet-based one from `ai-wallet-billing.ts`). The single still-live
  export, the `AiGatewayTurnPricing` **type**, was relocated to `ai-gateway.ts`
  (the framework-free gateway pricing shapes) and `ai-gateway-service.ts` now
  imports it from there.
- **Renewal tick removed.** `server.ts` no longer schedules the Phase 18 AI
  subscription renewal tick (it fed the dropped `ai_business_billing`).
- **Housekeeping.** `ai_credit_packages` / `ai_subscription_plans` removed from
  `EXEMPT_TABLES`; stale doc comments in `tenant-tables.ts` and
  `messaging-billing.ts` refreshed to describe the retired service in the past
  tense.
- **Verification.** `tsc` clean; full unit suite **5073 tests / 352 files**;
  integration — tenant-isolation, migrations (fresh apply + the 0011→latest
  upgrade path), MCP connector, and both wallet-billing suites — **72/72**; a
  fresh database applies all **200** migrations and re-migrate is a no-op;
  production build succeeds.

> **Note on the CI repair done alongside Phase J.** The branch was 119 commits
> behind `main`, so the PR's checks ran `main`'s newer `test.yml` and failed on
> three jobs. Merging `main` in fixed the *design-checks* job (it runs
> `primitive-lint.test.ts`, a file the stale branch lacked) and surfaced two
> more real issues that were fixed in the same pass: the AI Usage dashboard now
> composes the approved `KpiCard`/`DataTable` primitives `primitive-lint` began
> enforcing, and migration **0163** restores `'mcp'` to
> `ai_action_audit_source_check` — this program's 0155 had redefined that
> constraint on a pre-MCP base and silently dropped `'mcp'`, breaking every
> MCP-authorised write once main's connector merged in.
