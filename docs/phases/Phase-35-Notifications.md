# Phase 35 — notifications («اعلان‌ها»)

## Why

Everything in this section of the product already worked. The till reconciles, the
backup runs at 03:00, the coworker job fires when the shift closes, the store room
knows the bread is below its reorder level. What none of it could do was **reach a
person who was not looking at a screen**.

The concrete failures, which are the reason this phase exists:

- A shift closes 400,000 ﷼ short. The variance is computed, stored, and shown on
  the shifts tab. The owner is at home. They find out on Saturday, when the person
  who counted the till has been off for two days and nobody remembers the evening.
- The scheduled backup fails on a Monday. `backup_runs` records it and the
  dashboard shows an alert card. Nobody opens the dashboard until Thursday, by
  which point three nights of trade are unprotected. This is the failure whose
  entire cost is in the delay.
- A Phase 32 coworker job fires at 02:00 and lands in the approval inbox. The
  owner set it up precisely so they would not have to think about it, and the one
  thing it now needs is for them to think about it.

There was no mechanism at all — no table, no key pair, no service worker handler.
So this phase is that mechanism, plus the smallest catalogue of events worth
sending through it, plus the rules that decide who hears which.

## Why Web Push, and why that covers iOS, Android and Windows

The requirement was one notification system for phones and desktops. There is
exactly one way to get that without shipping three apps: **Web Push**
(RFC 8030/8291/8292), which every current browser implements against the same
subscription and encryption model.

| Platform | How it arrives | Condition |
| --- | --- | --- |
| iOS / iPadOS 16.4+ | Safari's push service | **Only** for a PWA added to the home screen |
| Android | Chrome/Edge/Firefox → FCM | Installed PWA or an ordinary tab |
| Windows | Chrome/Edge → FCM/WNS | Installed PWA or an ordinary tab |
| macOS / Linux | Chrome/Edge/Safari/Firefox | Same |

The app was already a PWA with a manifest and a service worker (Phase 12), so the
only missing pieces were the subscription, the sender, and the `push` handler.

The **iOS condition is the one that would have sunk the feature quietly**. Safari
does not expose `PushManager` at all outside an installed PWA — no error, no
prompt, nothing. A user tapping «فعال کردن» in mobile Safari would have watched
nothing happen and concluded the product was broken. `pushSupport()` in
`src/app/dashboard/settings/push-client.ts` detects that case up front and answers
with the instruction that actually fixes it («از دکمهٔ اشتراک‌گذاری Add to Home
Screen را بزنید»).

Two things this phase deliberately did **not** do:

- **No native app, and no FCM/APNs SDK.** Those need a Google/Apple developer
  account per deployment, and this product ships to on-site installs on a café
  laptop. Web Push needs neither.
- **No `web-push` npm dependency.** The wire format is a few dozen lines against
  primitives Node already has (ECDH, HKDF, AES-GCM, ECDSA), and the alternative is
  a third-party package in the trusted path of every notification the product
  sends. `src/lib/web-push.ts` follows the same precedent as `s3-lite.ts`, and its
  test decrypts its own output with an independently written receiver.

## What was built

### The schema (`migrations/0102_notifications.sql`)

| Table | What it is |
| --- | --- |
| `platform_push_config` | The deployment's VAPID key pair. One row, no `business_id` — tenant-exempt, like `platform_ai_config`. |
| `notification_devices` | One browser push subscription. `endpoint` is globally UNIQUE. |
| `notification_rules` | Per user, per event, optionally per branch: enabled, channels, severity floor, amount floor, quiet window. |
| `notification_events` | The outbox. UNIQUE `(business_id, dedupe_key)`. |
| `notification_recipients` | The bell — one row per person per event, with `read_at`. |
| `notification_deliveries` | One row per device per event, with the push service's answer. |

### Producers → outbox → tick → devices

A producer calls `recordNotification` (`src/lib/notification-events.ts`) and
returns. It is a single `INSERT ... ON CONFLICT DO NOTHING`, it swallows its own
errors, and it imports nothing but `db` — the same tiny-module shape and the same
contract as Phase 32's `recordCoworkerEvent`, for the same reason: **a cashier
closing their till must never wait on, or fail because of, an HTTPS round trip to
a push service in another country.**

`runNotificationTick` (`src/lib/notifications-service.ts`, 15s) is the only thing
that sends. It enumerates businesses with pending rows under the documented
`platform` bypass, wraps each fan-out in `withTenant`, and claims each event with a
conditional `UPDATE ... WHERE processed_at IS NULL` before delivering — so two app
instances ticking at once produce one notification, not two.

### The producers

| Event key | Emitted from | Default recipients |
| --- | --- | --- |
| `shift.opened` | `shift-service.ts` | nobody (opt-in) |
| `shift.closed` | `shift-service.ts` | nobody (opt-in) |
| `shift.cash_variance` | `shift-service.ts` | owner, manager |
| `business_day.closed` | `business-day-service.ts` | owner |
| `order.voided` | `/api/orders/[id]` | owner |
| `payment.refunded` | `/api/orders/[id]/returns` | owner |
| `inventory.low_stock` | `notification-scans.ts` (scan) | owner, manager |
| `backup.failed` | `backup-service.ts` | owner |
| `ai.coworker.pending` | `ai-coworker-service.ts` | owner |
| `ai.coworker.reported` | `ai-coworker-service.ts` | owner |
| `ai.coworker.failed` | `ai-coworker-service.ts` | owner |
| `contract.completed` | `contracts/signing.ts` after the last required signer commits | owner, manager |

Every key in the catalogue has a producer. A key without one is a switch in the
settings screen that does nothing, which is worse than an absent one, and
`notifications.test.ts` pins the catalogue's shape so a future addition cannot
drift into that state unnoticed.

**`inventory.low_stock` is the one scanned producer**, and the exception is
deliberate. Stock leaves an item through at least six paths — a sale's recipe
deduction, a waste write-off, a transfer out, a production consume, a stock count,
a supplier return — so a threshold crossing is a property of the *level* after any
of them, not of any one of them. Putting the check in all six would guarantee that
the seventh, added later, silently does not notify. `runLowStockScanTick` runs on
its own much slower cadence (10 min) and dedupes on
`inventory.low_stock:<item>:<business date>`, using `app_business_date` so a café
working 18:00→03:00 gets one alert per night rather than two at midnight.

### The AI half

The user requirement was that jobs and AI functions be able to notify. They do —
and notably **not** by getting an `ACTION_CATALOG` entry.

A notification writes nothing to the books, moves no money, and needs no approval.
Routing it through Phase 31's autopilot machinery would have meant inventing a
category, an executor and a cap for something with no financial risk, and — worse
— an `approvalMode: 'ask'` job would have had to ask permission before telling
anyone anything, which is absurd. So `fireCoworkerJob` calls `recordNotification`
directly at its three outcome points, deterministically, from facts the run
already has:

- a run that lands in the approval inbox → `ai.coworker.pending`;
- a run that produced a report (the accounting review) → `ai.coworker.reported`;
- a run that failed or only partly applied → `ai.coworker.failed`.

A fully `applied` run notifies nobody: it did exactly what the owner pre-approved
and is already in the audit tab, so a notification would be the product telling
them what they told it to do. A `skipped` run notifies nobody either — a job that
correctly finds no stale bread on 300 nights must not produce 300 notifications,
or the one night it does find something is lost among them.

This keeps every Phase 31/32 invariant intact: no model is in the loop, no
provider is called, no credits are spent, and **MCP gains no new tool** (Phase 34's
`assertWriteToolsMatchCatalogue` still passes unchanged, because the catalogue did
not change).

## Decisions

### A missing rule is a default, not a silence

`resolveRecipients` falls back to the catalogue's per-role defaults for anybody who
has never opened the settings tab. The alternative — everything off until
configured — produces a notification system that is switched off on every install,
and the failure is invisible: the owner simply never hears about the shortfall and
never learns there was something to switch on.

The defaults are narrow on purpose. No event defaults a `cashier` or `kitchen`
member into anything (pinned as a unit test): an app that buzzes every till phone
about the backup log has its notification permission revoked within a week, and
then none of it works.

Deleting a rule restores the default; switching an event off is a rule with
`enabled: false`. Those are different states and the settings screen distinguishes
them with a «پیش‌فرض» badge, so the screen is honest about the fact that
notifications already work.

### «بیدارم نکن» is not «به من نگو»

Quiet hours suppress the **push** and never the bell row, and the suppression is
recorded as a `quiet` delivery so "why didn't my phone buzz" has an answer rather
than a guess. A `critical` event ignores the window entirely — `backup.failed` is
the only one, and it is the whole justification for the exception: a business whose
backups have been failing for three nights needs to be told at 03:00, not at 09:00
on the fourth day.

A window that wraps midnight (22:00 → 07:00, the one people actually configure) is
the normal case, not a special one. A window whose ends are equal means *nothing*
rather than *all day*: "quiet from 8 to 8" is far more likely a slip than a request
never to be notified again.

### Branch access is Phase 14's answer, not a second one

Who may *hear about* branch X is `accessibleLocationIds` — the same pure function
that decides who may *act in* branch X. Re-deriving it from `users.location_id`
would have quietly disagreed with every other screen the moment a manager is
assigned two of five branches. A rule can narrow what someone sees; it can never
widen it past their own assignment.

### The VAPID pair is generated, not configured

`getPushConfig` reads `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` when set (so a fleet
can share one identity) and otherwise generates a pair into
`platform_push_config` on first use. An on-site install has no operator to run a
key-generation step, and a notification system that required one would simply be
off on every such install, silently.

The row is written **once** — `ON CONFLICT DO NOTHING` followed by a re-read, never
an upsert — because the public half is baked into every subscription a browser has
ever minted. Rotating it would invalidate every device every business owns, with
no error to notice; the integration test pins that it does not move.

### A dead subscription is deleted, not retried forever

`classifyPushStatus` splits the push service's answer four ways. 404/410 means the
browser is gone (uninstalled, site data cleared, permission revoked) and the row is
**deleted** — keeping it would mean failing against it until the end of time.
429/5xx is the push service's problem and counts toward `failure_count`, which
disables the device after 8. 400/401/403 means this deployment's own setup is wrong
and retrying changes nothing.

### `requireMember` — a fourth guard

The notification endpoints let every member manage only **their own** devices,
rules and inbox, so there is no role left to gate: a کارمند آشپزخانه choosing which
of their own alerts reach their own phone is not a manager-level act. Listing all
six roles in `requireRole` would read as an oversight rather than as a decision, so
`requireMember()` was added to `auth.ts` alongside it, documented as narrow.
`api-guards.test.ts` now recognises it *and* asserts that every route using it
scopes its work to `session.sub` — because that scoping is the only thing keeping
one member out of another's devices.

## Where the exit criteria are satisfied

| Criterion | Where |
| --- | --- |
| Push reaches iOS, Android and Windows from one implementation | `src/lib/web-push.ts` (RFC 8291/8292), `public/sw.js`, `push-client.ts`'s iOS install path |
| Notifications are sent per user-defined rules | `resolveRecipients`/`ruleFor` (`notifications.ts`), the «اعلان‌ها» settings tab |
| Jobs notify | `fireCoworkerJob`'s three outcome points (`ai-coworker-service.ts`) |
| A producer never blocks or fails its caller | `recordNotification` — one INSERT, swallows its own errors |
| One fact, one notification | UNIQUE `(business_id, dedupe_key)` + the claim `UPDATE` in `runBusinessNotificationDelivery` |
| Quiet hours suppress push only, critical overrides | `isWithinQuietHours` + the `quiet` delivery status; `integration/notifications.integration.test.ts` |
| Tenant isolation | RLS on all five tenant tables; `integration/tenant-isolation.integration.test.ts` |
| The encryption is correct | `web-push.test.ts` decrypts its own output with an independently written RFC 8291 receiver |

## Not built, and why

- **Email or SMS.** A different delivery problem (an SMTP relay or an Iranian SMS
  gateway, per business, with its own credentials and billing) attached to the same
  rules. The `channels` column is an array precisely so adding one later is a
  migration and a sender, not a redesign.
- **A per-branch rule editor.** The schema supports `location_id` on a rule and
  `ruleFor` prefers the more specific one, but the settings screen only edits the
  all-branch rule. A second, near-identical form for a case most businesses do not
  have is how a settings screen becomes unusable.
- **An in-app bell UI.** `notification_recipients` and `/api/notifications/inbox`
  are built and tested, and the `inapp` channel writes to them, but no bell icon
  was added to the dashboard chrome in this phase — that is a nav-level change
  worth doing on its own rather than smuggled in here.
- **Notifying on a fully applied autopilot/coworker run.** See the AI section
  above: it would be the product reporting back what the owner already authorised.

## Testing notes

`PwaRegister` deliberately skips service-worker registration in development so the
shell is never cached while iterating. `push-client.ts` therefore registers the
worker on demand when someone actually asks for notifications, so «فعال کردن» works
under `npm run dev` — the worker only starts existing once it is needed. Push also
requires a secure context: `localhost` counts, a LAN IP over plain HTTP does not,
and `pushSupport()` says so rather than letting it read as a browser limitation.
