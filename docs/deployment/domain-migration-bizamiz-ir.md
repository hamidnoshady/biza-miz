# Domain migration: `app.eshobe.com` → `app.bizamiz.ir`

Status: **Phase 2 live** (2026-11-22). `app.bizamiz.ir` is now `ROOT_DOMAIN`;
`app.eshobe.com` is still fully served as `ADDITIONAL_ROOT_DOMAINS`. **No redirect
is in place yet** — each root keeps its own sessions. Phase 3 (redirect and
retire) is blocked until every customer, session and device has moved.

## Current production (verified 2026-11-22)

- Primary root: `https://app.bizamiz.ir` (`/api/health` 200, wildcard TLS)
- Legacy root: `https://app.eshobe.com` (`/api/health` 200, unchanged)
- Business hosts: `<label>.app.bizamiz.ir` and `<label>.app.eshobe.com` serve the
  same business; `/api/host/resolve` returns `canonicalUrl: null` for both, so
  neither root is redirected to the other
- Console: `admin.app.bizamiz.ir`; legacy `admin.app.eshobe.com`
- `ROOT_DOMAIN=app.bizamiz.ir`
- `ADDITIONAL_ROOT_DOMAINS=app.eshobe.com`
- `PLATFORM_BASE_URL=https://app.bizamiz.ir`
- `WEBAUTHN_RP_ID=app.eshobe.com` (see WebAuthn below)
- Deployed image: `sha-34c6eb5` (`:latest`), the multi-root build
- `pos.eshobe.com` is **not** the live root (503); do not migrate it.

## Target

- New tenant root: **`app.bizamiz.ir`**
- New businesses: `<business>.app.bizamiz.ir`
- New console: `admin.app.bizamiz.ir`
- `bizamiz.ir` / `www.bizamiz.ir`: marketing site or redirect to `https://app.bizamiz.ir`; **not** a tenant root.
- Old root `app.eshobe.com` stays fully operational during the migration.

## Why DNS alone is not enough

The app resolves tenant hosts against one `ROOT_DOMAIN`. The code now accepts
`ADDITIONAL_ROOT_DOMAINS` alongside the primary, and all redirects/handoffs keep
the root the browser actually used. Without that code deployed, requests to
`*.app.bizamiz.ir` parse as “unknown host” and fail closed.

## ArvanCloud DNS

With the server’s true IPv4/IPv6 address:

| Record | Type | Value | Purpose |
|---|---|---|---|
| `app.bizamiz.ir` | A (+AAAA) | `<true IP>` | platform apex / directory |
| `*.app.bizamiz.ir` | A (+AAAA) | `<true IP>` | every business tenant |
| `admin.app.bizamiz.ir` | A (+AAAA) | `<true IP>` | super-admin console |
| `bizamiz.ir` | A | marketing host | optional |
| `www.bizamiz.ir` | A / CNAME | marketing host | optional |

Keep every `app.eshobe.com` and `*.app.eshobe.com` record unchanged.

TTL 300 during the cutover.

In the ArvanCloud zone the record names are relative to `bizamiz.ir`:
`app.bizamiz.ir` is name `app`, `admin.app.bizamiz.ir` is name `admin.app`.
Both are **DNS-only** (`cloud=false`): ArvanCloud must not proxy them, or the
original `Host` header and the ACME challenge are lost.

Businesses are host-scoped, so the wildcard is required for Phase 2: `*` (record
name `*.app`) is a DNS-only A record, and the `bizamiz-tenants` router asks the
`arvan` resolver for `app.bizamiz.ir` + `*.app.bizamiz.ir`. Without it, every
`<label>.app.bizamiz.ir` link — including invitations and emails built from the
primary root — would be NXDOMAIN.

### TLS

`*.app.bizamiz.ir` needs a **wildcard certificate**. Let’s Encrypt will not issue
one over HTTP-01; use DNS-01 (ArvanCloud DNS API in Coolify/Traefik) or upload an
ArvanCloud wildcard certificate.

The proxy has three resolvers configured: `letsencrypt` and `arvan` (both
DNS-01) and `http01`. Traefik keeps one default certificate store, so a host
served by a router that names another resolver still gets the matching
certificate without a handshake failure. Certificates are issued from the
router’s `tls.certResolver` label/value; nothing is uploaded by hand.

Keep the existing `*.app.eshobe.com` certificate until the old root is retired.

### Proxy mode

Prefer **DNS-only / direct to the true IP** for this stack so the original `Host`
reaches the app and certificate issuance is simple. If ArvanCloud proxies, use
Full (Strict) TLS and confirm it forwards `Host` (or set `TRUST_FORWARDED_HOST=on`
only if the edge overwrites it).

## Coolify (Central application)

The service is a Docker-image service with a comma-separated FQDN list. Coolify
creates **one router per domain**, so listing both roots yields four routers
(`http-0`/`https-0` for `app.eshobe.com`, `http-1`/`https-1` for
`app.bizamiz.ir`). Current value:

```text
service_applications.fqdn = https://app.eshobe.com,https://app.bizamiz.ir
```

Add the domains to the **same** Central service; do not remove the old ones and
do not enable a global redirect.

`admin.app.bizamiz.ir` is **not** in that list: it is served by the file provider
(`/data/coolify/proxy/dynamic/routes.yml`), because it is an exception like the
existing `admin.app.eshobe.com` wildcard router. See “Operational pitfalls” below.

Wildcards (`*.app.bizamiz.ir`) stay out until subdomain routing is switched on.

Redeploy after the certificate is issued. Verify:

```bash
curl -fsS https://app.bizamiz.ir/api/health
curl -fsS https://app.eshobe.com/api/health
```

## Environment phases

### Phase 1 — deploy multi-root, old domain still primary

Applied 2026-11-22.

```text
ROOT_DOMAIN=app.eshobe.com
ADDITIONAL_ROOT_DOMAINS=app.bizamiz.ir
PLATFORM_BASE_URL=https://app.eshobe.com
# PUBLIC_ORIGIN: leave unset during migration
```

Old behaviour is unchanged. Verify:

- `https://app.eshobe.com/api/host/resolve?host=acme.app.eshobe.com` → business host
- `https://app.bizamiz.ir/api/host/resolve?host=acme.app.bizamiz.ir` → same label
- `https://admin.app.bizamiz.ir/login` → 200
- an existing business resolves on both roots
- old sessions still work

### Phase 2 — make `app.bizamiz.ir` primary

Applied 2026-11-22.

```text
ROOT_DOMAIN=app.bizamiz.ir
ADDITIONAL_ROOT_DOMAINS=app.eshobe.com
PLATFORM_BASE_URL=https://app.bizamiz.ir
```

New links, new tenants and new emails use `app.bizamiz.ir`. Old hosts still
resolve and old sessions/cookies stay on `app.eshobe.com`.

Coolify stores these Laravel-encrypted, so a raw SQL `UPDATE` corrupts them. Use
the UI/API, or update through the model inside the Coolify container:

```bash
docker cp update-env.php coolify:/tmp/update-env.php
docker exec coolify php /tmp/update-env.php      # $svc->environment_variables()->...->save()
docker exec -u root coolify rm -f /tmp/update-env.php
```

Then sync the service `.env` and recreate only the app:

```bash
cd /data/coolify/services/<uuid>
docker compose -p <uuid> -f docker-compose.yml up -d --no-deps app
```

Startup takes ~90s under `tsx`; the first 502/503 is not a failure.

Do not set `PUBLIC_ORIGIN=https://app.bizamiz.ir` during the transition: that pin
would move old-domain handoffs to the new domain and lose the host-scoped
session. The handoff now preserves the request root.

### Phase 3 — retire the old root

Not started. A redirect is **not** safe yet, even though the wildcard exists:

- **Sessions are host-only.** A redirect from `app.eshobe.com` to
  `app.bizamiz.ir` (and from every `<label>.app.eshobe.com`) drops the cookie, so
  all ~500 employee sessions and ~57 admin sessions must log in again. That is a
  scheduled maintenance action, not a deploy.
- **Passkeys.** With `WEBAUTHN_RP_ID=app.eshobe.com`, moving users to the new
  domain disables their passkeys until the RP ID is switched and they re-enrol.
- **Desktop devices** still pair to `https://app.eshobe.com`; their remote URL
  must be moved (or redirected) first.
- **Business aliases**: `business_subdomain_aliases` rows still point at old
  hosts and should be reviewed.

When those are done:

- remove `app.eshobe.com` from `ADDITIONAL_ROOT_DOMAINS`
- remove its DNS records and certificate
- add the 301 `app.eshobe.com` → `app.bizamiz.ir` (and `<label>.app.eshobe.com`
  → `<label>.app.bizamiz.ir`) in the proxy, not in the app

## WebAuthn / passkeys

`WEBAUTHN_RP_ID` is a single RP ID; a passkey registered on `app.eshobe.com`
cannot be used on `app.bizamiz.ir` (different registrable domains).

To keep old passkeys working during the migration:

```text
WEBAUTHN_RP_ID=app.eshobe.com
```

New-domain users use password/PIN until the old root is retired. After that,
switch to `WEBAUTHN_RP_ID=app.bizamiz.ir` and require passkey re-enrolment.

> **Phase 2 makes this user-visible.** `app.bizamiz.ir` is now the primary root,
> but the RP ID is still `app.eshobe.com`, so passkey registration and login on
> the new domain fail the browser’s RP check (the user falls back to password).
> Switching the RP ID fixes the new domain and **invalidates every passkey
> registered on the old one** — verify each passkey holder can log in with a
> password before flipping it.
A future per-request RP ID change can support both without this limitation.

`WEBAUTHN_ORIGIN` can list both origins:

```text
WEBAUTHN_ORIGIN=https://app.eshobe.com,https://*.app.eshobe.com,https://app.bizamiz.ir,https://*.app.bizamiz.ir
```

(Origins are also derived from the request host when it is under a configured
root, so the wildcard entries are documentation rather than a substitute for the
per-business origins the browser actually sends.)

## Desktop update feed

- **Existing devices** keep `remoteUrl=https://app.eshobe.com`; updates continue
  because Central remains served there.
- **New devices** pair to `<label>.app.bizamiz.ir` (or whatever host the owner is
  signed in at — the panel derives the address from the request, see “Hybrid
  sites and paired desktops” below).
- **Release registration** (GitHub `windows-production` environment):
  `DESKTOP_RELEASE_REGISTRY_URL=https://app.bizamiz.ir/api/desktop-releases/promote`
  — `/api/health` on the new host is already 200 (2026-11-22), so only the
  variable is outstanding.
- The release catalogue is the same Central database, so a release registered
  through `app.bizamiz.ir` is visible to devices polling `app.eshobe.com`.
- Installer downloads are from GitHub; the domain change does not affect them.
- To move one device, change Settings → Server sync → remote URL to
  `https://app.bizamiz.ir` (same token), test it, then roll out gradually.

## Hybrid sites and paired desktops

Three different things are easy to conflate. Only one is affected by the root
change, and not in the way it looks.

| Thing | Where the address lives | Effect of Phase 2 |
|---|---|---|
| Desktop paired to a hosted business | the desktop’s own config; Central stores no URL | none — the old host is still served |
| Hybrid site paired to Central | `local_cloud_activations.cloud_origin` **on the site** | none — `app.eshobe.com` still answers |
| Business on a custom domain | its DNS and host record | independent of either root |

### The pairing address follows the request

`desktop-link-service.ts` builds the address the owner copies into the desktop
from the request that rendered the panel, never from `PLATFORM_BASE_URL`:

```ts
address: originFromHeaders(headers) // "this request's own origin, never a configured constant"
```

An owner signed in at `<label>.app.eshobe.com` still gets that address; one on
`<label>.app.bizamiz.ir` gets the new one, which is valid because the wildcard
exists. Codes are business + location scoped — `pairing-service.ts` looks up
`business_id`/`location_id`/`code_hash` — so a code issued on one root redeems on
the other.

### Central stores no device URL

`devices` and `site_devices` have no host, origin or URL column at all; the
address lives in the desktop app. A root change cannot rewrite what is not
stored, so no device row needs editing on Central (verified 2026-11-22: 0
`devices`, 12 `site_devices` identities, none with an address).

### The hybrid site → Central link

The site keeps Central’s origin in `local_cloud_activations.cloud_origin` in its
**own** database (0 rows on Central, by design). It is probed as
`${cloudOrigin}/api/health`. A site still pointing at `app.eshobe.com` keeps
working because that root is served and not redirected.

### What the Phase 3 redirect breaks

- the desktop’s host-scoped session/token is not sent to the new origin;
- a 301/302 can be replayed as `GET` on a POST; 308 keeps the method but still
  crosses origins;
- server-to-server sync would redirect on every poll and hide failures.

Before enabling the 301, re-point or exempt:

- re-issue a pairing code while signed in at the new host, then re-pair (or edit
  Settings → Server sync);
- `repairOrReenrollLocalInstallation`
  (`src/lib/local-activation-site-service.ts`) to move a site’s `cloud_origin`;
- or keep an explicit no-redirect rule in the proxy for the hosts and API paths
  desktops use.

Inventory first: the 12 `site_devices` rows, every hybrid site’s `cloud_origin`,
and each desktop’s configured address.

## Integrations to update

Add the new origins while keeping the old ones:

- CMS embed/preview: `ADMIN_EMBED_ORIGINS`, `SITE_PREVIEW_ORIGINS`
- Android App Links: `ANDROID_WEB_ORIGIN_PRODUCTION`
- Telegram: `TELEGRAM_PUBLIC_ORIGIN=https://app.bizamiz.ir`, webhook URL
- printing connector download base (`PLATFORM_BASE_URL` covers it)
- payment/SMS/OAuth callback allow-lists
- email links: add SPF/DKIM/DMARC for `bizamiz.ir` before sending from it
- MCP/OAuth clients: they read the canonical endpoint from the tenant’s
  Connections page, which follows `ROOT_DOMAIN`/`PLATFORM_BASE_URL`

## Operational pitfalls (learned 2026-11-22)

Each of these looks like a DNS problem and is not. All were hit and fixed during
the Phase 1 cutover.

### 1. `ARVANCLOUD_API_KEY` must include the `Apikey ` prefix

Traefik’s DNS-01 provider (lego) writes the API key into the header verbatim:

```go
req.Header.Set("Authorization", c.apiKey) // no "Apikey " is added
```

So `/opt/traefik/arvan.env` (loaded as an `env_file` by
`/data/coolify/proxy/docker-compose.yml`) must read:

```text
ARVANCLOUD_API_KEY=Apikey <token>
```

Failure signatures:

| Value | ACME result |
|---|---|
| bare `<token>` | `401 {"message":"Unauthenticated."}` |
| `Apikey <token without zone access>` | `403 {"message":"Your access to this section is restricted."}` |
| `Apikey <token that lists the zone>` | certificate issued |

The token must belong to the ArvanCloud account/team that owns the zone. Check
before blaming Traefik — `GET /cdn/4.0/domains` must list `bizamiz.ir`, and a TXT
write must succeed:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Authorization: Apikey <token>' -H 'Content-Type: application/json' \
  -d '{"type":"txt","name":"_probe","value":{"text":"probe"},"ttl":120,"cloud":false}' \
  https://napi.arvancloud.ir/cdn/4.0/domains/bizamiz.ir/dns-records
# expect 201; delete the returned id afterwards
```

The env file is read at container start, so recreate the proxy after editing it:

```bash
cd /data/coolify/proxy && docker compose -p coolify-proxy -f docker-compose.yml up -d --force-recreate
```

Let’s Encrypt also rate-limits failed authorizations per identifier (5/hour), so a
burst of wrong-token attempts blocks issuance for up to an hour after the fix.
The error names the retry time; wait for it instead of restarting repeatedly.

### 2. A manual proxy recreate detaches it from service networks

Coolify connects `coolify-proxy` to every network used by managed containers. A
manual `docker compose up -d` on the proxy drops those attachments. Hosts routed
by Docker labels then **complete the TLS handshake and hang**: `access.log` shows
`DownstreamStatus: 499`, `OriginStatus: 0`, and `Duration` equal to the client
timeout. The same URL through a file-provider service (`host.docker.internal`)
works, which makes it look like an app bug.

Restore immediately after any manual proxy recreate:

```bash
bash /data/coolify/proxy/attach-networks.sh
```

Verify from inside the proxy:

```bash
docker inspect coolify-proxy --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep jrfpvt0rctfkmzpw1ao5c1cb
docker exec coolify-proxy wget -qS -O /dev/null --header='Host: app.bizamiz.ir' http://<app-ip>:3000/api/health
```

Coolify’s own restart path re-attaches the networks; the script is only needed
for manual compose work.

### 3. Hosts Coolify does not own live in `dynamic/routes.yml`

`/data/coolify/proxy/dynamic/routes.yml` (Traefik file provider) serves hosts that
are not in the service’s FQDN list. The cutover added:

```yaml
    bizamiz-admin:
      rule: 'Host(`admin.app.bizamiz.ir`)'
      priority: 60
      service: pos            # host.docker.internal:3000
      middlewares: [sec-headers]
      tls:
        certResolver: arvan
```

`pos-root` (`app.eshobe.com`), `pos-tenants` (`^.+\.app\.eshobe\.com$`, wildcard
cert) and the CMS/observe routers stay as they were. File-provider routers
survive Coolify regenerating `/data/coolify/services/<uuid>/docker-compose.yml`;
hand edits to the labels in that file do not.

### 4. Never pin the service image to a SHA

`publish.yml` promotes a tested `sha-<short>` image by re-tagging it `latest`, then
restarting Coolify with `latest=true`. If the service compose references
`ghcr.io/hamidnoshady/biza-miz:sha-<short>`, the promote is a **silent no-op**:
the restart pulls the pinned tag and `APP_IMAGE_SHA` never changes.

The compose must reference `:latest` (it is the only moving tag; `sha-*` stays
immutable for staging). Coolify regenerates the compose from
`services.docker_compose_raw` on every start, so that column — or the UI stack
form — is the source of truth:

```bash
docker exec coolify-db psql -U coolify -d coolify -t -A \
  -c "select docker_compose_raw from services where uuid='jrfpvt0rctfkmzpw1ao5c1cb';" | grep 'biza-miz:'
```

Do not hand-write a combined `Host(a) || Host(b)` label: Coolify rebuilds one
router per comma-separated FQDN on the next start and the edit is lost.

### 5. A full disk silently keeps the old container

A promoted deploy can report success while the pull fails during layer
extraction. Symptom: `docker compose pull` prints
`failed to extract layer … no space left on device`, the container keeps the old
image ID, and `APP_IMAGE_SHA` stays behind.

Check before promoting — one image pull needs several GB:

```bash
df -h /
docker system df
```

Safe cleanup — unused images and build cache only:

```bash
docker image prune -a -f
docker builder prune -f
```

**Never delete `/srv/appdata/*` or the backups.** Those are live production data,
not build artefacts:

| Path | What it is |
|---|---|
| `/srv/appdata/wp-ghaemsazan`, `wp-watchmid`, `wp-zaniziba` | live WordPress sites |
| `/srv/appdata/wp-db` | the database behind those WordPress sites |
| `/srv/appdata/pos` | POS data |
| `/srv/backups/db` | database backups |
| `/data/coolify/backups` | Coolify backups |
| Docker volumes | application data |

Pruning containers, images or volumes can destroy them (`docker system prune
--volumes` and `docker volume prune` are always wrong here). Disk pressure must be
solved by removing unused images, never by touching `/srv`.

### 6. Verify DNS, TLS and routing from both sides

```bash
# server side
getent hosts app.bizamiz.ir admin.app.bizamiz.ir

# any machine: certificate + health, per host
for h in app.eshobe.com app.bizamiz.ir admin.app.bizamiz.ir admin.app.eshobe.com; do
  curl -sS -o /dev/null -w "$h %{http_code} tls=%{ssl_verify_result}\n" "https://$h/api/health"
done

# redirects must stay on the root the browser used
for p in / /admin /platform /platform/login; do
  curl -sS -o /dev/null -w "$p -> %{http_code} %{redirect_url}\n" "https://app.bizamiz.ir$p"
done
```

`ERR_NAME_NOT_RESOLVED` for `admin.app.bizamiz.ir` means the record is missing —
`app.bizamiz.ir` being live does not imply its subdomains are.

## Rollback

No database change is involved. Set `ROOT_DOMAIN`/`ADDITIONAL_ROOT_DOMAINS`/
`PLATFORM_BASE_URL` back to the Phase 1 values and redeploy. DNS and certificates
can remain in place while the cause is investigated.

## Verification checklist

Verified on 2026-11-22 with the multi-root image `sha-34c6eb5`:

- [x] `https://app.bizamiz.ir/api/health` 200, valid TLS
- [x] `https://app.eshobe.com/api/health` 200 (unchanged)
- [x] `https://admin.app.bizamiz.ir/platform/login` 200, valid TLS
- [x] `https://admin.app.eshobe.com` 200 (unchanged)
- [x] `*.app.bizamiz.ir` wildcard resolves; `<label>.app.bizamiz.ir` serves the
      same business as `<label>.app.eshobe.com`
- [x] `/`, `/admin`, `/platform` on either root stay on that root (no cross-root
      redirect)
- [x] no `eshobe.com` references in the HTML served on the new root
- [x] Phase 2 applied: `ROOT_DOMAIN=app.bizamiz.ir`,
      `ADDITIONAL_ROOT_DOMAINS=app.eshobe.com`,
      `PLATFORM_BASE_URL=https://app.bizamiz.ir`

Pending:

- [ ] old employee session still valid on `<label>.app.eshobe.com` (needs a real
      browser session, not a curl)
- [ ] new employee login works on `<label>.app.bizamiz.ir`
- [ ] passkey decision recorded and applied (see WebAuthn above)
- [ ] company/impersonation handoff stays on the browser’s root
- [ ] desktop health/update check on the old URL still works
- [ ] hybrid inventory done before the redirect: every `cloud_origin` and paired
      desktop address re-pointed or exempted (see “Hybrid sites and paired
      desktops”)
- [ ] `DESKTOP_RELEASE_REGISTRY_URL` points at the new host and a registration
      succeeds
