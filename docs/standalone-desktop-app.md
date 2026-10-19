# Windows standalone Business Suite

The supported on-site deployment is a Windows 11 Electron installer for the
complete Business Suite: Accounting, CRM, Growth/Marketing, Website Management,
POS and supporting capabilities. It requires no preinstalled Docker, Node.js or
PostgreSQL.

## Packaged architecture

```text
Business Suite.exe
├── Electron shell
│   ├── single-instance/startup orchestration
│   ├── persistent secrets and instance identity
│   ├── local certificate authority and HTTPS/WSS gateway
│   ├── optional scoped Windows Firewall integration
│   └── graceful application/database shutdown
├── desktop-runtime/                 positive production staging
│   ├── bin/server.cjs               bundled custom Next/WS server
│   ├── bin/migrate.cjs
│   ├── bin/derive-runtime-database-url.cjs
│   ├── .next/                       production output; no build cache
│   ├── node_modules/                traced runtime dependencies only
│   ├── migrations/
│   └── public/
└── one Windows embedded PostgreSQL 16 payload (outside ASAR)
```

The staged runtime is produced by `scripts/build-desktop-runtime.mjs`. It starts
from the Next standalone trace and copies an allowlisted set of executables,
migrations and public assets. It rejects top-level TypeScript, test/build
tooling, caches, development packages and unexpected source files instead of
trying to prune a copied development checkout with broad exclusion globs.

## Network boundaries

- Next.js binds to `127.0.0.1` by default.
- The Electron `BrowserWindow` always uses that loopback origin.
- Embedded PostgreSQL listens on loopback only.
- Printing does **not** go through the browser/cloud product's loopback print
  connector (`127.0.0.1:9123`) here: the desktop app reaches Windows printers
  and network ESC/POS printers directly from the Electron main process
  (`electron/native-printing.js`), so a desktop install never needs to
  install that separate helper. See [printing.md](printing.md) for the full
  two-backend split.
- Phones/tablets use the dedicated HTTPS gateway. It terminates TLS and proxies
  both HTTP and WebSocket traffic to the internal server.
- The gateway exposes neither PostgreSQL nor the desktop's native printing IPC.

The Owner's **Settings → Connections → Local Devices** panel selects a valid
Private LAN adapter, enables/disables the gateway, displays the HTTPS address
and QR code, and provides the local root certificate for device onboarding.
Optional firewall creation is limited to the selected gateway TCP port and the
Private profile; it is the only action allowed to request elevation.

Normal production authentication still uses Secure cookies. The proxy forwards
the original host/protocol information needed by the server's existing host,
origin, CSRF and WebSocket checks. The gateway does not enable
`ALLOW_INSECURE_LAN` or bypass tenant/RLS controls.

## Persistent state

Installation resources are immutable. The following remain beneath the
app's data directory so they survive app updates and reinstall/uninstall by
default:

- PostgreSQL data directory
- generated database password (the restricted runtime-role URL is derived at boot)
- JWT and application master keys
- desktop instance identity
- local CA/server certificates
- gateway configuration
- application/Electron logs

By default that data directory is Electron's standard OS-appropriate
`userData` path. Since Section 3 of the desktop audit, a genuinely first
launch (no `config.json` at the default path, no previously recorded choice)
asks once whether to keep that default or use a different drive/folder — a
bigger disk, an external drive — via `electron/local-storage.js`'s
`evaluateFolder` (a real free-space check plus a write/read/delete round
trip on the candidate folder, not just a typed path) and `main.js`'s
`runStorageBootstrap`/`promptForStorageLocation`. The answer is written once
to a small marker file at the *default* `userData` path (so it is always
findable regardless of what was chosen) and reused silently on every later
launch — the prompt never repeats. An automated/CI boot
(`DESKTOP_SMOKE_MARKER` set) always takes the default path, unattended, so
this never blocks a scripted run. Relocating an *already-initialised*
`pgdata` directory later is out of scope for this feature and belongs with
the Section 10 backup/restore wizard instead.

Within whichever root that resolves to, Section 8 of the desktop audit
splits it into four subfolders rather than leaving everything flat —
`electron/app-paths.js`'s `computePaths()` is the single source of truth:

- `Configuration/config.json` — generated secrets, ports, instance identity
- `Data/pgdata` — the embedded PostgreSQL data directory
- `Data/gateway-certificates` — the local mobile-access CA/server certificates
- `Backup/emergency-backups` — automatic pre-restore safety dumps
- `Logs/desktop.log` (+ Postgres's own log) — everything `electron/logger.js` writes

An install that predates this split has all of the above sitting directly
in the `userData` root instead. `main.js` runs `app-paths.js`'s
`migrateLegacyLayout()` exactly once per install, immediately after the
storage-location choice above resolves and before the logger, backend
manager or certificate manager compute a single path from the result — it
moves each legacy entry that exists into its new home and records
completion in a `.folder-layout-v1` marker file at the root, so it never
re-runs and a fresh install (nothing to move) is a no-op. A move failure
(locked file, permissions) is not recorded as migrated, so it is retried on
the next launch, and a partially-migrated entry never causes data loss —
the source is only removed after a successful copy.

The in-app **Setup wizard → Backup destination** step and the packaged app's
own first-run prompt both call through to the same `evaluateFolder` check —
disk-space and a real write/read/delete round trip — via
`window.businessSuiteDesktop.storage` (see `src/lib/desktop-bridge.ts`), so a
folder is never accepted purely because its path string looked valid.

The NSIS package is per-user by default. Ordinary install and startup therefore
do not need administrator rights. The uninstaller deliberately does not delete
application data.

## Startup and shutdown

`electron/main.js` coordinates focused modules rather than implementing every
service directly:

1. Acquire the single-instance lock.
2. On a genuinely first launch, ask once where local data should live
   (default `userData` path or an owner-chosen folder) and record the
   answer — see "Persistent state" above.
3. Migrate an existing install's flat layout into
   Configuration/Data/Backup/Logs, once, idempotently — see "Persistent
   state" above.
4. Load or create protected persistent configuration.
5. Start embedded PostgreSQL and wait for readiness.
6. Apply forward-only migrations.
7. Derive the restricted `pos_app` runtime database URL.
8. choose a free loopback application port and start the staged server.
9. Verify identity-aware `/api/health` before opening the window.
9. Restore the configured HTTPS gateway where possible.

If another process owns a required resource, startup fails with a diagnostic
rather than attaching to an unrelated service. Shutdown stops the gateway,
drains the Node server and then stops PostgreSQL; logs remain available for
support.

## Pairing and offline operation

First launch either bootstraps a new local owner or redeems a short-lived code
issued for an explicitly selected cloud location. Every redemption creates a
separate site-device identity and credential. Pairing snapshot v3 seeds the
currently classified bootstrap data; supported ongoing sync events remain a
smaller explicit catalog documented in [server-sync.md](server-sync.md).

Loss of Internet does not make the local server unavailable. Browser mutations
that encounter transient local-server failures can queue in IndexedDB for
supported routes, while cloud synchronization retries separately. The UI
reports local-server, Internet and cloud/service states independently rather
than treating `navigator.onLine` as proof that the local service is reachable.

## Build and verification

The `shadcn` component-generation CLI is a **development dependency**. Its
`shadcn/tailwind.css` import is compiled into the application styles at build
time; neither the production server nor the installed desktop runs the CLI.
Keep its code-generation/glob dependency graph marked development-only in the
lockfile. Both desktop CI workflows retain the unchanged
`npm audit --omit=dev --audit-level=high` production vulnerability gate.

PR/branch installer builds use unique `X.Y.Z-ci.<run>` preview versions and do
not publish release tags. They may still build when `desktop-vX.Y.Z` was
released after their branch was created. Stable tag-collision checks apply to
main/manual release builds, where rebuilding a shipped version remains blocked.

From the repository root:

```bash
npm ci
npm run build
npm run desktop:runtime
cd electron
npm ci
npm run verify:runtime
npm run dist
```

The Windows workflow additionally:

- verifies exactly one Windows embedded-PostgreSQL payload and no Linux/macOS
  payloads;
- rejects root development-tree leakage;
- checks staged, unpacked and installer size budgets;
- parses the shipped PowerShell print connector;
- silently installs the actual NSIS installer under a newly-created standard
  (non-administrator) Windows user;
- launches the installed executable twice against the same `userData`;
- requires UTF-8 database initialization, all migrations, restricted-role/RLS
  startup, first-run bootstrap/authentication, persistence and clean shutdown.

### Measured acceptance (2026-09-20)

[Windows package run 35508534104](https://github.com/hamidnoshady/cafe-restaurant-pos/actions/runs/35508534104)
passed end to end:

| Measurement | Result | Regression gate |
|---|---:|---:|
| NSIS installer | 131.4 MiB | 350 MiB |
| Unpacked installed payload | 504.9 MiB | 600 MiB |
| Positively staged runtime (local Linux build) | 153.9 MiB | 200 MiB |

**Current configured budgets (2026-10-13; maintainer acceptance of the 640/220
MiB values is still open).** The installer gate is 175 MiB. The workflow
currently checks an unpacked-payload limit of **640 MiB** and a pre-package
staged-runtime limit of **220 MiB**. Both numbers were reached independently,
more than once, by parallel branches that have now merged, and are recorded
here exactly rather than smoothed into a single tidy story:

- The AEC document-control wave took the traced runtime from 599.8 to 600.6
  MiB against the former 600 MiB gate, which moved it to 620 MiB (0.2 → 20 MiB
  headroom).
- Issue #884's device-registry slice (five API routes, a service module, a
  migration, the native-bridge device-identity command) took the unpacked
  payload from 618.6 to 621.4 MiB, crossing 620 MiB; that branch's owner
  explicitly signed off on moving the detector to 640/220 MiB for this reason.
- Separately, issue #834's Windows package measured 620.2 MiB
  ([run 38165434904](https://github.com/hamidnoshady/biza-miz/actions/runs/38165434904)),
  and the merged multicurrency/auth-hardening build on `main` measured 620.4
  MiB on 2026-10-11 — both also past the old 620 MiB gate, and that branch's
  own commit raised the configured value to 640 MiB too, but documented that
  **maintainer acceptance of that specific increase was still undecided** at
  the time, not a claim that either of those two results meets the former
  620 MiB policy.

So the number in the workflow files is 640/220 MiB, arrived at twice
independently, but it carries one open owner decision (from the issue #834 /
main-growth side) that has not been explicitly confirmed, alongside one that
has (the issue #884 side). Because this merge now ships every contributing
change together, the actual combined payload has not yet been re-measured;
the next `packaged Windows end-to-end` CI run is the source of truth for
whether 640/220 MiB still holds, and the budget is not to be raised again
without a fresh measurement and an explicit sign-off covering the still-open
question. The detector's job is to catch a payload that accidentally ships
`node_modules`, a build cache or source maps rather than to freeze the app's
growth. The component report shows the dominant term: roughly 103 MiB of
*unminified* `.next/server` chunks — minifying the compile pass is the real
size work available here and is tracked separately.

**Current configured budgets, superseding the above (2026-10-19).** The
workflow files' actual values moved past the 640/220 MiB this section
describes twice since: PR #993 (2026-10-17) raised them to 644/224 MiB after
issue #984's support-companion server slice measured 642.120 MiB unpacked /
221.656 MiB staged on its branch (see the workflow files' own comments for
that byte-accurate evidence). Issue #909's shared navigation-acknowledgment
work (PR #1020) then measured 675,834,891 bytes (644.526 MiB unpacked) and
234,929,705 bytes (224.046 MiB staged) on its branch — both just past the
644/224 MiB gates, from one new client component (the platform-wide
navigation-pending indicator) replicated as a small reference across roughly
1,232 per-route client-reference manifests, not a leaked dependency. That PR
moved the gates to **646 MiB unpacked / 226 MiB staged**, the numbers now in
`build-desktop-installer.yml` and `verify-shippables.yml`; the installer gate
is unchanged at 175 MiB. As with every prior move, the next packaged run is
the source of truth, and the still-open #834/main-growth sign-off question
from the 2026-10-13 history below is unaffected by this one.

*(2026-10-03 history.)* The installer gate was 175 MiB and the unpacked
payload's runaway detector was 620 MiB, raised from 600 MiB when the AEC
document-control wave took the traced runtime to 600.6 MiB against 0.2 MiB of
headroom.

The uploaded installer artifact is 136,405,815 bytes as a GitHub artifact and
has digest
`sha256:b6aa7459191c4f59b47532594e94a5da61f19a0eaf6dc1afcd7019f52c2ceb93`.
The run also proved that exactly one executable Windows PostgreSQL payload was
present, no foreign-OS payload was packaged, and the installed app retained its
instance and database across the second launch.

GitHub's `windows-latest` hosted image is a clean Windows Server runner, not a
retail Windows 11 VM. The standard-user NSIS/runtime path is accepted there,
but a final signed-build check on a clean Windows 11 machine with the target
network adapters, firewall/UAC policy, printers, and phone certificate
onboarding remains a release acceptance step.

`npm run desktop:size` (or the Electron `size` script after packaging) writes a
Markdown report with component and largest-path measurements.

## Backups, printing, and updates

The existing backup UI and print connector remain product capabilities.
However, a packaged release must include PostgreSQL 16-compatible `pg_dump` and
`pg_restore` plus their required DLLs before packaged physical backup/restore
can be claimed. Do not substitute old PostgreSQL 13/14 clients or download an
unverified archive during CI.

Desktop updates are manual in this release. Removed Docker-era update paths
must not be restored, and no downloaded executable/image may run without a
signed, integrity-verified update design with backup and rollback.

## Uninstall and recovery

Use Windows **Installed apps** to uninstall. App data remains by default. To
perform an intentional destructive reset, first create and verify a compatible
backup, uninstall, and remove the Business Suite `userData` directory manually.
Never delete the data directory as part of a routine upgrade or reinstall.

After such a reset there are two ways back, both on the first-run screen:

- **«اتصال کسب‌وکار موجود»** — pair with a fresh code from the cloud panel. The
  new install is seeded from the cloud; anything the old install never managed
  to push is not in the cloud and is not brought back.
- **«بازگردانی از فایل پشتیبان»** — upload the `.dump`/`.dump.enc` taken before
  the reset (see [backup-restore.md](backup-restore.md) §A2). Then restart,
  sign in with the old account, and use «ترمیم / اتصال دوباره» on the desktop
  panel so the restored install pushes its pending events to the cloud.
