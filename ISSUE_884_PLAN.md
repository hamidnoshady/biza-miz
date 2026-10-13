# Issue #884 — Android TWA runtime, native bridge, and a dedicated CI/release pipeline

Working branch: `arena/05f6c985-biza-miz` (from `main` at `7b1b11c`).

Source: <https://github.com/hamidnoshady/biza-miz/issues/884> (the issue body is the spec; every
acceptance item in it is listed in the table below, not summarised).

## Scope decision: a foundation slice, not the whole issue

Issue #884 describes a full native platform: device registry, a mobile shell redesign,
Bluetooth and USB printers, call screening, VoIP, NFC, push and background sync. That is several
product slices. This branch delivers the **foundation** the rest depends on, and it stops there.

In scope (done or in progress on this branch):

- plan and contracts (this file, `config/native-bridge-contract.json`, `config/android-environments.json`)
- the web side of the bridge: contract, client, handshake, capability resolver, React provider and gate
- the Digital Asset Links file and the Android Trusted Web Activity shell, with App Links and an offline fallback
- the Android CI, a manual signed staging candidate, and a manual production release
- the runtime documentation (`docs/android-runtime.md`)
- **the device registry (Phase 6 below)**: a tenant-scoped table and RLS policy, self- and
  admin-service API routes, live revocation enforcement in `getSession()`, the `device.identity`
  bridge command (bridge version 2), and the registration client mounted in `WorkspaceShell`

Deferred (listed as follow-up work below): the device-registry admin/self-service UI (the API and
enforcement are done; there is no Settings screen yet), the mobile shell redesign, the list/card
representations, biometric re-authentication, push, background sync, the scanner, camera, share
and file flows, printers, CRM Caller ID and post-call CRM, feature flags, and store promotion
from a candidate.

## Baseline and what could be verified here

- Node 22 in the sandbox. The repo targets `>=24`. The web checks were run with the repo's own scripts.
- No JDK, Gradle, or Android SDK can be installed in this sandbox. Maven, Google Maven, and the
  Gradle distribution host are blocked. So the Android project was not compiled or tested locally.
  It was verified by `android-build.yml`, which is green on `f64c5fd` for both the pull request and the push.
- The Gradle wrapper JAR and scripts were taken from the `gradle/gradle` repository at tag
  `v8.14.3` through the GitHub API. The distribution checksum is pinned in
  `android/gradle/wrapper/gradle-wrapper.properties`.

## Versions

| Item | Chosen | Why not the latest |
|---|---|---|
| Gradle | 8.14.3 | The Gradle line that AGP 8.13 is released with. Gradle 9 is a separate upgrade. |
| Android Gradle Plugin | 8.13.2 (latest 8.x) | 9.x changes built-in Kotlin, which would add a second migration |
| Kotlin | 2.2.21 | Matches AGP 8.13. Newer lines are not needed for this code. |
| `androidx.browser` | 1.10.0 (latest) | Provides `TrustedWebActivityIntentBuilder`, `CustomTabsClient` and post-message |
| compileSdk / targetSdk | 36 | Google Play requires API 36 for new apps and updates from 2026-08-31 |
| minSdk | 24 | The lowest level with `activeNetwork` and `NotificationManager.areNotificationsEnabled` and no compat code |
| JDK | 17 | The AGP 8.x requirement |

`androidbrowserhelper` was not added. The Trusted Web Activity builder is in `androidx.browser`,
so the app needs one library rather than two.

## Phase 1 — contracts and the web side of the bridge

- [x] Plan and status (this file)
- [x] `config/native-bridge-contract.json`: protocol `biza-native-bridge`, version 1, commands, events, error codes, capabilities with `nativeMinBridgeVersion`
- [x] `config/android-environments.json`: development, staging and production, with separate application IDs
- [x] `src/lib/native/bridge-contract.ts`: typed commands, results, events, envelopes; validators that return `null` on anything unexpected
- [x] `src/lib/native/bridge.ts`: client with request IDs, timeouts, `channel_closed` on teardown, an injected transport, and no generic executor
- [x] `src/lib/native/handshake.ts`: the port is accepted only from the page's own origin
- [x] `src/lib/native/capability.ts`: native-first, browser fallback, and `updateRequired` only when the installed app predates the capability
- [x] `src/lib/native/native-environment.ts`: `android-app://` referrer detection against an allowlist, with a sessionStorage memory
- [x] `src/lib/native/native-runtime.ts`: external store, MessagePort adapter, and the attach and teardown lifecycle
- [x] `src/components/native/native-provider.tsx`, mounted in `src/app/layout.tsx`. Plain-web state on the server and on first render, so hydration matches.
- [x] `src/components/native/native-capability-gate.tsx`
- [x] Tests for each module above, plus drift guards in `native-config.test.ts` that compare the TypeScript allowlists, the Gradle build and `assetlinks.json` with the shared JSON

## Phase 2 — Trusted Web Activity and verified app setup

- [x] `public/.well-known/assetlinks.json`: `use_as_origin` and `handle_all_urls` for the three packages. Fingerprint lists are empty on purpose (fail closed), see the open questions.
- [x] App Links: an https intent filter with `autoVerify`, host set from the configured origin through a manifest placeholder
- [x] `TwaLauncherActivity`: opens the TWA with `TrustedWebActivityIntentBuilder`, binds the Custom Tabs service, and creates the post-message session
- [x] `TwaChannelCallback`: requests the channel after navigation, announces `bridge.ready`, and answers requests through the allowlisted router
- [x] `AppLinkRouter`: same host, https only, default port only, no userinfo. Anything else goes to home.
- [x] `OfflineActivity`: Persian offline, browser-unavailable, and not-configured screens with retry
- [ ] Fingerprints of the real signing keys — blocked on the upload key and the Play App Signing key
- [ ] Verification on a device: App Links verified, no browser chrome, channel established — not possible in this sandbox

## Phase 3 — the Android module

- [x] Gradle project: `settings.gradle.kts`, `build.gradle.kts`, `gradle.properties`, `gradle/libs.versions.toml`, the wrapper
- [x] One module, `:app`, with product flavors `development`, `staging` and `production` on the `environment` dimension
- [x] Configuration read from `config/*.json` at configuration time, not copied into Kotlin
- [x] Release tasks fail before compiling if the origin or the signing values are missing (`gradle.taskGraph.whenReady`). Every PR proves the refusal: the job asks for a staging release with neither, and fails unless Gradle says so.
- [x] `BridgeProtocol`, `BridgeCommandRouter`, `TwaSessionHolder`, `AppLinkRouter`
- [x] JVM tests: `AppLinkRouterTest`, `BridgeProtocolTest`, `BridgeCommandRouterTest`, `BridgeContractTest`
- [ ] Instrumented tests — deferred until there is a feature that needs an emulator

## Phase 4 — CI and release

- [x] `.github/workflows/android-build.yml`: path-filtered PR and push. Web bridge tests, then Gradle lint, JVM tests and the development debug APK, uploaded as `biza-miz-android-development-debug-NON-PRODUCTION`. Uses no secrets.
- [x] `.github/workflows/android-signed-candidate.yml`: manual, `main` only, `android-staging` environment. Signed staging APK and AAB, signature verified, checksums written to the job summary, artifact retained 30 days.
- [x] `.github/workflows/android-production-release.yml`: manual, `main` only, `android-production` environment. Validates the version inputs, refuses to reuse a tag, builds and verifies, tags `android-v<version>`, and uploads to Play only when `PLAY_SERVICE_ACCOUNT_JSON` is set.
- [x] `CLAUDE.md`: CI table row for `android-build.yml`; the two release workflows listed as manual only; a note on bash and `ubuntu-latest`
- [x] `.gitignore`: anchored Android build output, local SDK paths, and keystore patterns
- [x] Existing workflows are unchanged, including `mobile-emulator-acceptance.yml` and `mobile-real-device-acceptance.yml`
- [ ] Repository setup: the `android-staging` and `android-production` environments, their secrets and variables, and reviewers on the production environment — owner action
- [x] First green `android-build.yml` run: pull-request run `37942083863` on `af78713` (web bridge tests, Gradle lint, JVM tests, debug APK artifact)
- [x] Final `android-build.yml` run on `f64c5fd`: green on the pull request (`37944325144`) and on the push (`37944320292`)

## Phase 5 — documentation

- [x] `docs/android-runtime.md`: layout, environments, local development, testing, bridge contract, security model, permissions, offline behaviour, CI and release, secrets, Play Store steps, Digital Asset Links, and rollout
- [x] This plan

## Phase 6 — Device registry

Owner decisions that unblocked this phase (session after the owner chose "device registry" as
the next slice):

1. Owners and a member holding `native_devices.manage` may see/revoke every device in the
   business; everyone else sees/revokes only their own, server-enforced, tenant-isolated, with
   an audit record of every revocation.
2. Registration is an authenticated web API call, using an installation identity the Android app
   creates on first launch and hands over through a typed bridge command, after login and
   business selection. Idempotent, and it never silently reactivates a revoked device.
3. A revoked device loses the authenticated access tied to that installation (sessions, business
   API requests, sync, push, privileged native operations) — enforced server-side on every
   request, not only the next bridge round trip, because it cannot reach an offline device.
   Reactivation needs an explicit owner/admin action and a fresh login.

What is here:

- [x] `migrations/0216_native_app_devices.sql`: a new tenant-scoped table, its own RLS policy in
      the same migration (never `pos_devices`, which is the unauthenticated login-picker's
      terminal registry — a different security relationship, see the migration's own comment)
- [x] `src/lib/permissions.ts` / `src/lib/permission-registry.ts`: `native_devices.manage`, not
      owner-only, not in any role preset but `admin` (which holds every non-owner-only
      permission) — a business grants it per member the same way every other delegable key works
- [x] `src/lib/native-device-service.ts`: register (idempotent upsert, never revives a revoked
      row, never silently reassigns a shared installation's ownership), list (self/business),
      revoke (self/admin), reactivate (admin), each audited
- [x] `src/lib/auth.ts`: `SessionPayload.nativeDeviceId` (auth-edge.ts) and `checkNativeDevice`,
      wired into `resolveSessionFromToken` next to `checkEmployeeSession` — re-checks
      `revoked_at` on every request, the enforcement half of owner decision 3
- [x] `src/app/api/native-devices/**`: `POST /api/native-devices` (register, `requireMember`,
      rebinds the session cookie), `GET`/`DELETE /api/native-devices/self*` (self-service),
      `GET`/`DELETE /api/native-devices/[id]`, `POST /api/native-devices/[id]/reactivate`
      (`requirePermission(native_devices.manage)`)
- [x] Bridge contract bumped to version 2 for the new `device.identity` command (`minBridgeVersion`
      2): `config/native-bridge-contract.json`, `src/lib/native/bridge-contract.ts`,
      `BridgeProtocol.kt`, `BridgeCommandRouter.kt`, `InstallationId.kt` (the persistent
      installation UUID, kept in app-private `SharedPreferences`)
- [x] `src/lib/native/native-runtime.ts` / `src/components/native/native-provider.tsx`: exposes
      `request()` so a component can send a one-off bridge command, not only read capabilities
- [x] `src/components/native/native-device-registrar.tsx`, mounted in `WorkspaceShell` (not the
      root layout, which also wraps public pages with no session to register against): calls
      `device.identity` once connected and registers it, best-effort, never blocking the page
- [x] `docs/android-runtime.md#device-registry`
- [x] Tests: `integration/native-device-registry.integration.test.ts` (the DB-touching service,
      against the real schema and RLS, the same pattern as `device-binding.integration.test.ts`);
      unit tests for the bridge contract, the runtime store's `request()`, the registrar
      component, the Kotlin router and `BridgeContractTest`'s drift check
- [ ] A Settings UI to see/revoke devices (self and admin) — the API and enforcement exist;
      the screen does not. Follow-up.
- [ ] Revoking a push-notification token (`notifications_devices`, a separate web-push table) when
      a native device is revoked — out of scope until the FCM slice exists.
- [ ] Device-on-a-list verification on a real signed build — the sandbox cannot run Gradle.

## Acceptance criteria — issue #884

The 28 items in the issue's "Acceptance criteria" section. "Done" means implemented here and
covered by a test or a CI job. "Partial" means part of it is here. "Deferred" means it is not in
this slice and is listed under follow-up work.

| # | Criterion | Status | Proof / what remains |
|---|---|---|---|
| 1 | Existing repo structure is preserved | Done | Nothing under `src/`, `electron/` or `apps/` moved. `src/app/layout.tsx` gained one provider. |
| 2 | New `android/` runtime added | Done | `android/` Gradle project. Green in CI (run `37942083863`). |
| 3 | Verified TWA works without browser chrome | Partial | TWA launcher with the trusted builder. Not run on a device. |
| 4 | Digital Asset Links validated | Partial | `assetlinks.json` with three statements. Fingerprints and the live check are open. |
| 5 | App Links deep-link to the correct platform routes | Partial | Intent filter and `AppLinkRouterTest` (same host, https, default port). Not run on a device. |
| 6 | Native/web bridge is typed, versioned, allowlisted, and tested | Done | `config/native-bridge-contract.json`; `bridge-contract.test.ts`, `bridge.test.ts`, `native-config.test.ts`; `BridgeProtocolTest`, `BridgeContractTest` |
| 7 | Android can detect supported native capabilities | Partial | `resolveCapability` and `NativeProvider`. The app reports `notifications` only. |
| 8 | Mobile/TWA UI uses a real app shell | Deferred | The shell redesign (top bar, `Home \| Sales \| + \| CRM \| More`) is a separate slice. The existing bottom bar is unchanged. |
| 9 | All major platform modules remain accessible on Android | Partial | The TWA opens the full web platform, so nothing is hidden. Verify on a device. |
| 10 | Major lists/tables have mobile-native card/row representations | Deferred | Existing design-system rules are unchanged and remain authoritative. |
| 11 | Device registration and revocation work | Partial | `native_app_devices`, registration/list/revoke/reactivate APIs, live enforcement in `checkNativeDevice`, and the `device.identity` bridge command are all in (Phase 6). No Settings UI to see/revoke a device yet, and not verified on a signed device build. |
| 12 | Biometric re-authentication works | Deferred | Capability key `biometric` is reserved; no implementation. |
| 13 | Push notifications deep-link correctly | Deferred | No FCM in this slice. |
| 14 | Background native sync without a second business datastore | Deferred | No native storage was added. |
| 15 | Barcode/QR scanner integrates with web routes | Deferred | `barcode.scan` is reserved, with a `BarcodeDetector` browser fallback in the resolver. |
| 16 | Android share/file/camera flows integrate with the media flows | Deferred | Capability keys `share` reserved. |
| 17 | Native printer support is capability-gated | Partial | `printer` is reserved, and `NativeCapabilityGate` exists. No printer code. |
| 18 | CRM Caller ID identifies tenant customers from a local cache | Deferred | No `CallScreeningService`. Only the official API is in scope, as the issue requires. |
| 19 | Post-call CRM activity can be saved | Deferred | Needs the caller module. |
| 20 | Tenant isolation is enforced for native cached data and actions | Partial | No native cache and no tenant-bearing command exist yet. The rule is in the docs and the native-permission check is documented as not authorization. |
| 21 | Android PR CI is path-aware | Done | `android-build.yml` path filters, which include the issue's list. |
| 22 | Android PRs produce a debug APK artifact | Done | `biza-miz-android-development-debug-NON-PRODUCTION` (2.5 MB), uploaded by run `37942083863`. |
| 23 | Android release and signing secrets are protected | Done | Secrets are referenced only by the two release workflows, which run in environments and only on `main`. The keystore is decoded to the runner temp and removed. The Gradle check fails before compilation. Environment setup is an owner action. |
| 24 | Android has a separate build/release workflow from web and Windows | Done | Three `android-*.yml` files. Nothing in `test.yml` or the Windows workflows changed. |
| 25 | Web deploys do not unnecessarily require an Android release | Done | Web and Android versions are independent. `src/lib/native/**` changes run the Android build but not a release. |
| 26 | Bridge compatibility prevents old installed apps from breaking | Partial | `minBridgeVersion` and `nativeMinBridgeVersion`, unknown keys ignored, `updateRequired`, tested on the web side. The contract has already been versioned once in practice (1→2, for `device.identity`) without changing any existing command's shape. Two real app versions not tested on a device. |
| 27 | Existing mobile emulator/real-device acceptance remains in place | Done | Those workflows are untouched. |
| 28 | Documentation is added | Done | `docs/android-runtime.md`. Store and rollout steps need the owner's Play account. |

## What each change does

| Change | Purpose |
|---|---|
| `config/native-bridge-contract.json` | The bridge contract, in one file that both sides read |
| `config/android-environments.json` | Application IDs and origins per environment |
| `public/.well-known/assetlinks.json` | Digital Asset Links statements, served by the existing `public/` folder |
| `src/lib/native/*.ts` | The web side of the bridge: contract, client, handshake, capabilities, detection, runtime store |
| `src/components/native/*.tsx` | Provider and gate for React |
| `src/app/layout.tsx` | Mounts `NativeProvider` inside the theme provider. No visual change. |
| `android/**` | The Gradle project, the TWA launcher, the offline screens, the bridge, and the tests |
| `.github/workflows/android-*.yml` | The three Android workflows |
| `CLAUDE.md` | CI table row, manual-only list, and runner note |
| `.gitignore` | Anchored Android build and signing patterns |
| `docs/android-runtime.md` | Documentation for developers and the release owner |
| `migrations/0216_native_app_devices.sql` | The device registry's table and RLS policy |
| `src/lib/native-device-service.ts` | Register/list/revoke/reactivate a device, each audited |
| `src/app/api/native-devices/**` | Self- and admin-service device-registry API routes |
| `src/lib/auth.ts`, `src/lib/auth-edge.ts` | `nativeDeviceId` on the session and `checkNativeDevice`, the live revocation check |
| `src/components/native/native-device-registrar.tsx` | Registers the installation once the bridge connects |
| `android/**/bridge/InstallationId.kt` | The persistent installation UUID, in app-private storage |

## Decisions worth reading before review

- **TWA via `androidx.browser`, not a generated Bubblewrap project.** The launcher is ours, so the
  bridge and the origin handling are in one place, and they can be reviewed as code.
- **The post-message origin is the web origin.** The Chrome guide says `sourceOrigin` is the
  origin the TWA is equivalent to. That is the web origin, not `android-app://`. The handshake
  checks `event.origin` against `location.origin`.
- **Empty fingerprints fail closed.** Until the signing keys are known, App Links do not verify
  and the TWA opens as a Custom Tab. The bridge never connects, and the page stays in web mode.
- **Staging and production origins are not committed.** A guessed host would be a silent
  misconfiguration. The release task refuses to run without one.
- **Native permissions are not authorization.** No command in this slice reads or changes
  business data, so there is no server endpoint to guard yet. The rule is recorded in the
  contract, the router, and the docs, to apply to every command added later.
- **The bridge sends JSON strings.** The app's `postMessage` accepts strings only. This keeps
  the Kotlin side to `JSONObject` and avoids a parser dependency.
- **The production release builds from `main` and is gated by its environment.** The Windows
  pipeline promotes a previously accepted candidate. Android does not have acceptance evidence
  yet, so promotion is not implemented. It is follow-up work.

## Follow-up work (next slices)

1. Device-registry UI: a Settings screen (self list/revoke; an admin business-wide list/revoke/
   reactivate behind `native_devices.manage`), composed from the existing `data-table.tsx` /
   `page-chrome.tsx` / `ui.tsx` primitives, the same way the `pos_devices` "دستگاه‌های ثبت‌شده"
   tab is. The API and server-side enforcement (Phase 6) are already in; this is the screen.
2. Mobile shell: the top app bar, `Home | Sales | + | CRM | More` through the existing
   `MobileBottomNavigation` (which already has a customisable bar), and the quick-create sheet.
3. Mobile lists: card and compact-row representations in the design system's `DataTable` and
   `mobile-record-list` pattern. This needs a design review.
4. Biometric re-authentication and passkeys through Credential Manager. The issue's "forced
   re-authentication" on device revocation (beyond the session invalidation Phase 6 already
   does) depends on this slice existing first.
5. Push: FCM with deep links, and a server-side device token — likely a column on
   `native_app_devices` rather than a second table, so a revoked device is also unreachable by
   push without an extra join.
6. Native capabilities, one at a time, each behind its own `nativeMinBridgeVersion` and a
   feature flag: barcode, camera and document capture, share and file, network and Bluetooth
   printers, the caller module.
7. Store promotion from a signed candidate, with the acceptance evidence required by the Windows
   pipeline, instead of a rebuild.
8. Instrumented tests once a feature needs an emulator.

## Owner decisions

Answered by the owner during the session. Recorded here so the decisions travel with the code.

1. **Web hosts.** Production is `https://app.eshobe.com`, which is also the App Link host. Staging is `https://staging.eshobe.com`. Still owner setup: set the GitHub variables `ANDROID_WEB_ORIGIN_PRODUCTION=https://app.eshobe.com` and `ANDROID_WEB_ORIGIN_STAGING=https://staging.eshobe.com` on the matching environments. Until they are set, the staging and production builds refuse to compile.
2. **Play account.** There is no Play Console app yet. Next: create the app with the application ID `com.bizamiz.app`, and confirm in Play Console that Play App Signing is enrolled. Once it is, the Digital Asset Links fingerprint is the app signing key's SHA-256 from Play Console, not the upload key's. That value then goes into `public/.well-known/assetlinks.json`. Uploads to Play stay off until a service account exists.
3. **The device registry.** It gets its own tenant-scoped table, `native_app_devices`, not
   `pos_devices` (the unauthenticated login-picker's terminal list — a different security
   relationship), with RLS in the same migration. The owner answered the three open questions
   from item 3 above, in this later session:
   - **Who may see/revoke a device.** Owners and a member holding `native_devices.manage` may
     see and revoke every device in the business. Every other user may see and revoke only their
     own device. Enforced server-side, tenant-isolated, every revocation audited.
   - **How a device registers.** An authenticated web API call. The Android app creates a
     persistent installation identity on first launch (`InstallationId.kt`). After login and
     business selection, the web app reads that identity through the new `device.identity`
     bridge command and calls `POST /api/native-devices`. The server derives the user and tenant
     from the session, never from the request body. Registration is idempotent and never
     silently reactivates a revoked device.
   - **What a revoked device can still do.** It loses the authenticated access tied to that
     installation: sessions and credentials for it are invalidated, and business API requests,
     sync, push, and privileged native operations are denied. Only public/login screens, app
     updates, and basic diagnostics stay reachable, behind a "device revoked" screen.
     Reactivation needs an explicit owner/admin action plus a fresh sign-in. Other devices are
     unaffected. Revocation cannot reach a disconnected device instantly or erase what it already
     cached; the server enforces it on every protected request once the device is back online,
     and the client is expected to stop protected local operations and clear sensitive caches
     once it detects the revocation, not only on the next bridge call.
   - **A fourth point in the owner's instructions was cut off before any content followed "4."**
     It was never recovered in this session. If it covered a requirement this slice's design
     does not already satisfy, it still needs to be asked and applied as a follow-up.

## Gates

Local, on the final tree `f64c5fd` (sandbox: Node 22, 2 CPUs, 3.9 GB RAM). Every check below ran after a fresh `npm ci`:

- `npm ci`: exit 0.
- `npx tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=3072` (the heap CI uses): exit 0. An earlier attempt ran out of the default heap. That is a sandbox limit, not a type error.
- `npm test`: 706 files, 9,303 tests passed.
- `npx vitest run src/lib/native src/components/native`: 9 files, 161 tests passed. That count includes 33 tests in `src/lib/native-printing.test.ts`, an existing printing test file that the path filter also matches.
- `npx eslint src/lib/native src/components/native src/app/layout.tsx --max-warnings=0`: clean. `npm run lint` (whole repo): exit 0.
- `npm run db:migrate` (302 migrations applied), then `npm run test:db` with `DATABASE_URL` set: 197 files, 2,696 tests passed, 1 skipped. `vitest` does not read `.env`, so `DATABASE_URL` must be set in the environment, as CI does. A first run without it failed two files at import (the other 195 passed). That was an invocation mistake, not a code change.
- `npm run build`: **not completed here**. The production build needs more memory than this sandbox has, and a memory watchdog stopped it before the build finished. The `production build` job in `test.yml` is the gate for this step. It passed on both `test.yml` runs for `f64c5fd`.

Android, on GitHub (the sandbox has no JDK, SDK, or Gradle host access):

Not yet exercised: the two release workflows (`android-signed-candidate.yml`, `android-production-release.yml`). They are manual, main-only, and need the protected environments and their secrets, which are owner setup. A signed build and a Play upload have not run.

- `android-build` on `f64c5fd`: green on the pull request (run `37944325144`) and on the push (run `37944320292`). Web native bridge tests, Gradle lint, JVM unit tests and the debug APK all passed.
- Four CI runs failed before the green one, and each was a real defect. Three were the Gradle `whenReady` release guard: a bare lambda resolved to the deprecated Groovy `Closure` overload (two runs), and a lambda with an explicit `Action` type still did not infer (one run). An object expression fixed it. The fourth was a `toList()` call on `JSONArray` in a unit test, which only showed once the app code had compiled. Reading the androidx.browser source before CI reported it also found that `TrustedWebActivityIntentBuilder.build()` returns a `TrustedWebActivityIntent`, not an `Intent`. That was fixed in the same push as the diagnostics, and the app code compiled in the fourth run, so the fix is confirmed.

`test.yml` on `f64c5fd`, pull request run `37944325314` and push run `37944320331`:

- passed on both runs: production build, unit tests, integration tests (real database), data transfer engine (real database), ESLint, type check, API guard and permission tests, design checks, media E2E tests.
- **failed on both runs: visual regression.** It reports a 4.06% pixel diff on `docs/design/visual/accounting-expenses.png`. The same diff fails on `main` in runs `37919841516` and `37925908136`, so it predates this branch. Nothing under `docs/design` or the accounting UI changed here. The baseline is not re-recorded, per the repo rules. Because `required` depends on it, the PR will show red until `main` is fixed.

`verify-shippables` on `f64c5fd`:

- Pull request run `37944325145`: passed.
- Push run `37944320200`: the `desktop shell` job failed at the `npm ci` install step. This branch does not change `package.json`, the lockfile, `electron/`, or the workflow. The same job passed on the pull request run for this commit, and recent `main` push runs pass. No cause was found, and the job logs are not readable from the sandbox, so it is recorded as probably transient. GitHub refused a re-run and a manual dispatch from the sandbox. Re-run that job from the Actions tab to confirm.

## Gates — device registry slice (Phase 6)

Local, on the pre-commit tree built on top of `f64c5fd`/`main` (sandbox: Node 22, 2 CPUs, 3.9 GB
RAM, `DATABASE_URL` pointed at the `embedded-postgres` devDependency's local server). Run after a
fresh `npm ci`:

- `npx tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=3072`: exit 0, once the new
  `native-device-registrar.test.tsx` file's two `vi.fn()` call-site types were corrected (an
  argument-less mock inferred a zero-length `calls[]` tuple; typed the mocked `fetch` signature
  explicitly instead).
- `npm test`: 707 files, 9,320 tests passed. One pre-existing drift test needed a one-line fix for
  this slice: `src/lib/billing/catalog/audit.test.ts` enumerates every `/api/<segment>` and fails
  until it is classified; `native-devices` is now in `routes.ts`, classified the same way
  `devices` (`pos_devices`) is — an operations/security surface, not a billed capability.
- `npm run db:migrate` (303 migrations applied, `0216_native_app_devices.sql` included and a
  no-op on rerun — also exercised by `integration/migrations.integration.test.ts`'s clean-database
  and upgrade-from-0011 paths), then `npm run test:db`: 198 files, 2,702 tests passed, 1 skipped,
  zero failures. Includes the new `integration/native-device-registry.integration.test.ts` (6
  tests: idempotent re-registration as a heartbeat with exactly one audit row, a revoked
  installation refusing to reactivate itself on a repeat register from any user, refusing a silent
  ownership transfer to a different member, cross-tenant isolation on revoke/reactivate/list, a
  plain member's self list/revoke scoped away from an admin's business-wide view, and an
  owner/admin's revoke → reactivate cycle with its own audit trail) and
  `integration/device-binding.integration.test.ts` (the pre-existing `pos_devices` suite, unaffected).
- `npm run build`: **not completed here**, same sandbox memory limit as the foundation slice —
  the process was OOM-killed partway through `Creating an optimized production build`. The
  `production build` job in `test.yml` is the gate for this step; it will be read from CI once
  this slice's commit runs there.
- Not run locally: the Kotlin changes (`InstallationId.kt`, `BridgeCommandRouter.kt`'s new
  constructor param and `device.identity` case, `BridgeCommandRouterTest.kt`'s new test) — no
  JDK/Gradle/Android SDK in this sandbox, same as the foundation slice. `BridgeContractTest.kt`
  needed no change: it compares `BridgeProtocol.COMMANDS` and `BRIDGE_VERSION` against
  `config/native-bridge-contract.json` generically, so it already covers the new command and the
  version bump to 2 without being told about either by name. `android-build.yml` is the verifier.

On GitHub, commit `77ce640` (this slice, pushed on top of `522545d`): `test.yml`'s `required`
fan-in job (named "all checks passed" on the check-runs API, `needs:` every `test.yml` job) is
**confirmed green on the pull-request-triggered run** — type check, unit tests, integration tests
(real database, 2118s locally / similar on CI), production build, data transfer engine, ESLint,
API guard and permission tests, design checks, media E2E tests and visual regression all passed.
`android-build.yml` is green too (web native bridge tests, Gradle lint, JVM unit tests, the debug
APK). The PR's `mergeable` is `MERGEABLE` (branch protection is satisfied); `mergeStateStatus` is
`UNSTABLE` only because of the two non-required Windows size-budget failures below, not because of
anything in the required gate. (The *push*-triggered duplicate run of the same commit separately
hit the pre-existing, already-documented flaky "4.06% of pixels changed" `accounting-expenses`
visual-regression diff — confirmed via its check-run annotation — which is why that run's own
fan-in failed; the pull_request run that actually gates the PR did not hit it.) Per `CLAUDE.md`'s
CI table, `test.yml` is the only workflow that fans into a `required` status check;
`verify-shippables.yml` and `build-desktop-installer.yml` run automatically but are not documented
there as required, and this was confirmed directly: their failing jobs are absent from the
`required`/"all checks passed" job's `needs:` list in `.github/workflows/test.yml`.

**Two Windows-only size budgets failed, and need an owner decision before this slice is
release-ready on desktop, even though they do not block the `required` gate:**

- `build-desktop-installer.yml`'s "Final size report and budgets" step measured the unpacked
  installed payload at **621.4 MiB**, over its **620 MiB** budget
  (`.github/workflows/build-desktop-installer.yml`). The same job on `main`'s most recent run
  (same day, commit `55a9b7ee`) measured **618.6 MiB** — a 1.4 MiB margin that this slice's new
  production code (five API routes, the device-registry service, the migration, the bridge
  contract/runtime additions) was enough to cross by itself.
- `verify-shippables.yml`'s "desktop shell" job failed the same way on its "Staged runtime stays
  below pre-package budget" step (200 MiB budget); the exact MiB figure could not be read because
  job logs are not reachable from this sandbox (blob storage host is blocked), but it is the same
  `.next/standalone` + `migrations/` payload the installer budget measures, grown by the same
  commit, so it is almost certainly the same cause rather than a second, unrelated issue.

Both budgets are commented in their workflows as **deliberately tight, reviewed gates** ("leaves
nothing to hide" / "a runaway detector"), not auto-tuned numbers — bumping either is a product/ops
call, not a code fix, so this was raised to the owner rather than changed unilaterally. **Owner
decision: bump both budgets.** Applied in a follow-up commit, the same way the prior 600→620 MiB
precedent was handled — `build-desktop-installer.yml`'s unpacked-payload budget moves 620→640 MiB,
`verify-shippables.yml`'s staged-runtime budget moves 200→220 MiB, both with an explanatory comment
in the workflow and a dated note in `docs/standalone-desktop-app.md` (the prior 2026-10-03 note is
kept as history, not overwritten). **Confirmed fixed on CI**: both `desktop shell` (5m39s) and
`packaged Windows end-to-end` (15m14s) passed against the bump commit, including the "Staged
runtime stays below pre-package budget" and "Final size report and budgets" steps specifically.
Nothing about this affects the web or Android deliverable: no desktop-specific code was touched,
and the overage is pure Next.js bundle growth from genuine new routes/services.

A separate, pre-existing, already-documented flake resurfaced on the *push*-triggered duplicate of
`test.yml` for this same bump commit: "4.06% of pixels changed, bounds 54,18 1370×830" on
`docs/design/visual/accounting-expenses.png`, identical in percentage and bounds to the one seen
earlier on `main`/push-triggered runs of this branch. The *pull_request*-triggered run — the one
branch protection actually evaluates for this PR — passed visual regression cleanly both times it
ran. `gh pr view 890` reports `mergeable: MERGEABLE`; `mergeStateStatus: UNSTABLE` only because
GitHub surfaces the push-triggered run's duplicate failure alongside the passing one, not because
the required gate failed. Do not re-record the `accounting-expenses` baseline to "fix" this — it is
the same push-vs-pull_request-context flake already on record, not something this slice caused.

## Phase 6 hardening pass — three correctness/security bugs found on review, fixed

An independent review of the merged device-registry slice (PR #890, commit `915bd89`) found three
real gaps between the shipped code and the owner decisions in this plan. All three are fixed, with
new regression coverage, in migration `0217_native_app_devices_generation.sql` and the commit that
follows it.

1. **Reactivation could silently restore a session minted before revocation.** `checkNativeDevice`
   (auth.ts) checked only `revoked_at IS NULL`. Revoking sets it, reactivating clears it back to
   `NULL` — but a session JWT minted *before* the revocation (one that was never otherwise
   invalidated, e.g. a backgrounded tab whose token had not expired) would start resolving again
   the instant `revoked_at` went back to `NULL`, with no login in between. That contradicts owner
   decision #3's "reactivation requires an authorized owner/admin action followed by fresh
   authentication" — the fresh-authentication half never actually happened for that token.
   **Fix:** `native_app_devices.session_generation` (migration 0217), the same shape
   `platform_users.token_version` already has for a password change. Every session is stamped with
   the generation current when it was minted (`SessionPayload.nativeDeviceGeneration`); revoking
   *and* reactivating both bump the column; `checkNativeDevice` now denies any session whose
   stamped generation no longer matches, regardless of what `revoked_at` says. Proven by
   `integration/native-device-registry.integration.test.ts`'s "denies a session minted before
   revocation even after the device is reactivated" test, which signs a token, revokes, reactivates,
   and asserts that exact token is still denied — then shows a token from a *new* registration call
   resolves normally.
2. **A revoked installation's failed re-registration left its browser session fully authenticated
   and completely unbound.** `POST /api/native-devices` only re-signed the session cookie (binding
   `nativeDeviceId`) on success. On `device_revoked`, it returned 409 and touched nothing else — and
   `native-device-registrar.tsx` never reads the response body (by design: there is nothing useful
   to show the member, see its doc comment). The result: a session that logged in, failed to
   register because its installation was already revoked, kept working as an ordinary, fully
   authenticated session for the rest of the token's life, because `checkNativeDevice` only ever
   runs for a session that carries `nativeDeviceId` — and this one never got the chance to.
   **Fix:** `NativeDeviceError` now carries the conflicting row's `deviceId` and `sessionGeneration`
   for the `device_revoked` case specifically (not `device_registered_to_another_user`, which is a
   different user's own device, not this session's). The route handler re-signs and sets the
   session cookie, binding it to that (revoked) device, *before* returning the 409 — closing the gap
   purely through the `Set-Cookie` header, which the browser stores regardless of whether the
   client reads the response body or even the status code. Proven by the new
   `integration/native-device-registration-route.integration.test.ts`, which calls the real route
   handler, confirms the 409 response carries a bound session cookie, and confirms
   `resolveSessionFromToken` on that exact cookie value is denied.
3. **Two concurrent first-registrations of the same brand-new installation could throw a raw
   unique-constraint error instead of converging on one row.** `registerNativeDevice`'s
   `SELECT ... FOR UPDATE` only locks a row that already exists; for a genuinely new `installId`,
   two concurrent transactions both find nothing to lock and both attempt the `INSERT` branch — the
   loser's `INSERT` fails `native_app_devices_business_install_unique`, which propagated as an
   unhandled `NativeDeviceError`-less exception. **Fix:** the `INSERT` is now wrapped so a
   unique-violation (Postgres code `23505`) triggers a bounded retry (up to 3 attempts) of the whole
   transaction, which re-runs the `SELECT` and this time finds the winner's committed row, falling
   into the ordinary re-registration (`UPDATE`) branch instead. Proven by
   "resolves two concurrent first-registrations of the same brand-new installation into exactly one
   device row" (`Promise.all` of two calls), asserting one row, one `created: true`, no thrown error.

Local verification of this hardening pass (same sandbox as Phase 6's gates, after a fresh
`npm ci`): `npx tsc --noEmit` (heap raised to 6 GB — 3 GB was not enough this time) exit 0; `npm
run db:migrate` applied 304 migrations including `0217_native_app_devices_generation.sql`
cleanly; `npm test` — **707 files, 9,320 tests passed, 0 failures** (510.24s); `npm run test:db` —
**199 files, 2,707 tests passed, 1 skipped, 0 failures** (2691.39s), including both native-device
integration test files. `npm run build` did not complete locally — this sandbox has 3.8 GB of RAM
total, and the production build's webpack phase pegs Node's RSS at ~3.6 GB and thrashes rather than
producing a clear OOM error; this is a sandbox resource limit, not a code defect.

This commit (`c7a9039`, pushed to PR #890) was then confirmed green on GitHub's actual CI, which
is the authoritative check for the build in particular: `production build` passed in 5m22s,
`integration tests (real database)` passed in 24m21s (199/2707, matching the local run), `unit
tests` passed in 4m43s, `type check`, `ESLint`, `desktop shell`, `production container`,
`packaged Windows end-to-end`, `android development debug`, `web native bridge tests`, `media E2E
tests`, `design checks`, `API guard and permission tests`, `data transfer engine (real database)`,
`Windows print connector` and `WordPress plugin` all passed. Only `visual regression` failed, and
its annotation reports the exact same `docs/design/visual/accounting-expenses.png` diff (4.06% of
pixels changed) already on record as failing on `main` itself before this branch existed — not a
regression from this commit. Per the repo rules, the baseline is not re-recorded to paper over it.

Two other points the review raised were checked and are **not** bugs in this slice:

- **Empty `assetlinks.json` fingerprint arrays and no device/App-Links acceptance.** This is the
  documented, intentional state from the foundation slice (no signing key, no Play Console app
  yet — owner decisions recorded above) — the TWA fails closed until those exist, which is the
  correct behaviour, not a gap introduced here.
- **`android-build.yml`'s debug APK is labelled NON-PRODUCTION.** Also intentional and documented
  (PR #890's description) — it is a debug build with no secrets, never the signed artifact; the
  signed-candidate/production-release workflows are separate and manual.

Genuinely still missing, unchanged from before this pass and far larger than a hardening fix:
the Security/Devices settings UI (API and enforcement exist; no screen yet), biometric
re-authentication, push notifications, background sync, barcode/camera/file/share/media
integration, native printing, Caller ID and post-call CRM activity, and the full mobile-shell
navigation audit issue #884 asks for. None of those are started.

## Merging main into this branch to resolve PR #890's conflicts

`main` had advanced roughly 2,000 commits past this branch's original base by the time PR #890
showed real merge conflicts, and advanced again mid-resolution (a second PR merged to `main` while
this branch's first merge commit was being verified). Two merges were required, both pushed to this
branch:

1. `58afc25c` — merged `main` as of `3f429b7c`. Two textual conflicts, both comment-only, in
   `.github/workflows/build-desktop-installer.yml` and `docs/standalone-desktop-app.md`: two
   branches had independently raised the same Windows unpacked-payload/staged-runtime budgets
   (620→640 MiB, 200→220 MiB) for different, parallel reasons — this branch's device-registry
   slice (618.6→621.4 MiB) and `main`'s merged multicurrency/auth-hardening work (620.4 MiB).
   Resolved by combining both causes into one accurate narrative rather than picking a side.
2. `40f8203c` — merged `main` again as of `35cb0cd5` (which had landed issue #834's fiscal-period
   work, including its own commit raising the *same* 640/220 MiB values but explicitly noting that
   "maintainer acceptance of that increase remains undecided"). Same two files conflicted again, for
   the same underlying reason. Resolved by writing one narrative that lists all three independent
   crossings of the former 620 MiB budget and keeps the one still-open owner question (from the
   issue #834 / main-growth side) visible rather than asserting a false consensus that every
   increase was equally signed off.

No other file needed manual conflict resolution; everything else merged cleanly with git's `ort`
strategy despite the enormous amount of concurrent work on `main` (fiscal periods, chart-of-accounts,
cheques, payroll, multicurrency, auth hardening). Both merges were spot-checked for *silent* semantic
conflicts — not just textual ones — in every file this branch's own commits touch: `auth.ts`'s
`resolveSessionFromToken` chain still calls `checkNativeDevice` last, `SessionPayload` still carries
`nativeDeviceId`/`nativeDeviceGeneration`, `nativeDevicesManage` appears exactly once in both
`permissions.ts` and `permission-registry.ts` with no duplicate permission keys anywhere in the
merged 113-key table, and `db.ts`/`billing/catalog/routes.ts`/`layout.tsx`/`workspace-shell.tsx`
all still carry this branch's additions intact.

Verification after both merges (fresh `npm ci`, since `main` had also moved `package-lock.json`):
all `.github/workflows/*.yml` still parse as valid YAML; `npx tsc --noEmit` clean; `npm run lint`
(`eslint --max-warnings=0`) clean; `npm test` — **786 files, 10,354 tests passed, 0 failures**;
`npm run db:migrate` — 329+ migrations apply cleanly, including both `0216_native_app_devices.sql`
and `0217_native_app_devices_generation.sql` interleaved correctly with `main`'s own
differently-named 0216/0217-numbered migrations (this repo's migration runner orders by full
filename, not by numeric prefix, so same-numbered files from different branches are not a
collision); `npm run test:db` — **215 files, 3,175 tests passed, 1 skipped, 0 failures**. An
intermediate run of `test:db` showed 5 failures in `seed-live-chart`/`runtime-role-regrant`; the
root cause was that this session had started a brand-new empty embedded Postgres and run the suite
before running `npm run db:migrate` against it, not a merge defect — confirmed by re-running those
two files in isolation (failed identically before migrating, passed cleanly after) and then by the
0-failure full re-run above. `npm run build` still cannot complete in this sandbox's 3.8 GB RAM
(pre-existing, unrelated to the merge); CI's `production build` job is the authoritative gate.

**CI on the final merged commit (`40f8203c`), confirmed on GitHub directly:** 17 of 18 required
jobs passed, including `production build` (5m8s), `integration tests (real database)` (29m10s,
215 files / 3,175 tests, matching the local run), `unit tests` (4m46s), `type check`, `desktop
shell`, `production container`, `packaged Windows end-to-end` (15m27s, proving the merged 640/220
MiB budgets still hold against the combined payload), `android development debug`, `web native
bridge tests`, `media E2E tests`, `design checks`, `API guard and permission tests`, `data transfer
engine (real database)`, `Windows print connector` and `WordPress plugin`. Only `visual regression`
failed — its annotations (`accounting-cheques-dark.png` 4.26%, `accounting-cheques.png` 6.23%,
`accounting-chart-of-accounts.png` 4.08%) were compared directly against `main`'s own `test.yml` run
at commit `96c437f1` (the exact commit this branch's second merge pulled in) and are byte-for-byte
the same failure, with the same files and the same percentages, already failing on `main` itself
before this branch touched it. Per the repo's rules, the baseline is not re-recorded to paper over
a pre-existing flake on `main`.

Because `main` is moving fast (two conflicting merges were needed within the same work session),
PR #890's mergeable status should be re-checked immediately before any actual merge or approval —
another conflict in these same two budget-history files is plausible, and should get the same
treatment (combine the causes honestly) rather than a reflexive re-bump of the numbers.

## Files


Added: `ISSUE_884_PLAN.md`, `docs/android-runtime.md`, `config/native-bridge-contract.json`,
`config/android-environments.json`, `public/.well-known/assetlinks.json`, `src/lib/native/`
(6 modules and 7 test files), `src/components/native/` (2 components and 1 test file), `android/`
(Gradle files, sources, resources, 4 JVM tests), `.github/workflows/android-build.yml`,
`.github/workflows/android-signed-candidate.yml`, `.github/workflows/android-production-release.yml`.

Changed: `src/app/layout.tsx` (one provider), `CLAUDE.md` (CI table, manual list, runner note),
`.gitignore` (anchored Android patterns).

Not changed: `src/` (other than the layout), `electron/`, `test.yml`, `mobile-emulator-acceptance.yml`,
`mobile-real-device-acceptance.yml`, `migrations/`, `src/middleware.ts`, `next.config.ts`.

Device registry slice (Phase 6), added on top of the above: `migrations/0216_native_app_devices.sql`,
`src/lib/native-device-service.ts`, `src/app/api/native-devices/` (5 route files),
`src/components/native/native-device-registrar.tsx` and its test,
`integration/native-device-registry.integration.test.ts`,
`android/app/src/main/java/com/bizamiz/android/bridge/InstallationId.kt`. Changed:
`src/lib/permissions.ts` / `src/lib/permission-registry.ts` (`native_devices.manage`),
`src/lib/auth.ts` / `src/lib/auth-edge.ts` (`nativeDeviceId`, `checkNativeDevice`),
`src/lib/db.ts` (`native-device-auth` bypass reason), `src/lib/billing/catalog/routes.ts`
(classifies the new API segment), `src/app/dashboard/workspace-shell.tsx` (mounts the registrar),
`config/native-bridge-contract.json` / `src/lib/native/bridge-contract.ts` (bridge version 2,
`device.identity`), `android/.../bridge/BridgeProtocol.kt`, `BridgeCommandRouter.kt`,
`TwaLauncherActivity.kt`, `BridgeCommandRouterTest.kt`, `src/lib/native/native-runtime.ts` /
`native-provider.tsx` (exposes `request()`), `docs/android-runtime.md` (the new
"Device registry" section).

Phase 6 hardening pass, added on top of the above:
`migrations/0217_native_app_devices_generation.sql` (`session_generation` column),
`integration/native-device-registration-route.integration.test.ts` (new file — the route-level
`device_revoked` binding test). Changed: `src/lib/auth-edge.ts` (`nativeDeviceGeneration` on
`SessionPayload`), `src/lib/auth.ts` (`checkNativeDevice` compares generations, not just
`revoked_at`), `src/lib/native-device-service.ts` (`NativeDeviceError` carries `deviceId`/
`sessionGeneration` for `device_revoked`; `registerNativeDevice` retries a unique-violation race;
revoke/reactivate bump `session_generation`), `src/app/api/native-devices/route.ts` (binds the
session on a `device_revoked` failure, not only on success),
`integration/native-device-registry.integration.test.ts` (3 new tests).
