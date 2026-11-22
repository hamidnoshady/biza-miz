# Domain migration: `app.eshobe.com` → `app.bizamiz.ir`

Status: prepared, not cut over. Existing customers stay on `*.app.eshobe.com` until they move.

## Current production (verified 2026-11-22)

- Central: `https://app.eshobe.com` (`/api/health` 200)
- `ROOT_DOMAIN=app.eshobe.com`
- Businesses: `<business>.app.eshobe.com`
- Console: `admin.app.eshobe.com`
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

### TLS

`*.app.bizamiz.ir` needs a **wildcard certificate**. Let’s Encrypt will not issue
one over HTTP-01; use DNS-01 (ArvanCloud DNS API in Coolify/Traefik) or upload an
ArvanCloud wildcard certificate.

Keep the existing `*.app.eshobe.com` certificate until the old root is retired.

### Proxy mode

Prefer **DNS-only / direct to the true IP** for this stack so the original `Host`
reaches the app and certificate issuance is simple. If ArvanCloud proxies, use
Full (Strict) TLS and confirm it forwards `Host` (or set `TRUST_FORWARDED_HOST=on`
only if the edge overwrites it).

## Coolify (Central application)

Add these domains to the **same** Central application; do not remove the old
ones and do not enable a global redirect:

- `app.bizamiz.ir`
- `*.app.bizamiz.ir`
- `admin.app.bizamiz.ir`
- `app.eshobe.com` (existing)
- `*.app.eshobe.com` (existing)
- `admin.app.eshobe.com` (existing)

Redeploy after the certificate is issued. Verify:

```bash
curl -fsS https://app.bizamiz.ir/api/health
curl -fsS https://app.eshobe.com/api/health
```

## Environment phases

### Phase 1 — deploy multi-root, old domain still primary

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
  only after `/api/health` on the new host is 200.
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

## Rollback

No database change is involved. Set `ROOT_DOMAIN`/`ADDITIONAL_ROOT_DOMAINS`/
`PLATFORM_BASE_URL` back to the Phase 1 values and redeploy. DNS and certificates
can remain in place while the cause is investigated.

## Verification checklist

- [ ] `https://app.bizamiz.ir/api/health` 200
- [ ] `https://app.eshobe.com/api/health` 200 (unchanged)
- [ ] `admin.app.bizamiz.ir/login` 200
- [ ] `acme.app.bizamiz.ir` and `acme.app.eshobe.com` resolve to the same business
- [ ] old employee session still valid on `acme.app.eshobe.com`
- [ ] new employee login works on `acme.app.bizamiz.ir`
- [ ] `/platform` on either root redirects to that root’s `admin.*`, not the other
- [ ] company/impersonation handoff stays on the browser’s root
- [ ] desktop health/update check on the old URL still works
- [ ] `DESKTOP_RELEASE_REGISTRY_URL` points at the new host and a registration
      succeeds
