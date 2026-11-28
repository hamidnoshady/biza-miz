# Adaptive UX + Ready-to-run Playbooks + Superadmin Template Studio

Canonical trackers: **GitHub #1590 / Linear ESH-233** (consolidates retired #1012 / ESH-117).
Campaign execution belongs to **#901**; marketer/referral ops to **#900**; Tour Studio **#972** is
a *pattern reference*, not a template executor. This document is the Wave-0 audit, compatibility
map, schema/API design and acceptance traceability. It is updated as waves land; nothing here
claims completion that is not implemented and tested.

## 1. What already exists (verified against `main`, do not duplicate)

| Concern | Canonical module | Notes |
|---|---|---|
| Authorization | `src/lib/auth.ts` `requirePermission/requireAnyPermission/requirePermissions`, `src/lib/authorize.ts`, `src/lib/permissions.ts` `effectivePermissions`, `src/lib/membership-authority.ts` | permission re-read from DB every request; revoked prerequisites cascade |
| CRM section gates | `src/lib/crm-permissions.ts`, `src/app/(app)/crm/crm-routes.ts` | `crm.view/manage/configure/merge/export/consent_manage/...` |
| Growth section gates | `src/lib/growth-access.ts`, `src/app/(app)/growth/growth-routes.ts` | `campaigns.view/manage`, `messaging`, `growth.view`, ... |
| App enable/disable | `src/lib/app-availability-service.ts` `effectiveAppAvailability/isAppAvailable` (migration 0128, per **app**) | never per-section |
| Industry | `src/lib/industries.ts` `INDUSTRIES`, `src/lib/industry-profile.ts` `ModuleKey`, `src/lib/industry-guard.ts` `isModuleEnabled` | canonical registry; **no invented keys**; clothing/fashion is #1567 (not in registry yet) |
| CRM tasks/activities | `crm-service.ts` `createActivity` (kinds call/meeting/message/note/task/visit), `updateActivity` | canonical CRM-native task; `assignee_user_id` verified against membership |
| CRM queues | `crm-queues.ts`, `crm-queue-views.ts`, `crm-shared.ts` `CRM_QUEUE_PRESENTATION` | new_leads, stalled_deals, vip_follow_up, at_risk_customers, possible_duplicates, ... |
| CRM saved views | `crm-saved-views-service.ts` `saveView` | canonical saved-view persistence |
| CRM automations | `crm-automation-rules.ts`, `crm-automation-service.ts` | **existing CRM engine**: trigger→condition→(assign / create follow-up task / signal Growth); NOT to be duplicated |
| CRM segments | `crm-segments-service.ts`, `src/lib/segments.ts` `SegmentDefinition` | pure SQL compiler; versioned; consent-aware purposes |
| CRM data quality | `crm-service.ts` `findDuplicates/previewMerge/mergeCustomers`, `crm-data-quality.ts` | merge requires explicit human approval |
| CRM scoring | `crm-scoring.ts` RFM lifecycle, `crm-health.ts` | no invented scores |
| Growth campaign builder (#901) | `campaign-builder.ts`, `campaign-builder-service.ts`, migration `0262` | `growth_campaigns` + immutable locked versions; statuses draft/pending_approval/approved/live/paused/completed/archived; `parseCampaignDefinition`, `simulateCampaign`, `hashCampaignDefinition`. **First slice only**: trigger `pos_sale_settled`, reward `cashback`; reward posting/ledger explicitly NOT shipped in this slice |
| Growth message campaigns (Phase 37) | `message-campaigns-service.ts`, `message-template.ts`, `campaign-audience.ts`, `campaign-channels.ts`, `message-outbox` | **real send path**: consent-filtered `audienceForSegment`, per-recipient snapshot, outbox drain, cost `messageCostRial`, `estimateTriggeredMessageCost`, pause/resume, `campaign_already_launched`, `campaign_has_no_recipients`, `messaging_not_configured`, `AUDIENCE_LIMIT` |
| Message templates | `message-templates-service` (`saveMessageTemplate`), `message_templates` table; closed variable set `{name, shopName, points, credit, discount}` | unknown variables are send-blocking |
| Consent | `crm-service.ts setConsent`, `parties.sms_consent/marketing_consent`, `CHANNEL_PURPOSE`, `SegmentPurpose`, CRM consent section, `crm-consent` | consent checked at execution time |
| Tour Studio pattern | `src/lib/tour-studio.ts`, `tour-studio-service.ts`, `src/app/platform/knowledge/kb-tours-panel.tsx`, `/api/platform/knowledge/tours*` | draft/validation/review/publish, immutable versions, rollback, audit — reused as *pattern* |
| Superadmin | `src/app/platform/**`, `src/lib/platform-auth.ts requirePlatformAdmin`, platform RBAC (`isPlatformAdmin`, role `platform`) | new studio goes here; canonical convention `/platform/<area>` + `/api/platform/<area>`; migration numbering next free `0323` |
| Offline/hybrid | offline sync + lease tables; messaging requires online provider | CRM-native local tasks may work offline where sync allows; **no claiming an offline-queued campaign ran** |
| Money | integer **Rial** storage; `formatMoneyText/useMoney` display Toman/Rial per tenant; `messageCostRial`; exact integer arithmetic | no new wallet/ledger; no direct posting |
| Dates | Shamsi/Jalali display only, `src/lib/jalali.ts`, `JalaliDatePicker`; `app_business_date`, `businessToday`, `todayJalali` | never native `<input type=date>`, never raw ISO to a user |
| Design | `page-chrome.tsx`, `data-table.tsx`, `filters.tsx`, `ui.tsx`, `src/components/ui`, `docs/design-system.md`; `npm run test:design`; `npm run test:visual` | compose, never re-derive; RTL Persian; dark/light; **no new global design changes** |
| Business size | `users` membership (`is_active`, `membership_status`, migration 0170); no existing headcount field | size derived from **active member count** + explicit user override; **defaults only, never a permission gate** |

## 2. What is missing (Wave scope)

- No `playbook_catalog` (typed, versioned, declarative) and no `playbook_instances`.
- No centralized adaptive policy resolver separating entitlements / profile / recommendation /
  presentation / overrides.
- No persisted per-user preferences for Simple/Advanced, My Tools/All Tools, pinned favorites.
- No CRM `templates` section / `/crm/templates`, no `/growth/templates`.
- No Superadmin Template Studio.
- #901 reward **execution/ledger** is not shipped in this repo slice, so Growth playbooks bound to
  cashback/journeys are surfaced as *draft creation + truthful prerequisite*, never as a running
  outbound campaign. Message-campaign playbooks bind to the real Phase-37 send path.
- No inline-AI form assistant for playbooks (deferred; must reuse existing assistant, no parallel
  form system or privileged executor).
- No `clothing` industry key (#1567); adaptive matching degrades safely and records the dependency.

## 3. Architecture

### 3.1 Adaptive context resolver — `src/lib/adaptive-context.ts` (pure)

`resolveAdaptiveContext(input: AdaptiveInputs): AdaptiveContext` separating **five** axes that the
issue requires be kept distinct:

1. `authorization` — actual effective permissions (server-resolved `Set<Permission>`), enabled apps,
   module flags, plan/capability constraints, branch/site scope. **Never** derived from size/industry.
2. `profile` — industry, size, goals, readiness, locale (RTL/fa), business-day context.
3. `eligibility` — per-template `TemplateEligibility` (status + machine-readable reasons).
4. `recommendation` — deterministic ranking (`rankPlaybooks`), no AI call required.
5. `presentation` — density (`simple`/`advanced`), My Tools/All Tools, pinned/favorites, explicit
   user overrides. **Never** widens authorization.

Permissions are always **re-checked server-side** on read/write/launch; the resolver only *reads*
an already server-resolved permission set to compute what to show. A size profile can never grant
a permission; a restricted member never sees a launch control the server would refuse.

### 3.2 Playbook catalog — `src/lib/playbooks/*`

One declarative, versioned catalog. Seed definitions live in typed code initially (repo convention,
see #901); **Studio persistence** layers on top via `playbook_templates` (below) without forking.

`PlaybookTemplate` (see `types.ts`): stable `key`, semantic `version`, `schemaVersion`, `owningApp`
(`crm`|`growth`), Persian `fa` + optional `en`, `businessGoals`, `tags`, `supportedIndustries`
(`"all"` or registry keys), `sizeDefaults`, `requiredCapabilities`, `requiredData`, `requiredPermissions`,
`requiredApp`, `quickInputSchema` (typed; **no JSON/rule-graph input**; no arbitrary code/SQL),
`preflight`, `executionBinding` (two canonical executor types only), `measurement`, `publicationState`
(`draft`|`review`|`published`|`archived`), `availability`. **No arbitrary JavaScript, SQL, unsafe
expressions, elevated access, or unsandboxed execution.**

Two executor types only (no parallel universal automation runtime):
- **CRM executor** `crm.*`: authorized CRM task/queue/saved-view/assignment/activity; may hand a
  *draft* to Growth via existing contracts; **never sends marketing, never moves money**.
- **Growth executor** `growth.*`: existing #901 campaign primitives / Phase-37 message campaigns;
  never a second engine.

### 3.3 Preflight & safety — `src/lib/playbooks/preflight.ts`

Separated pure checks + DB reads. Always truthful `unknown` (rendered نامشخص), never `0`.
- total vs consent-qualified reachable audience; missing/suppressed contacts; exclusions;
- source-data freshness; required permissions; capability/app readiness; branch scope;
- estimated vs actual cost (integer Rial; `unknown` not zero); reward/discount liability;
- send frequency / limits / quiet windows; overlapping workflows; approval requirement;
- stop/pause/rollback; expected-outcome (KPI) definitions + baseline + measurement window + denominator.

### 3.4 Instances — migration `0323_playbooks.sql`, `playbook-instances.ts`

`playbook_instances`: tenant + branch/site scope, `template_key`, immutable `template_version`
+ `config_snapshot`, initiator + approver, executor app + `executor_ref`, `idempotency_key`
(unique per business; retry/replay-safe), actual lifecycle
(`draft|pending_approval|scheduled|running|paused|completed|failed|canceled`), timestamps,
`last_error`, `retry_count`, `audit` (human-readable). **A published template change never mutates a
launched instance.** Valid lifecycle transitions enforced. RLS policy in same migration.

### 3.5 User preferences — `playbook_preferences`

Per (business, member): density simple/advanced, myTools, pinned, favorites, dismissed. RLS.

### 3.6 Superadmin Template Studio

`/platform/template-studio` + `/api/platform/template-studio/*`, `requirePlatformAdmin`, separate
author/edit vs publish permissions, no-code **approved blocks only**
(`trigger → condition → CRM task | Growth action → approval → result`), typed field
config/defaults/validation, targeting validated **server-side**, synthetic simulation
(solo/small/large × industry × capability × role; **no production writes/sends/charges**),
draft→validation→review→publish→staged rollout→immutable versions→diff→audit→rollback,
analytics from real events. **This session lands the canonical catalog + simulate + read model;
full no-code persistence is Wave-5 (see matrix).**

## 4. Security & consent (mandatory)

Tenant/branch/site isolation + RLS; server-side permission re-check on page/API/worker/AI-MCP;
separate view-preview / configure / approve / launch / send / financial-result permissions; marketing
consent + suppression + opt-out re-checked at execution time; quiet windows + frequency caps;
budget caps + reward liability + provider charges + approval thresholds via #901/accounting
(**no new wallet/ledger/reward engine; no direct financial-table posting**); idempotent retry;
no duplicate sends/tasks/rewards; complete audit; offline restrictions respected.

## 5. Measurement truthfulness

KPIs tied to real source events; distinguish **pipeline-influenced vs attributed vs incremental
uplift vs confirmed accounting revenue**; settled/completed orders net of refunds/returns;
baseline + window + denominator + freshness + source refs + attribution confidence + estimated vs
actual cost; `unknown` not zero; no fabricated ROI/brand-lift/uplift/audience/conversion;
ROI/causal claims require defensible comparison/control.

## 6. Acceptance traceability matrix (live)

Status: `not-started` | `in-progress` | `verified` | `blocked`. Nothing is `verified` without a
passing test/build + runtime evidence on the branch. This is the source for the GitHub/Linear
checklists.

### Top-level completion gates (#1590 §17 + inherited #1012)

| ID | Requirement | Implementation | Test evidence | Status |
|---|---|---|---|---|
| G1 | Adaptive across solo/small/growing/org | `adaptive-context.ts`, `businessSizeProfile` | `adaptive-context.test.ts` | in-progress |
| G2 | Industry/goal accurate; permissions independent of size | `eligibility.ts` | `eligibility.test.ts` | in-progress |
| G3 | CRM+Growth task-first, no-data safe | overview pages + `playbooks` featured | — | not-started |
| G4 | My Tools/All Tools, favorites, Simple/Advanced | `presentation`, `playbook_preferences` | — | not-started |
| G5 | Both galleries | `/crm/templates`, `/growth/templates` | — | not-started |
| G6 | #1012 discovery+preview+quick-launch | `preflight.ts`, quick wizard | — | in-progress |
| G7 | 15–20 functional playbooks | `catalog.ts` + executors + tests | `catalog.test.ts`, executor tests | in-progress |
| G8 | ≥1 CRM + ≥1 Growth end-to-end, trustworthy | CRM executor + Growth message-campaign adapter | integration test | in-progress |
| G9 | Missing capabilities disable safely | `eligibility` | `eligibility.test.ts` | in-progress |
| G10 | No duplicate engine | reuses canonical services | `crm-app-boundaries`, arch test | verified |
| G11 | Studio author/validate/publish/target/version/rollback | platform studio | — | not-started |
| G12 | Active instances immutable across publish | `template_version` snapshot | — | in-progress |
| G13 | Inline AI same forms, no escalation | — | — | not-started |
| G14 | Tenant/branch isolation; approval; consent | RLS + permission re-check | tenant-isolation test | in-progress |
| G15 | Financial reconcile | via #901/accounting only | — | not-started |
| G16 | Cloud/mobile/desktop/hybrid/offline | no offline campaign claim | — | not-started |
| G17 | RTL/Jalali/a11y/responsive visual | design system + `test:design`/`test:visual` | — | in-progress |
| G18 | Full CI/E2E green | — | — | not-started |
| G19 | Docs/operational guidance | this doc | — | in-progress |
| G20 | Reviewed+merged+runtime verified | — | — | not-started |
| G21 | Both trackers final evidence | GitHub #1590 + Linear ESH-233 | — | in-progress |

### Inherited #1012 P0/P1/P2 (condensed; full list preserved on #1590)

P0 featured 4–6 + View-all; full galleries; safe preview; working CRM playbooks + Growth via real
primitives; P1 preflight+2–4 inputs, approval/scheduling, instances, manage/pause, idempotency,
10+ eligible, source-backed metrics; P2 favorites/custom copies, industry recommendations,
Superadmin publish/version governance. See `docs` on #1590 for verbatim original.

## 7. Wave plan (this session)

- **Wave 0** ✅ this doc + audit.
- **Wave 1** adaptive context + preferences (scaffold) + tests.
- **Wave 2** canonical catalog + validation + eligibility + deterministic ranking + tests.
- **Wave 3** preflight + CRM executor + Growth adapter + instance persistence + idempotency + tests.
- **Wave 4** seed 15–20 + industry-aware recommendations + source-backed metrics mapping.
- **Wave 5** Superadmin Studio read/simulate + governance skeleton. (Full no-code builder: follow-up.)
- **Wave 6/7** inline AI + E2E + offline + security matrix + CI + docs. (Tracked; not claimed.)
