# Desktop updates: Coolify and GitHub operator guide

This is the operator runbook for publishing a signed Desktop release through the
**existing Bizamiz Central deployment in Coolify** and the GitHub release pipeline.
It adds no second updater and no second server. For what the Desktop does with a
release once Central offers it, read [desktop-updates.md](desktop-updates.md).

> Everything below uses placeholders. Do not paste real tokens, keys or hostnames into
> this file, an issue, a pull request or a chat. Steps that name Coolify screens were
> written from the Coolify documentation, not from a live panel: labels move between
> Coolify versions, so confirm each against the linked page. Nothing here records
> whether any production secret is configured today. Use the readiness check in step 5
> to find out.

## 1. Which pipeline does what

| Workflow | What it does | What it must never do |
|---|---|---|
| `publish.yml` | Push to `main` builds the Docker image and pushes only `sha-<short>` to GHCR (production unchanged). A manual `workflow_dispatch` with `sha=<tested commit>` re-tags that existing image as `latest`, asks Coolify to redeploy **Central (API and web)**, then verifies the live image SHA. | Publish or change a Desktop release. Use any `DESKTOP_RELEASE_*` value. |
| `windows-signed-candidate.yml`, the acceptance workflows, `windows-production-release.yml` | Build, sign and verify the Windows installer. The production workflow publishes `Bizamiz Setup X.Y.Z.exe` and `release-manifest.json` to a GitHub Release and registers the release in Central. | Redeploy Coolify. Use `COOLIFY_API_TOKEN`. |
| Desktop update engine (`electron/update-engine.js`) | Asks Central for its policy and target, downloads, verifies and installs on the device. | Receive a GitHub or Coolify credential. |

Cloud deploys and Desktop releases are independent on purpose. Merging to `main` updates
Central only. Promoting a Desktop release does not restart Central. A release that has been
registered reaches no device until a Superadmin approves it in **Bizamiz → `/platform/updates`**.

```
 GitHub Actions (windows-production environment)
   candidate ──► acceptance ──► windows-production-release.yml
                                   │ 1. sign manifest (private key stays in GitHub)
                                   │ 2. upload EXE + release-manifest.json to a GitHub Release
                                   │ 3. POST /api/desktop-releases/promote  (Bearer publish token)
                                   ▼
 Coolify ──► Bizamiz Central (existing app) ──► PostgreSQL (release catalogue, policies, device events)
                                   │  registered as published / internal / 0 %
                                   ▼
 Superadmin in /platform/updates:  pin a canary business ─► pilot % ─► full
                                   │
                                   ▼  authenticated, device-bound request (POST /api/server-sync/runtime-status)
 Hybrid or cloud-enrolled Full Offline Desktop
      policy + signed manifest ─► download from the release URL ─► verify signature, SHA-256, publisher
      ─► safe-window gates + verified backup ─► install ─► post-boot check ─► status back to Central
```

Coolify does not store the EXE. Central's database holds the artifact URL, checksum,
signing identity, channel, compatibility range and every device policy. The installer stays on
the file host (see step 6).

## 2. One-time Coolify setup (the existing Central application)

1. Open Coolify, then the **Project** and **Environment** that contain the Bizamiz Central
   application, then that application's **Environment Variables**.
2. Add the variables from the table. Mark the token as a runtime-only secret. Add the public
   key with the multiline editor, or as one line with `\n` for each line break (Central accepts
   both).
3. Confirm the Central database is the persistent PostgreSQL service and that `DATABASE_URL`
   points at it. Release metadata, policies and events live there. Never rely on the
   container's disk. See [Coolify persistent storage](https://coolify.io/docs/applications/configuration/persistent-storage).
4. Save, then **Redeploy** (an environment change needs a restart to reach the runtime).
5. Check that the public domain is reachable over HTTPS and routes to this application.

| Variable (Coolify, Central) | Type | Value |
|---|---|---|
| `DESKTOP_RELEASE_PUBLISH_TOKEN` | runtime secret | A long random value (at least 32 characters). Identical to the GitHub secret of the same name. Authorises release **registration** only. |
| `DESKTOP_RELEASE_PUBLIC_KEY_PEM` | runtime variable | The RSA **public** key that matches the manifest signing key. Public key only. |
| `DATABASE_URL` and the other existing variables | existing | Unchanged. |

Never put these in the Central container: `DESKTOP_RELEASE_PRIVATE_KEY_PEM`, a GitHub PAT, a
Windows signing key or its provider credentials, a private storage key, or
`COOLIFY_API_TOKEN`. Never add a `NEXT_PUBLIC_*` variable for any of them. The readiness check
fails loudly if the first, the Coolify token or a secret-looking `NEXT_PUBLIC_*` name is present.

With more than one replica, every replica must see the same variables and the same database,
and `/api/health` on each must report the same image SHA.

## 3. One-time GitHub setup (environment `windows-production`)

In the repository: **Settings → Environments → windows-production**. Turn on required
reviewers, and restrict deployment branches, so a release cannot be promoted without a person.

| Name | Type | Value |
|---|---|---|
| `DESKTOP_RELEASE_REGISTRY_URL` | variable | `https://<central-public-domain>/api/desktop-releases/promote`. This is Central's API, **not** the Coolify API. |
| `DESKTOP_RELEASE_PUBLIC_KEY_PEM` | variable | The same public key as in Coolify. It is embedded in the signed candidate. |
| `WINDOWS_EXPECTED_SIGNER` | variable | The Authenticode publisher the installer must carry. |
| `DESKTOP_RELEASE_PRIVATE_KEY_PEM` | secret | The manifest signing **private** key. GitHub only. |
| `DESKTOP_RELEASE_PUBLISH_TOKEN` | secret | Exactly the value configured in Coolify. |
| existing signing-provider credentials | secrets | Reuse the current Windows signing setup. There is no unsigned production fallback. |

`publish.yml` has its own, unrelated values (`COOLIFY_API_TOKEN`, `PRODUCTION_HEALTH_URL`).
Do not reuse them here, and do not reuse the publish token anywhere else. A test
(`src/lib/desktop-release-contract.test.ts`) fails the build if either workflow starts using the
other's credentials, or if the registry payload and Central's validator drift apart.

## 4. Publishing a release (no EXE is ever uploaded by hand)

1. A signed candidate is built and passes the Windows, signature and physical acceptance gates.
2. An authorised operator runs `windows-production-release.yml` on the **exact verified
   bytes**. It publishes `Bizamiz Setup X.Y.Z.exe` and the signed `release-manifest.json`
   to a GitHub Release.
3. The workflow calls `POST /api/desktop-releases/promote` with the Bearer publish token.
   Central verifies the manifest signature (production refuses without a configured public key)
   and stores immutable metadata. The release is **published / internal / 0 %** whatever the
   caller sends.
4. In **/platform/updates** the release appears under its channel. A Superadmin chooses who
   gets it, in this order: pin it to a canary business, location or device from the device's
   policy dialog; then pilot; then percentage; then full. All of this is inside Bizamiz, never in Coolify.
5. Each enrolled desktop asks Central (authenticated by its own device credential) for its
   effective policy and target. Central decides eligibility before it returns anything.
6. The desktop downloads from the artifact URL, verifies the signature, SHA-256 and publisher,
   and installs only if the policy and every local safety gate allow it.
7. Progress comes back as stepwise events with server-receipt times. **Requested**, **delivered**
   and **acknowledged** are three different things: an HTTP 200 from the registry is not "a
   desktop upgraded", and a queued policy for an offline desktop is not "done".

### If the GitHub Release succeeded but registration failed

Re-run the `Register the promoted release in Central` step (or the whole production workflow
against the same candidate). Registration is idempotent for identical metadata: an
already-registered version and channel returns `409 release_exists` and writes nothing, so a
retry cannot create a duplicate. Do **not** rebuild, and do not register by hand with different
bytes. A signature or hash that differs from the published release is a different release.

## 5. Verifying (no secrets are printed)

Run these from an operator machine. Replace the placeholders.

```bash
# Central is the image you expect (a Coolify "redeploy accepted" message is NOT verification).
curl -fsS https://<central-public-domain>/api/health

# The registry route exists and rejects an unauthenticated caller (expect 401, not 404 or a TLS error).
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<central-public-domain>/api/desktop-releases/promote
```

Then, signed in to the Superadmin console, open **`GET /api/platform/updates/readiness`** (or
call it from the browser while signed in). It reports, without returning any value:

- whether the publish token and public key are configured, and the key's SHA-256 fingerprint
  (compare it with the fingerprint of the key in GitHub);
- whether the update-policy migration has been applied;
- the last pipeline registration and the number of published releases;
- whether anything that must not exist on Central does.

Each check names its layer, so Coolify configuration, the database, the GitHub release, the
registry call and tenant exposure stay separate. A pipeline failure and a device failure are
different problems: use the **device timeline** in `/platform/updates` for the latter.

## 6. Where the installer is hosted (decision required before automation)

Central stores a URL; the desktop downloads from it with **no credential**. Today the engine
accepts only HTTPS from `github.com`, `objects.githubusercontent.com` and
`release-assets.githubusercontent.com` (plus anything in `DESKTOP_UPDATE_ALLOWED_ORIGINS`),
follows at most five redirects, and fails on any other origin.

If `hamidnoshady/biza-miz` is **private**, a plain GitHub Release download URL does not work
from a customer's machine. Do not embed a repository token, GitHub App secret or PAT in
Electron, the database, the manifest or a URL. Choose one, document the choice here, and test
it:

1. **Public installer-only host** (a separate public release repository, or a binary-only CDN
   bucket). Signed installers become public; source stays private. Checksums and the manifest
   signature make tampering detectable. Simplest, and compatible with the current engine.
2. **Private binary delivery through a broker**: Central issues a short-lived per-device URL to
   protected object storage. Prefer a CDN or object store for the bytes, not a multi-gigabyte
   response through the Central web container. Needs range/resume support, URL refresh, and the
   storage origin added to the allow-list. **Not implemented yet.**

Acceptance for either: from a clean Windows machine with **no GitHub login**, the installer
downloads completely, resumes after a dropped connection, and passes signature, SHA-256 and
publisher validation. A GitHub login page or an expired URL must fail with an actionable status
and never be executed.

## 7. Staging and production

Use the same procedure with separate values: a separate Coolify environment and Central
database, a separate registry URL and publish token, and (recommended) a separate signing key
and GitHub environment. A staging desktop must point at staging Central. Never promote a
staging-signed manifest to a production Central: the public key will not match and Central
rejects it.

## 8. Rotation

- **Publish token:** generate a new value, set it in Coolify and redeploy, then update the GitHub
  secret. Registrations fail between the two steps, so do it when no release is being promoted.
- **Manifest signing key:** needs a **signed transition release** that embeds the next public key
  before manifests switch signers. Never rotate by replacing the key alone: devices would reject
  every new manifest. Keep the old public key in Central until the transition release is on
  every active device.
- **Coolify API token / GHCR credentials:** belong to `publish.yml` only.

## 9. Incident response and rollback

| Symptom | Layer | What to do |
|---|---|---|
| Release on GitHub, not in `/platform/updates` | registration | Re-run the register step (step 4). Check readiness for the token and key. |
| Registration returns 401 | Central config | Token differs between GitHub and Coolify, or Central was not redeployed after the change. |
| Registration returns `invalid_manifest_signature` or `manifest_public_key_not_configured` | Central config / signing | Wrong or missing public key. Compare fingerprints. |
| Registration cannot connect (TLS, 403, timeout) | network | The public domain, proxy or firewall is blocking GitHub's runners. Fix the route. |
| Central shows an old image SHA | deployment | The redeploy did not take effect. Redeploy, then check `/api/health`. |
| Devices stay on "requested" policy | delivery | They are offline or have not reported. Offline is shown as offline, not as done. |
| Download fails (`download_http_*`, `installer_origin_not_allowed`) | installer host | The URL is private, expired, or on a host the engine does not allow (step 6). |
| `installer_sha256_mismatch`, `authenticode_invalid`, `manifest_signature_invalid` on the device | artifact | Never override. Withdraw the release, rebuild through the pipeline, promote again. |
| A device is revoked or locked | credential | It receives no policy or target. A brief outage on an enrolled device is not revocation. |

**Stop a bad release:** in `/platform/updates` pause or withdraw it, or set an emergency **hold**
on a business, location or device policy. A hold also stops an unattended install that is
already scheduled. It does not remove an installer already downloaded.

**Rollback:** a device never downgrades itself and never restores its database automatically.
After a failed update it enters `recovery_required` and keeps the pre-update dump and the
known-good installer. Recovery is an authorised, manual step through the existing verified
restore workflow, and only after schema compatibility is confirmed. See
[desktop-updates.md](desktop-updates.md#recovery).

## 10. Operator checklist

- [ ] Coolify: `DESKTOP_RELEASE_PUBLISH_TOKEN` and `DESKTOP_RELEASE_PUBLIC_KEY_PEM` set; Central redeployed.
- [ ] Coolify: none of the forbidden variables are present; readiness shows no `tenant_exposure` failures.
- [ ] GitHub `windows-production`: variables and secrets match the table; reviewers required.
- [ ] Public key fingerprints match between Coolify and the signing pipeline.
- [ ] Installer host decision made, documented and tested from a clean Windows machine (step 6).
- [ ] `/api/health` reports the expected image SHA; the promote route answers 401 unauthenticated.
- [ ] A test release registered as internal / 0 %, pinned to one canary business, installed, and
      reported "verified after restart" by the device.
- [ ] The same on a cloud-enrolled Full Offline device, including offline and reconnect.

References: [Coolify environment variables](https://coolify.io/docs/applications/configuration/environment-variables),
[Coolify GitHub Actions](https://coolify.io/docs/applications/sources/github/actions),
[Coolify persistent storage](https://coolify.io/docs/applications/configuration/persistent-storage),
[GitHub release assets API](https://docs.github.com/en/rest/releases/assets),
[production deployment verification](production-deployment-verification.md).
