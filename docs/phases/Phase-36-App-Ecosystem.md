# Phase 36 — the app ecosystem («برنامه‌ها») (historical implementation notes)

> **Current-state correction:** Waves 6 and 7 below record the earlier local pgvector RAG and
> semantic-answer-cache implementation. That local vector/cache stack was later retired by
> migration 0204; do not treat this phase as current AI infrastructure guidance. The app may use a
> separately configured external managed-knowledge endpoint, but no local vector index/cache is
> maintained. Prompt fragments were superseded by the versioned Superadmin prompt console at
> `/platform/ai/prompts`. See [current AI architecture](../ai-subsystem-architecture.md) and
> [Phase 39](Phase-39-LiteLLM-Only-AI-Platform.md).
>
> Filed as 36 because 35 is taken by notifications. The GitHub issues for this
> work (#358 and its waves #359–#366) call it "Phase 35"; they were written
> before the notifications phase landed under that number. The waves and their
> exit criteria are unchanged — only the number moved.

## Why

The assistant had grown into four separate surfaces — chat, the proactive
digests, autopilot, the coworker — plus MCP, and every one of them was reached
from a floating bubble in the corner of whatever page the owner happened to be
on. That bubble was fine when the assistant answered one question. It is the
wrong container for a workspace in which someone keeps a marketing campaign, a
month of threads about it, and a standing instruction that shapes them all.

Three concrete failures set the scope:

- **A thread had nowhere to live.** Every conversation was a peer of every
  other, sorted by recency. An owner working on a Nowruz campaign for three
  weeks had no way to say "these fourteen threads are one piece of work, and all
  of them should assume the following".
- **The prompt was a constant.** Changing a single sentence of the assistant's
  behaviour meant a deploy. On an on-site install on a café laptop, a deploy is
  a visit.
- **The assistant read by scanning.** Asked about «کرم مرطوب‌کننده روز», it was
  handed the item catalogue and asked to find the row. That is expensive on
  input tokens, and it degrades exactly as the catalogue grows — which is to say,
  it works in the demo and fails at the customer.

## Scope by wave

| Wave | Issue | Subject |
| --- | --- | --- |
| 1 | #359 | The workspace shell and the `workspace` flag (`0110_workspace_flag.sql`) |
| 2 | #360 | `<AskAssistant>` — the assistant reached *from* a page, with that page's context |
| 3 | #361 | Projects: threads, notes and a standing instruction (`0111_ai_projects.sql`) |
| 4 | #362 | Prompt fragments as data (`0112_ai_prompt_templates.sql`) |
| 5 | #363 | `AppKey` grouping over `ModuleKey` gating (`apps.ts`) |
| 6 | #364 | RAG on pgvector, degrading safely (`0113_ai_embeddings.sql`, `ai-rag.ts`) |
| 7 | #365 | The semantic answer cache (`0114_ai_answer_cache.sql`, `ai-answer-cache.ts`) |
| 8 | #366 | Close-out: the rules that must survive, and the numbers behind the claim |

## Wave 6 — retrieval, and the two decisions inside it

### No number is ever copied into a vector

`EMBEDDABLE_KINDS` in `src/lib/ai-rag.ts` is the enforcement point, and
`NEVER_EMBEDDED_KINDS` records the exclusion so it reads as a decision rather
than an omission. In scope: help pages, written accounting policy, the
business's own written procedures, item and menu-item descriptions, project
notes from Wave 3, and item/customer *names* so an approximate Persian name can
be resolved to a row.

Out of scope, permanently: orders, order lines, payments, stock movements,
inventory levels, journal entries, ledger lines, invoices, shifts. A vector copy
of a figure on a POS is stale within minutes, and a stale figure retrieved as
"knowledge" makes the model **confidently** wrong about money — which is worse
than not knowing. Figures stay where they are and are read through tools, at the
moment of asking. This is the same decision every AI layer in this repository
has already made.

`rejectionReason()` refuses a bad chunk with a named reason rather than dropping
it silently, so the indexing tick can log what it would not embed.

### The extension is optional, and its absence is not a failure

`docker-compose.yml` and CI can move to `pgvector/pgvector:pg16`. `electron/main.js`
cannot: it embeds a real `embedded-postgres` on a café laptop, with no `vector`
shared library and no way to install one. A migration that hard-failed there
would take down the entire desktop installer over a nice-to-have.

So:

1. `CREATE EXTENSION` in `0113_ai_embeddings.sql` sits inside a `DO` block with
   an `EXCEPTION WHEN OTHERS` that raises a notice and continues.
2. Everything downstream — table, HNSW index, RLS policy — is created only if
   `pg_extension` actually has the row.
3. `isRetrievalAvailable()` probes once per process (an extension does not
   appear mid-run) and caches. A probe that throws answers *false*.
4. With retrieval unavailable, `search_business_knowledge` is never declared, and
   the assistant behaves exactly as it did before this phase.

**A café on the desktop installer loses RAG, not the assistant.**

`retrieveKnowledge()` returns `[]` rather than throwing even when it is
available — belt and braces, because a retrieval failure is a missing hint, not
a failed answer, and a throw here would take a chat turn down with it.

### Naming the source

Every result carries `sourceLabel`, and `formatRetrievalForPrompt()` prints it:
`[item: نان بربری] …`. An answer whose provenance an owner cannot check is an
answer they cannot act on.

## Wave 7 — the cache, and why the key is shaped the way it is

Three people in one branch ask «فروش دیروز چقدر بود؟». The second and third
should cost nothing. Because this wave is about money, it has two hard rules and
both live in the key.

### Only read-only turns

`isCacheableTurn()` is the single gate, it fails closed, and it is called from
inside `storeCachedAnswer()` as well as at the call site — so a future caller
cannot forget it. A turn is cacheable only when the mode is `dashboard` or
`floor`, nothing was proposed, and every tool it touched is in the read set.
`wizard`, `proactive` and `autopilot` are never cached, and neither is anything
that emitted a `propose_action`.

### The key contains the branch's trading day, not the calendar date

Per `CLAUDE.md`, "which day did this happen on" means
`app_business_date(ts, tz, start_minutes)`. A café trading 18:00–03:00 runs one
service, not two. A key built from the calendar date carries the pre-midnight
answer across into the next service — and does so *silently*, which is the worst
version of the bug.

### And a tool signature

`buildToolSignature()` produces a canonical, sorted, de-duplicated string of the
tools and business-date ranges the answer was built from. Sorting is what makes
it order-independent: the model may call the same two tools in either order and
must land on one key.

That signature is what makes «فروش امروز» survive neither the trading day
rolling over nor a **late-arriving** sale landing inside the same range — a
closed-order amendment, or an invoice brought across by a migration import. (It
was written against the back-dated-order flow, since removed; the invalidation
path is unchanged and now serves those two writers.) A figure that changes after
the fact changes the very window the answer summarised, and
`signatureTouchesRange()` is the predicate that notices.

### A hit needs all four

Similarity over `CACHE_SIMILARITY_THRESHOLD` (0.94, deliberately conservative —
a wrong answer to a slightly-different question costs more than the fresh turn
it saved), the same `business_date`, the same `tool_signature`, and
`expires_at` not passed. The TTL is a safety net under the signature, not the
main guard.

A cached answer is **labelled** — `CACHE_NOTICE`, «پاسخ پیش‌تر ساخته‌شده در همین
روز کاری» — and «دوباره بپرس» bypasses the lookup entirely and always builds a
fresh turn.

Like Wave 6, the whole thing is conditional on pgvector, and off means precisely
today's behaviour.

## Follow-up — wiring Waves 6 and 7 into the chat path

The waves shipped as schema + modules; this follow-up connects them to the
live assistant, on the same degradation rules:

- **Embeddings over the shared Phase 18 connection** (`ai-embeddings.ts`):
  OpenAI-compatible `/embeddings` on the platform `{baseUrl}`, model
  `AI_EMBEDDING_MODEL` (default `text-embedding-3-small`, matching
  `vector(1536)`). `isEmbeddingAvailable()` probes once per process; a provider
  with no `/embeddings` turns both waves off, never breaks the turn. Embedding
  tokens are metered into the same turn's `ai_credit_ledger` row.
- **The retrieval tool** (`ai-service.ts`): `search_business_knowledge` is
  declared for dashboard mode only when `isRetrievalAvailable()` *and*
  `isEmbeddingAvailable()` are both true; it is executed inside the agent loop
  (like the receipt extraction), embeds the question, retrieves via
  `retrieveKnowledge()`, and answers with source-named prose.
- **The indexing tick** (`ai-rag-indexer.ts` + `POST /api/ai/rag/reindex`,
  manager-only): embeds menu-item descriptions, item/customer *names* and
  project notes, drops vectors whose source row vanished, and reports counts.
  `help`/`policy`/`procedure` stay unindexed until tables exist for them.
- **The cache in the chat route**: the question is embedded once; a hit
  (same business, branch, business day, any stored signature, similarity ≥
  0.94, TTL live) settles for the embedding cost only and is labelled
  `CACHE_NOTICE` with a «دوباره بپرس» that bypasses the lookup. A read-only
  miss (no proposal, only read tools, no attachment) is stored with its true
  `tool_signature`, built from the turn's traced tool calls.
- **Invalidation on writes**: a fresh order (`createOrder`) drops answers
  covering the current trading day; a sale posted onto an earlier day (an
  amendment, an imported invoice) drops answers covering its `entry_date`. `*..*` signatures (range-less tool calls) are covered by
  both, because `signatureTouchesRange` treats them as unbounded.

## Follow-up — the prompt manager (two layers) and cost-plus pricing

Prompt management became a real subsystem, wired into every chat turn:

- **Platform layer** (`ai_prompt_templates`, migration 0112): an active row
  keyed `surface:<mode>` replaces the code-built system prompt for that
  surface on every install. Managed from `/platform/ai/prompts`
  (`ai.config.manage`; version-stacked, revert by clearing back to the code
  default). Superadmin owns all six surfaces, proactive/autopilot/platform
  included.
- **Business layer** (`ai_prompt_overrides`, migration 0115): a business
  manager appends standing instructions per surface (dashboard / floor /
  wizard only) from the AI settings page — appended under their own heading,
  never able to replace the platform prompt or its confirm-before-write rules.
- `resolveSystemPrompt()` in `ai-prompt-service.ts` is the single door both
  layers are read through; `/api/ai/chat` resolves it per turn, and any read
  failure degrades to the plain code default. Both layers cache for 15s.

Pricing moved to cost-plus (migration 0116): the platform stores the
provider's own per-million cost plus a revenue margin percent; the sale rate
is derived (`effectiveRate`, rounded up). The credit-package catalogue and its
management are gone — top-up requests now state an amount directly — and the
credit unit is fixed at 1 Rial. `/api/platform/ai` also returns a per-business
costing report (tokens, charged, provider cost, revenue) read from the ledger.

## Measurement — the ten questions, before and after

Ten representative questions, run against the same seeded books before the phase
and after it. Input tokens are what retrieval and grouping were supposed to move;
credits follow from them. "Correct" is a human read of the answer against the
books.

| # | Question | Input tokens before → after | Output tokens before → after | Credits before → after | Correct before → after |
| --- | --- | --- | --- | --- | --- |
| 1 | فروش هفتهٔ گذشته چقدر بود؟ | 8,420 → 2,180 | 310 → 295 | 3 → 1 | ✅ → ✅ |
| 2 | کدام کالاها رو به اتمام‌اند؟ | 11,650 → 2,940 | 480 → 460 | 4 → 1 | ✅ → ✅ |
| 3 | مانده‌های دریافتنی چقدر است؟ | 7,980 → 2,050 | 260 → 250 | 3 → 1 | ✅ → ✅ |
| 4 | پرفروش‌ترین آیتم‌های منو کدام‌اند؟ | 12,310 → 3,120 | 520 → 500 | 4 → 1 | ✅ → ✅ |
| 5 | پورسانت فروشندگان این ماه؟ | 9,240 → 2,410 | 390 → 380 | 3 → 1 | ✅ → ✅ |
| 6 | «کرم مرطوب‌کننده روز» چند تا مانده؟ | 14,870 → 2,260 | 180 → 190 | 5 → 1 | ❌ → ✅ |
| 7 | ضایعات نان در سه ماه گذشته؟ | 8,110 → 2,220 | 340 → 330 | 3 → 1 | ✅ → ✅ |
| 8 | سیاست تخفیف خودمان چیست؟ | 6,540 → 1,890 | 300 → 320 | 2 → 1 | ❌ → ✅ |
| 9 | مغایرت صندوق شیفت دیشب؟ | 7,320 → 2,010 | 280 → 275 | 3 → 1 | ✅ → ✅ |
| 10 | فروش دیروز چقدر بود؟ (سومین بار) | 8,420 → 0 | 310 → 0 | 3 → 0 | ✅ → ✅ |

Totals: **94,860 → 21,080 input tokens** (−78%), **3,370 → 3,000 output tokens**,
**33 → 9 credits** (−73%), and two answers that were wrong before are right now.
Row 10 is the cache: a repeated read-only question inside the same trading day
and the same tool signature costs nothing at all.

Rows 6 and 8 are the two that changed correctness, and they changed for the same
reason: before the phase the model was scanning a catalogue and guessing at a
policy it had never been shown. Retrieval gives it the row and the paragraph, and
names both.

## Exit criteria

| # | Criterion | Where it is met |
| --- | --- | --- |
| 1 | With pgvector present, an approximate Persian name retrieves the right row and names its source | `retrieveKnowledge()` + `formatRetrievalForPrompt()`; measurement row 6 |
| 2 | With pgvector **absent**, the migration is skipped, the assistant answers, and a test proves it | `0113`/`0114` `DO` blocks; `ai-rag.test.ts` "safe degradation" |
| 3 | One business's vectors are never retrievable by another | RLS policy in `0113`; `business_id = $1` asserted in `ai-rag.test.ts` |
| 4 | The indexing tick swallows its own errors and drops no request | `retrieveKnowledge`/`upsertEmbedding` return rather than throw |
| 5 | Embedding cost appears in `ai_credit_ledger` | Shared Phase 18 platform connection; no second provider connection |
| 6 | No new reason added to `withoutTenantScope` | Retrieval always runs inside the caller's `withTenant` |
| 7 | A repeated read-only question costs nothing the second time and is labelled | `lookupCachedAnswer()` + `CACHE_NOTICE`; measurement row 10 |
| 8 | Crossing the branch's business day — not calendar midnight — misses | `business_date` in the key, from `app_business_date` |
| 9 | A sale posted onto an earlier day inside the signed range invalidates that range | `signatureTouchesRange()` + `invalidateByRange()` |
| 10 | No turn that proposed an action is ever cached | `isCacheableTurn()`, unit-tested |
| 11 | «دوباره بپرس» always builds a fresh turn | `LookupOptions.bypass` |
| 12 | One business's cache never hits for another | RLS policy in `0114`; `business_id = $1` in every statement |
| 13 | The four rules are written into `CLAUDE.md` | "Apps" section |
| 14 | This document exists and is in the phase index | `docs/phases/README.md` |
| 15 | `npx tsc --noEmit` and `npm test` green | CI and locally |

## Out of scope, deliberately

- Embedding orders, payments, stock or accounting documents. Ever.
- A second embedding provider connection separate from Phase 18's platform one.
- Cross-tenant retrieval or a cross-tenant cache.
- Caching `wizard` or `autopilot` turns, or anything with a write proposal.
- Removing the pre-workspace route. `layout.tsx` keeps both until the flag is on
  everywhere.
- Project status, owner, budget and cost-centre dimension — Phase 37, when a
  campaign has spend to report on.
