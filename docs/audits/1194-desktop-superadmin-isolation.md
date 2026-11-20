# Desktop Superadmin isolation and test-bootstrap removal (#1194)

Status: implemented in source and wired into the Windows release workflows.
Scope: the **production Windows installer** for both deployment modes — Hybrid
(site connected to Central) and Full Offline.

This record answers the review in [#1194](https://github.com/hamidnoshady/biza-miz/issues/1194)
finding by finding. It is a source-and-pipeline assessment, not a claim that a
cloud Superadmin compromise was reproduced; no such compromise is possible
from the surfaces below.

## 1. Test bootstrap removed from the distributable

| Before | After |
| --- | --- |
| `electron/smoke-probe.js` packaged, containing `mayBootstrap()`, `runSmokeProbe()` and `startMockCloudActivation()`, plus the hardcoded password `Packaged-Test-Password-2026` | Module deleted. Nothing in `electron/package.json`'s `build.files` contains it. |
| `electron/main.js` read `DESKTOP_SMOKE_MARKER`, ran the probe, wrote a marker and exited | No `DESKTOP_SMOKE_*` read exists in `main.js`; `bootWithRecovery()` always goes to the window. |
| `electron/backend-manager.js` forwarded `DESKTOP_SMOKE_MARKER` to the server child together with `LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK=1` | Both removed. The server child's environment has no test switch. |
| `validateCloudOriginForLocalActivation()` allowed plain-HTTP loopback when `DESKTOP_SMOKE_MARKER` was set | The smoke branch is gone. Loopback HTTP is allowed only from a source test process (`NODE_ENV=test|development` **and** `LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK=1`); the packaged runtime is `NODE_ENV=production` and cannot opt in. |
| `electron/scripts/smoke-packaged.js` relied on an in-process probe | Rewritten as an external harness that speaks the product's public HTTP API. It is not in `build.files` and not referenced by any shipped file. |

Acceptance criterion 1 (**no executable test-only account bootstrap path**)
is enforced by three independent checks:

- `src/lib/desktop-shell-hardening.test.ts` — the shipped shell sources
  contain no probe, marker switch or hardcoded credential;
- `src/lib/desktop-release-hardening.test.ts` — every `build.files` entry is
  scanned with the same rules as the release gate;
- `scripts/scan-desktop-release.mjs` — the packaged payload and the signed
  installer are scanned in CI (`build-desktop-installer`,
  `windows-signed-candidate`, `windows-11-release`).

The shell also deletes a customer-inherited
`LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK` from the spawned server child
(`electron/backend-manager.js`), so the remaining test-loopback condition cannot
be reached by a variable the customer sets even if a future change accidentally
weakened `NODE_ENV`.

### Preserved fresh-install testing (external, CI-only)

`electron/scripts/smoke-packaged.js` (`npm run desktop:acceptance`) launches
the installed `Bizamiz.exe` with only ordinary user-facing switches
(`--user-data-dir`), then:

1. scans the installed `resources/` tree for the removed markers and for
   Central route modules;
2. launches once with `DESKTOP_SMOKE_MARKER`, `DESKTOP_SMOKE_BOOTSTRAP=1`,
   `DESKTOP_SMOKE_PACKAGED_PROBE=1` and
   `LOCAL_ACTIVATION_ALLOW_TEST_HTTP_LOOPBACK=1` set, and proves they are
   inert: no marker file, `setup/state` still `needsBootstrap`, the removed
   smoke owner's known password rejected;
3. bootstraps the Owner through `POST /api/setup/bootstrap` in the ordinary
   `connected` product mode (so no mock Cloud service is needed — the thing
   #1194 asked to delete), then verifies `/api/auth/me` and `setup/state`;
4. probes `/platform`, `/platform/login`, `/api/platform/auth/login`,
   `/api/platform/auth/me`, `/api/platform/mcp` with a valid tenant cookie
   replayed as the platform cookie and with a forged platform cookie — each
   must answer 404;
5. closes the window (`CloseMainWindow()`), asserting exit 0 and no lingering
   `postmaster.pid` in an interactive session (`MainWindowHandle != 0`), or —
   when launched inside a non-interactive runner session with no window
   (`Start-Process -Credential`, `MainWindowHandle == 0`) — force-stopping the
   tree and recording `forcedStopUsed: true` / `cleanShutdownAsserted: false`
   in `acceptance-report.json` rather than claiming a clean quit it could not
   deliver;
6. relaunches, asserts the instance identity persisted, that a second
   bootstrap answers `409 already_initialized`, and that the real Owner
   credentials still sign in — completing the second factor enrolled at
   bootstrap (TOTP or single-use recovery code disclosed once by
   `/api/setup/bootstrap`) — while a wrong password is rejected;
7. when `DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL` is configured (protected
   repository variable) and `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN` is available (a
   single-use code minted for that run, since a stored one is redeemable
   only once), repeats a first run on a fresh profile in **Full
   Offline** mode: token preflight, real Cloud enrollment, activation record,
   owner session and a refused second bootstrap. Without that configuration
   the phase reports `skipped` — the harness never substitutes a mock service
   for Cloud, because the mock is exactly what #1194 removed.

The first launch is unattended because the harness pre-writes the ordinary
`storage-location.json` marker — a documented product file, not a test hook.
The profile directory comes from `DESKTOP_ACCEPTANCE_USER_DATA` (or a fresh
temporary directory per run), and the report path from
`DESKTOP_ACCEPTANCE_REPORT`.

## 2. Central Superadmin code and routing isolation

- **Packaging.** `scripts/build-desktop-runtime.mjs` now calls
  `scripts/desktop/central-route-exclusions.cjs`, which deletes
  `.next/server/app/platform`, `.next/server/app/api/platform` and their
  client chunks from the staged runtime, prunes their entries from
  `app-paths-manifest.json` / `app-build-manifest.json`, and then
  **fails the build** if any platform path survives (`assertNoCentralRoutes`).
  What was excluded is recorded in `.desktop-runtime/runtime-build.json`
  (`centralExclusions`) and reported by `npm run desktop:size`.
- **Traced source.** Next's node-file-trace can copy the original TypeScript
  of a dynamically imported module into `standalone/src/` even though the
  compiled server chunk is what executes. The 1.0.202 installer shipped
  `resources/desktop-runtime/src/lib/billing/entitlement/outbox-service.ts`,
  a Central billing-entitlement client, inside a site payload.
  `scripts/desktop/traced-source-exclusions.cjs` now removes our traced
  `.ts`/`.tsx` copies (font assets stay) and fails the build if any raw
  TypeScript survives outside `node_modules`; the release scan reports the
  same shape as `raw-source-file`.
- **Request time.** `src/middleware.ts` keeps answering 404 for the realm
  before the rate limiter; `isPlatformRealmPath` is now segment-aware
  (`/api/platformx` is no longer mistaken for the realm).
- **Authorization.** New `src/lib/platform-runtime-guard.ts` adds a third
  layer: `withPlatformScope()` and `requirePlatformAdmin()` answer
  `404 {error:"deployment_unsupported"}` whenever `DEPLOYMENT_ROLE` resolves
  to `site`, before any cookie, token or database read. Every
  unauthenticated platform entrance (login, MFA challenge/enrol/verify, MCP
  JSON-RPC, the four MCP OAuth endpoints, pairing redemption) calls the guard
  directly. A locally inserted `platform_admins` row or a locally minted
  platform cookie therefore cannot exercise a handler on a site process.
- **Cross-install sessions.** Platform and tenant sessions are signed with
  realm-derived secrets from the per-install `JWT_SECRET`. A desktop mints its
  own; Central mints its own. `src/lib/platform-realm-isolation.test.ts`
  proves both directions fail verification against the other installation's
  secret, and that a tenant token carrying forged `realm: "platform"` /
  `padmin` claims is still rejected by the platform verifier.

## 3. Secrets and artifact contents

The release gate (`scripts/scan-desktop-release.mjs`) fails on:

- any `DESKTOP_SMOKE_*`, `smoke-probe`, `runSmokeProbe`,
  `startMockCloudActivation` or `Packaged-Test-Password` literal;
- `PLATFORM_ADMIN_PASSWORD` / `seed-platform-admin` (Central credential
  seeding), `seed|reset-platform-mfa` files;
- a complete PEM private-key block (the public
  `desktop-release-public-key.pem` is the only key-shaped file allowed);
- `*.pfx`, `*.p12`, `*.p8`, `id_rsa`-style names, `.env` files, test suites,
  coverage, `.git`;
- any raw `.ts`/`.tsx` outside `node_modules` (`raw-source-file`) — the
  packaged runtime executes compiled chunks only;
- any `app/platform` or `app/api/platform` path in the payload, and (for an
  unpacked build) the required runtime shape.

`app.asar` is read through its real header, so entry names and contents are
both inspected instead of relying on a byte grep. When `--installer` is
passed, the gate extracts the **signed NSIS installer** with 7-Zip (including
the nested `app-64.7z`), scans the tree it would install, and records the
installer's SHA-256. The CI jobs pass `--require-installer-extraction`, so a
runner without 7-Zip fails instead of silently skipping the signed artifact.
An `app.asar` whose header cannot be read is reported as `asar-unreadable` and
fails the gate: "the archive could not be inspected" is never a pass.

The gate runs against bytes produced by the release build, in three places:
`build-desktop-installer.yml` (unsigned payload), `windows-signed-candidate.yml`
(signed payload plus installer) and `windows-11-release.yml` /
`windows-production-release.yml` (the downloaded signed installer). Promotion
to production requires the candidate's `desktop-release-scan.json` to report
`ok: true` **and** the installer SHA-256 it recorded to equal the installer
being promoted, so a gate result cannot be replayed onto a different artifact.
Two defects in the first CI run of the gate were fixed before this commit, and
both are worth recording because they are the failure modes a byte-level gate
has: the ASAR header reader used the wrong pickle offsets (JSON length is at
byte 12 and JSON starts at 16, so every real archive was unreadable — the
committed fixture `src/lib/__fixtures__/app-asar-fixture.asar` is a real
`@electron/asar` archive so the offsets cannot drift again), and findings were
printed to stderr where a step log does not show them, which made the failure
undiagnosable. The gate also now prefilters the private-key pattern on the two
`-----BEGIN `/`PRIVATE KEY-----` literals so a backtracking-prone regex never
runs over bundled JavaScript.

Those four workflow contracts are themselves asserted by
`src/lib/desktop-release-hardening.test.ts` ("release workflow wiring"), so
deleting a gate step from a workflow fails `verify-shippables` instead of
silently weakening the release.

Nothing in this repository ships a Central JWT signing key, Superadmin
password, seed credential, platform API key or private signing key: the
release public key is injected at build time from the protected
`DESKTOP_RELEASE_PUBLIC_KEY_PEM` variable, and no private key is committed.

## 4. Negative tests (Hybrid and Full Offline)

Both desktop modes run the same binary with `DEPLOYMENT_ROLE` compiled to
`site`, so one denial path covers both:

The database suites that exercise the Central realm
(`integration/platform-*.integration.test.ts`, `session-producers-854`,
`login-lockout-enumeration`) declare `DEPLOYMENT_ROLE=central` in `beforeAll`
and restore it afterwards, exactly as the commission suites already did for the
sync role. That is the point of the guard: the console's own tests have to say
they are Central, and an install that does not say so cannot reach the realm.

| Surface | Test |
| --- | --- |
| `/platform/*`, `/api/platform/*` on a site, any cookie | `src/middleware.issue-1194.test.ts`, `src/middleware.issue-1003.test.ts` |
| direct handler invocation on a site (no middleware) | `src/lib/platform-realm-isolation.test.ts` |
| every platform API route is guarded (static enumeration) | `src/lib/platform-realm-isolation.test.ts` |
| direct platform logout on a site | `src/lib/platform-realm-isolation.test.ts` |
| forged platform cookie / tenant token replayed as platform | `src/middleware.issue-1194.test.ts` |
| tenant token with forged platform claims | `src/lib/platform-realm-isolation.test.ts` |
| platform session minted on another installation | `src/lib/platform-realm-isolation.test.ts` |
| inherited env cannot set the site role, test mode or test loopback | `src/lib/backend-manager-environment.test.ts` |
| installed release cannot be switched into test mode | `electron/scripts/smoke-packaged.js` (Windows CI) |
| packaged runtime contains no platform module or raw TypeScript | `scripts/desktop/central-route-exclusions.cjs`, `scripts/desktop/traced-source-exclusions.cjs`, `src/lib/desktop-traced-source.test.ts` + release scan |

Expected behaviour in all cases: denial with **no mutation** — middleware
returns 404 without setting a cookie or redirecting, and the authorization
guard returns before any database access.

## 5. What remains, and how to finish the independent .exe assessment

The code, packaging and pipeline changes above are complete. The final
checklist item — an independent assessment of the actual signed `.exe` — needs
a Windows runner and the protected signing configuration, so it is **not**
claimed here. It runs automatically as part of a release candidate:

1. `windows-signed-candidate` builds and signs, then runs
   `node scripts/scan-desktop-release.mjs --payload=electron/dist/win-unpacked
   --installer="electron/dist/Bizamiz Setup <version>.exe"
   --output=desktop-release-scan.json --require-installer-extraction`
   and uploads `business-suite-windows-<version>-release-scan`.
2. `windows-11-release` scans the downloaded signed installer again on the
   retail machine before installing it, then runs the external acceptance
   harness against the installed binary (fresh install, abrupt-stop recovery,
   in-place update, uninstall with data preserved).
3. `build-desktop-installer` runs the same gate on every packaging build,
   including the standard-user install/launch/restart acceptance.

To reproduce manually on a Windows machine:

```powershell
# 1. Scan the artifact without executing it
node scripts/scan-desktop-release.mjs --installer="Bizamiz Setup <version>.exe" `
  --output=release-scan.json --require-installer-extraction

# 2. Install non-elevated and run the external acceptance harness
$env:DESKTOP_EXECUTABLE = "$env:LOCALAPPDATA\Programs\Bizamiz\Bizamiz.exe"
$env:DESKTOP_ACCEPTANCE_USER_DATA = "$env:TEMP\biza-acceptance"
node electron/scripts/smoke-packaged.js
```

Record in the release ticket: build SHA, desktop version from
`electron/package.json`, CI run URL, `desktop-release-scan.json`,
`signed-candidate-release-scan.json` and the harness report.

### Recorded so far (unsigned development only)

[`docs/audits/1194-evidence/`](1194-evidence/EVIDENCE.md) holds the only Windows
evidence CI has produced: the release scan for the **unsigned 1.0.197 development**
installer (`desktop-release-scan-1.0.197.json`, `ok: true`, `findings: []`), the
signature report showing that artefact is `NotSigned`
(`windows-signature-verification.json`), and the **Hybrid-mode** acceptance log from
the same `build-desktop-installer` run (`windows-acceptance-2026-11-18.log`).
The 1.0.202 CI run (`44415239203`, commit `d4c7466f`) repeated the same
unsigned-development result: installer SHA-256
`75901fe55665858aba5e5f2c2a6ab2dded49cf0d946792268fd0c464484707b1`,
`NotSigned`, release scan `ok: true` under the rules as they stood.

Re-running the *new* scan against those same 1.0.202 bytes found one defect the
old rules missed: `raw-source-file` at
`resources/desktop-runtime/src/lib/billing/entitlement/outbox-service.ts`. The
file is dead trace output (the compiled chunk in
`.next/server/chunks/20353.js` is what executes), but it disclosed the source of
a Central billing-entitlement client inside a site installer. It is now removed
at staging and rejected by the gate; see the *Traced source* bullet in section 2.

### Local reproduction (unsigned, 2026-11-20)

On a Windows 11 machine, the downloaded 1.0.202 installer was verified by hash
(`75901fe5…07b1`, matching the CI report) and `Get-AuthenticodeSignature`
answered `NotSigned`, matching `windows-signature-verification.json`. The new
scan rule reported the raw source above.

A build of this change (`npm run build`, then `npm run desktop:runtime`)
reported `Removed 1 traced TypeScript source file(s) (8013 bytes)`, `Excluded
Central Superadmin routes … 706 file(s)`, and no raw TypeScript or platform
route directory in `.desktop-runtime`. A payload assembled from that runtime
and the 1.0.202 `app.asar` passed the release scan (`ok`, 6,972 files). The
external harness then ran against the updated runtime and passed fresh-install
bootstrap, Owner login, restart with the same instance id, and every
platform-realm 404 probe; the Full Offline phase reported `skipped` (no staging
Cloud), and clean shutdown was skipped because the session had no window, so it
force-stopped and exercised the abrupt-stop path instead. This is local,
unsigned evidence; it is not the signed-artifact acceptance the ticket still
requires.

It deliberately contains no signed-installer scan and no Full Offline acceptance
run — both are still outstanding, and the harness reports the Full Offline phase as
`skipped` until a real staging Cloud URL and enrollment token are supplied (see
`EVIDENCE.md` `What is missing, and why it cannot be attached`).

### Remaining risks (accepted, documented)

- **No signed artifact exists yet.** Every Windows installer produced so far is
  `NotSigned`; `windows-signed-candidate` requires protected signing variables
  that are not configured in the repository. There is therefore no publisher
  identity / Authenticode evidence, and the release-scan evidence attached so
  far is for unsigned development bytes only.
- **Full Offline has not been exercised on a candidate yet.** The harness
  reports `skipped` unless a staging Cloud URL and a fresh single-use
  enrollment code are supplied. `windows-11-release.yml` now mints the code
  after the prior-release install, runs the phase against the updated
  candidate (`$env:INSTALL_DIR\Bizamiz.exe`), retains the candidate report and
  **fails the release** when the phase is not `passed`, instead of promoting
  on Hybrid alone. Until the `DESKTOP_ACCEPTANCE_OFFLINE_*` variables and
  secrets are configured, that workflow will fail closed — which is the
  intended release blocker, not evidence that Full Offline works.
- The 1.0.202 payload contained the raw source file described in section 2.
  The staging fix and the new `raw-source-file` rule are in place, but a new
  installer must be built and scanned before the artifact claim is true for a
  release candidate.
- An owner of the machine can patch their own local copy of the application.
  The guarantee is that doing so confers **no Central authority**: Central
  verifies its own session secret and its own database, and the platform
  routes are absent from the site runtime. Local patching can only change what
  that local install does with its own data.
- Per-install secrets protect at-rest configuration only; they do not make
  the installed JavaScript tamper-proof. ASAR integrity validation and the
  Electron fuses raise the cost but are not a security boundary by
  themselves.
- The release gate proves the absence of known markers and route modules; it
  is a regression gate, not a proof of absence of every possible vulnerability.
  A future review should treat new privileged routes as requiring the same
  exclusion + guard treatment.
