# Issue #812 — the AI subsystem, after the rebuild

Read this before touching anything under `src/lib/ai-*`, `src/app/api/ai/**` or
`src/app/platform/ai/**`. It is the map of who owns what, and almost every bug
this issue fixed came from one side of a boundary doing the other side's job.

## The one sentence

A tenant member asks a question in their current business/branch/app/project
context; the assistant resolves a prompt from the Superadmin's published
layers, narrows the tool catalogue to what that member may actually do, calls
the configured LiteLLM alias, runs the tool loop, and either answers or
proposes a mutation — which is re-checked against current authority and needs a
human's yes before it writes. Every turn is settled once, with attribution.

## Ownership — the boundary that decides everything else

| The LiteLLM/AI-infrastructure layer owns | The application owns |
| --- | --- |
| Model and provider deployments | Tenant / business identity and isolation metadata |
| Routing, fallbacks, retries | App / project / business context |
| Budgets, TPS/RPS, rate limits | User authorization |
| The shared semantic cache | Business tools and action execution |
| Embeddings and RAG infrastructure | Prompt and agent config, **exposed from Superadmin** |
| Model aliases (`pos-auto`, `pos-instant`, `pos-deep-research`) | Tenant memory as a product feature |
| Provider cost reporting | Deep Research orchestration |
| Virtual tenant keys | Usage and audit attribution |
| | Business billing and credit settlement |
| | Human confirmation for manual writes |

Two consequences worth stating plainly, because they are the reason the issue
exists:

1. **The application runs no semantic answer cache of its own** and **no
   pgvector RAG stack of its own**. `src/lib/ai-answer-cache.ts`, `ai-rag.ts`,
   `ai-rag-indexer.ts`, `ai-embeddings.ts`, `ai-knowledge-service.ts` and the
   `ai_answer_cache` / `ai_embeddings` tables are gone (migrations 0204). A
   second cache the app owns is a second source of truth about what a tenant was
   told, and it is the one nobody invalidates.
2. **There is exactly one prompt resolver.** `src/lib/ai-prompt-resolver.ts` is
   the live source of truth. The old fragment engine (`ai-prompts.ts`,
   `PROMPT_FRAGMENTS`, `assembleFromFragments`) is deleted. Two prompt builders
   is a prompt you cannot predict.

## Runtime modes — three, and only three

`auto`, `instant`, `deep_research`. The vocabulary lives in
`src/lib/ai-runtime-modes-shared.ts`, which is **database-free on purpose**:
client components import that file, and importing `ai-runtime-modes.ts` from a
`"use client"` file reaches `src/lib/db.ts` and fails
`client-bundle-boundary.test.ts`. A stored `thinking` value normalizes to
`auto` rather than silently doing nothing.

Each mode names a LiteLLM alias in `platform_ai_modes` (seeded by migration
0203, editable at `/platform/ai/modes`). A blank alias means "the gateway's
default chat model", which is what a deployment that has not set aliases up yet
keeps doing — so turning the console on is additive. What the app decides about
routing stops there: deployments, fallbacks, retries, budgets and TPS/RPS are
LiteLLM's, and there is deliberately no control in the console that would
suggest otherwise.

## The prompt resolver's composition order

One order, and it is not negotiable, because a layer in the wrong place changes
what the model was told:

```
platform base / system policy
  → runtime mode prompt (auto | instant | deep_research)
    → system Agent prompt (when one is invoked)
      → business-type fragment
        → app-context fragments
          → tenant durable memory
            → app memory
              → project standing instruction
                → project durable memory
                  → current task / user turn context
                    → runtime tool/action catalogue
```

Layers are versioned per scope in `ai_prompt_versions`. Publishing one version
retires the previously published one **in the same transaction**, so the partial
unique index on `scope_key WHERE state = 'published'` forces the order and a
scope never has none, or two. A scope with nothing published resolves to the
code default — the runtime can never end up with an empty system prompt.
Rollback republishes an older version rather than deleting anything, so what was
live stays readable.

## Memory — five layers, and what "deleted" means

Platform (Superadmin only) → tenant/business → app → project → conversation /
temporary. `src/lib/ai-memory.ts` holds the read path and
`renderMemoryForPrompt`; `POST /api/ai/memory` takes `ai.manage`. Two rules:

- A deleted memory entry stops influencing future turns. The render filters on
  the layer's current rows, not on anything cached.
- No secrets or tokens. `validateMemoryInput` refuses credential-shaped content
  (`sk-…`, `pk-…`, `rk-…`, a bare `bearer eyJ…`). This is a refusal, not a
  redaction: a stored token is a token you now have to rotate.

## System agents — Superadmin only

`src/lib/ai-system-agents.ts` is the only place an agent exists. There is no
tenant agent builder, no `/api/ai/agents`, no `AiAgentSelector` and no
`ai_projects.default_agent_id` (migration 0206 drops the table and the column).
A business meets an agent exclusively through an assignment made at
`/platform/ai/agents`, and `eligibleAgentCards` **re-checks the assignment's
requirements on every read**, so a revoked permission or a disabled app takes a
card away immediately rather than at next deploy.

### The allowlist intersection

Every allowlist can only narrow. The runtime intersects, in this order:

```
platform tool catalogue
  ∩ agent allowlist
    ∩ current tenant/app availability
      ∩ current user's effective permissions
        ∩ current location/project scope
```

The member's own permissions are the **last** term, so the worst a badly
configured agent can do is be useless. Unknown tool or action IDs **fail
closed** — an unknown name is refused, never ignored, because silently dropping
it would let a caller think a turn was scoped when it was not.

This is also why there is no `ai.widgets.manage`: a workspace widget is a saved
prompt that runs with its creator's *own* permissions, and `ai-widgets.ts`
refuses any widget whose `requiredPermissions` the caller does not already hold
(`widget_permission_widening`). That intersection holds per widget rather than
per member and fails closed on an unknown permission — a stronger boundary than
a dedicated key.

## Deep Research — the isolated workflow

`src/lib/ai-research.ts` + `ai-research-shared.ts`. Superadmin controls every
cap at `/platform/ai/research`: enabled/disabled, the alias, max context bytes,
max rounds, environment TTL, max spend per run, minimum data readiness, and the
external-web policy. A tenant cannot change any of them, and the chat route
refuses a `deep_research` turn outright while `enabled` is false (409
`mode_unavailable`).

The run is a separate cost-approved workflow, not a chat mode with a bigger
budget:

1. `POST /api/ai/research` creates a run in `awaiting_approval` carrying the
   **estimated maximum cost**, computed server-side from the platform's own
   caps — never read from the request.
2. `POST /api/ai/research/[id]/approve` is the human approval. It re-reads the
   run's business id before the environment opens, gates the wallet, and only
   then runs.
3. The run is bounded: a round cap, a spend cap checked after every round, and
   an environment TTL. When it stops — at the cap or otherwise — the cost is
   settled exactly once through the same `settleAiTurn` every other turn uses.
4. A second approval for an already-approved run is refused. Re-approving is
   how a run spends twice.

**Deep Research is a bigger budget, not a wider permission.** The approve route
filters the tool catalogue through `filterAiToolsByPermissions` with the
approver's own effective set — the same helper chat uses. It also takes
`ai.use` explicitly, because `getSession()` only proves the caller belongs to
the business.

## Knowledge — tenant-isolated, and infrastructure-owned

`src/lib/ai-knowledge-gateway.ts` reaches the managed, tenant-isolated
knowledge integration through the configured LiteLLM layer. The tenant is
stated **twice on every request** — as a path segment and in the metadata — so a
gateway reading either one alone still lands in the right namespace. A network
failure or a 5xx degrades to **empty**, never to a partial or cached answer: a
stale retrieval is a confidently wrong answer.

There is no tenant knowledge/reindex surface. Knowledge is infrastructure, not
something a tenant feeds.

## Settlement — once, with attribution

`src/lib/ai-wallet-billing.ts` is the single settlement point.
`gateAiTurn(businessId, config)` before, `settleAiTurn({...})` after, idempotent
per `requestId` (the unique index on `(business_id, request_id)` is what makes
that true).

- A turn that failed **after** the provider answered still cost money.
  `accruedUsageOf(error)` recovers the partial usage and settles it against the
  same request id, so the ledger is neither short nor double-charged.
- The provider's own cost header wins when present (including a genuine 0 for a
  cached or free response); the platform's token rates are the fallback.
- Every settlement carries the attribution the issue names, as **columns**:
  `runtime_mode`, `system_agent_id`, `suggestion_id`, `research_run_id`,
  `prompt_layers` (migration 0208). Columns rather than metadata keys because
  the usage report groups on them and a typo in a jsonb key is a silent NULL
  group forever.
- `runtime_mode` is **nullable**. A mode is relevant to a chat turn and to
  nothing else; writing `auto` on an OCR call would make the report claim it ran
  on the `auto` model.

## Permissions

| Capability | What it opens |
| --- | --- |
| `ai.use` | The assistant itself: chat, search, running a widget, Deep Research |
| `ai.manage` | Memory, assistant config, autopilot, coworker, vision/OCR surfaces |
| `ai.automations.manage` | The automation engine (create, preview, run) |
| `ai.usage.view` | Reading the business's own AI spend |

Ordinary chat is `ai.use` **plus the underlying domain permissions** — using the
assistant is not administering it. Retired by this issue: `ai.agents.manage`,
`ai.knowledge.manage` (their surfaces are gone) and `ai.widgets.manage` (its
surface is protected by the intersection above). Migration 0207 strips all
three from stored role and override rows; `parseOverrides` filters through
`isPermission`, so a stale grant already degrades to "no override".

**Superadmin endpoints use platform-admin authorization, never a tenant
`settings.manage`.** The control plane changes what *every* business's
assistant does, and a business owner holding it could re-point every other
business's traffic. Reads take `ai.read`, writes take `ai.config.manage`.

`src/lib/ai-permission-matrix.test.ts` pins which guard each route takes.
`api-guards.test.ts` proves a guard exists; that file proves it is the right
one.

## Unattended writes recheck current authority

`src/lib/ai-unattended-authority.ts`. An `auto` automation or a scheduled agent
that writes re-resolves the acting member's **current** permissions, the
business's current state and the target row's current state immediately before
executing — not the state captured when the job was queued. If anything moved,
the write is held as a proposal instead of forced through.

Manual writes still require confirmation and an apply-time authorization check
(`/api/ai/proposals/apply` re-checks the underlying domain permission per
action). Nothing about a bigger automation surface widens that.

## Money follows the tenant's preference

Storage is always Rial. Display follows the business's own preference
(`business.prefs.currencyDisplay`, `location_id IS NULL`), resolved by
`resolveBusinessMoneyUnit` in `src/lib/ai-money-unit.ts`. The widget run route
is wired for it; a business that chose Toman is shown Toman.

## Scrolling and reply status

- `use-sticky-scroll.ts` — the view follows new output only when the reader is
  already at the bottom. Scrolling up to read older content is never fought.
- A partial or cancelled reply is **visibly marked** (`ai-chat-hub.tsx`,
  `chat-bubble.tsx`), not silently shown as if it were complete. A truncated
  answer that looks finished is worse than an error.

## Where things live

| Path | What |
| --- | --- |
| `src/lib/ai-prompt-resolver.ts` | The one resolver: versions, publish, rollback, layer composition |
| `src/lib/ai-prompt-store.ts` | The version store behind it |
| `src/lib/ai-system-agents.ts` | System-agent CRUD, publish, retire, assignments, eligible cards |
| `src/lib/ai-runtime-modes.ts` | Mode reads (DB) |
| `src/lib/ai-runtime-modes-shared.ts` | Mode vocabulary — **the DB-free file client components import** |
| `src/lib/ai-memory.ts` | Layered memory read/render/validate |
| `src/lib/ai-knowledge-gateway.ts` | Tenant-isolated managed knowledge |
| `src/lib/ai-research.ts` / `-shared.ts` | Deep Research orchestration / DB-free vocabulary |
| `src/lib/ai-control-plane.ts` | The Superadmin's mode and research writes |
| `src/lib/ai-wallet-billing.ts` | The single settlement point |
| `src/lib/ai-unattended-authority.ts` | Current-authority recheck for unattended writes |
| `src/lib/ai-scheduled-jobs.ts` | The proactive tick's scheduled-job switches (not "agents") |
| `src/app/api/ai/**` | Tenant AI surface |
| `src/app/api/platform/ai/**` | Superadmin control plane |
| `src/app/platform/ai/**` | Superadmin console |
| `src/lib/ai-permission-matrix.test.ts` | The guard matrix, asserted |
| `src/lib/ai-attribution.test.ts` | The attribution contract, asserted |

## A note on the word "agent"

The issue reclaimed it. Before #812 it meant two things: a tenant-built
assistant (deletable, pinnable to a project) and the Superadmin's system agents.
Two things called Agent, one of which a business could switch on and off, is how
a control-plane boundary gets argued away.

So: **Agent** now means only a Superadmin-built, versioned system agent. The
proactive tick's background jobs are **scheduled jobs**
(`src/lib/ai-scheduled-jobs.ts`); their per-job opt-in switches live in the
existing `ai_agent_settings` table, whose name is a fact about the past and not
worth a data migration. If you find yourself writing "agent" for anything a
tenant configures, you have found a bug.
