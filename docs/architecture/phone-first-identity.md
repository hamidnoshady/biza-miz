# Phone-first identity, signup and business onboarding

Status: **identity schema and services in `main` (ESH-199 / #1384); signup, MFA
policy and short onboarding implemented on this branch (ESH-200/201/202/203 /
#1385–#1388).** Not a production rollout; see [Status and gates](#status-and-gates).

This is the one account journey. It replaces nothing that already works: the
tenant session, membership, OTP, MFA, SMS (#902), logo storage, industry registry
and business provisioning are reused. The full app-selection wizard remains
#1239's `/setup`; this flow only hands off to it.

## 1. The identity model

- **A person is `platform_users`.** It is global: one row per person, no business
  column. A business membership is `users`, which references the person through
  `platform_user_id`.
- **A verified mobile is the credential.** `platform_users.phone_e164` is
  canonical E.164 and is trusted only while `phone_verified_at` is set (migration
  0302). A partial unique index (`idx_platform_users_verified_phone`) makes one
  verified number map to one identity under concurrency; pending values may
  repeat, so an in-flight challenge never blocks another person.
- **Email and password are optional** (migration 0303). An identity must have at
  least one reachable channel (email or phone) and a password only beside an
  email. There is no placeholder address and no fake hash.
- **Email is untrusted until verified.** `email_verified_at` is the only proof;
  migration 0305's trigger clears it (and live tokens) when the address changes.
- **National ID is optional, encrypted and audited.** AES-256-GCM ciphertext plus
  an HMAC blind index on `platform_users`; set/clear are self-only, reads are
  self-or-platform-admin, every action is a row in `platform_identity_events`
  with ids only (migration 0303, repaired in 0307).
- **Ambiguity is never merged.** The two conflict views
  (`v_platform_verified_phone_conflicts`,
  `v_platform_verified_phone_identity_conflicts`) are the review surface;
  migration 0306 clears a number the first backfill may have guessed.
- **Phone-only memberships are valid.** The legacy `users_credentials`
  row-shape check was already dropped in migration 0187 — credentials live in
  `employee_credentials`, and a replicated membership may exist before a
  credential does. A phone-first owner therefore needs no password and no
  placeholder hash; 0310 deliberately does not reintroduce that CHECK.

## 2. Signup (ESH-200 / #1385)

`src/lib/iam/public-signup.ts`, `POST /api/auth/signup/request`,
`POST /api/auth/signup/verify`, `/signup`.

1. The form asks for **first name, last name and mobile only**.
2. `request` normalises the number through `src/lib/phone.ts` (Persian and Latin
   digits, `+98`, `0098`, trunk prefix), refuses a landline, enforces the send
   limiter on its own `signup` realm, and stores a `platform_signup_requests` row
   carrying the names typed once.
3. The code is an ordinary `mfa_challenges` row under
   `subject_realm = 'platform_signup'` with **`purpose = 'signup'`** — a sixth
   vocabulary entry the database constraint now accepts (migration 0310). A login
   code cannot create a person and a signup code cannot sign one in.
4. `verify` redeems the code (single-use, five guesses, five minutes, bound to
   the number it was sent to), then creates the identity **and** consumes the
   request in one transaction. Concurrent redemptions converge on one row through
   an advisory lock plus the partial unique index.
5. If the number already belongs to a verified identity, that identity is
   linked and `created: false` is returned. This is only revealed after the
   caller proved control of the number; the request endpoint never changes its
   answer based on account existence.
6. A new identity receives an encrypted 30-minute onboarding cookie
   (`pos_onboarding`). **No tenant session is minted**, because there is no
   business to scope one to.
7. Nothing in this step creates a business, branch, membership, wallet,
   subscription, app activation or charge.

`requestSignupOtp` / `verifySignupOtp` both check the deployment switch
server-side, so closing registration does not depend on hiding a page.

## 3. Login and the MFA policy change (ESH-201 / #1386)

Default login is **phone (or email) + password**, with the configured second
factor for the roles the policy covers. Password login is unchanged.

The alternative door is **phone + one purpose-bound SMS OTP**. This is the
deliberate change from #854/#809's routine behaviour:

- **Before:** a phone-OTP login for an Owner with an SMS enrolment computed
  "a factor exists" and produced a second-factor prompt whose only available
  method was `sms_otp` — a prompt `distinctSecondFactorMethods` had just
  excluded. In practice that was a dead end; in principle it asked for the same
  factor twice.
- **Now:** `phoneOtpRoutineChallengeRequired` challenges only when there is a
  **stronger distinct** confirmed factor (`totp`, WebAuthn). The SMS code that
  completed the sign-in is the routine factor.

What is not weakened:

- Password login still requires the configured distinct factor for
  `owner`/`admin` (and opted-in `manager`/`accountant`).
- An enrolled TOTP/WebAuthn factor still challenges on an OTP login — switching
  doors does not skip a stronger factor.
- Trusted-device trust, its expiry and its revocation on policy change are
  unchanged; trust is still earned only by completing the ceremony.
- Sensitive actions keep their separate `requireRecentAuth` step-up.
- OTP login still applies lockout, rate limits, audit and session revocation.

**Threat model (summary).** The routine OTP door is now single-factor by design:
whoever holds the number can sign in. That is acceptable because the number is
the account's primary credential in this product, the same SMS channel was
already sufficient to *reset into* the account, and privileged operations still
need a stronger factor when one is enrolled. The residual risk is SIM swap /
number recycling; mitigations are the existing lockout and audit trail, the
option to enrol TOTP, and step-up on sensitive actions. This trade-off must be
revisited if a future policy makes phone numbers transferable between identities.

## 4. Short onboarding and provisioning (ESH-202 / #1387)

`src/lib/iam/onboarding.ts`, `GET/PATCH /api/onboarding`,
`POST /api/onboarding/submit`, `/onboarding`.

- **Steps:** industry → business basics → optional logo → optional profile.
  Industry options come from `ENABLED_INDUSTRIES`; the logo is validated with the
  canonical 256 KiB / four-MIME / magic-byte rules and staged as the same data
  URL `settings.business.logo` stores.
- **Durable and resumable:** one `platform_onboarding_progress` row per person,
  saved on every Continue. A field the request does not name is left untouched,
  so a later step cannot erase an earlier answer.
- **Provision only on submit:** `provisionFirstBusinessFromOnboarding` reuses
  `insertBusiness`'s transaction — business, branch, owner membership, settings
  and payment ways — with the owner resolved by the proven identity, not by email
  and not by creating a second person. It takes an advisory lock keyed on the
  identity and stores `provisioned_business_id`; a retry, a double tap or two
  tabs return that same business.
- **No billing, no activation, no wallet.** Setup is deliberately **not** marked
  complete: `/setup` remains the only place that Finish happens.
- On success the real tenant session is minted and the onboarding cookie is
  cleared. `/setup`'s business-profile step reads `businesses`, `locations` and
  `business.logo`, so it opens prefilled for review rather than as a blank form.

## 5. Superadmin controls (ESH-203 / #1388)

`src/lib/iam/platform-auth-settings.ts`, `GET/PUT /api/platform/auth/signup`.

- One switch, `platform_auth_settings.public_signup_enabled`, enforced by both
  public routes. `configured = false` keeps the pre-existing
  `ALLOW_PUBLIC_SIGNUP` decision, so a running install is not silently changed by
  the deploy; once an operator saves, the stored value wins, including an explicit
  `false`.
- Writes require `security.manage` and are recorded by `platformAudit`
  (`auth.public_signup.update`). Authentication SMS settings and provider health
  stay in the existing `platform_sms_config` / #902 surfaces — no second SMS
  system.
- Funnel observability comes from the existing rows: `platform_signup_requests`
  (requested / consumed), `platform_onboarding_progress` (in progress /
  provisioned) and `auth_login_attempts` realm `signup` (sends, rate limits).
  Phone numbers are never exported in aggregate reports; account inspection stays
  permission-gated.

## 6. Migration and rollback

`migrations/0310_phone_first_signup_onboarding.sql` is additive:

- grows the `mfa_challenges.purpose` CHECK to include `signup`;
- creates `platform_signup_requests`, `platform_onboarding_progress` and
  `platform_auth_settings` with `platform_only` RLS and registers them as
  tenant-exempt.

Rollback: drop the three tables and restore the previous `mfa_challenges.purpose`
vocabulary (with no `signup` code in flight). No business, membership or identity
row is rewritten by this migration, so there is no data repair to undo. Migrations 0302/0303/0305/0306/0307 (the identity
foundation) already document their own forward repairs and rollback notes.

## 7. Status and gates

Implemented and locally verified on this branch:

- identity schema and services (#1384) — already in `main`;
- signup request/verify, session-less onboarding continuation (#1385);
- routine-OTP MFA policy change with tests (#1386);
- resumable onboarding, idempotent provisioning, `/setup` prefill (#1387);
- public-registration switch, capability check and audit (#1388);
- unit tests and a database integration suite (#1389, partial).

Not yet done — must be completed before closing #1383:

- Operator UI for the switch (the API is authoritative; it is not yet surfaced in
  the platform console) and funnel dashboards.
- A production-like migration rehearsal and a signed release.
- Browser end-to-end coverage (the screens were not driven in a browser here),
  visually reviewed RTL/mobile states, and the full legacy matrix (staff PIN,
  invitations, Superadmin, Cloud/Hybrid/Full Offline, restore, pairing).
- Staged rollout, monitoring and the support runbook.
