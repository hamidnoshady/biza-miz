# Company handoff origins — the browser-reachable canonical origin policy

**Scope:** the admin → internal-company application handoff
(`GET /api/platform/company/open` → `GET /api/auth/company-handoff`), and the
sibling handoff receivers audited with it. Written for whoever operates a
deployment and whoever touches these routes next.

## The one rule

Every cross-realm handoff redirect names **one validated, browser-reachable
canonical origin**. There is a single policy, implemented once in
`src/lib/public-origin.ts` (`resolveHandoffOrigin`) and unit-tested against the
deployment matrix in `src/lib/public-origin.test.ts`:

| Deployment shape | Destination origin of the handoff |
|---|---|
| Host tenancy on (`ROOT_DOMAIN` set, `SUBDOMAIN_ROUTING` not `off`) | The internal company's own tenant origin: `https://{subdomain}.{ROOT_DOMAIN}` plus the external port the browser is using |
| Intentionally single-host (`SUBDOMAIN_ROUTING=off` or no `ROOT_DOMAIN`) | The **validated browser-facing origin of the request itself** — `Host` (or `X-Forwarded-Host` under the trust contract), never `request.url`'s internal hostname |
| Either, with `PUBLIC_ORIGIN` set | The operator-pinned origin (scheme/host/port); under host tenancy the host is still rebuilt as `{subdomain}.{ROOT_DOMAIN}` so one pin cannot capture another business's handoff |

When the policy cannot *prove* a reachable origin it **fails closed before the
one-use credential is minted**, answers with a stable error code, logs that
code (never a token, never a URL), and the console shows the operator what to
fix. A production central deployment never sends a browser to `localhost`,
`127.0.0.1`, a container-internal name, a wrong scheme, or a wrong port.
Loopback survives only where it is honest: the desktop site install
(`DEPLOYMENT_ROLE=site`) and non-production development.

## Why this exists (issue #1062)

`/open` used to build the receiver URL as
`new URL('/api/auth/company-handoff?token=…', request.url)`. Inside a route
handler `request.url` is the **container's** origin — `http://localhost:3000`
behind a TLS-terminating proxy — so the browser was redirected to a loopback
host only it could not open (`ERR_CONNECTION_REFUSED`), with a fresh two-minute
credential already minted for an unreachable destination. The receiver had the
mirror problem: its post-redemption `Location` was built from a raw
`X-Forwarded-Host`, a client-controllable header.

## Environment contract

| Variable | Role | Trust implication |
|---|---|---|
| `ROOT_DOMAIN` | The public root zone; presence turns host tenancy on. Must be a bare DNS name (no scheme/port/path). | Values naming loopback/internal zones are refused in production. |
| `SUBDOMAIN_ROUTING` | `off` (or `false`/`0`/`no`) forces single-host mode even with `ROOT_DOMAIN` set. | — |
| `TRUST_FORWARDED_HOST` | `on` says: my proxy **overwrites or filters** `X-Forwarded-Host`, so it names the browser's host. | **Trust boundary — not a default flip.** Off by default: `Host` is the truth (Traefik-style, Host-preserving proxies). Turn on only when the platform is the sole route in (managed edges that rewrite `Host` to an internal name). A caller who can reach the app *directly* can otherwise spoof the header. |
| `PUBLIC_ORIGIN` | Optional explicit browser-facing origin: `https://host[:port]` and nothing else — no path, query, credentials. | The operator's pinned answer when the proxy contract cannot be inferred. Overrides request headers entirely on the handoff path. |
| `DEPLOYMENT_ROLE` | `site` marks the desktop/single-site install where localhost is the real origin. | The only role where internal origins are legitimate in production. |
| `NODE_ENV` | `development` is treated as explicitly local. | `production` central deployments enforce the reachability rules. |

`X-Forwarded-Proto` is honoured when its first hop is `http` or `https` (the
product-wide `preferredProto` contract — every shipped proxy sets it). A value
that claims to be a scheme and is neither **fails closed** rather than falling
back to the container's http. In production central, a destination that still
resolves to plain `http` is refused: session cookies are `Secure` there anyway,
so a mixed-scheme redirect would only strand the user.

### The two supported proxy shapes

| Proxy shape | `TRUST_FORWARDED_HOST` | Result |
|---|---|---|
| **Traefik / nginx preserving `Host`** (browser's Host reaches the app, proxy sets `X-Forwarded-Proto`) | `off` (default) | Correct `https://{subdomain}.{ROOT}…` Locations from `Host` + proto. |
| **Managed edge rewriting `Host`** to an internal name like `web-1234.internal:3000`, browser host in `X-Forwarded-Host` | `on` | Correct Locations from the forwarded host, under the documented trust boundary. |
| Managed edge rewriting `Host`, trust **off**, no `PUBLIC_ORIGIN` | — | **Fails closed** with `forwarded_host_untrusted` *before minting* — the #1062 shape, now an actionable operator error instead of a loopback redirect. |

Spoofed or untrusted `X-Forwarded-Host` is ignored when trust is off (the
`Host` header decides, exactly as for the tenancy check in middleware);
spoofed/garbage `X-Forwarded-Proto` fails closed; unknown `ROOT_DOMAIN` shapes
and malformed subdomains fail closed.

## Failure codes

Emitted as `handoff_error` back to the console (which explains them in
Persian), and as a `platform_company` structured log line
(`handoff.origin_rejected`) carrying only the code and the app key.

| Code | Meaning | Operator fix |
|---|---|---|
| `forwarded_host_untrusted` | The only trusted host is internal, but `X-Forwarded-Host` carries a public one | Set `TRUST_FORWARDED_HOST=on` **if** the proxy overwrites/filters the header, or set `PUBLIC_ORIGIN`, or make the proxy pass the browser's `Host` |
| `request_host_internal` | Resolved request host is loopback/private/container-internal | Fix proxy `Host` handling or set `PUBLIC_ORIGIN` |
| `origin_insecure` | Production destination resolved to plain `http` | Make the TLS proxy send `X-Forwarded-Proto: https` (or set `PUBLIC_ORIGIN=https://…`) |
| `forwarded_proto_invalid` | `X-Forwarded-Proto` first hop is not http/https | Fix the proxy's header |
| `public_origin_invalid` / `public_origin_insecure` / `public_origin_internal` | `PUBLIC_ORIGIN` malformed / `http` in production / internal host | Correct or remove the pin |
| `root_domain_missing` / `root_domain_invalid` / `root_domain_internal` | `ROOT_DOMAIN` unset (with host tenancy on) / malformed / internal zone | Set a real public zone |
| `request_host_missing` | No `Host` at all | Proxy misconfiguration |
| `request_host_outside_root` | Host tenancy on, request host not under `ROOT_DOMAIN` | Wrong vhost/DNS entry |
| `subdomain_invalid` | The company's subdomain is not a DNS label | Data repair in Platform Management |

The receiver and the impersonation handoff answer `origin_unreachable` (with
the `reason` code) **before redeeming**, so a spoofed request never spends the
one-use credential.

## Credential hygiene

* Every handoff response (redirects *and* error bodies) carries
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer` — the receiver
  URL holds the token in its query string, and `no-referrer` stops that URL
  from leaking as a `Referer` on the very next hop.
* Tokens are never logged. Structured logs carry codes, app keys, and ids;
  never `Location` values or token-bearing URLs. Redact them in any diagnostic
  capture too.
* Residual exposure: a query-string credential does land in browser history
  for the two minutes it could have worked. The token is single-use, expires in
  two minutes, and is stored hashed — see `platform_company_handoffs` in
  `src/lib/platform-company.ts`. If a token-bearing URL is ever pasted into a
  ticket or screenshot **with the token still unexpired**, wait out the two
  minutes or clear the row (`platform_company_handoffs`) and re-click the
  button; a fresh handoff mints a fresh token. Never repost the raw URL.

## Sibling audit (redirect construction only)

| Route | Finding | Status |
|---|---|---|
| `GET /api/auth/company-handoff` | Post-redemption `Location` from raw `X-Forwarded-Host` | **Fixed** — validated origin from the shared policy, resolved before redemption |
| `GET /api/auth/impersonate-handoff` | Same `X-Forwarded-Host` construction | **Fixed** — same policy; the impersonation *grant* model, capability checks and revocation semantics are deliberately untouched (different permission model) |
| `GET /api/host/redirect` | `X-Forwarded-Host ?? Host` gave a direct caller an open redirect (`/login` hop) | **Fixed** — host source is now the trust-aware `requestHost` |
| Support-session entry (`GET /api/support-access`) | Builds no server-side redirect origin at all — hands the client a validated same-site return *path* (`supportSessionReturnPath`) | Nothing to fix: no internal-origin or forwarded-header construction exists in this permission model |
| `src/middleware.ts` `redirectToLabel` | Takes only the *port* from `x-forwarded-host` under the same pattern | Noted; the label target is always `*.{ROOT_DOMAIN}` so impact is limited to the port component — revisit with middleware's own test surface |
| `src/lib/desktop-link-service.ts` `originFromHeaders` | Prefers forwarded headers | Deliberately lenient: the value is *displayed for a person to copy*, never decides a boundary (documented there) |

## Troubleshooting the #1062 symptom

Click «ورود به فضای کاری من», and either:

1. **The console shows a red error naming a setting** — the policy refused to
   mint. Match the code above; nothing was issued, nothing to clean up.
2. **The browser navigates to `http://localhost:3000/...` or an internal
   name** — you are running a build older than this fix. Verify
   `GET /api/health` reports the expected SHA (see
   [production-deployment-verification.md](../deployment/production-deployment-verification.md))
   and redeploy the matching image.
3. **Redirect works but lands on `wrong_origin` / `invalid_or_expired`** —
   subdomain or token mismatch (host tenancy requires the company's own
   host), or the two-minute token expired mid-click. Click again.

Before changing code, capture a **redacted** chain from the public Superadmin
URL: response status + `Location` with the token redacted, the public request
origin, `Host`, `X-Forwarded-Host`/`X-Forwarded-Proto` presence (values
redacted where they embed internal names), `ROOT_DOMAIN`,
`SUBDOMAIN_ROUTING`, `TRUST_FORWARDED_HOST`, `DEPLOYMENT_ROLE`,
`PUBLIC_ORIGIN`, and the deployment's image/commit SHA. Never capture or
persist a raw token.
