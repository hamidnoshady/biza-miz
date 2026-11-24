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
