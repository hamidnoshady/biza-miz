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
5. closes the window (graceful `WM_CLOSE`, never a forced kill), asserts the
   process exits 0 and no `postmaster.pid` remains;
6. relaunches, asserts the instance identity persisted, that a second
   bootstrap answers `409 already_initialized`, that the real password still
   signs in and a wrong one does not;
7. when `DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL` and
   `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN` are configured (protected repository
   variable + secret), repeats a first run on a fresh profile in **Full
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
| forged platform cookie / tenant token replayed as platform | `src/middleware.issue-1194.test.ts` |
| tenant token with forged platform claims | `src/lib/platform-realm-isolation.test.ts` |
| platform session minted on another installation | `src/lib/platform-realm-isolation.test.ts` |
| installed release cannot be switched into test mode | `electron/scripts/smoke-packaged.js` (Windows CI) |
| packaged runtime contains no platform module | `scripts/desktop/central-route-exclusions.cjs` + release scan |

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

### Remaining risks (accepted, documented)

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
