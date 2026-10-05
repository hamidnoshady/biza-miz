# Desktop Application — Testing Checklist

This checklist is for a human tester with access to a real Windows machine
and, ideally, a real receipt/kitchen printer. It was produced as part of the
desktop-application audit (see `AUDIT_REPORT.md`); none of these steps could
be executed inside the automated sandbox this audit ran in (no Postgres, no
Electron binary, no Windows printer). Everything below is either newly
introduced by the audit or an existing area the audit specifically touched
or reviewed.

Check off each item as `PASS` / `FAIL` / `N/A` with a one-line note. Items
marked **[NEW]** were built or changed during this audit and have zero
real-world verification yet — prioritize these first.

## 1. Fresh install

- [ ] Run the NSIS installer on a clean Windows machine (no prior install).
      Confirm it is **not** a silent one-click install (`oneClick: false`)
      — the wizard should let the user pick options.
- [ ] **[NEW]** During first run, confirm the storage-location prompt
      appears (Section 3): choose a non-default drive/folder, confirm the
      disk-space check and write/read/delete round-trip both run and give
      accurate results (e.g. point it at a full/read-only volume and
      confirm it's rejected with a clear message, not a silent failure).
- [ ] Confirm a *second* fresh install with the same choice does **not**
      re-prompt (the marker file should make `decideStorageBootstrap`
      reuse the recorded choice).
- [ ] Uninstall and reinstall; confirm existing business data survives
      (`deleteAppDataOnUninstall: false`).
- [ ] Confirm the app creates its DB/config/log files under the chosen
      location, not silently back at the Electron default.
- [ ] **[NEW]** Confirm a genuinely fresh install lands directly in the
      Section 8 split layout — `Configuration/config.json`, `Data/pgdata`,
      `Data/gateway-certificates` (once the mobile gateway is enabled),
      `Backup/emergency-backups` (once a restore has run), `Logs/desktop.log`
      — with nothing left flat at the chosen root.
- [ ] **[NEW] Upgrade path:** install an older build that predates the
      Section 8 split (flat `config.json`/`pgdata`/`logs`/
      `gateway-certificates`/`emergency-backups` directly under the storage
      root), run the app once with real business data in it, then install
      this build over it. Confirm on that first launch: (a) existing
      business data, settings, and the Postgres data directory are all
      intact after the move — nothing is lost or duplicated; (b) the app
      does **not** re-prompt for a storage location (the "already has data
      here" check must recognise the pre-migration flat `config.json`, not
      just the new `Configuration/config.json` path); (c) a second launch
      does not attempt the migration again (no-op, confirmed via the
      `.folder-layout-v1` marker file existing at the storage root).
- [ ] **[NEW]** Confirm backup/restore (`Section 6. Backup system` below)
      actually works on a **packaged** build, not just a dev run — this is
      the surface a real bug regressed silently in prior desktop builds
      (`PG_TOOLS_DIR` never reached the spawned server process, so
      `pg_dump`/`pg_restore` failed with
      `{pg_dump,pg_restore}_packaged_tools_not_configured`). A packaged
      install must be able to complete both a manual backup and a restore
      without that error.

## 2. First-run wizard (Cloud vs Local)

- [ ] Choose "Cloud Connected" — pair against a real cloud tenant using a
      pairing code; confirm the resulting session is scoped to the right
      business and the sync token round-trips correctly.
- [ ] Choose "Local Desktop Mode" — confirm a fully offline business
      bootstraps with no network calls attempted.
- [ ] Attempt pairing with an invalid/expired/already-redeemed code;
      confirm each produces a distinct, correct error message (not a
      generic "code is not valid" for a token-vs-code mix-up specifically).
- [ ] Attempt pairing against an unreachable remote URL; confirm
      "server unreachable" is shown, not a stack trace or infinite spinner.

### 2b. Hybrid login credentials at pairing **[NEW — issue #843]**

The regression: a paired desktop reached login showing only the owner created
during setup, even though cloud staff with PINs existed — because membership
metadata had synced while the credential/PIN plane had not. The automated
coverage lives in `integration/hybrid-credential-sync.integration.test.ts`;
this is the packaged-desktop pass of the same scenario.

- [ ] On the cloud, create a business with an owner, a manager and three PIN
      staff (cashier, waiter, kitchen), each with a PIN.
- [ ] Pair a **fresh** Windows desktop (empty database) with that business and
      finish the owner's device-local offline PIN step.
- [ ] Reach `/login` **immediately**: the quick-login roster must already show
      all three PIN staff — not just the owner — and each cloud PIN must sign
      its member in on the desktop.
- [ ] Confirm the manager (password role, no PIN) is **not** forced into the
      staff roster, and that the owner's offline PIN still works.
- [ ] Restart the app; the roster still shows all three staff. Then disable the
      network and sign in with the same cloud PIN — offline login must work.
- [ ] Change the cashier's PIN on the cloud, run Settings → اتصال و
      همگام‌سازی → «همگام‌سازی دوباره»; the old PIN must fail locally and the
      new one must work.
- [ ] Suspend the waiter on the cloud, sync again; the waiter must disappear
      from the roster and any existing desktop session must be invalidated.
- [ ] Offboard the kitchen member on the cloud and sync: the member disappears
      from the roster, any desktop session ends, and their replicated PIN is
      revoked rather than merely hidden (reactivating them without a cloud PIN
      must not let the old PIN back in).
- [ ] Simulate a credential failure (point the desktop at a cloud whose
      `/api/iam/login-credentials` returns 500, or stop it mid-pairing):
      Settings must show «رمز و پین ورود کارکنان: نیازمند بررسی» with the
      count of unready PIN accounts, the login screen must show
      «برخی حساب‌های کارکنان هنوز برای ورود آفلاین همگام نشده‌اند», and neither
      may claim the installation is fully healthy. «همگام‌سازی دوباره» must
      repair it once the cloud answers again.
- [ ] With the cashier's credential deliberately not yet converged, try
      «ورود با حساب ابری» for a password-role member: the desktop must refuse
      with the identity-sync-pending message rather than signing them in
      (that session would sit outside the cloud's token-version revocation).

## 3. Authentication flow — Choose Login Type **[NEW]**

- [ ] On first visit to `/login` on a fresh browser profile, confirm the
      three-card chooser (Staff / Admin / Offline Local) appears — **not**
      the staff roster directly.
- [ ] Choose "Staff" without checking "remember this device"; reload
      `/login` — confirm the chooser reappears (not remembered).
- [ ] Choose "Staff" **with** "remember this device" checked; reload
      `/login` — confirm it goes straight to the staff roster this time.
- [ ] From the staff roster, click "Change login type" — confirm it
      returns to the three-card chooser.
- [ ] Choose "Admin" — confirm it navigates to `/admin` and the admin
      login form has a "Staff? go to staff login" link back.
- [ ] Choose "Offline Local Login" — confirm it lands on the identical
      staff PIN flow with a footnote explaining it needs no internet, and
      confirm it actually works with the network disabled.
- [ ] Log in as staff, then use "Switch account" from the platform user
      menu — confirm it signs out **and** clears the remembered door, so
      `/login` shows the chooser again (distinct from plain "Logout",
      which should sign out without necessarily resetting the chooser).
- [ ] Confirm a plain "Logout" fully invalidates the session (subsequent
      protected API calls are rejected).
- [ ] Confirm attempting to reach `/admin`-only settings (cloud
      connection, users, sync, backup config) as a logged-in staff user is
      rejected server-side, independent of which door the UI showed.

## 4. Offline operation

- [ ] With no internet connection, complete a full order end-to-end
      (product lookup → cart → payment → receipt) on a Local Desktop Mode
      or already-paired Cloud Connected install.
- [ ] **[UPDATED]** While offline, take an order action (create order, add
      items, change an item's status) and a waste-logging action
      (Inventory → «ثبت ضایعات»); confirm both land in the local sync
      queue with `status: "pending"` (Section 5's state machine), not
      silently dropped or double-applied. These are, by design, the only
      client-offline-queue-backed actions in this app — a call-site audit
      this cycle confirmed Products/Customers/Accounting/Settings/Users/
      Images/Reports do not use this queue (they instead rely on
      `server-sync.ts`'s separate cross-device push/pull mechanism once
      back online, which requires connectivity to the local server too, so
      an action there while genuinely offline should be understood to wait
      rather than queue).
- [ ] Reconnect the network; confirm queued items transition
      `pending → syncing → completed` and disappear from the pending list.
- [ ] Force a server-side rejection of one queued item (e.g. a stale
      record); confirm it goes to `retryCount++` / `pending` again rather
      than being silently dropped, and eventually to `failed` after
      exceeding the retry ceiling — not stuck retrying forever.
- [ ] Force a genuine conflict (edit the same record from two offline
      devices, then let both sync); confirm the queue item lands in
      `status: "conflict"` and is surfced to an admin rather than silently
      overwriting one side.

## 5. Printer system **[NEW — needs real Windows + real hardware]**

> Everything in this section is implemented with unit-tested logic only.
> None of it has run against a real Windows print spooler or real
> hardware. Do not skip this section before shipping.

- [ ] On a real Windows machine with at least one installed printer,
      confirm `desktop:print-list-windows-printers` returns the actual
      installed printer list (via `window.businessSuiteDesktop.printing`),
      not an empty list or an error.
- [ ] Select a printer as "Default", print a test page — confirm actual
      paper output, correct encoding (Persian text, if applicable),
      correct paper width/cut behavior for a receipt printer.
- [ ] Configure a second printer as "Kitchen" and a third as "Label" (if
      available); confirm each order type routes to the correct assigned
      printer, not all to the default.
- [ ] Test a network ESC/POS printer (TCP socket path, not `winspool.drv`)
      — confirm discovery (`-discover-network`) finds it on the LAN and
      a raw send (`-send-raw`) produces real output.
- [ ] Deliberately point at an offline/nonexistent printer; confirm the
      error surfaced to the UI is a clear, canonical error code (per
      `src/lib/printing/errors.ts`), not a raw PowerShell/C# stack trace.
- [ ] Confirm this desktop print path works with **no** print-connector
      process running at all (the whole point of Section 7) — kill/never
      start the connector and confirm printing still works from the
      desktop app.
- [ ] Separately, confirm the **browser/cloud** version still requires and
      correctly uses the connector (unchanged by this audit) — this is a
      regression check, not a new feature check.

## 6. Backup system

- [ ] Configure a local backup destination on a non-default drive; trigger
      a manual backup; confirm the artifact lands there.
- [ ] Configure each schedule interval option and confirm the "next backup
      due" calculation (`latestSlotBefore`/staleness logic) matches
      expectations for at least one short interval (e.g. 1h) and the daily
      (24h) case.
- [ ] Set local retention to a small number (e.g. 2) and cloud retention
      to a large number; run enough manual backups to exceed local
      retention; confirm old local artifacts are pruned while cloud
      artifacts are not (retention is applied per-target, independently).
- [ ] Configure S3-compatible cloud backup (Arvan/Backblaze/MinIO or
      equivalent) end-to-end; confirm a real upload succeeds and appears
      in the restore list's "cloud" column.
- [ ] Run the restore wizard: pick an artifact, let it verify into the
      scratch database, confirm the verification summary is shown, then
      confirm the live database is **not** touched until explicit
      confirmation, and correctly replaced after confirmation.
- [ ] Attempt to start a second restore while one is in progress; confirm
      it's rejected with "a restore is already in progress," not silently
      queued or run concurrently.

## 7. Update system

- [ ] With a paired Cloud Connected install, confirm the Owner's settings
      panel correctly shows "up to date" vs. "update available" based on
      the real running cloud version.
- [ ] **[Confirm audit fix]** Read the update-available banner text;
      confirm it says installing the new version is a **manual**
      administrator step and recommends taking a backup first — it must
      **not** imply the update installs itself automatically.
- [ ] Perform a real manual update (download + run the new installer over
      an existing install); confirm all business data, settings, and
      backup history survive.
- [ ] After the update, confirm the Owner's settings panel now reports the
      new version as current.

## 8. Error handling **[NEW]**

- [ ] Force a render-time error inside the app shell (e.g. throw in a
      dashboard page during development); confirm `error.tsx` shows a
      friendly message, a short `ERR-XXXX-XXXX` error ID distinct from any
      `digest`, and an expandable technical-details section.
- [ ] Click "دریافت فایل گزارش‌ها" (export logs); confirm a file downloads
      containing the ring-buffer of recent client errors, and that no
      secret/token/connection-string value appears in it even if one was
      present in the underlying error context (redaction check).
- [ ] Force a **root-layout**-level error (severe enough to hit
      `global-error.tsx` instead of `error.tsx`); confirm the same
      error-ID/export behavior works from that self-contained page too.
- [ ] Open Settings → گزارش‌ها (Logs) tab; confirm it shows the same
      exportable client log, and on a desktop build, confirm the "open
      log folder" button actually reveals the Electron process log
      directory in the OS file browser.
- [ ] **[NEW]** Trigger a plain API/fetch error inside a dashboard page
      (e.g. force a `/api/...` route to return a 500, or disconnect the
      network mid-request); confirm the on-screen message is unchanged
      (still the existing `ErrorBox`/`errorMessage()` Persian text — no new
      UI element appears here by design), but confirm the failure **does**
      now show up in Settings → گزارش‌ها (Logs) → "دریافت فایل گزارش خطاها"
      after the fact, with the failing URL/method/status visible in the
      exported text.
- [ ] **[NEW]** Trigger an ordinary validation rejection instead (e.g.
      submit a form with a required field empty, a 400/404/409 response);
      confirm it does **not** appear in the exported log — only genuinely
      unexpected failures (5xx / dropped connection) are recorded, so a
      normal "please fill in this field" message is not treated as a bug.

## 9. General regression pass

- [ ] Run `npx tsc --noEmit` and `npx eslint .` — both must be clean.
- [ ] Run `npx vitest run` — should be **≥ 385 files / ≥ 5499 tests**,
      zero failures (this was the state at audit completion; a regression
      below this count means something in this audit's work broke).
- [ ] Spot-check Persian RTL rendering and Shamsi (Jalali) date display on
      every screen touched by this audit (login chooser, storage wizard,
      printer settings, logs tab, error screens) — none of these should
      look or behave differently from the rest of the app's existing
      design system.
