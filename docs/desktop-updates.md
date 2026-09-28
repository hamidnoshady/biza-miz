# Desktop release and update lifecycle

Desktop update identity is **SemVer**. A Git commit and build ID are provenance and are never
compared to a version. Central's Docker SHA is exposed separately as Central runtime provenance.

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
Automatic checks default on; background download is configurable; unattended installation stays
off so an active POS is never silently stopped.

## Offline package

Distribute these two production-release assets together:

- `Business Suite Setup X.Y.Z.exe`
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

## Required production configuration

The `windows-production` GitHub environment must provide:

- `WINDOWS_EXPECTED_SIGNER`
- `DESKTOP_RELEASE_PUBLIC_KEY_PEM` (GitHub environment variable and Central environment variable)
- `DESKTOP_RELEASE_PRIVATE_KEY_PEM` (GitHub environment secret; never configured on a client or Central)
- `DESKTOP_RELEASE_REGISTRY_URL` (full Central endpoint URL,
  e.g. `https://…/api/desktop-releases/promote`)
- `DESKTOP_RELEASE_PUBLISH_TOKEN` (secret)

Generate a protected RSA key pair outside the repository. The candidate workflow embeds only the
public key, while the production workflow signs the canonical manifest with the private key and
checks that the pair matches. Central verifies signatures before registration in production and
Electron verifies them again before accepting online or offline packages. Rotate keys only through
a signed client release that embeds the next public key before manifests switch signers.

Central must hold the same token as `DESKTOP_RELEASE_PUBLISH_TOKEN`. Normal platform and tenant
sessions cannot use the pipeline endpoint. Installer URLs are product metadata; raw storage
credentials do not exist in the release model.
