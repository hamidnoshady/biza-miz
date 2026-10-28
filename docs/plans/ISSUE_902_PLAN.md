# Issue #902 — delivery plan and record: managed Kavenegar child accounts

Scope: the issue's **first slice** as its triage comment defines it — “provider API spike
(child-account create, fund, template approval) behind an adapter, then the platform-level
managed-service contract that other integrations (#894, #896) will reuse.”

The epic is P0/P1 across many areas. This change lands the plumbing those areas share; §7
lists what is deliberately left for separately tracked follow-ups. The operator runbook and
provider facts live in
[`docs/integrations/kavenegar-managed-service.md`](../integrations/kavenegar-managed-service.md).

## 1. Provider spike (§0 of the issue's checklist)

- Verified the customer-management API shapes against the supplier's documentation and
  recorded them as fixtures in `src/lib/kavenegar/client.test.ts` (top-level `entries`,
  object vs array, template metadata, duplicate-key codes, credit semantics).
- **Found and fixed**: the Phase 37 send parser read `return.entries`; the documented reply
  puts `entries` beside `return`. Message ids were fabricated and `cost` discarded. The
  parser now reads both shapes and carries `providerCostRial`; the outbox stores it in
  `message_outbox.provider_cost_rial` (wholesale evidence only — retail charging untouched).
- No live provider call is made by any test.

## 2. Global managed-service contract (§0)

- `src/lib/managed-services/contract.ts`: the only tenant-facing readiness shape, a
  provider-free fault taxonomy with Persian copy, a managed-service registry, and
  `findTenantLeaks`/`assertTenantSafePayload` as the CI guardrail.
- Applied it to the three tenant endpoints that previously returned the console's provider
  configuration (`/api/messaging`, `/api/growth/settings`, `/api/messaging/preview`) via
  `getTenantMessagingConfig()`.
- Registered SMS and email in `MANAGED_SERVICES`; #894/#896 add entries rather than new
  shapes.

## 3. Existing risks in §1 reconciled

| Risk | Action |
| --- | --- |
| Two stored Kavenegar configurations | Child provisioning uses the **same** master key resolver as OTP (`getKavenegarMasterKey`); no second credential store. |
| Marketing uses one shared key | Per-business resolution in the drain; managed state non-active ⇒ no sender; legacy fallback is explicit and temporary. |
| `parseKavenegarResponse` reads `return.entries` | Fixed, with fixtures and cost preservation (see §1). |
| `SendResult` discards cost | Optional `providerCostRial`; persisted per outbox row. Retail settle logic unchanged. |
| `/api/platform/sms` guarded by `ai.config.manage` | Now `messaging.manage` (the capability migration 0176 created for SMS/provider config); console card gate updated to match. |
| Second ledger | Provider funding is `kavenegar_credit_transfers` (internal, tenant-scoped rows but no tenant surface at all). Tenants keep the central wallet. |
| Phase 31 automation limits | Untouched: this slice sends nothing new; it only routes existing campaigns through the right account. |

**Discovered while wiring eligibility:** `resolveBusinessCapability()` treated
`app_availability.state` values as `enabled`/`beta`; migration 0128's vocabulary is
`available`/`beta`/…, so every app with an `available` row was denied
`platform_unavailable`. Fixed to use `APP_AVAILABILITY_META[state].usable` (the pure rule the
pages and API guards already use). Without it, no business could ever be eligible for
provisioning.

## 4. Account model and provisioning (§2)

- Migration `0258_kavenegar_managed_accounts.sql`: `kavenegar_business_accounts` (tenant-scoped,
  FORCE RLS, unique `business_id`/`localid`), `kavenegar_account_credentials` (platform-only
  RLS — it carries no `business_id` to scope by — encrypted key + version + last-four hint),
  `kavenegar_provisioning_jobs` (tenant-scoped, one open job per business/kind, lease +
  skip-locked claim), `kavenegar_credit_transfers` (tenant-scoped journal),
  and the opt-in policy columns on `platform_sms_config`.
- Migration `0259_kavenegar_funding_templates_reconciliation.sql`: provider balance column,
  funding policy columns (buffer/caps/floor), `kavenegar_lookup_templates` (tenant-scoped,
  first-party titles, provider-neutral state), `kavenegar_reconciliation_runs` (tenant-scoped,
  one run per account per hour).

Every table that carries a `business_id` is tenant-scoped under FORCE RLS, including the
queue, the funding journal and the reconciliation runs: the platform code reads them under
the documented bypass, but a scoped query that forgot it can only ever see one business's
rows — which is what the repository-wide `tenant-isolation` guard requires, and it is the
stronger of the two rules.
- Pure state machine `src/lib/kavenegar/provisioning.ts`; worker and adoption in
  `provisioning-service.ts`.
- `localid` = business UUID; create with `Status=2`, zero credit, policy tariff and lines,
  `CanUseParentLines=false`; `fetchbylocalid` before any retry; `503` adopts, `502` retries
  with the next deterministic username; ambiguous POSTs are `outcome_unknown`.
- Eligibility is derived from the canonical resolver + app availability in a bounded sweep
  (`runKavenegarManagedServiceTick`) scheduled every 60 s in `server.ts`. No provider call runs
  inside a tenant request.
- Lapse suspends and retains mapping/key/tariff; renewal reactivates through read-before-write.

## 5. Funding (§3)

- `transferManagedCredit` writes the journal row `pending` before the provider call, confirms
  to `applied` with balance evidence, records `unknown` on transport ambiguity, answers a
  replayed idempotency key from the committed row, and updates the cached provider balance
  only when the provider actually reported one.
- `pricing-service.ts` adds the JIT policy: a buffer measured in messages, planned against the
  **dearer** (English) wholesale segment, clamped by a per-child ceiling, a rolling daily cap,
  and a master floor; the provider's 1,000-Rial minimum is honoured by rounding down and
  refusing sub-minimum transfers. An unresolved (`pending`/`unknown`) transfer blocks funding
  entirely — double-funding is the failure this journal exists to prevent.
- `runManagedFundingTick` funds a bounded set of active children every 15 minutes; automatic
  top-up is **off by default** (`funding_buffer_messages = 0`) and a configured floor refuses
  to act when the master balance is unknown rather than funding through it.
- Console: policy form, per-account “تأمین اعتبار”, and a manual transfer form with a
  per-click idempotency key.

## 5a. Funding strategies and the cross-business guard (§3)

The first slice shipped one rule — top up to the buffer whenever the child is under it — plus the
per-child cap, the daily cap, the master floor and the unresolved-transfer block. The issue asks
for a *choice* of strategy and for a guard that protects the fleet, so migration `0261` and
`planFunding` add:

| Addition | Rule |
| --- | --- |
| `jit` | The 0259 behaviour, now explicit |
| `low_watermark` | Refill only after the child drops below a trigger, then refill to the whole buffer — hysteresis, so a child one message under target is not topped up every 15 minutes |
| `scheduled` | Only inside a UTC hour window (wraps midnight; `start = end` means all day). An unset window funds normally rather than never, so an accidental strategy never silences the fleet |
| `manual` | Explicit "never automatically"; distinct from a zero buffer, which reads like a misconfiguration |
| `funding_global_daily_cap_rial` | Ceiling for **all** children in one rolling day, checked before the per-child caps: the cross-business demand guard |

A watermark of 0 (or ≥ the buffer) clamps to the target, so a typo can never fund above what the
operator chose. The console exposes all of it; the route rejects an unknown strategy instead of
silently treating it as `jit`.

Still open in §3 and left for a follow-up: funding from an **authoritative** master balance (the
customer API does not expose the master's credit), and the `approved campaign budget` strategy —
that needs a product decision on which campaigns count as approved spend.

## 5b. Funding under concurrency, and the Superadmin attention ledger (§3)

§3 asks for two things the first funding pass did not do: *"concurrent business demand"*
must be bounded, and the operator must be **alerted** — "low master credit, child
discrepancies, suspended accounts, failed transfers".

**The caps were read, not reserved.** `planFunding` was already correct in isolation, but
the pass read the day's transfers, decided, and only then wrote a `pending` row — so two
workers (a tick on each instance, or a tick and an operator click) could both read "there is
room" and both take it. Fixed by making the decision *atomic with its reservation*
(`reserveAutomaticTransfer`):

1. one transaction takes a **per-child advisory lock** (`pg_try_advisory_xact_lock`, so a
   second worker defers instead of queueing behind a slow pass) and, only when a global cap
   is configured, the **fleet lock**;
2. inside it, the snapshot and both windows are re-read — and both windows now count
   `pending` reservations as already spent, because the provider may already have moved that
   credit (a transfer is one row changing state, so the figure does not double-count when it
   becomes `applied`);
3. the pure planner runs against those fresh numbers, the day's idempotency key is allocated
   inside the lock, and the row is committed as `pending`;
4. **only then** is the provider called, outside every transaction and lock
   (`applyReservedCreditTransfer`). A network round trip never happens under a database lock;
   a decision never happens without one.

The fleet ceiling is exact rather than approximately right: with a global cap set, competing
children serialise on the fleet lock for the few milliseconds it takes to insert one row, and
the transfer is clamped to whatever the ceiling still allows (a partial top-up, asserted in
the suite).

**Alerts are a ledger, not a log** (`0263`, `alert-service.ts`). One *open* row per condition
with `occurrences`/`last_seen_at` moving while it persists; `resolved_at` set by the pass that
sees it clear; acknowledgement recorded as a human act with who and when. Twelve kinds, each
with first-party Persian copy and a stated remedy, and — deliberately — **nothing** for the
conditions that are not incidents: `automatic_top_up_off` and `outside_funding_window` are the
operator's own settings, `below_provider_minimum` is a rounding remainder the next cycle
closes, and an in-flight reservation (which blocks the next pass for a few seconds by design)
is the double-funding guard working. The incident is an `unknown` *outcome*, which raises
`unresolved_transfer` from the transfer state instead.

Wiring: the funding tick raises on the blocking reason and closes business-scoped conditions
when it finds the child healthy; a fleet-level alert is closed only by evidence that clears it
(one applied transfer for the master floor and the fleet cap, a supplied balance for
`master_balance_unknown`). The reconciliation pass raises `reconciliation_drift` (critical) vs.
`reconciliation_incomplete` (info, an unreadable balance) and closes both on a clean run, and
— because it is the one pass that reads a child's provider status on a timer — it raises
`account_suspended` when our row says `active` and the provider disagrees. A provisioning job
that will not be retried raises `provisioning_failed`, and the next success closes it.

Surfaces: `GET /api/platform/sms/accounts` returns `alerts` + `alertSummary`, the console
shows «نیازمند اقدام» above the fleet with the severity, the occurrence count, the remedy and
a «بررسی کردم» acknowledgement (`POST {action:"acknowledge_alert"}`, audited).

## 6. Lookup templates and wholesale reconciliation (§4, §7 of the issue)

- `template-service.ts`: tenant creates a **draft** with a first-party title; the provider
  name is derived (`bmv`/`bmt` + 10 hex of a content hash) so a retry cannot create a second
  template; validation follows the provider's rules (`%token`, numbered variants, per-script
  length 268/612); submission and approval sync run through the **child** account with
  `apiKey`; `602` (name exists) is adopted by name rather than treated as failure; an
  ambiguous submit is recorded as `outcome_unknown` and resolved by the next sync. Tenants
  receive `{title, purpose, status, statusLabel}` only — no provider name, id, or rejection
  text.
- `reconciliation-service.ts`: expected = applied funding − provider cost, compared with the
  provider's `remaincredit` over the child's lifetime (the provider's balance is cumulative);
  runs are bucketed to the hour so a retry cannot duplicate one; a failed provider read is
  `incomplete`, not `drift`; the console lists drift first and shows retail charged vs
  provider cost (`billing_usage_ratings` vs `message_outbox.provider_cost_rial`).
- Scheduled: funding every 15 minutes (5-minute delay), reconciliation every 6 hours
  (10-minute delay), both central-only and bounded.

## 6a. Wholesale cost into the commercial ledger (§4)

- **Was missing:** `message_outbox.provider_cost_rial` held what the supplier charged, and the
  margin report read it — but nothing wrote it to `billing_vendor_cost_events`, the one table
  where every other integration states what the platform actually paid. Margin was therefore
  computable but not auditable against finance, and reconciliation compared retail credit
  against a number that lived only inside the messaging tables.
- `src/lib/messaging-vendor-cost.ts` posts one event per **accepted** send, keyed to the outbox
  row (`message_outbox:<id>`), reusing 0177's unique `(provider, source_reference)` so a retried
  drain cannot double-post. An unreported cost posts **nothing**: null is *unknown*, not zero, and
  the margin report keeps counting those rows as `unreported` rather than inflating margin.
- The drain records the cost inside the business's own tenant scope, after the outbox row is
  marked `sent`; a billing write failure is logged and repaired by the backfill, never allowed to
  fail a send that already went out.
- `runMessagingTick` ends with a bounded, self-healing backfill (200 rows, selected by the
  *absence* of the event, not a timestamp) so sends accepted before this module existed are
  caught up once and the pass then idles.
- Still open in §4 and deliberately left for the Billing domain: markup/surcharge policy, volume
  slabs, price-version selection at reservation time, tax policy, and the refund-on-rejection
  rule. This change ledgers the cost side only; what a tenant is charged is unchanged.

## 6b. The lookup-template lifecycle, completed (§5, §6)

The catalog, approval sync and tenant-neutral view shipped with the first slice; what was still
missing was the rest of the provider's documented surface and the tenant screen that uses it.

| Added | Why it matters |
| --- | --- |
| `verify/updatetemplate` in the adapter (`buildUpdateTemplateRequest`, `client.updateTemplate`) | The only documented template method we did not call. Required fields are `templateId`, `sourceType`, `sendMethod`, `name`; the reply has **no** `approvalStatus`, so an accepted edit means "back in review" |
| `needsProviderUpdate()` + `submitted_body`/`submitted_title` (migration `0260`) | `state` alone cannot tell a never-submitted draft from a rejected one, so a resubmit could not know whether it owed the provider an edit. The snapshot makes that decidable and makes a no-change resubmit free |
| `revisionPlan()` + `reviseLookupTemplate()` | draft/rejected rows are rewritten **in place** (the derived name is the template's identity, so the provider copy is updated, not duplicated); approved/submitted rows get a **successor** with `supersedes_id`, so an edit never stops automation that is sending today (§5's "versioned rollout and reapproval") |
| `archiveLookupTemplate()` | `verify/deletetemplate` on the child key, then `disabled` + `archived_at`. `424`/`449` are "already gone"; any other failure still retires our row and records the code, so the console shows a manual cleanup instead of claiming a clean delete |
| Tenant endpoints `lookup_template_revise` / `lookup_template_disable` on `/api/messaging` | Ownership is checked in the tenant's own scope first; a tenant request never deletes anything at the provider |
| Growth screen «پیام‌های خودکار» | The tenant finally sees its approved messages with a first-party status label, can add one, revise the text of a `needs_action` row, and remove it from the catalog |
| Console «کاتالوگ الگوهای تأییدشده» | Rejections first, then reviews in flight: submit (add or update, chosen by the service), retire, and the stored provider-neutral error code |

Still open in §5/§6 and left for the follow-ups below: enabling catalog entries **by business
type/plan**, the delivery/health dashboard, and wiring approved templates to concrete triggers.

## 6c. Delivery and health reporting (§6)

The fleet view answered "is this account provisioned and funded?" but not "are messages arriving?".
A child can be `active`, funded and failing every send, and nothing on the console showed it.

- `src/lib/messaging-delivery-report.ts` reports, per business over 24 hours: accepted (`sent`),
  confirmed delivered, failed and still queued — ordered by failures so the operator's next question
  is at the top, and served only from `/api/platform/sms/accounts`.
- `deliveryHealth()` turns that into a first-party verdict, and deliberately separates **idle**
  (no attempts — no evidence) from **healthy**, so silence never reads as success.
- The console gains «وضعیت تحویل پیام (۲۴ ساعت اخیر)» with the counts, the verdict and the last
  attempt per business.

Still open in §6: the dedicated audit view (platform audit entries exist and are written by every
managed-account action, but the console links to the shared audit page rather than filtering it).

## 6d. Retail pricing, price versions and supplier cost (§4)

§4 asks for one number the tenant pays and a truthful account of the number the platform pays —
without turning either into the other.

**The policy is versioned and effective-dated** (`0262`, `kavenegar_retail_price_versions` +
`_slabs` + `_overrides`). `platform_message_config.sms_rial_per_segment` stays the *base* rate,
which is why shipping this cannot move an existing tenant's bill: with no version published the
engine is `base × units`, exactly the Wave 1 amount. Publishing is the only thing that changes a
price, it requires `billing.manage`, and every publish writes `platform_audit_log` with
before/after.

The order in `src/lib/kavenegar/retail-pricing.ts` is the specification:

1. base — Billing's rate, never a provider tariff;
2. volume slab — the tier for this business's segments in the current UTC month replaces the
   version's markup/surcharge (a tier is a price, not a discount on one);
3. exceptions — channel, then business, then business+channel, each overriding only the fields
   it sets, so the narrowest agreement wins;
4. markup — `floor(base × bps / 10,000)`;
5. surcharge — once per *message*, not per segment; a message fully inside the free allowance
   costs nothing at all;
6. discount — a promotion, only while its window is open;
7. tax — on the discounted amount. Every step floors and clamps at zero.

**Reservation picks the version, settlement never re-prices.** The drain quotes the whole batch
once (`quoteBusinessSends`), reserves the exact total, and settles with the sum of the messages
that actually went out; the wallet entry carries only the version *number* — the markup and
margin are not tenant data. If the pricing tables cannot be read, the drain falls back to the
base rate rather than stopping messaging.

**Supplier cost** posts to `billing_vendor_cost_events` keyed `(kavenegar, message_outbox:<id>)`,
so a replayed drain cannot post it twice. §0/DoD #3 forbids a tenant seeing supplier cost, name
or margin in *any* surface, so `0262` adds `tenant_visible` and a RESTRICTIVE policy that ANDs
with the existing permissive tenant policy: a managed cost row is unreadable through a tenant
connection even if a future query forgets to filter, while every pre-existing row keeps the
visibility it always had.

**Failure is a policy, not an assumption.** `failed_send_policy` is `refund` by default (no
acceptance, no charge — the reservation is returned) and `charge` only where the supplier
actually bills the attempt. The issue is explicit that a failed delivery must not be assumed
free, so the choice is recorded per version and audited with it.

Surfaces: «قیمت‌گذاری خرده‌فروشی پیام مدیریت‌شده» in `/platform/billing?tab=usage`
(`/api/platform/billing/retail-pricing`, GET any admin, POST `billing.manage`) with the policy in
force, the month-to-date fleet volume, a slab editor, an exception editor with a business search,
and the version history. `/platform/messaging` links to it and keeps the wholesale side.

Still open in §4: wiring `billing_usage_ratings`/invoice lines to the same versions, and the
supplier-invoice reconciliation that would confirm accepted-but-undelivered billing in practice.

## 7. Verification run

| Gate | Result |
| --- | --- |
| `npx tsc -p <scoped tsconfig>` covering every changed file and its dependency graph | pass (the repository-wide `tsc --noEmit` exceeds this sandbox's 3.9 GB and is killed by the OOM killer; see §10) |
| `npx vitest run` — new unit files | 149 tests pass across 10 files (`retail-pricing` adds 27, `alert-service` adds 13) (`contract`, `client`, `rest`, `secrets`, `provisioning`, `pricing-service`, `template-service`, `reconciliation-service`) |
| `npm test` (full suite) | 1223 files, 15,333 tests pass, 7 skipped, exit 0 (one unrelated guard, `brand-coverage`, caught a `Biza-Miz`→`Bizamiz` copy slip in new comments; fixed) |
| `npm run test:db` — `kavenegar-managed-accounts` | 46/46 pass on a migrated database, fake transport, no network (5 for the §6b lifecycle, 3 for the §5a strategies, 1 for the §6c delivery report, 3 for the §6a wholesale-cost ledger) |
| `npm run test:db` — `kavenegar-retail-pricing` | 13/13 pass: version windows, back-date refusal, persisted markup/surcharge/tax/allowance, slab tiering from recorded usage, business and channel exceptions, reserve → settle → refund-once, supplier cost posted once and hidden from a tenant connection, RLS forced on the three new tables |
| `npm run test:design` | platform console is outside the design-lint realms; tenant Growth card changed only its copy — run recorded with the change |
| `npm run lint` (whole repository, `--max-warnings=0`) | clean |
| `npm run db:migrate` | 419 migrations apply from an empty database, including `0258` and `0259` |
| `npm run build` | not verified here: Next's production build is killed by the OOM killer in this sandbox (both phases need the memory of the full repository). Everything it would type-check is covered by the scoped `tsc` above; CI runs the real build. |

## 8. Console and tenant surfaces (§7)

- `/platform/messaging` now carries the managed-account console: policy (including funding),
  eligibility probe, account fleet with state/tariff/internal balance/key hint, per-account
  sync/fund/reconcile/rotate/suspend actions, recent jobs, unresolved transfers, 30-day
  margin and recent reconciliation runs. Provider detail is allowed here and nowhere else.
- The Growth messaging card no longer says «وضعیت ارائه‌دهنده»: it renders the contract's
  `service.statusLabel`/`detail` and a first-party action link, so a tenant sees
  «در حال آماده‌سازی» or «کیف پول را شارژ کنید», never a supplier or an error code.
- `/api/platform/sms` and the accounts route both require `messaging.manage`; the security
  page's card gate was corrected to match, so visibility and authorization agree.

## 9. Follow-ups (each needs its own issue)

0. **Campaign-budget and OTP reserved capacity** (#902 §3, P0): the three strategies and the
   guards are in place; "approved campaign budget" as a distinct funding trigger, and a
   reserved slice of master credit that marketing can never consume (so a login OTP is funded
   even when every child is capped), are still open.
1. **Delivery/health dashboards** (#902 P1): per-campaign delivery and provider latency are
   visible through the existing outbox/billing screens; a dedicated panel is a follow-up.
2. **Template automation wiring** (#902 P1): the catalog, the revision/reapproval lifecycle and
   the tenant screen exist; tying approved templates to concrete triggers (login code, order
   ready) is product work. Enabling catalog entries *by business type or plan* is the other half.
3. **Retail ↔ wholesale settlement in invoicing** (billing): the price versions (§6d), the
   margin report and `billing_vendor_cost_events` (§6a) exist; emitting
   `billing_usage_ratings`/invoice lines from the same versions, and reconciling a supplier
   invoice against them, belongs to Billing.
4. **Funding from an authoritative master balance**: the provider's customer API does not
   expose the master's credit, so the floor accepts an operator-supplied balance and refuses
   to fund blindly. A mirror of the panel balance would close the loop.
5. **Managed-service rollout for other integrations**: #894 Torob, #896 Divar, payments,
   media, AI — apply the contract and add leak-guard tests per integration.
6. **`resolveBusinessCapability` follow-up**: audit other callers for the same stale
   `"enabled"` comparison (this change fixed the one in the resolver itself).

## 10. Environment notes

- The sandbox has 3.9 GB RAM and 2 cores; repository-wide `tsc --noEmit` is killed by the OOM
  killer at ≥3.4 GB heap. A scoped `tsconfig` covering all changed files and their imports was
  used for type verification. CI's `test.yml` runs the full type check with more memory.
- `npm ci` and `npm run db:migrate` were run locally; the integration suite creates and drops
  its own scratch database, as the other `integration/*` suites do.
