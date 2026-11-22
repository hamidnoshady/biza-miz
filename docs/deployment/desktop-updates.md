# Desktop release and update lifecycle

Desktop update identity is **SemVer**. A Git commit and build ID are provenance and are never
compared to a version. Central's Docker SHA is exposed separately as Central runtime provenance.

> **Two release paths exist.** The default is certificate-free:
> `build-desktop-installer.yml` → `windows-release.yml` (see *Certificate-free release trust*
> below). Steps 1-3 in the flow below describe the optional Authenticode path.

## End-to-end flow

1. `windows-signed-candidate.yml` embeds `version`, `buildCommit`, `buildId` and `channel`, then
   builds and verifies the signed NSIS installer.
2. Existing Windows and physical acceptance workflows run against those exact bytes.
3. `windows-production-release.yml` promotes without rebuilding, creates `release-manifest.json`,
   publishes the installer and manifest as a GitHub Release, and registers the release in Central.
4. A pipeline-registered release starts with an **internal/zero-device rollout**. An owner advances
   it to pilot, percentage or full rollout in `/platform/updates`; pause and withdrawal are audited.
5. A paired site reports runtime facts to `POST /api/server-sync/runtime-status`. The bearer token
   resolves the device, business and location; the body cannot choose another device.
6. Central selects a target for that device's channel and deterministic rollout bucket. The local
   backend atomically hands that authenticated manifest to Electron's single update engine, so
   automatic checks continue when the settings page is closed.
7. The engine verifies the manifest's detached RSA-SHA256 signature with the public key embedded
   in the signed application, restricts download origins, supports retry/resume, verifies exact byte
   size and SHA-256, and checks Authenticode plus the expected Windows publisher.
8. Before executable replacement, Electron blocks while any shift or open/held order remains,
   then creates a custom-format PostgreSQL backup and proves
   it is readable with `pg_restore --list`. A failed backup blocks installation.
9. Electron gracefully stops the local web backend and PostgreSQL, launches NSIS, and exits.
10. On the next launch, PostgreSQL and the web backend must pass health checks and
    `app.getVersion()` must equal the target before the update is marked successful.

Manual download, background download, install-now, install-on-next-restart, and offline packages
all use `electron/update-engine.js`. There is no second manual installer path hidden in the UI.
«بررسی دوباره» in Settings is an explicit exchange, not a re-read of the cached target: the local
backend re-runs the same authenticated runtime-status request immediately
(`POST /api/desktop-update/check`, outside the sync interval) and only then hands the returned
manifest to the engine (issue #1008). If Central cannot be reached the screen keeps the persistent
«برای بررسی به‌روزرسانی به اینترنت وصل شوید» hint and does not run a manifest-less check that
could only answer «no update».
Automatic checks default on; background download is configurable; unattended installation stays
**off unless a Superadmin policy turns it on** for that business, location or device (see below), so
an active POS is never silently stopped.

Operators publishing a release: [desktop-updates-coolify.md](desktop-updates-coolify.md)
(Coolify and GitHub setup, verification, rotation, incident response).

## Central update policy

Migration 0227 adds a versioned policy that Central resolves **per device** before it returns
anything. Precedence is **platform defaults → business → location → device**; a layer stores only
the keys it explicitly overrides, so the console can show inherited versus overridden values. The
resolved policy is previewed in `/platform/updates` (device → «سیاست به‌روزرسانی») and every change
needs a reason and is written to the platform audit log with its before and after.

| Key | Meaning |
|---|---|
| `automaticChecks`, `backgroundDownload` | Whether the engine checks and pre-downloads without a click. |
| `automaticInstall` | `off` (default) or `safe_window`. The only way an installer runs unattended. |
| `channel` | Channel this scope follows; `null` keeps what the install itself reports. |
| `targetReleaseId` | Approve one **published** release for this scope (a canary), including one still at internal / 0 %. A draft, paused, withdrawn or other-channel release is withheld, never substituted. |
| `hold` | Emergency hold: no target, and no unattended install. |
| `maintenance`, `deferUntil`, `deadlineAt`, `allowCriticalOverride` | When an unattended install may start. After `deadlineAt`, and only if `allowCriticalOverride` is set, the window and the deferral are waived. |
| `minimumBatteryPercent` | Blocks an unattended install on battery below this charge (unknown charge counts as low). |
| `meteredNetworkDownload` | Stored and delivered, **not enforced yet**: Electron has no metered-connection API. |

A policy cannot carry an installer URL, an origin, a downgrade, or any switch for signature,
SHA-256, publisher or backup verification. Those are not policy fields, and unknown keys are
refused on write.

The policy reaches the device through the same authenticated exchange as the target
(`POST /api/server-sync/runtime-status`; the bearer credential names the device, never the body).
The local backend writes it to `Configuration/update-policy.json` for the engine, only for its own
business. The document carries `policyVersion` (drawn from one global sequence, so it only
grows), `issuedAt`, `expiresAt` (seven days), the device and business identity and an audit
reference. The engine validates every field, refuses an older version (rollback) and applies the
values over local preferences while the document is unexpired.

**Delivery is tracked in three steps.** *Requested* is the policy write, *delivered* is Central
having sent that version, *acknowledged* is the device reporting it applied that version. An offline
device stays "requested" or "delivered"; it is never shown as acknowledged.

### Unattended install (`automaticInstall: safe_window`)

All of these must agree, every time; any doubt means "not now":

1. An unexpired central policy with `safe_window`, no `hold`, inside the maintenance window (or
   past the deadline with the override set). The window is read in its own timezone and a window that
   crosses midnight belongs to the day it starts on.
2. The engine is `ready_to_install`: the installer was downloaded and passed size, SHA-256 and
   Authenticode/publisher checks.
3. Safety facts read from the local database say **no open shift, no open or held order, no print
   job in flight (last ten minutes)**, and at least 2 GiB free. A fact that cannot be read is a block.
4. A five-minute announced grace period passes with the facts still true. The state exposes the
   scheduled time; a user can postpone (at most 24 hours; the critical override ignores this).
5. The same path as **Install now** runs: a fresh pre-update backup that must verify with
   `pg_restore --list`, graceful shutdown, installer, and the post-boot version and health check. Only
   one install can run at a time.

The critical deadline waives the window and the deferral, **never** these data-safety checks. A
device that is offline past the deadline simply stays on its version and is shown as such. An
expired cached policy (offline for more than seven days) cannot start an unattended install; manual
and offline-package installs are unaffected.

Known gaps tracked on issue #981: unsynced Hybrid events are not yet a gate (they live in the
local database that the update preserves and backs up), and support-session and maintenance-task
gates still need integration with their respective lifecycle owners.

### Durable device requests

Superadmin can enqueue only the verbs the current backend supports: **recheck** and
**download now**. A request is tenant/device bound, monotonic, idempotent and expirable. Central
reports `queued`, `delivered`, `acknowledged`, `executed`, `verified`, `failed` and `expired`
separately; in particular, an offline device remains queued and an HTTP success never means the
Desktop upgraded. The device pulls one command over the same authenticated device channel used
for policy, rejects an expired, replayed or foreign command, and executes it through the existing
signed target/download engine. Commands cannot contain an installer URL or disable signature,
hash, publisher, anti-downgrade or backup checks. Installation/restart commands are deliberately
not exposed until the remaining local safety integrations and Windows E2E gate are complete.

## Offline package

Distribute these two production-release assets together:

- `Bizamiz Setup X.Y.Z.exe`
- `release-manifest.json`

In **Settings → Desktop and updates**, choose **Offline package**, then select both files. The same
SemVer, size, SHA-256, Authenticode, publisher and backup gates run without Internet access.
An older package is rejected unless a future explicit, separately authorized recovery flow is used.

## Recovery

The engine persists update state under `Configuration/update-state.json`, installers under
`Data/Updates`, and verified pre-update dumps under `Backup/pre-update`. On a failed first launch or
version mismatch it enters `recovery_required` and keeps the backup and release recovery metadata.

Binary rollback and database rollback are intentionally separate:

- Never downgrade the database automatically.
- Preserve the known-good installer metadata and pre-update dump.
- Diagnose whether the failure is binary startup, PostgreSQL health, migration compatibility, or
  target-version mismatch.
- Restore a database only through the existing verified restore workflow and only after confirming
  schema compatibility.

The platform fleet view uses server-received report time. Reports older than 10 minutes are stale;
reports older than 60 minutes are offline. Unknown, stale, offline, invalid or incompatible devices
are never shown as compliant green.

## Certificate-free release trust (manifest schema 2)

The default release path no longer needs a paid Windows Authenticode certificate. Trust is:

1. a **detached signature over a deterministic manifest** (Ed25519 preferred, RSA-SHA256 kept for
   legacy schema 1 manifests);
2. a **public keyring embedded in `app.asar`** (`electron/desktop-release-keys.json`), never chosen
   by a server or supplied by the manifest;
3. the exact installer **SHA-256 and byte size** from that signed manifest;
4. the existing HTTPS-origin, staging, backup and post-boot health checks.

Authenticode is optional defense-in-depth (`installer.signatureRequired`). When a manifest asks for
it, the exact publisher and certificate thumbprint are still enforced. A manifest can never disable
its own signature, the SHA-256 check, the origin check, the backup or the release-sequence rules.

### Manifest schema 2

```json
{
  "schemaVersion": 2,
  "appId": "bizamiz-desktop",
  "version": "1.0.221",
  "releaseSequence": 1000221,
  "buildCommit": "<40-hex>",
  "buildId": "build-run-...",
  "channel": "stable",
  "platform": "win32",
  "architecture": "x64",
  "releasedAt": "...",
  "expiresAt": "...",
  "minimumSupportedVersion": "1.0.218",
  "mandatory": false,
  "installer": { "url": "https://github.com/...", "sha256": "<64-hex>", "size": 123, "signatureRequired": false },
  "database": { "migrationVersion": 311, "minimumSchemaVersion": 1, "maximumSchemaVersion": 311, "backupRequired": true },
  "releaseNotes": ["..."],
  "recovery": { "knownGoodVersion": null, "notes": "..." },
  "signatureAlgorithm": "ed25519",
  "signingKeyId": "sha256:<SPKI SHA-256>",
  "manifestSignature": "<base64>"
}
```

### Timestamp precision (load-bearing)

`releasedAt` and `expiresAt` are part of the canonical payload and are compared
as **strings**, not instants. Central stores them as `timestamptz` and the
Desktop canonicalizes whatever it is handed, so both must be the exact ISO
millisecond form (`2026-11-22T07:26:49.714Z`).

`scripts/sign-desktop-release-manifest.mjs` pins them before signing. Without
that, PowerShell's `[DateTime]::ToString('o')` (seven fractional digits) yields a
manifest that verifies as published and fails after the database round trip:
registration answers `invalid_manifest_signature`, and an installed app rejects
the manifest Central serves. Such a release cannot be repaired without
re-signing — publish a new version instead.

Every field except `manifestSignature` is canonicalised and signed. Schema 1 remains byte-for-byte
compatible for already signed RSA manifests.

### Verification flow

1. The engine validates the manifest shape, version, channel, app id, platform/architecture and
   `minimumSupportedVersion`.
2. It resolves `signingKeyId` in the embedded keyring, rejects unknown/revoked/inactive keys,
   then verifies the signature over the canonical payload.
3. It rejects a `releaseSequence` at or below the last successfully applied sequence for that
   channel, a downgrade, an expiry outside the freshness policy and an installer origin outside the
   allow-list.
4. It downloads, checks exact size and SHA-256, stages the file, and repeats the size, SHA-256 and
   signature checks against the staged bytes immediately before execution (TOCTOU protection).
5. It quiesces the backend, creates and verifies a PostgreSQL backup, installs, and only marks the
   release successful after the new version boots and passes health checks.

### Anti-rollback, freshness and offline

`releaseSequence` is the primary replay/rollback defence: a successful post-update boot records the
channel's applied sequence, and a manifest at or below it is refused. Freshness uses `expiresAt`
with a 24-hour clock-skew grace. If the local clock is before `releasedAt`, expiry is not treated as
proof of staleness, so an offline device with a wrong clock keeps working; the signature and
sequence still apply. Offline packages should carry a long expiry (for example 180 days). A local
clock alone can never authorise an older sequence.

### Required production configuration

The `windows-production` GitHub environment must provide:

- `DESKTOP_RELEASE_ED25519_PRIVATE_KEY_PEM` (secret; never on a client or Central)
- `DESKTOP_RELEASE_ED25519_PUBLIC_KEY_PEM` (variable, also configured on Central)
- `DESKTOP_RELEASE_PUBLIC_KEYS_JSON` (repository variable; the keyring embedded in the build)
- `DESKTOP_RELEASE_REGISTRY_URL` (full Central endpoint, e.g. `https://.../api/desktop-releases/promote`)
- `DESKTOP_RELEASE_PUBLISH_TOKEN` (secret; the same value on Central)

Keep `DESKTOP_RELEASE_PUBLIC_KEY_PEM` and `DESKTOP_RELEASE_PRIVATE_KEY_PEM` while any schema 1
client remains. They are not used by the certificate-free workflow. The optional Authenticode path
additionally uses `WINDOWS_SIGNING_PROVIDER`, `WINDOWS_EXPECTED_SIGNER` and
`WINDOWS_EXPECTED_SIGNER_THUMBPRINT`.

Central must hold `DESKTOP_RELEASE_ED25519_PUBLIC_KEY_PEM` (or the same keyring) to verify a
registered manifest, and the same `DESKTOP_RELEASE_PUBLISH_TOKEN`. Normal platform and tenant
sessions cannot use the pipeline endpoint. Installer URLs are product metadata; raw storage
credentials do not exist in the release model.

### Publishing a certificate-free release

1. Let `build-desktop-installer.yml` build and accept the version on `main`; it records
   `desktop-vX.Y.Z` and uploads `business-suite-desktop-installer-X.Y.Z`.
2. Run `windows-release.yml` with that run id, version, channel, `minimum_supported_version`,
   `migration_version`, release note and `release_sequence`. It reuses the accepted bytes, generates
   and signs the schema 2 manifest, publishes the GitHub Release, verifies the published bytes and
   registers Central as `published / internal / 0%`.
3. Promote the release for the intended scope in `/platform/updates`. A registered release reaches
   no device before that promotion.

`windows-production-release.yml` remains available for an optional Authenticode-signed release. Do
not run both workflows for the same version.

### Key rotation and revocation

1. Add the next public key to `DESKTOP_RELEASE_PUBLIC_KEYS_JSON` and ship a client release that
   embeds it **before** signing anything with the new key.
2. Sign new manifests with the new `signingKeyId`; keep the previous key in the ring for clients
   that have not updated yet.
3. Mark a compromised key `revoked: true` in a new shipped keyring and stop signing with it. A
   revoked key is refused even if an old manifest is replayed.
4. Never accept a replacement key from a manifest, Central, or an environment variable in a
   packaged build. `DESKTOP_ALLOW_RELEASE_KEY_OVERRIDE` is a test/migration-only escape hatch and
   must not be set on production devices.

### Migrating 1.0.218 and 1.0.220

Those builds shipped the placeholder key (and older code that only understands required
Authenticode). They cannot verify a schema 2 manifest, so the first schema 2 build needs **one
manual install**:

1. Back up the business database through Settings → Backups.
2. Install the schema 2 installer from its GitHub Release (Unknown Publisher/SmartScreen may appear
   because it is not Authenticode-signed).
3. Start Bizamiz, confirm the version and that the local database/device identity is intact.
4. Future releases arrive through the normal in-app updater.

The temporary `DESKTOP_RELEASE_PUBLIC_KEY_PEM` user environment variable used during diagnosis is
not a production trust mechanism. Remove it after the manual upgrade. A packaged build ignores
environment trust overrides unless `DESKTOP_ALLOW_RELEASE_KEY_OVERRIDE=1`.

Manifest signing authenticates an update to Bizamiz's updater; it does not create Windows publisher
identity. Running an installer manually outside Bizamiz can still show Unknown Publisher,
SmartScreen or UAC warnings.
