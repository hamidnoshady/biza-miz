# Dead code and unused route cleanup — 2026-09

Repository-wide audit for genuinely dead, duplicated and unreachable code, with
the confirmed removals implemented and guarded.

| | |
| --- | --- |
| Starting commit | `7429b38b842b8ee1d53cd9dc8137e16c323c5be4` (`main`) |
| Ending commit | see PR head (branch merged with `main` @ `fa34a2b9` after PR #710 landed) |
| Branch | `arena/01a0cd88-cafe-restaurant-pos` |
| Net change vs `main` | 21 files changed, **627 insertions, 912 deletions** (−285 net; −570 excluding the new guard test) |

**Governing principle applied:** remove what can be *demonstrated* unused,
preserve what may still be legitimately consumed. Four candidates that a naive
"zero imports" sweep would have deleted are deliberately retained below, each
with the evidence that keeps it.

---

## 1. Method

The candidate set came from a purpose-built import-graph walk rather than a
generic tool, because this repository has entry points a generic tool
misconfigures: App Router special files, the Edge middleware, `server.ts`,
`scripts/`, `integration/`, and tests that consume modules *as source text*.

The walk resolves static imports, re-exports, dynamic `import()` and CommonJS
`require()` across the `@/` alias, seeds from those real entry points, and
reports what is left over. That walk is now a committed regression test —
`src/lib/module-reachability.test.ts` — so the audit is repeatable rather than
a one-off.

Every zero-reference result was then treated as a *candidate only* and checked
by hand against: full-text grep across `src`, `scripts`, `electron`,
`wordpress-plugin`, `docs`, `config`, `.github`; git history; the design and
route test suites; and, for ambient/typing cases, by deleting the file and
re-running `tsc`.

Separate sweeps covered routes (`src/app` tree vs. `app-routes.ts` vs.
middleware), `public/` assets (all referenced), dependencies (see §5),
WordPress plugin PHP include and hook chains, and the Electron module graph
against `electron/package.json`'s `build.files`.

---

## 2. Cleanup decisions

### Removed

| Path / route | Original purpose | Evidence it is dead | Risk | Action | Validation |
| --- | --- | --- | --- | --- | --- |
| `src/app/(app)/overview/page.tsx` | Redirect-only page for the retired quick-report dashboard | Body is a bare `redirect("/dashboard")`. `app-routes.ts` already owns this rule; AGENTS.md forbids a duplicate legacy page | Low — behaviour moved, not dropped | Deleted; rule moved into `legacyRedirectTarget` | `route-smoke.test.ts`: `/overview` → 308 `/dashboard` |
| `src/app/(app)/ai/page.tsx` | Redirect-only page for the retired standalone AI app | Same shape; forwarded `conversation`/`ctx`/`project`/`aiPanel` params | Low | Deleted; query preserved via `withSearch` | `route-smoke.test.ts` asserts `/ai?conversation=abc123` keeps its thread |
| `src/app/(app)/ai/{agents,coworkers,automations,activity,knowledge,usage}/page.tsx` | Six redirect-only pages → `aiPanelHref(section)` | Each is a two-line `redirect()` duplicating the central table | Low | Deleted (6 files); the **manager components in the same dirs are kept**, see below | New test asserts every `/ai/<section>` 308s with the correct `?aiPanel=` value |
| `src/components/ai/ai-assistant.tsx` (+ `ai-chat-header`, `ai-chat-input`, `ai-chat-messages`) | Floating popup chat launcher | Orphaned when the assistant became `/dashboard` itself. Only importer was `setup-assistant.tsx`, itself orphaned — a closed island | Low | Deleted (4 files, 597 lines) | `tsc`, full unit suite, design suite |
| `src/app/setup/setup-assistant.tsx` | Mounted the popup in wizard mode | Zero references anywhere; the setup layout never renders it | Low | Deleted | Setup route tests pass |
| `src/app/dashboard/ai/ai-recent-conversations.tsx` | «نخ‌های اخیر» sidebar widget | Superseded by `ai-conversations-sidebar.tsx` over the same `/api/ai/conversations`. `workspace-rail-ai-launcher.test.ts` already documents the move and asserts the rail must not contain `AiRecentConversations` | Low | Deleted | Existing rail test still green |
| `src/components/kds-dark-default.tsx` | Forced dark theme on the KDS | Nothing mounts it; the kitchen page renders `KdsBoard` directly, which carries its own `dark:` pairs | Low — KDS theming unchanged | Deleted | Design lint + `test:design` |
| `electron/build-output.log` | Captured `npm run dist` transcript | Records `cafe-pos-desktop@1.0.0` / electron-builder **25.1.8**; current is `business-suite-desktop@1.0.5` / **26.15.3**. No script, workflow, packaging step or doc reads the path | None | Deleted; `.gitignore` entry added | Desktop packaging config untouched |

### Route-layer change

`src/lib/app-routes.ts` — `legacyAssistantTarget` now also answers `/overview`,
`/ai` and `/ai/<section>`, which previously had their own page files. This is
the *same* rule, relocated into the table that AGENTS.md designates as the one
owner of legacy redirects. No redirect target changed; no new legacy URL was
introduced; no redirect loop is possible because `isCanonicalAppPathname`
already excludes both prefixes and `/dashboard` is not itself a legacy row.

---

## 3. Deliberately retained

These have zero static importers but are **not** dead. Each is recorded in the
allowlist of `module-reachability.test.ts` with its reason, so the exemption is
reviewable rather than invisible.

| Path | Why it stays |
| --- | --- |
| `src/types/mssql.d.ts` | Ambient declaration loaded by `tsconfig`, never imported. **Verified by deletion:** `tsc` then fails with TS7016 in `src/lib/integrations/holoo/client.ts` and `scripts/holoo-probe.ts`. |
| `src/lib/crm-deal-handoff.ts` | Consumed *as source text* by `crm-app-boundaries.test.ts`, which greps it to pin the invariant that the CRM prepares a sales document and never posts revenue. A documented integration contract (`docs/crm-architecture.md`); its API surface is simply unbuilt. |
| `src/lib/ai-platform-tools.ts` | Executor for the two platform-support health tools that `src/lib/ai.ts` **still declares** to the model for `mode: "platform"`. No route passes that mode today, so it is unreached at runtime — but deleting the executor alone would leave two advertised tools nothing can answer. Removing the pair is a product decision, not a cleanup one. |
| `src/app/dashboard/dashboard-grid.tsx` | The renderer half of a feature whose other half is live: «سنجاق به داشبورد» (`reports/pin-button.tsx`) is reachable from two report screens and writes to `/api/dashboard/widgets`, which `getDashboardWidgets` still serves. Deleting the renderer would make a working control write to nothing. Flagged as follow-up, not removed here. |
| `src/lib/{ai-prompts,ai-tool-routing,app-data-rules,order-controls,order-control-service}.ts` | Reached only from tests, but these are **specification modules** — they encode prompt fragments, tool→app routing, data-ownership rules and order-control policy that their suites assert against. Retained; no evidence their lifecycle has ended. |
| All `public/` assets | Every file, including `windows/cafe-pos-print-connector.ps1` and `offline.html`/`sw.js`, is referenced. Nothing to remove. |
| All 10 WordPress plugin PHP files | Every `includes/class-pos-*.php` is `require_once`d from the bootstrap (`class-pos-cli.php` conditionally, under WP-CLI). No orphan. |
| All Electron modules | `main.js`, `preload.js`, `backend-manager`, `certificate-manager`, `firewall-manager`, `gateway-manager`, `logger` are each required *and* listed in `build.files`. No orphan. |
| Every dependency | See §5 — no removal is justified. |
| All 210 migrations | Untouched. Treated as applied production history per §8 of the brief. |

---

## 4. What was explicitly **not** done

- **No migration** was deleted, reordered, renumbered or edited; no table,
  column, policy or index was dropped.
- **No** permission rule, feature entitlement, industry profile, app ownership
  or role gate was changed.
- **No** legacy redirect was removed — one set was *moved* into the central
  table and given stronger test coverage than it had as pages.
- **No** CI job, trigger or branch protection was weakened.
- **No** visual baseline was re-recorded.
- **No** dependency or framework upgrade, restyle, or architectural rewrite.

---

## 5. Dependency analysis — no removals

An initial sweep flagged `decimal.js`, but that was a **false positive from the
detector's own regex** (the `.` in the package name). Re-checked: `decimal.js`
is imported by 10+ modules including `lib/accessories.ts`, `lib/fefo.ts` and
`lib/cosmetics-service.ts`. It stays.

The remaining flagged names are all genuinely consumed by tooling rather than
by an `import` statement, and all stay:

- `@types/pdfkit`, `@types/pg`, `@types/pngjs`, `@types/qrcode`, `@types/react`,
  `@types/react-dom`, `@types/ws` — resolved by `tsc` via `node_modules/@types`.
- `eslint-config-next` — loaded through `compat.extends("next/core-web-vitals",
  "next/typescript")` in `eslint.config.mjs`.
- `@otplib/plugin-base32-scure` — re-exported by `otplib`; `lib/mfa-verify.ts`
  constructs `ScureBase32Plugin`.

Lockfiles are therefore unchanged.

---

## 6. Regression coverage added

**`src/lib/module-reachability.test.ts` (new, 248 lines)** — the repeatable
route/dependency audit. Walks the import graph from real entry points and fails
on any orphan. Four sub-tests keep it honest:

1. no orphaned modules under `src/`;
2. every allowlist entry still exists (a stale exemption is how the next orphan hides);
3. no allowlist entry is *genuinely* imported (so an exemption cannot outlive its need);
4. the walk finds >100 entry points and reaches known anchors — so a resolver
   bug cannot make the suite vacuously green.

**`src/app/route-tree.test.ts`** — replaced the assertion that `/overview` and
`/ai` resolve to pages with the inverse: neither, nor any `/ai/<section>`, may
have a `page.tsx`. This is the guard against the duplicate legacy page creeping
back.

**`src/app/route-smoke.test.ts`** — added 14 redirect cases plus two behavioural
tests driven through the real middleware: every `/ai/<section>` opens the
correct `?aiPanel=` panel (asserted against `aiPanelHref`, the single producer,
not a re-spelled string), and `/ai?conversation=` keeps its thread.

Coverage was **added, not weakened**: no existing assertion was relaxed and no
test for still-supported behaviour was deleted.

---

## 7. Local quality gate

Run on this sandbox (Linux, Node 22.22.3) at the ending commit.

| Check | Result | Notes |
| --- | --- | --- |
| `npm ci` | **pass** | 1048 packages |
| `npm run lint` | **pass** | `--max-warnings=0`, clean |
| `npx tsc --noEmit` | **pass** | clean |
| `npm test` | **pass** | **399 files, 5724 tests** (re-run after the `main` merge) |
| `npm run test:design` | **pass** | 5 files, 37 tests |
| `npm run db:migrate` | **pass** | 210 migrations against real PostgreSQL 16 |
| `npm run db:migrate` (re-run) | **pass** | "Nothing to do" — idempotency confirmed |
| `npm run test:db` | **pass** | **132 files, 1508 passed, 1 skipped**, real PostgreSQL |
| `npm run build` | **pass** | see note below |

Baseline (`tsc`, `lint`, `npm test`) was captured at `7429b38` before any edit
and was **already green**, so every result above is a like-for-like comparison.
There are **no new failures**.

Build note: the first `npm run build` OOM'd in this 3.9 GB sandbox *after*
"Compiled successfully", during type-checking. Re-run with the same
`NODE_OPTIONS=--max-old-space-size=3072` the `test` workflow sets, it passes.
Environmental, not a code defect. The route manifest confirms the cleanup:
`/ai`, `/ai/*` and `/overview` no longer appear as routes.

### Checks not run — environment limitations

Stated explicitly; none of these is claimed as passing.

- **`npm run test:visual`** — needs a seeded database, an app-role provision and
  a pinned Chromium against a running production server. Low risk: no
  component rendered by any baseline screen was touched (the deleted UI was
  unmountable), and `test:design` covers the lint/primitive/loading half.
- **Desktop runtime verification / packaging** — `electron/scripts/verify-runtime.js`
  requires a staged `.desktop-runtime/`, produced by the Windows-only pipeline.
  Mitigated by static verification: every Electron module is required *and*
  listed in `build.files`; no PostgreSQL executable, runtime trace, migration
  or installer resource was touched.
- **PHP syntax / plugin tests / plugin packaging** — no PHP runtime in this
  sandbox. Mitigated: **no plugin file was modified**. Include chains and hook
  registrations were audited read-only and are intact.
- **Deployment verification scripts** — require live infrastructure. No
  Dockerfile, Compose file, Coolify config or release script was modified.

---

## 7a. Merge with `main` (PR #710) — conflict resolution

While this work was in review, PR #710 landed on `main`, producing two
**modify/delete** conflicts:

- `src/components/ai/ai-assistant.tsx`
- `src/components/ai/ai-chat-header.tsx`

Both were files this PR deletes and `main` had edited. A modify/delete conflict
is exactly the case where "keep my side" is the wrong reflex — if `main` had
re-wired these into a live surface, the deletion would no longer be correct. So
the resolution was checked rather than assumed:

1. **What `main` changed.** Both edits are purely cosmetic, from a repo-wide
   "remove gradients" pass: `bg-gradient-to-br from-primary to-primary/80` →
   `bg-primary`, and the equivalent on the chat header. No imports, no exports,
   no wiring.
2. **Whether the island is still closed.** Re-ran the importer search against
   `origin/main`: `AiAssistant`'s only importer is still
   `src/app/setup/setup-assistant.tsx`, which is itself still imported by
   nothing; the three subcomponents are still imported only by `ai-assistant.tsx`.
   The component graph is unchanged — `main` restyled dead code.

The deletion therefore still holds, and the conflicts were resolved in its
favour. The full gate was re-run against the **merged** tree (§7), including the
reachability guard, which passes — confirming `main`'s new modules
(`electron/app-paths.js`, `local-storage.js`, `native-printing.js` and others)
are all properly wired and that this PR's guard does not flag them.

## 8. Measured improvements

Reproducibly measured:

- **12 files deleted**, 912 lines deleted against 627 added (−285 net; −570
  excluding the new guard test, since the additions are almost entirely new
  test coverage).
- **8 duplicate redirect-only pages removed** from the App Router tree,
  confirmed absent from the production route manifest.
- **0 legacy redirects lost** — all 8 addresses still 308, now with 14 explicit
  test cases where previously they had none as pages.
- **1 stale build artifact** (141 lines) untracked.
- **0 dependencies removed** (none justified), so lockfiles and bundle
  composition are unchanged.

Expected but **not** measured: a marginally smaller server bundle and route
manifest from the 8 removed page modules. Not quantified — the deleted pages
were two-line redirects, and the difference is below the noise floor of the
build's reported chunk sizes. No claim is made about desktop installer size.

---

## 9. Follow-up, deliberately outside this PR

1. **`dashboard-grid.tsx` + pin-to-dashboard.** The pin control is reachable and
   writes real rows, but nothing renders the grid since `/dashboard` became the
   assistant. Either restore a surface for pinned widgets or retire the feature
   end-to-end (control, renderer, `/api/dashboard/widgets`, `getDashboardWidgets`,
   and a backward-compatible plan for existing `dashboard_widgets` rows). A
   product decision with a data dimension, not a cleanup.
2. **`ai-platform-tools.ts` + the `platform` agent mode.** Either wire a
   platform-support surface that passes `mode: "platform"`, or retire the tool
   declarations in `ai.ts` together with the executor. Retiring the executor
   alone would be a regression.
3. **`crm-deal-handoff.ts`.** Build the handoff UI/route, or record the module
   as a specification-only contract. Do not delete while
   `crm-app-boundaries.test.ts` depends on it for a real invariant.
4. **Schema retirement review.** Not attempted here, per the brief's rule that
   source cleanup must not drop data. Any retirement needs its own deliberate,
   backward-compatible migration plan.

---

# Addendum — issue #812, the AI subsystem rebuild (2026-10)

Same governing principle: remove what can be **demonstrated** unused, preserve
what may still be legitimately consumed. The difference this time is that most of
what was removed was not unreachable — it was reachable and wrong, because it put
a tenant-configurable surface on something the issue makes Superadmin-only.

> **Current ownership correction (issue #757):** this addendum records what the #812 cleanup
> removed; it is not an endorsement of LiteLLM features as replacements. LiteLLM owns provider
> deployments/routing/fallbacks, not the app's prompts or MCP connector. The app no longer has a
> local semantic-cache/pgvector stack, but optional managed-knowledge retrieval uses a separately
> configured external endpoint; do not assume it is a LiteLLM-native feature. Current map:
> [AI subsystem architecture](../ai-subsystem-architecture.md) and
> [Phase 39](../phases/Phase-39-LiteLLM-Only-AI-Platform.md).

## Removed, with the evidence

| What | Why it could go |
| --- | --- |
| `src/lib/ai-answer-cache.ts`, `ai_answer_cache` | The app-owned semantic answer cache was retired. This means no local app cache; it does not mean the app delegates its cache policy to LiteLLM. |
| `src/lib/ai-rag.ts`, `ai-rag-indexer.ts`, `ai-embeddings.ts`, `ai_embeddings`, `api/ai/rag/reindex` | The application's pgvector/indexing stack was retired. The app may call an optional external managed-knowledge endpoint; LiteLLM's native RAG ownership is not assumed. |
| `src/lib/ai-knowledge-service.ts`, `ai-knowledge-shared.ts`, `api/ai/knowledge`, `(app)/ai/knowledge/knowledge-manager.tsx` | The tenant knowledge manager was removed. The app's remaining managed-knowledge client sends a server-resolved tenant scope to the configured external endpoint; there is no tenant ingestion/reindex surface. |
| `src/lib/ai-custom-agents.ts`, `ai-custom-agents-service.ts`, `api/ai/agents/**`, `components/ai/ai-agent-selector.tsx`, `(app)/ai/**` (agents, automations, usage), `ai_custom_agents`, `ai_projects.default_agent_id` | The tenant agent builder. Two things called "Agent", one of them switchable by a business, is how a control-plane boundary gets argued away. |
| `src/lib/ai-reasoning.ts` (`AI_REASONING_MODES`, `AI_MODE_DIRECTIVES`, `AiReasoningMode`) | Superseded by the three runtime modes. A "thinking" mode alongside auto/instant is a fourth mode nobody configured. |
| `src/lib/ai-prompts.ts` + its test (`PROMPT_FRAGMENTS`, `fragmentsForTurn`, `assembleFromFragments`) | The dead fragment engine — only its own test imported it. Two prompt builders is a prompt you cannot predict. |
| `src/lib/ai-agents.ts` → `ai-scheduled-jobs.ts` | Migrated, not just deleted. The Persian job definitions, the status pill, the "today's tasks" list and the three service functions that fed them had **no caller outside the module**. The per-job opt-in switches survive, because they are what stops a tenant paying for an empty digest. The table keeps its old name: renaming a tenant table for vocabulary is a data migration with no product payoff. |

## Retired permissions

`ai.agents.manage` and `ai.knowledge.manage` guarded surfaces deleted above.
`ai.widgets.manage` is retired for a different reason: **its surface still
exists**, but a workspace widget is a saved prompt that runs with its creator's
own permissions, and `ai-widgets.ts` refuses any widget whose
`requiredPermissions` the caller does not already hold
(`widget_permission_widening`). That intersection holds per widget rather than
per member and fails closed on an unknown permission — a stronger boundary than
a dedicated key, so the key was guarding nothing while the registry advertised
it as delegatable.

An advertised capability that gates nothing is a permission a reviewer stops
trusting, so all three keys are gone from `PERMISSIONS`, the role presets and
the Superadmin catalogue. Migration 0207 strips them from stored role and
override rows; `parseOverrides` already filters through `isPermission`, so a
stale grant degraded to "no override" at parse time even before the data was
cleaned.

## Two bugs the sweep found by writing assertions

Neither is reachable from a unit test of the route, which is why both survived:

1. **`deep_research` was not in `ai_wallet_settlements.request_type`'s CHECK
   list.** The approve route had always written it. The first real run to settle
   would have been rejected at INSERT, losing the run's cost entirely.
   Migration 0208 widens the constraint with the original list preserved.
2. **The widget run route typed its failure settlement `widget`** — also not in
   the list. Both paths now type it `chat` and distinguish it by
   `metadata.mode`, which also puts a run's cost in one slice of the usage
   report instead of two.

And one that a comment was actively concealing: the Deep Research approve route
claimed §12's tool intersection was "not re-opened for research" while its tool
list came from the **unfiltered** catalogue. It also called `getSession()`, which
proves only that the caller belongs to the business — so any member, including
roles whose whole permission set is `ai.use`, could approve a run that spends the
business's AI budget. Both fixed; `ai-permission-matrix.test.ts` now pins it.

## Still retained (unchanged from §9 above)

`dashboard-grid.tsx`, `ai-platform-tools.ts` + the `platform` agent mode, and
`crm-deal-handoff.ts` remain documented deliberate retentions in
`module-reachability.test.ts`. Issue #812 did not touch them and did not make
them reachable.
