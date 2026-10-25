# Service activation, setup & hourly wallet billing (issue #1041)

The service activation layer adds **two new charges to the business's existing
wallet** and a **Superadmin retention policy** that starts counting only after the
customer disables a service themselves:

1. a one-time setup fee per business per *stable service identity*, and
2. a per-**enabled-hour** availability tariff for as long as that service stays
   enabled,

plus per-service automatic data destruction after a deliberate disablement.

It does not replace or reinterpret anything that already bills: subscriptions,
top-ups, add-ons, the payment gateway, invoices, AI token credits and every
existing metered charge keep their tables, routes and contracts. There is one
payments authority (`business_wallets` / `wallet_ledger`) and this layer only
adds statement lines to it.

Migration: `0255_service_activation_billing.sql`. Code:
`src/lib/service-activation/`.

## What is a billable service

| Kind | Identity | Examples |
| --- | --- | --- |
| `app` | one of the four `APP_KEYS` in `src/lib/apps.ts` | `accounting`, `crm`, `growth`, `website` |
| `workspace` | a separately priced **My Workspace business capability** | `projects`, `documents`, `media-library` |
| `agent` | a Superadmin-published background agent/routine, plus an optional tenant `runtime_instance_id` | `agent:watch#branch-2` |

Deliberately **not** services:

- the website app's two managers (Eshobe CMS and WordPress/Woo) — they are one
  app, one switch, one tariff;
- the My Workspace shell, navigation, billing, account/security/settings,
  customer export and login — those are never sold or hidden by this layer;
- the AI chat home. Interactive assistant turns stay token/credit metered exactly
  as before; only *background-enabled* agents/routines carry an availability
  tariff, and a suggestion card that merely opens a chat turn never does.

## Pricing (fail closed)

`service_price_schedules` is a versioned, immutable catalogue with no
`business_id`:

- `setup_mode = 'fixed'` → a Rial amount;
- `setup_mode = 'hour_equivalent'` → N hours × this row's hourly rate. This is a
  one-time *setup-fee equivalent* (the owner's 72-hour / 3-day example), never N
  hours of prepaid runtime;
- `hourly_rate_rial` → the per-enabled-hour availability rate;
- `published` → the eligibility gate.

**A service with no published row is not eligible to activate.** Free is an
explicit published `0` Rial row, never the absence of a price. Publishing a new
price closes the previous version at the same instant; an interval already
opened keeps the price version it was opened at, so a later price change never
alters settled history.

The quote (`quoteService` / `GET /api/services/:kind/:key`) shows the setup
debit, the hourly tariff, the first-interval reserve (setup + one enabled hour),
24-hour and 30-day estimates, the current balance, and the *additional* charges
this tariff does not include (AI tokens, provider/SMS/storage).

## Settlement

The canonical record is `service_activation_intervals`:

- opened by an activation or a re-enable, closed by a disable or a suspension;
- `last_settled_at` is a monotonic cursor — everything before it is settled
  exactly once;
- enabled time is measured in **whole seconds** and prorated per second, rounded
  up to the Rial once per segment (`ceil(seconds × rate ÷ 3600)`);
- a settlement segment's `(interval_id, period_start)` is unique and its usage
  event id is deterministic (`service_runtime:<interval>:<start>`);
- the wallet debit, the charge row, the usage event and the cursor advance are
  one transaction. A restarted or concurrent worker produces duplicates, never a
  second debit.

`MINIMUM_BILLING_UNIT_SECONDS = 60` applies only to an *open* interval, so the
five-minute tick cannot write one ledger row per tick. Closing an interval (disable
or suspension) settles every remaining second: **1h20m enabled bills exactly 80
minutes**.

If the wallet cannot cover a due segment, nothing is charged and the service is
suspended — the platform never creates uncovered debt. The uncovered seconds
since the last cursor are not billed (they are capped at one settlement unit plus
worker delay).

Meters `service.setup` (`activation`) and `service.enabled_seconds` (`second`)
record the same events in `billing_usage_events` / the daily rollups, so the
billing console's existing usage views show them. Ledger kinds: `service_setup`
and `service_runtime`.

## Lifecycle

```
unconfigured → setup_in_progress → payment_reserved → active
                                                      │
     customer disable ────────────────────────────────┤
                                                      ▼
                                          disabled_retained → eligible_for_purge
                                                      │            → purging
                                                      │            → data_purged
     re-enable before the deadline ───────────────────┘   (purge cancelled)
     suspension (credit/outage/maintenance/legal) ──► suspended_insufficient_credit
                                                      platform_unavailable
                                                      legal_hold
```

- **First activation** needs a published tariff, the app's platform availability,
  `billing.manage`, and wallet cover for setup + one hour. The setup debit, the
  interval start, the setup evidence (`service_setup_charges`) and the usage
  event commit together; a failed attempt leaves no charge and no half-built
  activation.
- **Setup is once per business per stable identity.** Re-enable, an updated
  published agent version, a renewed subscription, a wizard edit or a rebuild
  after a purge never charges it again. Truly new agent identity = a new,
  separately priced service.
- **Disable** closes the interval at the effective instant, keeps every setting
  and every row of data, and starts the retention countdown. It deletes nothing.
- **Re-enable** locks out and cancels a queued purge, reuses the old
  configuration, checks cover for the first hour only, and opens a new interval.
  Re-enable and a concurrent purge are serialised on the activation row.
- **Suspension** (no credit, provider outage, maintenance, legal hold, trial
  grace) stops billing immediately but never sets `disabled_at` or a retention
  deadline, so it can never masquerade as a customer disable or start a deletion
  countdown. The reason is stored and shown separately.

The resumable per-service wizard lives in `business_service_wizard_state` — not
in the business's first-run `setup` progress (PR #838), which must never reopen.

## Retention and automatic destruction

Policy (`service_retention_policies`, plus an audited
`business_service_retention_overrides`): per service, `auto_purge_enabled` and
`retention_days` (1–3650 days, or `NULL` = keep forever, the default). The
notification lead and export grace stay a platform decision so pinning a business
cannot shorten its warning. No row anywhere means **no automatic destruction**:
an upgrade cannot start deleting pre-existing data.

The worker (`runDueServicePurges`, every five minutes with the settlement tick):

1. claims due rows `FOR UPDATE`, re-checks that the service is still disabled,
   the retention deadline has passed and no hold is in force;
2. cancels itself if the customer re-enabled first;
3. writes a `planned` journal row for a dry run and changes nothing else;
4. otherwise deletes only manifest entries classified `owned` + `delete` —
   today the service's own wizard state — and verifies the scope is empty;
5. journals the full manifest, including what it refused to touch, and reports
   the run as `completed` only when nothing is blocked, otherwise `partial`.

The manifest (`purgeManifestFor` / `servicePurgePlan`) always preserves the activation record,
setup-paid evidence, wallet ledger, invoices and usage events, and blocks any
dataset whose ownership has not been reviewed (the coordination work with #926
media and #903 backups). Authoritative operational datasets are therefore never
deleted by accident, and a purge never claims more than it did.

App-owned operational tables, provider-side website/Woo content, media and
backup copies still need their reviewed ownership/retention work in the
follow-ups listed below; until then those entries stay blocked and the run is
truthfully `partial`.

## Enforcement: the fourth API axis

The epic requires the paid-activation state to be enforced "on APIs, background
workers, tools, scheduler and pages", not merely displayed. The API half lives in
`src/lib/service-activation/app-gate.ts` (the decision, pure) and
`app-gate-service.ts` (one indexed read), called from the single guard chain in
`src/lib/auth.ts` — right after app availability, in the same place the feature
flag and the industry module are enforced. No route was edited, so no route can
forget it.

It is deliberately the *quietest* of the four axes:

| Axis | Question | Failure |
| --- | --- | --- |
| feature flag | is this business entitled? | `feature_disabled` 403 |
| industry module | does this trade have it? | `module_unavailable` 403 |
| app availability | is the app working now? | `app_unavailable` 503 |
| **paid activation** | **did the customer switch it off?** | **`service_disabled` 403** |

1. **No activation row ⇒ no opinion.** A business that never touched this layer
   keeps working exactly as before. Defaulting to "not activated ⇒ blocked"
   would lock every existing customer out of an app they already use the moment
   this shipped — the opposite of the "zero unintended debits, no lockout"
   requirement.
2. **Only a deliberate customer disable refuses anything** (`customerDisabled` in
   the state catalogue: `disabled_retained`, `eligible_for_purge`, `purging`,
   `data_purged`, `purge_failed`). Low-credit suspension, platform unavailability
   and legal hold are **not** disables and do not lock the app — the issue says
   they must never masquerade as one.
3. **Reads stay open; only `POST`/`PUT`/`PATCH`/`DELETE` are refused.** The
   issue requires a working read/export path until the retention deadline
   actually passes.
4. **A failed lookup is a retryable 503**, not "no row": a transient database
   problem cannot accidentally pass a mutation past a deliberate disable. A
   genuinely absent activation row remains a non-blocking answer.

## Setup wizard per service

`src/lib/service-activation/wizard.ts` holds the definitions (pure, so the
dialog, the API and the tests share them) and
`business_service_wizard_state` holds the answers — one row per service identity,
`version`-bumped per save, `completed_at` on the last step. Each app asks for what
its activation actually needs (Accounting: Jalali fiscal year + money unit +
opening-balance mode; CRM: customer source + first pipeline stage; Growth:
channel + loyalty tiers; Website: bare hostname + publish state; Workspace: scope;
agent: run mode + timezone).

Three rules matter here:

- **Never first-run onboarding.** The answers never touch
  `businesses.setup_progress/completedAt` (PR #838), so resuming an app's wizard
  cannot reopen the business's onboarding.
- **Resumable and versioned.** `PUT /api/services/:kind/:key/wizard` saves per
  step; the tenant dialog seeds itself from the saved draft on reopen, on any
  device. Both the wizard API and activation endpoint validate the answer set;
  a direct `POST` cannot bypass preflight and charge for an unfinished setup.
- **Only the wizard's own vocabulary is stored** (`normalizeWizardProgress`): this
  row is deleted by the retention purge, so it must not become an accidental
  document store.

## API surface

Tenant (`billing.view` to read, `billing.manage` to spend):

- `GET /api/services` — every service with its state, setup-paid flag, retention
  deadline and accrued runtime;
- `GET /api/services/:kind/:key` — state, binding quote, effective retention
  policy, destruction plan, journal, runtime summary;
- `POST /api/services/:kind/:key` — `{ action: "activate" | "reenable" |
  "disable" | "settle", requestId?, runtimeInstanceId? }`;
- `GET|PUT /api/services/:kind/:key/wizard` — resumable setup state.

Superadmin:

- `GET /api/platform/services` (`billing.view`) — pricing catalogue + retention;
- `POST /api/platform/services/pricing` (`billing.manage`, audited);
- `GET|PUT /api/platform/services/retention` (`billing.view` / owner-only
  `retention.manage`, audited);
- `GET|PATCH /api/platform/businesses/:id/services` — activations, queue,
  journal, per-business override, hold/release, purge retry/cancel, dry run.

## Tests

- `src/lib/service-activation/catalog.test.ts` — registry boundaries, setup
  modes (including 72-hour equivalent), per-second proration and rounding, quote
  eligibility/fail-closed, retention windows and validation, purge eligibility,
  state vocabulary, manifest safety, meters.
- `integration/service-activation.integration.test.ts` — setup charged once
  (duplicate + parallel activation), 1h20m = 80 minutes settled once, cursor
  across restarts, historical price versions, disable stops billing and starts
  retention, re-enable with no second setup fee and cancelled purge, dry-run vs
  live purge (owned-only deletion, `partial` status, evidence preserved),
  post-purge re-activation, legal hold, suspension/non-disable, unaffordable
  segment suspends instead of creating debt, wizard state isolation.
- `src/lib/service-activation/wizard.test.ts` — every service has an answerable
  wizard, the Jalali fiscal-year window, select/domain validation, resumable
  progress, and that only the wizard's own answers are stored.
- `src/lib/service-activation/app-gate.test.ts` — no activation row never blocks,
  only a customer disable blocks, only writes are blocked, suspension/legal hold
  never block, and the decision tracks the state catalogue's own
  `customerDisabled` flag.
- `integration/tenant-isolation.integration.test.ts` — every new table's RLS.
- `integration/service-activation.integration.test.ts` also covers the guard's
  data half (no row ⇒ null, disable ⇒ `disabled_retained`, suspension ⇒
  `suspended_insufficient_credit`) and the warning scan (fires once inside the
  lead window, never for a suspension, and never after a re-enable).

## UI surfaces

- **Tenant** `/settings/services` (`src/app/(app)/settings/services-settings.tsx`,
  a `services` tab in `src/lib/settings-tabs.ts`): the business's services with
  their live state, whether setup was already paid, and — when off — the exact
  retention deadline. **Enable** shows the binding quote first (setup fee, hourly
  tariff, first-hour reserve, 24h/30d estimates, balance after setup, and the
  charges outside this tariff); **Disable** states that nothing is deleted
  immediately, that the hourly charge stops now, and the deadline plus a link to
  the export screen. Rows also link to `/settings/billing` for the wallet.
- **Superadmin** `/platform/billing?tab=services` and `?tab=retention`
  (`src/app/platform/_components/billing/services-tab.tsx`): publish a new
  per-service tariff version (fixed Rial or N-hour equivalent + hourly rate;
  publishing 0 is the explicit free choice, an unpublished version fails closed)
  and set the per-service destruction window (7/30/90/365 or indefinite, with
  the warning lead and export grace). Both are capability-gated in the tab bar
  and re-checked by the APIs. The catalogue lists every **published** Superadmin
  agent, including one with no tariff yet — otherwise the first tariff for a
  brand-new agent could never be published (an unpriced agent is *ineligible*,
  not invisible).
- **Tenant** `/settings/billing` gained a «هزینهٔ سرویس‌ها» card: the same wallet's
  charges **grouped by service** — setup paid, minutes actually enabled, settled
  Rial, and the next-24-hours estimate at the tariff in force — plus each
  disabled service's deletion deadline and a link to `/settings/services`. It
  renders nothing for a business that never activated a service, so the page is
  unchanged for every existing customer.
- **Pre-expiry warning** (`notifyRetentionWarnings`, run by the activation tick
  before the purge pass): when a disabled service enters its policy's
  notification-lead window (`deadline − notificationLeadDays`), the owner gets one
  `service.retention_expiring` notification. Idempotency is the notification
  table's `(business_id, dedupe_key)` unique keyed on
  `service-retention:<activation>:<deadline>` — a re-run writes nothing, a new
  deadline after a re-disable is a new fact that may warn again, and a suspension
  never has a deadline to warn about.
- **Per business** `/platform/businesses/:id/billing?tab=usage` renders
  `services-panel.tsx`: activations, setup evidence, last settlement, retention
  deadline, purge queue state, and the audited hold/release, purge retry/cancel,
  dry-run and per-business override controls.

## Still to do (follow-ups, not silently implemented here)

- **Scheduler/worker enforcement.** The API axis above is enforced; an agent
  scheduler that keeps *running* work for a disabled service has no gate yet
  because the agent runtime is #906's, not this layer's.
- **Per-tenant price overrides** (§A "optional tenant-approved overrides").
  Retention overrides are implemented; price overrides are not.
- **The export grace** is stored and displayed, but does not yet shift the
  deletion instant itself (`notificationLeadDays` moves the warning only).
- **Cross-service dependency graph** — disabling an app does not yet pause the
  agents that depend on it (§B's dependency paragraph).
- The reviewed table/object ownership manifest for app, workspace, agent,
  website/Woo and media datasets (#926), plus provider-side deletion APIs.
- Backup/manifest alignment and honest "unreclaimed copies" reporting (#903);
  cloud-issued purge tombstones and device acknowledgements for Hybrid/Full
  Offline (#998 / #974).
- Coordination with #928's subscription/billing views, #1012's playbook
  preflight and #906's agent runtime; add-on/entitlement crossover rules.
- Rollout mechanics: shadow metering, staged enablement, customer notice and a
  zero-debit backfill for existing businesses (new tables start empty and no
  existing row is charged by this migration).
