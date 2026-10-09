# Issue #885 — Platform-wide login and authentication

**Branch:** `arena/d6aa0a4a-biza-miz`
**Base commit:** `d14f0e3557253591da3b083771745e87ee244b93`
**Work commit:** `1ffa97e1f3df27a7b883d6f2f6a622e832b61152`
**Diff (`d14f0e3` → `1ffa97e`):** 37 files changed, +4,665 / −299 — 25 modified, 12 added

---

## 1. Implemented

### The mandatory seven-day trusted-device requirement

`src/lib/trusted-device.ts` (new) + `migrations/0215_login_auth_hardening.sql`.

- New `trusted_devices` table. The credential is an opaque 32-byte token, `tdev_`-prefixed, stored **only** as `HMAC-SHA256(getRealmSecret("tenant"), token)`. The raw token exists once, in an `httpOnly` `sameSite=lax` cookie with no `Domain`, so it never reaches `localStorage` or a response body.
- Scope is **account + tenant + device**, recorded as a three-way unique key. Trust on one tenant never leaks to another, and the same device used by two members is two independent trusts.
- `evaluateDeviceTrust(entry, { businessId, userId }, now)` is pure and fails **closed**: a missing, revoked, expired, or wrong-subject entry is all `trusted: false`. Revocation is checked before expiry so a revoked device can never be resurrected by clock movement, and an unparseable `expires_at` is treated as untrusted rather than skipped.
- TTL is exactly 7 days (`TRUSTED_DEVICE_TTL_MS`), computed at issue time and never recalculated. **Nothing on the ordinary login path extends it** — the expiry written at issue is the only expiry.
- Trust is offered **only after all required verification on that request has completed**: on `mfa/verify` it is issued after the session cookie, and only when `trustDevice === true && !useRecoveryCode` (a recovery code never earns trust); on `phone-otp/verify` when the member finished the ceremony there.
- `pin-login` *evaluates* trust to decide whether the phone gate is satisfied, but never *issues* it — the PIN door has no place to offer it.
- Revocation is wired at password reset (in-transaction, reason `password_reset`), membership offboarding (`member_offboarded`, in `team-service.ts`), and user request via `DELETE /api/auth/trusted-devices`.
- Listing and revocation UI: `TrustedDevicesCard` in `settings/profile/profile-section.tsx` and `security-center-settings.tsx`, showing device label, issue date and **expiry**, each individually revocable.
- "Remember my login type" is kept as a separate, non-security concern — the `pos:loginDoor` `localStorage` flag cannot establish trust.

### Other new surfaces

| Surface | Purpose |
|---|---|
| `src/lib/login-contract.ts` | Client-safe primitives shared by forms and routes: `safeLoginNextPath`, `normalizeOtpCode`, `normalizePinInput`, `boundedString`, `uuidOrNull`, `loginErrorMessage`. |
| `src/components/auth/use-login-request.ts` | `useLoginRequest` — bounded timeout, abort signal, generation counter, guaranteed `finally` release. |
| `src/app/api/auth/login-capabilities/route.ts` | Public `GET` capability probe for the offline door. |
| `src/app/api/auth/trusted-devices/route.ts` | `GET` list / `DELETE` revoke own devices, gated by `requireRecentAuth`. |
| `otpSendBudgetDecision` in `phone-otp-policy.ts` | Order-independent send-budget decision, exported so both the route and tests share one implementation. |

---

## 2. Bugs fixed

**L01 — signed-out phone login blocked by middleware.** The two phone-OTP endpoints are now registered as pre-session routes. `phone/self` deliberately stays authenticated (it is self-service, not login).

**L05 — permanently disabled sign-in forms.** Both forms set `busy`, awaited a bare `fetch` with no `catch`/`finally`, and released `busy` on the line *after* the await. A network rejection threw past that line and left the button disabled forever with no message. The manager form now uses `useLoginRequest`; the PIN path in `login-form.tsx` is wrapped so a rejection reports a network error and releases the button.

**L06 — `next` lost when switching login type.** Hard-coded `/admin` and `/login` targets and alias redirects that dropped the query are replaced by `withLoginNextParam` over a validated `next`.

**L07 — remembered manager choice ignored.** The remembered value was written but the only consumer compared `=== "staff"`. `"admin"` now routes to `/admin` preserving a validated `next`.

**L08 — `needsBusinessSelection` treated as success.** `/api/auth/login` already returned it; the client accepted any success as a login. The form now renders a business-selection step.

**L09 — error collapse.** 429 / wrong-origin / no-membership / 5xx were all reported as "wrong password". `loginErrorMessage` maps status and code to distinct messages, including the lockout countdown.

**L11 — RTL digit stripping.** `replace(/\D/g, "")` discarded Persian and Arabic digits. Normalisation now goes through the existing `toLatinDigits` at both the UI and API boundaries.

**L14 — unchecked JSON.** The password route called `.trim` and bcrypt on unparsed input. Both login routes now run bounded runtime validation with consistent 400s and UUID validation.

**L17 — malformed roster rendered as an empty roster.** A 200 whose body has no `employees` array is now a failure state, not a silent "no staff here".

**A pre-existing bug the audit did not list.** `auth_login_attempts` (migration 0070) constrained `realm` to `('tenant_password','platform_admin','directory')`; 0078 widened only the realm list. `sendEmployeePhoneOtp` has inserted `realm='phone_otp'` since Phase 42, so **every** OTP send violated the check constraint — *after* the SMS had already been dispatched, outside any `try/catch`. Two consequences: the route's catch answered `502 sms_dispatch_failed` for a message that had been delivered (inviting a retry), and no attempt row was recorded, so `checkPhoneOtpRateLimit` always read an empty budget and the 1/min, 5/hr, 20/day ceiling never applied. Verified by direct insert against PostgreSQL 18.4. Fixed by re-adding both constraints to include `'phone_otp'` and `'reserved'`.

---

## 3. Architecture changes

**Challenge binding (L02).** The phone-OTP payload gains `cid`, `destination` and `purpose`. A challenge is now identified by subject + tenant + purpose + challenge id + canonical destination, and `verifyEmployeePhoneOtp` takes that whole tuple. Redemption is a single conditional `UPDATE … AND consumed_at IS NULL AND expires_at > now() AND attempts < $max RETURNING id`, so the row is the arbiter — there is no read-then-write window for two concurrent verifies to both succeed. Older challenges for the same identity are retired in the same CTE that inserts the new one.

**Atomic quota (L03).** `reserveOtpSend` runs in `withTenantTransaction` under `pg_advisory_xact_lock(hashtext(identityKey))` and writes an `auth_login_attempts` row with outcome `'reserved'` *before* dispatch. `refundOtpSend` releases the reservation if the provider fails, so a failed send does not consume quota. The return type is a proper discriminated union (`OtpSendReservation`) rather than an intersection with optional fields, which previously forced a meaningless `challengeId: ""`.

**A single next-path authority.** `login-helpers.useNextPath` and desktop `safeNextPath` were two implementations that disagreed — one rejected `//` but not `/\`. Both now delegate to `safeLoginNextPath`.

**PIN bounds imported, not duplicated.** `pin-pad.tsx` repeated the literals `4` and `12`; it now imports `PIN_MIN_LENGTH` / `PIN_MAX_LENGTH` from `pin-policy.ts`.

**Capabilities are resolved, not asserted (L04).** The offline door used to promise "Internet unnecessary" unconditionally. `useLoginCapabilities` probes the new endpoint and the copy is generated from what the server actually reports — cloud wording, local/hybrid wording, and the seven-day SMS prerequisite when enforcement is active. Any probe failure degrades to a neutral "unavailable" note rather than a false promise. **MFA/OTP were not weakened to make the button work.**

**Middleware gained a pre-session Origin check** on browser login mutations only (`BROWSER_LOGIN_MUTATION_PATHS`), 403 on mismatch, missing Origin allowed. Server-to-server callers (`desktop-session`, `cloud-login/callback`, `server-sync`, `iam`, `v1`, `mcp`) are explicitly excluded.

---

## 4. UX/UI changes

- **Offline door** states the real prerequisite instead of an unconditional promise.
- **Door switching preserves `next`**, so a deep link survives changing your mind about how to sign in.
- **Business selection** is now a visible step rather than a silent dead end.
- **Distinct error messages** per failure class, with the lockout countdown shown.
- **Password visibility toggle** and correct `autocomplete` purposes on the manager form.
- **Accessible names and live regions (L12).** `mfa-step.tsx` had no label on either input — the heading above was an `<h2>`, not a `<label>`, so a screen reader announced "edit text" plus a placeholder that vanishes on typing. Both inputs now carry mode-aware `aria-label`s, the code input is `aria-describedby` the instruction, and all three error paragraphs are `role="alert" aria-live="assertive"`. Focus stays on the submit button when verification fails, so an error rendered elsewhere in the tree was simply never announced. A recovery-code field no longer advertises `one-time-code`, which invited password managers to autofill an SMS the member was not being asked for.
- **Trusted-device listing** shows device label, issue date and expiry, each revocable.
- **Copy corrections (L16)** where the product promised "full settings/reports" against a role-based reality.
- **Forgotten-password link** on the manager form, pointing at a truthful `RecoveryHelp` panel (see §9).

---

## 5. Security changes

- **Challenge binding** as in §3 — the single largest change.
- **Anti-enumeration completed (L15).** The request route collapses 429 / 502 / 423 into the same `200` it returns for an unknown number, via `antiEnumerationResponse(phone)` with `suppressDiagnostics: true`. On the verify route, `!payload.sub` answers `invalid_code` 401 — **byte-for-byte identical to a wrong code** — and never consults the challenge or the lockout ledger. Status *and* body match; matching only the status would leave a differing `error` field as the oracle.
- **Pre-session Origin check** on browser login mutations.
- **Bounded input validation** on both login routes.
- **Trusted-device credentials are opaque, hashed at rest, and revocable**, and trust is never granted by a client-supplied label or fingerprint.
- **Recovery codes never earn device trust.**
- **Trust is revoked** on password reset, offboarding, and user request.

**A regression I introduced and then caught.** My first edit to `phone-otp/verify/route.ts` collapsed both failure branches into `unauthorized`, which reopened exactly the member-existence oracle L15 exists to close: an unknown number would have answered `unauthorized` where a wrong code answered `invalid_code`. Confirmed against the base commit with `git show d14f0e3:…`, then fixed. `src/app/api/auth/phone-otp/verify/route.test.ts` now pins it — reverting the fix makes that test fail, which I verified by reverting and re-running.

---

## 6. Dead / legacy removed

- `useNextPath` and `safeNextPath` no longer carry independent validation logic; both delegate to `safeLoginNextPath`.
- `pin-pad.tsx`'s duplicated `4` / `12` literals are gone, imported from `pin-policy.ts`.
- The duplicated `OtpSendResult` shape was split into a proper `OtpSendReservation` union, removing the placeholder `challengeId: ""` that the old intersection type forced callers to fabricate.
- The `//`-but-not-`/\` inconsistency between the two next-path validators is gone with the second implementation.

The legacy PIN-only scan was reviewed but **not retired** — it is still the only door for staff without a linked platform identity, and removing it is a product decision rather than a cleanup.

---

## 7. Tests added / updated

| File | Tests | Notes |
|---|---:|---|
| `src/lib/login-contract.test.ts` | 25 | new — next-path, digit and PIN normalisation, bounded strings, error mapping |
| `src/middleware.test.ts` | 28 | +5 — phone-OTP public, authenticated `phone/self` still gated, prefix siblings not public, `isBrowserLoginMutationPath` |
| `src/lib/phone-otp-policy.test.ts` | 24 | +`otpSendBudgetDecision` block — order independence, unparseable stamps, never a negative wait |
| `integration/phone-otp.integration.test.ts` | 13 | +5 — challenge mint/redeem harness, concurrent consumption, scope mismatch |
| `src/app/api/auth/phone-otp/verify/route.test.ts` | 12 | new — anti-enumeration equivalence, binding pass-through, trust offer |
| `src/components/auth/login-door-chooser.test.tsx` | 11 | new — `next` preservation, offline copy, capability degradation |
| `src/lib/trusted-device.test.ts` | 11 | new — trust matrix, exact 7-day boundary, invalid date fails closed |
| `src/components/auth/use-login-request.test.tsx` | 10 | new — busy release on reject/timeout/non-JSON, stale-response guard, cancel |
| `integration/trusted-device.integration.test.ts` | 7 | new — against real PostgreSQL |
| `src/app/api/api-guards.test.ts` | — | +2 registrations for the new routes |

Two of these are regression guards for bugs found during this work, not just coverage for new code: the verify-route equivalence test, and the `auth_login_attempts` constraint is exercised by the integration harness that now records real attempt rows.

**No test was disabled, no assertion loosened, no timeout raised, no visual baseline re-recorded.**

---

## 8. Verification / CI results

All commands run in this sandbox on the work commit.

| Command | Result |
|---|---|
| `NODE_OPTIONS=--max-old-space-size=3072 npx tsc --noEmit` | **exit 0**, no output |
| `npx eslint . --max-warnings=0` | **exit 0** |
| `npx vitest run --maxWorkers=2` | **671 files / 8,469 tests passed**, exit 0 |
| `DATABASE_URL=… npx vitest run --config vitest.db.config.ts` (9 auth files) | **9 files / 64 tests passed**, exit 0, 71.1 s |
| Same, plus the 3 files exercising `team-service.ts` / `password-reset.ts` | **3 files / 49 tests passed**, exit 0, 141.0 s |

Auth integration breakdown: `phone-otp` 13, `trusted-device` 7, `auth-account-security` 5, `auth-lockout` 3, `login-lockout-enumeration` 4, `staff-login-tenant` 7, `iam-login-credentials` 2, `authorization` 21, `desktop-cloud-login` 2.

Modified-code integration breakdown: `hybrid-credential-sync` 16, `team` 23, `plan-limits` 10. These three were selected by grepping `integration/` for every test that references `auth_login_attempts`, `mfa_challenges`, `password-reset`, `consumePasswordResetToken`, `team-service`, or `revokeTrustedDevices` — i.e. the full set of integration tests reaching code this change touched, not a convenience sample. Combined: **12 files / 113 tests**.

Database: PostgreSQL **18.4**, provisioned via `embedded-postgres` on 127.0.0.1:54339, migrations applied through `scripts/migrate.ts`.

Baseline before any edits, same environment, measured by checking out base commit `d14f0e3` in a separate worktree: `npx tsc --noEmit` exit 0 and `npx vitest run` → **666 files / 8,386 tests passed**, exit 0. This change therefore adds **5 unit test files and 83 tests** with no existing test removed or altered in expectation.

GitHub CI: **no runs or statuses exist** for this repository — the lookup returns empty. There is no CI to report against.

---

## 9. Genuine remaining issues

**The production build does not complete in this sandbox.** `npm run build` is OOM-killed (exit 137) on a machine with 3.9 GB RAM and no swap. I verified this is environmental, not caused by this work: `git stash`-ing every change and building the untouched base commit `d14f0e3` is killed identically at the same point, with the same exit code. **The build is therefore unverified for both the base and this branch here.** It must be run on CI or a machine with more memory before merge.

**L10 — forgotten-password email delivery is not implemented.** There is no transactional email transport for `platform_user` identities; `message-outbox-service.ts` is campaign-scoped and billing-metered, so routing a security email through it would be wrong. The manager form links to a truthful `RecoveryHelp` panel that explains the admin-mediated reset that does exist (`platform-service.ts` and `team-service.ts` return a `resetUrl` for an admin to relay). The non-enumerating, rate-limited *initiation* flow the issue asks for is **not** built, because without delivery it would be a flow that silently goes nowhere.

**L13 — the deployment-aware eligibility/assurance policy is not implemented.** Roster and PIN admit `owner, admin, manager, accountant` off cloud; WebAuthn verify accepts only the four operational roles; WebAuthn never evaluates the phone policy; and a local privileged PIN session omits platform identity, `tokenVersion` and MFA state, so the MFA grace banner never appears there. Unifying these is **not** a mechanical fix: gating WebAuthn on the phone policy the way PIN is gated would lock out WebAuthn users at any business that never adopted phone OTP, the day the adoption window closes. That is a product decision about who may sign in by which method, and guessing at it would be worse than leaving it. This is the largest unfixed item in the issue.

**L16 is partially addressed.** Copy corrections, the password toggle and `autocomplete` purposes are in; broader input ergonomics were not taken up.

**Hostless multi-match disclosure is retained deliberately.** When a phone number matches members at several businesses, the response names those businesses before any proof is offered. Closing it means changing a flow that legitimate users depend on, so it is reported here rather than silently "fixed".

**The full 195-file integration suite was not completed here.** It reached 20 files, all passing and with no failures logged, before I stopped it — at this machine's speed it needed hours and contended with the build for the same 2 cores. Rather than leave that as a bare gap, I then enumerated the integration tests that actually reach code this change touched, by grepping `integration/` for `auth_login_attempts`, `mfa_challenges`, `password-reset`, `consumePasswordResetToken`, `team-service` and `revokeTrustedDevices`, and ran all 12 of those files: **113 tests, all passing** (§8). So the change is covered by every integration test that can observe it; what remains unverified is the set of domains this change does not reach.

Migration `0215` is additive (new nullable columns, widened constraints, one new table), and it was applied successfully by every file that ran across all attempts — the 20 from the partial full run plus the 12 targeted ones — so the migration itself is exercised well beyond the auth domain.

**One client item was deferred and then completed in this pass:** the `mfa-step.tsx` label and `role="alert"` work described in §4.
