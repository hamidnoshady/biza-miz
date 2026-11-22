# Domain migration: `app.eshobe.com` → `app.bizamiz.ir`

Status: **Phase 1 live** (2026-11-22). `app.eshobe.com` is still the primary
`ROOT_DOMAIN`; `app.bizamiz.ir` and `admin.app.bizamiz.ir` serve the same
deployment. Phase 2 (the flip) is pending approval. Existing customers stay on
`*.app.eshobe.com` until they move.

## Current production (verified 2026-11-22)

- Central: `https://app.eshobe.com` (`/api/health` 200)
- New root (alias): `https://app.bizamiz.ir` (`/api/health` 200, valid TLS)
- Console: `admin.app.eshobe.com`; new console: `admin.app.bizamiz.ir` (200)
- `ROOT_DOMAIN=app.eshobe.com`, `ADDITIONAL_ROOT_DOMAINS=app.bizamiz.ir`
- Businesses: `<business>.app.eshobe.com`
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

The wildcard row is only needed once per-business hosts go live
(`SUBDOMAIN_ROUTING` on). While production runs single-host, `app` + `admin.app`
are enough; a wildcard also needs a DNS-01 wildcard certificate, which is more
moving parts than the cutover needs today.

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

```text
ROOT_DOMAIN=app.bizamiz.ir
ADDITIONAL_ROOT_DOMAINS=app.eshobe.com
PLATFORM_BASE_URL=https://app.bizamiz.ir
```

New links, new tenants and new emails use `app.bizamiz.ir`. Old hosts still
resolve and old sessions/cookies stay on `app.eshobe.com`.

Do not set `PUBLIC_ORIGIN=https://app.bizamiz.ir` during the transition: that pin
would move old-domain handoffs to the new domain and lose the host-scoped
session. The handoff now preserves the request root.

### Phase 3 — retire the old root

After every customer and device has moved:

- remove `app.eshobe.com` from `ADDITIONAL_ROOT_DOMAINS`
- remove its DNS records and certificate
- optionally 301 `app.eshobe.com` → `app.bizamiz.ir`

## WebAuthn / passkeys

`WEBAUTHN_RP_ID` is a single RP ID; a passkey registered on `app.eshobe.com`
cannot be used on `app.bizamiz.ir` (different registrable domains).

To keep old passkeys working during the migration:

```text
WEBAUTHN_RP_ID=app.eshobe.com
```

New-domain users use password/PIN until the old root is retired. After that,
switch to `WEBAUTHN_RP_ID=app.bizamiz.ir` and require passkey re-enrolment.
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
- **New devices** pair to `https://app.bizamiz.ir`; update the placeholder in
  Settings → Server sync in a later build.
- **Release registration** (GitHub `windows-production` environment):
  `DESKTOP_RELEASE_REGISTRY_URL=https://app.bizamiz.ir/api/desktop-releases/promote`
  — `/api/health` on the new host is already 200 (2026-11-22), so only the
  variable is outstanding.
- The release catalogue is the same Central database, so a release registered
  through `app.bizamiz.ir` is visible to devices polling `app.eshobe.com`.
- Installer downloads are from GitHub; the domain change does not affect them.
- To move one device, change Settings → Server sync → remote URL to
  `https://app.bizamiz.ir` (same token), test it, then roll out gradually.

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
- [x] `/`, `/admin`, `/platform` on either root stay on that root (no cross-root
      redirect)
- [x] no `eshobe.com` references in the HTML served on the new root

Pending:

- [ ] a business resolves on both roots (`<label>.app.bizamiz.ir` needs the
      wildcard record and certificate, so after subdomain routing is enabled)
- [ ] old employee session still valid on `<label>.app.eshobe.com`
- [ ] new employee login works on `<label>.app.bizamiz.ir`
- [ ] company/impersonation handoff stays on the browser’s root
- [ ] desktop health/update check on the old URL still works
- [ ] `DESKTOP_RELEASE_REGISTRY_URL` points at the new host and a registration
      succeeds
