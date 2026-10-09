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

Deferred (listed as follow-up work below): the device registry, the mobile shell redesign, the
list/card representations, biometric re-authentication, push, background sync, the scanner,
camera, share and file flows, printers, CRM Caller ID and post-call CRM, feature flags, and
store promotion from a candidate.

## Baseline and what could be verified here

- Node 22 in the sandbox. The repo targets `>=24`. The web checks were run with the repo's own scripts.
- No JDK, Gradle, or Android SDK can be installed in this sandbox. Maven, Google Maven, and the
  Gradle distribution host are blocked. So the Android project was not compiled or tested locally.
  It was verified by the `android-build.yml` run on the pull request, which is green on `af78713`.
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

## Phase 5 — documentation

- [x] `docs/android-runtime.md`: layout, environments, local development, testing, bridge contract, security model, permissions, offline behaviour, CI and release, secrets, Play Store steps, Digital Asset Links, and rollout
- [x] This plan

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
| 11 | Device registration and revocation work | Deferred | Device registry is the next slice. |
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
| 26 | Bridge compatibility prevents old installed apps from breaking | Partial | `minBridgeVersion` and `nativeMinBridgeVersion`, unknown keys ignored, `updateRequired`, tested on the web side. Two real app versions not tested. |
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

1. Device registry: a server table for each Android installation, with its own name (not
   `devices`, which is POS terminals), RLS in the same migration, a Security/Devices UI, and
   revocation that takes effect on the next bridge request. The issue's "forced re-authentication"
   needs the biometric slice first.
2. Mobile shell: the top app bar, `Home | Sales | + | CRM | More` through the existing
   `MobileBottomNavigation` (which already has a customisable bar), and the quick-create sheet.
3. Mobile lists: card and compact-row representations in the design system's `DataTable` and
   `mobile-record-list` pattern. This needs a design review.
4. Biometric re-authentication and passkeys through Credential Manager.
5. Push: FCM with deep links, and a server-side device token that the registry owns.
6. Native capabilities, one at a time, each behind its own `nativeMinBridgeVersion` and a
   feature flag: barcode, camera and document capture, share and file, network and Bluetooth
   printers, the caller module.
7. Store promotion from a signed candidate, with the acceptance evidence required by the Windows
   pipeline, instead of a rebuild.
8. Instrumented tests once a feature needs an emulator.

## Open questions for the owner

1. **The production and staging web hosts.** The App Link host, the origin in each environment,
   and the assetlinks statements all depend on them. Until they are set, staging and production
   builds refuse to compile.
2. **Play account and signing mode.** Whether the app is already created in Play Console, and
   whether Play App Signing is enrolled. Production fingerprints come from that key.
3. **Whether the device registry is the next slice,** or whether the mobile shell comes first.

## Gates

Local, on the final tree (sandbox: Node 22, 2 CPUs, 3.9 GB RAM):

- `npx tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=3072` (the heap CI uses): exit 0. The first attempt ran out of the default heap, which is a sandbox limit and not a type error.
- `npm test`: 706 files, 9,300 tests passed.
- `npx vitest run src/lib/native src/components/native`: 9 files, 158 tests passed. That count includes 33 existing printing tests that the path filter matches.
- `npx eslint src/lib/native src/components/native src/app/layout.tsx --max-warnings=0`: clean. `npm run lint` (whole repo): exit 0.
- `npm run db:migrate` (302 migrations applied) then `npm run test:db`: 197 files, 2,696 tests passed, 1 skipped.
- `npm run build`: **not completed here**. The production build needs more memory than this sandbox has, and a memory watchdog stopped it before the build finished. The `production build` job in `test.yml` is the gate for this step. It passed on the pull-request run for `af78713`.

Android, on GitHub (the sandbox has no JDK, SDK, or Gradle host access):

Not yet exercised: the two release workflows (`android-signed-candidate.yml`, `android-production-release.yml`). They are manual, main-only, and need the protected environments and their secrets, which are owner setup. A signed build and a Play upload have not run.

- `android-build` on `af78713`, both pull-request and push: web native bridge tests passed. `android development debug` passed: Gradle lint, JVM unit tests and the debug APK all succeeded.
- Four CI runs failed before the green one, and each was a real defect. Three were the Gradle `whenReady` release guard: a bare lambda resolved to the deprecated Groovy `Closure` overload (two runs), and a lambda with an explicit `Action` type still did not infer (one run). An object expression fixed it. The fourth was a `toList()` call on `JSONArray` in a unit test, which only showed once the app code had compiled. Reading the androidx.browser source before CI reported it also found that `TrustedWebActivityIntentBuilder.build()` returns a `TrustedWebActivityIntent`, not an `Intent`. That was fixed in the same push as the diagnostics, and the app code compiled in the fourth run, so the fix is confirmed.

`test.yml` on `af78713` (pull request):

- passed: production build, unit tests, ESLint, type check, data transfer engine (real database), API guard and permission tests, design checks, media E2E tests.
- **failed: visual regression.** It reports a 4.06% pixel diff on `docs/design/visual/accounting-expenses.png`. The same diff fails on `main` in runs `37919841516` and `37925908136`, so it predates this branch. Nothing under `docs/design` or the accounting UI changed here. The baseline is not re-recorded, per the repo rules. Because `required` depends on it, the PR will show red until `main` is fixed.

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
