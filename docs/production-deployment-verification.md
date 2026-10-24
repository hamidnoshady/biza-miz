# Verifying a production rollout

A Docker registry push and a deployment-platform restart acknowledgement do **not**
prove that users are running the image just built. An image tag can remain cached,
a pull can fail after a restart is queued, or the platform can restart a service
whose configured image is still old.

The app exposes the build argument baked into the running image at the public,
database-free endpoint:

```json
GET /api/health
{"ok":true,"version":"<APP_IMAGE_SHA>","at":"..."}
```

`version` must equal the short Git SHA supplied as Docker's `GIT_SHA` build
argument. It is the source of truth for a running container; the GitHub Actions
job, a registry tag, and a green liveness check alone are not.

## One-command smoke check

Run this after a manual deployment, or while diagnosing a report that a new page
still 404s:

```bash
npm run deploy:verify -- \
  --health-url https://<live-business-host>/api/health \
  --expected-sha "$(git rev-parse --short HEAD)" \
  --attempts 60 --delay-ms 10000
```

It first waits for the health endpoint to report the requested SHA. Only then it
makes signed-out requests to the canonical URLs affected by the top-level apps
and settings change:

- `/dashboard`, `/projects`, `/settings`, `/settings/billing`, `/settings/team`
- `/accounting/overview`, `/accounting/expenses`, `/accounting/settings`
- `/crm/overview`, `/crm/persons`
- `/growth/overview`, `/websites/overview`

Every protected URL must be a `307` to `/login?next=<that same canonical URL>`.
That checks the public routing boundary without storing a staff cookie or other
credential in CI. It catches both a literal 404 and the former middleware-rewrite
failure, whose redirect incorrectly carries `/dashboard/...` in `next`.

Use a single attempt (`--attempts 1`) for an immediate diagnosis. The longer
retry form is for an asynchronous rollout. The same options can be supplied as
`PRODUCTION_HEALTH_URL`, `EXPECTED_SHA`, `DEPLOY_VERIFY_ATTEMPTS`, and
`DEPLOY_VERIFY_DELAY_MS` environment variables.

## GitHub Actions / Coolify setup

On a push to `main` the `publish` workflow builds and publishes only the
immutable image tag `sha-<short-sha>`. Production is redeployed only by a manual
`workflow_dispatch` of the same workflow with `sha=<the tested commit>`, which
re-tags that existing image as `latest` and then asks Coolify to redeploy; the
verification below runs in that dispatch. Configure the non-secret repository
Actions variable:

```text
PRODUCTION_HEALTH_URL=https://<live-business-host>/api/health
```

The workflow then runs the smoke check above for every push to `main` and fails
if the public container does not report the newly published SHA or any canonical
route has the wrong signed-out response. Do not use an internal Docker or
Coolify hostname: the check must traverse the same TLS proxy and host routing as
a browser.

If the variable is not configured, the publication and restart request can still
succeed, but the workflow cannot attest that the live service changed; it emits a
visible GitHub Actions warning. Treat that as **unverified**, not deployed. Add
the variable before relying on automatic rollouts.

## When health reports an old SHA

This is a deployment artifact/configuration incident, not evidence that the
current route tree needs to be rewritten.

1. Compare `GET https://<live-host>/api/health` with the intended commit's short
   SHA. Do this before changing application code.
2. In the platform service configuration, select the immutable image that
   matches that SHA — for example
   `ghcr.io/hamidnoshady/biza-miz:sha-<short-sha>` — and redeploy it. Use the
   repository's **current** name: the publish workflow tags
   `ghcr.io/${{ github.repository }}`, so a `sha-<short>` tag only exists under
   the current package name, and a pre-rename reference keeps resolving to the
   frozen image built before the rename. Confirm the service is configured for
   this repository, has registry access, and pulls rather than reusing a local
   cached image.
3. Repeat `npm run deploy:verify`. Do not call the rollout complete until both
   the reported SHA and all redirects pass.
4. If the SHA is current but routes still fail, query
   `/api/host/resolve?debug=1` on the affected hostname. Verify `rootDomain`,
   `usedForTenancy`, and the parsed host before investigating the route code.
   Managed edges that replace `Host` with an internal name require
   `TRUST_FORWARDED_HOST=on`; a proxy that preserves `Host` must leave it off.

The production Dockerfile builds `.next` in its builder stage and `.dockerignore`
excludes a workstation's `.next` from the context. A properly rebuilt image
therefore cannot accidentally inherit this checkout's old build output. A stale
**image reference**, however, can continue to serve an old, internally-consistent
`.next` indefinitely.


## Handoff origins and the proxy-header contract

Cross-realm handoffs (Superadmin → the internal company's apps, and the
impersonation handoff) redirect browsers to an origin the deployment itself
declares. The contract — `PUBLIC_ORIGIN`, `TRUST_FORWARDED_HOST`,
`ROOT_DOMAIN`, `SUBDOMAIN_ROUTING`, which proxy shapes are supported, and the
failure codes the console shows when the shape is wrong — lives in
[company-handoff-origins.md](company-handoff-origins.md). Two checkpoints worth
doing on every rollout, from the **public** host (never the internal Docker or
Coolify name):

1. `GET /api/health` reports the intended SHA (above).
2. From Superadmin → کسب‌وکار پلتفرم → فضای کاری من, «ورود به فضای کاری من»
   lands on `https://{company}.{ROOT_DOMAIN}/workspace` (or the same-host
   deployment's own public origin) — never `localhost`, an internal service
   name, or a `:3000` port behind 443. If the console shows a red handoff
   error instead, that is the fail-closed path working: match the code in
   [company-handoff-origins.md](company-handoff-origins.md) and fix the proxy
   configuration it names.

## Desktop releases are a separate pipeline

Verifying a Cloud deploy (the image SHA on `/api/health`) says nothing about Desktop releases,
and promoting a Desktop release never redeploys Central. See
[desktop-updates-coolify.md](desktop-updates-coolify.md) for the Desktop release setup and its own
verification.
