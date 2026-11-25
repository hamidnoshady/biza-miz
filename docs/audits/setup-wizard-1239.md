# Business Setup Wizard 2.0 — audit against #1239 / ESH-90

**Date:** 2026-11-25
**Base:** `origin/main` @ `6c436c389`
**Scope:** the existing `/setup` wizard, its APIs, the service-activation and
billing it consumes, and the first-run lifecycle. This audit is the evidence
behind the "acceptance matrix" for GitHub #1239 and the paired Linear issue.

Verdicts: **complete** (implemented and covered by a test), **partial**
(implemented with a specific gap), **missing** (not implemented), **blocked**
(cannot be verified here — reason stated).

| Requirement | Implementation | Verification | Remaining work |
|---|---|---|---|
| First-login enforcement | **partial → fixed** | `src/lib/first-run-guard.ts` (+ test), `src/app/dashboard/workspace-shell.tsx`, `src/middleware.ts` (`x-pathname`), `src/lib/root-landing.ts`. The shell now sends an unfinished owner/manager/admin to `/setup` from `/dashboard`, `/accounting`, `/crm`, `/growth`, `/websites`, `/workspace`; members without `settings.manage` are never redirected; billing/security/connections/help stay reachable. | Server-side guard added for direct URL, `?next=`, browser Back and native deep links. Business-switch/login-picker paths land on `/dashboard` and are therefore covered. |
| Business profile | **complete** | `src/app/setup/business/page.tsx`, `src/app/api/setup/business/route.ts`; prefilled from `computeSetupState`; industry read-only; name/location/contact/legal/tax/email/website; currency prefs. | — |
| Logo management | **partial** | `src/lib/business-logo.ts`, `src/lib/business-logo-rules.ts`, `src/app/api/settings/business/logo/route.ts`, upload/preview/remove in the profile step; 256 KiB decoded cap and MIME/signature checks; deliberate skip. | **No crop.** Prose in #1239 asks for "crop/preview/remove/replace"; the acceptance checklist only requires safe preview/upload/remove + defer. |
| App gallery | **complete** | `src/app/setup/apps/page.tsx`, `src/app/api/setup/apps/route.ts`, `src/lib/setup-apps.ts`, `src/lib/setup-apps-service.ts`; four canonical apps, industry/deployment/availability/tariff gating, published prices, setup + 24 h estimate, extra-charge note; zero-app path. | — |
| Pricing and billing | **complete** | `src/lib/service-activation/pricing-service.ts` (immutable versions, fail-closed `published=false`), 168 h default in `src/app/platform/_components/billing/services-tab.tsx`, `setupFeeRial`/`enabledRialForSeconds` in `catalog.ts`. | — |
| No charge on selection | **complete** | `PUT /api/setup/apps` writes only `settings.setup.selectedApps`; the route has no activation/wallet branch (`route.ts` + `route.test.ts`). | — |
| Per-app configuration | **partial** | `src/app/setup/app-setup/page.tsx` composes the existing service wizard (`src/lib/service-activation/wizard.ts`), resumable in `business_service_wizard_state`, server-validated (`/api/services/[kind]/[key]/wizard`). | Answers are **not applied to canonical domain configuration**: `fiscalYear`/`moneyUnit`, CRM `firstStage`, Growth `tierCount`, Website `domain`/`publishMode` stay wizard state. See "Remaining work". |
| Optional data imports | **complete** | `src/app/setup/import/page.tsx`, `src/app/api/setup/imports/route.ts`; reuses `ImportSection` and `src/lib/data-transfer/*` (XLSX/CSV/JSON/PDF), mapping, no-write preview, duplicate/reconciliation, explicit confirm, resumable jobs, tenant scope; filtered by selected app and **now by industry module** (`requiresModule`, added in this change). | Retry is offered in the Data Transfer history, not inside the wizard; import job list is business-wide rather than branch-filtered (engine-level; see Remaining work). |
| Knowledge integration | **missing → fixed** | `src/lib/setup-wizard-help.ts`, `src/app/setup/step-help.tsx`, `StepShell` integration, `src/lib/kb-step-excerpt.ts`, `GET /api/knowledge` `inlineHelp`, `setup` section + `/setup/*` pages in `src/lib/knowledge-base.ts`, article attached in `scripts/knowledge-seed/content.ts`. | Inline help on the 11 `StepShell` steps; per-app setup keeps its field-level hints. |
| Wizard persistence | **complete** | Settings-based state (`setup.progress`, `setup.selectedApps`, `business.prefs`, `business.profile`, `business.logo`), service wizard versioned rows; server-side, so it survives refresh/logout/device. | — |
| Finish and dashboard | **complete** | `src/app/setup/finish/page.tsx` (routes to `/dashboard`), `POST /api/setup/complete` (readiness from domain data, `markSetupComplete` once, audit in the same transaction, idempotent). | — |
| Wallet activation | **partial** | `src/app/dashboard/setup-wallet-notice.tsx` (dismissible, selection-keyed, no debit), `/settings/billing` + `/settings/services`; activation is the existing `/api/services/[kind]/[key]` with preflight, wallet check and idempotency. | The runtime entitlement gate (`src/lib/service-activation/app-gate.ts`) treats **"no activation row" as permissive**. A new tenant that selected an app but has not paid therefore keeps write access to it. See "Remaining work" 1. |
| Industry compatibility | **partial → fixed** | `src/lib/wizard-steps.ts` shapes per industry; import types now filtered by `requiresModule`. | `menu`/`costing` are still *required* for `food_service` (see "Product decision needed"). |
| Security and isolation | **partial** | Tenant scope on every setup route (`withTenantScope` + `requireManager` = `settings.manage`); selection/finish are non-billing; activation guarded server-side. | Import job list/read is business-scoped, not branch-scoped (pre-existing `src/lib/data-transfer/import-service.ts`). No demo branch in setup routing. |
| RTL and accessibility | **partial** | `dir="rtl"` throughout, Persian copy, `role="progressbar"` with `aria-valuenow/text`, labelled buttons, native `<details>` for help, focus-visible rings. | No automated axe/keyboard E2E suite for `/setup`. |

## First-run lifecycle audit (all entry paths)

| Path | Behaviour | Verdict |
|---|---|---|
| Public signup (`/signup` → `/onboarding`) | Provisions without `completeSetup`; lands on the wizard. | complete |
| Superadmin console provisioning | **Was stamped complete for every non-F&B trade**; now always incomplete (`shouldCompleteSetupForPlatformProvision` returns `false`). | fixed |
| MCP `provision_business` | Same helper, same fix. | fixed |
| Platform company workspace | Explicit `completeSetup: true` (platform-internal exception). | complete |
| Desktop pairing / restore | Stamp/replay their own marker; untouched. | complete |
| Existing tenants | Migration `0197_setup_completion_backfill.sql` backfilled operational tenants; it is not re-run and nothing new re-forces them. | complete |
| Multiple memberships / switch | Switch returns JSON; the new tenant's landing (`/`) or `/dashboard` is now guarded. | fixed |
| Direct URL / `?next=` / Back | Blocked by the new guard. | fixed |
| Non-owner employees | Never redirected into `/setup` (permission-based guard; `/setup` layout already refuses them). | complete |
| Demo | Demo tenants are isolated at provisioning/credentials/billing; setup routing has no demo branch, but demo has no usable login in this repo. | partial |

## Verification performed in this change

- `npx tsc --noEmit` — passed.
- Targeted Vitest — passed: first-run guard, root landing, business
  provisioning, setup lifecycle paths, KB excerpt, setup step help,
  `/api/knowledge` inline help, setup imports (lib + route), wizard steps,
  knowledge catalogue/seed plan, tours, import resume.
- `npm test` — **20 053 passed, 17 failed, 12 skipped**. Every failure is
  environment-only and reproduces independently of this change:
  `client-bundle-boundary` (15 s test timeout; passes with
  `--testTimeout=180000`), `cheques-section` (15 s timeout under load; passes
  alone), `required-gate` (`/bin/bash` missing — no WSL), and
  `desktop-installer-staging` / `desktop-update-engine` (Windows temp/EPERM).
- `npm run test:design` (design lint, primitive lint, loading coverage,
  reference screenshots) — passed.
- `npm run test:db` — **not run**: no Postgres in this environment
  (`DATABASE_URL` unset). The DB-backed setup tests
  (`integration/setup-complete.integration.test.ts`,
  `integration/business-industry.integration.test.ts`) were updated to the new
  provisioning contract but not executed here.

## Remaining work / decisions

1. **Unpaid/unselected app entitlement for new tenants (the largest open gap).**
   `serviceGateDecision` documents "no activation row ⇒ no opinion"
   (`src/lib/service-activation/app-gate.ts:21-25,58-62`), so a business that
   selected an app in the wizard and has not activated it can still call that
   app's mutating APIs. #1239 asks for new tenants to be gated by
   *selection + activation*. A safe fix needs a single combined fact read
   (activation state **and** `setup.selectedApps`) in the
   `src/lib/auth.ts` guard, a product decision on whether *unselected* apps are
   also locked, and DB/E2E proof that legacy tenants are untouched — none of
   which can be verified in this environment (no Postgres). Deliberately not
   shipped unverified.
2. **Canonical per-app configuration.** The service wizard's answers are
   validated and resumable but only stored. Applying `moneyUnit` →
   `business.prefs`, `fiscalYear` → fiscal periods, CRM `firstStage` →
   `crm_pipeline_stages`, Growth `tierCount` → loyalty tiers, Website `domain`
   → CMS site would need one canonical write per app, each with its own
   idempotency and permission review. Not attempted in this change.
3. **Branch-scoped import history.** `listImportJobs`/`getImportJob` filter by
   business only, so a branch-scoped manager can see another branch's job
   metadata and resume it. Fix belongs to #1118/Data Transfer, not the wizard.
4. **Import retry inside the wizard.** The wizard links to the transfer
   history for retries; no per-job retry control on the step.
5. **Logo crop.** Upload/preview/replace/remove exist; crop does not.
6. **Product decision needed:** #1239's acceptance list says menu/catalogue
   population must not block Finish, but the shipped readiness contract (and
   migration 0197, and the published KB article) require one active sellable
   menu item for `food_service`. Left as shipped to avoid silently reopening
   or redefining completion for existing cafés.
7. **Demo routing.** No demo-specific branch in `isSetupComplete`/root landing;
   there is no demo login route in `src/` to exercise it.
8. **Browser E2E.** No Playwright suite for the wizard flow in this repo.
