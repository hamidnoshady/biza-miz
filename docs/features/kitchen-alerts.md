# Kitchen alerts, sound and ticket aging

The KDS (`/accounting/kitchen`) has three deliberately separate controls. They
answer different questions and must not be collapsed into one "notifications"
switch:

| Concern | Where it is configured | Scope | Shared policy |
| --- | --- | --- | --- |
| In-app bell / push | «تنظیمات ← اعلان‌ها» | Per person, with optional branch scope | The Phase 35 notification engine (`src/lib/notifications.ts`) |
| Sound | «اعلان‌ها و صدا» on the KDS | This browser/device only | Browser autoplay permission |
| Automatic printing and print warnings | «تنظیمات ← چاپ و فاکتور» (`/settings/printers`) → «چاپ و اعلان‌ها» | Business default + branch override | `printing.behavior` (`all` / `failures` / `off`) |

## Shared notification events

Three keys live in the ordinary notification catalogue, so they inherit role
permissions, branch scope, quiet hours, push/in-app channels and the outbox
dedupe:

- `kitchen.ticket_created` — a new order reached the kitchen. Emitted after the
  order mutation commits, and after a website order is accepted (an unapproved
  website order is not visible to the kitchen yet).
- `kitchen.items_added` — a new round was added to an order the kitchen already
  knows. The dedupe key includes the exact line-id set, so retries and sync
  replays cannot produce two notifications for one round.
- `kitchen.ticket_aged` — the one-minute scan found a ticket at its branch's
  approaching or overdue threshold. The dedupe key includes the order, the
  stage and the late line set, so reconnects and repeated scans stay silent.

All three use `kitchen.view` and the kitchen module (F&B only). Their
`defaultRoles` is empty: a kitchen member opts in from their own notification
settings rather than having sound/push forced on.

## Branch thresholds

`settings` key `kitchen.alerts` holds:

```json
{ "overdueMinutes": 10, "approachingMinutes": null }
```

- `overdueMinutes` is the branch's late threshold. The platform default remains
  the existing `DEFAULT_TICKET_AGING_MINUTES` (10).
- `approachingMinutes` is optional. `null` means no approaching alert; no
  preparation duration is invented.
- A business-level row (`location_id IS NULL`) can act as a default, with the
  branch row winning — the same layer shape as `printing.behavior`.
- The KDS caches the last authoritative value in local storage only as an
  offline fallback, then replaces it with the GET response.

Age is always `now - MIN(sent_to_kitchen_at)` from the persisted line. The KDS
shows the elapsed time, the configured thresholds and one of «در محدوده»,
«نزدیک آستانه» or «از آستانه گذشته».

## Device sound

`kds.sound-alerts` and `kds.sound-preferences` are browser-local. Sound is off
by default. Enabling it requires a click, creates/resumes the `AudioContext`
from that gesture and reports a visible `role="alert"` when the browser refuses
to play. Visual toasts and the persistent stale/reconnect banners remain on
regardless. Per-event sound switches cover new tickets, added items, aging,
connection changes and print-dispatch failures.

The print-dispatch worker already owns the visual warning and honours the shared
print policy; it emits `bizamiz:kitchen-print-failure` so an open KDS can add the
operator's opt-in tone and a persistent local line without starting a second
print-notification system.

## De-duplication rules

- The first KDS snapshot is a baseline: a page load or refresh never replays
  the whole queue as "new".
- Seen order and line ids only grow for the session, so a reconnect, a manual
  refresh or a stale response that briefly omits a line cannot alert twice.
- Aging alerts fire only when a ticket moves up a stage. A threshold change
  re-baselines the open tickets instead of firing one alert per ticket.
- The server uses the notification outbox's `(business_id, dedupe_key)` unique
  constraint for the same guarantees across devices and hybrid/offline replay.

## Tests

- `src/lib/kitchen-alerts.test.ts` — thresholds, stages, diffs, sound prefs.
- `src/lib/kitchen-alert-service.test.ts` — event payloads/dedupe keys and the
  aging scan's persisted-timestamp behaviour.
- `src/lib/notification-scans.test.ts` — F&B-only scan selection and failure
  isolation.
- `src/app/api/kitchen/alerts/route.test.ts` — permission and validation.
- `src/app/dashboard/kitchen/kds-board.test.tsx` — arrival, new round, denied
  autoplay, aging escalation, reconnect, duplicate suppression and the settings
  panel save flow.
- `src/app/dashboard/kitchen/kitchen-dispatch-agent.test.tsx` — print-failure
  handoff to the KDS.
