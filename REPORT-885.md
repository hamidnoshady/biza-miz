# Issue #885 — Platform-wide login and authentication

**Branch:** `arena/d6aa0a4a-biza-miz`
**Branched from:** `d14f0e3557253591da3b083771745e87ee244b93`, then synchronised with `main` — the current merge-base with `origin/main` is **`b8b66b21`**, i.e. this branch is **0 behind / 28 ahead**.
**Diff (`b8b66b21` → branch HEAD), code and tests only:** **57 files changed, +7,076 / −271** — 27 added, 30 modified. (This report is excluded from the count, so the figure does not move as the report is edited.)

An earlier draft of this header reported 53 files / +6,262 measured against `d14f0e3`. That base is stale: it predates the merge of `main`'s accounting and multicurrency work, so it counted main's own changes as this branch's. The figures above are measured against the true merge-base and describe only what this branch contributes.

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

### Forgotten-password initiation (L10)

`src/lib/password-reset-request.ts` + `src/app/api/auth/password-reset/request/route.ts`.

Redemption already existed — an admin could mint a link from the team screen and `consumePasswordResetToken` would accept it. What was missing is the half a locked-out manager actually needs: a way to *ask*, without first finding someone who can already get in.

- Reuses `issuePasswordResetToken`, so a self-requested link and an admin-issued one are the same credential with the same 24-hour single-use semantics.
- **Non-enumerating by construction.** The route returns one status and one body for all six outcomes the service can produce (`sent`, `unknown_email`, `inactive`, `rate_limited`, and two `not_configured` reasons). A rate limit is deliberately *not* surfaced as a 429 — that would be the most useful possible answer to an attacker, distinguishing an address that exists and has been used from one that does not.
- **Rate-limited per address** at 3/hour and 8/day, decided by a pure, order-independent `passwordResetBudgetDecision` that ignores unparseable and future-dated stamps rather than counting them.
- **Delivery is not awaited**, on purpose: waiting on SMTP would make response time a function of whether the address exists, and no identical body can hide that timing difference. Send errors are logged, never surfaced.
- **Declines rather than half-works.** If SMTP is unconfigured, or there is no `PLATFORM_BASE_URL`/`POS_DOMAIN`/`ROOT_DOMAIN` to build a link from, nothing is minted — issuing a link that can never arrive would revoke the user's existing pending token and leave them worse off.
- The client keeps the admin-issued path visible alongside the email form, so an install with no SMTP still has a working recovery route.

### Other new surfaces

| Surface | Purpose |
|---|---|
| `src/lib/login-contract.ts` | Client-safe primitives shared by forms and routes: `safeLoginNextPath`, `normalizeOtpCode`, `normalizePinInput`, `boundedString`, `uuidOrNull`, `loginErrorMessage`. |
| `src/components/auth/use-login-request.ts` | `useLoginRequest` — bounded timeout, abort signal, generation counter, guaranteed `finally` release. |
| `src/app/api/auth/login-capabilities/route.ts` | Public `GET` capability probe for the offline door. |
| `src/app/api/auth/trusted-devices/route.ts` | `GET` list / `DELETE` revoke own devices, gated by `requireRecentAuth`. |
| `otpSendBudgetDecision` in `phone-otp-policy.ts` | Order-independent send-budget decision, exported so both the route and tests share one implementation. |
| `src/lib/password-reset-request.ts` | L10 forgotten-password initiation: non-enumerating request service, per-address rate limit, delivery over the platform's own SMTP settings. |
| `src/app/api/auth/password-reset/request/route.ts` | Public `POST` for the above — one response shape for every outcome. |
| `src/lib/login-eligibility.ts` | L13 — the single deployment-aware login-eligibility policy: which role set each door applies, rendered as SQL. |

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

**L17 — the OTP step's async could outlive a cancelled step.** `phone-otp-step.tsx` was still on a bare `await fetch` behind a local `busy` flag, so nothing moved on when the member backed out mid-verify. A response landing afterwards ran its handlers regardless: `onVerified()` completed a login the member had already abandoned. It now goes through `useLoginRequest`, gaining the generation guard and the bounded timeout the two sign-in forms already had.

That wiring exposed a second defect, in the hook itself rather than the step. `cancel()` moved the generation on, which is enough to protect the caller's state, but never aborted the request — so an abandoned verify still reached the server, still consumed an OTP attempt, and still counted against the send ceiling. A member who backed out and retried could burn the attempt their next code needed. `cancel()` now aborts the in-flight controller.

**A pre-existing bug the audit did not list.** `auth_login_attempts` (migration 0070) constrained `realm` to `('tenant_password','platform_admin','directory')`; 0078 widened only the realm list. `sendEmployeePhoneOtp` has inserted `realm='phone_otp'` since Phase 42, so **every** OTP send violated the check constraint — *after* the SMS had already been dispatched, outside any `try/catch`. Two consequences: the route's catch answered `502 sms_dispatch_failed` for a message that had been delivered (inviting a retry), and no attempt row was recorded, so `checkPhoneOtpRateLimit` always read an empty budget and the 1/min, 5/hr, 20/day ceiling never applied. Verified by direct insert against PostgreSQL 18.4. Fixed by re-adding both constraints to include `'phone_otp'` and `'reserved'`.

---

## 3. Architecture changes

**Challenge binding (L02).** The phone-OTP payload gains `cid`, `destination` and `purpose`. A challenge is now identified by subject + tenant + purpose + challenge id + canonical destination, and `verifyEmployeePhoneOtp` takes that whole tuple. Redemption is a single conditional `UPDATE … AND consumed_at IS NULL AND expires_at > now() AND attempts < $max RETURNING id`, so the row is the arbiter — there is no read-then-write window for two concurrent verifies to both succeed. Older challenges for the same identity are retired in the same CTE that inserts the new one.

**Atomic quota (L03).** `reserveOtpSend` runs in `withTenantTransaction` under `pg_advisory_xact_lock(hashtext(identityKey))` and writes an `auth_login_attempts` row with outcome `'reserved'` *before* dispatch. `refundOtpSend` releases the reservation if the provider fails, so a failed send does not consume quota. The return type is a proper discriminated union (`OtpSendReservation`) rather than an intersection with optional fields, which previously forced a meaningless `challengeId: ""`.

**A single next-path authority.** `login-helpers.useNextPath` and desktop `safeNextPath` were two implementations that disagreed — one rejected `//` but not `/\`. Both now delegate to `safeLoginNextPath`.

**One login-eligibility policy (L13, partial).** The same role lists were written out literally in seven places across the login and credential paths, in two different spacing conventions, with no shared name — so "who can use a PIN" was answered by whichever file you happened to open. They are now one module, `login-eligibility.ts`, which owns only the *policy* (how a role set maps onto a deployment profile and onto each door); role *membership* stays in `@/lib/roles`, whose existing `roles.test.ts` guard fails the build if any module re-declares it. That guard caught my first attempt at this, which re-declared the lists — it is now satisfied. The two doors still differ on purpose, and the module records why: PIN and roster widen to the password roles off cloud, while WebAuthn stays narrow on every profile because a passkey is device-bound and the privileged doors are not.

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
- **Pasting an SMS into the OTP field now yields the code (L16).** `otpFromPastedText` pulls a digit run of exactly the expected length out of arbitrary pasted text, wired into an `onPaste` on the phone-OTP and MFA code inputs. The bug was not the normaliser: `maxLength={6}` makes the browser truncate a paste *before* `onChange` fires, so "Your code is 123456. Do not share it." arrived as `"Your c"` and normalised to an empty box. The member pasted their code and saw nothing, with no explanation. Recovery-code entry is deliberately excluded — its format is not six digits.
- **Forgotten-password request (L10)** on the manager form: a labelled email field that asks for a reset link, prefilled with the address already typed into the login form, with its own error live region. The admin-issued path stays visible underneath it as the fallback for installs with no SMTP, and the confirmation copy says "*if* this address is registered" rather than "sent", because the endpoint answers every outcome the same way by design.

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

**A second regression, found by the full integration suite, and fixed (migration 0216).** Migration 0215 gave `mfa_challenges` a `business_id` and a `destination` — a member's phone number — so a phone-OTP code could be bound to the tenant it was issued for. That was the right binding and the wrong table state: `mfa_challenges` was still listed in `EXEMPT_TABLES`, the set of tables with **no row-level security**, on the original reasoning that a login challenge exists before any business is known. The reasoning stopped holding the moment the row carried a business. An exempt table is readable from any tenant-scoped connection, so a member of business A could have reached business B's challenge rows, phone numbers included.

`integration/tenant-isolation.integration.test.ts` asserts precisely this invariant and failed with `mfa_challenges is exempt but carries a tenant column`. It was right to. I confirmed the cause was mine rather than pre-existing: `migrations/0071_auth_mfa.sql` creates the table with no `business_id`, and 0215 is the only migration that adds it.

The fix protects the table rather than weakening the test. Migration 0216 enables and forces RLS with the standard `tenant_isolation` policy, and `mfa_challenges` comes off `EXEMPT_TABLES`. That was safe only because I audited every access path first: the platform realms (`platform_user`, `platform_admin`) leave `business_id` NULL and are reached exclusively through `withoutTenantScope("platform", …)`, which sets `app.rls_bypass` and ignores the policy — `mfa-verify.ts`, `mfa-enrol.ts`, `mfa-service.ts`, and the send/rollback paths in `phone-otp.ts`. The `employee_phone` realm writes under the same bypass and reads under `withTenant(businessId, …)` in `verifyEmployeePhoneOtp`, where the row's business is the one being verified. So every existing path either bypasses deliberately or matches.

The effect on the platform rows is the point, not a side effect: with `business_id IS NULL` they now satisfy no tenant predicate, so they are invisible to every tenant-scoped connection and reachable only through the auditable bypass.

It is a separate migration rather than an edit to 0215 because 0215 has already run on the development database; editing it in place would leave that database unprotected with nothing to re-apply the fix.

---

## 6. Dead / legacy removed

- `useNextPath` and `safeNextPath` no longer carry independent validation logic; both delegate to `safeLoginNextPath`.
- `pin-pad.tsx`'s duplicated `4` / `12` literals are gone, imported from `pin-policy.ts`.
- The duplicated `OtpSendResult` shape was split into a proper `OtpSendReservation` union, removing the placeholder `challengeId: ""` that the old intersection type forced callers to fabricate.
- The `//`-but-not-`/\` inconsistency between the two next-path validators is gone with the second implementation.
- Seven hand-copied role allowlists removed (`pin-login`, `webauthn/login/verify`, `employee-service`, `iam/login-credential-sync` ×3, `iam/login-credentials-service`, `iam/sync` ×2), plus an eighth in `iam/login-credentials.ts` that was spelled `new Set([...])` and so escaped the `roles.test.ts` guard, which only matches array literals. All now derive from `@/lib/roles`.

The legacy PIN-only scan was reviewed but **not retired** — it is still the only door for staff without a linked platform identity, and removing it is a product decision rather than a cleanup.

---

## 7. Tests added / updated

| File | Tests | Notes |
|---|---:|---|
| `src/lib/login-contract.test.ts` | 33 | new — next-path, digit and PIN normalisation, bounded strings, error mapping, SMS paste extraction |
| `src/middleware.test.ts` | 28 | +5 — phone-OTP public, authenticated `phone/self` still gated, prefix siblings not public, `isBrowserLoginMutationPath` |
| `src/lib/phone-otp-policy.test.ts` | 24 | +`otpSendBudgetDecision` block — order independence, unparseable stamps, never a negative wait |
| `integration/phone-otp.integration.test.ts` | 13 | +5 — challenge mint/redeem harness, concurrent consumption, scope mismatch |
| `src/app/api/auth/phone-otp/verify/route.test.ts` | 12 | new — anti-enumeration equivalence, binding pass-through, trust offer |
| `src/components/auth/login-door-chooser.test.tsx` | 11 | new — `next` preservation, offline copy, capability degradation |
| `src/lib/trusted-device.test.ts` | 11 | new — trust matrix, exact 7-day boundary, invalid date fails closed |
| `src/components/auth/use-login-request.test.tsx` | 10 | new — busy release on reject/timeout/non-JSON, stale-response guard, cancel |
| `src/components/auth/phone-otp-step.test.tsx` | 7 | new — late verify after unmount cannot log in, in-flight verify is aborted, network failure releases the button, MFA branch preserved, SMS paste |
| `src/lib/login-eligibility.test.ts` | 12 | new — SQL fragment shape, per-profile widening, and that WebAuthn stays narrow when the PIN door widens |
| `src/lib/password-reset-request.test.ts` | 13 | new — budget boundaries, order independence, corrupt stamps, reset-email copy |
| `src/app/api/auth/password-reset/request/route.test.ts` | 8 | new — all six outcomes answer identically, no 429, no outcome echo |
| `integration/password-reset-request.integration.test.ts` | 7 | new — minting, single-live-link, cap at the exact boundary, against real PostgreSQL |
| `integration/trusted-device.integration.test.ts` | 7 | new — against real PostgreSQL |
| `src/app/api/api-guards.test.ts` | — | +2 registrations for the new routes |

Two of these are regression guards for bugs found during this work, not just coverage for new code: the verify-route equivalence test, and the `auth_login_attempts` constraint is exercised by the integration harness that now records real attempt rows.

**No test was disabled, no assertion loosened, no timeout raised, no visual baseline re-recorded.**

---

## 8. Verification / CI results

All commands run in this sandbox on the work commit.

| Command | Result |
|---|---|
| `NODE_OPTIONS=--max-old-space-size=3072 ./node_modules/.bin/tsc --noEmit` | **exit 0**, no output |
| `./node_modules/.bin/eslint . --max-warnings=0` | **exit 0** |
| `npx vitest run` (full unit suite) | **738 files / 9,655 tests passed**, exit 0, 410.7 s |
| `DATABASE_URL=… npx vitest run --config vitest.db.config.ts` (full integration suite, 203 files) | **203 files passed / 0 failed · 2,940 tests passed / 0 failed / 1 skipped**, 2351.5 s |

All figures above are measured at the merged head **`6e5f099b`** — `origin/main` merged into this branch, 0 behind / 26 ahead, with the originally published #885 head `4ad73b9` still an ancestor.

PostgreSQL for the integration run: **16.14**, started with the project's own `npm run db:dev:start` on 127.0.0.1:5432, with `npm run db:migrate` applied first exactly as CI does (**312 migrations** at this head, including the multicurrency work merged from main; a re-run is correctly a no-op).

The integration suite is **fully green**: 203/203 files, 2,940 passed, 0 failed, 1 skipped, 2351.5 s, from a single uninterrupted process. Two earlier runs of mine reported failures that were both artifacts of how I ran the suite rather than defects, and both are corrected below. No test was skipped, disabled, loosened or re-baselined to reach these numbers; the one skip is `platform-system-backup`'s peer-surface case, conditional on a second server.

**The single failing integration file was my harness error, not a defect — and an earlier draft of this report was wrong about it.**

| Failing file | Tests | Actual cause | Mine? |
|---|---|---|---|
| `runtime-role-regrant` | 2 | `relation "schema_migrations" does not exist` at `create-app-role.ts:108`. The root database `DATABASE_URL` points at had **never been migrated** — `to_regclass('public.schema_migrations')` returned `null` and `pg_tables` counted **0** rows in `public`. | Yes — harness |

**Root cause, found rather than assumed.** CI does not run the suite against a bare cluster. `test.yml` applies migrations first and proves the second run is a no-op:

```
- name: Apply migrations
  run: npm run db:migrate          # test.yml:96-97
- name: Re-apply migrations (must be a no-op)
  run: npm run db:migrate          # test.yml:99-100
- name: Integration tests
  run: npm run test:db             # test.yml:102-103
```

I had skipped both migrate steps. Most integration files build their own scratch database and migrate it themselves, so the omission was invisible until a file that targets the *root* database — `runtime-role-regrant` calls `createAppRole`, which grants on `schema_migrations` — reached it.

After `npm run db:migrate` (**305 migrations applied**, `public` now **442 tables**, re-run correctly a no-op), the file passes **2/2**:

```
✓ integration/runtime-role-regrant.integration.test.ts (2 tests) 129ms
Test Files  1 passed (1)   Tests  2 passed (2)
```

**Correcting a claim I made earlier.** I had written that this failure was "proven pre-existing" because it reproduced identically in a worktree at `origin/main`. That reasoning was invalid: I made the *same* harness omission in both worktrees, so the comparison could only ever reproduce my own error. It proved nothing about the code. The correct procedure — the one CI encodes — makes the failure disappear, and no production source file needed to change.

An earlier full run of mine reported a second failure, `backup-locks` throwing `DATABASE_URL is required` at *collection*. That was an artifact of how I launched the suite: I relied on `.env` rather than exporting the variable. CI sets `DATABASE_URL` at the **job level** (`test.yml`, integration job `env:`), and exporting it the same way makes the failure disappear — which is what the figures above measure. Worth recording because it means a local run must export `DATABASE_URL` explicitly; `.env` alone is not sufficient once an earlier file has replaced the value.

**The second artifact: two overlapping suites.** A run that reported `hybrid-sync` failing 10 tests was contaminated by my own mistake — I had started a second suite while the first was still running, and both were creating and dropping scratch databases on the same cluster for about five minutes. Run on its own, `hybrid-sync` passes **18/18**, and the clean single-process run above has zero failures. Running two integration suites against one cluster concurrently is never valid here.

**Where the earlier failure reports went.** An earlier draft of this report tabulated 13 integration failures across 196 files. That table is superseded by the run above and is reproduced here only so the discrepancy is visible rather than silently edited away. All 13 traced to the environment I ran them in, not to the code: they came from a PostgreSQL **18.4** cluster, where `platform-system-backup` (7) hit `pg-tools.ts`'s major-16 guard, and `runtime-database-url` (4) plus `runtime-role-regrant` (2) needed `APP_DB_PASSWORD`. Against the project's own PG 16.14 cluster started by `db:dev:start`, `platform-system-backup` **passes 21/21** and `runtime-database-url` **passes 7/7**. `runtime-role-regrant` needed neither a special cluster nor `APP_DB_PASSWORD` — only the `npm run db:migrate` step CI runs and I had skipped; it now **passes 2/2**.

Both preconditions were re-checked on this box rather than assumed: the `pg_dump` search returns nothing, `env | grep APP_DB_PASSWORD` is empty, and `pg-tools.ts:195` is `if (postgresMajor !== 16) throw`.

**One earlier failure was mine and is now fixed.** A run taken before the final commit failed `tenant-isolation` with `mfa_challenges is exempt but carries a tenant column`: migration 0215 had given that table `business_id` and `destination` while it was still listed as RLS-exempt. Migration 0216 adds the RLS policy and drops it from `EXEMPT_TABLES` (§5), and `tenant-isolation` passes in the run above — which is why the count is 193/3 here rather than the 192/4 of that earlier run.

The **1 skipped test** in the verified run is `platform-system-backup`'s peer-surface case, conditional on a second server being present. It was skipped by its own `describe.skip`, not failed, and not disabled by me. (An earlier draft reported 10 skips; that figure belonged to the superseded 18.4 run.)

Database for the verified run: PostgreSQL **16.14**, provisioned via `embedded-postgres` on 127.0.0.1:5432 by the project's own `npm run db:dev:start`, migrations applied through `scripts/migrate.ts`.

Baseline before any edits, same environment, measured by checking out base commit `d14f0e3` in a separate worktree: `npx tsc --noEmit` exit 0 and `npx vitest run` → **666 files / 8,386 tests passed**, exit 0. At the merged head the same command reports **738 files / 9,655 tests**, exit 0. That total is *not* attributable to #885 alone: merging `main` brought in its own accounting and multicurrency tests, so the 8,386 → 9,655 delta is the sum of both bodies of work and I have not tried to split it. What this branch contributes on its own is the 9 unit test files added in §7, measured against the pre-merge branch head; no existing test was removed, and none had an expectation weakened to obtain green.

GitHub CI: **this repository does have CI** — 14 workflows under `.github/workflows/`, and `test.yml` alone runs 10 jobs. An earlier draft of this report claimed no CI existed; that was wrong and is corrected here.

The `test.yml` run at the published head **`c05e9429`** is **fully green — all 10 jobs `success`**, reported across the two runs GitHub split it into ([`38170129564`](https://github.com/hamidnoshady/biza-miz/actions/runs/38170129564) and [`38170125462`](https://github.com/hamidnoshady/biza-miz/actions/runs/38170125462)), with the `all checks passed` roll-up job itself `success`:

| Job | Result |
|---|---|
| unit tests | ✓ 4m53s |
| **production build** | **✓ 5m4s** |
| integration tests (real database) | ✓ 42m6s |
| data transfer engine (real database) | ✓ 1m32s |
| type check | ✓ 2m26s |
| ESLint (noninteractive) | ✓ 2m10s |
| design checks | ✓ 22s |
| visual regression | ✓ 5m18s |
| media E2E tests | ✓ 3m57s |
| API guard and permission tests | ✓ 33s |

This supersedes the earlier figures in this report, which were measured at `4ad73b9` — the head *before* `main` was merged in. The numbers above are the ones that describe the code a reviewer would actually be merging. Two jobs outside `test.yml` are red; both are analysed in §8 below and §9.

**Two jobs outside `test.yml` are red. They have different causes, and only one of them is pre-existing.**

**(a) `desktop shell` (`verify-shippables.yml`, job `114561339250`) — a genuine regression on the merged head, caused by the merge.**

This one *is* attributable to this branch, and the earlier draft of this report did not mention it. The per-step conclusions from the Jobs API locate it exactly: steps 1–12 all `success` — including step 8, *Build production app and staged desktop runtime*, so the production build itself is fine — and step 13, **`Staged runtime stays below pre-package budget`**, is `failure`. That step has exactly one failure mode: `.desktop-runtime` exceeding 200 MiB.

I reproduced it rather than inferring it. Adding swap to get past this sandbox's memory ceiling and running `npm run build && npm run desktop:runtime` at the merged head stages **215.6 MiB** (the script's own figure; `du -sb` = 227,355,383 bytes = 216.8 MiB) against a **200 MiB** budget. Composition: `.next` 138 MiB (`server/app` 108 MiB, `static` 18, `chunks` 12), `node_modules` 80 MiB (`@img` 37, `next` 28, `playwright-core` 7), `migrations` 3 MiB, `public` 1 MiB.

Attribution is a *combination*, and I want to state it precisely rather than assign it to either side:

- `desktop shell` **passed** at this branch's pre-merge head `51189607` (✓ 6m10s).
- `desktop shell` **passed** on `main` at `b8b66b21` (`verify-shippables` run `38135440182`, job `success`).
- `desktop shell` **fails** at the merged head `c05e9429`.

So neither parent alone crossed the budget; the merged tree does. The merge brought in 21 new API routes and 77 changed source files from `main`'s accounting/multicurrency work, which grows the traced `.next/server/app`; combined with this branch's 58 changed files the total passes 200 MiB.

Two caveats, stated plainly. The 215.6 MiB figure is a **Linux** measurement; CI runs this job on Windows, where the staged `@img` sharp binaries are `win32-x64` rather than the `linux-x64` + `linuxmusl-x64` pair (37 MiB) present locally, so CI's exact number differs and is unreadable here — the log host is unreachable (§ below). What is not in doubt is the direction: CI ran the same check and failed it.

**I did not raise the 200 MiB budget.** Doing so would be weakening an assertion to obtain green. The two honest resolutions are a deliberate maintainer decision to re-set the budget for the now-larger app, or a genuine reduction of the traced runtime — and the growth is `main`'s routes, not this branch's, so neither is this PR's call to make unilaterally. It is recorded as an open issue in §9.

**(b) `packaged Windows end-to-end` (`build-desktop-installer.yml`) — pre-existing on `main`, not this branch's doing.** It fails on this PR — and it also fails on **`main`'s own head `b8b66b21`**, which contains the main commit this branch merged but *none* of the #885 work (`git merge-base --is-ancestor 4ad73b9 b8b66b21` → false). It fails identically on three unrelated `arena/**` branches, and it was still green at `55a9b7ee`. Its cause is unrelated to (a): it reports a built installer, so it is not the size budget.

What the annotations show is that the package itself builds — "Installer 161.2 MiB; unpacked installed payload 620.2 MiB; PostgreSQL tools 1.1 MiB", version bumped 1.0.42 → 1.0.43 — and the job then exits 1. The exact failing step could not be read: GitHub's log-archive host (`productionresultssa12.blob.core.windows.net`) is not reachable from this sandbox, and every retrieval attempt returned `EOF`. So the *attribution* is established by the ancestry check above and the *cause* is not; it is recorded as an open, pre-existing failure on `main` rather than explained away.

The only annotations are `ubuntu-latest`→Ubuntu 26 migration notices.

**On the reported Arm64 production-build failure: I could not confirm it, and the evidence contradicts it.** I checked rather than repeating the claim:

- `grep -riE "arm64|aarch64"` across all 14 workflows returns **no Arm64 runner**. Every `runs-on` is `windows-latest`, `ubuntu-latest`, or a self-hosted `Windows, X64` label.
- The `production build` job is `test.yml:120-121` and runs on **`windows-latest`** (x64), not Arm64.
- The only Arm64-class runner in the repository is `macos-14` in `mobile-emulator-acceptance.yml`, and that job boots an **iOS simulator to prove HTTPS/WSS certificate trust** — it does not build the product. It is also `path`-filtered to `electron/` files, so it does not run for this diff at all.
- The production build in the run above **passed** in 4m24s.

So there is no Arm64 build failure in this repository's CI for me to fix or to list as a blocker. If a specific failing run is being referred to, it is not one I can see on this branch, and I have not invented one to match the expectation. The one real build limitation is the sandbox OOM described in §9, which CI does not share.

---

## 9. Genuine remaining issues

**The merged head exceeds the desktop runtime's 200 MiB budget, and `desktop shell` is red because of it.** This is the one item here that is a *regression introduced by this branch's merge*, and it is the first thing a reviewer should look at. Full diagnosis and attribution are in §8; the short form is that the staged runtime measures **215.6 MiB** against a **200 MiB** limit, that neither parent head crossed the limit on its own (`desktop shell` ✓ at pre-merge `51189607`, and ✓ on `main` at `b8b66b21`), and that the merge is what pushed it over. I did **not** raise the budget, because raising a limit to make a check pass is exactly the kind of green I was told not to manufacture. The two honest fixes are a maintainer decision to re-set the budget for the now-larger application, or a real reduction in the traced runtime — and since the growth is `main`'s 21 new API routes rather than this branch's auth work, choosing between them is not this PR's call to make alone.


**The production build is verified on CI, and only unverifiable *in this sandbox*.** `npm run build` here is OOM-killed (exit 137) on a machine with 3.9 GB RAM and no swap; building the untouched base commit is killed identically at the same point, so it is a memory ceiling, not a regression. The authoritative result is CI job `113936440462`, `production build` ✓ 4m24s (§8). An earlier draft called the build "unverified" outright; that understated it — it is unverified *locally* and green on CI.

**L10 depends on the deployment having SMTP configured.** The flow is implemented and tested, but it sends through the platform's `platform_message_config` singleton. On an install with no SMTP host, or with no `PLATFORM_BASE_URL`/`POS_DOMAIN`/`ROOT_DOMAIN` to build a link from, the service declines to mint a token and logs why — deliberately, because minting a link that can never be delivered would revoke the user's existing pending token and leave them worse off than before. The client keeps the admin-issued link visible alongside the email form for exactly that case. **An install with neither SMTP nor an admin who can reach the team screen still has no self-service recovery**, and nothing in this change creates one.

*(Correction to an earlier draft of this report: it claimed no email transport existed for platform identities. That was wrong. `resolveMessageConfig()` reads `platform_message_config WHERE id = true` under `withoutTenantScope("platform")` — a deployment-wide singleton, not a tenant setting — and `data-transfer/schedule-service.ts` already sends non-campaign mail through the same `SmtpMessageProvider`. L10 is implemented.)*

**L13 is partially addressed — the policy is now explicit, but the underlying divergence is untouched.**

What *is* done: the issue's "one explicit deployment-aware eligibility policy" now exists. `src/lib/login-eligibility.ts` is the single place that says which role set each door applies, and all eight hand-copied role lists are gone (§6). The doors' differing behaviour is now recorded as a decision with its reason attached, rather than being an accident of which file you opened.

What is **not** done, and is the substance of the finding:

- **WebAuthn never evaluates the phone policy.** Roster and PIN admit `owner, admin, manager, accountant` off cloud while WebAuthn verify accepts only the operational roles, and WebAuthn still does not consult the phone-OTP gate at all. Closing this is not mechanical: gating WebAuthn on the phone policy the way PIN is gated would lock out WebAuthn users at any business that never adopted phone OTP, the day the adoption window closes. That is a product decision about who may sign in by which method, and guessing at it would be worse than leaving it.
- **A local privileged PIN session still omits platform identity, `tokenVersion` and MFA state**, so the MFA grace banner never appears on that path.

  I looked hard at fixing this and deliberately did not, because the fix is not neutral. `pin-login` mints its session with `platformUserId: null` and never fetches `users.platform_user_id` at all. Four routes currently refuse a session in that shape, and populating the field would switch them on for a PIN-authenticated caller:

  | Route | Today, for a PIN session | After populating `platformUserId` |
  |---|---|---|
  | `auth/businesses` | returns an empty list | enumerates the member's other tenants |
  | `auth/mfa/self` | `GET` reports `not_required`; `POST` is `403 forbidden` | exposes real enrolment state **and** allows enrolling/removing factors |
  | `auth/password/self` | `409 no_login` | allows a password change |
  | `auth/switch-business` | `403 forbidden` | allows switching tenant |

  `signSession` would then also auto-populate `tokenVersion` from `platform_users` and subject the session to `checkPlatformIdentity`'s `token_version`/`is_active` re-check — which is the assurance the issue actually wants, but it arrives bundled with a cross-tenant capability that a four-to-twelve-digit PIN was never meant to grant on its own.

  So this is the same shape of decision as the WebAuthn one above, not a mechanical omission: it needs a deliberate answer to "what should a PIN-only session be allowed to do", ideally with a step-up for the sensitive routes rather than a blanket grant. Making that call unverified, late in the change, on a security boundary, was the wrong trade.

So the drift risk the finding warns about is removed; the assurance gap it describes is not. This remains the largest open item in the issue.

**L16 is largely addressed.** Copy corrections, the password toggle, `autocomplete` purposes and SMS paste extraction are in. What remains is open-ended: the finding also asks for broader input ergonomics, which is a design sweep rather than a defect list, and I did not attempt to define its scope here.

One note on how the paste fix was chosen. The obvious reading of the symptom is that `normalizeOtpCode` mishandles pasted text. It does not — it extracts `123456` from a full SMS body correctly. The actual cause is `maxLength={6}`: the browser truncates a paste to the field's maximum length *before* `onChange` fires, so the handler only ever saw `"Your c"`. Fixing the normaliser would have changed nothing. `otpFromPastedText` therefore runs in `onPaste`, where `clipboardData` still holds the untruncated text, and only accepts a digit run of exactly the expected length — lifting six digits out of a phone number or an order id would hand the member a plausible wrong code and cost them a failed attempt, which is worse than leaving the box empty for a retry.

**Hostless multi-match disclosure is retained deliberately.** When a phone number matches members at several businesses, the response names those businesses before any proof is offered. Closing it means changing a flow that legitimate users depend on, so it is reported here rather than silently "fixed".

**Superseded: the "3 environmental failures" claim was wrong, and I am correcting it rather than leaving it.** An earlier draft said the integration suite could not be completed in this sandbox and that `platform-system-backup`, `runtime-database-url` and `runtime-role-regrant` must wait for CI. That was false, and it was false for a reason worth recording: I had provisioned PostgreSQL **18.4** myself instead of using the project's own `npm run db:dev:start`, which brings up **16.14** — the version `pg-tools.ts:195` requires. The three failures were my cluster, not the code, and not a missing sandbox capability.

Against the project's own 16.14 cluster all three pass — `platform-system-backup` **21/21**, `runtime-database-url` **7/7**, `runtime-role-regrant` **2/2** — and the full suite is green at **203/203 files, 2,940 passed, 0 failed, 1 skipped** (§8). Nothing is outstanding on CI for this reason, and no test was skipped, disabled or loosened to reach that total.

Migration `0215` is additive (new nullable columns, widened constraints, one new table), and it was applied successfully by every file that ran across all attempts — the 20 from the partial full run plus the 12 targeted ones — so the migration itself is exercised well beyond the auth domain.

**One client item was deferred and then completed in this pass:** the `mfa-step.tsx` label and `role="alert"` work described in §4.
