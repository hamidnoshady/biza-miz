# Phase 45 — Cloud-primary Hybrid (the desktop is the till)

**Status:** Designed — awaiting implementation plan.

Phase 44 made the Hybrid event transport reliable, but a paired desktop still pretended to be a
second copy of the whole suite. Only the till's data syncs (orders, payments, menu, customers,
staff), so every other desktop screen — the ledger, reports, stock, CRM — showed a partial local
copy that disagreed with the cloud. Found on a real install (2026-09-30):

| Symptom on the desktop | Cause |
|---|---|
| 12 bills on 29 Sep vs the cloud's 16 (drift alarm) | All 16 arrived; the desktop's branch has no `business_day_start_minutes` (the cloud's is 18:00), so it split the night at midnight. Branch settings are copied once at pairing and never again. |
| «شیفت انتخاب‌شده پیدا نشد», «شیفت بازی ثبت نشده» | `employee_shifts` is in no sync domain; the desktop has 0 shifts. |
| 20 journal documents vs the cloud's 1,033 | History is not copied, and most accounting actions (manual journals, cheques, expenses, AR/AP, opening balances) have no sync event. |
| AI switched off in the super-admin console still shows | Feature switches are copied once at pairing; «از دستیار بپرس» checks no switch at all. |

Adding a sync event for every action in four apps is a list that never ends, and double-entry
books cannot be merged from two writers. This phase takes the design every offline-capable POS
uses (Toast, Square, Lightspeed, Odoo POS): **the cloud is the system of record; the desktop is
the till**, and it keeps selling offline and syncs when the Internet returns.

## Decisions (owner's choices)

1. **Approach A — the till is always local, the back office is always the cloud.** Selling, floor &
   kitchen, and shifts & cash-up run on the desktop's local server whether online or not. Every
   other screen opens the cloud. Rejected: switching the whole window between cloud and local on
   connectivity (flips mid-bill, flaps on poor links, two selling paths).
2. **The cloud is unchanged and standalone.** Its POS, books and every app behave exactly as they
   do for a business with no desktop. It is never made read-only for a paired branch, and bills
   rung on the cloud POS for the branch keep reaching the desktop. The only cloud-side code this
   phase adds *accepts* shift events and *serves* one read-only profile to a paired desktop.
3. **Cloud screens open in a second app window**, not the system browser and never inside the
   till window.
4. **Offline scope is selling, floor & kitchen, and shifts & cash-up.** Stock work (purchases,
   waste, counts) moves to the cloud.

## Scope

Applies only where `deployment.profile = hybrid` **and** the runtime role is `site`. A
`local`-only install (no cloud) keeps the full local suite; the cloud is untouched.

### 1. Route split — `src/lib/site-routes.ts` (pure, unit-tested)

One list decides what a hybrid desktop renders locally:

- Selling: `/accounting/pos`, `/accounting/orders`, `/accounting/waiter`
- Floor & kitchen: `/accounting/floor`, `/accounting/kitchen`, `/accounting/reservations`,
  `/accounting/delivery`
- Shifts & cash-up: the shift controls inside those screens (no route of their own)
- Sign-in family (password, PIN) and the desktop's own settings: cloud sync, local devices/LAN,
  printers, local backup

Everything else is **cloud-by-default**, so a feature added later needs no sync work and cannot
appear half-populated on a desktop. `isSiteLocalRoute(pathname)` is the single predicate; it
uses the canonical routes (`ACCOUNTING_WORKSPACE_HREFS`), and legacy redirects resolve first.

Consumers:

- **Page gate** — `DeploymentCapabilityGate` gains the hybrid-site rule: a non-local path renders
  «این بخش در نسخهٔ ابری باز شد» and asks the desktop shell to open `cloudUrl + pathname` in the
  cloud window; offline it renders «این بخش به اینترنت نیاز دارد». The existing growth/website/AI
  entries become special cases of the same rule.
- **Menu** — the till window's navigation lists only local routes plus one «نسخهٔ ابری» button.
- **Home** — `/dashboard` on a hybrid site redirects to `/accounting/pos`.
- **APIs stay open.** Till screens read menu, customers, payment ways and similar endpoints, and
  the local server listens on loopback only. The split is a presentation boundary; the cloud's
  own API guard is what protects cloud data.

### 2. The cloud window — `electron/`

- A second `BrowserWindow` with `partition: "persist:cloud"` (the cloud login survives
  restarts), `sandbox: true`, `contextIsolation: true`, and **no preload**: a remote page never
  gets `pick-folder`, firewall or printer IPC.
- `will-navigate` restricted to the origin it was opened with; `window.open` goes to the system
  browser. One cloud window is reused and focused, not one per click.
- The till's preload exposes `openCloud(url)`; main accepts only `https:` URLs.
- A failed load (`did-fail-load`) shows a local «اتصال به اینترنت برقرار نیست — دوباره تلاش
  کنید» page with a retry.

### 3. Shift sync — new events `shift.opened@1` and `shift.closed@1`

- `openShift` and the close paths (`closeOwnShift`, `closeShiftById`) append the shift's full row
  (id, employee, location, business date, opening/closing float, started/ended, closed_by) with
  `appendSyncOutboxEvent` in their own transaction.
- A handler in `sync-domain-handlers.ts` upserts `employee_shifts` by id. `session_id` and
  `device_id` are device-local and replay as NULL. Closing an already-closed shift is idempotent.
  A shift whose employee has not arrived yet defers, like any other missing prerequisite.
- The existing machinery records on both sides, so a shift opened on the cloud POS for the
  branch also reaches the desktop. That keeps both sides' "the night ends at the cash-up" window
  the same.
- Registered in `data-ownership.ts` as a new `shifts` domain (contract bump) and documented in
  the supported-event list.

### 4. Site profile — cloud → desktop, `GET /api/server-sync/site-profile`

- Authenticated with the site bearer credential (`server-sync-auth.ts`), added to the three
  middleware session-less lists next to `master` and `digest`, and constrained to the
  credential's own location.
- Returns what the till needs and does not own:
  - branch: name, address, phone, timezone, `business_day_start_minutes`, is_active
  - effective feature switches (global flag state × `business_features`)
  - effective app availability (platform row, overridden per business)
- The desktop calls it on every sync tick after pull. If the response hash changed, it applies it
  in one transaction: updates `locations`, upserts `business_features`, and writes each app's
  effective state as a `business_app_availability` override (so the global catalogue on the
  desktop is never rewritten). Offline, the last applied copy stays in force.
- A failure is logged in the sync state like pull/push, backs off with the same `sync-backoff`,
  and is shown on the sync panel. It never blocks push or pull.

### 5. «از دستیار بپرس» follows the AI switch

`AskAssistant` renders nothing when the business's AI is off (the same entitlement the chat home
uses). This is a bug fix on every deployment, the cloud included.

## Offline and reconnect behaviour

- **Offline:** selling, tables, kitchen, reservations, delivery and shifts work as today. Bills,
  payments and shifts queue in `sync_events`. Cloud-window screens show the offline page. Branch
  settings and switches keep their last applied values.
- **Back online:** the existing wake-ups (`pg_notify`, long-poll) run a tick within seconds. It
  pushes queued events, pulls, refreshes the site profile, and the drift check compares the same
  business days on both sides.

## Not in this phase

- Stock work offline (purchases, waste, counts): cloud only.
- Copying history (pre-pairing bills, journals) to the desktop. With the desktop's accounting
  screens gone there is nothing to show it on.
- Removing the desktop's own ledger posting for sales. Selling code depends on it, and nobody
  reads it on a hybrid site any more.
- Making the cloud read-only for a paired branch (rejected, decision 2).
- Local-only installs: unchanged.

## Exit criteria

- `site-routes.test.ts`: every till route is local, and every other canonical app route
  (accounting ledger, reports, inventory, products, CRM, growth, website, AI, settings) is cloud.
- `integration/hybrid-sync.integration.test.ts` (two databases, real routes):
  - a shift opened and closed on the desktop appears on the cloud with the same id and floats;
  - a business-day start set on the cloud reaches the desktop, and both sides then bucket an
    after-midnight bill into the same day (the drift check agrees);
  - AI switched off on the cloud is off on the desktop after one tick.
- Unit tests for the site-profile apply diff and the shift event payload validation.
- `verify-shippables` passes (Electron sources parse; packaging constraints hold).
- On a real hybrid install: the desktop opens on the POS, «حسابداری» opens the cloud window
  logged in, pulling the network cable keeps selling working, and reconnecting delivers the
  queued bills and shift.
- `docs/server-sync.md`, the phase index and the CLAUDE.md Hybrid section describe the
  cloud-primary split.
