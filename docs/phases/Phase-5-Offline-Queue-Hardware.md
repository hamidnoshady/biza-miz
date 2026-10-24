# Phase 5 — Offline Queue + Hardware

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–4
**Goal:** A device briefly losing LAN connection doesn't lose data, and receipts/kitchen tickets print correctly on real hardware, with cash drawer control.

---

## Scope

- IndexedDB queue (Dexie.js) on each client: order actions taken while disconnected from the local server queue locally and sync on reconnect
- Conflict handling: what happens if two devices' queued actions conflict on reconnect
- **Print connector** — a small local helper running on the till PC: exposes a loopback HTTP endpoint the browser calls, delivers finished ESC/POS bytes to receipt and kitchen printers (Windows spooler or network TCP), triggers the cash drawer kick, and backs the setup wizard's test-print step for real
- Receipt template (customer-facing) and kitchen ticket template (kitchen-facing), both RTL/Persian-correct

## Out of scope (later phases)

- Inventory (Phase 6)
- Ledger (Phase 7)
- USB/Bluetooth printer connections (only IP/port network printers, matching what Phase 1's wizard already captures)
- Split/partial payments (checkout records one full payment per order; see decision 6)

## Exit criteria

- Pulling the WiFi mid-order on a client doesn't lose the order; reconnecting syncs it correctly with no duplication
- A real (or test/emulated) receipt printer produces a correctly formatted, correctly RTL Persian receipt
- Cash drawer opens on triggering payment completion
- Kitchen ticket prints correctly if a physical kitchen printer is used (in addition to/instead of the KDS screen)

---

## Questions to answer before/during this phase

1. **Printer hardware** — what exact printer model(s)? (Determines the ESC/POS command set and connection type.)
2. **Cash drawer** — via the receipt printer's RJ11 port, or a standalone drawer?
3. **Kitchen printing vs. KDS-only** — physical printed tickets in addition to the screen, or is the screen enough?
4. **Receipt content/branding** — logo, business info, footer message?
5. **Conflict resolution preference** — last-write-wins, flag for manual review, or something else?
6. **Card payment terminal** — separate physical terminal (software just records "paid by card"), or does software talk to it directly?

---

## Decisions on Phase 5 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Printer hardware** — no specific model, on purpose. Rather than guess a codepage/Persian-font setup that might not match whatever gets bought, printing targets the universal ESC/POS `GS v 0` raster-image command, supported by essentially every ESC/POS-compatible printer regardless of brand or firmware. Hardware is reached one of two ways — a Windows-installed queue (`type: "windows"`) or a raw TCP socket to `ip:port` (port 9100 by default, `type: "network"`). Direct USB device access (WebUSB) was tried and removed: a USB thermal printer installs in Windows and is a `windows` printer. (The original plan of a Node.js print agent was replaced by a dependency-free PowerShell connector — see the note below.)
2. **Cash drawer** — assumed wired through the receipt printer's RJ11 port (the common setup), kicked with the standard `ESC p` pulse command (`src/lib/escpos.ts`'s `openDrawerPin`/`buildDrawerKickJob`). No standalone drawer controller in v1.
3. **Kitchen printing vs. KDS-only** — both. Sending to kitchen prints a ticket (if a kitchen printer is configured) *in addition to* the existing KDS broadcast (Phase 4); missing/unreachable hardware never blocks the order.
4. **Receipt content/branding** — business name + location address/phone (`GET /api/business-info`) and a static thank-you footer. No logo/social handles in v1 — `ReceiptData.business.footerMessage` is free text already, ready to wire to a settings field later without a template change.
5. **Conflict resolution** — replay-based, not blind last-write-wins. `order.create`/`order.add_items` are pure appends, so they never conflict — the server-side idempotency key (`client_event_id`) only guards against a client retrying its own flush. `order_item.status` updates re-validate against the existing status machine (`order-item-status.ts`) at replay time via `offline-sync.ts`'s `classifyStatusReplay`: a transition that's still legal from the item's *current* state applies; landing on the state it's already in is a harmless duplicate; anything else (already voided, superseded by a different device's action) is flagged a conflict instead of silently overwritten.
6. **Card payment terminal** — separate physical terminal; the app only records which method was used after the fact (`POST /api/orders/[id]/pay`), matching what Phase 1's wizard already assumed. No terminal integration.

### Offline queue

`sync_events` (migration 0001, unused until now) is the server-side idempotent inbox: `UNIQUE (location_id, client_event_id)` lets a client retry a flush without double-applying it. The client side is `src/lib/offline-db.ts` (Dexie `pendingActions` table, one row per queued mutation, keyed by a client-generated uuid that doubles as `client_event_id`) plus `src/app/dashboard/offline-queue.tsx`:

- `apiOrQueue()` wraps a mutation's fetch. A real network failure (fetch throws — LAN drop, agent unreachable) queues the action and reports success-with-`queued: true` to the caller; a server-side rejection (validation error, 409, …) still comes back as a normal failure — only "the request never reached the server" gets queued.
- `flushQueue()` POSTs the whole queue to `POST /api/sync/events`, in the order actions were queued, on the `online` event and every 15s while online; whatever the server reports as applied *or* conflicted is removed (nothing left to usefully retry either way).
- `useOfflineQueue()` + `OfflineBanner` (mounted in the dashboard layout) surface pending-count / offline state on every screen.
- Wired at the four places an order/kitchen action can be lost mid-service: POS order submit (`pos-screen.tsx`), order-detail "add item," waiter "send to kitchen" (`table-order-panel.tsx`), and both kitchen-bump (`kds-board.tsx`) and mark-served status updates.

**Sync Queue System (desktop offline-first audit, Section 5).** Each queued row now carries the full lifecycle the audit's spec asked for — `id / action_type (type) / table / record_id (recordId) / created_at (createdAt) / status / retry_count (retryCount)` — instead of the original implicit two-state model (present until flushed, then deleted). `src/lib/sync-queue.ts` holds the pure state machine (`SyncQueueStatus`: `pending → syncing → completed` on success, back to `pending` with `retryCount++` on a plain rejection, to `failed` once `retryCount` hits `MAX_SYNC_RETRIES` (5, with exponential backoff before the next attempt), or to `conflict` on a flagged two-device conflict — `conflict`/`failed` are terminal until a human acts). `src/lib/offline-db.ts` is a Dexie v2 schema (`upgrade()` backfills pre-existing rows as fresh `pending` entries). The Devices settings tab (`sync-queue-panel.tsx`) lists every entry with its status badge and, for `failed`/`conflict` rows, "تلاش دوباره" (re-arm and retry) / "حذف از صف" (discard) actions; `OfflineBanner` gets a distinct, highest-priority message when any entry needs that attention. This closes the gap where a server-side rejection (not just a network drop) or a real conflict used to sit in the queue forever with no visible outcome, or — for a flagged conflict — was silently deleted with no record a human ever saw it.

Server side, `src/lib/sync-events.ts` dispatches each event to the *same* transaction functions the synchronous routes use — `src/lib/order-mutations.ts` (`createOrder`/`addItemsToOrder`) was extracted out of `POST /api/orders` and `POST /api/orders/[id]/items` specifically so an order created while offline can't behave differently from one created online. `order_item.status` events go through `classifyStatusReplay` (decision 5) before touching the DB.

### Print hardware (as shipped — superseded the original Node print agent)

> The phase originally shipped a Node.js `print-agent/` service. It was later
> replaced during the printing rebuild: the cashier machine runs the
> **Cafe POS Windows Print Connector** (`public/windows/cafe-pos-print-connector.ps1`)
> — dependency-free PowerShell, loopback `127.0.0.1:9123`, exact-origin,
> installed with one click from the app. It handles **both** hardware types:
> Windows queues (native winspool RAW) and network TCP (port 9100), plus local
> network discovery. The app server renders every job to canonical ESC/POS
> bytes (`POST /api/printing/print`, printerId-scoped); the browser forwards
> them through the connector. Current details: [docs/features/printing.md](../features/printing.md).

The render pipeline is unchanged since this phase, just relocated server-side:

1. Pure HTML string (`src/lib/receipt-template.ts` / `src/lib/kitchen-ticket-template.ts` — RTL, Persian digits, Jalali dates via the existing `digits.ts`/`jalali.ts`/`money.ts` helpers, unit-tested as strings, no DB/rendering)
2. Real Chromium screenshot (`src/lib/printing/chromium.ts`, via `playwright-core`, with the repo's bundled Vazirmatn font embedded as a data URI so Persian shaping/BiDi is handled by an actual browser engine)
3. Grayscale decode (`src/lib/printing/raster.ts`, via `pngjs`)
4. 1-bit ESC/POS raster packing (`src/lib/escpos.ts`'s `packMonochromeRaster`, unit-tested)
5. Server packs the finished bytes; delivery to hardware happens on the till PC through the connector (winspool RAW or raw TCP)

Why raster instead of ESC/POS text mode: no printer we could target ships a codepage that covers Persian (not just Arabic) correctly, and none do BiDi reordering — rendering with a real browser sidesteps both problems and works on any ESC/POS-compatible printer, not a specific model (decision 1). This was verified end-to-end in this session: rendering a sample receipt through the full pipeline into a PNG showed correctly shaped, correctly right-to-left Persian text and the right Jalali date.

`GET /api/printers` (any dashboard role) and `GET /api/business-info` let the browser assemble what a print needs without going through the manager-only `/api/setup/*` endpoints; the hardware job itself goes through `POST /api/printing/print`, which resolves the `printerId` against the caller's branch server-side. Checkout (`POST /api/orders/[id]/pay`) is new in this phase — orders never reached `status = 'completed'` anywhere before it (`table-session-service.ts`'s `closeSession` only ever freed the table; payment recording didn't exist). It records one full payment (v1: no split/partial — decision 6) and completes the order; `order-detail.tsx`'s `pay()` then best-effort prints the receipt and, for cash, kicks the drawer, never blocking checkout success if the agent or printer is unreachable.

The setup wizard's hardware step now embeds the same printers panel Settings uses (`printers-panel.tsx`): pair a real printer with a test print before save, or skip — the step completes without hardware present.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Pulling WiFi mid-order doesn't lose the order; reconnect syncs with no duplication | `offline-db.ts` + `offline-queue.tsx` queue `order.create`/`order.add_items`/`order_item.status`; `POST /api/sync/events` + `sync-events.ts` apply idempotently keyed on `client_event_id` (`sync_events` UNIQUE constraint) |
| A receipt printer produces a correctly formatted, correctly RTL Persian receipt | `receipt-template.ts` (tested) rendered by `src/lib/printing/chromium.ts` via real Chromium, delivered through the Windows print connector — verified end-to-end in this session |
| Cash drawer opens on payment completion | `POST /api/orders/[id]/pay` + `order-detail.tsx`'s `pay()` calls `kickDrawer()` for cash payments; `escpos.ts`'s `openDrawerPin`/`buildDrawerKickJob` (tested) |
| Kitchen ticket prints in addition to the KDS | `kitchen-ticket-template.ts` (tested); `pos-screen.tsx`/`table-order-panel.tsx` call `printKitchenTicket()` alongside the existing KDS broadcast (Phase 4) |

Schema: no new migration in this phase — migration 0001 already modeled `sync_events`, `printers`, and `payments`/`orders.status = 'completed'`; the printer `connection` column was later reshaped by migration 0155 (`system`→`windows`, legacy transports → reconnect-required). Unit tests: `escpos.test.ts`, `receipt-template.test.ts`, `kitchen-ticket-template.test.ts`, `offline-sync.test.ts`, plus the current printing suite under `src/lib/printing/`.
