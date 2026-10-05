# Issue #812 — AI subsystem rebuild — implementation plan

Working branch: `arena/01a10aea-biza-miz`

Baseline (verified before any change):
- `npx tsc --noEmit` → clean
- `npm test` → 570 files / 7502 tests green

## Phase 1 — security/runtime correctness
- [ ] §14 `stockCount` executor reads canonical `stock_movements` on-hand
- [ ] §16 provider cost from partial/failed/cancelled multi-round calls is not lost
- [ ] §15 tenant currency preference (Rial/Toman) flows through the AI runtime
- [ ] §13 unattended writes recheck current authority immediately before execution
- [ ] §17 conversation loading / stream finalizer races are generation-guarded
- [ ] §18 no forced autoscroll while reading older content
- [ ] §19 partial/cancelled replies are visibly marked

## Phase 2 — remove duplicated local infrastructure
- [ ] §1 application-owned semantic answer cache removed
- [ ] §2 application-owned pgvector RAG/reindex stack removed
- [ ] tenant-isolated managed knowledge integration (LiteLLM/AI infrastructure)

## Phase 3 — Superadmin control plane
- [ ] §7 Auto / Instant / Deep Research runtime modes resolve configurable LiteLLM aliases
- [ ] §8 one live prompt resolver (base → mode → agent → business type → app → memory → task → tools)
- [ ] §5 system-wide Agent builder + versioning
- [ ] §6 Superadmin assigns agents to tenants through suggestion cards

## Phase 4 — tenant-side cleanup
- [ ] §4 tenant Agent Builder / picker / API removed
- [ ] §11 tenant AI management exposes only product-level controls
- [ ] §22 legacy scheduled-agent concepts migrated or removed
- [ ] §23 dead `platform` AgentMode removed

## Phase 5 — Deep Research
- [ ] readiness, explicit cost approval, isolated run/environment, spend cap, TTL, sources, settlement

## Phase 6 — attribution, tests, docs, dead-code sweep
- [ ] §20 per-turn attribution
- [ ] §21 App Focus narrows the live tool catalogue
- [ ] §12 explicit AI API permission matrix
- [ ] §29 tests
- [ ] §31 documentation

---

# Status — complete (2026-10-05)

All six phases are implemented, committed and gated. Commits: `52247f6`
(phase 1 core) → `a949194` (§17/18/19 + tests) → `f3b012d` (phases 2–5) →
`d657229` (phase 3 control plane + phase 4 deletions) → `dd63d8e` (attribution
columns, permission matrix, retired permissions) → `1f1f402` (docs, dead-code
record, final sweep) → `aaa6c5a` (runtime-mode aliases, cross-tenant isolation
proof, secret-shape fix) → `78d2c45` (App Focus narrows the live catalogue) →
`64e4dc2` (prompt-resolver tests found a publish bug; §20 app focus + prompt
versions) → `c8d8018` → `bb10cd9` (Deep Research tests found a spend-cap
overshoot and an unreachable TTL branch) → `fcedc59` (client-chat lifecycle
tests) → `95d8d08` (route-boundary tests; a widget the caller cannot run no
longer spends) → `e174da6` (§14 stock-count ledger, proven against the bug) →
`665a24b` (§29 reopening restores valid metadata).

## The §29 gap audit — closed

§29 names 60-odd cases. Auditing each against the tree, rather than assuming the
issue's own list was covered, found five real gaps and one dead test. Every one
is now closed, and three of them found product defects:

| Gap | What the audit found | Outcome |
| --- | --- | --- |
| Prompt resolver + system agents | **No test file at all.** The resolver is the single source of truth for what the model is told, so a regression there changes every answer and nothing else notices. | `ai-prompt-resolver-agents.integration.test.ts` (14). Found the publish bug above. |
| Deep Research | Zero behavioural tests. | `ai-deep-research.integration.test.ts` (14). Found a spend-cap overshoot and an unreachable TTL branch. |
| Client chat lifecycle | `use-ai-chat.ts`, ~780 lines implementing §17/18/19, had no test. Three of §29's five client-chat cases are races, and a race is what a test that awaits one thing at a time cannot see. | `use-ai-chat.test.tsx` (6). Drives a real `ReadableStream` over a stubbed `fetch`, so the hook's own reader/buffering/framing is exercised rather than bypassed. |
| Route boundaries | `ai-permission-matrix.test.ts` proved each route *names* the right guard; nothing proved the gate behind it fires. A route can call `requirePermission` correctly and still let a crafted body through. | `ai-route-boundaries.test.ts` (15). **Found:** a widget whose `requiredPermissions` the caller holds none of still ran, spending the business's budget on an answer with no data behind it. Now 403. |
| §14 stock count | The canonical-ledger fix had no test. | `ai-stock-count-ledger.integration.test.ts` (4), **proven against the bug** — with the defect reintroduced the first two cases fail with `expected 1000 to be 9`. |
| §29 reopening | "Reopening restores valid metadata" was unproven. | 3 cases added to `ai-conversations.integration.test.ts`. |

Each of the five test files was written to fail first, or to fail against a
reintroduced defect. A green suite that has never been red is a suite that has
not been shown to test anything.

## Definition of done

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Tenant users cannot create/manage custom Agents | Done — `ai-custom-agents.ts`, `/api/ai/agents/**`, `AiAgentSelector`, `(app)/ai/**`, `ai_custom_agents` and `ai_projects.default_agent_id` deleted (`0206`) |
| 2 | System Agents built/versioned only by Superadmin | Done — `ai-system-agents.ts` + `/api/platform/ai/agents`, platform-admin guarded |
| 3 | Superadmin assigns agent-backed suggestion cards | Done — `createAgentAssignment` / `eligibleAgentCards`, re-checked on every read |
| 4 | Auto, Instant, Deep Research only | Done — `AI_RUNTIME_MODES`; a stored `thinking` normalizes to `auto` |
| 5 | Auto/Instant resolve different configurable aliases | Done — `applyRuntimeModeAlias`; pinned by `ai-runtime-mode-aliases.test.ts` |
| 6 | Deep Research is a separate cost-approved workflow | Done — `awaiting_approval` → approve → bounded run → settle once |
| 7 | No application-owned semantic answer cache | Done — `ai-answer-cache.ts` + `ai_answer_cache` deleted (`0204`) |
| 8 | No application-owned tenant pgvector RAG stack | Done — `ai-rag.ts`, `ai-rag-indexer.ts`, `ai-embeddings.ts`, `ai_embeddings`, reindex routes deleted |
| 9 | AI knowledge isolated per tenant/business | Done — `ai-knowledge-gateway.ts`; tenant stated twice per request; a 5xx degrades to empty |
| 10 | Layered Platform/Tenant/App/Project memory manageable and auditable | Done — `ai-memory.ts` + `/api/ai/memory`; deletion stops future turns; secrets refused |
| 11 | One prompt resolver is the live source of truth | Done — `resolveSystemPrompt`, called by `api/ai/chat/route.ts`; `ai-prompts.ts` deleted |
| 12 | App Focus actually narrows the live tool catalogue | Done — `routeTools` wired into `runAgentTurn` |
| 13 | Every remaining AI API has an explicit correct guard | Done — `ai-permission-matrix.test.ts` (9 tests) |
| 14 | Unattended writes recheck current authority | Done — `ai-unattended-authority.ts` |
| 15 | Manual writes still require confirmation + apply-time authorization | Done — `/api/ai/proposals/apply` re-checks `aiActionPermission` per action |
| 16 | Stock-count executor uses canonical stock movement data | Done — `LEFT JOIN LATERAL … sum(sm.quantity)` |
| 17 | Rial/Toman follows tenant preference | Done — `resolveBusinessMoneyUnit`; widget run route wired |
| 18 | Provider cost from partial/failed/cancelled calls not lost or double-settled | Done — `accruedUsageOf` + idempotent `requestId` |
| 19 | Conversation switching / stream finalizers race-safe | Done — generation-guarded `AbortController` |
| 20 | Scrolling does not force the user to the bottom | Done — `use-sticky-scroll.ts` |
| 21 | Partial/cancelled replies visibly marked | Done — `AiMessageStatus` + `chat-bubble.tsx` |
| 22 | Usage/audit records include project/mode/agent/research attribution | Done — migration `0208` columns: `runtime_mode`, `system_agent_id`, `suggestion_id`, `research_run_id`, `prompt_layers`, `app_focus`, `prompt_versions` |
| 23 | No cross-tenant knowledge/memory leak possible in tests | Done — `integration/ai-tenant-isolation.integration.test.ts` |
| 24 | Old tenant Agent/cache/RAG/Thinking/dead prompt code removed | Done |
| 25 | Tests, typecheck, lint, migrations, build pass | See below |
| 26 | Documentation reflects the final architecture | Done — `docs/ai-subsystem-architecture.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`, dead-code addendum |

## Quality gate — what actually ran

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` (`NODE_OPTIONS=--max-old-space-size=2800`) | clean |
| `npm run lint` | clean |
| `npx vitest run --config vitest.config.ts` | **571 files / 7463 tests** all pass |
| `npm run test:db` | **2118 passed / 1 skipped** (178 files). Run with `DATABASE_URL=postgres://pos:pos@localhost:5432/pos`; without it, `backup-locks` and `runtime-role-regrant` fail on a module-scope `process.env.DATABASE_URL` read, which is an environment artefact and not a test defect |
| `npm run test:design` | 5 files / 38 tests all pass |
| `npm run build` | **Not completable in this sandbox** — OOM-killed at ~3.4 GB. Verified pre-existing: the identical failure reproduces on the unmodified `main` commit `0cf81eba` in a separate worktree. An environment memory limit, not a regression. |

### Test files this issue added

| File | Tests | Covers |
| --- | --- | --- |
| `src/lib/ai-permission-matrix.test.ts` | 9 | §13 route guard matrix |
| `src/lib/ai-attribution.test.ts` | 12 | §6 attribution columns |
| `src/lib/ai-runtime-mode-aliases.test.ts` | 5 | §7 alias resolution, Thinking rejected |
| `src/lib/ai-812-phase2.test.ts` | 20 | §2/§3/§4 retirements, no local cache or pgvector |
| `src/lib/ai-knowledge-gateway.test.ts` | 10 | §2/§3 tenant-isolated knowledge |
| `src/lib/ai-tool-routing.test.ts` | 15 | §20 App Focus narrowing |
| `src/lib/ai-money-unit.test.ts` | 5 | §15 Rial/Toman per tenant |
| `src/components/ai/use-ai-chat.test.tsx` | 6 | §17/18/19 chat lifecycle races |
| `src/app/api/ai/ai-route-boundaries.test.ts` | 15 | §5/§10/§12 gates behind the guards |
| `integration/ai-tenant-isolation.integration.test.ts` | 6 | §23 cross-tenant isolation |
| `integration/ai-prompt-resolver-agents.integration.test.ts` | 14 | §8/§9 resolver + system agents |
| `integration/ai-deep-research.integration.test.ts` | 14 | §5 Deep Research |
| `integration/ai-stock-count-ledger.integration.test.ts` | 4 | §14 canonical ledger |

## Migrations added

| File | What |
| --- | --- |
| `0204_ai_local_infra_retired.sql` | drops `ai_answer_cache`, `ai_embeddings` |
| `0205_ai_research_runs_shape.sql` | recreates `ai_research_runs` / `ai_research_sources` |
| `0206_ai_custom_agents_retired.sql` | drops `ai_projects.default_agent_id`, then `ai_custom_agents` |
| `0207_ai_permissions_retired.sql` | strips the three retired keys from stored role/override rows |
| `0208_ai_attribution_columns.sql` | adds `runtime_mode`, `system_agent_id`, `suggestion_id`, `research_run_id`, `prompt_layers`; widens the `request_type` CHECK to admit `deep_research` |

`0203_ai_control_plane.sql` was already applied before this issue and was not
edited; the control-plane tables (`platform_ai_modes`, `ai_prompt_versions`,
`ai_system_agents`, `ai_agent_assignments`, `ai_memory`, `ai_research_runs`,
`ai_research_sources`) are all in `EXEMPT_TABLES` where they are platform-scope.

## A bug the §29 test audit found: publishing a second prompt version

Auditing §29's named tests against the tree showed the **prompt resolver and the
system agents had no test file at all**. For the resolver that is the worst
possible gap: it is the single source of truth for what the model is told, so a
regression there changes every answer and nothing else would notice.

Writing the test found a real bug. `publishPromptVersion` wrote both statements
as CTEs of one statement — which looks atomic and is not, because every CTE sees
the same snapshot. The `published` UPDATE ran against a snapshot in which the old
row was still `published`, and the partial unique index rejected it.

**Publishing a second version of any scope failed outright.** A Superadmin could
publish version 1 of a prompt and nothing after it, with no error a user would
connect to the cause. The fix is two statements — retire, then publish — in one
transaction. Only a test that publishes twice finds it.

## Known limitations, recorded rather than hidden

1. ~~**`website` has no mapped tools in `TOOL_APP_MAP`.**~~ **Closed.** The
   Website app did have three read tools (`list_website_posts`,
   `list_website_products`, `get_website_status`, all Phase 38's
   WebsiteAdapter reads) — they were simply absent from the map, so focusing a
   turn on Website fell back to the whole catalogue. The mechanism was fine; the
   data was missing. All three are now mapped, and the test that had recorded
   the gap ("leaves the website app unmapped rather than guessing") was
   rewritten to assert the narrowing instead. `website` now narrows the same way
   the other three apps do.
2. **A tool absent from `TOOL_APP_MAP` is general-purpose** and starts life
   unfiltered, as before. The AEC/project tools sit here by design: a project is
   a scope, not one of the four standalone apps, so there is no app to narrow
   them against.
3. **`npm run build` cannot complete in this 3 GB sandbox.** Pre-existing on
   `main`; reported rather than worked around.
4. **Two `test:db` files fail without an explicit `DATABASE_URL`** — an
   environment artefact of a module-scope `process.env` read, not a test defect.
   Do not "fix" the tests; export the variable.
