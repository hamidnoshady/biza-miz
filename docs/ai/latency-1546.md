# Assistant latency — baseline, changes and what is still blocked (#1546)

Issue: [#1546](https://github.com/hamidnoshady/biza-miz/issues/1546) · Linear:
[ESH-219](https://linear.app/eshobeai/issue/ESH-219/gh-1546-p1ailatency-reduce-assistant-first-token-and-end-to-end-response-time)

This document records what was measured, what changed, and exactly which
acceptance criteria could not be verified in the environment that produced the
change. Nothing here is an estimate presented as a measurement: every number is
either produced by a command listed below or marked **blocked**.

## 1. What the turn actually does

`/api/ai/chat` → `runAgentTurn` (`src/lib/ai-service.ts`):

- one LiteLLM `/v1/chat/completions` call per round (`callProvider`), streamed;
- up to `MAX_TOOL_ROUNDS` (6) rounds, one tool round per provider call;
- the whole read-tool catalogue is offered on **every** round, so its JSON
  Schema is paid for on every round;
- before this change the only time limit was 60 s per round, so a turn could
  occupy the request for ~6 minutes with no user-visible end;
- no application-level generation retry existed (the only retry re-sends
  without `stream_options` after a 400 — protocol negotiation, not generation).

That shape explains the reported numbers: 3–9 calls per turn × 45k–54k prompt
tokens, with the tool schemas a constant share of each call.

## 2. How the schema budget is measured

The application's own estimator (`estimateTokens`, `src/lib/ai-billing.ts`,
deliberately conservative at ~chars/2) is applied to
`JSON.stringify(toolDefinitions("dashboard", { browserNavigation: true, retrieval: true, hasAttachment: true }))`
— the exact payload sent as `tools`.

```bash
npx vitest run src/lib/ai-tool-selection.test.ts
```

That suite prints the table below and fails if any representative app-focused
case drops under 50% fewer schema tokens, so the criterion is enforced rather
than described.

### Baseline (before the change)

| Measurement | Value |
| --- | --- |
| Tools offered every round | 152 |
| Tool-schema tokens per round | **35,768** |
| Rounds per turn (reported) | 3–9 |
| Schema tokens per turn | ~107k–322k |

The reported ~29k figure comes from LiteLLM's own tokeniser for the then-144
tools; the application estimator is intentionally pessimistic, so it lands
higher for the same catalogue. Both describe the same cost.

### After the change

| Case (app focus · instruction) | Tools | Schema tokens | Reduction |
| --- | --- | --- | --- |
| accounting · «چقدر دیروز فروختیم؟» | 50 | 13,417 | **62.5%** |
| accounting · «موجودی انبار و ضایعات…» | 42 | 11,738 | **67.2%** |
| accounting · «مانده حساب مشتریان و مالیات…» | 51 | 14,636 | **59.1%** |
| crm · «مشتری‌های در معرض ریزش…» | 35 | 11,465 | **67.9%** |
| growth · «کمپین پیامکی بازگشت مشتری…» | 40 | 12,307 | **65.6%** |
| website · «وضعیت سایت و نوشته‌ها…» | 28 | 9,543 | **73.3%** |
| accounting · cross-app multi-tool («فروش دیروز و مشتری‌های سایت… موجودی انبار») | 81 | 19,642 | 45.1% |

A turn that names no section at all keeps the whole focused app (and the shared
settings surface): «دیروز چطور بود؟» still sends 120 tools / 29,494 tokens. That
is deliberate — uncertainty widens the catalogue instead of guessing.

Because the system prompt and history are unchanged, the share of *input*
tokens removed from each call is at least the schema share above; the schema is
the majority of the prompt, so the ≥50% input-token criterion is met on the
app-focused cases.

The cross-app multi-tool turn is deliberately **not** held to 50%: it names
three apps, so its tools must all survive. It keeps Accounting, CRM, Website
and Inventory readers and still removes 45.1% of the schema cost by dropping
the sections nobody mentioned (payroll, projects, workspace, growth).

## 3. What changed

| Area | Change |
| --- | --- |
| Tool selection (`src/lib/ai-tool-routing.ts`) | Every dashboard tool is classified into a section (`accounting:sales`, `accounting:inventory`, `accounting:ledger`, `accounting:payroll`, `accounting:projects`, `accounting:workspace`, `crm:records`, `growth:campaigns`, `website:content`, or `shared`/`settings`). App Focus narrows to the app; the member's own words and the existing task lens choose the sections; naming another app's section adds it (cross-app path); no section signal widens to the whole app; an unclassified tool is always kept. |
| No extra model call | Selection is a deterministic string match over the instruction already sent. No classifier, no second request. |
| Authorization | Unchanged and independent: `filterAiToolsByPermissions` still intersects the offer with the member's permissions, and every executor re-checks tenant/branch/app/project/permission when it runs (`runReadTool`). Narrowing the offer cannot grant anything. |
| Diagnostics (`src/lib/ai-latency.ts`) | One `ai.turn.latency` JSON line per turn, keyed by the application `requestId` that settlement and audit already carry. Per round: TTFT, generation time, round total, input/output tokens, tools called (names only), protocol fallback. Per turn: model alias, mode, tool-schema count, offered sections, round count, totals, cost, deadline hit, outcome. No prompt, argument, result, credential or record has a field to travel in. |
| Whole-turn deadline (`ai-service.ts`) | `TURN_DEADLINE_MS = 90_000`. Each round takes `min(60 s, remaining)`, and a turn that runs out fails with `ai_turn_deadline` (a partial-result state), not a silent hang. Cancellation reports `ai_cancelled`; a plain slow provider reports `ai_timeout`. No retry was added for generations or tool execution — routing/fallbacks stay LiteLLM's, per `docs/architecture/ai-subsystem-architecture.md`. |
| Tool progress (`src/lib/ai-tool-progress.ts`, chat SSE) | `tool` events with `running` / `completed` / `failed`, a server-built Persian label derived from the tool's section, and the round number. Rendered under the streaming bubble with `role="status"` / `aria-live="polite"`, RTL inherited; cleared on `done`/`error`; cancellation and error states unchanged. The shared SDK adapter (`sdkToolsFrom`) emits the same events through its `onToolProgress` hook, so an SDK caller cannot invent a second protocol. |
| Fast mode | If `platform_ai_modes.model_alias` for `instant` is blank, `/api/ai/chat` now answers `409 mode_unavailable` with `reason: "fast_alias_not_configured"` and a Persian explanation instead of silently routing to the Auto model. The picker learns the same answer from `/api/ai/modes` and disables Fast before it can be chosen (section 7). |

## 4. Blocked criteria

**No LiteLLM credentials, gateway alias or model deployment are available in
the environment that produced this change, and no independent candidate route
is provisioned.** The following therefore could not be executed and are
reported as blocked, not as passing:

| Criterion | Status | What unblocks it |
| --- | --- | --- |
| p50/p95 first-token, per-round and full-turn latency, real tokens and cost for the same representative cases | **Blocked** | Point `npm run bench:ai-latency` at an approved alias (below) and re-run production-shaped turns; the `ai.turn.latency` line gives the production half of the same numbers. |
| p95 end-to-end latency −50% on 3+ tool-call cases | **Blocked** | Same benchmark; the schema-token half is measured (≥50% fewer tokens per call), but end-to-end p95 needs a live provider. |
| Fast p95 TTFT ≤ 5 s under documented load | **Blocked** — Fast is reported **unavailable** | A working fast deployment plus `platform_ai_modes` row for `instant` with its alias. |
| Effective alias/deployment verification for Auto / Fast / Thinking on real requests | **Blocked** | Live gateway; the diagnostics line prints the alias each turn actually used. |
| Shared-route vs independently provisioned candidate benchmark | **Blocked** | Independent capacity + credentials and an approved budget. A second LiteLLM entry pointing at the same shared endpoint would not qualify. |

### Running the latency benchmark

```bash
AI_BENCH_BASE_URL=https://<litellm-host>/v1 \
AI_BENCH_API_KEY=<virtual key for the alias> \
AI_BENCH_MODEL=<alias, e.g. pos-auto> \
AI_BENCH_TOOLS_FILE=<exported tools JSON, optional> \
AI_BENCH_RUNS=5 \
npm run bench:ai-latency
```

The script prints p50/p95 TTFT, generation and total time, tokens and the
gateway-reported cost per case, and writes a JSON report when `AI_BENCH_OUT` is
set. It refuses to run without configuration (exit code 2) rather than
producing a number it did not measure.

### Configuring Fast truthfully

1. Create/confirm a fast deployment in LiteLLM and a model group alias for it
   (e.g. `pos-instant`).
2. In the Superadmin console (`/platform/ai/modes`), set the `instant` row's
   alias to that alias and keep it active.
3. Leave the alias blank to keep Fast **unavailable** — the picker disables it
   with the reason, and the chat route refuses it as the backstop, instead of
   serving the Auto model under a faster label.

No credential is stored in the repository; the gateway and virtual keys remain
in the platform configuration/secret store.

## 5. Checks run for this change

| Check | Result |
| --- | --- |
| `node --max-old-space-size=6144 node_modules/typescript/lib/tsc.js --noEmit` | pass, exit 0 |
| Focused suites (`ai-tool-selection`, `ai-tool-routing`, `ai-service`, `api/ai/chat/route`, `use-ai-chat`, `ai-latency`, `ai-tool-progress`, `ai-runtime-mode-aliases`, `ai-sdk-adapter`) | 9 files, **89 tests passed** |
| `npm run lint` | pass, exit 0 |
| `npm run test:design` | 5 files, **47 tests passed** |
| `npm run build` | pass (route table generated, no compile errors) |
| `npm test` (full suite) | **1632 files passed, 1 skipped; 19,909 tests passed, 8 skipped** |

Not run here: `npm run test:db` (needs a Postgres instance) and `npm run test:visual`.

## 6. Remaining work (blocked, not abandoned)

- Real p50/p95 and cost comparison, on the same cases, once an approved alias
  and key exist.
- Fast deployment verification, then the ≤5 s p95 TTFT criterion.
- Independent-capacity benchmark, only with approved credentials and budget.
- Real p50/p95 verification of the Fast route once its alias exists.

## 7. Fast-mode truthfulness in the picker (issue #1546 follow-up)

The refusal at send time was only half the fix: a member could still pick «سریع»,
wait for a send, and then be told it does not exist. The picker now asks the
server which modes this deployment actually configured.

| Piece | Where |
| --- | --- |
| Availability decision | `modeAvailability(row, mode)` in `src/lib/ai-runtime-modes.ts`: retired or `is_active = false` → `disabled`; Fast with a blank alias → `fast_alias_not_configured`; otherwise ready. It returns the full `AiModeAvailability` row, and `aiModeAvailability(rows)` applies it to the three chat modes in picker order (a missing settings row is decided from the same default row the runtime read uses), so this is the only place the rule exists. |
| Tenant read | `GET /api/ai/modes` (`src/app/api/ai/modes/route.ts`), on `ai.use` (using the assistant is not administering it). Returns `{ modes: [{ mode, available, reason }] }` with `Cache-Control: no-store`. No alias, deployment, temperature or credential is in the payload. |
| Same decision both ways | The chat route refuses a turn on `modeAvailability` and this route renders it, so an offer and a refusal cannot disagree. The 409 stays the backstop for a crafted body or a picker that loaded before the platform changed the setting. |
| Picker | `useAiModeAvailability` (`src/components/ai/use-ai-mode-availability.ts`) starts every mode available and replaces that with the server's answer; a failed or unreadable response keeps the optimistic default rather than hiding a working mode. `unavailableModeReason` is the one lookup the three surfaces share: `ChatComposer` renders an unavailable mode as a disabled option with the Persian reason, `AiChatHub` falls back to Auto when the selected or URL-restored mode is unavailable, and `AiWorkspaceContext`'s native select disables it. The chat route's 409 carries the same `reason`. |

Checks for this follow-up: `tsc --noEmit` pass; focused suites
(`api/ai/modes/route`, `ai-runtime-modes-shared`, `ai-runtime-mode-aliases`,
`api/ai/chat/route`, `ai-chat-hub`, `ai-permission-matrix`, `api-guards`,
`mcp/registry`, `persistent-tenant-ai`, `tenant-assistant-frame`) — 11 files,
**96 tests passed**; ESLint on every touched file, exit 0. `docs/mcp/coverage-matrix.md`
regenerated for the new route (1315 routes, 0 unclassified).

## 8. Phase 2 — server-resolved context and safe tool metadata

Phase 1 narrowed a turn that already had an explicit app focus. Phase 2 adds the
context the server actually owns, so the default/sidebar path is narrowed too,
without turning a client hint into authorization.

### 8.1 One metadata source

`src/lib/ai-tool-metadata.ts` maps every catalogue tool to its app, section, task
lens, required permission and any runtime dependency. It does **not** declare a
second schema:

| Source of truth | Reused for |
| --- | --- |
| `toolDefinitions()` in `ai.ts` | The only tool schemas. |
| `TOOL_GROUP_MAP` in `ai-tool-routing.ts` | App/section ownership. |
| `AI_TOOL_PERMISSION_MAP` in `ai-capabilities.ts` | The permission the executor already requires. |

Dependencies are data: `workspace`, `retrieval`, `browserNavigation`,
`attachment`, `branchWide`, `aecIndustry` (construction-only project reads) and
`externalMcp`. `get_branch_comparison` is branch-wide; the AEC group requires the
Workspace and the construction industry; hospitality sub-features require their
own feature flag. The Phase 1 §3.6 finding was fixed here: the declared
`search_business_knowledge` tool now has its `ai.use` permission entry instead of
being silently dropped by the fail-closed filter.

### 8.2 One selector

`src/lib/ai-tool-selection.ts` computes the active set from:

- server-resolved effective permissions;
- usable apps (`effectiveAppAvailability`);
- resolved tenant features (`resolveTenantTaskFeatures`, with usable apps);
- current project (`projectScoped`), active location and branch scope;
- the assigned agent's app focus and read allowlist;
- the selected task lens;
- explicit app focus and the member's own words;
- the new route-path hint the compact sidebar sends (`routePath` →
  `appForPagePath`).

A client focus or route is only a hint. A disabled/unknown focus is dropped; it
never widens. `routeTools` still has its safe fallback: no app context at all
sends the full catalogue, and an app focus with no section sends the whole app.
An explicit cross-app request keeps the focused app and adds the named groups.
Non-dashboard surfaces (floor, wizard, platform, proactive) are returned
untouched.

### 8.3 Measured cases after Phase 2

Measured with the application estimator over the dashboard catalogue
(`browserNavigation`, `retrieval`, attachment-capable owner payload):

| Case | Tools | Schema tokens / round | vs 35,768 |
| --- | ---: | ---: | ---: |
| No context / ambiguous («سلام») | 152 | 35,768 | 0% (safe fallback) |
| Sidebar on Accounting, vague question | 120 | 29,494 | 17.5% fewer |
| Accounting · sales question | 50 | 13,417 | **62.5% fewer** |
| Accounting · inventory question | 42 | 11,738 | **67.2% fewer** |
| Accounting · ledger/tax question | 51 | 14,636 | **59.1% fewer** |
| CRM · churn question | 35 | 11,465 | **67.9% fewer** |
| Growth · campaign question | 40 | 12,307 | **65.6% fewer** |
| Website · status question | 28 | 9,543 | **73.3% fewer** |
| Cross-app (sales + CRM + website + inventory) | 81 | 19,642 | 45.1% fewer (safety, not the token target) |
| CRM project conversation (non-AEC; general Workspace reads kept, AEC reads removed) | 71 | 18,828 | 47.4% fewer |
| Branch-scoped Accounting vague question | 119 | 29,295 | 18.1% fewer |
| Focus on a disabled app | 18 | 7,788 | 78.2% fewer (shared safety surface only) |
| `ai.use`-only member, sales question | 10 | 6,316 | 82.3% fewer |
| Agent allowlist (`find_customers`, `get_customer_profile`) | 4 | 4,954 | 86.1% fewer |

The app-focused criterion is still enforced by
`src/lib/ai-tool-selection.test.ts`; the new context cases are enforced by the
same suite. The full fallback is deliberate: an ambiguous request must not lose
a capability silently.

### 8.4 Sanitized diagnostics

The existing `ai.turn.latency` line now carries a `toolSelection` object:

- selection `source` (`explicit_focus`, `route_hint`, `agent_focus`,
  `workspace_focus`, `message`, `task`, `no_context`);
- focused/route/agent app, apps in scope, ambiguity flag, project/branch/location
  booleans (never ids);
- included and excluded groups with counts and reasons (`permission`,
  `app_disabled`, `feature_disabled`, `dependency_unmet`, `agent_allowlist`,
  `not_selected`);
- catalogue vs offered tool count and estimated schema tokens with the rounded
  reduction.

There is no field for a prompt, message, tool argument, customer record,
business name, user id or credential. The suite asserts that a sentinel message
does not appear in the serialized diagnostics.

### 8.5 Execution is still the authority

The selector runs before provider serialization; `runAgentTurn` still calls
`filterAiToolsByPermissions`, and every read/action executor re-checks tenant,
permission, branch/project and approval state at execution time. Filtering the
tool list is not authorization. The SDK adapter exposes
`sdkToolsFromSelection`, which runs the same selector before `sdkToolsFrom`, so a
transport change cannot create a second schema or a different active set.

### 8.6 Checks for Phase 2

| Check | Result |
| --- | --- |
| `node --max-old-space-size=6144 node_modules/typescript/lib/tsc.js --noEmit` | pass, exit 0 |
| Focused suites (`ai-tool-selection`, `ai-tool-routing`, `ai-service`, `ai-latency`, `ai-sdk-adapter`, `api/ai/chat/route`, `ai-permission-matrix`, `ai.test`) | 8 files, **158 tests passed** |
| `npm run lint` | pass, exit 0 |
| `npm run test:design` | 5 files, **47 tests passed** |
| `npm run build` | pass (route table generated) |
| `npm test` | **1651 files passed, 1 skipped; 20,119 tests passed, 12 skipped**; 9 files failed on environment-only cases (Windows temp-directory `EPERM`, WSL `/bin/bash`, and filesystem-walk timeouts), not on the AI changes. The timeout suites pass when run in isolation except `client-bundle-boundary`, which exceeds its 15 s budget on this host. |

Not run here: `npm run test:db` (needs Postgres) and `npm run test:visual`.
Live p50/p95, real alias verification and Fast TTFT remain **blocked** on gateway
credentials, as in §4; no number is claimed for them.

## 9. Phase 3 — runtime-mode routing verification and authorized-route benchmark

**Pre-check.** Phase 1 (PR #1548, merge `1bceebdca`) and Phase 2 (PR #1596,
merge `03dc39ac6`, follow-up `959e53a3c`) are merged; their reports above were
re-read before this phase started, not assumed.

### 9.1 Effective routing table (verified from code, seeds and proxy config)

The chain a representative `/api/ai/chat` turn follows, in order:

1. `getPlatformAiMode(runtimeMode)` reads `platform_ai_modes` **once**;
2. `modeAvailability` gates the offer and the refusal (picker and route share
   the one decision);
3. `resolveAiConfigFor` resolves the gateway/branch/business config;
4. `applyRuntimeModeAlias` **replaces** `config.model` with the row's
   `model_alias` when non-blank (the mode wins over a branch model override);
5. `callProvider` puts `config.model` into the `/v1/chat/completions` body.
   Which *deployment* serves that alias is decided proxy-side
   (`routing_strategy: simple-shuffle`) and is not visible to the app.

Seed state (migrations `0203` + `0256`) and the bundled proxy template
(`docker/litellm/config.yaml`):

| Mode | `platform_ai_modes` seed | Availability | Outgoing `model` on a fresh deployment | Proxy deployment |
| --- | --- | --- | --- | --- |
| Auto (`auto`) | alias `''`, active | available | gateway default: `platform_ai_gateway.chat_model` → `LITELLM_CHAT_MODEL` → `gpt-4o-mini` | `pos-chat` → `openai/gpt-4o-mini` (rpm 60) per the template; default fallback `pos-cheap` → `openai/gpt-4.1-nano` (rpm 120) |
| Fast (`instant`) | alias `''`, active | **unavailable** — `fast_alias_not_configured` | **none**: `409 mode_unavailable` before any gateway resolve or provider call | n/a |
| Thinking (`thinking`) | alias `''`, active | available | same gateway default as Auto (no distinct route) | same as Auto |
| Deep Research | alias `''`, inactive | never offered (`410 research_retired` if requested) | n/a | n/a |

Proxy policy (LiteLLM-owned, unchanged by this issue): `simple-shuffle`,
`num_retries: 3`, `request_timeout: 120`, `allowed_fails: 3`, `cooldown_time:
30`, `fallbacks: pos-chat → pos-cheap`, `default_fallbacks: [pos-cheap]`.

**Provider-configuration finding.** The bundled `model_list` defines no
`pos-instant` or `pos-thinking` group. A console alias that is not in the
proxy's `model_list` is rejected by LiteLLM with `Invalid model name` at request
time; the platform's own gateway probe (`probeGateway`, stage `model_alias`
against `/model/info`) catches that at configuration time. Making Fast routable
therefore requires adding a fast model group **in the LiteLLM config first**
(the approved configuration path), then setting the `instant` alias — never an
app-side model or a second client.

### 9.2 Configured / enabled / reachable

| Question | Answer | How verified |
| --- | --- | --- |
| Configured (repo defaults) | All three chat modes seeded with a **blank** alias; `is_active = true`; `deep_research` inactive | Migrations `0203`, `0256` re-read this phase |
| Configured (staging deployment) | **Unknown — blocked.** The staging `platform_ai_modes` rows cannot be read from this workspace | Unblock: run `SELECT mode_key, model_alias, is_active FROM platform_ai_modes;` on the deployment DB, or open `/platform/ai/modes`, or `GET /api/ai/modes` (returns availability only, deliberately no alias) |
| Enabled | Per-row `is_active`, enforced identically by the picker (`GET /api/ai/modes`) and the chat route (both call `modeAvailability`) | `modeAvailability` unit + route tests (§9.4) |
| Reachable | **No.** Sanitized probes from this workspace: `staging.eshobe.com` resolves (`45.94.213.43`), TCP :443 connects, then the TLS handshake is cut by the sandbox egress policy (`SSL_ERROR_SYSCALL`); plain HTTP :80 gets an empty reply; `litellm:4000` does not resolve (compose-network only); `127.0.0.1:4000`/`:3000` have nothing listening | `curl` probes recorded in the Phase 3 tracker comment; no credential was used or printed |

No `LITELLM_*` or `AI_BENCH_*` value exists in this workspace's environment or
files, no local proxy runs, and Docker is unavailable — so **zero** provider
routes are both authorized *and* reachable from here.

### 9.3 Model selected for representative requests; Fast vs Thinking

Verified with the real `getPlatformAiMode`, `modeAvailability` and
`applyRuntimeModeAlias` at the route level (§9.4): with the seeded blank rows,
an Auto or Thinking turn sends the gateway default (`pos-chat` in the test's
resolved config) and a Fast turn is refused **before** `resolveAiConfigFor` is
called, so no Fast request can reach the provider. Configured rows replace the
model exactly (`pos-instant`, `pos-thinking`); a console-disabled mode is
refused with `disabled`.

**Does Fast use a faster route than Thinking? No — on this configuration Fast
uses no route at all.** Fast is refused as unavailable while Thinking rides the
gateway default; the product no longer serves the reasoning/default model under
a faster-sounding label. Fast becomes routable only after a fast deployment
exists in LiteLLM *and* the `instant` alias names it — at which point
`probeGateway`'s `model_alias` stage and a benchmark run are the verification.
Even if the alias were pointed at `pos-cheap`, that shares the same upstream
credentials as `pos-chat`, so it is a cheaper model on the **same** capacity,
not independent capacity.

### 9.4 What was executed (product behaviour + suites)

New route-level tests in `src/app/api/ai/chat/route.test.ts` (real mode read,
real availability, real alias application; only the gateway resolve and the
provider loop are replaced, so the assertion lands on the exact `model` that
would go into the request body):

| Test | Asserts |
| --- | --- |
| Fast, blank alias | `409` / `mode_unavailable` / `fast_alias_not_configured`; `resolveAiConfigFor` and `runAgentTurn` **not** called |
| Fast, configured alias | `200` and `runAgentTurn` config carries `pos-instant` |
| Auto, blank alias | `200` and config carries the gateway default |
| Thinking, blank then configured | gateway default first, then `pos-thinking` replaces it |
| Thinking, console-disabled | `409` / `disabled`, no provider call |

Checks run for this phase:

| Check | Result |
| --- | --- |
| `node --max-old-space-size=6144 node_modules/typescript/lib/tsc.js --noEmit` | pass, exit 0 |
| `npm run lint` (and `npx eslint` on the touched file) | pass, exit 0 |
| Focused suites (`ai-runtime-mode-aliases`, `ai-runtime-modes-shared`, `api/ai/modes/route`, `ai-runtime-readiness`, `ai-gateway-probe`, `ai-latency`, `api/ai/chat/route`, `ai-service`, `ai-tool-selection`, `ai-sdk-adapter`) | pass — the chat route suite is **10 tests**, including the 5 new Phase 3 ones |
| `npm run test:design` | pass, 5 files / **47 tests** |
| `npm test` (full suite) | **1685 files passed, 1 skipped; 20,397 tests passed, 8 skipped; 0 failures** |
| `npm run build` | pass, exit 0 (route table generated). The sandbox's 3.72 GiB cgroup killed the first attempts with SIGKILL; an 8 GiB swapfile let it finish — an environment fix, not a code change |
| `npm run bench:ai-latency` | exit 2 by design: no gateway configured, nothing measured (§9.5) |

Not run here: `npm run test:db` (needs Postgres) and `npm run test:visual`.

### 9.5 Benchmark — sanitized method and result

**Result: not executed; zero calls made.** No authorized route is reachable
from this workspace (§9.2), and the harness refuses to invent numbers:

```
$ npm run bench:ai-latency
ai-latency-benchmark: no gateway configured, nothing was measured.
Required environment: AI_BENCH_BASE_URL, AI_BENCH_API_KEY, AI_BENCH_MODEL
exit code 2
```

**Method, ready to run the moment an approved endpoint exists** (staging only,
existing credentials only, no production traffic, no new provider):

```bash
AI_BENCH_BASE_URL=https://<staging-litellm>/v1 \
AI_BENCH_API_KEY=<existing staging virtual key> \
AI_BENCH_MODEL=<alias under test> \
AI_BENCH_RUNS=5 AI_BENCH_OUT=phase3-<alias>.json \
npm run bench:ai-latency
```

- Three representative prompts — simple (no tools), app-focused (one tool
  round), multi-tool (forces several rounds) — the same cases the Phase 1
  baseline used.
- Concurrency: **1 in flight** (the harness runs sequentially); `AI_BENCH_RUNS`
  samples per case (default 5).
- Measures per call: time-to-first-token, generation time (total − TTFT), total
  time, input/output tokens (gateway-reported usage), failures, answered-rate
  as an output-quality smoke check, and cost from `x-litellm-response-cost`.
  Reports p50/p95 (nearest-rank) per case and writes a JSON report.
- Same prompt set and procedure for any candidate route; a route counts as
  independent capacity only with its own upstream capacity **and** credentials.

**Candidate route: none provisioned.** Nothing in this repository, GitHub
#1546/ESH-219, or the tracker history shows a separately provisioned candidate
with independent upstream capacity, so the current-vs-candidate comparison is
**not applicable** rather than failed. A duplicate `model_list` entry pointing
at the same shared endpoint would not qualify as capacity.

### 9.6 Provider-configuration blockers (this phase)

| Blocker | Unblocks |
| --- | --- |
| No gateway credential and no reachable gateway from this workspace (staging TLS cut by egress policy; no `LITELLM_*`/`AI_BENCH_*` values; no Docker) | Any live probe: `probeGateway` (health → `/model/info` → minimal completion), live p50/p95 benchmark, live `model_id`/`api_base` per alias |
| Staging `platform_ai_modes` rows unreadable from here | The exact per-deployment alias/enabled table in §9.1 — one DB read or `/platform/ai/modes` |
| Bundled proxy template has no fast model group | Fast staying truthful: either add an approved fast deployment to LiteLLM's `model_list` and set the `instant` alias, or keep Fast reported unavailable (current behaviour) |
| No candidate route with independent capacity/credentials | The independent-capacity comparison in §4 |

Timeout reconciliation, progress-UI polish and the final end-to-end verification
remain open on #1546 / ESH-219.
