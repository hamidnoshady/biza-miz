# Deep Research retirement (issue #1367)

**Status:** implemented — Deep Research (`پژوهش عمیق`) is retired as a separate
product experience. New runs cannot be created, approved or executed through any
UI or API. Historical runs, sourced findings, prompt versions and settlement
rows are kept exactly as they were. The everyday chat modes — **Auto, Fast,
Thinking** — are unchanged.

This document is the policy the code implements. The single source of truth for
the vocabulary and the API contract is
[`src/lib/ai-research-retirement.ts`](../../src/lib/ai-research-retirement.ts);
the server-only flag read lives in
[`src/lib/ai-research-retirement-server.ts`](../../src/lib/ai-research-retirement-server.ts).

## 1. Why retirement rather than deletion

Deep Research was never the Thinking chat mode. It had its own multi-round
execution, explicit cost approval, spend cap, environment TTL, stored findings
and its own settlement attribution. Deleting it would have destroyed:

- the answer a business was given,
- the sources that answer was checked against,
- the USD cost the platform paid, and
- the Rial settlement that cost produced.

So the product entry point is closed; the record stays. **No row is deleted, and
no historical `deep_research` value is rewritten to `auto` or `thinking`.**

## 2. What is retired, and where it is enforced

| Surface | Route / file | New behaviour |
| --- | --- | --- |
| Create a run | `POST /api/ai/research` | `410 research_retired` |
| Approve + execute | `POST /api/ai/research/[id]/approve` | `410 research_retired` |
| Change platform caps | `PUT /api/platform/ai/research` | `410 research_retired` |
| Chat turn asking for it | `POST /api/ai/chat` with `runtimeMode: "deep_research"` | `410 research_retired` |
| Service-level create | `createResearchRun()` | `{ ok: false, error: "research_retired" }` |
| Service-level approve | `approveResearchRun()` | `{ ok: false, error: "research_retired" }` |
| Service-level execute | `runResearchRun()` | `{ ok: false, error: "research_retired" }` before any provider call |

The route guard and the service guard are both required:

- The **route** is what an HTTP client sees, and what returns the documented
  status and body.
- The **service** is the boundary a future route, script or job cannot skip. In
  particular `runResearchRun()` refuses before it reads a run or calls LiteLLM,
  so retirement cannot trigger unintended spending even for a run someone
  approved just before the deploy.

### API error contract

All retired writes answer the same body, so a stale client can branch on it:

```json
{
  "error": "research_retired",
  "message": "پژوهش عمیق بازنشسته شده است. از حالت‌های خودکار، سریع یا تفکر عمیق استفاده کنید.",
  "supersededBy": ["auto", "instant", "thinking"]
}
```

- Status is **`410 Gone`** — the endpoint exists and the feature is deliberately
  gone, which is more useful to a client than a `404` that reads like a typo.
- Authorization runs **first**. A caller without `ai.use` gets `403` and learns
  nothing about the product decision.
- `supersededBy` is informational only. Nothing is silently remapped: a
  `deep_research` request is refused, never answered as Thinking or Auto.

### Configuration writes

- System agents: creating or updating an agent with `allowedModes`/`defaultMode`
  naming `deep_research`, or assigning one with `preferredMode:
  "deep_research"`, fails with `400 mode_retired`. An existing agent row keeps
  whatever it stored — history is not rewritten by an unrelated update.
- Prompt layers: `mode:deep_research` is no longer offered by the console
  (`PROMPT_SCOPES`). Existing versions remain in `ai_prompt_versions` and
  `isPromptScopeKey()` still accepts the key, so an operator can still recover
  them; no new publish is invited.
- Runtime modes: `deep_research` stays in `AI_RUNTIME_MODES` so stored values
  resolve, but is not in `AI_CHAT_MODES`, and `isAiRuntimeModeAvailable()` is
  `false` for it regardless of any `platform_ai_modes` row.

## 3. What stays readable

| Surface | Route | Gate | Scope |
| --- | --- | --- | --- |
| Tenant history | `GET /api/ai/research` | `ai.use` | the caller's own `user_id` **and** session business |
| Tenant history UI | `/dashboard?aiPanel=research` | `ai.use` or `ai.manage` | same as the API (the panel is read-only) |
| Platform caps (audit) | `GET /api/platform/ai/research` | platform `ai.read` | the historical gateway settings |

`ai_research_runs`, `ai_research_sources`, `ai_wallet_settlements` (including
rows with `request_type = 'deep_research'`, its `runtime_mode`, and
`research_run_id`) and `ai_prompt_versions` are untouched. No migration is
needed, and none is added by this change.

## 4. In-flight, pending and scheduled work

There is **no background worker or scheduler for research**. A run executes
inside the approval request itself, so at deploy time the only possible
non-terminal states are:

- `awaiting_approval` — never started, and it never spent anything (creation
  writes no cost). After the deploy it cannot be approved; it is history.
- `running` — a row whose approval request was in flight during the deploy. The
  new `runResearchRun()` guard refuses before any provider call, so a new
  instance cannot continue it. A row left `running` by a crash was already
  possible before this change and was already never resumed.

### Reconciliation command

The policy lives in
[`src/lib/ai-research-reconcile.ts`](../../src/lib/ai-research-reconcile.ts);
the script is only the connection, arguments and printing.
`npm run research:retire` reports open runs; nothing changes without `--apply`.

```bash
npm run research:retire                          # report only, every tenant
npm run research:retire -- --business=<uuid>     # report only, one tenant
npm run research:retire -- --json                # machine output
npm run research:retire -- --apply               # cancel pending, expire stale running
```

- `awaiting_approval` → `cancelled`, `error = 'research_retired'`. No cost ever
  accrued, so this is a state correction, not a financial one.
- `running` whose `expires_at` has passed → `failed`, `error =
  'research_retired'`. It did start; "failed" is the truthful terminal state.
  `actual_cost_usd`, tokens and `finished_at` are preserved, and any settlement
  already written is never touched.
- A `running` row that has **not** expired is left alone on purpose: it may be an
  old instance still finishing during a rolling deploy. Re-run the report after
  the TTL and apply then.

The command sets `app.rls_bypass = 'on'` for its own session, exactly like
`withoutTenantScope()` in `src/lib/db.ts`, because it is platform administration
across tenants. It never approves, executes, deletes or reprices anything.

## 5. Frontend and URL compatibility

| URL / control | After this change |
| --- | --- |
| Superadmin nav «پژوهش عمیق» | removed from `AI_CONSOLE_SECTIONS` |
| `/platform/ai/research` | temporary (`307`) redirect to `/platform/ai/modes` |
| Tenant mode picker | exactly Auto, Fast, Thinking — no `deep_research` item |
| `?mode=deep_research` bookmark | renders Auto in the composer (view state); the API still refuses an explicit request |
| `?aiPanel=research` bookmark | read-only history panel («تاریخچهٔ پژوهش عمیق») |
| Research history panel | no create field, no cost-approval step, no approve button |

The redirect is temporary rather than permanent so a rollback does not leave
browsers caching the retirement. All views remain Persian-first RTL and use the
existing primitives (`SectionCard`, `StatusBadge`, `EmptyState`, `ErrorBox`,
`Button`); no second AI interface is introduced.

## 6. Rollout and rollback

The change is a normal code deploy. There is **no migration, no data write and no
runtime flag**:

1. **Rollout**
   1. Merge and deploy the code. The retirement is a constant in
      `ai-research-retirement.ts`; nothing has to be configured.
   2. Run `npm run research:retire` to see what is open. Apply only after the
      approval-request window has drained (no `running` row younger than the
      `24h` environment TTL remains).
   3. Watch `ai_wallet_settlements` for `request_type = 'deep_research'`: new rows
      should stop appearing; historical rows must not change.
2. **Rollback**
   - Revert this change and redeploy. Because it adds no migration and deletes
     or rewrites no row, the previous code runs against the same data: the
     historical runs, caps, prompt versions and settlements were never touched,
     so a revert is a complete rollback.
   - The reconcile command is opt-in and irreversible per row (it sets a terminal
     status). If a rollback is planned, do not run `--apply` until the decision
     is final; a report-only run changes nothing.
3. **Why there is no feature flag.** A flag that re-opens a retired spending
   workflow is a spending bypass behind an environment variable, and it would
   also have to restore the old route bodies — the code this change removes. The
   security property ("no new Deep Research job through any UI or API") is worth
   more than a flag that can only be used to break it. A revert is the rollback,
   and it is safe by construction.

### What never needs a rollback step

Historical rows, prompt versions, settlements and audit events. They are read by
unchanged code and were never migrated.

## 7. Verification

Covered by the following automated checks (all runnable without a live provider):

- `src/lib/ai-812-phase2.test.ts` — three chat modes, retired value preserved but
  unavailable, request decision refuses `deep_research`, the retirement is a
  constant with no env switch, stable error body.
- `src/app/api/ai/ai-route-boundaries.test.ts` — direct create/approve bypass
  returns `410` with nothing created, read, gated or settled; `403` without
  `ai.use`; `GET` stays scoped to the caller's own runs.
- `src/app/api/platform/ai/research/route.test.ts` — `PUT` is `410` and never
  writes a cap; `GET` stays readable for audit; `403` without the capability.
- `src/app/dashboard/ai/ai-chat-hub.test.tsx` — no `deep_research` composer
  option; `?aiPanel=research` opens a read-only panel with no create/approve
  control; historical answer and sources remain visible.
- `src/lib/ai-attribution.test.ts` — the retired approve route can neither gate
  nor settle nor run, and the settlement schema still accepts historical
  `deep_research` rows.
- `src/app/api/api-guards.test.ts` — the two research routes are pinned to
  `withTenantScope()` + `requirePermission(PERMISSIONS.aiUse)`.
- `src/lib/ai-research-reconcile.test.ts` — the in-flight policy: pending runs
  are cancelled, expired running runs are failed, live running runs are left
  alone, and the tool never deletes, reprices or executes.

## 8. Known limitations

- A `running` row from a crashed pre-retirement request has always been
  unrecoverable; retirement does not reconstruct its cost. The reconciliation
  report makes it visible instead of hiding it.
- The prompt console no longer lists `mode:deep_research`; recovering an old
  version of that scope is an API/DB operation, not a click.
- `platform_ai_gateway` still stores the `research_*` caps. They are inert
  configuration kept for audit; removing the columns would be a destructive
  migration with no product benefit.
