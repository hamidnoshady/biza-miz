# Phase 46 — One desktop, the full suite

**Status:** Implemented (migration 0192).

Phase 45 made the cloud the system of record and the desktop the till. It worked, but on a real
install (2026-10-01) it did not feel like one product:

| Symptom | Cause | Fix |
|---|---|---|
| The desktop menu listed only till screens; CRM, growth, the workspace and the assistant were a separate «نسخهٔ ابری» window | Phase 45 decision 3 (a second window) | The full menu, and cloud screens render **in the till window** (`CloudPane`) |
| A menu click often needed a second click, on the desktop and the cloud | The sidebar's branch switcher showed a 44px placeholder, then removed it on a one-branch business: every entry below jumped ~56px between the cursor aiming and the click landing. It happened again whenever navigation crossed a layout (`/accounting/*` ↔ `/settings`) and remounted the shell | The placeholder takes no space in the sidebar, and the answer is kept for the page's lifetime |
| «ورودی در انتظار ۸» / «در انتظار پیش‌نیاز ۸» on the desktop, forever | The cloud records purchase events for a paired branch; the desktop tried to replay them and waited for suppliers it never receives (stock is cloud-only since Phase 45) | A desktop acknowledges pulled stock, transfer and ledger-reversal events as applied no-ops (`siteSkipsPulledEvent`) |
| The cloud's «همگام‌سازی سرور» page showed «unreachable: fetch failed» from months ago | A central server never pushes or pulls; its push/pull rows were a leftover from before it was central | The push/pull rows are a site's only |
| «آخرین همگرایی دوطرفه: هنوز انجام نشده» while syncing fine | An idle pull did not record its success, and the converged point needed a push even with nothing to push | An idle pull records success; with nothing waiting to go up, the last pull is the converged point |
| No shift button for an owner at the till | The sidebar's shift control was PIN-roles only | Shown to anyone with `orders.create` — the permission `/api/shifts/start` checks |
| Signing in to the cloud screens meant a second password | — | «ورود با حساب ابری»: one click, both signed in |

## Decisions

1. **Cloud screens render inside the till window.** This reverses Phase 45 decision 3 at the
   owner's request. The guarantees of the old window carry over unchanged: the guest is an
   Electron `<webview>` with no preload, no Node, a sandbox and its own `persist:cloud`
   partition (`hardenCloudPane` on `will-attach-webview`, whatever the page asked for), and its
   navigation and redirects are pinned to the origin it was attached with (`guardCloudPane`);
   billing and subscription still go to the system browser. A browser on the LAN has no
   `<webview>` and gets a link.
2. **The cloud draws an embedded page without its own sidebar**, recognising the pane by a
   user-agent token (`src/lib/cloud-embed.ts`). Presentation only — nothing is granted or
   withheld on it; the cloud's session and API guards decide everything.
3. **The two addresses follow each other.** A menu click loads the guest; a link inside the
   guest moves the desktop's address with `history.replaceState` (so the menu highlights it),
   and a link to a till screen opens the local till instead. Sign-in pages are never mirrored.
4. **Home.** A member who can use the assistant lands on the cloud's assistant, like on the
   cloud; till staff land on their till screen (`siteHomeFor`), as in Phase 45.
5. **Offline.** The till keeps working; a cloud screen says it needs the Internet and reopens by
   itself when the connection returns. The desktop toasts the change both ways
   (`HybridConnectivityNotice`). PIN sign-in — owners and managers included — needs no Internet.
6. **One-click cloud sign-in** (`src/lib/desktop-cloud-login.ts`):
   1. The login screen's «ورود با حساب ابری» asks the local server for a `state` (an httpOnly
      cookie of that window) and opens the cloud's `/desktop-login` in the system browser.
   2. The signed-in member confirms; the cloud mints a two-minute single-use *device* code bound
      to that one paired install and a branch the member may work in, and hands the browser
      back with `businesssuite://cloud-login?code&state` (registered by the installer and by
      `app.setAsDefaultProtocolClient`).
   3. Electron loads `/api/auth/cloud-login/callback`; the local server checks `state` against
      its cookie and redeems the code with the install's own bearer credential
      (`POST /api/server-sync/desktop-login`). Only that install can redeem it.
   4. The desktop signs the member in locally (IAM sync gives desktop users the cloud's ids;
      a member not synced yet is told so) and keeps the answer's single-use *session* code in a
      two-minute httpOnly cookie, which the cloud pane spends once on the business's origin
      (`GET /api/auth/desktop-session`). Codes are stored as SHA-256 only and claimed with a
      conditional `UPDATE`; `desktop_login_codes` is tenant-scoped with RLS.

## Not in this phase

- Offline stock work, and copying history to the desktop (Phase 45's exclusions stand).
- A desktop without the embedded pane (an older shell): versions ship together in one installer.

## Exit criteria

- Unit: `src/lib/cloud-embed.test.ts`, `src/lib/desktop-cloud-login.test.ts`,
  `src/lib/desktop-cloud-pane.test.ts` (the guest hardening and navigation pinning),
  `src/components/cloud-pane.test.tsx`, the Phase 46 block of
  `src/lib/sync-event-registry.test.ts`, `src/lib/site-routes.test.ts`.
- `integration/tenant-isolation.integration.test.ts` covers the new table's RLS.
- On a real install: the desktop menu matches the cloud's; CRM, growth and the assistant open
  in the till window; pulling the cable keeps selling and toasts; «ورود با حساب ابری» signs in
  both the desktop and its cloud pane; the 8 stuck purchase events clear on the next tick.
