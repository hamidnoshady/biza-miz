# Auth & account hardening (issue #854)

Follow-up to #809, and one coherent pass rather than a set of screen fixes.
This document is the map: what the pass changed, the invariant each change
buys, where it lives, and the items deliberately deferred with the reason.

Everything below is written against the code in this branch. Where a finding is
only *partly* closed the row says so — an accurate "not yet" is worth more than
a green table.

## Security invariants

| # | Invariant | Where it is enforced today |
|---|---|---|
| 1 | A privileged account cannot pick a weaker door to skip MFA | `pin-login` and `webauthn/login/verify` both refuse a privileged role whose policy requires MFA or which holds an active factor; `phone-otp/verify` applies the same gate |
| 2 | Membership administration cannot escalate past the actor | `src/lib/membership-authority.ts` (`membershipGrantRefusal`), asked by `POST /api/team`, `POST /api/team/invitations` and `PATCH /api/team/[id]` |
| 3 | A tenant admin cannot take over a global identity | `requestMemberPasswordReset` returns a *delivery* record only; the credential goes by SMS to the holder's **verified** phone (`issueDeliveredPasswordReset`) |
| 4 | OTP verification is bound to phone **and** purpose | `src/lib/otp-challenge.ts`, migration `0211` §1 (`purpose`, `candidate_phone_e164`); `expectedPhoneE164` refuses a mismatch before the code is compared. The table stays tenant-free on purpose — it is minted before any business is known, so the tenant is resolved after proof, not stored on the row |
| 5 | A one-time challenge is consumed atomically | `redeemOtpChallenge`: one transaction, `SELECT … FOR UPDATE`, conditional transition to `consumed_at` (`0211` §2) |
| 6 | MFA policy is one rule for every login path | `src/lib/mfa.ts` (`mfaAppliesToRole`, `privilegedMfaBaseline`) + `mfa-policy.ts`; asked by password, phone-OTP, PIN, biometric, invitation and step-up |
| 7 | Global identity security is judged across **all** memberships | `mfa-service.globalMfaRequirementForPlatformUser` (`mayRemoveGlobalMfaFactor` is the only decision point) |
| 8 | Cloud/Hybrid/Local ownership is explicit per field | `src/lib/credential-authority.ts` — a data table, not scattered `if (profile === "hybrid")` |
| 9 | Personal security in `/settings/profile`, organization security in Security Center, membership administration in Team | `(app)/settings/profile/page.tsx` passes server-computed surfaces; the policy card lives in the Security Center |
| 10 | Sensitive changes need recent auth in a credential the user actually has | `recent-auth.ts` + `src/lib/auth-contracts.ts` (`availableStepUpMethods`) + `components/auth/step-up-prompt.tsx` |
| 11 | Session UI describes the scope it revokes | `src/lib/session-contract.ts`, `/api/sessions/self` (`scope`, `sessionRevokeDescription`) |
| 12 | Sensitive mutations are audited | `src/lib/security-audit.ts` (`recordSecurityAudit`) writes a secret-free row **inside the same transaction** as every personal-security mutation in both realms (enrol start/confirm, factor removed/replaced, primary changed, recovery codes, step-up success/failure, session revoke scopes), plus the `audit_log` rows on every changed route (`auth.step_up`, `auth.self_phone_changed`, `auth.self_pin_changed`, `crew.pin_rotation`, `team.invited`, `team.invitation_accepted`, …) and the membership rows carrying actor + change + reason (GAP 4) |
| 13 | UI/API contracts are covered by regression tests | `src/lib/{auth-contracts,session-contract,credential-authority,membership-authority,auth-hardening}.test.ts`, `integration/auth-hardening-854.integration.test.ts`, `integration/auth-hardening-854-gaps.integration.test.ts` (second-pass gaps 1–8 + P2.21, including the replacement's UI contract), plus rendered contracts `src/app/(app)/settings/two-factor-settings.test.tsx` (replacement reachability, phone binding on confirm/resend, confirmation dialogs) and `src/components/auth/webauthn-manager.test.tsx` (profile WebAuthn surface, removal confirmation) |
| 14 | No duplicated phone/MFA state drifts between surfaces | the challenge row is the single source of the destination and purpose; `GET` returns the live challenge rather than letting the UI remember it |
| 15 | Door-changing decisions and door-changing writes cannot interleave | `src/lib/membership-lock.ts` — one advisory transaction lock per (business, membership), taken first by role transitions, creation, invitation acceptance, PIN writes, cloud credential/PIN replication, IAM event application, site commands, offboarding and owner-profile suspension (GAP 7). Deferred phone-verification stamps commit only after the whole ceremony (GAP 8, `MfaPendingPayload.phoneCompletion`) |

Realm isolation is unchanged: a tenant session is still a tenant JWT, the
Platform/Superadmin console still has its own cookie/jar and its own guards, and
nothing in this pass merges the two trust boundaries.

## P0 findings

| Finding | Fix | Regression |
|---|---|---|
| P0.1 `POST /api/team` bypasses anti-escalation | shared `resolveMembershipAuthority` → `membershipGrantRefusal` before any write | `membership-authority.test.ts`, `team.integration.test.ts` |
| P0.2 `POST /api/team/invitations` same hole | the identical shared refusal | as above |
| P0.3 tenant admin receives a usable reset credential | `requestMemberPasswordReset` delivers by SMS to the holder's verified number and returns `{deliveredTo, channel, expiresAt, email}`; the token exists only in the sent message; `no_verified_channel` when there is none | `auth-hardening-854.integration.test.ts` (P0.3) |
| P0.4 invitation acceptance bypasses authentication for an existing identity | the offered password must verify against the identity's **existing** hash (`authentication_required` / `invalid_credentials`), and the acceptance itself is now two phases: `beginInvitationAcceptance` (validate the invitation, authenticate, create the identity a first-time invitee's second factor hangs off) and `completeInvitationAcceptance` (write the membership). Nothing the ceremony promises is written until every factor is proven — the pending MFA token carries `invitationId`, and `/api/auth/mfa/verify` completes the acceptance on its success path, immediately before the session. Phase 2 re-locks the invitation, so one revoked mid-ceremony cannot land, and is idempotent for the identity it accepted. The invitation screen renders the shared `MfaStep` instead of navigating away on `res.ok` (it used to bounce the invitee to the login screen) | `auth-hardening-854.integration.test.ts` (P0.4 ordering), `team.integration.test.ts`, `auth-account-security.integration.test.ts` |
| P0.5 invitation `locationIds` not tenant-validated | validated at creation **and** re-validated under the acceptance transaction | `auth-hardening-854.integration.test.ts` (P0.5) |
| P0.6 privileged PIN login bypasses MFA and sets `platformUserId: null` | a privileged role is refused the staff door when MFA applies or a factor exists (403 `mfa_required`); biometric now runs the same gate; PIN/biometric sessions carry the real `platformUserId` + `tokenVersion` | `pin-login/route.ts`, `webauthn/login/verify/route.ts` |
| P0.7 phone OTP stamps `otp_login_at` before MFA | the stamp is deferred into the terminal step of `completePhoneLogin`, after the MFA decision | `phone-otp.integration.test.ts` |
| P0.8 self OTP accepts a fresh phone at verify | purpose and destination are read from the challenge row; the body's `phone` is never used at verify | `phone-otp.integration.test.ts`, `auth-hardening-854.integration.test.ts` |
| P0.9 the last factor is removable from the wrong business | `mayRemoveGlobalMfaFactor` + `globalMfaRequirementForPlatformUser` (strictest active membership wins) | `auth-hardening-854.integration.test.ts` (P0.9) |

## P1 findings

| Finding | Fix |
|---|---|
| P1.1 `admin` missing from the mandatory policy | `PRIVILEGED_MFA_ROLES = PASSWORD_ROLES` (owner/admin/manager/accountant); owner+admin mandatory by construction, manager/accountant configurable (`mfa.requireForManagers`, `mfa.requireForAccountants`). Every login door reads the *whole* policy: `mfaAppliesToRole(role, policy)` takes the object, so `requireForAccountants` reaches password, phone-OTP, PIN and WebAuthn sign-in alike. Two service reads were reading a key nothing writes (`security.mfaPolicy`); both now bind `SETTING_KEYS.mfaPolicy` (`mfa.policy`), and the Security Center roster query matches `admin` and opt-in `accountant` as well as owner/manager |
| P1.2 Profile MFA UI hard-coded to `["owner","manager"]` | `page.tsx` passes `credentials.hasGlobalIdentity`; a PIN-only member gets an explanation instead of a form |
| P1.3 Profile sends `DELETE /api/sessions/self` while the route is `POST` | `export const DELETE = POST` |
| P1.4 session list and revoke scope disagree | the list is business-scoped and so is `revoke_others`; `revoke_all` is a separate, confirmed, explicitly global sign-out (`scope: "global"`) |
| P1.5 session API/UI contract drift (`issuedAt`, `lastSeenAt`, missing `locationName`) | one typed `SelfSessionView`; the UI renders `sessionActivityIso()` and shows business/branch/method |
| P1.6 a PIN-only member cannot satisfy recent auth | step-up accepts `pin` (verified with `verifySelfPin` + lockout) alongside password/TOTP/SMS/recovery; the prompt offers exactly `availableStepUpMethods` |
| P1.7 self PIN change has no Profile UI / no re-auth | Profile card → `POST /api/auth/pin/self`, recent-auth + current PIN required; Team keeps the administrative reset |
| P1.8 WebAuthn add/remove lacks recent auth | `requireRecentAuth` on `register/options`, `register/verify`, `credentials/[credentialId] DELETE` |
| P1.9 broken step-up contract (`mfaCode` vs `code`, no method) | `parseStepUpRequest` / `stepUpBody` — one schema, used by the route and every prompt |
| P1.10 SMS step-up has no UI challenge flow | `action: "send_sms"` on the step-up route + the SMS button in `step-up-prompt.tsx` |
| P1.11 step-up confirms pending enrolments | two *named* ceremonies: step-up and the login interstitial prove a confirmed factor (`verifyExistingConfirmedMfaFactor`), the enrolment screen activates one (`verifyAndConfirmPendingMfaEnrolment`). The login interstitial confirms a pending row only when the account has no confirmed factor at all — `mayConfirmPendingEnrolmentAtLogin` — so a mid-enrolment member is not locked out and a half-finished enrolment is never anyone's second factor. (The `confirm` actions on `/api/auth/mfa/self` and `/api/platform/mfa` had been calling the *strict* verifier, so no pending enrolment could ever be confirmed; both now call the enrolment ceremony explicitly.) |
| P1.12 role transitions not credential-aware | `loginCredentialModelForRole` splits the roles into the two doors (password role → the global identity behind the login screen, PIN role → the staff door). Every role change and every reactivation is checked inside the same transaction as the write (`assertRoleTransitionKeepsLoginPath`) and refused with the missing credential's own code — `identity_required`, `identity_inactive`, `password_not_set`, `pin_required` — rather than provisioning a credential the member never chose. Suspended memberships move freely, because reactivation is re-checked. The member editor warns before the save using `hasLogin` / `hasPin` |
| P1.13 Hybrid invitations not blocked | `createInvitation` refuses on a Hybrid profile (`cloud_confirmation_required`), like direct creation |
| P1.14 Hybrid writes to cloud-owned PIN/phone | `describeCredentialSurface` guards in `/api/auth/phone/self`, `/api/auth/mfa/self` and `setPin`; the table decides, not the route |
| P1.15 Profile shows editable controls Hybrid rejects | the page passes the surfaces; the cards render read-only with «این مورد در نسخهٔ ابری مدیریت می‌شود.» |
| P1.16 self phone change lacks a duplicate pre-check | `isPhoneTaken` before the SMS **and** again on the verify path |
| P1.17 challenge consumption not concurrency-safe | row lock + `consumed_at` (§1–2 of `0211`) |
| P1.18 phone login anti-enumeration incomplete | the business list is only returned after a valid code; before that the multi-business path answers exactly like any other send |
| P1.19 multi-business phone/password selection UI | one shared step, `components/auth/business-picker.tsx` (`useBusinessSelection` + `BusinessPicker`). Both doors render it: the phone-OTP step replays its `selectionToken`, and the password door re-posts `{email,password,businessId}` — it has no token, because `/api/auth/login` re-verifies the credentials on every call. The password door previously read `res.ok` as a successful login and navigated, so a member of two businesses looped back to the login screen with no explanation |
| P1.20 biometric roster and verify disagree on roles | both use `PIN_ROLES` plus the privileged site door off-cloud, so an offered button always works |

| Invariant 4 — a code is only good for the transaction it was minted for | every second-factor caller states its `smsPurposes`: step-up spends `step_up_sms` only, the login interstitial `mfa_login` only, the enrolment screen `mfa_enrol_sms` only (its resend now mints that purpose rather than inheriting the login default). A caller that states nothing gets nothing — `verifySmsOtp` fails closed instead of falling back to "whichever second-factor purpose is live" |

## P2 findings

The ids below follow the issue's own numbering. The first pass's draft of this
section mixed several of them up (it credited the MFA action allowlist to P2.2
instead of P2.18, treated P2.4 as closed by the permission editor when P2.4 is
the *required reason*, read P2.12 as the invitation's custom role when P2.12 is
the PIN copy, and gave P2.25/P2.24 each other's topics). This table is the
corrected record: one row per finding, status, and where the proof lives.

| Finding | Status | What was done / why it is deferred |
|---|---|---|
| P2.1 settings tab admits `team.view` | resolved (pass 1) | roster renders read-only for it |
| P2.2 Team UI permission controls gated | resolved (pass 1) | mutating controls require `team.permissions_manage`; request shape omits the permission half without it |
| P2.3 permission registry duplicated | resolved (pass 1) | member editor + roles dialog render the canonical `PermissionEditor` |
| P2.4 "reason required" was only UI metadata | **resolved (pass 2, GAP 4)** | server-validated meaningful reasons (8–500 chars, whitespace-normalised) in `validateAccessChangeReason`; enforced inside the write — `updateMembership`, `createMembership`, `createInvitation` (stored on the invitation, inherited by the acceptance audit), `createTenantRole` (always) and `updateTenantRole` (permission/archive/scope changes, not description-only edits). The validated reason, the actor and the change ride the IAM event and the audit row. The member editor, roles dialog and invite dialog show the reason field exactly when the server will demand it; role archiving asks for its reason. Blank/missing/short refusals and successful persistence are pinned in `integration/auth-hardening-854-gaps.integration.test.ts` (GAP 4) |
| P2.5 personnel/membership identity drift | deferred — product decision | membership renames repair the personnel file (`ensureEmployeeParty` is the repair path, covered by `parties.integration.test.ts`); whether a personnel edit may rename a membership backwards is undecided. Nothing reads the stale copy for authorization |
| P2.6 membership-linked party hard-deleted | **resolved (pass 2)** | `removeParty`'s history check now counts the `employee_user_id` link itself, so a member's personnel file is archived, never hard-deleted; pinned by the new case in `parties.integration.test.ts` |
| P2.7 personnel subsection without `parties.view` | deferred — scope | the Team page degrades instead of crashing; a membership-scoped personnel read path is a larger change recorded rather than guessed |
| P2.8 offboarded member looks "reactivatable" | partly resolved | reactivating a stripped (offboarded) membership is refused; a true rehire flow (new states, credential re-establishment) needs a migration — deferred as a product decision |
| P2.9 re-invite collides with retained rows | partly resolved | invitations supersede pending ones per address and acceptance is idempotent per identity; an explicit rehire/relink workflow is part of the same deferred product decision as P2.8 |
| P2.10 branch-scope validation incomplete | resolved (pass 1) | explicit scope validated at creation and acceptance |
| P2.11 invitation UI lacks branch scope | resolved (pass 1) | the invite form asks for scope + branches |
| P2.12 PIN uniqueness copy and implementation disagree | resolved (pass 1) | the PIN surface copy and the blind-index constraint now describe the same per-business rule |
| P2.13 PIN uniqueness race-prone check | resolved (pass 1) | keyed blind index + unique index, migration `0211` §3 |
| P2.14 custom-role `default_location_scope` dead | **resolved (pass 2, GAP 10)** | the scope is now applied: `createTenantRole`/`updateTenantRole` store and serve it (update is an access change and needs a reason), the roles dialog edits it, and both membership-creation paths inherit it when no explicit branch policy is given — refusing `selected`/`home` defaults that cannot be honoured instead of silently widening to "all". Pinned by the GAP 4 invitation/creation cases in `auth-hardening-854-gaps.integration.test.ts` |
| P2.15 confirmPassword ignored | resolved (pass 1) | one server-side validator |
| P2.16 whitespace-only password | resolved (pass 1) | rejected by the same validator |
| P2.17 password error contracts drift | resolved (pass 1) | shared error codes/messages |
| P2.18 MFA endpoint lacks an action allowlist | resolved (pass 1) | explicit `KNOWN_MFA_ACTIONS` allowlist on `/api/auth/mfa/self` |
| P2.19 pending setup not resumable | resolved (pass 1) | `GET` surfaces return the live challenge; masked destination from the challenge, not the client |
| P2.20 two SMS numbers for one user | resolved as *kept separate*, labelled | the login phone (membership, `users.phone_e164`) and the MFA SMS factor (identity, `mfa_enrolments.phone_e164`) are independent by design; Profile labels them as login vs second factor, and the strict verifier binds each code to the number its challenge was sent to — collapsing them would make "which number gets which code" ambiguous |
| P2.21 replacing the only SMS factor | **resolved (pass 2 backend, pass 3 UI)** | enrolment accepts `replaceConfirmed` for a *different* number, keeps the confirmed row untouched during the ceremony (never factorless), and the confirmation commits the swap inside the account lock — `commitSmsFactorReplacement` semantics live in `confirmMfaEnrolment` (`provenPhoneE164`), audited as `auth.mfa_factor_replaced`. Pass 3 finished the *screen* half the service tests could not see: the tenant and platform cards render «تغییر شمارهٔ دریافت» for a member who already has a confirmed SMS factor (the form used to render only when none existed), the confirmation and the replacement resend both name the new number (`expectedPhoneE164` / `provenPhoneE164` carry it; a provided phone that does not canonicalise is a 400, never a silent drop), the swap itself waits behind the P2.26 confirmation, cancellation sends nothing, and a reload resumes a fresh enrolment from `pendingSmsPhone` (a replacement deliberately restarts — the screen says so). Pinned by the P2.21 cases in `auth-hardening-854-gaps.integration.test.ts` (swap-on-proof, wrong-destination refusal, resend-to-named-number, abandon-mid-ceremony, concurrent replacement-vs-removal) and by the rendered contract `src/app/(app)/settings/two-factor-settings.test.tsx` |
| P2.22 personal security under-audited | **resolved (pass 1 + pass 2, GAP 5)** | `recordSecurityAudit` writes a secret-free row inside the same transaction as every sensitive mutation (enrol start/confirm, factor removed/replaced, primary changed, recovery codes, step-up success/failure, session revoke scopes) in both realms; `auditRevocation` no longer swallows failures |
| P2.23 Persian digits in OTP/TOTP inputs | resolved (pass 1) | `toLatinDigits` normalisation before validation |
| P2.24 "trusted device" wording inaccurate | **resolved (pass 2)** | `otp_login_at` is membership-wide and the wording now says so — the Profile phone card reads «رمز عددی تا ۷ روز برای همهٔ ورودهای این عضویت کار می‌کند (نه فقط یک دستگاه)»; the security-center and login-screen copy already described the window without per-device claims. No per-device trust is claimed anywhere |
| P2.25 resend UX for phone verification | resolved (pass 2 + pass 3) | server-side cooldown and caps (`checkPhoneOtpRateLimit`: 60 s resend, 5/hour, 20/day; the MFA challenge limiter is the twin) with `retryAfterMs` surfaced by the routes. Pass 3 finished the presentation the issue actually asks for, via one shared hook (`components/auth/use-resend-cooldown.ts`): a **live ticking countdown** seeded from the challenge's real send time (so a reload mid-window shows the honest remainder, not a fresh 60), the limiter's own `retryAfterMs` rewriting the window on a 429, the masked destination, and a live expiry line (`smsChallengeExpiryMessage`) driven by `useNowTick`. Wired into the tenant two-factor card, the platform console card, the Profile login-phone card (whose pending challenge now carries `requestedAt`), and the door's `phone-otp-step` |
| P2.26 destructive actions confirmed | **resolved (pass 3)** | one shared product confirmation (`components/auth/security-confirm-dialog.tsx`): consequences are a required, rendered list; cancellation sends no mutation; while busy the dialog cannot be closed and both buttons disable, so a retry cannot duplicate the mutation; recent-auth stays a separate gate. It now fronts every destructive personal/membership-security action that used to be a bare `confirm()` or nothing: factor removal and recovery-code regeneration (tenant card + platform console card), the SMS-factor swap, WebAuthn credential removal, team suspension and offboarding, and the IAM card's «ترمیم از نسخهٔ ابری» and detach-to-local. Session revocation keeps its own inline confirmed panel (P1.4). Pinned by `two-factor-settings.test.tsx` and `components/auth/webauthn-manager.test.tsx` |
| P2.27 weak device/session labels | resolved (pass 1) | device labels + login methods recorded |
| P2.28 personal security split across surfaces | **resolved (pass 3)** | `/settings/profile` is the canonical personal-security screen **including WebAuthn**: pass 3 extracted the sidebar-only biometric overlay into the reusable `components/auth/webauthn-manager.tsx` card, added it to the profile under the `webauthn_credential` credential surface (server authority unchanged — writable on every profile, read-only contract honoured), and reduced the sidebar's `BiometricSettingsButton` to a link to the profile instead of a duplicate panel. Pinned by `components/auth/webauthn-manager.test.tsx` |

### Second-pass gaps (GAP 1–10) mapped to findings

| Gap | Findings touched | Where |
|---|---|---|
| GAP 1 — initial SMS enrolment purpose | invariant 4, P1.11 | `enrolMfaMethod` names `mfa_enrol_sms` on the first send; first send → confirm completes without a resend, both realms (`auth-hardening-854-gaps`, GAP 1) |
| GAP 2 — strict SMS step-up binding | invariant 4, P1.10/P1.11 | `issueSmsMfaChallenge(requireActiveFactor)` + strict verifier; pending factors rejected even via crafted direct calls; removing the factor invalidates a minted challenge (GAP 2 cases) |
| GAP 3 — last-factor removal atomicity | P0.9, invariant 7 | `withMfaAccountLock` around every factor lifecycle mutation; concurrent removals serialise and the second refuses the last factor (GAP 3 case) |
| GAP 4 — required access-change reasons | P2.4 | see the P2.4 row |
| GAP 5 — MFA/recovery audit coverage | P2.22, invariant 12 | `src/lib/security-audit.ts` — secret-key guard, retry-once-then-throw, attribution in both realms |
| GAP 6 — membership.created payload drift | replication integrity | payload equals the persisted row (`customRoleId` no longer hard-coded `null`); the event carries the reason; a site applying it grants the custom role (GAP 6 case) |
| GAP 7 — unlocked login-path assertion | P1.12, invariant 13-adjacent | `src/lib/membership-lock.ts`: one advisory-lock protocol for role transitions, creation, PIN writes, cloud PIN/credential replication, IAM event application, site commands, offboarding and owner-profile suspension. Proven by making one transaction wait on the other, plus a rollback case (GAP 7 cases) |
| GAP 8 — deferred phone verification | P0.7 | the MFA pending token carries `phoneCompletion`; `/api/auth/mfa/verify` commits the stamps only after the second factor, the session keeps `phone_otp` provenance, abandonment commits nothing (GAP 8 cases). Fixing this surfaced migration `0216`: the `auth_login_attempts` realm check had never admitted `phone_otp`, so phone-OTP sends failed the constraint — a real bug the test caught |
| GAP 9 — this document | — | corrected ids and acceptance matrix (you are reading it) |
| GAP 10 — deferred items | P2.5–P2.9, P2.14, P2.20, P2.21, P2.24, P2.25 | P2.6/P2.14/P2.21 completed (rows above); P2.24 wording fixed; the rest are recorded product decisions with their reason |

## Known limitations, stated plainly

- **Legacy `users.pin_hash` rows.** Every PIN read goes through
  `coalesce(ec.secret_hash, u.pin_hash)`, so a pre-migration bcrypt hash still
  signs its owner in, but such a row sits *outside* the keyed blind index —
  uniqueness for it is not enforced by the constraint, and it cannot be looked
  up by index. No code path writes that column any more (creations and
  rotations write `employee_credentials` + the index; suspension/offboarding
  and cloud replication only ever NULL it). The safe migration policy is
  rotation on next contact: an affected member sets a new PIN through the
  normal self-service or admin-reset flow, which writes the indexed credential,
  and the legacy column is then cleared. Until that happens the legacy hash
  remains the only door for that member — which is why it is kept readable
  rather than dropped.
- **`issueCredential` / `verifyCredential` were dead code and are removed.**
  The audit found no route, job, script, dynamic import or test calling them;
  they were a parallel bcrypt PIN path that bypassed the blind index, so they
  are deleted rather than left as a hole around the one-source-of-truth rule.
- **The invitation reason lives on the invitation, not the membership.** The
  acceptance audit inherits it; the membership row itself does not carry it,
  because by acceptance time the access was decided at invite time and the
  audit trail — not the roster — is where justifications belong.

## Tests that pin this

Pure rules (no database): `auth-contracts`, `session-contract`,
`credential-authority`, `membership-authority`, `auth-hardening`
(OTP purposes/normalisation, PIN policy).

Against Postgres: `integration/auth-hardening-854.integration.test.ts` (P0.3,
P0.4's ordering, P0.5, P0.9, P1.1 — the console roster reads the canonical policy
key and covers `admin`/`accountant` — P1.7, P1.11 — the strict/pending pair and
the login predicate's consequences — P1.13, invariant 4's purpose isolation,
P2.13), `integration/auth-hardening-854-gaps.integration.test.ts` (the second
pass: GAP 1's one-send enrolment in both realms, GAP 2's strict-binding and
factor-removal invalidation, GAP 3's concurrent last-factor removal, GAP 4's
reason refusals and persistence across memberships/roles/invitations, GAP 6's
event-payload-equals-row and site application, GAP 7's lock serialisation and
rollback, GAP 8's deferred stamps through the real routes, and P2.21's atomic
SMS replacement — the swap on proof plus the UI-contract cases: a replacement
resend bound to the named number, wrong-destination refusal, abandonment leaving
the old factor authenticating, and a concurrent replacement-vs-removal that can
never end factorless), `integration/team.integration.test.ts` (P1.12's four transition
cases, now exercising the reason rule), plus the updated
`integration/{team,auth-account-security,phone-otp,iam-login-credentials,parties}.integration.test.ts`.

Rendered component contracts (jsdom, real components against a fake server):
`src/app/(app)/settings/two-factor-settings.test.tsx` — the replacement form is
reachable with a confirmed SMS factor, the enrol/confirm/resend bodies carry the
new number, the swap waits behind its dialog and cancellation sends nothing,
factor removal and recovery regeneration are dialog-gated, a reload resumes a
fresh enrolment from the server's pending row, and a 429 surfaces the limiter's
message — and `src/components/auth/webauthn-manager.test.tsx` — the profile's
WebAuthn card lists devices, renders the empty state, gates removal behind the
confirmation (cancellation sends no DELETE), and a read-only deployment surface
renders the notice without controls. These exist because the service tests
proved the backend of P2.21 while the screen still hid the form — the layer the
issue said was broken.

Screen contracts without rendering: `src/lib/admin-screen-contracts.test.ts`
holds the admin screens to the same rules the routes enforce, including P1.19 —
both doors import the shared picker, keep the pending choice in the shared hook,
and check `capture(data)` *before* treating the response as a sign-in.

## Remaining work

Every P0 and P1 finding is closed end to end. Of the P2 list, all items are
resolved except three recorded product decisions, none of which hides a
security invariant:

- **P2.5** personnel edits renaming memberships backwards — needs a product
  ownership decision; the forward direction (membership rename repairs the
  personnel file) is implemented and tested. (P2.5 is identity drift between a
  membership and its personnel file, not anything the MFA rows touch.)
- **P2.7** a membership-scoped personnel read path for Team managers without
  `parties.view` — the page degrades safely today; the dedicated path is a
  larger change. (P2.7 is about reading personnel without `parties.view`, not
  permission gating in general.)
- **P2.8 / P2.9** suspend→reactivate is safe and re-checked; offboard→rehire
  needs new membership states, credential re-establishment and a migration.
  The dangerous half — reactivating a stripped membership as if nothing
  happened — is refused today.

Items closed in the third pass that earlier drafts of this document credited to
pass 1/2 without the screen half being done: P2.21 (the replacement UI), P2.25
(the live countdown/expiry feedback), P2.26 (the confirmation dialogs), P2.28
(WebAuthn on the profile). P2.20's two phone numbers — the membership's login
phone and the identity's MFA SMS factor — are kept deliberately separate and
labelled; the rationale is in its row above.

## Gate results in this workspace

| Step | Result |
|---|---|
| `npx tsc --noEmit` | clean (pass-3 head `4e1dd30`, 2026-10-09) |
| `npm test` | 706 files / 9270 tests passed (pass-3 head) |
| `npm run lint` (`eslint . --max-warnings=0`) | clean (pass-3 head) |
| `npm run test:design` | 38 passed (pass-3 head) |
| `npm run test:db` | 199 files / 2743 tests passed, 1 skipped (pass-3 head `4e1dd30`, local Postgres 5432, 2026-10-09) — including the extended `auth-hardening-854-gaps` suite (23 cases) and every tenant-isolation/team/phone-otp file |
| `npm run build` | production build completed with `NODE_OPTIONS=--max-old-space-size=3072` (same as CI) once the sandbox gained swap; every earlier attempt on the swap-less 4 GB box was OOM-killed |
| `npm run test:visual` | run locally against the CI-mirrored recipe in `docs/design/visual-regression.md` (Chromium `141.0.7390.0` from `@sparticuz/chromium@141.0.0`, seeded DB, production server, `TZ=Asia/Tehran`). Before this pass it failed exactly as CI did, and **only** on `accounting-expenses` (3.67% of pixels, bounds 54,18 1342×831; CI measured 4.06% at 54,18 1370×830 on the same stale baseline) with the other 13 screens byte-comparable. The diff is the #832 expenses redesign — the screen gained the VAT checkbox, the receipt-upload file input, the status/receipt/number/actions columns and the «پرداختی از حساب‌ها» totals line, all on the existing primitives (teal primary, amber eyebrow, the same table skin) — for which no baseline was ever re-recorded, on main as well as here. Reviewed per policy and re-recorded once, committed with this explanation; the suite is now 14/14 |
