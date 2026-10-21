# Security Audit — `cafe-restaurant-pos` (Business Suite)

**Date:** 2026-09-22
**Scope:** Full application layer — frontend (Next.js 15 App Router, React 19, Electron shell, WordPress plugin), backend (custom `server.ts`, 649 API route handlers, `src/lib/*` services), database configuration (PostgreSQL 16, RLS, migrations), authentication & session management, and infrastructure/deployment config (Dockerfile, docker-compose × 4, Caddyfile, GitHub Actions, Traefik labels).
**Commit audited:** `63e9632` (`arena/01a0c9f0-cafe-restaurant-pos` branch).

> **History caveat:** this checkout contains a single squashed commit, so git-history secret scanning was limited to the current tree (plus `git log --diff-filter` on env files, which showed only `*.example` files were ever added).

---

## Verdict at a glance

| Severity | Count |
|---|---|
| Critical | 0 |
| Medium | 3 |
| Low | 8 |
| Informational | 3 |

No critical issues were found. This codebase has clearly been through several internal security-hardening passes (Phase 17/24 reviews are referenced in comments, and there are dedicated `tenant-isolation`, `auth-lockout`, and `first-run-guard` integration tests). The findings below are residual hardening gaps, not systemic weaknesses.

---

## MEDIUM severity

### M1. Content-Security-Policy ships in **report-only** mode in every deployment configuration

**Where:** `src/lib/security-headers.ts` (lines 3–9) and `src/middleware.ts` (lines 1056–1059).

```ts
// src/lib/security-headers.ts
export function cspMode(): CspMode {
  const mode = process.env.CSP_MODE;
  if (mode === "off" || mode === "enforce") { return mode; }
  return "report-only";          // ← the default
}

// src/middleware.ts
if (mode === "enforce") {
  response.headers.set("Content-Security-Policy", cspStr);
} else if (mode === "report-only") {
  response.headers.set("Content-Security-Policy-Report-Only", cspStr);
}
```

**Why it's a risk:** None of the shipped deployment configs set `CSP_MODE` — not `.env.example`, `docker-compose.yml`, `docker-compose.srv1.yml`, `docker-compose.local.yml`, nor `archive/deploy/docker-compose.komodo.yml`. Every production deployment therefore emits `Content-Security-Policy-Report-Only`, which **browsers do not enforce**. If an XSS is ever introduced (a future `dangerouslySetInnerHTML`, a dependency compromise, a browser extension on a shared till), the nonce-based `script-src 'self' 'nonce-…' 'strict-dynamic'` policy that would contain it is inert. The project's own Phase-24 doc (`docs/phases/Phase-24-Security-Hardening-Data-Protection.md`, line 547) flags “flipping `CSP_MODE` to `enforce`” as deferred work.

**Fix:**
1. Collect and review CSP reports from a staging/production window (the report-only mode exists precisely for this).
2. Set `CSP_MODE=enforce` in `docker-compose.srv1.yml`, `docker-compose.local.yml`, `archive/deploy/docker-compose.komodo.yml`, and document it in `.env.example`.
3. Consider refusing to boot in production with `CSP_MODE=off` (mirroring the existing `JWT_SECRET` strength check in `src/lib/jwt-secret.ts`).

---

### M2. SVG uploads are validated with a bypassable **blocklist**, not a sanitizer

**Where:**
- `src/lib/media.ts` lines 74–80 (`hasMatchingMediaSignature`, media library uploads), and
- `src/lib/business-logo.ts` lines 52–57 (`hasMatchingLogoSignature`, receipt/invoice logo).

```ts
if (mimeType === "image/svg+xml") {
  const head = new TextDecoder().decode(bytes.slice(0, 1024)).toLowerCase();
  if (!head.includes("<svg")) return false;
  const whole = new TextDecoder().decode(bytes).toLowerCase();
  return !whole.includes("<script") && !whole.includes("onload=") && !whole.includes("<foreignobject");
}
```

**Why it's a risk:** The check only rejects three literal substrings. An SVG can still be stored containing `onclick=`, `onmouseover=`, `onbegin=` (SVG animation events), `<animate xlink:href="…">`, `<use href="…">`, `javascript:` URIs, HTML-entity-encoded variants (`&#60;script`), or external references — any of which is executable active content in the right context. The *current* mitigations are good (see below), but they are context-dependent, and the parse-level control is the weakest link if a future consumer renders the stored bytes differently.

**Existing mitigations (why this is Medium, not High):** the media route (`src/app/api/media/[id]/file/route.ts`, lines 44–54) forces SVG to `application/octet-stream` + `Content-Disposition: attachment`, and the logo is only ever consumed as a `data:` URL inside an `<img>` (a browser context where scripts and external references are disabled). Documents are also role-gated.

**Fix:** Replace the substring blocklist with allowlist sanitization at upload time — e.g. run the SVG through DOMPurify (server-side, SVG profile) or an equivalent parser that keeps only a safe element/attribute set, then store the *re-serialized* output. Alternatively, drop `image/svg+xml` from `LOGO_MIME_TYPES` / `IMAGE_MIMES` entirely — a 160 px thermal-printer logo gains nothing from vector format that a 2× PNG wouldn't.

---

### M3. SSRF guard is vulnerable to DNS rebinding (check-then-fetch race) — self-acknowledged

**Notification sink remediation (#931):** Web Push now uses a provider allowlist plus a validated, address-pinned HTTPS transport (`src/lib/notification-transport.ts`) that never follows redirects. Register/test APIs are durably throttled. See `docs/notifications-audit-931.md` for coverage and rollout caveats. The historical analysis below still applies to the generic helper and is not a claim that other URL-fetching subsystems are fixed.

**Where:** `src/lib/ssrf.ts` (`assertPublicHttpsUrl`), consumed by `src/lib/notifications-service.ts` lines 221 (device registration) and 630 (pre-send re-check).

**Why it's a risk:** The guard resolves the hostname and requires *every* address to be publicly routable — but `fetch()` then resolves the name **again** at connect time. A DNS zone under attacker control can answer the guard's lookup with a public IP and the browser-of-the-server's actual connect microseconds later with `10.0.0.5`/`169.254.169.254`. The file's own header comment documents exactly this gap (“Closing that needs the connection pinned to the address that was checked”). The reachable sink matters: **any signed-in staff member** (including a `kitchen` role) can register a Web Push "endpoint", and the server POSTs to it from inside the deployment network — where Postgres, LiteLLM, OpenObserve and the cloud metadata endpoint live. The pre-send re-check shrinks the race window from “whenever the attacker updates their zone” to microseconds, but does not close it.

**Fix:** Pin the connection to the address that was validated. Concretely: perform the DNS resolution yourself, validate it with `isPrivateAddress`, then issue the request through an `undici` `Agent` with a custom `connect`/`lookup` hook that refuses any address not in the validated set (or connect by IP with the original `Host` header / SNI set). Apply the same dispatcher to both notification fetch sites.

---

## LOW severity

### L1. AI image-enhancement downloads a provider-chosen URL with no SSRF check at all

**Where:** `src/lib/ai-media-service.ts` line 210:

```ts
const dl = await fetch(parsed.url, { signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS) });
```

**Why it's a risk:** `parsed.url` comes from the AI provider's chat-completions reply (`parseImageEditReply` in `src/lib/ai-media.ts`). Unlike the push endpoints, this fetch has **no** `assertPublicHttpsUrl` check — only a 12 MB cap and timeout. The base URL is platform-admin configured (semi-trusted), so exploitation requires a compromised or hostile gateway/provider — but that is precisely the kind of upstream this guard exists for elsewhere, and a successful abuse turns the app server into an internal-network HTTP client.

**Fix:** `const target = await assertPublicHttpsUrl(parsed.url); if (!target.ok) throw new MediaAiError("ai_reply_invalid", …);` before the download.

### L2. First-run "test connection" probe fetches arbitrary user-supplied http(s) URLs

**Where:** `src/app/api/setup/pair/test/route.ts` lines 27–48 + `src/lib/connection-code.ts` `normalizeServerAddress` (accepts any http/https host, including private IPs).

**Why it's a risk:** A session-less caller can make the server issue a GET to any `http://`/`https://` origin (explicit `http://` is deliberately allowed for LAN pairing) and observe timing/error differences — an internal port scanner with one hop. Mitigated by `hasAnyUser()` (line 27): the route 409s on any initialized install, so the window is only an empty first-run database, and the response only reports protocol shape.

**Fix:** Reuse `isPrivateAddress` from `src/lib/ssrf.ts` to refuse loopback/RFC-1918/link-local targets in `normalizeServerAddress` (or at least in this route), even while the install is uninitialized.

### L3. Weak default seed credentials with no environment guard

**Where:** `scripts/seed.ts` lines 24 and 104 (defaults `owner1234` / cashier PIN `1234`), documented in `README.md` lines 60/65 and `.env.example` line 258; plus dev `docker-compose.yml` (`POSTGRES_USER: pos / POSTGRES_PASSWORD: pos` — bound to `127.0.0.1:5432` only).

**Why it's a risk:** `npm run db:seed` is manual, but nothing stops it being run against a production database: it would create an Owner account with a publicly documented password (bcrypt-hashed, but the plaintext is in the public repo). The dev Postgres superuser pair is loopback-only and the app *refuses* to run in production against a superuser/`BYPASSRLS` connection (`src/lib/db.ts` `assertRlsEffective`, and the entrypoint provisions a restricted `pos_app` role), so the docker-compose defaults are contained.

**Fix:** In `scripts/seed.ts`, refuse the default password/PIN when `NODE_ENV=production` or when the database already contains real (non-seed) businesses, mirroring the bootstrap route's `already_initialized` refusal.

### L4. Dev dependency vulnerability: `vitest` / `@vitest/mocker` (GHSA-82fw-gwwq-j7x9, moderate)

**Where:** `package.json` devDependencies (`vitest ^3.2.7`); `npm audit` reports 2 moderate (path traversal / arbitrary file read via redirect mock, CWE-22). `npm audit --omit=dev` → **0 vulnerabilities** in the production dependency tree.

**Why it's a risk:** Dev-only — relevant only if CI executes tests over untrusted fixtures/branches, which this repo's workflows do not (no `pull_request_target` found in `.github/workflows/`).

**Fix:** Bump `vitest` to ≥ 4.1.11 (a major version bump; `fixAvailable: vitest@5.0.1`) when the test-suite migration is convenient.

### L5. `/api/host/resolve?debug=1` echoes internal routing metadata unauthenticated

**Where:** `src/app/api/host/resolve/route.ts` lines 40–55 — publicly listed in middleware `PUBLIC_PATHS`.

**Why it's a risk:** The `debug=1` query parameter makes the route echo the raw `Host` / `X-Forwarded-Host` headers, the `TRUST_FORWARDED_HOST` decision, root domain, and subdomain-routing state — including the platform's internal container hostname. The route's own comment concedes “the one new fact it can reveal is the platform's internal hostname for the container.” On its own it's reconnaissance aid, not a breach; combined with M3-class issues it maps the internal network for an attacker.

**Fix:** Gate `debug=1` behind a platform-admin session (the route already imports nothing that prevents a cheap check), or strip the debug block when `NODE_ENV=production` and `TRUST_FORWARDED_HOST` is unset.

### L6. CSP directives weakened: `img-src http: https:` and `style-src 'unsafe-inline'`

**Where:** `src/lib/security-headers.ts` lines 55, 61.

**Why it's a risk:** Once CSP is enforced (see M1), `img-src` allowing **any** http/https origin permits image-based data exfiltration of page content and keeps mixed-content images possible on plain-HTTP deployments; `'unsafe-inline'` styles blunt CSP's protection against style-based exfiltration and injection. Both are documented, deliberate trade-offs (CMS/WordPress remote media thumbnails; Tailwind inline styles) — recorded here because they materially dilute the policy.

**Fix:** Move to `img-src 'self' data: blob: https:` plus an explicit allowlist of the connected CMS/WordPress hosts (the app already stores per-business CMS origins), and plan a nonce-based `style-src` once the design system allows it.

### L7. Rate-limit key derivation depends on proxy configuration; falls back to a shared `ip:unknown` bucket

**Where:** `src/lib/rate-limit.ts` `clientIpFrom` (`TRUSTED_PROXY_HOPS` default `1`; returns `"unknown"` when no `X-Forwarded-For` is present).

**Why it's a risk:** If the app is ever reached *without* its expected proxy chain, all unauthenticated callers share one login bucket (`AUTH_IP_LIMIT = 20/min`): an attacker can exhaust it to DoS logins for everyone, or — if `TRUSTED_PROXY_HOPS` is set wrong for the real chain — pick a spoofable position in the XFF list and rotate limiter keys past the brute-force ceiling. The code comments acknowledge the shared-bucket case; production compose files keep the app loopback-published behind a proxy, which contains it.

**Fix:** Document `TRUSTED_PROXY_HOPS` in `.env.example` with per-deployment guidance (it is currently only described in code), and have the server log a startup warning when it sees requests with no `X-Forwarded-For` while `NODE_ENV=production`.

### L8. Production infrastructure hostnames disclosed throughout the public repository

**Where:** ~190 references to `eshobe.com` / `eshobe.app` (e.g. `pos.eshobe.com`, `srv1.eshobe.com`, `updates.eshobe.app`, `cms.eshobe.com`) across `README.md`, `docs/`, `docker-compose.srv1.yml`, `.env.example`, and the WordPress plugin's hard-coded update manifest URL.

**Why it's a risk:** Public documentation of the production central server, super-admin console host, CMS host, and update server gives an attacker a pre-mapped target list (and the WordPress plugin's update endpoint is a high-value supply-chain target whose manifest host is now publicly known).

**Fix:** Replace real hostnames with placeholders (`pos.example.com`) in README/docs/compose committed to the public repo; keep real values in the private deployment environment. Consider making `POS_CONNECTOR_UPDATE_URL` a constant an operator sets rather than a hard-coded production URL.

---

## INFORMATIONAL (no action strictly required)

- **I1 — Privileged DB URL kept in app process env.** `docker-entrypoint.sh` exports `BACKUP_DATABASE_URL` (the superuser/owner connection) into the app process for `pg_dump`. Runtime queries use the restricted `pos_app` role, but any RCE in the process would find dump-grade credentials in the environment. Standard trade-off; consider a sidecar/one-shot container for backups instead.
- **I2 — Trusted-proxy toggles degrade boundaries by design.** `TRUST_FORWARDED_HOST=on` (Runflare/PaaS deployments) makes the origin/tenancy check rely on a spoofable header; `ALLOW_LEGACY_SYNC_TOKEN=1` re-enables a shared bearer token for server sync. Both default off, both loudly documented in `.env.example` — flagged so they appear on any deployment checklist.
- **I3 — Legacy `REMOTE_SYNC_TOKEN` warning.** `server.ts` logs a warning when the legacy token is set without the opt-in; good. Keep refusing it by default.

---

## Verified strengths (coverage of the requested categories)

For each audit category, what was checked and what passed:

**1. Secrets & credentials**
- `.gitignore` covers `.env`, `.env.local`, `.env*.local`; only `*.example` env files are tracked; `git log --diff-filter=A` confirms no real env file was ever committed. `.dockerignore` excludes all env files from the image.
- No hardcoded API keys/tokens/private keys found in the tree (regex sweep for `sk-`, `AKIA`, `AIza`, `ghp_`, `xox`, PEM blocks — one match, the AWS documentation example key `AKIAIOSFODNN7EXAMPLE` in a test fixture).
- `JWT_SECRET` placeholder is refused outright; production requires ≥ 32 chars (`src/lib/jwt-secret.ts`). Docker build passes a throwaway secret inline on a single `RUN` (not baked into layer metadata — explicitly done to avoid `docker history` leakage).
- Secrets that must be stored in DB are encrypted at rest (`platform_sms_config.api_key_enc`, `platform_cms_config`, field-level encryption via `POS_MASTER_KEY` + per-business DEKs); API keys and sync tokens are stored only as SHA-256 hashes; MFA recovery codes as bcrypt.

**2. Authentication & authorization**
- All non-public routes pass a middleware session gate (`src/middleware.ts` `handleTenantAuth`); the public list is explicit and commented, and prefix matching is segment-safe (`/api/v1evil` does not match `/api/v1`).
- Route handlers layer `requireRole`/`requirePermission`/`requireManager`/scope checks (1130 call sites); the public `/api/v1` API authenticates via hashed bearer keys with explicit `ApiScope` grants.
- Tenant isolation is enforced twice: Postgres **row-level security** keyed on `app.business_id` (set on every pool checkout, `src/lib/db.ts`) under a restricted runtime role — with a production startup refusal against `BYPASSRLS`/superuser connections — plus host-based isolation comparing the host label to the signed `businessSubdomain` claim in Edge middleware, failing closed. Dedicated `integration/tenant-isolation.integration.test.ts` exists.
- IDOR spot-checks (media reads, orders, CRM, devices, team) all scope by `session.businessId`/`locationId` from the verified token, not from client input. Impersonation sessions are re-checked live against their grant and forced read-only for mutations at middleware level.

**3. Session & token management**
- Passwords/PINs/recovery codes: **bcrypt, centralized cost 12** (`src/lib/password-hashing.ts`); dummy-hash comparison defeats user-enumeration timing on all three login surfaces (tenant, platform, apex directory).
- JWTs: HS256 explicitly pinned (no algorithm confusion), per-realm HKDF-derived keys, mandatory `realm` claim in both directions, previous-secret rotation support, 12 h expiry. Password sessions carry `tokenVersion` re-checked against `platform_users`; PIN sessions carry `employee_sessions` rows re-checked live (revocation works before expiry).
- Cookies: `httpOnly`, `sameSite: "lax"`, `secure` in production, no `domain` attribute (host-scoped per-business — the tenant boundary). New token minted at each login (no fixation). Mutating `/api/*` requests require a same-host `Origin` header (CSRF), with the `X-Forwarded-Host` trust handled through the audited `requestHost` helper.

**4. Input validation & injection**
- SQL: parameterized queries throughout; the handful of dynamic fragments reviewed (`crm-lead-service.ts` filter builder, `menu-service.ts`/`delivery-service.ts` SET builders, `platform-backup-service.ts` table list, `restore-engine.ts` identifiers) use whitelisted column/table names or `quoteIdentifier`; `LIMIT/OFFSET` clamped; `ILIKE` wildcards escaped.
- XSS: no `dangerouslySetInnerHTML` anywhere; React auto-escaping; markdown rendering via `react-markdown` (no raw HTML); CSV exports carry a formula-injection guard (`src/lib/data-transfer/codecs.ts` `csvCell`).
- Command injection: only `src/lib/pg-tools.ts` spawns processes — fixed binary paths, argument arrays, production refusal of env overrides, SHA-256 provenance manifest verification of packaged tools.
- Deserialization: JSON only; `xlsx`/CSV parsed through bounded, typed parsers with size caps.

**5. SSRF** — `assertPublicHttpsUrl` (literal + full DNS resolution, IPv4-mapped-IPv6 aware) guards the push-endpoint sink at registration *and* re-checked immediately before send. Residual gap = M3; unguarded sinks = L1/L2.

**6. Network & transport** — No `Access-Control-Allow-Origin: *` on any cookie-authenticated endpoint; the wildcard appears only on the MCP/OAuth family, which is bearer-token-only with `credentials` never allowed (documented and correct per MCP/OAuth 2.1). Security headers (`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `COOP`, `Permissions-Policy`, HSTS when HTTPS) applied in both middleware and `next.config.ts`; Traefik label config adds HSTS + admin-console IP allowlist (private ranges only); all production compose files publish the app on loopback only; TLS terminated at Traefik/Caddy.

**7. File uploads** — Media library: per-kind size ceilings (10/200/25 MB), MIME allowlist + byte-signature verification, tenant-scoped object keys with a fail-closed `keyBelongsToBusiness` check on every read, non-inline content served with `attachment` + `nosniff`, S3 credentials never reach the browser (bytes proxied through the app). Logo: 256 KB cap + signature check. Nothing is ever stored where it could be executed (S3/data-URL, not the filesystem).

**8. Rate limiting & abuse prevention** — Comprehensive: per-IP 20/min on every credential-exchange endpoint (login, PIN, WebAuthn, MFA, phone-OTP, pairing, signup, apex directory), per-employee and per-account lockout (5 fails/15 min tenant, 3/30 min platform — gated *before* the credential verdict to avoid a password oracle), per-business 300/min, per-token sync/plugin/peer buckets, per-key public-API and MCP buckets, OTP attempt burning with 5-minute TTL; counters are Postgres-backed (durable across restarts/replicas) with the internal counter route HMAC-authenticated and ceiling-capped.

**9. Dependencies** — `npm audit --omit=dev`: **0 vulnerabilities**; production tree clean. Dev-only vitest advisory → L4. `package.json` `overrides` pin `uuid`, `brace-expansion`, `@hono/node-server`, and Next's `postcss`/`sharp` — evidence of active dependency hygiene.

**10. Error handling & disclosure** — API errors return coded strings (`invalid_credentials`, `category_exists`, …); unexpected errors are re-thrown to Next's generic 500 (no stack traces in production); DB errors are mapped to named codes; `console.error` detail goes to server logs/OpenObserve only. Login responses are uniform to prevent enumeration.

**11. Cloud & infrastructure** — Postgres is never published to the host in any production compose file (dev compose binds `127.0.0.1` only); LiteLLM (holds every upstream vendor key) is compose-network-only behind a profile; the super-admin console is additionally IP-allowlisted at Traefik; the entrypoint drops from superuser to a restricted RLS-bound role before the server starts; container runs as non-root `node` user with `su-exec` privilege drop; GitHub Actions use `secrets.*`/`GITHUB_TOKEN` only, no `pull_request_target`; Electron shell runs `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, loopback-only backend, and a minimal frozen preload bridge; the WordPress plugin's self-updater requires HTTPS + same-host download URL + SHA-256 checksum, and all plugin↔server traffic is HMAC-SHA256-signed (timestamp + nonce + body hash) with `$wpdb->prepare`-parameterized queries, admin nonces, and escaped output.

**Next.js-specific:** App Router with middleware-edge auth, no `getServerSideProps` legacy, `output: "standalone"` with a hardened custom server (WS origin checks, error-safe socket handling), no `images.remotePatterns` wildcarding, dot-prefixed well-known routes rewritten explicitly.

---

## Recommended fix order

1. **M1** — flip `CSP_MODE=enforce` in production stacks after a report-review window (config-only change, immediate defense-in-depth win).
2. **M3 / L1** — add address-pinned fetching for push endpoints and an `assertPublicHttpsUrl` call before the AI enhance download.
3. **M2 / L2** — allowlist SVG sanitizer (or drop SVG), and private-address refusal in the first-run probe.
4. **L3–L8** — hygiene items at convenience.

---

> **Note:** This audit covers common application-layer and configuration risks based on a point-in-time review of the repository. It does **not** replace a professional penetration test and does not guarantee complete security — business-logic flaws, novel attack vectors, deployment-specific misconfigurations, and vulnerabilities in undiscovered code paths may still exist. Regular re-testing, dependency monitoring, and code review are recommended alongside this report.
