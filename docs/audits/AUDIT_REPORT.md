# Desktop Application Audit — Technical Report

**Scope:** Full audit, redesign, and offline-architecture hardening of the
desktop (Electron) client and its shared Next.js application, across the 14
sections requested (UI/UX, first-run wizard, local storage config, auth
flow, offline-first/sync, cloud↔desktop relationship, printing, installer,
settings center, backup, updates, error handling, code audit, deliverables).

**Method:** Postgres is not available in this sandbox, and there is no
Electron binary to launch, so verification was limited to static analysis
(`tsc --noEmit`, `eslint`) and the existing Vitest unit/pure-logic suite —
nothing that requires a live database, a live Electron process, or real
Windows printer hardware was executed end-to-end. Every native-Windows-only
code path added during this audit is implemented with an injectable
`run`/`connect`/`listInterfaces` seam specifically so its *logic* is
unit-testable without a Windows box, but it still needs a real Windows
verification pass before being trusted in production — this is called out
explicitly wherever it applies below, per the standing instruction not to
claim hardware verification that never happened.

**Baseline at completion:** `npx tsc --noEmit` clean · `npx eslint .` clean ·
`npx vitest run` → **385 files / 5499 tests, all passing**. Branch
`arena/01a0c899-cafe-restaurant-pos`; see the commit-chain table in §3 for
the full, current list of commits (each tagged with the section(s) and
files it covers).

---

## 1. Executive summary

This codebase (a Persian-RTL, Jalali-dated, integer-Rial café/restaurant
POS with a Next.js app shell wrapped in an Electron desktop shell) was, on
inspection, considerably more mature than a typical "needs a full audit"
brief implies. Most of the 14 requested sections turned out to already have
a correct, well-tested implementation on `main`; the audit's job in those
cases was to *confirm* correctness and document it, not to rebuild it. A
smaller number of sections had **real, confirmed gaps** — a login flow that
skipped the door-choice screen, dark gradients inconsistent with the design
system, a fake two-state sync queue instead of the specified state machine,
no local-storage picker at first run, a printer path that required an
always-running connector service even on desktop, error screens with no
error ID or exportable log, and one instance of UI copy that overclaimed an
auto-update capability the backend deliberately does not have. Those are
the changes actually shipped in this engagement; they are listed file-by-
file in §3.

Two categories of finding are *documented but intentionally not
"fixed"*, because closing them would either violate the standing
instruction against faking hardware verification, or would require
infrastructure (code signing, a rollback story) well outside a UI/logic
audit's blast radius:

- **Native Windows printing** (§3.7) is implemented and unit-tested, but
  has never run against a real Windows print spooler or real thermal
  hardware in this engagement.
- **Automatic update installation** (§3.11) remains deliberately disabled;
  the audit's job there was to make the UI honest about that fact, not to
  build an auto-updater, since electron-builder auto-update needs signing
  and rollback infrastructure this codebase does not yet have.

## 2. Section-by-section findings

### Section 1 — Desktop UI/UX redesign
**Finding (confirmed bug):** setup/login screens used dark gradient
backgrounds and right-anchored form layouts inconsistent with the app's
design-system tokens used everywhere else.
**Fix:** removed the gradients, switched to the standard solid
background/card tokens, centered the forms. See `687794b`.
**Residual:** a full pixel-level pass over every settings sub-page was out
of scope given the size of the codebase; the fix targeted the setup/login
surfaces named explicitly in the brief.
**Follow-up sweep (this cycle):** searched the rest of `src/app` for any
other dark-gradient usage the original fix might have missed
(`bg-gradient-to-*`/`from-slate-900`/`from-gray-900`/`from-black`/
`via-black`/`bg-clip-text`). The only hit outside the already-fixed
setup/login surfaces is `src/app/dashboard/ai/ai-chat-hub.tsx`'s hero
section (two gradients: an icon tile and a heading). Both use semantic
design-system tokens — `from-primary to-primary/70` and `from-foreground
to-foreground/60` — not a raw dark/black color, so this is compliant with
the "remove dark gradients" requirement rather than a residual violation
and was left as-is.

### Section 2 — First-run wizard (Cloud Connected vs Local Desktop Mode)
**Finding:** already implemented (`src/app/welcome/*`) — a welcome step
that branches into pairing a cloud tenant vs. bootstrapping a fully local
business, before either credential is set up. No changes required; this
audit only confirmed the branch exists and both paths reach a working
first-user state.

### Section 3 — Local storage configuration wizard
**Finding (confirmed gap):** before this engagement, exactly one path (the
backup destination) was user-choosable, and even that took a typed path
with no validation. The embedded Postgres data directory, `config.json`,
and logs were silently pinned to Electron's default `userData` path with
no visibility and no way to pick a different disk before first run.
**Fix (`5d1fb7a`):** `electron/local-storage.js` — real disk-space check
(`fs.promises.statfs` against the closest existing ancestor, since the
target folder usually doesn't exist yet), a real write/read/delete round
trip to prove the folder is actually usable (not just that `fs.access`
didn't throw), and `decideStorageBootstrap()`, a pure function deciding
whether to prompt, reuse a recorded choice, or leave an existing install
alone (so it never re-prompts and silently relocates data on an existing
site). A marker file at the default `userData` path remembers the answer.
**Residual:** Browse-button UI wiring for attachments/images/reports
folders individually (vs. one storage root) was not built — the fix
covers the DB/config/logs root, which is the piece silently defaulted with
no visibility before. Splitting each artifact type into its own
independently-configurable folder was judged lower priority than the root
gap and is not done.

### Section 4 — Authentication flow (Choose Login Type)
**Finding (confirmed bug):** `/login` went straight to the staff PIN
roster on every visit; `/admin` existed but had no discoverable link
anywhere a first-time user would see it (the only mention was a caption
three steps into the phone-OTP flow).
**Fix (`687794b`):** `src/lib/login-door.ts` (device-local, non-security
"which door did this browser last use" memory) +
`src/components/auth/login-door-chooser.tsx` (a three-card chooser: Staff /
Admin / Offline Local, shown once per browser unless remembered, reachable
again at any time via a persistent "Change login type" link). Also added a
"Switch account" menu action distinct from plain logout
(`src/lib/platform-user-menu.ts`) that clears the remembered door so
`/login` shows the chooser again, and an escape hatch on the admin door
back to staff login so neither door is ever a dead end.
**Confirmed already correct, no change needed:** admin-vs-staff
authorization was never actually enforced client-side by the missing
chooser — `/admin` and `/login`'s underlying API routes
(`/api/auth/login`, `/api/auth/pin-login`) already gate who may sign in
where server-side; the chooser is a UI-discoverability fix, not a security
fix.

### Section 5 — Offline-first architecture / Sync Queue System
**Finding (confirmed gap):** the client offline queue existed
(`offline-db.ts`, a Dexie table) but only had an implicit two-state model
— a queued action was present until flushed, then deleted whether the
flush succeeded or failed. There was no Pending/Syncing/Completed/Failed/
Conflict lifecycle, no retry count, and no per-record identity to reconcile
against the server.
**Fix (`f0973d9`):** `src/lib/sync-queue.ts` — a pure state machine adding
exactly the spec's fields (`id`/`action_type`/`table`/`record_id`/
`created_at`/`status`/`retry_count`, in this repo's camelCase convention),
`classifyFlushOutcome` (success → completed; server rejection → pending
with incremented retry count, or failed once retries are exhausted;
flagged conflict → conflict), exponential retry backoff, and
`resolveQueueRecordRef` mapping each action type to its table/record id.
17 unit tests. `offline-db.ts`'s Dexie schema bumped to v2 with an
`upgrade()` backfill so pre-existing queued rows on an already-deployed
install get sane defaults instead of breaking the migration.
**Follow-up audit (this cycle) — call-site coverage, corrected finding:**
grepped every `apiOrQueue`/`enqueueAction` call site repo-wide: the client
queue was used in exactly 4 files covering exactly 3 action types
(`order.create`, `order.add_items`, `order_item.status`) — zero usage in
Products/Customers/Accounting/Settings/Users/Images/Reports.
`docs/phases/Phase-5-Offline-Queue-Hardware.md`'s explicit scope section
confirms this was the *original design boundary*, not an unaudited gap —
those domains never wired into the client queue at all, so there was
nothing left to "spot-check" per call site (the prior wording above was
imprecise and is corrected here). Separately, `server-sync.ts`'s
push/pull mechanism (over `sync_events`/`sync_domain_effects`, ~20
registered event types in `sync-event-registry.ts`) already gives those
other domains cross-device/cloud sync — a genuinely different mechanism
from the client's local Dexie queue.
**Follow-up feature (this cycle — see commit-chain table in §3 for the exact
hash) — extended the queue to a second domain as a real proof-of-pattern
build, not just documentation:**
`inventory.waste.recorded` is now the client queue's first non-order action
type. This was chosen because its server-side transactional domain handler
already existed and was already idempotent by `clientEventId`
(`waste-service.ts`, Phase 32) — the change opens an existing, already-safe
server capability to the offline queue rather than writing new posting
logic. Changes: `sync-event-registry.ts` gained an `offlineQueueEligible`
flag (a definition existing in the registry for the server-to-server sync
engine no longer implies the client queue may post it — only types
explicitly opted in, alongside real client wiring, may) and a new
`isOfflineQueueEligible()` helper; `/api/sync/events/route.ts` now gates on
that helper instead of `?.legacy`; `offline-db.ts`'s `PendingActionType`
and `sync-queue.ts`'s `resolveQueueRecordRef` gained the new type (targets
`inventory_items`, no server-assigned record id until it applies, same
shape as `order.create`); `waste-section.tsx`'s submit handler now calls
`apiOrQueue` instead of a plain `api()` POST, with an inline Persian
"queued for later" notice matching the existing order-detail-modal pattern;
`sync-queue-panel.tsx`'s `actionTypeLabel` (the Devices settings tab's
queue list) gained a Persian label for the new type instead of falling
back to the raw event-type string. No new server posting/ledger logic was
written. 10 new tests: registry
eligibility (`sync-event-registry.test.ts`), the new `resolveQueueRecordRef`
case (`sync-queue.test.ts`), and a new `route.test.ts` for
`/api/sync/events` pinning that a transactional type merely existing in the
registry (e.g. `order.payment.completed`) is still rejected as
`invalid_event` unless explicitly opted in.
**Residual (deliberately out of scope, unchanged from before):** the other
7 domains (Products/Customers/Accounting/Settings/Users/Images/Reports)
remain on `server-sync.ts`'s cross-device mechanism only, not the client
offline queue — extending further was assessed as a larger scope decision
per domain (conflict semantics, UI wiring, dedicated server handlers where
none exist yet) than this cycle's one-domain proof-of-pattern build, and is
left for a future phase rather than attempted piecemeal here.
**Final scope decision (this cycle, "do all jobs" pass):** re-evaluated
whether to migrate any further domain onto the client queue before closing
this engagement, and explicitly decided not to. Each remaining domain
would need its own conflict-resolution semantics, its own idempotent
server-side handler audit (the waste domain only qualified because
`waste-service.ts` was already `clientEventId`-idempotent — that is not
yet established for the other 7), and its own UI wiring reviewed against
that domain's specific offline/online transition risks (e.g. Accounting
entries are far higher-stakes to double-post than a waste log). Attempting
several of these in one pass, unaudited, inside an already-large
engagement would be exactly the kind of unscoped, risky rewrite the
standing "no temporary/cosmetic-only fixes" and "do not fake verification"
instructions warn against in spirit — a shallow multi-domain change here
would be worse than the current, honestly-documented single-domain
boundary. This is recorded as an explicit decision, not a silent omission.

### Section 6 — Cloud/Desktop installation relationship audit
**Finding:** reviewed `src/lib/server-sync.ts` (token/credential
resolution — per-business token hashing with a legacy single-secret
fallback, constant-time comparison), `src/app/api/setup/pair/route.ts` and
its `test/route.ts` sibling (pairing-code redemption and pre-bootstrap
connectivity probing — both include TOCTOU protection via a
re-checked `hasAnyUser()` immediately before the database write), and
`DESKTOP_INSTANCE_ID`/`DESKTOP_DEVICE_NAME` (set by
`electron/backend-manager.js`, consumed by `/api/health` for the
child-process readiness handshake). **No structural bugs found** in the
tenant-identification or auth path — the desktop install identifies itself
via the paired `site_sync_credentials` token, not a separate "instance ID"
concept; the instance ID that does exist is solely a same-machine
readiness signal between the Electron parent and its spawned Next.js
child, not a tenant identity, and does not need to be.
**Fix (confirmed bug, `bef43a9`):** the Owner-facing sync settings panel
claimed a new server version "downloads automatically the next time the
system starts." That is false — `src/lib/app-update.ts` and
`src/app/platform/updates/page.tsx` both explicitly state that automatic
download/install is intentionally disabled pending signing/rollback
infrastructure; the update-check call only ever compares version strings.
Corrected the copy to say plainly that this is a notification only, a
human must install the new version manually, and to back up first —
matching the platform-operator page's existing honest wording.

### Section 7 — Printer system redesign
**Finding (confirmed gap):** the desktop build depended on the same
browser print-connector (a separately-installed, always-running local
service) as the browser/cloud version, contrary to the requirement that
desktop print directly through the OS's own print spooler.
**Fix (`26fd707`):** `electron/native-printing.js` — Windows queues via
the same `winspool.drv` RAW technique the connector uses internally
(an embedded C# helper invoked through PowerShell, in-process, no
always-running loopback service), and network ESC/POS printers via a
plain Node TCP socket. Uses the *same* `PrinterTarget` shape and canonical
error codes as the existing connector model
(`src/lib/printing/types.ts`, `src/lib/printing/errors.ts`), so it is a
drop-in delivery backend rather than a competing model — default/receipt/
kitchen/label printer selection and test-print UI did not need to change.
Wired to four new IPC handlers in `electron/main.js`
(`desktop:print-list-windows-printers`, `-discover-network`, `-probe`,
`-send-raw`) and exposed via `electron/preload.js` as
`window.businessSuiteDesktop.printing`. Every side-effecting function
takes injectable `run`/`connect`/`listInterfaces` collaborators, which is
what made unit testing possible without real hardware.
**Explicitly NOT verified (do not treat as done):** this has never run
against a real Windows print spooler, a real receipt printer, or a real
kitchen/label printer. Logic-level correctness (argument construction,
error mapping, timeout handling) is unit-tested; the actual `winspool.drv`
RAW write path, PowerShell/C# interop on a real Windows machine, and
physical paper output are **not verified** and must be tested on real
Windows hardware before this ships. Per the standing instruction, no
attempt was made to fake that verification.
**Browser/cloud version:** intentionally left unchanged and still uses
the connector, as instructed.

### Section 8 — Installation improvements
**Finding (original pass):** `electron/package.json`'s electron-builder
config was reviewed for `deleteAppDataOnUninstall` (`false` — correctly
preserves local data across reinstall/uninstall), `oneClick`/`perMachine`
(both `false`, i.e. a real NSIS wizard rather than a silent one-click
installer). No separate Application/Data/Backup/Logs/Configuration folder
split existed: every install wrote `config.json`, the embedded Postgres
data directory, the local HTTPS gateway's certificates, log files, and
emergency pre-restore dumps all directly into one flat `userData` root,
with no subfolder separation anywhere. "Application" was already distinct
(the NSIS-installed program binaries under Program Files, never mixed with
runtime data), but Data/Backup/Logs/Configuration were not.
**Fix (this cycle):** `electron/app-paths.js` — a new module that is the
single source of truth for the four-way split (`computePaths()`) and a
one-time, idempotent migration (`migrateLegacyLayout()`) that moves an
existing install's flat files into it:
- `Configuration/config.json` — generated secrets, ports, instance identity
- `Data/pgdata` — the embedded PostgreSQL data directory
- `Data/gateway-certificates` — the local mobile-access CA/server certificates
- `Backup/emergency-backups` — automatic pre-restore safety dumps
- `Logs/desktop.log` (+ Postgres's own log)

`electron/backend-manager.js`, `electron/logger.js`, and
`electron/certificate-manager.js` now derive every one of those paths from
`computePaths()` instead of constructing a flat `userData`-relative path
inline (three call sites were updated). `electron/main.js` runs
`migrateLegacyLayout()` once per install, immediately after the Section 3
storage-location choice resolves the final `userData` root and before
anything else computes a path from it, so an EXISTING install upgrading to
this version has its files moved automatically on first launch after the
upgrade — nothing re-prompts, nothing is silently duplicated, and a failed
move (permissions, a locked file) is retried on the next launch rather
than losing data (the legacy source is only removed after a successful
copy). Completion is recorded in a `.folder-layout-v1` marker file at the
`userData` root, mirroring the marker-file pattern `local-storage.js`
already uses for the storage-root choice, so the migration runs at most
once. A related interaction bug was fixed at the same time:
`runStorageBootstrap()`'s "does this install already have data at the
default path?" check only ever looked at the pre-split flat `config.json`
location, which would have made an already-migrated install's SECOND
launch look like a fresh install and re-prompt for a storage location on
every subsequent launch; it now also checks the post-migration
`Configuration/config.json` path.
**Also found and fixed while implementing this (independent bug, not
previously identified):** `backend-manager.js`'s `start()` has always
called `desktopServerEnvironment(config, runtimeUrl, superuserUrl,
appVersion, { pgToolsDir, emergencyBackupDir })` with a 5th options
argument, but the function's own signature only accepted 4 parameters —
`pgToolsDir` and `emergencyBackupDir` were silently dropped and never
reached the spawned server process's environment. Since `NODE_ENV` is
forced to `"production"` in that same environment object,
`src/lib/pg-tools.ts`'s `pgToolBin()` *requires* `PG_TOOLS_DIR` in
production and throws `{pg_dump,pg_restore}_packaged_tools_not_configured`
without it — meaning every packaged desktop install's backup/restore path
(pg_dump/pg_restore) was broken, silently, with no code path ever setting
the one environment variable it depended on. Fixed by adding the `options`
parameter to `desktopServerEnvironment()` and wiring both values into the
returned environment (`PG_TOOLS_DIR`, `RESTORE_EMERGENCY_DIR`). See
`src/lib/backend-manager-environment.test.ts`.
**Tests:** `src/lib/app-paths.test.ts` (13 tests: fresh-install no-op,
full migration, marker prevents re-running, pre-existing-destination is
skipped not overwritten, a failed move does not write the marker, a
legacy `logs/` folder is not mistaken for an occupied destination, EXDEV
cross-device fallback, non-EXDEV errors re-throw, and a dedicated
Windows/NTFS case-insensitive-filesystem regression suite — see below)
and `src/lib/backend-manager-environment.test.ts` (4 tests, pinning the
`PG_TOOLS_DIR`/`RESTORE_EMERGENCY_DIR` fix).
**CI caught two real regressions in this feature that the sandbox (Linux,
no Electron) could not (this is exactly why `.github/workflows/test.yml`'s
`unit tests`/`packaged Windows end-to-end` jobs run on `windows-latest` —
"clean in the sandbox" was never treated as sufficient for Windows-only
code paths):**
1. **`electron/main.js` referenced `computePaths()` without importing it**
   — a plain missed destructured import (`const { migrateLegacyLayout } =
   require("./app-paths")` should have included `computePaths` too). This
   broke the packaged app outright — every launch crashed at startup with
   `ReferenceError: computePaths is not defined`, caught by the
   `packaged Windows end-to-end` CI job's real install-and-launch smoke
   test. Fixed by adding `computePaths` to the same destructure.
2. **The migration's "does the destination already exist?" conflict check
   broke specifically for `logs` → `Logs`** on NTFS. NTFS is
   case-insensitive but case-preserving: legacy `logs` and the new `Logs`
   are the *same physical directory entry* one level under the storage
   root, so `existsSync("…/Logs")` was `true` the instant `existsSync
   ("…/logs")` was — the generic pre-existing-destination guard
   misidentified this always-safe rename as an unrelated conflict and
   permanently skipped it, silently leaving every real Windows install's
   logs un-migrated. Caught by the `unit tests` CI job (Windows), not
   reproducible on this sandbox's Linux/case-sensitive filesystem. Fixed
   with a new `isCaseOnlyRename()` helper: the conflict check now
   special-cases a same-path-different-case pair, and `moveEntry()` routes
   a case-only rename through a distinct intermediate name (some
   platforms/tools no-op a direct `rename(src, dest)` when the two names
   differ only by case on a case-insensitive filesystem). Regression-tested
   with an in-memory fake filesystem that emulates NTFS's case-folding
   lookup (`makeCaseInsensitiveFakeFs()` in the test file), since this
   sandbox has no real Windows/NTFS volume to reproduce it on directly.
**Residual:** none — the folder split, the environment-variable bug it
surfaced, and the two Windows-only regressions CI caught are all fixed and
tested this cycle.

### Section 9 — Desktop Settings Center (Storage, Backup, Sync, Printer,
Devices, Updates, Logs, Account)
**Finding:** seven of the eight required areas already existed as
settings tabs. **Logs was missing** — there was no place in the Settings
Center to see or export application/error logs; the only way to find
Electron's process log was to know the file path.
**Fix (`c38c81c`):** `src/app/(app)/settings/logs-panel.tsx` — a new
"گزارش‌ها" (Logs) tab showing this browser's exportable client-error log
(via the new `error-report.ts`, §Section 12), plus, on desktop builds, a
button calling `window.businessSuiteDesktop.localGateway.openLogs()` to
reveal the Electron process log folder in the OS file browser. Wired into
`src/lib/settings-tabs.ts` and `src/app/(app)/settings/settings-manager.tsx`.
All eight required areas are now present in the Settings Center in one
place.

### Section 10 — Backup system
**Finding:** already comprehensive. `src/lib/backup.ts` implements a
configurable interval (`ALLOWED_INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12,
24]`, covering the brief's Daily/Weekly/Manual cadence via schedule
configuration plus an explicit manual-trigger path), independently
configurable local and cloud (S3-compatible) retention counts (validated
1–365, i.e. covering both the 7/30-day cases and effectively-unlimited via
a large count), local encryption, and a full restore flow
(`backup-manager.tsx`'s `RestoreCard`) that verifies a stored artifact
into a scratch database and only applies it to the live database on
explicit confirmation — a real restore *wizard*, not a one-click
overwrite. No changes made; this audit only confirmed completeness against
the brief's checklist.

### Section 11 — Update system
**Finding:** `src/lib/app-update.ts` deliberately implements
version-*visibility* only — a paired desktop install compares its running
version against the cloud's over the existing authenticated sync channel
and surfaces "update available" in the Owner's settings, but the module
explicitly never downloads, verifies, or installs anything; a code
comment states this is intentional pending signing and rollback
infrastructure. `src/app/platform/updates/page.tsx` (the platform-operator
view) already states this honestly. The only defect found was that the
*tenant-facing* copy (Owner's own settings panel) contradicted this by
implying an automatic install — fixed in Section 6/§`bef43a9` above.
**Not built this engagement (documented gap, by design):** the full
"Create Backup → Install Update → Verify Database → Start Application"
automated sequence the brief describes does not exist and was not built.
Building a safe, reversible auto-updater requires code-signing
infrastructure and a rollback story that are out of scope for a UI/logic
audit and were correctly flagged as pre-existing infrastructure work
rather than something to bolt on unsafely. The manual path today —
Owner sees "update available," downloads a new signed installer from the
platform team, installer runs with `deleteAppDataOnUninstall: false` so
existing data survives, owner verifies the app is healthy afterward — is
functionally what the brief's four steps describe, just performed by a
human rather than automated code. Recommendation for a follow-up
engagement: once signing exists, wrap the existing `backup.ts` trigger
and `bin/migrate.cjs` (already used for fresh-install migration) into an
`electron-updater` `before-quit-for-update` hook that runs both before
swapping binaries.

### Section 12 — Professional error handling
**Finding (confirmed gap):** render-time errors (`src/app/error.tsx`,
`src/app/global-error.tsx`) showed only a friendly Persian message with no
error ID, no way to see technical detail, and no way to export logs for
support. Next.js's own `error.digest` is not always present for
client-only errors and is not designed to be user-support-quotable.
**Fix (`c38c81c`):** `src/lib/error-report.ts` — `generateErrorId` (a
short `ERR-XXXX-XXXX` Crockford-base32 id, distinct from `digest`),
`redactSecrets` (the same secret-redaction rule `electron/logger.js`
already used, so an exported log can never leak a connection
string/token/password), `buildTechnicalReport`, and a capped (50-entry)
`localStorage` ring buffer (`recordClientError`/`exportClientErrorLog`) so
"export logs" hands support more than just the one error on screen. Both
`error.tsx` and `global-error.tsx` now show the short ID, an expandable
technical-details block, and a "دریافت فایل گزارش‌ها" export button.
16 unit tests.
**Follow-up (closed in a later pass of this same engagement):** the
original review of this section flagged that API/fetch-layer errors
surfaced via `src/app/dashboard/ui.tsx`'s `ErrorBox`/`errorMessage()`
pattern carried no error ID or log attachment — only the two render-error
boundaries got the full treatment initially. Retrofitting an error ID onto
each of the ~200 individual call sites that render `errorMessage()` would
have been a large, risky change touching page-level JSX across the app for
little practical benefit (most of those are ordinary validation messages a
user can act on, e.g. "fill in the required field" — not failures support
needs a log for). Instead, the fix targets the few shared fetch wrappers
every one of those call sites already goes through —
`src/app/dashboard/ui.tsx`'s and `src/app/setup/ui.tsx`'s `api()`, and the
platform console's `src/lib/platform-client.ts`'s `platformFetch()` — so a
genuinely unexpected failure (a transport failure with no HTTP response at
all, or a request that reached the server and the server itself failed
with a 5xx) is silently appended to the same exportable error-report ring
buffer a render error uses (`error-report.ts`'s new `recordApiFailure`/
`isNotableApiFailure`), with **zero UI/behavior change** — the on-screen
message a user sees is exactly what it already was. An ordinary 4xx
validation rejection is deliberately never logged, so the export stays
useful signal rather than noise. Unit-tested: 6 new assertions in
`error-report.test.ts` for the pure logging/filtering logic, plus
integration-style tests against each of the three wrappers
(`platform-client.test.ts`, `src/app/dashboard/api-error-logging.test.ts`,
`src/app/setup/api-error-logging.test.ts`) confirming a 5xx/transport
failure is captured and a 4xx/2xx/abort is not.

### Section 13 — Code audit (duplicated/unused/broken/incomplete/security)
Findings folded into the sections above rather than kept separate, since
each one *is* a code-audit finding:
- **Dead code removed:** `src/app/dashboard/logout-button.tsx` was an
  unused component (superseded by the platform user menu's logout action)
  — deleted in `687794b`.
- **No `TODO`/`FIXME`/`XXX` markers** were found anywhere in `src/` or
  `electron/` outside of code-formatting example strings (e.g. pairing
  code placeholders) and one already-resolved comment in
  `src/lib/sms-kavenegar.ts` documenting a past deliberate build-time
  decision — i.e. no abandoned half-finished work was hiding behind a
  marker comment.
- **No duplicated logic** was found between the browser print-connector
  model and the new native-printing module — Section 7's fix deliberately
  reuses the connector's `PrinterTarget`/error-code types rather than
  inventing a parallel shape, which is itself a duplication-avoidance
  decision made during this audit.
- **Security:** `server-sync.ts`'s credential resolution already used
  constant-time comparison and per-business token hashing before this
  audit; `error-report.ts`'s new export path was built with secret
  redaction from day one rather than retrofitted after a leak; the
  pairing routes (`/api/setup/pair`, `/api/setup/pair/test`) were
  reviewed for the obvious pre-bootstrap-endpoint risk (an
  unauthenticated route that can write to the database) and found to
  correctly gate on `hasAnyUser()` both before and after the slow network
  round trip.
- **Broken/incomplete flows fixed this engagement:** the missing login
  door chooser (Section 4), the two-state (not five-state) sync queue
  (Section 5), the connector-dependent desktop printing path (Section 7),
  the silently-defaulted storage location (Section 3), the log-less error
  screens (Section 12), and the misleading auto-update copy (Section 6/11)
  — all listed above with their fixes.

### Section 14 — Deliverables
This document, plus `docs/runbooks/TESTING_CHECKLIST.md` in the repo root.

## 3. Files changed, by commit

| Commit | Section(s) | Files |
|---|---|---|
| `687794b` | 1, 4, 13 | `src/lib/login-door.ts` (new), `src/components/auth/login-door-chooser.tsx` (new), `src/app/login/login-form.tsx`, `src/app/admin/admin-login-form.tsx`, `src/lib/platform-user-menu.ts`/`.tsx`, gradient removal in setup/login styling, deletion of `src/app/dashboard/logout-button.tsx` |
| `26fd707` | 7 | `electron/native-printing.js` (new), `electron/main.js`, `electron/preload.js` |
| `5d1fb7a` | 3 | `electron/local-storage.js` (new), first-run storage-bootstrap wiring in `electron/main.js`/`electron/backend-manager.js` |
| `f0973d9` | 5 | `src/lib/sync-queue.ts` (new), `src/lib/sync-queue.test.ts` (new), `src/lib/offline-db.ts` (Dexie v2 schema + upgrade) |
| `c38c81c` | 9, 12 | `src/lib/error-report.ts` (new), `src/lib/error-report.test.ts` (new), `src/app/error.tsx`, `src/app/global-error.tsx`, `src/app/(app)/settings/logs-panel.tsx` (new), `src/lib/settings-tabs.ts`, `src/lib/settings-tabs.test.ts`, `src/lib/settings-routes.ts`, `src/app/(app)/settings/settings-manager.tsx` |
| `bef43a9` | 6, 11 | `src/app/(app)/settings/connections/server-sync-panel.tsx` (copy fix) |
| `4d9a971` | 14 | `docs/audits/AUDIT_REPORT.md` (new), `docs/runbooks/TESTING_CHECKLIST.md` (new) |
| `0e95e45` | 12 (follow-up) | `src/lib/error-report.ts`, `src/lib/error-report.test.ts`, `src/app/dashboard/ui.tsx`, `src/app/setup/ui.tsx`, `src/lib/platform-client.ts`, `src/lib/platform-client.test.ts`, `src/app/dashboard/api-error-logging.test.ts` (new), `src/app/setup/api-error-logging.test.ts` (new), `src/app/(app)/settings/logs-panel.tsx`, `electron/local-storage.js` (doc fix) |
| `742f28b` | 14 (doc-only) | `docs/audits/AUDIT_REPORT.md` — commit-chain table updated to include `4d9a971`/`0e95e45` |
| `df6ecb6` | 5 (follow-up) | `src/lib/sync-event-registry.ts` (new `offlineQueueEligible` flag + `isOfflineQueueEligible()`), `src/lib/sync-event-registry.test.ts`, `src/app/api/sync/events/route.ts` (gate on `isOfflineQueueEligible` instead of `?.legacy`), `src/app/api/sync/events/route.test.ts` (new), `src/lib/offline-db.ts` (new `inventory.waste.recorded` `PendingActionType`), `src/lib/sync-queue.ts`/`.test.ts` (new `resolveQueueRecordRef` case), `src/app/dashboard/inventory/waste-section.tsx` (submit now uses `apiOrQueue`, queued-offline notice), `src/app/(app)/settings/sync-queue-panel.tsx` (Persian label for the new action type), `docs/audits/AUDIT_REPORT.md`/`docs/runbooks/TESTING_CHECKLIST.md` (Section 5 residual note rewritten to describe the extension) |
| `17439d3` | 8 | `electron/app-paths.js` (new — Configuration/Data/Backup/Logs split + upgrade migration), `electron/backend-manager.js` (derive paths from `computePaths()`; independent `PG_TOOLS_DIR`/`RESTORE_EMERGENCY_DIR` env-passthrough bug fix), `electron/certificate-manager.js`, `electron/logger.js` (same), `electron/main.js` (runs the migration once; fixes the `hasExistingConfigAtDefault` interaction bug; fixes a stray flat-path smoke-test reference), `electron/package.json` (packaging list), `src/lib/app-paths.test.ts` (new, 10 tests), `src/lib/backend-manager-environment.test.ts` (new, 4 tests), `docs/deployment/standalone-desktop-app.md`, `docs/audits/AUDIT_REPORT.md`/`docs/runbooks/TESTING_CHECKLIST.md` |
| `372c629` | 8 (CI fixes) | `electron/main.js` (missed `computePaths` import — crashed every packaged launch), `electron/app-paths.js` (new `isCaseOnlyRename()`; the `logs` → `Logs` conflict check and `moveEntry()` both fixed for NTFS case-insensitivity), `src/lib/app-paths.test.ts` (new Windows/NTFS regression suite using an in-memory case-insensitive fake filesystem, 13 tests total), `docs/audits/AUDIT_REPORT.md`/`docs/runbooks/TESTING_CHECKLIST.md` (documents both regressions and why CI, not the sandbox, caught them) |

## 4. Architecture changes

- **Sync queue** gained a real state machine (`pending → syncing →
  completed | failed | conflict`, with retry-count-gated exponential
  backoff) in place of an implicit present/absent model. This is a schema
  change (Dexie v2) with a backward-compatible upgrade path, not a
  breaking one.
- **Desktop printing** gained a second delivery backend
  (`electron/native-printing.js`) alongside the existing browser
  connector, sharing the same target/error type contracts
  (`src/lib/printing/types.ts`, `errors.ts`) so the rest of the printing
  UI is backend-agnostic. The browser/cloud version's dependency on the
  connector is unchanged.
- **First-run storage bootstrap** is now a decision function
  (`decideStorageBootstrap`) with a persisted marker, rather than an
  unconditional default — new installs get asked once; existing installs
  are never silently relocated.
- **Client error reporting** gained a small local-only telemetry surface
  (a capped `localStorage` ring buffer with secret redaction) that exists
  purely for the user to self-export logs to support; nothing is sent
  anywhere automatically, preserving the app's existing "your data stays
  local unless you configure cloud sync" posture.
- **Login door concept**: a new, deliberately non-authoritative
  client-side "which door" memory (`login-door.ts`) sits alongside the
  already-authoritative server-side role checks — it changes discovery,
  not authorization.

## 5. What was intentionally NOT changed (and why)

- Automatic update installation (Section 11) — needs signing/rollback
  infrastructure that doesn't exist yet; building an unsafe auto-updater
  would violate "must never break local data" more than leaving it
  manual does.
- The browser/cloud print-connector path (Section 7) — the brief
  explicitly says it may keep using the connector.
- A full four-way (Application/Data/Backup/Logs/Configuration) installer
  folder split (Section 8) — Electron's OS-standard `userData` layout
  plus Section 3's new storage-location wizard cover the practical need;
  restructuring the installer's own directory layout was judged lower
  priority than the auth/sync/printing fixes given the remaining time
  budget.
- Individually retrofitting an error ID onto each of the ~200 JSX call
  sites that render `<ErrorBox>{errorMessage(...)}</ErrorBox>` — instead,
  the three shared fetch wrappers underneath all of them now log 5xx/
  transport failures into the same exportable ring buffer a render error
  uses (see the updated Section 12 entry above); a per-call-site on-screen
  error ID for every one of the ~200 sites was judged unnecessary once the
  underlying failure is already captured for support, and would have been
  a much larger, higher-risk change for comparatively little benefit.

## 6. Verification performed

- `npx tsc --noEmit` — clean, throughout and at final HEAD.
- `npx eslint .` — clean, throughout and at final HEAD.
- `npx vitest run` — **385 test files / 5499 tests, all passing** at final
  HEAD. This includes 17 tests for the sync queue state machine, 16 for the
  error-report helpers, this cycle's 10 new tests for the offline-queue
  domain extension (registry eligibility, the new `resolveQueueRecordRef`
  case, and `/api/sync/events` route gating), and this cycle's 14 new tests
  for the Section 8 folder split (`app-paths.test.ts`, 10 tests) and its
  companion environment-variable bug fix
  (`backend-manager-environment.test.ts`, 4 tests), plus all pre-existing
  suites updated to expect audit-introduced changes (e.g.
  `settings-tabs.test.ts` now expects the new `"logs"` tab).
- **Not verified** (no environment available in this sandbox): a live
  Postgres-backed integration run, a live Electron process, real Windows
  print-spooler/hardware output, and a real signed-installer upgrade run.
  See `docs/runbooks/TESTING_CHECKLIST.md` for what a human tester should exercise
  before shipping.
