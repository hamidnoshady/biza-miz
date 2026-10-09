# Android runtime (Trusted Web Activity)

The Android app is a shell. It opens the existing Biza Miz web platform in a Trusted Web
Activity (TWA), with no browser chrome, and adds a small set of native capabilities through a
versioned, allowlisted bridge. It does not contain a second copy of the platform UI, and it does
not hold a second business database. The web app stays the product, and the backend stays the
source of truth.

Status: this is the foundation slice of issue #884. The bridge, the link rules, the Gradle
build and the release workflows are implemented and unit-tested. Behaviour on a real device
(no browser chrome, App Links verification, native capabilities) has not been verified yet.
The plan and the open items are in [`ISSUE_884_PLAN.md`](../ISSUE_884_PLAN.md).

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
It points at `https://app.invalid`, so it can only show the offline or not-configured screen
until the development origin is changed. To test against a real host, pass
`-Pbiza.webOrigin.development=https://<host>`. The host must serve `assetlinks.json` for
App Links to verify.

## Testing

What runs today:

- **Web, Vitest** (`src/lib/native`, `src/components/native`): the contract validators, the
  capability resolver, the client (request IDs, timeouts, closed channels), the handshake
  (origin gate), the runtime store (detection, adoption, teardown), and drift guards. The drift
  guards fail if the TypeScript allowlists, the Gradle build, or the Digital Asset Links file
  disagree with the shared JSON.
- **Android, JVM unit tests** (`android/app/src/test`): link routing (`AppLinkRouter`), frame
  parsing and encoding (`BridgeProtocol`), command routing (`BridgeCommandRouter`), and the
  same contract checks from the Kotlin side (`BridgeContractTest`).

Not yet: instrumented tests on an emulator, live Digital Asset Links verification, a TWA run on
a device, and any test of the native capabilities themselves. These come with the features.

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

### Commands and events (version 1)

| Name | Kind | Result |
|---|---|---|
| `app.info` | command | `appVersionName`, `appVersionCode`, `environment`, `bridgeVersion`, `capabilities` |
| `notifications.status` | command | `permission`: `granted` or `denied` today. `not_determined` is in the contract for a later app that asks for the permission. |
| `bridge.ready` | event | same shape as `app.info` |

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

## Permissions

The manifest asks for `INTERNET` and `ACCESS_NETWORK_STATE`. It requests no runtime permission
yet. `POST_NOTIFICATIONS`, the camera, Bluetooth and call-screening roles are added with the
features that need them. `notifications.status` reports the system setting and does not request
anything.

The `<queries>` entries let the app find the Custom Tabs provider on Android 11 and later.

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
| `android-build.yml` | PR and push to `main`/`arena/**`, path-filtered | Web bridge tests; Gradle lint, JVM tests and a development debug APK, uploaded as `biza-miz-android-development-debug-NON-PRODUCTION`. No secrets are used. |
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

- Native features are gated by capability, not by app version, so the web app can ship before an
  Android release. Feature flags per capability are planned with the features and are not in this
  slice.
- Play's staged rollout is the release control for native changes.
- Rollback: a bad web deploy is rolled back in the web pipeline. A bad Android release is halted
  with the Play staged-rollout control, and a fixed build ships with a higher `versionCode`.
