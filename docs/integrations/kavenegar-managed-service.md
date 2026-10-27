# Kavenegar as a Bizamiz managed SMS service (issue #902)

**Status:** first slice delivered — provider spike, the platform-wide managed-service
contract, the child-account adapter, provisioning, JIT funding with caps, the Lookup
template catalog, wholesale reconciliation, and the Superadmin console. Remaining product
work is listed in §10.

This page is the contract between the platform and the supplier, and the operator's
runbook. It deliberately contains provider names: it is documentation for Superadmins, not
a tenant surface. Tenant-facing wording is owned by
[`src/lib/managed-services/contract.ts`](../../src/lib/managed-services/contract.ts).

---

## 1. The product rule this implements

Every third-party integration is a **Bizamiz managed service**:

- tenants use first-party workflows, plans, wallet, permissions and reports;
- **Superadmin** alone holds provider credentials, accounts, tariffs, provider credit,
  health and switching;
- there is **one commercial authority** — the central wallet and billing domain. Retail
  credit is the tenant's only balance. Provider credit is internal pre-funding, invisible
  and non-spendable;
- a stable domain interface separates the capability from the adapter, so changing supplier
  does not change tenant routes, prices or copy;
- an adapter's provider vocabulary may appear in Superadmin observability and internal logs,
  **never** in normal tenant screens, responses or exports.

The same contract is what #894 (Torob) and #896 (Divar) are specified against. Register a
new managed service by adding an entry to `MANAGED_SERVICES` and returning
`TenantManagedServiceView` from its readiness read — do not invent a second payload shape.

### Tenant vocabulary

| Use | Do not use |
| --- | --- |
| پیامک / پیام‌رسانی | کاوه‌نگار / Kavenegar |
| اعتبار پلتفرم / هزینهٔ ارسال | اعتبار کاوه‌نگار / تعرفهٔ نمایندگی |
| وضعیت سرویس: آماده، در حال آماده‌سازی، نیازمند اقدام، غیرفعال | provider status codes (`418`, `502`, …) |
| «کیف پول را شارژ کنید» | «API Key نامعتبر است» |

`findTenantLeaks()` / `assertTenantSafePayload()` enforce this in tests: a payload carrying
`apikey`, `remaincredit`, `pricingname`, `localid` or a supplier name fails.

---

## 2. Provider spike — what was verified

Verified against the supplier's own documentation (no live account was called from tests):

| Topic | Finding |
| --- | --- |
| Base URL | `https://api.kavenegar.com/v1/{MASTER_KEY}/client/{method}.json` |
| Envelope | `{ "return": { "status": 200, "message": "…" }, "entries": … }` — **`entries` is top-level**, an object for single records and an array for `client/list`; `/verify/templatelist` adds `metadata`. |
| Create | `client/add` with `localid`, `Username`, `password`, `Fullname`, `Planid`, `Status` (`0` disabled, `1` active with panel, `2` active without panel), `Mininumallowedcredit`, `Lines`, `Credit`, `Mobile`, `CanUseParentLines`, `expiredate`. |
| Lookup | `client/fetch` (by child key), `client/fetchbylocalid` (by our id), `client/list`. |
| Manage | `client/update`, `client/setstatus`, `client/renewkey`, `client/chargecredit` (signed Rial; negative claws back; minimum ±1000 Rial; provider invoices both sides). |
| Templates | `verify/templatelist`, `verify/addtemplate`, `verify/updatetemplate`, `verify/gettemplate`, `verify/clonetemplate`, `verify/deletetemplate`; `apiKey`/`localId` target a child. Approval states: `Approved`, `PendingReview`, `Rejected`; SMS text must contain `%token`. |
| Eligibility | The customer-management API is documented as **restricted to high-volume customers** and REST-only. Provisioning must therefore be opt-in and capability-probed, never assumed. |
| Tariff semantics | A child's `smsfarsicost`/`smsenglishcost` are wholesale (Rial/segment); English is 2.3× the Persian rate in the example. `PricingName`/`Planid` are wholesale detail. |
| Duplicate keys | `503` = duplicate `localid`, `502` = duplicate username — the first is a **recovery** signal, the second a **retry with a new username** signal. |
| Known error codes | `400,401,402,403,406,407,409,411,412,413,414,417,418,419,420,424,449,451,502,503,504,505,506,507,601,602,603,703–710` — all classified in `src/lib/kavenegar/client.ts`. |

### Defect found and fixed in the existing send path

`parseKavenegarResponse()` read `return.entries`, so the message id always fell back to a
timestamp and the per-message `cost` was discarded. It now reads the documented top-level
`entries` (legacy nesting still accepted for old fixtures) and returns
`providerCostRial`, stored on `message_outbox.provider_cost_rial` for wholesale
reconciliation. Retail charging is unchanged.

### Defect found while wiring eligibility

`resolveBusinessCapability()` compared `app_availability.state` with `"enabled"`, a state
that has not existed since migration 0128 (`available`/`beta`/`coming_soon`/`maintenance`/
`disabled`). Every app with an `available` row was denied `platform_unavailable`. Fixed to
use the pure `APP_AVAILABILITY_META[state].usable` rule. Without the fix, managed
provisioning could never see an entitled business.

---

## 3. Account model

- **One child account per business**, created when the canonical entitlement
  (`cloud.messaging`) resolves and the Growth app is available — never per staff user, never
  per CRM customer.
- `localid` is the business UUID. It is stable, unique across the install, and the only
  recovery key that survives a lost create response.
- Username is derived (`bm` + first 16 hex of the business UUID, plus an attempt suffix on a
  provider collision). The panel password is a random 32-character secret that nobody uses:
  the child is created with panel login disabled (`Status=2`).
- Initial provider credit is **zero**. Funding is a separate, audited transfer (§6).
- No CRM data is sent. The provider receives a display name, a username and the policy's
  lines — not contacts.

### State machine

```
not_provisioned ──request──▶ pending ──claim──▶ provisioning ──create/read──▶ active
                                                     │  ├─ username collision ─▶ retry_pending ─▶ attention_required
                                                     │  ├─ lost response ──────▶ retry_pending (fetchbylocalid first)
                                                     │  └─ permanent ──────────▶ attention_required
active ──Growth lapses/suspend──▶ suspended ──renew──▶ (reactivate → read → active)
```

`retry_pending` means **read before write**: the next attempt calls
`client/fetchbylocalid` first. `suspended` keeps the mapping, the encrypted key, the tariff
snapshot and the provider credit; nothing is deleted. `attention_required` needs an
operator (console retry or adoption).

Constraints that make this real rather than aspirational:

- `UNIQUE (business_id)` and `UNIQUE (localid)` on `kavenegar_business_accounts`;
- one open job per `(business_id, job_kind)` (partial unique index);
- `FOR UPDATE SKIP LOCKED` claim plus a five-minute lease;
- `client/add` is never retried automatically — an unanswered POST is *ambiguous*, and the
  worker reconciles before writing.

---

## 4. Credentials

| Secret | Where | Who may read |
| --- | --- | --- |
| Master API key | `platform_sms_config.api_key_enc` (migration 0076), env bootstrap fallback | OTP path and customer-management adapter, same resolver (`getKavenegarMasterKey`) |
| Child API key | `kavenegar_account_credentials.api_key_enc`, AES-256-GCM (`POSKVN1` magic) under the platform realm secret, with `api_key_version` | platform-only RLS; the outbox resolver reads **one** key by an account id it already established belongs to the scoped business (`kavenegar-credentials` bypass) |
| Child key hint | `api_key_hint` (last four) | console only |

There is no second configuration store. The OTP path and the marketing path resolve the
master key through one function, which is what closes the "two SMS configurations disagree"
risk in the issue.

Logs, URLs and errors are redacted (`redactKavenegarUrl`, `redactManagedServiceText`): the
key path and `apikey`/`password`/`token`/`localid` query parameters never reach a log line.

---

## 5. Which account sends a business's marketing SMS?

`resolveBusinessSmsSender(businessId)` (`src/lib/kavenegar/credentials.ts`):

| Account state | Sender |
| --- | --- |
| no account yet (rollout) | legacy platform key — explicit, temporary branch |
| `active` + decryptable key | that child's key and first assigned line |
| any other state, or key undecryptable | **none** — SMS rows stay queued, fail closed |

The resolver runs inside the drain's own `withTenant(businessId)`, so a request body can
never select another tenant's account. Authentication OTP does **not** use this path: it
keeps `platform_sms_config`, so login survives a suspended child, an exhausted tenant
wallet, or Growth being switched off.

Tenant endpoints (`/api/messaging`, `/api/growth/settings`, `/api/messaging/preview`) return
`getTenantMessagingConfig()`: `enabled`, `configured`, `rate`, and the provider-free
`service` readiness view.

---

## 6. Funding (internal, never a tenant balance)

`kavenegar_credit_transfers` is the journal, with a client-supplied `idempotency_key`
unique per request:

1. row written `pending` **before** the provider call;
2. confirmed → `applied` with the child's reported `balance_after_rial`;
3. transport timeout → `unknown` (not failed): the money may have moved;
4. same key again → answered from the committed row, no provider call;
5. provider refusal → `failed` (no money moved).

### JIT funding policy

Automatic top-up is **off by default** (`funding_buffer_messages = 0`). When it is on, a plan
is a pure decision over explicit inputs (`planFunding`):

1. buffer 0 → nothing;
2. any `pending`/`unknown` transfer → nothing (never double-fund an unresolved move);
3. unknown wholesale tariff → nothing (never guess a target);
4. target = `buffer_messages × the dearer wholesale segment` (English is ~2.3× Persian, so
   planning on Persian would under-fund English traffic);
5. deficit clamped by the per-child ceiling and the rolling 24-hour cap;
6. the master floor is subtracted from what the master may spend — and if a floor is set
   while the master balance is unknown, the plan refuses rather than fund through it;
7. the remainder is rounded **down** to 1,000 Rial; below that the provider refuses (±1,000
   minimum), so nothing is attempted.

Deterministic keys (`auto:<account>:<day>:<n>`) mean a tick that runs twice asks for the same
journal row. Tenants never see any of it: their balance is the central wallet.

**Strategies** (migration `0261`) decide *when* a transfer is planned; the buffer is always the
target:

| Strategy | Rule |
| --- | --- |
| `jit` | Every pass that finds the child under target |
| `low_watermark` | Only after the child drops below a trigger (messages), then refill to the target — hysteresis, so a child one message under target is not topped up every 15 minutes |
| `scheduled` | Only inside a UTC hour window (wraps midnight; `start = end` means all day). An unset window funds normally rather than never: an accidental strategy must not silently stop the fleet |
| `manual` | Never automatically; distinct from a zero buffer, which reads like a misconfiguration |

A watermark of 0 (or ≥ the buffer) clamps to the buffer, so a typo cannot fund above what the
operator chose. `funding_global_daily_cap_rial` is the **cross-business demand guard**: a ceiling
on what *all* children may receive in one rolling day, checked before the per-child caps so one
busy tenant cannot drain the master credit the rest of the fleet needs.

---

## 6a. Lookup templates

| Step | Who | Rule |
| --- | --- | --- |
| Draft | Tenant | First-party title + body; `%token` (or `%token2`…`%token20`) required; length 268 Persian / 612 Latin; no other `%` placeholders. |
| Provider name | Platform | Derived: `bmv`/`bmt` + 10 hex of `sha256(businessId, purpose, title, body)`. Never chosen by the tenant, stable across retries. |
| Submit | Superadmin | `verify/addtemplate` on the **child** key (`apiKey`), row → `submitted`. `602 duplicate name` is adopted, not failed; a timeout is `outcome_unknown`, resolved by the next sync. |
| Revise (draft / rejected) | Tenant | Rewritten in place: `revision + 1`, back to `draft`. The provider **name is kept**, so the next submit is `verify/updatetemplate` on the same template instead of a duplicate. |
| Revise (approved / submitted) | Tenant | A **successor** row is created and points at the live one through `supersedes_id`. The approved row keeps sending until the successor is approved — an edit can never stop working automation. |
| Retire | Superadmin | `verify/deletetemplate` on the child key, then `disabled` + `archived_at`. `424`/`449` mean the provider copy is already gone; any other failure still retires our row and records the code so the console shows a manual cleanup. |
| Approve | Provider | `approved`/`rejected`/`pending` mapped into our lifecycle by the sync (`verify/templatelist`). |
| Tenant view | Tenant | `{title, purpose, status, statusLabel}` only. Provider name, id, `PendingReview`/`Rejected` wording and rejection text never leave the server. |

A rejected template is `needs_action` with an actionable sentence. The tenant's edit reaches the
provider as an **update of the same template** (`submitted_body` snapshot ≠ current body), because
the derived name is the template's identity; only a revision of an already-approved template gets a
new derived name, precisely so both can coexist during reapproval. An accepted `updatetemplate`
reply carries no approval status (documented output), so the row goes back to `submitted` — never
straight to `approved`.

`revision`, `submitted_title`/`submitted_body`, `supersedes_id` and `archived_at` come from migration
`0260`; the backfill marks every already-reviewed row as `submitted_body = body` so the first sync
after the upgrade resubmits nothing.

## 6b. Reconciliation

`kavenegar_reconciliation_runs` compares two independent records per child:

- **ours**: applied transfers − `message_outbox.provider_cost_rial` (the cost the provider
  reported for each send);
- **the provider's**: `remaincredit` read by `client/fetchbylocalid` (the stable key, so a
  suspect child key cannot hide the balance).

The window starts when the child was provisioned — the provider's balance is cumulative,
so a 24-hour sum would report every older transfer as drift. Runs are bucketed to the hour
(unique per account), so a retry cannot duplicate one. A failed provider read is
`incomplete`, not `drift`. Drift keeps its sign: positive means we under-recorded funding or
cost, negative means we spent more than we recorded. The console also shows retail charged
(Billing's `billing_usage_ratings`) against provider cost, which is the margin evidence.

## 7. Operator checklist — before enabling the policy

Do these in order; the policy switch (`managed_child_accounts_enabled`) is off by default
and nothing provisions until it is on.

1. **Confirm eligibility.** `POST /api/platform/sms/accounts {action:"probe"}` must answer
   `eligible: true`. If it does not, stop: the supplier has not approved the master account
   for customer management. Do not guess or work around it.
2. **Record the tariff.** Note the provider `Planid` and the per-segment Persian/English
   wholesale rates. Confirm wholesale is below the retail rate in Billing for **both**
   languages (English is ~2.3× Persian).
3. **VAT.** Confirm with accounting whether `chargecredit` should send `vat=0` or `1`; the
   default here omits it. Record the decision in the policy note.
4. **Lines.** Decide which sender lines a child may use, confirm they are assigned to the
   master account, and put exactly those in `managed_sender_lines`.
5. **Supervised create.** Enable the policy, then, for one pilot business,
   `POST {action:"provision"}` and verify: state `active`, console shows the tariff, no
   second account appears in the provider panel on a retry.
6. **Funding drill.** First `{action:"transfer"}` 25,000 Rial once; verify one provider
   invoice, then retry the same idempotency key and verify no second invoice. Only then set
   `funding_buffer_messages`, a per-child cap and a daily cap, and confirm
   `{action:"fund"}` plans exactly the buffer (or refuses with a reason).
7. **Suspension drill.** `POST {action:"suspend"}`, confirm marketing sends stop
   (rows stay queued) **and login OTP still arrives**. Then `{action:"reactivate"}`.
8. **Rotate drill.** `{action:"rotate_key"}` on the pilot; confirm the old key stops working
   and the new one is stored encrypted (console hint changes).
9. **Rate limits.** Record the master account's documented/live send limits and the child
   limits; keep the tick at one provision per job and five jobs per pass.
10. **Rollback.** Disable the policy (new accounts stop being created) and suspend pilots.
    Existing mappings and keys are retained; disabling the policy never deletes rows or
    provider credit.

---

## 8. Failure modes and what happens

| Failure | Behaviour |
| --- | --- |
| Master key invalid/expired (`403`/`505`) | job fails permanently, account `attention_required`, tenant sees «نیازمند اقدام» |
| Master credit exhausted (`418`) | transfer `failed`; sending continues until the child empties, then `credit_exhausted` for the tenant — never a raw provider code |
| Provider timeout on create/fund | ambiguous: `retry_pending`/`unknown`, reconciled by a read before any retry |
| Duplicate local id (`503`) | adopted as success |
| Duplicate username (`502`) | retried with the next deterministic username, up to the job cap |
| Rate limited (`451`) | job requeued with exponential backoff (30 s → 6 h) |
| Child suspended / Growth off | marketing rows stay queued; OTP unaffected |
| Credential undecryptable | fail closed (no sends), account `attention_required`; never fall back to the master key |
| Funding plan blocked | the console shows why (`unresolved_transfer`, `master_floor`, `daily_cap_reached`, …); the tick records nothing and sends keep working from the child's remaining credit |
| Reconciliation drift | a stored `drift` run with a signed delta; no automatic money movement |

---

## 9. Delivered in this slice

- `src/lib/managed-services/contract.ts` (+ test) — tenant view, fault taxonomy, leak guard,
  registry.
- `src/lib/kavenegar/client.ts` (+ fixtures test) — documented request builders, envelope
  parsing (top-level `entries`), status table, redaction.
- `src/lib/kavenegar/rest.ts` (+ test) — injectable transport, timeouts, ambiguous-POST
  semantics, GET-only retries.
- `src/lib/kavenegar/secrets.ts` (+ test) — versioned AES-GCM envelope for child keys.
- `src/lib/kavenegar/provisioning.ts` (+ test) — state machine, eligibility, username/
  password/localid derivation.
- `src/lib/kavenegar/provisioning-service.ts` — queue, worker, adoption, rotation,
  suspension, funding journal, console snapshot, eligibility probe.
- `src/lib/kavenegar/credentials.ts`, `policy.ts`, `src/lib/messaging-service-readiness.ts`
  — the server-side key resolution, the opt-in policy, the tenant-safe config.
- `migrations/0258_kavenegar_managed_accounts.sql` and
  `0259_kavenegar_funding_templates_reconciliation.sql` — accounts, platform-only
  credentials, jobs, transfer journal, policy + funding columns, Lookup templates,
  reconciliation runs, and `message_outbox.provider_cost_rial`. Every table with a
  `business_id` is tenant-scoped under FORCE RLS; the platform code reaches it only through
  the documented bypass.
- `pricing-service.ts` — wholesale→retail quotes/margins and the JIT funding planner.
- `template-service.ts` — the Lookup template catalog and approval sync.
- `reconciliation-service.ts` — stored wholesale balance/margin evidence.
- `/api/platform/sms/accounts` — Superadmin reads (accounts, margin, reconciliation, template
  catalog) and actions (policy, probe, transfer, fund, reconcile, template submit/archive/sync,
  enqueue).
- `/platform/messaging` — the console card: policy, probe, fleet, actions, margin and
  reconciliation.
- `/api/platform/sms` corrected from `ai.config.manage` to `messaging.manage`.
- The outbox drains through the business's own child key (§5), and records provider cost.
- Three central ticks: eligibility/jobs every 60 s, funding every 15 min, reconciliation
  every 6 h. Funding and reconciliation make **no** provider call while the policy is off.
- `integration/kavenegar-managed-accounts.integration.test.ts` — 29 database cases with a
  fake transport (no network): one-child-per-activation, lost-response recovery, funding
  idempotency and caps, template approval, reconciliation bucketing, RLS under an
  unprivileged role, and the app-availability regression.

## 10. Deliberately deferred (with reasons)

| Item | Why it is not in this slice |
| --- | --- |
| Delivery/health dashboard | Delivery is visible through the outbox and Billing's usage screens; a dedicated latency/failure panel is a follow-up. |
| Tying approved templates to concrete triggers | The catalog and approval lifecycle exist; wiring «کد ورود»/«سفارش آماده است» to product events is product work. |
| Retail settlement against wholesale cost, price versions, invoices | `provider_cost_rial` and the margin report exist; moving wholesale into invoice/price-version economics is the Billing domain's change. |
| Authoritative master balance | The customer API exposes a child's balance only. The floor accepts an operator-supplied balance and refuses to fund blindly without one. |
| Bulk adoption of pre-existing children | Single adoption by `localid` exists (`adopt` job); bulk mapping needs operator-supplied data. |
| Cross-integration managed-service migration (#894, #896, payments, media, AI) | The contract is shared here; each migration is tracked on its own issue, per the epic. |
