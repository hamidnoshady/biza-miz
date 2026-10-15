# Android runtime (Trusted Web Activity)

The Android app is a shell. It opens the existing Biza Miz web platform in a Trusted Web
Activity (TWA), with no browser chrome, and adds a small set of native capabilities through a
versioned, allowlisted bridge. It does not contain a second copy of the platform UI, and it does
not hold a second business database. The web app stays the product, and the backend stays the
source of truth.

Status: Bridge v3 (`config/native-bridge-contract.json`), the Android TWA shell (`android/`), all 8
native capability modules, server-side `native_app_devices` registration/revocation/FCM fan-out,
and mobile UX integration are implemented and verified in automated unit and database integration
tests. Live Digital Asset Links verification (`sha256_cert_fingerprints` from Google Play App
Signing), signed staging/production release builds (`android-staging` / `android-production`
environment secrets), live Firebase Cloud Messaging credentials (`FIREBASE_*`), and physical
printer/telephony hardware validation remain gated on external prerequisites. The plan and the
28-criterion evidence matrix are in [`ISSUE_884_PLAN.md`](../ISSUE_884_PLAN.md).

## Where things live

| Path | What it is |
|---|---|
| `android/` | Gradle project: one app module, `:app`, package `com.bizamiz.android` |
| `config/android-environments.json` | Application IDs and web origins per environment. Read by Gradle and by the web tests. |
| `config/native-bridge-contract.json` | Bridge version, commands, events, error codes, capabilities. Read by Gradle, the web code, and the Android tests. |
| `public/.well-known/assetlinks.json` | Digital Asset Links statements for the three application IDs |
| `src/lib/native/` | Web side of the bridge: contract types, capability resolver, client, handshake, runtime store |
| `src/components/native/` | `NativeProvider` (mounted in the root layout), `NativeCapabilityGate`, `useNative()` |
| `.github/workflows/android-*.yml` | Build, staging candidate, production release (see [CI](#ci-and-release)) |

The Android app and the web app have independent version numbers. `android/gradle.properties`
holds `bizaVersionName` and `bizaVersionCode`, and `package.json` is not involved.

## Environments

| Environment | Application ID | Web origin | Notes |
|---|---|---|---|
| development | `com.bizamiz.app.dev` | `https://app.invalid` (placeholder) | Used by PR builds. The artifact is labelled NON-PRODUCTION. |
| staging | `com.bizamiz.app.staging` | from `BIZA_ANDROID_WEB_ORIGIN_STAGING` | Installs beside production |
| production | `com.bizamiz.app` | from `BIZA_ANDROID_WEB_ORIGIN_PRODUCTION` | The Play listing's package |

Staging and production have no committed origin on purpose. A release task fails before it
compiles anything if its origin is missing or is not a bare `https://host`. The origin can be
set in three ways, in this order: the environment variable, a Gradle property
(`-Pbiza.webOrigin.staging=https://…`), or the committed value in the config file. Only
development has a committed value.

The host of each environment's origin needs its own `/.well-known/assetlinks.json`. The file
under `public/` is served by every host, so the statements are the same on all of them.

## Local development

Web side (no JDK needed):

```bash
npx vitest run src/lib/native src/components/native
npm test
```

Android side (JDK 17, Android SDK with platform 36 and build-tools 36.0.0):

```bash
cd android
./gradlew :app:testDevelopmentDebugUnitTest
./gradlew :app:lintDevelopmentDebug :app:assembleDevelopmentDebug
```

The debug APK is `android/app/build/outputs/apk/development/debug/app-development-debug.apk`.
It points at `https://app.invalid`, which does not resolve. The TWA opens and Chrome shows its
own error page, so the APK is useful for checking the shell, not the web app. To test against a
real host, pass `-Pbiza.webOrigin.development=https://<host>`. The host must serve
`assetlinks.json` for App Links to verify.

## Testing

What runs today:

- **Web, Vitest** (`src/lib/native`, `src/components/native`, `src/components/mobile`, `src/app/dashboard/data-table.test.tsx`):
  the contract validators, the capability resolver, the client (request IDs, timeouts, closed
  channels), the handshake (origin gate), the runtime store (detection, adoption, teardown),
  the v3 capability helpers (`capabilities-client.test.ts` including route-level verification
  against `POST /api/crm/activities` and Kotlin `crm.callEnded` JSON frames), the Android
  printing bridge (`android-printing-bridge.test.ts`), the device registrar and tenant-safe
  deep-link router (`native-device-registrar.test.tsx`), mobile sheets (`mobile-components.test.tsx`),
  and drift guards (`native-config.test.ts`). The drift guards fail if the TypeScript allowlists,
  the Gradle build, or the Digital Asset Links file disagree with the shared JSON.
- **PostgreSQL integration tests** (`integration/native-device-registry.integration.test.ts`,
  `integration/native-device-registration-route.integration.test.ts`,
  `integration/notifications.integration.test.ts`): registration, revocation, reactivation,
  `session_generation` enforcement, sign-out auth/push/caller-ID state clearing, cross-tenant RLS
  isolation, and native FCM device fan-out (`deliverEvent`).
- **Android, JVM unit tests** (`android/app/src/test`): link routing (`AppLinkRouterTest`), frame
  parsing and encoding (`BridgeProtocolTest`), command routing (`BridgeCommandRouterTest`),
  encrypted caller-ID cache and phone normalization (`CallerIdCacheTest`), background sync state
  and retry backoff (`TenantSyncStateStoreTest`), native capability gateways (`AndroidNativeCapabilitiesTest`),
  and contract parity (`BridgeContractTest`).

External environment and hardware checks (not executable in headless CI): live Digital Asset Links
verification against Play App Signing keys, signed staging/production release builds, live FCM push
delivery with external Firebase credentials, and physical thermal printer / `CallScreeningService`
hardware validation.

## Bridge contract

### Transport

The page and the app talk over the post-message channel that Chrome opens inside a TWA
(Chrome 115 or later; the app uses `androidx.browser` 1.10.0):

1. The app binds `CustomTabsService` and starts the TWA with a session.
2. After `NAVIGATION_FINISHED`, the app calls `requestPostMessageChannel(origin, origin)`, where
   `origin` is the web origin.
3. Chrome posts one `message` to the page carrying a `MessagePort` in `event.ports[0]`.
   The page accepts it only when `event.origin` equals `location.origin`.
4. The app sends `bridge.ready`. The page can also ask with `app.info`.

Every frame is a JSON string. The app's `postMessage` takes strings only, so the page encodes
and decodes each frame.

### Envelopes

```text
request:  { v, kind: "request",  id, command, payload }
response: { v, kind: "response", id, ok, result | error: { code, message? } }
event:    { v, kind: "event",    name, payload }
```

`id` is 1 to 64 characters from `[A-Za-z0-9-]`. `v` is the protocol version (`bridgeVersion`).
A frame with a different `v` is ignored, so the request that is waiting for it times out.

### Commands and events (version 3)

| Name | Kind | Min bridge | Result / Payload |
|---|---|---|---|
| `app.info` | command | 1 | `appVersionName`, `appVersionCode`, `environment`, `bridgeVersion`, `capabilities` |
| `notifications.status` | command | 1 | `permission`: `granted`, `denied`, or `not_determined` |
| `device.identity` | command | 2 | `installationId` — the app's own persistent installation UUID (`InstallationId.kt`), used by the [device registry](#device-registry) |
| `notifications.register` | command | 3 | `permission`, `fcmToken` (`null` when unconfigured), `pushProvider` (`"fcm"` or `"none"`), `channels` |
| `biometric.status` | command | 3 | `available`, `enrolled`, `biometricStrength` |
| `biometric.authenticate` | command | 3 | `authenticated`, `verifiedAt`, `method` |
| `scanner.scan` | command | 3 | `rawValue`, `format`, `symbology`, `scannedAt` |
| `media.pick` | command | 3 | `files`: array of `{ name, mimeType, sizeBytes, base64Data }` |
| `share.open` | command | 3 | `shared`, `target` |
| `printer.discover` | command | 3 | `printers`: array of `{ id, name, transport, address, paired }` |
| `printer.print` | command | 3 | `printed`, `transport`, `bytesWritten`, `jobId` |
| `crm.callerId.status` | command | 3 | `roleHeld`, `permission`, `cachedEntries`, `lastSyncedAt` |
| `crm.callerId.sync` | command | 3 | `roleHeld`, `syncedCount`, `businessId`, optional `matchedCaller` |
| `sync.status` | command | 3 | `pendingCount`, `lastSyncedAt`, `networkAvailable`, `scheduled` |
| `sync.trigger` | command | 3 | `pendingCount`, `lastSyncedAt`, `networkAvailable`, `scheduled` |
| `bridge.ready` | event | 1 | same shape as `app.info` |
| `navigation.deepLink` | event | 3 | `path`, `notificationCategory`, `businessId` |
| `crm.callEnded` | event | 3 | `phoneNormalized`, `direction` (`"incoming"` \| `"outgoing"`), `durationSeconds`, `customerId`, `customerName`, `endedAt` |
| `sync.completed` | event | 3 | `businessId`, `syncedAt`, `revoked`, `flushedCount` |

There is no generic executor. A command that is not in the allowlist gets `unknown_command`,
and nothing runs. The allowlists are the `commands` and `events` keys in the contract file.
The web side and the Kotlin side each keep a typed copy, and the drift tests compare them.

### Versions and capabilities

- The page never sends a command the app's `bridgeVersion` cannot handle. Each command has a
  `minBridgeVersion` in the contract.
- Each capability has a `nativeMinBridgeVersion`. The resolver reports it as native only when
  the app lists it and is new enough.
- If the capability is missing and the installed app is older than that version,
  `updateRequired` is true. The UI then shows «update the app», not «not supported».
- Capability keys that the page does not know are dropped, so a newer app cannot break an older
  page.
- An unknown error code becomes `native_failure`. An unknown event name is ignored.

Changing the contract: edit `config/native-bridge-contract.json`, then the matching arrays in
`src/lib/native/bridge-contract.ts` and `BridgeProtocol.kt`. Raise `bridgeVersion` only for a new
command, a changed shape, or a changed meaning. Never rename a field in place. The drift tests
fail until all three agree.

## Security model

- The app is opened only at its configured origin. Any App Link to another host, to plain
  http, to a non-standard port, or with userinfo falls back to the home page.
- The page accepts a channel only from its own origin and only when a port is attached. The
  page ignores every other message.
- Native permissions are not platform authorization. Every native action, including any future
  one that touches Biza Miz data, must still pass the server's role and permission checks.
- Cellular call recording is not treated as an Android capability. Accessibility-based
  recording is not used.
- Signing material never enters the repository. See [Secrets](#secrets-and-signing).

## Permissions and Native Capabilities (Bridge v3)

`config/native-bridge-contract.json` (`bridgeVersion: 3`, `minCompatibleBridgeVersion: 1`) defines
the allowlisted commands, events, and capabilities shared between `src/lib/native/bridge-contract.ts`
and `android/app/src/main/java/com/bizamiz/android/bridge/BridgeProtocol.kt` (guarded against drift
by `src/lib/native/native-config.test.ts` and `BridgeContractTest.kt`):

- **Commands (15)**: `app.info`, `notifications.status`, `device.identity`, `notifications.register`,
  `biometric.status`, `biometric.authenticate`, `scanner.scan`, `media.pick`, `share.open`,
  `printer.discover`, `printer.print`, `crm.callerId.status`, `crm.callerId.sync`, `sync.status`,
  `sync.trigger`.
- **Events (4)**: `bridge.ready`, `navigation.deepLink`, `crm.callEnded`, `sync.completed`.
- **Capabilities (8)**: `notifications` (v1), `barcode.scan` (v3), `printer` (v3),
  `crm.caller-id` (v3), `biometric` (v3), `share` (v3), `media.capture` (v3),
  `background.sync` (v3).

### Native capability modules

1. **Encrypted Caller ID Cache (`EncryptedKeyValueStore.kt` + `CallerIdCache.kt`)**:
   - Customer caller-ID entries are encrypted at rest with AES-256-GCM (`AES/GCM/NoPadding`, 96-bit
     random IV, 128-bit authentication tag) using an Android Keystore key
     (`biza_caller_id_aes_gcm_v1`), with the storage key bound as GCM Additional Authenticated Data
     (AAD) so ciphertext cannot be substituted across keys or tenants.
   - Cache entries are strictly partitioned by `businessId`, purged on tenant switch (`clearTenant`),
     sign-out (`clearAll`, which also deletes/rotates the wrapping key for cryptographic erasure),
     loss of `ROLE_CALL_SCREENING` (`reconcileRoleState(false)`), or device revocation, and protected
     by a crash-recovery marker (`__pending_wipe__`) across process death.
   - **Offline erasure limitation**: If an administrator revokes a device while that device has no
     network connectivity, server-side sessions and push/sync fan-out are blocked immediately, and
     local `CallerIdCache` / `WorkManager` state is wiped on the device's next network contact
     (`/api/health`, `/api/auth/me`, `/api/native-devices`). While completely air-gapped offline,
     instant remote wipe cannot reach the device; cached caller metadata remains encrypted at rest
     under Android Keystore AES-256-GCM until the device reconnects, signs out locally, switches
     tenant, or loses `ROLE_CALL_SCREENING`.
2. **Incoming Call Identification vs. Post-Call Follow-Up (`BizaCallScreeningService.kt` + `CallLifecycleTracker.kt`)**:
   - `BizaCallScreeningService.onScreenCall` only identifies the caller in the active business's
     encrypted `CallerIdCache`, posts a heads-up Caller ID notification, and records the screened
     call in `CallLifecycleTracker`. It never blocks/silences calls, never records call audio, and
     never emits `crm.callEnded` during screening.
   - `CallLifecycleTracker` observes `CALL_STATE_OFFHOOK` and `CALL_STATE_IDLE` and emits
     `crm.callEnded` (`{ phoneNormalized, direction, durationSeconds, customerId, customerName, endedAt }`)
     only when the call disconnects, using the measured off-hook duration (or `0` if unanswered).
3. **Background Sync (`NativeSyncScheduler.kt` + `BizaSyncWorker.kt` + `TenantSyncStateStore.kt`)**:
   - Uses `androidx.work:work-runtime-ktx` (`WorkManagerSyncScheduler` + `BizaSyncWorker`) with
     `NetworkType.CONNECTED` constraints and exponential backoff (`MAX_RETRY_ATTEMPTS = 5`).
   - Android does not maintain a second business database; when `BizaSyncWorker` verifies origin
     connectivity, it stamps `lastSyncedAt` and emits `sync.completed` to trigger `flushQueue()` on
     the web app's IndexedDB `pendingActions` queue (`POST /api/sync/events`).
4. **Firebase Cloud Messaging (`BizaFirebaseMessagingService.kt` + `NotificationChannelManager.kt`)**:
   - Integrates `com.google.firebase:firebase-messaging` directly (no reflection) with auto-init
     disabled until explicit user opt-in and credential verification (`BuildConfig.FIREBASE_*`).
   - When external Firebase project credentials are not supplied in the build/server environment,
     `NotificationChannelManager.resolvePushToken` explicitly returns `null` (`pushProvider: "none"`)
     without simulating success. When configured, `src/lib/notifications-service.ts` (`deliverEvent`)
     fans out notification outbox events to active FCM `native_app_devices` alongside Web Push.
5. **Tenant-Safe Deep Links (`NativeDeviceRegistrar.tsx`)**:
   - Resolves the authoritative active business from `WorkspaceShell` and `GET /api/auth/me` before
     routing any `navigation.deepLink` event. Mismatched target tenants are authorized via
     `POST /api/auth/switch-business` (wiping the previous tenant's local native caches first) or
     blocked when unauthorized; missing or revoked sessions fail closed.

## Device registry

Every Android installation that signs in registers itself, so an owner can see and revoke a
lost or stolen phone. Owner decisions (ISSUE_884_PLAN.md):

1. **Who may see/revoke a device.** A plain member sees and revokes only their own installation
   (`GET`/`DELETE /api/native-devices/self*`, `requireMember`, scoped to `session.sub`). An
   owner, or a member explicitly granted `native_devices.manage`, sees and revokes every
   installation in the business (`/api/native-devices*`). Every revocation is audited
   (`audit_log`, entity `native_device`).
2. **How registration happens.** `TwaLauncherActivity`'s `InstallationId` generates a UUID once,
   on first launch, and keeps it in app-private storage. Once the bridge connects inside an
   authenticated page, `NativeDeviceRegistrar` (mounted in `WorkspaceShell`, so a session and a
   business are already known) asks for it with the `device.identity` command and calls
   `POST /api/native-devices`. The server derives the user and tenant from the session, never
   from the request body. Registration is an idempotent upsert keyed on
   `(business_id, install_id)` — repeat logins and reconnects never create a second row — but it
   never revives a revoked row: that fails with `device_revoked` until an owner/admin calls
   `POST /api/native-devices/[id]/reactivate`.
3. **What revocation does.** `native_app_devices.revoked_at` is checked live, on every request,
   by `checkNativeDevice` in `src/lib/auth.ts` — the same shape `checkEmployeeSession` already
   has for PIN logins. A session bound to a revoked device (`SessionPayload.nativeDeviceId`,
   set when registration succeeds) stops resolving immediately: the next request is treated as
   unauthenticated, which denies business API calls, sync and any privileged native operation
   from that installation without needing per-route code. **This cannot reach an installation
   that is offline at the moment of revocation** — enforcement is "the next request this
   installation makes is refused", not a push to the device — and it does not erase whatever the
   installation already has cached locally; the existing PWA offline layer governs that, the
   same as for the web app. Reactivation requires the explicit owner/admin action above, and
   restores nothing by itself: the member must sign in again and the app must register again,
   because the session the installation was using was already invalidated when it was revoked.

`native_app_devices` is its own table, not `pos_devices` (the till/biometric-terminal registry):
a POS device token narrows an unauthenticated login picker, where this is a record of an
already-authenticated member's own installation. See migration `0216_native_app_devices.sql`
for the full rationale.

## Offline and failure

| Situation | What the user sees |
|---|---|
| No network when the app opens | Offline screen (Persian) with a retry button |
| No browser that supports TWAs | «browser not found» screen with a retry button |
| Build without a web origin | «not configured» screen, no retry |
| Network drops after the TWA opens | The web app's own offline behaviour: the service worker and `public/offline.html` |

Business data is not stored on the device. The offline layer is the existing PWA one.

## CI and release

| Workflow | Trigger | What it does |
|---|---|---|
| `android-build.yml` | PR and push to `main`/`arena/**`, path-filtered | Web bridge tests; Gradle lint, JVM tests and a development debug APK, uploaded as `biza-miz-android-development-debug-NON-PRODUCTION`. It also checks that a staging release is refused without an origin and signing. No secrets are used. |
| `android-signed-candidate.yml` | manual, `main` only | Signed staging APK and AAB, with the `android-staging` environment. Uploads an artifact and does not publish. |
| `android-production-release.yml` | manual, `main` only | Signed production AAB and APK, tag `android-v<version>`, and a Google Play upload to the chosen track when Play is configured. Uses the `android-production` environment. |

### Secrets

Set these in the `android-staging` and `android-production` environments. They are not
repository-wide.

| Name | Kind | Purpose |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | secret | Upload keystore, base64-encoded. Decoded to the runner's temporary directory and removed at the end of the job. |
| `ANDROID_KEYSTORE_PASSWORD` | secret | Keystore password |
| `ANDROID_KEY_ALIAS` | secret | Key alias |
| `ANDROID_KEY_PASSWORD` | secret | Key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | secret | Play Developer API credentials. Optional: without it the release job skips the upload. |
| `ANDROID_WEB_ORIGIN_STAGING` | variable | Staging web origin, `https://host` |
| `ANDROID_WEB_ORIGIN_PRODUCTION` | variable | Production web origin, `https://host` |

PR workflows never reference these names, so a fork's PR cannot reach them.

### Versions and tags

- `bizaVersionName` is `X.Y.Z`. `bizaVersionCode` is a positive integer that must increase on
  every Play upload. Both come in as workflow inputs and are passed with `-P`.
- The release tag is `android-v<versionName>`. The workflow refuses to run if the tag exists.
- Web and Android releases are separate. A web deploy does not need an Android release, and an
  Android release does not need a web deploy, because the bridge keeps older apps safe.

### Google Play

1. Create the app in Play Console with the application ID `com.bizamiz.app`, and enrol in Play
   App Signing. Google then holds the signing key used for distribution.
2. Add that key's SHA-256 to the production statement in `public/.well-known/assetlinks.json`.
   Until it is there, App Links do not verify and the TWA does not get the origin.
3. Create a service account with release permissions and store its JSON as
   `PLAY_SERVICE_ACCOUNT_JSON`.
4. Upload goes to the `internal` track first. Promote by hand in Play Console, or with a later
   workflow. Use a staged rollout for native changes.

The target API level is 36, which is what this build uses. Google Play requires new apps and
updates to target API 36 from 31 August 2026.

## Digital Asset Links

`public/.well-known/assetlinks.json` declares `delegate_permission/common.handle_all_urls` and
`delegate_permission/common.use_as_origin` for each application ID. The `sha256_cert_fingerprints`
lists are empty in this slice, so:

- Android does not verify the App Links, and taps on them show the app chooser.
- Chrome does not give the TWA its origin, so the TWA falls back to a Custom Tab. The bridge
  never connects, and the page stays in web mode.

Both are the intended fail-closed behaviour until the signing fingerprints are added. Add a
fingerprint only from the real signing key:

```bash
keytool -list -v -keystore <upload.jks> -alias <alias>   # SHA256 line
```

Or copy the App Signing key's certificate fingerprint from Play Console.

Multi-tenant note: the TWA opens one configured origin. A tenant on its own subdomain is a
different origin, and it would need its own statement and its own TWA build. That is not part of
this slice.

## Rollout

- Native features are gated by capability (`NativeCapabilityGate` + `resolveCapability`) and by
  server-side `feature_flags` seeded in `migrations/0222_native_app_capabilities.sql`
  (`android_caller_id`, `android_native_print`, `android_document_scanner`, `android_biometric`,
  and `android_voip` defaulting to disabled), so the web app can ship before an Android release
  without breaking older v1/v2 clients.
- Play's staged rollout is the release control for native changes.
- Rollback: a bad web deploy is rolled back in the web pipeline. A bad Android release is halted
  with the Play staged-rollout control, and a fixed build ships with a higher `versionCode`.
