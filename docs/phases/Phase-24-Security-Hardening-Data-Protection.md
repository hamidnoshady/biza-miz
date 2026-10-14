# Phase 24 — Security Hardening & Data Protection

Tracked by GitHub issue [#228](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/228).

## Status: all five waves implemented; Wave 3 is at step 2 of its three-step migration

This document was written as the specification before any of it was built, and the rest of
it — file paths, function signatures, migration SQL — is still that original design. It has not
been rewritten wave-by-wave against what actually shipped, so read it as intent, not as a
record of the code.

What is actually true of the code today:

- **Waves 1, 2, 4 and 5** (perimeter/security headers, login lockout, MFA — TOTP and Kavenegar
  SMS OTP —, VPN-only/LAN HTTPS, and the Postgres-backed rate limiter) are implemented and
  covered by passing unit and integration tests against a real PostgreSQL 16/18.
- **Wave 2 is now complete end to end**, not just on the server: the login and platform-login
  screens carry the challenge/verify second step (`src/components/auth/mfa-step.tsx`), grace
  issues a real session and nags instead of blocking, recovery codes are issued and shown once
  at enrolment (and accepted on verify), the first-run and create-business flows show the TOTP
  QR once, `/platform/security` reads out who is enrolled and extends a single account's grace,
  the Kavenegar key has its own configuration page, and its `return.status` codes map to
  Persian.
- **Wave 3 (field-level encryption at rest) is implemented through step 2 of the three-step
  migration.** `POS_MASTER_KEY` / `POS_MASTER_PASSPHRASE` are read by `src/lib/master-key.ts`;
  `src/lib/business-keys.ts` mints and wraps a per-business DEK into `business_encryption_keys`
  (also minted inside `provisionBusiness`'s transaction);
  `migrations/0125_field_encryption_columns.sql` adds `*_enc`/`*_bidx` to `customers` and
  `reservations` with a blind index on the phone; `customers-service.ts` and the reservations
  routes dual-write and read the ciphertext with a plaintext fallback;
  `scripts/encrypt-fields.ts` (`npm run db:encrypt-fields`) is a real, idempotent, resumable,
  batched backfill; `src/lib/tenant-export.ts` decrypts on export; and
  `integration/field-encryption.integration.test.ts` asserts the registry against
  `information_schema.columns`.

  Two decisions were settled rather than deferred, because both get harder after step 3:

  - **Partial phone search.** A blind index does equality and nothing else, so encrypting
    `phone` ends substring search on it. Rather than accept that wholesale, `customers` carries
    `phone_last4` — the last four digits, plaintext and indexed — because reading the last four
    off a receipt is the actual workflow at a till, and losing it silently is the sort of
    regression noticed three weeks late. Arbitrary substring and *prefix* search are accepted
    as lost: `0912…` matches half an Iranian customer base. The cost is four digits per
    customer in a dump, beside a name that was already plaintext; four digits cannot be dialled
    or messaged. The full argument is in the migration header.
  - **`phone_e164` → `phone_bidx`.** Done now, not at step 3: `findDuplicates`
    (`crm-service.ts`) and the duplicate count (`crm-overview.ts`) match on
    `coalesce(phone_bidx, phone_e164)` — the same prefer-ciphertext-fall-back-to-plaintext rule
    the read paths use, expressed as a join, collapsing to `phone_bidx` alone when the
    plaintext columns go. Writing `phone_e164` also moved into `customers-service.ts`, which
    fixed a pre-existing bug on the way: `crm-service.syncCustomerPhone` had **never had a
    caller**, so a customer typed into the dashboard had a NULL canonical phone and was
    invisible to duplicate detection, segments and the SMS-reachable count until somebody ran
    `npm run db:normalize-phones` by hand.

  - **The lookups, and two shapes of phone match.** Every equality lookup on `phone_e164` now
    goes through one of two helpers exported by `customers-service.ts`, and the difference
    between them is deliberate. `phonePairKeySql(alias)` is *row to row* — the duplicate
    self-joins in `crm-service.findDuplicates` and `crm-overview` — and is
    `coalesce(phone_bidx, phone_e164)` on both sides, because the two rows are almost always in
    the same state and a transient miss costs one delayed merge suggestion.
    `phoneMatchSql(alias, $bidx, $e164)` is *input to row* — `ai-tools.findCustomersTool` and
    `integrations/sync-service.ts`'s two "is this shopper already here" probes — and prefers
    the blind index, falling back to `phone_e164` **only for a row that has no blind index
    yet**. A lookup compares a typed number against a row that may be mid-backfill, and a miss
    there does not degrade a suggestion: in the WooCommerce sync it creates a second copy of a
    real person. `phoneMatchKeys(businessId, phone)` computes both forms plus `last4` from one
    input. The sync's own writers now call `crm-service.syncCustomerPhone` after every
    `INSERT`/`UPDATE` of a plaintext phone, so a synced shopper is searchable immediately
    rather than at the next backfill.
  - **`with_mobile` / `sms_reachable` was a semantic bug, not a rename.** Both counted
    `phone_e164 IS NOT NULL`, which means "parses as an Iranian number" — a front-desk landline
    parses, and was being counted as SMS-reachable. `phone_bidx IS NOT NULL` would have
    preserved the bug (a landline gets a blind index too) while making it invisible. The fix is
    a classification column: `customers.phone_kind` (`mobile` | `landline` | `unknown`,
    CHECK-constrained, plaintext, nulled by the same invalidation trigger and filled by the
    same backfill), written from `phone.ts`'s existing `kind` on every service write. It is a
    policy classification rather than a number, so it is not PII on its own, and it is cheap:
    the alternative — decrypting every phone on the reporting path to count them — is not.
    `mobileReachableSql(alias)` reads it, falling back to the shape of `phone_e164` for rows
    the backfill has not reached, and yields NULL (uncounted) for a customer with no phone.

  **Step 3 — dropping the plaintext columns — has NOT happened, and prerequisites remain.**
  What is left, in order: `segments.ts`'s `consentPredicate("sms")` still gates a send on
  `c.phone IS NOT NULL AND btrim(c.phone) <> ''`, which is a plaintext read and, separately,
  the same landline question the counts just answered — the audience of a real SMS campaign,
  so changing who receives one is its own decision and not folded in here; the writers that
  still touch the plaintext directly (`crm-service.ts`'s merge, the Holoo import) should
  dual-write rather than lean on the invalidation trigger; and `ai-tools`' and
  `customers-service`'s `phone ILIKE '%…%'` disappears with the column, which is the accepted
  loss recorded above (`phone_last4` covers the till workflow, and only that). Tier A (the
  platform-scope secrets) is also still plaintext — see `TIER_A_PENDING` in
  `src/lib/encrypted-columns.ts`.

  **`migrations/0126_business_encryption_keys_rls.sql`** fixes a latent bug in 0072's
  scaffolding, found only once Wave 3 gave that table its first reader: its RLS policy omitted
  `app_rls_bypass()`, which every other tenant policy honours. On any install where the app
  connects as the unprivileged `pos_app` role — i.e. every correctly configured one, and not
  the docker-compose default where `pos` is a superuser and RLS is a silent no-op — minting a
  DEK under the platform bypass failed with "new row violates row-level security policy", which
  would have broken business creation outright once a master key was configured.

## Context: what exists today

The data this application holds is the most sensitive thing a business owns: the full
double-entry ledger, payroll, cost prices, customer PII, and — since Phase 21 — jewelry serial
numbers, weight attributes and consignor records.

Two boundaries are already sound, and **this phase does not touch either of them**:

- **The tenant row boundary.** Postgres row-level security with `FORCE ROW LEVEL SECURITY`,
  keyed on the `app.business_id` GUC, fail-closed, applied on every connection checkout by
  `installTenantScoping` in [`src/lib/db.ts`](../../src/lib/db.ts), and proven continuously by
  `integration/tenant-isolation.integration.test.ts`. Phase 12 made isolation a property of
  the database rather than of 99 correctly-written route handlers, and that is still true.
- **The browser origin boundary.** Phase 23 gave each business its own host, a session cookie
  with no `domain` attribute, and middleware that compares the real `Host` header against the
  JWT's `businessSubdomain` claim and fails closed.

Everything *around* those two boundaries is missing. Six concrete problems:

1. **There are no security response headers anywhere in the repository.** `next.config.ts` is
   `const nextConfig: NextConfig = {};` — no Content-Security-Policy, no HSTS, no
   `X-Frame-Options`, no `X-Content-Type-Options`, no `Referrer-Policy`, no
   `Permissions-Policy`. There is no Traefik headers middleware either, so nothing supplies
   them at the proxy. A grep across `.ts/.tsx/.yml/.js/.mjs` finds only a comment.

2. **Email/password, platform-admin and directory logins have no lockout.** Phase 20 built one
   for PIN logins (`lockoutStatus`, `src/lib/employee.ts:115-130`), enforced in
   `src/app/api/auth/pin-login/route.ts` and `src/app/api/auth/webauthn/login/verify/route.ts`.
   The password realms got nothing. Their only defence is the 20-requests-per-60-seconds
   per-IP bucket in `src/middleware.ts:159-160` — and that bucket is weaker than it looks:
   `clientIp` (`src/middleware.ts:176-180`) takes the **first** `x-forwarded-for` entry, which
   is entirely attacker-chosen, and Next 15 removed `request.ip`, so Edge middleware cannot
   see the socket peer address at all. On `docker-compose.local.yml` there is no proxy in
   front, so every LAN request's XFF is whatever the attacker types. **On the site box the
   limit is inert.**

3. **The legacy shared `REMOTE_SYNC_TOKEN` authenticates as any business.** Phase 17 moved
   server-sync to per-business SHA-256-hashed tokens in `server_sync_tokens`, but kept the old
   single env-var token as a fallback (`src/app/api/server-sync/push/route.ts:43-52`, and the
   same in `pull`). Its use is recorded by `recordLegacyTokenUsage` and flagged red in the
   dashboard, but never blocked. One leaked value reads and writes every tenant's sync stream.

4. **Local and USB backups are plaintext.** `src/lib/backup.ts:13-19` states it outright:
   "the cloud provider only ever stores ciphertext … local artifacts are plaintext and stay
   on-site." So the scheduled `pg_dump` in `BACKUP_DIR`, and its mirror in
   `BACKUP_SECONDARY_DIR` (the USB drive or NAS an owner is explicitly encouraged to plug in),
   are complete unencrypted copies of the ledger and customer table. `GET /api/backup/export`
   is likewise unencrypted, and sets no `Cache-Control`.

5. **Assorted hardening gaps.** The runtime container has no `USER` directive and runs as
   root, shipping the full dev dependency tree and source. One `JWT_SECRET` signs both auth
   realms. The `/ws` upgrade handler (`server.ts:113-132`) verifies the session cookie but
   skips the impersonation and `employee_sessions` re-checks that every HTTP route performs,
   so a revoked employee keeps their live feed until the token expires. `docker-compose.yml`
   publishes Postgres on `0.0.0.0:5432` with the `pos/pos` superuser.

6. **The on-premise deployment serves the café LAN over plain HTTP.**
   `docker-compose.local.yml` publishes port 3000 directly, and its own header comment already
   documents the consequences: a production `Secure` cookie is dropped by the browser over
   `http://`, and WebAuthn's secure-context requirement means Phase 20's biometric login can
   never run there. This is the deployment that matters most for a business that wants its
   data on its own premises.

### What "end-to-end encryption" can and cannot mean here

True zero-knowledge end-to-end encryption — where the server stores only ciphertext it can
never decrypt — is **incompatible with this application, and is explicitly rejected**. Every
report, the domain-event posting engine, ledger aggregation, the RLS predicates themselves and
the AI assistant all require the server to read the data. Adopting it would be a rewrite of
the entire product, not a hardening phase, and the resulting system could not produce a trial
balance.

What "encrypted end to end" means in this phase is that every link in the chain is protected
by the mechanism appropriate to it:

| Link | Protection | Wave |
|---|---|---|
| Device → server | TLS everywhere including the café LAN, over a VPN with no public port | 4 |
| Server → database | Restricted `pos_app` role, RLS-forced, loopback-only | already exists |
| Data at rest | Field-level encryption of designated sensitive columns | 3 |
| Site → central VPS | The VPS stores Tier A/B columns as ciphertext it holds no key for | 3 |
| Backups | AES-256-GCM on local, USB **and** cloud artifacts | 1 |
| Who may log in at all | Mandatory 2FA on every full-privilege account | 2 |

---

## Threat model

Three trust boundaries and seven adversaries. Kept deliberately small so it can be argued
with; an unfalsifiable threat model is decoration.

**B1 — browser origin.** `{subdomain}.$ROOT_DOMAIN` per business, `admin.$ROOT_DOMAIN` for the
console. Enforced today by the host-scoped cookie (`sessionCookieOptions`, `src/lib/auth-edge.ts`)
and `handleHostIsolation` (`src/middleware.ts:403-432`). *This phase adds* CSP `frame-ancestors`
and an Origin check on cookie-authenticated mutations.

**B2 — tenant row boundary.** Postgres RLS, forced, fail-closed, proven in CI. *This phase adds
nothing.* It is the part that is already right, and the correct response to a request to "make
tenants more isolated" is to say so rather than to add a second, weaker mechanism beside it.

**B3 — site ↔ central VPS.** The site box is the live brain; the VPS is a sync and disaster-
recovery layer that should not be able to read everything it holds. **This boundary does not
exist today** — the VPS reads all of it in cleartext. Waves 3 and 4 create it.

| # | Adversary | Capability | Mitigated today by | Residual risk this phase addresses |
|---|---|---|---|---|
| A1 | Malicious staff member | Valid PIN, physical till access | Role/permission guards, PIN lockout, revocable `employee_sessions`, audit log | `audit_log` records no IP or user-agent; a revoked employee's `/ws` feed survives up to 12h; the USB backup is a pocketable plaintext ledger |
| A2 | Another tenant | Valid session for business B, wants business A | RLS + origin isolation | Shared `REMOTE_SYNC_TOKEN` authenticates as any business; sibling-subdomain CSRF once `SUBDOMAIN_ROUTING=on` |
| A3 | Stolen till PC or café laptop | Full disk, offline, unlimited time | Nothing | Plaintext dumps in `BACKUP_DIR`/`BACKUP_SECONDARY_DIR`; plaintext Postgres data directory; `JWT_SECRET` and `DATABASE_URL` in `.env` on disk |
| A4 | Platform operator, or a compromised VPS | Root on the central box, full database read | Impersonation audit trail (advisory only) | Reads every tenant's customers, ledger and stored secrets in cleartext. **The adversary the on-premise decision is aimed at.** Wave 3 is its only real answer; Wave 2 stops a stolen password alone from reaching the console |
| A5 | Attacker on the café WiFi | On-path on the LAN | None on `docker-compose.local.yml` | Plain HTTP on `:3000` — session cookie readable, `Secure` dropped, WebAuthn unavailable |
| A6 | Internet scanner / credential stuffer | Unauthenticated, high volume | 20/min per spoofable IP | No lockout on password, platform-admin or directory login; no security headers |
| A7 | Lost USB drive or cloud backup | Ciphertext or plaintext at rest | Cloud artifacts are AES-256-GCM encrypted | Local and USB artifacts plaintext; `/api/backup/export` plaintext with no `Cache-Control: no-store` |

**Explicitly out of scope**, so that the model is falsifiable rather than aspirational:

- **A malicious Owner of a business.** They legitimately hold all of their own data; no
  technical control inside the product can change that.
- **A compromised Node process on the site box.** It must hold the data encryption key to
  function at all. Defending this needs an HSM, which is out of proportion here.
- **npm supply-chain compromise.** Wave 5 adds scanning, which is detection, not defence.
- **Physical coercion of a key holder.**

---

## Scope — Wave 1: Perimeter, credentials, artifacts

Selection rule for this wave: **severity at least high, effort at most about a day, and no new
data model.** Anything needing a key-management story, a table with a backfill, or an ops
runbook is deferred to a later wave. Nine items.

### 1. Security response headers

New `src/lib/security-headers.ts` — Edge-safe (no `node:` imports), pure, unit-tested:

```ts
export type CspMode = "off" | "report-only" | "enforce";
export function cspMode(): CspMode;                        // CSP_MODE, default "report-only"
export function generateNonce(): string;
export function contentSecurityPolicy(nonce: string, opts: { https: boolean }): string;
export function staticSecurityHeaders(opts: { https: boolean }): Record<string, string>;
```

Wired into **both** `next.config.ts` and `src/middleware.ts`, for a reason worth recording:
`next.config.ts`'s `headers()` does not apply to responses returned *from* middleware — and
this middleware returns many, including the 401/403/429 JSON bodies at `src/middleware.ts:182`,
`:361`, `:417` and `:568`, plus every redirect. Conversely middleware does not run for
`_next/static`, `favicon.ico` or `*.woff2|png|svg|ico`, which its matcher excludes
(`src/middleware.ts:585-590`). So: the static set goes in the config for the assets middleware
never sees, and the static set **plus the per-request nonce CSP** goes in middleware.

The static set is `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin`,
`X-DNS-Prefetch-Control: off`, a `Permissions-Policy`, and `Strict-Transport-Security:
max-age=31536000; includeSubDomains` **only when the request is HTTPS**.

The CSP is `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; script-src 'self' 'nonce-{n}' 'strict-dynamic'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:;
worker-src 'self'; manifest-src 'self'`, plus `upgrade-insecure-requests` on HTTPS.

#### Decisions

**`publickey-credentials-get=(self)` is set explicitly, not omitted.** Omitting the directive
happens to permit WebAuthn today, so the shortest correct `Permissions-Policy` would leave it
out. Naming it means a future edit that adds a blanket deny cannot silently kill Phase 20
Wave 3's biometric login — the directive is already there to be seen and updated.

**HSTS is emitted only on HTTPS responses, and never with `preload`.** The LAN install
(Wave 4 notwithstanding) can still be reached over `http://`, and an HSTS header served from
a box a browser also reaches by IP would poison that browser against the deployment. Rejected
alternative: unconditional HSTS, which is the common advice and is wrong for a product with an
on-premise HTTP mode.

**`style-src` keeps `'unsafe-inline'`.** `next/font/local` (`src/app/layout.tsx:8-13`) emits an
inline `<style>` element whose content changes per build, and `react-grid-layout` (used by
`src/app/dashboard/dashboard-grid.tsx`) writes `style` attributes at runtime. Neither can be
hashed. Rejected alternative: splitting into `style-src-elem 'self' 'nonce-…'` plus
`style-src-attr 'unsafe-inline'` — it still requires `'unsafe-inline'` for the attributes, so
it buys nothing but complexity. Inline *style* is a far weaker gadget than inline script, and
scripts do get a nonce.

**Scripts get a nonce plus `'strict-dynamic'`, which requires plumbing.** Next 15 reads the
nonce out of the `Content-Security-Policy` header on the **incoming request** and stamps it
onto its own inline bootstrap scripts, so middleware must set the CSP on the forwarded request
via `NextResponse.next({ request: { headers } })` as well as on the response. `next-themes`
injects its own inline script, so `src/components/theme-provider.tsx` must accept and forward
a `nonce` prop and `src/app/layout.tsx` must read it from `(await headers()).get("x-nonce")`.
Known consequence: that makes the root layout dynamic — acceptable, because every
authenticated page already reads `cookies()`.

**`CSP_MODE` defaults to `report-only`.** A CSP mistake is a white screen for a café in the
middle of service. The header name switches to `Content-Security-Policy-Report-Only` in that
mode. Flipping to `enforce` is a deliberate later step, listed in Wave 4's scope, taken only
after a manual pass over `/accounting/pos`, `/accounting/floor` and `/accounting/kitchen` with
devtools open reports zero violations.

**Wiring.** The existing `export async function middleware` (`src/middleware.ts:495`) is
renamed to `handle`, and a new exported `middleware` wraps it so that every return path —
`NextResponse.next()`, redirects, and JSON error bodies alike — has headers applied on the way
out.

### 2. Login lockout, generalized to the password realms

`lockoutStatus` (`src/lib/employee.ts:115-130`) is already a pure function over an event list.
Its only tenant-specific detail is the literal `"employee.login_failed"` at line 118.

New `src/lib/login-lockout.ts` carries the rule and its policies; `src/lib/employee.ts`
re-exports `lockoutStatus`, `LOGIN_LOCKOUT_THRESHOLD` and `LOGIN_LOCKOUT_WINDOW_MINUTES` with
their existing defaults so that every current importer is untouched.

```ts
export interface LockoutPolicy { threshold: number; windowMinutes: number; failedAction: string; }
export const EMPLOYEE_LOCKOUT_POLICY: LockoutPolicy;   // 5 / 15 — unchanged
export const PASSWORD_LOCKOUT_POLICY: LockoutPolicy;   // 5 / 15
export const PLATFORM_LOCKOUT_POLICY: LockoutPolicy;   // 3 / 30
export function lockoutStatus(events: LoginAttemptEvent[], policy?: LockoutPolicy, now?: Date): LockoutStatus;
```

New `migrations/0070_auth_login_attempts.sql`:

```sql
CREATE TABLE auth_login_attempts (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    realm        text NOT NULL CHECK (realm IN ('tenant_password','platform_admin','directory')),
    identity_key text NOT NULL,
    outcome      text NOT NULL CHECK (outcome IN ('failed','success','unlocked')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_login_attempts_lookup ON auth_login_attempts (realm, identity_key, id DESC);
```

DB half in `src/lib/login-lockout-service.ts`: `identityKeyFor`, `checkAuthLockout`,
`recordAuthFailure`, `recordAuthSuccess`, `clearAuthLockout`.

#### Decisions

**A new table rather than `audit_log`.** `audit_log.business_id` is `NOT NULL`
(`migrations/0001_foundation.sql:100`), and an email/password attempt happens before any
business is known. That is the whole reason the existing lockout only covers PIN logins, which
always occur inside a chosen business.

**No RLS policy, and that is deliberate.** The table carries no `business_id` or `location_id`
and holds no tenant data, so it joins the documented exempt list beside `platform_admins` and
`feature_flags`. It must be added to `EXEMPT_TABLES`
(`integration/tenant-isolation.integration.test.ts:34`) with a justification comment in the
existing style, or the isolation test fails at line 196 — and that failure would be correct,
not a test to weaken.

**No new `withoutTenantScope()` reason is required.** Because the table has no policy, a
normally-scoped connection reads and writes it; `/api/auth/login` already runs inside
`withoutTenantScope("login", …)` in any case. CLAUDE.md makes every bypass addition a reviewed
decision, so the absence of one is worth stating rather than leaving a reviewer to check.

**`identity_key` is an HMAC of the lowercased email, never the email itself.** This table is
readable by anyone who reaches the database, including adversary A4; storing raw addresses
would turn it into a harvestable account list. The pepper is `LOGIN_ATTEMPT_PEPPER`, defaulting
to an HKDF derivation from `JWT_SECRET` so that no existing deployment has anything new to
configure. Rejected alternative: plaintext emails for an admin UI's benefit — the tenant-side
security centre already lists locked employees by name, and the platform side does not need a
locked-account list badly enough to justify holding an email dump.

**A lockout is revealed only to someone who has proved the password.** The three password
routes (`src/app/api/auth/login/route.ts`, `src/app/api/platform/auth/login/route.ts`,
`src/app/api/auth/directory/route.ts`) must **not** short-circuit on `locked`. They run the
bcrypt comparison regardless — preserving the `DUMMY_HASH` timing-uniformity those routes
already implement — and only then branch: a wrong password returns the same 401
`invalid_credentials` as today, whether or not the account is locked, while a **correct**
password on a locked account returns 423 `account_locked` with `lockedUntil`. Rejected
alternative: returning 423 up front, which is what `pin-login` does. That is right *there*,
because `/api/auth/pin-login/roster` already lists a business's staff publicly so there is
nothing left to enumerate; it is wrong for a global email address, where an unconditional 423
would be a free account-existence oracle that undoes the `DUMMY_HASH` work at
`src/app/api/auth/login/route.ts:19`.

**IP attribution is improved but not fixed, and identity-keyed lockout is the real control.**
`clientIp` moves into `src/lib/rate-limit.ts` as `clientIpFrom(headers, trustedHops)`, reading
`TRUSTED_PROXY_HOPS` (default 1, matching the Traefik deployment; 0 for the LAN box) and taking
the XFF entry at `length - trustedHops` instead of the first. It cannot be made correct,
because Next 15 gives Edge middleware no access to the socket peer address at all.

### 3. The legacy shared sync token is denied by default

The duplicated fallback in `src/app/api/server-sync/push/route.ts:25-27,43-52` and
`src/app/api/server-sync/pull/route.ts:20-21,44-50` moves into `src/lib/server-sync.ts` beside
`tokensMatch`, as `legacySyncTokenAllowed()`, `legacySyncToken()` and `legacyTokenWarning()`.

Two behaviour changes:

1. **The default flips to deny**, re-enabled only by `ALLOW_LEGACY_SYNC_TOKEN=1`. This is safe:
   pairing has minted per-business tokens since Phase 17, `server-sync/update-check` and
   the site-scoped server-sync routes already run with no session fallback
   already shows a red banner to any deployment still on the legacy path.
2. **Even when re-enabled, the shared token may not act for a business that has its own.** After
   `eventsBusinessId` is resolved (`push/route.ts:103`), a legacy-authenticated request for a
   business with a row in `server_sync_tokens` is refused with 403 `legacy_token_superseded`.
   About five lines, and it closes the impersonation case even for a deployment that cannot
   migrate immediately.

`server.ts` prints a boot warning next to `describeDeploymentRole()` when `REMOTE_SYNC_TOKEN`
is set but the flag is not, so that an upgrade never silently breaks a working sync link.
`src/app/api/api-guards.test.ts:68-76`, `.env.example` and `docs/server-sync.md` are updated.

### 4. Per-realm JWT signing keys

**This is not a live forgery bug, and the phase must not claim one.** Both verifiers already
reject the other realm's tokens: `verifySession` checks `realm !== "tenant"`
(`src/lib/auth-edge.ts:131-142`) and `verifyPlatformSession` checks the realm *and* that
`padmin` is a string. The actual problems are that the separation rests on an application-level
claim check rather than on cryptography — one missed check anywhere and it collapses — and that
rotating `JWT_SECRET` logs out both realms simultaneously.

`src/lib/jwt-secret.ts` gains:

```ts
export type SigningRealm = "tenant" | "platform";
export async function getRealmSecret(realm: SigningRealm): Promise<Uint8Array>;
export async function getLegacySecret(): Promise<Uint8Array | null>;
export async function verifyWithRealmSecret<T>(token: string, realm: SigningRealm): Promise<T | null>;
```

`getRealmSecret` is HKDF-SHA256 over `JWT_SECRET` with info `pos.jwt.<realm>.v1`, cached per
isolate as a `Map<SigningRealm, Promise<Uint8Array>>`.

#### Decisions

**Derivation is async, and that costs nothing.** `node:crypto` is unavailable on the Edge
runtime, which middleware uses transitively through `auth-edge.ts`, but `crypto.subtle` is
available on Edge, Node 20 and the browser. `subtle.deriveBits` is async — and
`signSession`/`verifySession` and their platform counterparts are *already* async, so the
change is mechanical.

**Keys are derived, not configured.** `JWT_SECRET_TENANT` and `JWT_SECRET_PLATFORM` are honoured
as optional overrides, which is what makes real rotation possible in Wave 5, but neither is
required. Rejected alternative: requiring both. Every shipped compose file, CI, `.env.example`
and the Electron installer would have to change in lockstep or the app fails to boot — and the
standalone desktop install has nowhere for an operator to type one.

**A boolean grace flag is enough.** Verification tries the derived key, then falls back to raw
`JWT_SECRET` while `JWT_LEGACY_VERIFY !== "off"`. Tenant tokens expire in at most
`SESSION_HOURS` (12 by default) and platform tokens in 2, so no timestamped window is needed.
Wave 5 deletes the fallback. The existing production floor of 32 characters continues to apply
to the input secret.

### 5. Local and USB backups are encrypted

Much of this already exists: `scripts/restore.ts:180-185` sniffs the `POSBKP1\0` magic and
decrypts with `BACKUP_PASSPHRASE`, `ARTIFACT_RE` (`src/lib/backup.ts:189`) already tolerates a
`.enc` suffix, and `selectPrunable` matches it. The work is confined to
`src/lib/backup-service.ts` and the config shape.

**One trap, and it is the sharpest bug risk in this wave.** `cloudKeyFor`
(`src/lib/backup.ts:211-213`) unconditionally appends `.enc`, so an already-encrypted local
artifact would upload as `.dump.enc.enc` and `runCloudUpload` would encrypt it a second time.
`cloudKeyFor` must append only when the name does not already end in `.enc`, `runCloudUpload`
must guard with `isEncryptedBackup()`, and `src/lib/backup.test.ts` gets a case for each.

`BackupConfig` gains a top-level `passphrase` and `encryptLocal` (default `true`);
`cloud.passphrase` becomes a deprecated read-only fallback for configs written before the
change. A pure `backupPassphrase(config)` resolves top-level, then cloud, then
`BACKUP_PASSPHRASE`, then empty.

`runLocalBackup` encrypts **before** the final rename, so that the secondary copy is made from
the encrypted file — the USB drive never sees plaintext, which is the entire point of the item.
The recorded hash must cover the bytes actually written.

`GET /api/backup/export` gains `?encrypt=1` (409 `passphrase_required` when none is configured)
and, unconditionally on both branches, `Cache-Control: no-store` — that response is literally
all of a business's data. `scripts/restore-tenant.ts` gets the same magic sniff as
`scripts/restore.ts`.

#### Decisions

**`encryptLocal` defaults to on, and that is safe.** With no passphrase configured the code
writes plaintext and surfaces a visible warning, so no existing install's restore path breaks
on upgrade. The warning is surfaced through a new `warnings: string[]` on
`getBackupConfigMasked`, deliberately **not** through `computeBackupAlert` — that function
returns exactly one alert and its shape is pinned by existing tests.

**Key loss is now a bigger deal, so it must be said louder.** `docs/backup-restore.md` and the
Persian dashboard both need to state plainly that losing the passphrase now loses the local
backups too, not only the cloud copies.

### 6. The container stops running as root

Two traps, both of which break a real deployment if skipped.

**Named-volume ownership.** `pos-backups:/app/backups` is already root-owned on every existing
deployment, so a bare `USER node` in the Dockerfile would break backup writes on upgrade with
no migration path. Instead the entrypoint keeps starting as root, runs
`chown -R node:node /app/backups`, and hands off with `exec su-exec node "$@"` in place of
`exec "$@"` (`docker-entrypoint.sh:59`). The process still ends up unprivileged and the volume
repair is automatic and idempotent.

**`npm` and `npx` as a non-root user.** `docker-entrypoint.sh` runs `npm run db:migrate` and
`npx tsx scripts/derive-runtime-database-url.ts`, both of which want a writable `$HOME` and npm
cache. They become `./node_modules/.bin/tsx scripts/migrate.ts` and the equivalent — which also
removes an npm registry lookup from every boot, a real improvement on a café laptop with a
flaky connection.

Every runner-stage `COPY` gains `--chown=node:node`. Moving `tsx` into `dependencies` and
building with `npm ci --omit=dev` — the actual fix for "the runtime image ships the whole dev
tree" — is deferred to Wave 5.

### 7. The `/ws` upgrade re-checks revocation, and checks Origin

`server.ts:113-132` verifies the session cookie and nothing else, so a revoked impersonation
grant or a revoked `employee_sessions` row keeps its live feed until the JWT expires — up to 12
hours for a fired employee.

`src/lib/auth.ts` gains an exported `resolveSessionFromToken(token)` composing `verifySession`
→ `checkImpersonation` (line 32) → `checkEmployeeSession` (line 51), both of which are currently
unexported, and `getSession()` (lines 98-110) is rewritten to call it — so that there remains
exactly one definition of what a valid session is. The upgrade handler calls the new function
instead of `verifySession`, and additionally destroys the socket when the `Origin` header's host
does not equal the request `Host`. Electron is unaffected: its window loads
`http://localhost:PORT`, so origin and host match.

### 8. Origin check on cookie-authenticated mutations

The rule: **a mutating request that carries the session cookie must carry an `Origin` whose host
equals the request `Host`.** 403 `bad_origin` otherwise, behind `ORIGIN_CHECK` (default on).

This is a Phase 23 completion item rather than generic hygiene. `SameSite=Lax` already blocks
cross-*site* POSTs; the residual risk is a sibling subdomain, because `evil.$ROOT_DOMAIN` is
same-site as `acme.$ROOT_DOMAIN` — a risk that only materializes when `SUBDOMAIN_ROUTING=on`,
which is exactly where Phase 23 is heading.

Bearer-token callers (`/api/server-sync/*`, `/api/rollup/ingest`, `/api/v1/*`, `/api/host/*`)
are exempt **by construction**, because they carry no cookie. That is what makes the rule safe
to enforce by default rather than shipping it report-only: there is no allowlist that can go
stale. Before enabling, confirm that `electron/main.js` makes no
cookie-bearing POSTs without an Origin header. (The former `print-agent/` Node
service no longer exists — the till-side print connector is loopback PowerShell
and never talks to this app's server with a cookie.)

### 9. The development Postgres binds to loopback

`docker-compose.yml` publishes `"5432:5432"` with the `pos/pos` superuser — the exact role
`assertRlsEffective` refuses to run against in production. It becomes
`"127.0.0.1:5432:5432"`. Everything in development connects over loopback, so nothing is lost.

## Out of scope (this wave)

- **Flipping `CSP_MODE` to `enforce`.** Deferred to Wave 4, after a manual verification pass —
  see the decision above.
- **Durable rate limiting.** The in-process `Map`s at `src/middleware.ts:148-151` still reset on
  restart and multiply across replicas. Wave 5.
- **`tsx` → `dependencies` and `npm ci --omit=dev`.** Wave 5; item 6 makes the container
  unprivileged, which is the security half.
- **Session revocation for password logins.** Note that `requirePermission`
  (`src/lib/auth.ts:206-243`) already re-reads role, permissions and `is_active` from the
  database on every call, so deactivating a member already kills their session on
  permission-guarded routes; the gap is routes guarded by `requireRole` alone. Wave 5.

---

## Scope — Wave 2: Two-factor authentication (Kavenegar SMS OTP and TOTP)

A password alone — however well hashed — is one phishable secret between an attacker and every
business on the platform. This wave requires a second factor on every account that holds full
privileges, with **SMS OTP through Kavenegar as the default** and **Google Authenticator (TOTP)
as an optional alternative**.

**Who it applies to.** Every `platform_admins` row, because the console holds cross-business
power; and every business account with full privileges — the `owner` role, plus anyone
`requirePermission` resolves to a full permission set. Cashier and waiter PIN logins are
untouched: they already have lockout, device binding and revocable `employee_sessions`, and a
till cannot receive an SMS mid-service. A business may opt to extend the requirement to
`manager`; off by default.

| Method | Default | Long-lived secret? | Works without internet? |
|---|---|---|---|
| `sms_otp` — Kavenegar `verify/lookup` | **yes** | no; the OTP is short-lived and stored hashed | **no** |
| `totp` — RFC 6238, Google Authenticator | optional alternative | yes, a shared secret | yes |

An account may enrol one or both; when both, one is primary and the other is the fallback.

### Decisions

**A `deployment.mode = local` install forces TOTP.** The standalone desktop install and the
offline café box have no internet, so an SMS-only Owner would be locked out of their own POS
the first time the connection dropped. This follows directly from the on-premise posture the
phase is built around, and it is the single most likely way to ship this feature broken.

**Enrolment happens when the business is made.** `ProvisionBusinessInput`
(`src/lib/business-provisioning.ts:29-66`) gains `ownerPhone`, and `provisionBusiness` writes
the Owner's `sms_otp` enrolment in the same transaction — so a business has working 2FA from
the moment it exists, rather than depending on someone remembering to switch it on later.
Required by `validateProvisionBody` when `deploymentMode` is `connected`; for `local`,
provisioning returns a TOTP secret and QR for the wizard to display instead. Callers to update:
the first-run `/welcome` flow, public signup, and the `/platform` console's add-business form.

> **Trap:** the existing `phone` field (`business-provisioning.ts:33`) is the **location's**
> phone and is written to `locations.phone` (`migrations/0001_foundation.sql:57`). Reusing it
> would send one-time passwords to the café landline. `ownerPhone` is a separate, separately
> validated mobile number.

**Existing accounts get a grace period, then it is mandatory.** Making 2FA a hard requirement
on deploy would lock out every current Owner and platform admin simultaneously, and anyone
whose stored phone number is missing or wrong would need a super-admin to rescue them — with
nobody to rescue the super-admin. So `mfa_enrolments` carries `grace_until`, stamped at the
first login after deploy; `MFA_GRACE_DAYS` defaults to 14, and to **7 for platform admins**,
who are a small known set holding the most power. During the window login shows an enrolment
prompt with a "later" button and a visible countdown; afterwards enrolment is a hard gate
before the dashboard renders. `/platform` gains a readout of who is enrolled, who is in grace
and how long remains, and a super-admin may extend a single account's grace (audited) rather
than the whole platform's. The rule itself is a pure
`enrolmentRequirement(account, now) → not_required | grace | required` in `src/lib/mfa.ts`,
unit-tested — the same shape as `lockoutStatus`.

**The interstitial is a dedicated token, not a session.** After the password check and Wave 1's
lockout check succeed, an account that requires 2FA receives an `mfa_pending` token: its own
realm, roughly five minutes, carrying `sub` and `method` and **no role, `businessId` or
permission claim**, so that a stolen one grants nothing at all. It uses Wave 1's
`getRealmSecret("mfa")`, which is why the key split has to land first. Then
`POST /api/auth/mfa/challenge` sends the SMS (a no-op for TOTP) and
`POST /api/auth/mfa/verify` mints the real session exactly as today. Mirrored for
`/api/platform/auth/login`; deliberately not applied to `/api/auth/pin-login`.

**Anti-abuse is a first-class requirement, because every send costs money.** An unthrottled
challenge endpoint is both a financial denial-of-service against the platform and an
SMS-bombing vector against the Owner. Sends are limited to one per 60 seconds per identity,
five per hour and twenty per day, reusing Wave 1's `auth_login_attempts` machinery under new
realms rather than introducing a second mechanism. The OTP is six digits with a two-minute TTL,
single-use, invalidated after five failed verifications, stored as an HMAC and never in
plaintext, and compared with `timingSafeEqual` (matching `src/lib/server-sync.ts:122`). A failed
OTP counts toward the Wave 1 lockout streak.

**Recovery codes are mandatory, not a nicety.** If the only super-admin loses their phone, the
platform has no way back in. Ten single-use codes are issued at enrolment, bcrypt-hashed at
cost 10 to match the rest of the codebase, and shown exactly once, drawn from
`src/lib/code-alphabet.ts` (Phase 23's ambiguity-free alphabet) so that they read correctly off
paper. A platform admin may reset a *business* Owner's 2FA, audited; a super-admin's own reset
requires a recovery code or `scripts/reset-platform-mfa.ts`.

**Kavenegar's `verify/lookup`, not `sms/send`.** The endpoint is
`GET https://api.kavenegar.com/v1/{API-KEY}/verify/lookup.json?receptor=&token=&template=`,
returning `{ "return": { "status": …, "message": … }, "entries": [ … ] }`. The template is
pre-approved by the carrier, so the message body is not attacker-controllable and the traffic
is delivery-prioritised — which is also what Iranian carriers require for transactional SMS.
The `return.status` code table must be read from `kavenegar.com/rest.html` at implementation
time and mapped to Persian user messages; it was returning 503 while this phase was written, so
guessing it here would be worse than leaving it as a build-time task.

> **The API key sits in the URL path**, so any error path that logs a request URL leaks it.
> A `redactKavenegarUrl()` helper is mandatory and unit-tested, and the key is never
> interpolated into a thrown error message.

**Phone normalisation is load-bearing.** `09xxxxxxxxx`, `+989xxxxxxxxx` and `989xxxxxxxxx` must
all normalise to one canonical form or the OTP silently goes nowhere. Pure function in
`src/lib/phone.ts`, unit-tested across all three shapes plus Persian-digit input — the codebase
stores Latin digits, but a number typed on a Persian keypad still has to work.

**SMS configuration lives in `/platform`, not a business dashboard.** Per CLAUDE.md, anything
that administers clients across businesses belongs to the console. A new `platform_sms_config`
singleton takes the same shape and guards as `platform_ai_config` (`migrations/0039`), with the
API key stored encrypted and `KAVENEGAR_API_KEY` / `KAVENEGAR_OTP_TEMPLATE` as an operator
bootstrap fallback, exactly as the `AI_*` variables work today.

**Enrolment is stored globally, with no RLS policy.** MFA belongs to the *login identity* —
`platform_users` and `platform_admins`, both global tables — and the challenge happens before
any business has been chosen, the same reasoning that justified `auth_login_attempts`. So
`mfa_enrolments` joins `EXEMPT_TABLES` with the same justification.

```sql
CREATE TABLE mfa_enrolments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_realm text NOT NULL CHECK (subject_realm IN ('platform_user','platform_admin')),
    subject_id    uuid NOT NULL,
    method        text NOT NULL CHECK (method IN ('sms_otp','totp')),
    is_primary    boolean NOT NULL DEFAULT false,
    phone_e164    text,          -- sms_otp only
    totp_secret   bytea,         -- totp only; encrypted, never plaintext
    grace_until   timestamptz,
    confirmed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject_realm, subject_id, method)
);
```

Plus `mfa_challenges` (hashed OTP, expiry, attempt count) and `mfa_recovery_codes`.

**`totp_secret` is `bytea` and encrypted from its first migration.** A plaintext TOTP secret in
the database is a complete second-factor bypass for adversary A4 — the platform operator —
which is precisely the adversary this wave exists to defend against. It uses a dedicated
`MFA_SECRET_KEY` (a single AES-256-GCM key) rather than waiting for Wave 3's per-business DEK
hierarchy, because MFA enrolment is identity-level and global, so a per-business key is simply
the wrong shape for it. Wave 3 may fold it into the general mechanism later.

New files: `src/lib/{sms,sms-kavenegar,phone,mfa,mfa-service}.ts`,
`src/app/api/auth/mfa/{challenge,verify,enrol}/route.ts`, the same under
`/api/platform/auth/mfa/`, `src/app/api/platform/sms/route.ts`, the dashboard and console
enrolment UI in Persian, and the `business-provisioning.ts` change. `src/lib/sms.ts` defines a
`SmsProvider` interface with a `KavenegarProvider` and a `NoopProvider`, so that tests use a
fake and offline installs degrade cleanly. Libraries: `otplib` for TOTP and `qrcode` for the
enrolment QR — both pure JavaScript, and both used only in route handlers, never in middleware.

## Out of scope (this wave)

- **2FA for PIN logins.** See above; a till cannot receive an SMS mid-service.
- **WebAuthn as a second factor.** Phase 20 already ships it as a *primary* factor for
  employees; making it a second factor for Owners is a separate design.
- **SMS for anything other than login OTP** — no receipts, no marketing, no lockout
  notifications. Each is its own product decision with its own cost model.

---

## Scope — Wave 3: Field-level encryption at rest

The rule, which is the reusable part: **encrypt a column only if it is never used in a `WHERE`
range, an `ORDER BY`, a `GROUP BY`, or an aggregate. Equality-only lookup is permitted via a
blind index. Everything else stays plaintext.**

**Tier A — pure secrets, zero query impact. Start here.** `platform_ai_config.api_key`
(`migrations/0039:16`). The former `platform_update_config.s3_secret_access_key` (`0038:16`) was removed by migration 0187 together with the inactive updater config. The
secrets inside the `settings` JSONB: `backup.config.cloud.secretAccessKey`,
`backup.config.cloud.passphrase`, `server_sync.config.token`, `rollup.config.token`. These are
read once and used, never filtered, sorted or summed. This is the highest value-to-cost ratio
in the entire phase: a database dump today yields live S3 credentials and a live AI provider
key.

**Tier B — PII with an equality-lookup need.** `customers.phone`, `customers.address`,
`customers.notes`, `reservations.customer_phone`. `customers.phone` backs
`idx_customers_phone (business_id, phone)` for lookup at the till, so it gains `phone_enc bytea`
plus `phone_bidx text` — an HMAC under the per-business key, indexed. **Concrete loss: partial
and prefix phone search stops working.** Check `src/lib/customers-service.ts` for a
`LIKE '%…'` before committing to this; if one exists, that is a real regression to decide on
deliberately, not to discover after the migration.

**Tier C — never encrypt.** Every money `BIGINT`, every timestamp, every foreign key,
`orders.*`, `journal_entries` and `journal_lines`, roles, statuses, and `users.full_name`
(sorted in every roster). Encrypting any of them breaks the ledger, the reports and the trial
balance — which is the same reason zero-knowledge E2EE was rejected for the product as a whole.

**Keys are two-level and per business.** A KEK comes from the environment (`POS_MASTER_KEY`, or
scrypt-derived from a passphrase reusing `backup.ts`'s existing derivation shape; on the
standalone Electron install, `safeStorage.encryptString` — DPAPI on Windows — is its natural
home). Each business gets a 32-byte DEK, minted at creation and stored **wrapped under the KEK**
in `business_encryption_keys (business_id, key_version, wrapped_dek, created_at, retired_at)` —
a tenant-scoped table, so it needs an RLS policy in the same migration, per CLAUDE.md. That RLS
is defence-in-depth only, and the migration comment should say so: the wrapped DEK is inert
without the KEK, which lives in the process environment, not the database.

Per business rather than one global key because it gives a per-tenant export its own key, it
bounds a single-tenant key leak, and it enables crypto-shredding — which is what makes Phase
15's hard delete actually destructive rather than a `DELETE` a forensics tool can undo.

**This is where "the VPS holds ciphertext it cannot read" gets teeth.** The site box holds its
own KEK; the central VPS does not. Sync payloads pushed to `/api/server-sync/push` carry Tier A
and Tier B columns already encrypted under the site's DEK, and the VPS stores them opaque. The
consequence must be written down plainly, so that nobody later "fixes" it by shipping the KEK
to the VPS: central-side reporting continues to show all money and ledger data, which is
plaintext by design, but cannot show a customer's phone number or address.

New `src/lib/field-crypto.ts` with magic `POSFLD1` — deliberately different from `POSBKP1\0`, so
that a mis-piped artifact fails loudly rather than decrypting into nonsense. Encoding and
decoding hook in at the `*-service.ts` layer, **not** in `db.ts`: a transparent database layer
cannot know which column is which and would silently encrypt the wrong things. A registry
`src/lib/encrypted-columns.ts` maps `table.column → tier`, and a new integration test asserts
the registry against `information_schema.columns` — the same mechanism
`tenant-isolation.integration.test.ts` uses against `pg_policy`, and the thing that stops a
future migration quietly adding a plaintext PII column.

**One deliberate exception to "no encryption logic in the database", and it is not the thing
that rule prohibits.** `migrations/0125_field_encryption_columns.sql` installs a BEFORE UPDATE
trigger on `customers` and `reservations` that nulls a row's `*_enc`/`*_bidx` (and
`phone_last4`) whenever its plaintext column changes without them in the same statement. **Do
not remove it as cleanup.** It holds no key, performs no cryptography, and knows two tables by
name; what the rule above forbids is a *generic, transparent* layer guessing which columns to
encrypt across the whole schema. The trigger exists because these tables are written from more
places than the services this wave touched — `crm-service.ts`'s merge, the Holoo import, the
integrations sync — and a writer that updates the plaintext alone would otherwise leave readers
serving the *previous* value, since reads prefer the ciphertext. A silent wrong answer is worse
than an unencrypted one. With the trigger, such a write degrades to "correct but not yet
encrypted", and the next `npm run db:encrypt-fields` repairs the row, which is precisely what
makes the backfill's `WHERE col_enc IS NULL` resumability load-bearing rather than decorative.
`NEW.col_enc IS NOT DISTINCT FROM OLD.col_enc` is what distinguishes an aware writer (updates
both, left alone) from an unaware one (nulled). Removing it does not fail any test that a
green suite would catch quickly — it fails as stale data in production.

**Interaction with RLS: none, by construction.** `business_id` stays plaintext, so every policy
in `migrations/0021` is unaffected. The one real interaction is `src/lib/tenant-export.ts`,
which would otherwise dump ciphertext and must decrypt on export — Owner-only, already the
highest bar in the application, with the resulting *file* encrypted instead via Wave 1's
`?encrypt=1`.

**Migration path — three forward-only steps.** First, add nullable `*_enc bytea` (and `*_bidx`
where needed) alongside the plaintext columns, and create `business_encryption_keys` with its
policy. Second, `scripts/encrypt-fields.ts` (`npm run db:encrypt-fields`) enumerates businesses
under the platform bypass and wraps each one's batched updates in `withTenant(businessId, …)`,
per CLAUDE.md's background-work rule; it is idempotent and resumable on `WHERE col_enc IS NULL`,
and reads during the window prefer `_enc` and fall back to plaintext. Third, one release later,
drop the plaintext columns.

**Rejected: `pgcrypto` / `pgp_sym_encrypt`.** The key would arrive as a query parameter, landing
in server logs, `pg_stat_statements` and the WAL, and decryption would run on the database
server — the exact machine adversary A4 owns. Application-side crypto keeps the key in the app
process only. Also rejected: Postgres TDE, which is not in stock PG16, and encrypting in place
inside the migration, which has the same key-in-SQL problem and is unrecoverable if it fails
halfway under a forward-only regime.

---

## Scope — Wave 4: VPN-only network and LAN HTTPS

**What changes in the repository:**

- `docker-compose.local.yml` stops publishing 3000 (`ports:` becomes `expose:`) and gains a
  `caddy` service publishing 443, with a committed `Caddyfile` using **`tls internal`** —
  Caddy's own local CA auto-issues for the site hostname and prints a root certificate to
  install on each phone, tablet and till. This describes the historical Docker deployment;
  the current Electron desktop uses its own certificate manager and Local Devices onboarding.
  The file's
  now-obsolete `NOTE on HTTPS:` header comment is deleted when this lands.
- `POS_LOCAL_HOST` (e.g. `pos.cafe.lan`) wired to `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN`, with
  router-DNS and hosts-file guidance. A hostname is mandatory rather than cosmetic: **WebAuthn's
  RP ID cannot be an IP address**, so an `http://<lan-ip>:3000` origin can never run biometric
  login regardless of what else changes. With TLS in front, `NODE_ENV=production` and `Secure`
  cookies finally work correctly.
- `BIND_ADDR` (default `0.0.0.0`) on the published port, so that an operator can bind to the
  WireGuard interface and "zero public exposure" becomes something the compose file enforces
  rather than something a document asks for.
- `server.ts` gains an optional `https.createServer` branch behind `TLS_CERT_FILE` /
  `TLS_KEY_FILE`, because the Electron standalone has no proxy in front of it.
- `docker-compose.komodo.yml` gains a Traefik `headers` middleware duplicating Wave 1's static
  set (belt and braces, and it covers Traefik's own error pages), plus an **`ipallowlist` on
  the `pos-admin` router**. Making `admin.$ROOT_DOMAIN` unreachable from the public internet is
  the single highest-value network control against adversary A4, and it costs four label lines.
- New `src/lib/deployment-posture.ts` and a `server.ts` boot assertion mirroring
  `assertRlsEffective()`: refuse to boot a production `DEPLOYMENT_ROLE=site` install serving
  plain HTTP on a non-loopback bind unless `ALLOW_INSECURE_LAN=1`. Same fail-closed shape, same
  precedent, a pure predicate with a thin caller so it is unit-testable.
- New `docs/vpn-only-deployment.md`: WireGuard versus Tailscale, site firewall rules, the
  no-port-forward checklist, the recovery story when the tunnel is down, and the point that
  **server-sync needs no inbound rule at all** — it is outbound HTTPS from site to VPS via
  `runServerSyncTick` — which is what makes a VPN-only posture cheap here.
- `CSP_MODE` flips from `report-only` to `enforce`, alongside the LAN HTTPS change.

**Pure runbook, not repository work:** installing WireGuard or Tailscale, router configuration,
ACLs and key distribution, device enrolment, and installing Caddy's local root CA on each staff
device.

---

## Scope — Wave 5: Remaining hardening

- `audit_log` gains IP and user-agent columns; `platformAudit`'s swallowed write failures
  (`src/lib/platform-auth.ts:148-173`) become loud.
- Postgres-backed rate limiting, replacing the per-process `Map`s at `src/middleware.ts:148-151`
  that reset on restart and multiply across replicas.
- Session revocation for password logins (`platform_users.token_version` and
  `platform_admins.token_version`, paired with `employee_sessions` and `auth_admin_sessions`
  tracking and `impersonation_grants` revocation on password/MFA/role mutations), two-step MFA
  factor confirmation (`confirmed_at` set only after code verification, single confirmed primary
  via `idx_mfa_enrolments_single_confirmed_primary`), distinct second-factor enforcement after
  phone-OTP primary login, step-up re-authentication (`requireRecentAuth`), and user-controlled
  password reset tokens (`auth_password_resets` — forbidding cross-tenant password overwrite).
- Real JWT key rotation with two live keys, and deletion of Wave 1's legacy verify fallback.
- `tsx` moved to `dependencies` and the image built with `npm ci --omit=dev`.
- Periodic re-authorization for long-lived `/ws` sockets.
- SBOM and dependency scanning in CI.

---

## Verification

Nothing to verify yet beyond the documentation itself — no application code has changed. The
commands below are for whoever builds Wave 1.

**Unit tests** (`npm test`):

| File | Asserts |
|---|---|
| `src/lib/security-headers.test.ts` | Nonce appears in the CSP; `report-only` selects the `-Report-Only` header name; HSTS present only when `https`; `frame-ancestors 'none'`; `publickey-credentials-get=(self)` present, guarding Phase 20 against a future blanket deny |
| `src/lib/login-lockout.test.ts` | The rule under a custom policy; realm policies differ; **`src/lib/employee.test.ts` passes unmodified**, which is the behaviour-preservation proof |
| `src/lib/jwt-secret.test.ts` | Realm keys differ from each other and from the raw secret; a tenant-signed token with a rewritten `realm` claim still fails platform verification; the legacy fallback works and stops when disabled; the 32-character production floor survives |
| `src/lib/backup.test.ts` | `backupPassphrase()` precedence; **`cloudKeyFor` does not double-append `.enc`**; `selectPrunable` over a mixed `.dump`/`.dump.enc` directory |
| `src/lib/rate-limit.test.ts` | `clientIpFrom(headers, trustedHops)` including `hops=0` and a spoofed multi-entry XFF |
| `src/lib/server-sync.test.ts` | `legacySyncTokenAllowed()` defaults to false |

**Integration tests** (`npm run test:db`):

- `integration/tenant-isolation.integration.test.ts` — add `auth_login_attempts` to
  `EXEMPT_TABLES` with a justification comment, or it fails at line 196.
- New `integration/auth-lockout.integration.test.ts` — N failures lock; a success clears the
  streak; **the realms do not share a bucket** (locking `platform_admin` for an address leaves
  `tenant_password` unlocked for the same address).
- `src/app/api/api-guards.test.ts` — update the two server-sync justification strings.

**Full gate, mirroring CI:**

```bash
npx tsc --noEmit && npm test && npm run test:db && npm run build
```

**Against a running instance:**

```bash
curl -sI https://<host>/login | grep -iE 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions'
docker run --rm --entrypoint id ghcr.io/hamidnoshady/cafe-restaurant-pos:<tag>   # expect uid=1000(node)
head -c 8 backups/pos-backup-*.dump.enc | xxd                                    # expect POSBKP1\0
BACKUP_PASSPHRASE=… npx tsx scripts/restore.ts backups/pos-backup-*.dump.enc --dry-run
curl -si -X POST https://<host>/api/orders -H 'Cookie: pos_session=…' -H 'Origin: https://evil.example'  # expect 403 bad_origin
curl -si https://<host>/api/server-sync/push -H "Authorization: Bearer $REMOTE_SYNC_TOKEN"               # expect 401
```

Plus a manual browser pass with devtools open on `/accounting/pos`, `/accounting/floor`
(react-grid-layout is the most likely CSP violator) and `/accounting/kitchen`, confirming zero
CSP reports before `CSP_MODE=enforce` is ever considered.
