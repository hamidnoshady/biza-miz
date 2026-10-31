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
- **The §0 inventory is code, not prose** (`src/lib/managed-services/inventory.ts`): every
  provider-backed capability, its credential store, its console and tenant files, and an honest
  maturity (`managed` / `partial` / `vendor_visible` with the issue that finishes it). The table is
  tested like code — the paths it names must exist, a `vendor_visible` entry must carry its
  follow-up, and a service in `MANAGED_SERVICES` must appear in it.
- **The rules are documented once** (`docs/integrations/managed-services.md`), including the
  exceptions that are stated rather than hidden (a gateway's own hosted page during a redirect; the
  MCP panel's Claude/ChatGPT, which are the tenant's own clients; a tenant's own WordPress or SMTP).
- Two real leaks the inventory's guard turned up, both fixed in this slice:
  - the security centre's phone-OTP notice read «سرویس پیامک (کاوه‌نگار)», naming our SMS supplier to
    every owner;
  - the billing page decided its copy from a raw `gateway` string returned by
    `/api/billing/payments`, so the supplier's name travelled into a tenant payload. The API now
    returns `paymentMode: "online" | "manual"` — the distinction the screen actually needs.
- `SUPPLIER_NAME_PATTERN` is now the single definition shared by the payload guard and the source
  guard, and it matches zero-width non-joiner separators: the old pattern only caught «کاوه نگار»
  with a space, not the «کاوه‌نگار» people actually type.

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
| A login code in a production log | The offline fallback logs a live code only when `NODE_ENV` is `development` or `test`; anything else, including unset, refuses (§3a). |

**Discovered while wiring eligibility:** `resolveBusinessCapability()` treated
`app_availability.state` values as `enabled`/`beta`; migration 0128's vocabulary is
`available`/`beta`/…, so every app with an `available` row was denied
`platform_unavailable`. Fixed to use `APP_AVAILABILITY_META[state].usable` (the pure rule the
pages and API guards already use). Without it, no business could ever be eligible for
provisioning.

## 3a. DoD #9: the fallback that wrote login codes into a log

DoD #9 ends with a sentence that is easy to read past — *"No OTP logged in production plaintext via
noop fallback."* The fallback exists for a real reason: an install with no SMS account must still
boot and enrol TOTP, and a developer without a modem has to finish a login somewhere. It printed
`[SMS NOOP] To: … OTP: …`, which is a fine thing for a terminal and a bad thing anywhere else: a
deployment that lost its key, or never had one, answered a login request by writing a live code to
stdout — into a container log, an aggregator, and whoever can read them — while the person waiting
for the SMS got nothing and the challenge stayed worth five minutes of guessing.

The fallback now reads `NODE_ENV` at call time:

| `NODE_ENV` | Behaviour |
| --- | --- |
| `development`, `test` | logs the code, as before — the terminal is the developer's own |
| `production`, `staging`, **unset** | writes one operator line naming the missing configuration (no number, no code) and throws `SmsNotConfiguredError` |

Unset fails closed on purpose: a deployment that forgot to declare its environment is not evidence
that printing login codes is safe. Nothing had to change downstream — every caller already treats a
failed dispatch honestly (`phone-otp` and `mfa-enrol` consume the challenge, `password-reset` revokes
the link, `owner-activation` refuses earlier with a 503 it can explain), so the refusal reaches the
screen as «ارسال پیامک ممکن نشد» instead of a "sent" screen for a message that was never sent.

The other half of DoD #9 — that a login keeps working when Growth is off, a marketing wallet is
empty, a campaign is paused, or a child account is suspended — is structural, and is already
enforced by `kavenegar/lookup-trigger-boundaries.test.ts`: the files that send an OTP may not import
the child credential store, the managed send service or the trigger path, and they resolve their key
only from `platform_sms_config` / `KAVENEGAR_API_KEY`.

## 3b. The audit behind one stale comparison (§9 item 6)

The resolver fix in §3 replaced `state === "enabled"` with the registry's `usable`. That raised the
obvious follow-up — *who else keeps a copy of this vocabulary?* — and the answer was nobody, and that
was the problem: the vocabulary was copied by hand in three places that could each drift from
`app-availability.ts` without a single test failing.

| Finding | Why it mattered |
| --- | --- |
| `setBusinessAppAvailability` / `setPlatformAppAvailability` wrote `write.state` straight to the column | The console route validated with `isAppAvailabilityState`; the MCP tool passed `write as never`. An unknown state from a tool call therefore reached the SQL CHECK and came back as a database error, for what is a client mistake |
| `local-activation-site-service.ts` kept its own `Set(["available", "beta", …])` | A state added to the registry would have been silently dropped when a cloud bundle was applied: the bundle carries it, the deploy skips it, and the app comes back up unchanged with nothing to report |
| `resolveBusinessCapability` cast `state as AppAvailabilityState` | A cast is how the original comparison stayed wrong for so long: the type said the string was a state, so the compiler had nothing to say about it |

The write now validates once, in the one function every caller passes through
(`assertWritable`), refuses with `InvalidAppAvailabilityStateError`, and the MCP tool turns that
refusal into its own `invalid_state` rather than letting a Postgres error escape. The local-activation
importer asks `isAppAvailabilityState`. The resolver asks the type guard and then reads `usable`, so
neither branch can be reached with a string the registry does not know.

**The rule, as a test** (`app-availability-callers.test.ts`): no file outside the registry and its
presentation-only allowlist may decide availability from a hand-written state string; the allowlist
is checked to still exist, so it cannot rot into a no-op; the resolver is checked for the bug's exact
shape (`"enabled"`); both writers are checked to validate; and the TypeScript states are reconciled
against migration `0128`'s two `CHECK` clauses — a state may not exist in one half only.

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
  to act when the master balance is unknown rather than funding through it. The pass reads that
  balance from the provider itself (`account/info`, §5g) once per pass.
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

Still open in §3 and left for a follow-up: the `approved campaign budget` strategy — that needs a
product decision on which campaigns count as approved spend. (The **authoritative master balance**
that used to head this list is closed by §5g; the second half of the same item — a **reserved slice
of master credit that marketing can never consume** — is §5h.)

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

## 5c. The message library: targeting, versions, safe rendering (§5)

§5 asks the platform to own the *messages* — not just approve what tenants write. Three sentences
from the issue drove this slice: "Allow Superadmin enable/disable catalog entries by business
type/channel/plan", "Updating master template must support safe versioned rollout and reapproval
without breaking active sends", and "business-supplied name/amount/order info maps to approved
variables, not arbitrary backend syntax".

**The library is a platform table** (`0264`, `kavenegar_master_templates`): a `key`, a first-party
title, the body the provider will approve, the ordered variables it accepts, and two targeting
arrays — `industries`, `plans`. Empty means everyone, which is the honest default for a login code;
a campaign receipt that only the upper plan pays for is a rule, not a permission, and it is applied
server-side from `businesses.industry` and the subscription's plan. A tenant never reads the table
(platform-only RLS) and never passes an id to get around a rule: it names an entry, and the server
re-resolves eligibility for *that* business. Disabling an entry withdraws the offer and touches
nothing a business already has.

**A copy is a copy** (`instantiateMasterTemplate`): the business gets a `draft` row carrying the
library body, `master_template_id` and the `master_version` it came from. It is created through the
tenant-facing path, so the derived provider name makes the operation idempotent — adding the same
entry twice lands on the same draft. Approval is still the platform's submit path: an unapproved
copy cannot send.

**Versions move only when the message moves.** Saving a changed body/title bumps `version`;
enabling, disabling or retargeting does not, because no business's approved text changes. An
existing copy keeps its own body and its origin version, so a rollout is "instantiate the new
version, approve it, then retire the old one" (the `0260` revision flow already keeps the live row
sending until the successor is approved). A tenant revision of a library copy inherits the lineage.

**Rendering is the security boundary** (`template-variables.ts`, pure): six variables — `code`,
`customer_name`, `store_name`, `order_number`, `amount`, `date` — each with exactly one renderer.
A template declares its variables **in order**, and position is the mapping: `variables[0]` fills
`%token`, `[1]` fills `%token2`, `[2]` fills `%token3`. A body may only use those slots, as a
prefix (no `%token2` without `%token`, no `%token10`, no repeated slot), and a body that cannot be
rendered cannot be saved — so a library entry is never something a business discovers is broken
after approval.

| Variable | Rendered as | Why |
| --- | --- | --- |
| `code` | ASCII digits, 4–8 | a human types an OTP back from the message |
| `customer_name`, `store_name` | whitespace-collapsed text, `%` and control characters stripped, ≤ 25 chars | a `%` in a value would look like a token to the provider's own substitution; a newline breaks the segment |
| `order_number` | `[A-Za-z0-9-]`, ≤ 20 chars | a reference, not a place to put a URL or SQL |
| `amount` | Persian grouped digits, in **rial** | the seeded messages say «ریال», so the unit is never guessed |
| `date` | Jalali `۱۴۰۵/۰۸/۰۶` | a Gregorian date in a Persian SMS reads as foreign |

An invalid value is an error (`variable_invalid`), never a silent truncation into a customer's
inbox; a missing one is `variable_missing`. The same renderer produces the **sample** the tenant
sees before approving — first-party title, readable text, no `%token` and no provider vocabulary.

Surfaces: `GET /api/platform/sms/accounts` returns `masterTemplates` (with `sample` and a
`business_copies` count), `POST {action:"master_template_save"}` upserts, `master_template_toggle`
enables/disables, `template_from_master` gives one business a copy — all audited. Tenants get
`templateLibrary` on `GET /api/messaging` and `lookup_template_from_library` on its POST.

## 5d. Sending one approved message (§5)

A library entry, a copy and a rendered token list are still not a message that reached anyone.
`sendManagedLookup` (`lookup-send-service.ts`) is that last step, and it is deliberately the only
place where the three things that can go wrong at once — credentials, money and the provider's own
rules — are decided together.

**The child's key, not the master's.** `verify/lookup` is authenticated by the key in the URL, so
`buildLookupSendRequest` takes no master key at all: the message leaves the business's own account
and is paid for out of its provider credit. A business with no active child, a suspended one, or an
undecryptable key is refused (`sms_not_ready`) — the managed path never falls back to the platform
key, because that would bill the platform for a tenant's message.

**Retail first, wholesale second.** The tenant is charged Bizamiz retail, priced by the §4 engine
in force at send time; the provider's reported `cost` becomes a `billing_vendor_cost_events` row
with `tenant_visible = false`, so the supplier tariff and the margin never reach the tenant. One
message, one reserve, one settle, at most one refund — the same contract the outbox drain uses.
With no base rate in `platform_message_config` there is nothing honest to charge and the send is
refused (`pricing_unavailable`) rather than priced at a guess; an unreadable *version* table falls
back to the base rate, exactly as the drain does.

**An unknown outcome is not a failure.** `verify/lookup` is a POST: a dropped connection may mean
the message went out. A definitive provider answer (424 template not approved on that child, 411
bad recipient, 418 no credit) refunds in full and reports the provider-neutral code; an *ambiguous*
transport failure keeps the reservation and reports `unknown`. Refunding there would make the same
message free to send twice, and retrying would bill the tenant twice.

**Approved only, mapped only.** A draft, a submitted or a rejected template cannot send — the
provider's rule (424) enforced before the request leaves the building, so the operator sees the
refusal in the console rather than in a failed delivery report. A template with no declared
`variables` (migration `0265`) is refused as `template_variables_undeclared`: positional mapping is
the whole contract, and guessing it would put the wrong value in the wrong sentence. A tenant edit
that would change the number of slots is refused at save time (`variables_mismatch`), so a mapping
cannot be silently invalidated by an edit.

`normalizeReceptor` is the other half of "no billed mistakes": `+98`, `0098`, `98`, Persian digits
and stray separators all become one canonical `09xxxxxxxxx`, and anything that is not an Iranian
mobile is refused before a call is made.

Surfaces: the console's «ارسال آزمایشی» on an approved row — one receptor for the page, a value
input per declared variable, and a notice that distinguishes sent / refused / unknown. The action is
`POST {action:"template_send_test"}`, audited (`sms.managed_account.template_send_test`) with the
outcome, the provider message id and the retail charged. A refusal answers 400 with its code: it is
the operator's answer, not a server fault.

## 5e. Triggers: an event becomes one message (§5)

§5d made a message sendable; nothing yet gave it a reason. The only caller was the console's
«ارسال آزمایشی» — an operator proving a template, not a business telling a customer their order is
ready. `lookup-triggers.ts` is the product half, and it is deliberately small: a closed vocabulary,
the facts each event really has, and a claim that makes one fact one message.

**Two events, and deliberately not a third.** The vocabulary is `order_ready` and
`payment_received`, listed in `lookup-trigger-facts.ts` and again in migration `0266`'s `CHECK`.
`login_code` is absent from both, and that absence is the point: every trigger in this module is a
send on the **business's** child account charged to the **business's** wallet, while a login OTP must
keep working when Growth is off, the child is suspended or the marketing wallet is empty (issue DoD
#9). Adding it would be exactly the outage the issue rules out, so the refusal is in the schema as
well as in the code — and `lookup-trigger-boundaries.test.ts` reads the auth path's imports to prove
the two families cannot borrow each other's credentials in either direction.

**The business's decision, not a default.** `kavenegar_lookup_triggers` holds one row per (business,
trigger) pointing at one of that business's approved messages; the migration seeds none. A trigger
with no row is `trigger_disabled`, and the send log says so — an automation nobody turned on is not
a silent success.

**Facts, not strings.** A trigger is handed typed facts (`customerName`, `amountRial`) and the token
values are built by `triggerValues` against the variables the *template* declares. Formatting stays
in `template-variables.ts` (Persian digits, grouping, a Jalali date), so there is exactly one
formatter in front of the provider. A template declaring a fact its event does not have is refused
at configuration time *and* again at send time (`trigger_variable_unsupported`), because the row
could have been edited in between: positional mapping is what makes the sentence true.

**One fact, one attempt.** `kavenegar_lookup_trigger_sends` is claimed (`pending`) before the
provider is called, with `UNIQUE (business_id, trigger_key, event_key)` on the identity of the
*fact* (`order:<uuid>`) rather than of the attempt. A replayed offline bump, a second terminal
bumping another line of the same ticket, and two bumps racing all resolve to one send — the tests
assert that for both the sequential and the concurrent case. There is no retry queue on purpose:
telling a customer their order is ready twenty minutes later is worse than not telling them, and a
retry is a second charge for one event.

**Consent before money.** A transactional message is not an unconsented one. The dispatcher reads
the customer's own `parties.sms_consent` and a reachable mobile first; a "no" is recorded as
`skipped` with `no_consent` (or `missing_phone`, `no_customer`) so support can answer «چرا پیامک
نیامد؟» with a fact. A skipped or blocked fact is consumed — the event has happened either way.

**Never on the critical path.** Both kitchen sites — the online bump
(`/api/kitchen/items/[itemId]`) and the offline replay (`sync-events.ts`) — fire
`notifyOrderReady` without awaiting it, for the same reason the outbox drain exists: a kitchen bump
must not wait on a provider round trip, and taking money has already committed. Nothing in the
module throws.

**Both product events, wired where they commit.** `order_ready` fires from the online kitchen bump
and from the offline replay; `payment_received` fires from the counter's checkout route and from
the offline replay of a settlement, after `COMMIT` in both cases and never awaited. The other
payment writers — the Woo/CMS importers and the closed-order amendment bridge — write inside their
own transactions and have no post-commit point yet; they are named in the follow-ups rather than
given a hook that would run before the money committed. The receipt carries the amount the cashier
actually took, passed by the caller rather than re-read from `orders.total`, which a later tender or
amendment will have moved.

Surfaces: the Growth card's «پیام‌های خودکار» section now lists both triggers with the approved
messages that can serve them, a status that says «فعال»/«خاموش»/«نیازمند رسیدگی», and one
«فعال کردن»/«خاموش کردن» action (`POST {action:"lookup_trigger"}`). `toTenantLookupTemplates` now
carries `triggers` — the events a message's own variables can fill — so the screen cannot offer an
automation that would be refused at send time.

## 5f. The library a business can actually use (§5, tenant surface)

§5c gave the platform a curated message library and §5e gave a business automations to point at an
approved message. Nothing joined them: the API had returned `templateLibrary` since §5, and no
tenant screen rendered it, so a business's only route to a template was writing one by hand and
waiting for the console to submit it. `template-library-view.ts` and the Growth card close that.

**The screen shows three things, and each is computed rather than copied.** The *sample* is rendered
by `renderTemplateSample` — the same renderer a real send uses — so a preview cannot promise
formatting the send will not produce. The *variables* are the entry's ordered domain vocabulary,
named in Persian (`نام مشتری`, `مبلغ (ریال)`) instead of `%token2`, and a variable outside that
vocabulary is dropped rather than displayed as our notation. The *automations* an entry can serve are
computed by `checkTriggerTemplate` — the same check `sendManagedLookup` refuses with — so the screen
cannot offer a pairing the server would reject.

**Adding one is a draft, not a switch.** The action is the existing
`POST {action:"lookup_template_from_library"}`; the server re-resolves eligibility by id (a disabled
entry, or one targeted at another trade, is a refusal, not "look it up by id"), creates a `draft`,
and the platform's submit path asks the provider for approval. The notice therefore says «برای
بررسی ثبت می‌شود», and the entry stays visible in the list marked «در فهرست شما» — a person should
not have to guess whether the click worked.

**What the screen does not say.** No provider name, no provider template id, no approval
vocabulary and no wholesale price: `managed-services/inventory.test.ts` reads every tenant screen
for supplier names, and `template-library-view.test.ts` checks the rendered view against the same
pattern.

## 5g. The master's own balance, read instead of typed (§3, plan item 4)

The funding plan has refused to move money through a floor it could not see since §5 — and the
scheduled pass had no balance to give it. Every automatic top-up therefore died on
`master_balance_unknown` for exactly the operators careful enough to configure a floor, and the
fleet was only funded when a human read the provider's panel and typed a number into the console.
The guard was right; what was missing was the number.

**The customer API does not expose the parent's credit, but the account endpoint does.** `GET
/v1/{KEY}/account/info.json` describes whichever account the key belongs to, so the master key's own
answer *is* the master's credit. `KavenegarManagementClient.fetchAccountInfo()` reads it once per
pass — not once per child, because the figure is the same for the fleet and the alternative
multiplies provider traffic by the number of tenants.

Three decisions matter:

| Decision | Why |
| --- | --- |
| A missing or unparseable `remaincredit` is `null`, never `0` | "The provider said zero" and "the provider said nothing I could read" are opposite facts to a floor; collapsing the second into the first would make a funded master look empty |
| A failed read is swallowed into `null`, with one log line | A provider hiccup must not turn a funding pass into an incident, and `null` already has an honest meaning: refuse, and raise `master_balance_unknown` for the operator |
| An explicit `masterBalanceRial` still wins | The console's manual transfer and every existing test pass a figure on purpose; the read is the *default*, not a replacement |

The provider's echo of the key in that payload is dropped during mapping, the read is a GET (so the
transport may retry it), and the log line carries the reason rather than the URL.

With the figure real, `master_balance_unknown` stops being a routine warning: it now means the read
failed, so its remedy in both the alert ledger and the console changed from «read the panel and type
it in» to «check the master key and the connection; the pass reads the balance itself».

## 5h. A reserved slice marketing can never spend (§3, DoD #9)

DoD #9 says a login OTP must keep working when "every child is capped" and when "tenant marketing
credit is exhausted". §5g made the funding pass able to *see* the master's credit; it did not give
the fleet a way to keep any of it. The floor alone cannot do this job: once the master drifts down to
the floor, automation stops funding **everyone** — the message that then fails to go out is the login
code a customer is waiting for, while a campaign funded an hour earlier has already been sent.

The distinction the floor cannot make is *why* a message is being sent, and the platform cannot infer
it: the same child account carries a campaign and an order-ready message. So migration `0267` adds
the two things only an operator can decide, and `planFunding` enforces them:

| Column | Meaning |
| --- | --- |
| `managed_funding_transactional_reserve_rial` | credit above the floor that marketing may not spend; `0` (the default) means no reserve |
| `managed_funding_purpose` | `marketing` (default) or `transactional` — how this fleet's provider spend is classified |

The rule is one line in the planner: spendable = master − floor, and marketing may use
`spendable − reserve`. A blocked marketing transfer reports `transactional_reserve`, **not**
`master_floor`, and raises its own warning (`transactional_reserve_held`): an operator told "credit
low" would top up a master account that is not short, so the words have to distinguish "the money is
gone" from "the money is held". `marketing` is the default and the restrictive side, so enabling a
reserve can only ever hold capacity back — never let more money out by accident.

**What this does not do.** The provider has no concept of a reserved balance, so this is enforced on
our side of the call, not in the provider's ledger: it governs *funding*, and it protects the
transactional lane from being starved by funding decisions. It is not a second wallet, and a child
that already holds credit is unaffected by it.

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

Still open in §5 and left for the follow-ups below: wiring an approved template to a concrete send
(`sendManagedLookup`) once reserve/settle is in place. The audit view is §6f.
Targeting by business type/plan shipped in §5c, the delivery dashboard in §6c.

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

The dedicated audit view landed as §6f: not a second page, but the shared log with the `sms` family
and a per-account deep link — the rows were always there, they just read as raw strings.

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

## 6e. Delivery per campaign, with the two waits apart (§6, plan item 2)

§6c answered the fleet question — "are messages arriving, and for whom" — from the outbox, per
business, over 24 hours. The question a *business* asks is smaller and sharper: did my campaign
arrive, and if it was slow, was it us or the carrier? Answering it needed a different grouping and a
second clock.

**Only half the latency was provable.** `0134` records when a row was queued (`created_at`), when it
was attempted (`last_attempt_at`) and when the provider accepted it (`sent_at`), so the *queue* wait
is derivable — `sent_at − created_at`. The provider's own answer time was thrown away by the drain the
moment `send()` returned, which made "backed-up drain" and "slow carrier" indistinguishable even
though they have opposite fixes. Migration `0268` adds `send_latency_ms`, written on every attempt
(accepted or refused) from the drain's own clock, nullable because every row queued before it has no
measurement.

`campaign-delivery-report.ts` then answers per campaign: accepted, delivered, failed, still queued,
the verdict from §6c's `deliveryHealth`, and **two** percentile summaries — queue and send.

| Rule | Why |
| --- | --- |
| Percentiles, not an average | One 90-second retry moves an average far enough to hide a healthy fleet; p50 answers "is it fine", p95 answers "is anyone hurting" |
| `null` for no measurement, never `0` | "We measured nothing" and "it took no time" are opposite statements, and `0 ms` for silence is a number an operator quotes in a meeting |
| A tenant sees its own campaigns only | The platform report names businesses and reads across tenants under the bypass; `tenantCampaignDelivery` is scoped by the caller *and* by RLS, and neither carries a provider error string, provider name or wholesale cost |

Surfaces: the console's «تحویل به تفکیک کمپین (۷ روز اخیر)» table under the 24-hour fleet card, and a
second line under each campaign on the tenant's Growth messaging screen («تأخیر صف» / «تأخیر ارسال»,
in «—» when nothing was measured).

## 6f. The audit view is the shared log, filtered (§6)

§6 asked for an audit view of the managed-SMS control plane. The rows were already being written —
every provisioning job, suspension, transfer, funding pass, reconciliation, policy change, template
submit and test send goes through `platformAudit` — but the console linked to the unfiltered log, and
the log had no idea what an `sms.*` action was. An operator investigating a suspension saw
`sms.managed_account.suspend` as literal text with a generic icon, mixed into every other privileged
action in the platform.

Copying the log into a messaging-only page would have been the wrong fix: a second place to read
events, drifting from the first. Instead the shared page learned the vocabulary.

- Every `sms.*` action now has a Persian label, a status tone and an icon — a suspension in
  `warning`, a test send in `info` because it spends real money at the provider and reaches a real
  handset, a key rotation in `warning` even though nothing failed, since it invalidates the credential
  the drain is holding.
- `AUDIT_ACTION_FAMILIES` gains «پیامک مدیریت‌شده» (`sms`). The API already matched the family as a
  prefix (`action LIKE '<value>%'`), so one entry filters the whole plane.
- The messaging console links into it twice: «همهٔ رویدادهای پیامک مدیریت‌شده ←» for the fleet, and
  per account «رویدادهای این حساب ←» (`?actionFamily=sms&businessId=…`), which lands on the account's
  own history with the detail drawer intact.

The guard is a sweep, not a list: `action-meta.test.ts` reads the actions back out of the two routes
that write them **and** follows the `jobKindFor` switch that produces
`sms.managed_account.${action}`, so a tenth job kind cannot ship unlabeled. It also asserts the two
deep links keep their `actionFamily=sms` parameter — the exact thing that was missing.

## 5i. The master balance the last pass saw (§9 item 4, second half)

§5g made the funding pass read the master's own credit from the provider instead of trusting a number
an operator typed once. That fixed the *decision* and left the *evidence* missing: the figure lived in
the tick's local variable and vanished when the tick returned, so the console could not show it, and
an operator asking "how much headroom is left above the floor?" had to read it live, by hand, from the
provider — from a screen, on a whim, with their own eyes.

Migration `0269` adds three columns to `platform_sms_config` (one row, the same row the policy lives
in — no new table, no new key, no tenant scope):

| Column | Why it is separate |
| --- | --- |
| `managed_master_balance_rial` | the figure the provider reported; `NULL` when it never said |
| `managed_master_balance_at` | when that figure was observed — a balance with no age is a rumour |
| `managed_master_balance_checked_at` | when a pass last *tried*; newer than `..._at` means the last read failed |

Collapsing those last two into one timestamp is exactly how a stale figure comes to look live. A
pairing `CHECK` forbids a value without its observation time.

`masterBalanceView()` turns the stored triple into one of four verdicts, and the console renders each
differently: `unknown` (never observed — not zero, not "fine"), `current` (recent, last read did not
fail), `unreadable` (observed once, a later pass could not read it — honest history, not a claim about
now), `stale` (older than six hours, i.e. six missed passes). `unreadable` outranks `stale`: the
failure is the more urgent fact.

The rules live in `master-balance-facts.ts` and the two statements in `master-balance.ts`, because the
console is a client component: `client-bundle-boundary.test.ts` refused the first version, which
imported the constant straight from the module that owns the pool. The split is the fix it asked for,
not a suppression.

Only a pass that read the provider writes the value. An operator's typed figure is an *instruction*,
not an observation, and must never overwrite evidence about what the provider said — which is why
`runManagedFundingTick` guards the write on `masterBalanceRial === undefined`, and why a mirror write
that fails is logged and swallowed: the money decision is the job, the evidence is the bonus.

## 5j. An approved campaign is a funding trigger of its own (§9 item 1)

Funding was sized by the *policy*: "keep 100 messages of credit on every child". That is a standing
order, and it is right for a steady trickle. It is wrong for the thing this platform is actually used
for — a business approves an audience of 500 and sends it. The pool then needs 500 messages of
provider credit while the standing order still asks for 100, so the drain runs out mid-campaign, the
provider refuses the tail with its credit error, and every remaining recipient is marked `failed` for
a reason the business never chose and cannot see.

The missing trigger is the **work already queued**, and no product decision is needed to define it: an
approved campaign has its recipients materialized in `message_recipients` and its sends queued in
`message_outbox` — that pair *is* the approval, because nothing is enqueued for an audience nobody
approved. So the demand is a query, not a forecast.

| Rule | Why |
| --- | --- |
| Demand is counted in **segments**, not recipients | The provider bills per 70-character segment. A per-recipient count under-funds every multipart campaign by a factor of two or three, and does it quietly |
| The SQL segment expression is built from the billing constants | `smsSegmentsSql()` interpolates `SMS_FIRST_SEGMENT_CHARS`/`SMS_NEXT_SEGMENT_CHARS`, so the funding target and the invoice cannot drift; it refuses anything that is not a plain column reference |
| The target becomes `max(buffer, demand)`, never `demand` alone | A small campaign must not let the standing order lapse. Demand raises the target; it does not replace it |
| The **trigger** moves with the target | `low_watermark`'s hysteresis would otherwise pace a campaign that is already draining |
| Only `queued` and `sending` count | `sent`/`delivered`/`failed` are settled questions; counting them would make the target grow forever on a busy business's history |
| The transfer reason distinguishes the two triggers | `campaign_demand` versus `top_up`: "running low" and "500 messages are waiting" are different instructions to whoever reads the ledger |
| Everything else still applies | Caps, the master floor, the transactional reserve and the fleet cap clamp the amount exactly as before. Demand is a target, not a bypass |
| Read inside the funding transaction, scoped to the child | The decision must see the queue as it is at the moment of the decision, and one tenant's campaign must never fund another tenant's child |

One correction worth recording: the channel lives on `message_recipients`, not on `message_outbox`,
and the first version filtered `o.channel` — a column that does not exist. Only the database suite
caught it; the unit guards now assert `r.channel` and the absence of `o.channel` so the mistake cannot
return quietly.

`planBusinessFunding` reads the same demand, so the console's "what would a pass do" preview cannot
promise a healthy child a transfer it is about to receive — or the reverse. The console's account rows
add «صف فعال: N پیام (M قطعه) در K کمپین» when a queue exists, which is the sentence that makes a
transfer above the buffer legible instead of arbitrary. Counts only: the money it implies is the
planner's arithmetic, and a second copy of it in a React file is how two answers start.

## 5k. A trigger shows its text and its record (§9 item 0)

§5e/§5f gave the tenant a switch per automation: on or off, attached to an approved message. A switch
is not an answer to either question a business actually has — *what will my customer read?* and *did
it work?*

**The preview is the message.** §9 item 0 asked for "a tenant preview of a trigger's exact text before
enabling it", and the word *exact* is the whole design: a hand-written sample on the screen can
disagree with the message that goes out, and the tenant would find out from a customer. So
`previewTriggerMessage()` runs the dispatcher's own two functions — `triggerValues()` then
`renderTemplateTokens()` — over obviously-fake facts («سارا محمدی», a 250,000 Rial payment). The
preview therefore shows the renderer's money formatting and Jalali date, not a second formatter's
idea of them. A pair that cannot render is `null` and renders nothing: "we cannot show this" and "the
message is blank" are different claims, and only one of them is true.

**The record is per trigger.** `kavenegar_lookup_trigger_sends` already holds one row per (business,
trigger, fact) with a status and a provider-neutral code; `listTriggerSettings` now aggregates it over
a week — sent, skipped, blocked, failed, unknown, the last attempt and the last code. Sent and skipped
are counted **apart** on purpose: a screen showing only zeros must let a business tell "nobody ordered"
from "we are refusing every message because consent is missing", and those two have completely
different fixes.

`lastCode` is the most recent attempt that *had* a code, not the most recent attempt: a successful
send stores `NULL`, so "latest row wins" made the reason vanish the moment a retry worked — and a
batch written in one statement shares a timestamp, which made it arbitrary as well. The first CI run
of the database case caught exactly that.

Codes are translated by one shared map (`TRIGGER_CODE_LABELS`), imported by the client rather than
copied into it — a code this build does not know becomes «پیام ارسال نشد», never the raw string, so a
future or provider-shaped code cannot reach a tenant screen verbatim.

## 5l. Every payment path tells the customer (§9 item 0)

§5e wired the receipt trigger into the two paths that existed for the *counter*: the checkout route and
the offline replay. Three paths that also record a payment were left out, and they are the ones where a
receipt matters most — the customer is not standing in front of you:

| Path | What it records |
| --- | --- |
| `ingestFnBOrder` (plugin/WooCommerce) | an online ticket, closed to `completed` with an `online` payment |
| `ingestRetailOrder` (plugin/WooCommerce) | the same for a goods retailer, through the batch/FEFO service |
| `importPaidCmsOrder` (CMS storefront) | a `order.paid` delivery from the business's own site |

All three now call `notifyPaymentReceived` **after** their `COMMIT` and **not awaited**: notifying
inside the transaction would send a receipt for a sale that could still roll back, and awaiting would
put a provider round trip between the webhook and its response — then a failed message would fail an
import that had already committed.

Two details that are easy to get wrong and are now asserted:

- **The scope.** A webhook and a CMS delivery carry no request session, and the lookup tables are
  tenant-RLS, so an unscoped read finds no order and the receipt is silently never attempted. Each
  call is wrapped in `withTenant(businessId, …)`.
- **The amount.** `Number(total)` — the figure on the payment row that was just committed, not the
  order's `total` re-read later (an amendment moves that, and a receipt has to say what the customer
  paid).

**The amendment bridge is deliberately excluded,** with the reason written next to the code: an
amendment *rewrites* what was already paid (old rows superseded, new rows tagged), so no money changed
hands again. A second «پرداخت ثبت شد» would tell the customer they had been charged twice. A refund or
a genuine additional tender has its own path and its own trigger. `imported-payment-receipts.test.ts`
fails if someone adds the call back without reading that note.

The same guard test checks the shape of all three wirings: the call exists, it follows `COMMIT`, it is
not awaited, and it is business-scoped — because "the dispatcher works" was never the missing part.

## 5m. A rating cites the price that produced it (§9 item 3, part one)

Two ledgers record every message. The **wallet** says what the business paid; the **Billing rating**
(`billing_usage_ratings`) says what the platform booked as usage. The margin report is the subtraction
of the two, and the supplier reconciliation is the comparison of the second against
`billing_vendor_cost_events` — which means the rating's *provenance* is not documentation, it is the
control. If a rating cannot name the price version that produced its amount, neither report means
anything: they are comparing two numbers whose origins nobody can check.

The rating had exactly one provenance column, `price_version_id`, foreign-keyed to
`billing_price_versions` — the **meter** catalogue. Messaging is priced by
`kavenegar_retail_price_versions` instead, so every messaging rating cited a version whose numbers had
never been used to compute the amount beside it. The true version existed only inside
`billing_vendor_cost_events.metadata` and the wallet metadata: JSON, unjoinable, and invisible to the
two reports that most need it.

The advice to follow here is Billing's own: *an amount is not evidence of how it was computed.* So the
fix is not to change any money. It is to make the row say what happened to it:

| `price_basis` | When | What it cites |
| --- | --- | --- |
| `retail_price_version` | the send was priced by the published retail version (§6d) | `retail_price_version_id` + the human-readable `retail_price_version`; `price_version_id` is **NULL** |
| `explicit_amount` | the caller computed the amount itself (`ratedAmountRial`) and no retail version applies | nothing — a price version it did not use is not a citation |
| `meter_price_version` | ordinary metered usage rated from `billing_price_versions` | `price_version_id`, as before |
| `NULL` | the row was written before this migration | nothing, and it says nothing — a guess would be indistinguishable from evidence |

Three details that make this safe to ship over existing data:

- **No backfill.** `0270` adds the column with no default and no `UPDATE`. A row written before today
  genuinely has no recorded basis, and the same rule as `0268`'s `send_latency_ms` applies: unknown is a
  real answer.
- **The CHECKs let legacy rows pass.** Each is written as a pairing over `IS NOT NULL`, so an all-NULL
  row evaluates to NULL rather than FALSE and is accepted, while a row that claims
  `retail_price_version` without an id is refused at insert time.
- **A retail row cannot point at the meter catalogue.** The third CHECK enforces
  `price_version_id IS NULL` when the basis is retail. This is what stops someone from "helpfully"
  filling both columns later and restoring exactly the false provenance this replaces.

The rule itself is one pure function, `resolveRatingBasis()` in `src/lib/billing/rating-basis.ts` — pure
because the callers include a React-adjacent module, and a browser import of `../db` is a build failure
(`client-bundle-boundary.test.ts`). `runtime.appendUsageEvent` makes the decision once and both INSERT
branches (rating created vs. rating upserted under a correction) write the same three columns, so a
correction cannot silently keep an older basis. `message-outbox-service` passes the exact version the
drain priced with — the same object whose `version.id` the retail quote already used.

**A bug this slice found, and had to fix.** Writing the case that asserts "what left the wallet equals
what was rated" is what made it visible: the drain's success branch added `rowCost` to `sentCost`
twice. Because `settleMessageSend` charges `min(actual, reserved)`, doubling `actual` did not overcharge
a clean batch — it charged the **entire reservation** for any batch containing one refused row, and
refunded nothing. In other words the §4 `refund` policy — "a send the provider never accepted is not
charged to the tenant" — was inverted in the one case it exists for, and the business paid for messages
that were never sent. Nothing tested it: no unit test drove the drain, and every database test settled
through `settleMessageSend` directly. The duplicate is gone, the increment is now guarded (one occurrence,
counted by `rating-basis.test.ts`), and `messaging-usage-rating` drives a real drain with a scripted
provider that refuses one row of three and asserts the money out equals the sum of the ratings.

Two smaller notes. The database test needed a transport seam — the drain builds its providers from
config, and a test may not call a real provider — so `runBusinessMessageDrain` takes an optional third
argument that defaults to `buildProviders(effective)`; production passes nothing. And the meter-version
publish in that test is back-dated by a minute on purpose: `publishPriceVersion` defaults to `now()`
while the event is rated at the JS clock's `now()`, which can sit a millisecond behind the database's.

One correction worth recording: the first version of `resolveRatingBasis` *clamped* a negative version
number to `0`. Zero already means "the built-in default", so that turned nonsense into a specific and
wrong claim — the same class of bug this slice exists to remove. It now rejects a non-finite or
negative version and falls through to `explicit_amount`, and `rating-basis.test.ts` pins it.

What this does **not** do, and should not pretend to: generate invoice lines from ratings, or reconcile a
supplier's invoice against `billing_vendor_cost_events`. Those are Billing's own work (§9 item 3's other
half) and now have the join they were missing.

## 5n. Usage that was rated becomes a bill (§9 item 3, part two)

§5m made a rating say which price produced its amount. That answers the question for one row. It does
not answer the question a business asks when a bill arrives — *what is this for, and on what terms?* —
and until this slice there was no answer at all: `billing_invoice_lines` had **no `kind = 'usage'`
writer**. Usage was reported (the ratings, the spend breakdown, the console) and separately invoiced
(subscriptions, add-ons, the website service), and the two ledgers never met. A business could have a
month of rated usage and no line describing it.

The line is the join, and the design follows from what a reader must be able to check:

| Rule | Why |
| --- | --- |
| A line is one **meter + one price version** | Two rows of the same meter in one month can have been priced by two retail versions — a promotion ended, a markup changed. Folding them into one line gives "which version?" a blended, false answer, which is exactly the lie 0270 removed from the ratings |
| `amount_rial` is the **sum of the ratings**, and the unit price is derived from it | The amount is what is billed. Deriving the amount from a rounded unit would leave a Rial unexplained on any line whose quantity does not divide evenly; a test pins 10 Rial over 3 units as 10, not 9 |
| Every rating is **linked** to the line it was billed on, with what it contributed | A line that does not add up to its parts is a bill nobody can defend. The link also answers "has this been billed?" without arithmetic |
| One rating is billable **once, ever** (`UNIQUE (usage_event_id)`) | The invoice's own `UNIQUE (business_id, reference)` claim stops a second invoice for the same month. It does **not** stop a late event with an occurrence date in an earlier window from being collected again by the next month's run. The index is the guarantee; the application code is not |
| Wallet-backed usage is **never** invoiced | That money already left the wallet. The same `walletBacked = false` predicate the spend breakdown uses decides it — one definition of "billable outside the wallet", asserted by a test so the two cannot drift into two answers |
| A zero-rated event produces **no line**, but is still counted | A line of ۰ ریال is not something anyone can pay, and it would fill every invoice with rows that were entirely inside a plan allowance. `ratingCount` versus `billedCount` is what tells an operator "no usage" from "usage, all of it free" |
| A pre-0270 rating is **billed without a citation** | It has no recorded basis. Refusing to bill it would let an accounting change decide whether a business owes money |
| An **open** invoice accepts a rating that arrived late; a paid one does not | A crash between the claim and the lines must not strand an empty invoice, and a genuinely late rating should reach the bill it belongs to. But rewriting a settled document is how a customer is charged twice for one thing and then disputes everything after it — so a closed invoice returns `invoice_closed` and the rating waits for an amendment |

**What a repeat run says.** Issuing again for a month that is already billed is not an error and not a
silent no-op. It returns the invoice that exists, with that invoice's own total and line count, and a
reason: `already_invoiced` (nothing new), `invoice_closed` (new usage, but the document is settled) or
`nothing_to_bill` (no usage, no invoice). The first version returned `totalRial: 0` for the repeat case,
which reads as "the invoice vanished" — the kind of answer that makes an operator issue a second one by
hand. The database suite caught it; the case is now asserted.

**It is an operator action, not a timer, and that is a deliberate line.** Post-paid metered usage is a
commercial decision. Today essentially every rateable event is wallet-backed — `ai`, `media`,
`messaging`, activation all mark theirs — so a monthly pass would be inert now and would start billing
people the day some new source rates without charging. `POST /api/platform/billing/usage-invoices`
issues (capability `billing.manage`, audited with the invoice it created); `GET` previews a month
(`billing.view`) so the decision can be made from real numbers. The month's key is `usage:<YYYY-MM>`,
and its window comes from the same `tehranMonthWindow` the spend report uses — anchored on the 15th at
noon UTC, so the key unambiguously names the month it bills.

**The portability lesson, again.** The dry run of this slice's own SQL is where a slice like this is
usually wrong, and this repository has no local Postgres: the database suite is the only proof, so it is
written to test the constraint rather than the happy path — it asserts that a *second* link for the same
rating is rejected by `billing_invoice_line_usage_once`, not that the service avoids writing one.

What is **still** Billing's own work: reconciling a supplier's invoice against
`billing_vendor_cost_events`. That is the last half of §9 item 3, and it now has both halves it needs —
the rated amount with its citation (§5m) and the invoiced amount with its citation (§5n).

## 5o. The long view: delivery over months (§9 item 2, part two)

§6e answered the question an operator asks while a campaign is running — *is it arriving, and at
which end is it slow* — over seven days. It cannot answer the one they ask after a bad month: **was
last month worse, and did it get worse gradually or fall off a cliff?** A row cannot be a series.

The data was already there. `message_outbox` keeps every row (nothing prunes it, unlike the
integration queues), and `0134`/`0268` already carry the enqueue and provider clocks. So this slice is
a query and a shape — no new columns, no new table, no new tick.

What it had to get right, in the order the mistakes would appear:

| Rule | The failure it prevents |
| --- | --- |
| A bucket with **no attempts is a gap**, not a zero | Silence and total failure draw identically on a chart that plots zeros. An operator then chases a collapse that never happened — and a real one looks the same as the false one |
| `failureRate` is **`null`** when nothing was decided, never `۰٪` | A week of no sends has no failure rate. Printing zero is a claim, and a flattering one |
| Buckets are cut on the **Tehran calendar**, in SQL, by the same key the facts module builds | Grouping `created_at` in UTC moves every Iranian evening (21:00 UTC = 00:30 Tehran) into the next day, so the trend would disagree with every other figure in the product |
| Granularity follows the span: **days ≤ 31, weeks ≤ 120, months beyond** | 365 daily bars is not a chart, and a single constant granularity is wrong at one end of the range whichever one is chosen |
| Latencies are **pooled over the window**, not averaged per bucket | An average of medians is not a median, and it weights a two-message week like a two-thousand-message one. The test asserts the pooled p50 on a 1 000:1 split |
| The tenant series is **business-scoped and RLS-scoped**, and selects no provider field | A trend is still a tenant surface. Counts and latencies only: no provider id, no error string, no wholesale cost |

Two side effects worth naming. `deliveryHealth()` and `latencyStats()` moved out of the two reporting
modules into `delivery-health.ts` and `latency-stats.ts`, both pure, because a third caller (the trend)
and a client component (the console card) both need them — the card had been keeping a hand-copy of the
thresholds with a comment saying it mirrored the server, which is how a rule becomes two rules; it now
imports the one function. And the screens say the quiet part out loud: the console card draws an empty
dashed box for a bucket with no sends and a note that «کادر خالی یعنی … هیچ ارسالی ثبت نشده — نه اینکه
همه شکست خورده باشند», and the tenant card carries the same note in the business's own words.

That closes §9 item 2: §6e gave the per-campaign view, this gives the window that contains it.

## 7. Verification run

| Gate | Result |
| --- | --- |
| `npx tsc -p <scoped tsconfig>` covering every changed file and its dependency graph | pass (the repository-wide `tsc --noEmit` exceeds this sandbox's 3.9 GB and is killed by the OOM killer; see §10) |
| `npx vitest run` — new unit files | 170 tests pass across 11 files (`retail-pricing` adds 27, `alert-service` adds 13, `template-variables` adds 21) (`contract`, `client`, `rest`, `secrets`, `provisioning`, `pricing-service`, `template-service`, `reconciliation-service`) |
| `npm test` (full suite) | 1223 files, 15,333 tests pass, 7 skipped, exit 0 (one unrelated guard, `brand-coverage`, caught a `Bizamiz`→`Bizamiz` copy slip in new comments; fixed) |
| `npm run test:db` — `kavenegar-managed-accounts` | 46/46 pass |
| `npx vitest run` — `client` + `rest` + `pricing-service` (§5g) | 4 new fixtures: `account/info` addressed under the master key and never a child's, a real `0` kept distinct from an unreadable balance, the key the payload echoes dropped, a refused read surfacing as an error the pass turns into `null` (and a log line with no credential in it) |
| `npx vitest run` — `pricing-service` + `alert-service` (§5h) | 6 new fixtures: marketing clamped to `spendable − reserve` rather than the target, the reserve's own blocked reason, transactional funding reaching the same target, the floor still ahead of the reserve for both purposes, the rule inert at reserve `0`, and `transactional_reserve_held` carrying its own copy rather than "credit low" |
| `npm run test:db` — `kavenegar-managed-accounts` (§5h) | one added case: the policy round-trips, marketing funds the buffer while it has room above the reserve, is refused with `transactional_reserve` once only the reserve is left, and funds again the moment the fleet is classified `transactional` |
| `npm run test:db` — `kavenegar-managed-accounts` (§5g) | two added cases: a floored fleet funds with no operator figure (the pass calls `account/info` first, then `chargecredit`), and an unreadable master balance funds nothing and leaves `master_balance_unknown` open |

| `npm run test:db` — `kavenegar-master-templates` | 16/16 pass (targeting by trade and plan, idempotent instantiation of a copy, versioned rollout that leaves the live copy alone, lineage through a revision, platform-only RLS) |
| `npm run test:db` — `kavenegar-lookup-send` | 8/8 pass (approved-only, undeclared mapping, bad receptor, no child, invalid value → refused before a charge; a successful send charges retail once, records the wholesale cost tenant-invisibly and calls the child's key; a definitive refusal refunds in full; an ambiguous failure keeps the reservation) |
| `npm run test:db` — `kavenegar-lookup-triggers` | 17/17 pass (a message that is not approved, has no mapping or wants a fact the event does not have is refused when the automation is saved; `login_code` is refused as a trigger; an unconfigured trigger sends nothing; one event sends once on the child's key, charges retail once and logs it; a replay is `duplicate`; two racing bumps produce one provider call; an empty wallet blocks before the provider is called; `notifyOrderReady` reads the order/customer/store, honours «پیامک نفرست», skips an anonymous order and an unusable mobile; `notifyPaymentReceived` sends the receipt with the amount in Persian digits and one receipt per replayed settlement; neither notifier throws) |
| `npx vitest run` — `lookup-trigger-facts` + `lookup-trigger-boundaries` | 15/15 pass (closed vocabulary including the `login_code` refusal, fact→variable mapping, template fits, fact keys; and the auth path's imports and the schema CHECK) |
| `npx vitest run` — `lookup-send.test.ts` | 7/7 pass (receptor normalisation, the child-key request shape, slot spelling, cost mapping) on a migrated database, fake transport, no network (5 for the §6b lifecycle, 3 for the §5a strategies, 1 for the §6c delivery report, 3 for the §6a wholesale-cost ledger) |
| `npm run test:db` — `kavenegar-retail-pricing` | 13/13 pass: version windows, back-date refusal, persisted markup/surcharge/tax/allowance, slab tiering from recorded usage, business and channel exceptions, reserve → settle → refund-once, supplier cost posted once and hidden from a tenant connection, RLS forced on the three new tables |
| `npx vitest run` — `imported-payment-receipts` (§5l) | 6/6: both plugin importers (F&B and retail) and the CMS importer call the receipt trigger, in every case after `COMMIT`, never awaited, and wrapped in `withTenant` — plus the amount being the same `total` the payment row was written with; and the amendment bridge carrying no call at all, with its reason still in the file |
| `npx vitest run` — `delivery-trend` (§5o) | 18/18: granularity from the span (day/week/month) and a contiguous series ending today; Tehran day keys (21:00 UTC is tomorrow) and Monday-start weeks (a Sunday belongs to the week before); a bucket with no rows is `hasData: false` with a `null` rate and `idle`, and an in-flight-only bucket is data with no rate; the rate is over decided attempts only; a bucket outside the window is dropped; the window's latency is pooled rather than averaged from medians (the 1 000:1 case); worst verdict and newest-first health; bars scaled to the busiest bucket with a visible minimum and `null` for an empty window; plus the guards — SQL groups on `Asia/Tehran` at every granularity, the tenant query is `withTenant` + `business_id`, no provider field is selected, the window clamps to a year, and both screens render server-computed points with the shared health rule and no hand-copied thresholds |
| `npm run test:db` — `delivery-trend` (§5o) | CI only (no Postgres here): a 21:00 UTC send lands on the next Tehran day while a 19:00 UTC one stays on today (the UTC-grouping bug, asserted against Postgres); empty buckets stay gaps with no rate; a quarter rolls into weeks and a Sunday falls in the previous week; the window pools queue and provider latencies from the outbox's own columns; a failure counts as a decided attempt; each business sees only its own series while the fleet view counts rows across both and businesses once each |
| `npx vitest run` — `usage-invoice` (§5n) | 16/16: ratings of one meter and version fold into one line whose amount is the sum of its parts; a mid-month price change splits into two lines, each citing one version; a retail line and a meter line for the same meter never cross catalogues; an allowance-covered rating bills nothing but is still counted; a pre-0270 rating is billed without a citation; 10 Rial over 3 units stays 10; a negative rating is dropped rather than credited; descriptions carry the catalogue's Persian name, the basis label and the version in Persian digits and no supplier word; plus the schema guards (0275's pairing CHECKs, `kind = 'usage'`, the one-billing-ever index, forced RLS), the writer's linkage and the route's two capabilities |
| `npm run test:db` — `billing-usage-invoice` (§5n) | CI only (no Postgres here): a month of ratings becomes one invoice with one line per meter-and-version, each rating linked with what it contributed and the lines summing to the invoice; wallet-backed usage is left out; a month with nothing unbilled creates no invoice; issuing twice finds the same invoice and writes no second line; the database refuses a second link for the same rating; a late rating extends an open invoice and is refused by a paid one; another business's usage is not invoiced |
| `npx vitest run` — `rating-basis` (§5m) | 11/11: retail wins and nulls the meter column; explicit amount cites nothing; meter stays the fallback; a zero version is a real default while a negative or non-finite one is rejected rather than clamped; plus source guards on both INSERT branches, the migration's pairing CHECK, and the drain passing the version it priced with |
| `npm run test:db` — `messaging-usage-rating` (§5m) | CI only (no Postgres here): a drained send takes exactly what it rates out of the wallet and cites `retail_price_version` `7` by id and number with `price_version_id` NULL; a three-recipient batch rates as one version and sums to the single reservation; a batch where the provider refuses one of three charges and rates only the two that went out (the case the double-count broke); an `explicit_amount` rating stays uncited even with a meter version published; a metered event still cites the published meter version |
| `npx vitest run` — `lookup-trigger-facts` (§5k) | 6 new fixtures: the preview rendered by the dispatcher's renderer (no `%token` left, the amount formatted as money and the date as Jalali rather than the raw rial integer or an ISO string); a template whose variables the event cannot fill previewing as `null` rather than blank; and the code map translating the refusals a tenant can act on while a code it does not know — `http_429`, `kavenegar_418` — becomes a generic sentence instead of leaking |
| `npx vitest run` — Growth messaging section (§5k) | 3 new source guards: the screen renders `setting.preview` from the server and hard-codes no sample text of its own; the delivery line exists and speaks its zeros; and the code labels are imported from the shared map rather than copied into the component |
| `npm run test:db` — `kavenegar-lookup-triggers` (§5k) | one added case (CI only; no Postgres here): the setting carries a real preview before anything has been sent, `delivery` reads `{sent: 0, skipped: 0}`; after one sent row, one consent refusal and one unknown payment row the two triggers report `{sent: 1, skipped: 1}` and `{unknown: 1}` with `lastCode` `no_consent`, and another business sees none of it |
| `npx vitest run` — `campaign-demand` (§5j) | 8/8: demand priced per segment rather than per recipient, zero for an empty queue and never negative, zero when there is no tariff; only `queued`/`sending` counted; the SQL segment expression built from the billing constants and reproducing `smsSegmentCount` at every boundary (0, 70, 71, 137, 138, 205, 500) and on a Persian body; a non-column reference refused; and the read happening inside the funding transaction, scoped to one child |
| `npx vitest run` — `pricing-service` (§5j) | 5 new fixtures: demand raising the target above the buffer and reporting `campaign_demand`; a child that satisfies the buffer but not its queue now being funded; demand below the buffer leaving the standing order in charge (`top_up`); caps, the master floor and the transactional reserve still clamping a demand-sized target; `low_watermark`'s trigger rising to the queue, and the child healthy again once it is above |
| `npm run test:db` — `kavenegar-managed-accounts` (§5j) | two added cases (CI only; no Postgres here): a three-recipient queue whose multipart bodies total five segments reads `{messages: 3, segments: 5, campaigns: 1}` and funds the queue rather than the 10-message buffer, while another tenant's queue reads zero; and a small queue leaves the 100-message buffer as the target with reason `top_up` |
| `npx vitest run` — `master-balance` (§5i) | 10/10: `unknown` rather than zero when nothing was observed; `current` for a fresh figure; `unreadable` when a later read failed — and outranking `stale`, because the failure is the more urgent fact; `stale` only after six hours; a future clock skew is age 0. Plus the source rules: the mirror is written only when the pass read the provider, a failed mirror write cannot fail the pass, both halves are written in one statement, both queries run in the documented platform scope with no `withTenant`, and the console reads the snapshot rather than calling the provider |
| `npm run test:db` — `kavenegar-managed-accounts` (§5i) | one added case (CI only; no Postgres here): a live pass mirrors `10 000 000` as `current`; a pass whose read is refused leaves the figure and moves `checkedAt`, reading as `unreadable`; an operator-supplied figure does not overwrite the observation and makes no `/account/info.json` call; the console snapshot carries the mirrored value |
| `npx vitest run` — `audit/action-meta` (§6f) | 4/4: every `sms.*` action the two SMS routes write has a label that is not the key echoed back; the `jobKindFor` switch is followed so a new job kind cannot ship unlabeled; the `sms` family exists and prefixes every one of them; and both console deep links still carry `actionFamily=sms` |
| `npx vitest run` — `campaign-delivery-report` (§6e) | 8/8 (nearest-rank percentiles where one 90 s retry still shows at p95, `null` for silence rather than `0`, unmeasured rows excluded from the statistics, unsorted input not mutated; and the source guards: no provider name, no `o.error`/`provider_message_id` in the shared row shape, the tenant query scoped by business *and* RLS, the cross-tenant read behind the documented bypass) |
| `npm run test:db` — `kavenegar-managed-accounts` (§6e) | one added case: a campaign with two accepted sends (2 s/4 s queue, 100 ms/300 ms provider), one queued and one refused reports `{p50: 2 000, p95: 4 000}` and `{p50: 100, p95: 300}` with health `attention`; the tenant copy is its own campaign with no business or provider field, another business sees none of it, and `[null, null]` is "no measurement" |
| `npx vitest run` — `app-availability-callers` (§3b) | 11/11 (the sweep over ~1,100 source files finds no hand-written state decision; every allowlisted presentation file still exists; the resolver carries neither `"enabled"` nor a cast; both writers validate; the SQL CHECK matches the TypeScript states exactly; and `enabled`/`off`/`""`/`null`/`3` are all refused before any query runs) |
| `npx vitest run` — `sms-noop` (§3a) | 7/7 pass (the code is printed in `development`/`test`; `production`, `staging` and an unset `NODE_ENV` all throw `SmsNotConfiguredError` with neither the code nor the number in the log or the error; the resolver really returns this fallback) |
| `npx vitest run` — `template-library-view` (§5f) | 6/6 pass (Persian variable names in mapping order, the automation each entry can serve computed by the send path's own check, no automation for an unfillable message, unknown variables dropped rather than shown as `%token4`, supplier-free copy) |
| `npx vitest run` — `managed-services` (§0) | 23/23 pass (inventory covers every registered service, paths exist, maturities are honest with their follow-ups, plus the source guard over ~100 tenant screens and a positive/negative control for the supplier pattern) |
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

0. ~~**The rest of the triggers**~~ — **closed** (§5k, §5l): both events are wired from every path
   that commits a customer-facing action — the counter, the offline replay, both plugin importers and
   the CMS storefront — and the tenant sees each automation's **exact text** and its **per-trigger
   record**. The amendment bridge is excluded on purpose and says so in the file: a correction is not
   a second payment. The login code is deliberately *not* one of these triggers: it stays on the
   platform-auth transport (§5e), which is what keeps it working with an empty wallet.
1. ~~**Campaign-budget funding trigger**~~ — **closed** (§5j): the three strategies and the guards
   were already in place, and the reserved slice closed in §5h. The "approved campaign budget" turn
   out not to need a product decision after all: the approval is *materialized*, so the trigger is the
   queue of sends the business already approved (`message_outbox` still `queued`/`sending`), counted
   in the segments the provider bills and priced at the child's wholesale rate. The target becomes
   `max(buffer, demand)` and the transfer reports `campaign_demand` rather than `top_up`.
2. ~~**Delivery/health dashboards** (#902 P1): per-campaign delivery and provider latency~~
   — **closed** (§6e, §5o): the console and the tenant screen show delivery per campaign with the
   queue wait and the provider wait separated, and now also a **long-range trend** — a quarter of
   sends bucketed weekly (days under a month, months over a quarter), where a bucket with no
   attempts is a gap rather than a zero and the failure rate is `null` instead of `۰٪`. The outbox
   rows it reads are retained, so it stayed a query and a chart.
3. **Retail ↔ wholesale settlement in invoicing** (billing) — **two of three parts closed**:
   the rating cites the version that produced its amount (§5m), and those ratings now become **invoice
   lines** — one per meter-and-version, each linked to the ratings it was built from with one-billing-ever
   enforced by the database (§5n). Still Billing's: reconciling a **supplier invoice** against
   `billing_vendor_cost_events` (the wholesale side, which exists and is tenant-invisible, but has no
   statement to reconcile against yet).
4. ~~**Funding from an authoritative master balance**~~ — **closed** (§5g and §5i): the account
   endpoint reports the master's own credit, the funding pass reads it once per pass, and the figure
   is now mirrored with its age and its failed-read flag, so a configured floor neither stops
   automation nor forces an operator to ask the provider what the balance is.
5. **Managed-service rollout for other integrations**: #894 Torob, #896 Divar, payments,
   media, AI — apply the contract and add leak-guard tests per integration.
6. ~~**`resolveBusinessCapability` follow-up**: audit other callers for the same stale
   `"enabled"` comparison~~ — **closed** (§3b): the audit found the same class of drift in three
   more places (an unvalidated write, a hand-copied vocabulary and a cast in the resolver), all
   fixed, and the rule is now a test rather than a note.

## 10. Environment notes

- The sandbox has 3.9 GB RAM and 2 cores; repository-wide `tsc --noEmit` is killed by the OOM
  killer at ≥3.4 GB heap. A scoped `tsconfig` covering all changed files and their imports was
  used for type verification. CI's `test.yml` runs the full type check with more memory.
- `npm ci` and `npm run db:migrate` were run locally; the integration suite creates and drops
  its own scratch database, as the other `integration/*` suites do.
