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
| 9 | Personal security in `/settings/profile`, organization security in Security Center, membership administration in Team | `(app)/settings/profile/page.tsx` passes server-computed surfaces; the Security Center renders policy posture only — its personal phone card links to the Profile ceremony instead of duplicating it (pass 4) |
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
| P0.6 privileged PIN login bypasses MFA and sets `platformUserId: null` | a privileged role is refused the staff door when MFA applies or a factor exists (403 `mfa_required`); biometric now runs the same gate; PIN/biometric sessions carry the real `platformUserId` + `tokenVersion` | `pin-login/route.ts`, `webauthn/login/verify/route.ts`; pinned by the P0.6 cases in `auth-hardening-854.integration.test.ts` — refusal under a requiring policy, refusal for a confirmed factor under a permissive policy, no session minted, and the staff door still open for an uncovered PIN role |
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
| P1.16 self phone change lacks a duplicate pre-check | `isPhoneTaken` before the SMS **and** again on the verify path. Pinned by the P1.16 case in `auth-hardening-854.integration.test.ts`: a taken number answers 409 with no SMS spent, a free number sends, a number taken mid-window is refused at verify, and nothing is stamped on a refusal — all driven through the real route with a real signed session |
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
| P2.5 personnel/membership identity drift | **resolved (pass 4)** | canonical ownership defined exactly as the issue prescribes: the membership row (`users`: `full_name`, `email`, `phone_e164`) and the global identity own the login-identity fields; the personnel record keeps HR-only fields. A personnel write that would *change* a shared field away from the membership's value is refused with `identity_{name,email,phone}_managed_by_membership` (HTTP 409 + fieldErrors from `/api/parties/[id]`), so `/api/parties` can never silently fork a conflicting identity copy; repair writes that align the party with the membership stay allowed, and unlinked parties are untouched. The membership→party direction remains the repair path — since issue #947 it is one guaranteed operation, `ensurePersonnelFileForMembership` in `src/lib/personnel-file.ts`, called by every door that creates or changes a membership (create, update, rehire, `setMemberPhone`, invitation acceptance, setup, IAM replica) and retried from `GET /api/team` and `scripts/reconcile-personnel-files.ts` when it fails; the old route-local `ensureEmployeeParty` writer is gone. Nothing reads a stale personnel copy for authorization. Pinned by the canonical-ownership cases in `parties.integration.test.ts` and the sync cases in `team.integration.test.ts` |
| P2.6 membership-linked party hard-deleted | **resolved (pass 2)** | `removeParty`'s history check now counts the `employee_user_id` link itself, so a member's personnel file is archived, never hard-deleted; pinned by the new case in `parties.integration.test.ts` |
| P2.7 personnel subsection without `parties.view` | **resolved (pass 4)** | the issue offers two fixes; the Team page now implements the first — the personnel subsection mounts only when the signed-in member can actually read it: `canViewParties(role, permissions)` from the shared `parties-scopes` module gates the single `<PartiesSection>` mount (no unconditional fallback mount), so a team manager with team access but no `parties.view` sees a clean team screen instead of a 403-ing subsection. The dedicated membership-scoped personnel read path stays recorded as possible future work; the `parties.view` permission itself was *not* widened to make the error disappear |
| P2.8 offboarded member looks "reactivatable" | **resolved (pass 4)** | actions now derive from the lifecycle state: suspended members get «فعال‌سازی» (reactivate), offboarded members get «بازگشت به کار» (rehire) and nothing else — the generic activate button no longer renders for an offboarded row, and the service refuses `not_offboarded` in the other direction. Rehire is an explicit ceremony, `POST /api/team/[id]/rehire`, holding the membership row lock, gated on `team.manage` **and** `team.permissions.manage` (a rehire re-grants the stored role/permissions), with the whole grant re-checked against the actor (`grants_beyond_actor`) and owner-only/self checks preserved. It restores the identity linkage (relinks or mints the platform identity, preserving the historical membership row — no history deletion), re-establishes PIN credentials (`employee_credentials.secret_hash` — the only stored form of a PIN since migration `0221` dropped the blind index, issue #953), and applies the stored role, permission overrides and branch scope in one transaction, with an explicit `reason`. No migration was required: offboarding already retained everything a rehire needs. Pinned by the rehire cases in `team.integration.test.ts` (success + every refusal code + MFA factor survival + same-email rehire with history kept) |
| P2.9 re-invite collides with retained rows | **resolved (pass 4)** | the same-email case no longer dead-ends: a new membership for an offboarded identity's email is refused `email_taken` by design, and the retained row is recovered through the rehire ceremony instead of colliding with it — invitations still supersede pending ones per address and acceptance stays idempotent per identity. Cross-tenant rehire attempts answer `not_found`, and historical membership/personnel/audit references survive the relink untouched |
| P2.10 branch-scope validation incomplete | resolved (pass 1) | explicit scope validated at creation and acceptance |
| P2.11 invitation UI lacks branch scope | resolved (pass 1) | the invite form asks for scope + branches |
| P2.12 PIN uniqueness copy and implementation disagree | **superseded (migration `0221`)** | pass 1 aligned the copy with the per-business constraint; #953 then removed uniqueness itself (P2.13), so the hint now says what is true — the PIN is *this member's* personal secret, the door finds the member by name, and two members may happen to choose the same digits |
| P2.13 PIN uniqueness race-prone check | **superseded (migration `0221`)** | uniqueness itself is gone: refusing a duplicate PIN told the person choosing it what a colleague's PIN was. The door now always names the member (`employeeId` is required by `/api/auth/pin-login`), the blind index and its unique index are dropped, and `secret_hash` is the only stored form of a PIN |
| P2.14 custom-role `default_location_scope` dead | **resolved (pass 2, GAP 10)** | the scope is now applied: `createTenantRole`/`updateTenantRole` store and serve it (update is an access change and needs a reason), the roles dialog edits it, and both membership-creation paths inherit it when no explicit branch policy is given — refusing `selected`/`home` defaults that cannot be honoured instead of silently widening to "all". Pinned by the GAP 4 invitation/creation cases in `auth-hardening-854-gaps.integration.test.ts` |
| P2.15 confirmPassword ignored | resolved (pass 1) | one server-side validator |
| P2.16 whitespace-only password | resolved (pass 1) | rejected by the same validator |
| P2.17 password error contracts drift | resolved (pass 1) | shared error codes/messages |
| P2.18 MFA endpoint lacks an action allowlist | resolved (pass 1) | explicit `KNOWN_MFA_ACTIONS` allowlist on `/api/auth/mfa/self` |
| P2.19 pending setup not resumable | resolved (pass 1) | `GET` surfaces return the live challenge; masked destination from the challenge, not the client |
| P2.20 two SMS numbers for one user | resolved as *kept separate*, labelled | the login phone (membership, `users.phone_e164`) and the MFA SMS factor (identity, `mfa_enrolments.phone_e164`) are independent by design; Profile labels them as login vs second factor, and the strict verifier binds each code to the number its challenge was sent to — collapsing them would make "which number gets which code" ambiguous |
| P2.21 replacing the only SMS factor | **resolved (pass 2 backend, pass 3 UI)** | enrolment accepts `replaceConfirmed` for a *different* number, keeps the confirmed row untouched during the ceremony (never factorless), and the confirmation commits the swap inside the account lock — `commitSmsFactorReplacement` semantics live in `confirmMfaEnrolment` (`provenPhoneE164`), audited as `auth.mfa_factor_replaced`. Pass 3 finished the *screen* half the service tests could not see: the tenant and platform cards render «تغییر شمارهٔ دریافت» for a member who already has a confirmed SMS factor (the form used to render only when none existed), the confirmation and the replacement resend both name the new number (`expectedPhoneE164` / `provenPhoneE164` carry it; a provided phone that does not canonicalise is a 400, never a silent drop), the swap itself waits behind the P2.26 confirmation, cancellation sends nothing, and a reload resumes a fresh enrolment from `pendingSmsPhone` (a replacement deliberately restarts — the screen says so). Pinned by the P2.21 cases in `auth-hardening-854-gaps.integration.test.ts` (swap-on-proof, wrong-destination refusal, resend-to-named-number, abandon-mid-ceremony, concurrent replacement-vs-removal) and by the rendered contract `src/app/(app)/settings/two-factor-settings.test.tsx` |
| P2.22 personal security under-audited | **resolved (pass 1 + pass 2, GAP 5)** | `recordSecurityAudit` writes a secret-free row inside the same transaction as every sensitive mutation (enrol start/confirm, factor removed/replaced, primary changed, recovery codes, step-up success/failure, session revoke scopes) in both realms; `auditRevocation` no longer swallows failures |
| P2.23 Persian digits in OTP/TOTP inputs | **resolved (pass 1, completed pass 4)** | pass 1 added `toLatinDigits` normalisation; pass 4 audited **every** remaining security-code input and moved them onto one helper, `normalizeSecurityDigits` (`src/lib/digits.ts`): Persian *and* Arabic-Indic digits become ASCII, non-digits drop, and the length cap is enforced on the client before validation. It covers the login MFA step (TOTP/SMS/recovery), the phone-OTP door, the tenant and platform MFA cards (code **and** replacement-number fields), the Profile login-phone/PIN cards, owner activation, the platform console card, and the welcome pairing PIN — no remaining input strips localised digits with `/\D/g` before converting them. Pinned by the localised-digit cases in `two-factor-settings.test.tsx` and the pure-rule cases in `digits.test.ts` |
| P2.24 "trusted device" wording inaccurate | **resolved (pass 2)** | `otp_login_at` is membership-wide and the wording now says so — the Profile phone card reads «رمز عددی تا ۷ روز برای همهٔ ورودهای این عضویت کار می‌کند (نه فقط یک دستگاه)»; the security-center and login-screen copy already described the window without per-device claims. No per-device trust is claimed anywhere |
| P2.25 resend UX for phone verification | resolved (pass 2 + pass 3) | server-side cooldown and caps (`checkPhoneOtpRateLimit`: 60 s resend, 5/hour, 20/day; the MFA challenge limiter is the twin) with `retryAfterMs` surfaced by the routes. Pass 3 finished the presentation the issue actually asks for, via one shared hook (`components/auth/use-resend-cooldown.ts`): a **live ticking countdown** seeded from the challenge's real send time (so a reload mid-window shows the honest remainder, not a fresh 60), the limiter's own `retryAfterMs` rewriting the window on a 429, the masked destination, and a live expiry line (`smsChallengeExpiryMessage`) driven by `useNowTick`. Wired into the tenant two-factor card, the platform console card, the Profile login-phone card (whose pending challenge now carries `requestedAt`), and the door's `phone-otp-step` |
| P2.26 destructive actions confirmed | **resolved (pass 3)** | one shared product confirmation (`components/auth/security-confirm-dialog.tsx`): consequences are a required, rendered list; cancellation sends no mutation; while busy the dialog cannot be closed and both buttons disable, so a retry cannot duplicate the mutation; recent-auth stays a separate gate. It now fronts every destructive personal/membership-security action that used to be a bare `confirm()` or nothing: factor removal and recovery-code regeneration (tenant card + platform console card), the SMS-factor swap, WebAuthn credential removal, team suspension and offboarding, and the IAM card's «ترمیم از نسخهٔ ابری» and detach-to-local. Session revocation keeps its own inline confirmed panel (P1.4). Pinned by `two-factor-settings.test.tsx` and `components/auth/webauthn-manager.test.tsx` |
| P2.27 weak device/session labels | **resolved** (pass 1; #957 third and fourth passes) | device labels and `login_method` are recorded on every door. Pass 1 left the password door and the desktop's cloud-login callback unlabelled; #957's third pass labelled the password door, and its fourth pass the callback (`cloud_account`, migration 0227). Before that the security center showed a cloud-account session as «پین» |
| P2.28 personal security split across surfaces | **resolved (pass 3 + pass 4)** | `/settings/profile` is the canonical personal-security screen **including WebAuthn**: pass 3 extracted the sidebar-only biometric overlay into the reusable `components/auth/webauthn-manager.tsx` card, added it to the profile under the `webauthn_credential` credential surface (server authority unchanged — writable on every profile, read-only contract honoured), and reduced the sidebar's `BiometricSettingsButton` to a link to the profile instead of a duplicate panel. Pass 4 removed the last duplicate: the Security Center's personal phone card (its own mutation form against `/api/auth/phone/self`) is gone from the organisation screen; the Security Center now renders the organisation's MFA policy posture and links to the Profile section that owns the personal phone ceremony. One writer per surface remains: Profile for the signed-in person, Security Center for policy, Team for member administration. Pinned by `components/auth/webauthn-manager.test.tsx` and the Security Center's rendered contract |

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
| GAP 10 — deferred items | P2.5–P2.9, P2.14, P2.20, P2.21, P2.24, P2.25 | P2.6/P2.14/P2.21 completed (rows above); P2.24 wording fixed; the rest were recorded product decisions — every one of them was closed in pass 4 (rows above) |

### Pass 4 (round 4) — the review gaps

The fourth pass came from a review of the branch head `f79cf31`. It did not redo
passes 1–3; it closed what the review still found reachable:

| Gap | Finding(s) | What pass 4 did |
|---|---|---|
| Personal-security ownership | P2.28 | the Security Center no longer carries a personal phone mutation form; it renders the organisation's phone-door posture (adoption + unverified members) and links to the Profile section that owns the ceremony. Consumers traced before removal: the card's only writes were `/api/auth/phone/self`, which Profile's `SelfPhoneCard` already owns |
| OTP/PIN digit handling | P2.23 | one `normalizeSecurityDigits` helper in front of every remaining security-code input (see the P2.23 row); the duplicated form whose `/\D/g` strip motivated the audit was removed with the phone card above |
| Personnel section authorisation | P2.7 | the Team screen's personnel subsection mounts only behind `canViewParties`; `parties.view` not widened |
| Membership lifecycle & rehire | P2.8, P2.9 | lifecycle-derived actions + the explicit rehire ceremony `POST /api/team/[id]/rehire` (`rehireMembership`: membership row lock, dual permission gate, grant re-check against the actor, identity relink, PIN re-establishment, stored role/permissions/branch scope restored in one transaction, reason required; refuses `not_offboarded`, keeps history rows; `email_taken` steers same-email cases to rehire instead of colliding). No MFA bypass: factors live on the global identity and survive the relink — pinned by an integration test that reads `mfa_enrolments` through the relinked `platform_user_id` |
| Canonical identity ownership | P2.5 | the membership/global identity owns `full_name`/`email`/`phone_e164` for login purposes; conflicting personnel writes are refused (`identity_*_managed_by_membership`, 409 + fieldErrors), alignment writes allowed; membership→party sync on rename/create/setMemberPhone, now the single `ensurePersonnelFileForMembership` guarantee (issue #947) called from every membership door. Consumers inspected: party create/update API, the personnel-file sync, team rename/create/setMemberPhone, data-transfer CRM import (`entities/crm.ts` now refuses conflicting employee-party identity writes), ai-autopilot customer updates (unaffected — customers are not employee-linked) |
| Deterministic MFA contention | P0.9/GAP 3 + P2.21 concurrency | the existing `Promise.all` races stay (they prove the invariant under a real race), and pass 4 adds held-lock ordering tests: a client holds `pg_advisory_xact_lock(hashtext('platform_user'), hashtext(subject))` — the same lock both `removeMfaFactorChecked` and `confirmMfaEnrolment` take — the queued operation is *proven* waiting by a 700 ms race probe, then released. Pinned orderings: replacement-commits-first then removal refuses; removal-decides-first (refused, required account) then replacement commits — identical final state, never factorless; two-factor removals serialise with the survivor covering the account; a stale replacement code cannot authorise a swap to a different number (`expectedPhoneE164` binding) and cannot be replayed; a wrong code rolls back leaving the confirmed factor intact |

## Known limitations, stated plainly

- **Legacy `users.pin_hash` rows.** Every PIN read goes through
  `coalesce(ec.secret_hash, u.pin_hash)`, so a pre-migration bcrypt hash still
  signs its owner in, but such a row predates `employee_credentials` entirely:
  it has no credential row, no `last_used_at`, and no device binding, and it is
  outside every credential-lifecycle rule this page describes. (Uniqueness is
  not one of those rules and has not been since migration `0221` — issue #953
  removed the blind index and its unique constraint, because refusing a
  duplicate PIN told the person choosing it what a colleague's PIN was.) No
  code path writes that column any more (creations and rotations write
  `employee_credentials`; suspension/offboarding and cloud replication only
  ever NULL it). The safe migration policy is rotation on next contact: an
  affected member sets a new PIN through the normal self-service or admin-reset
  flow, which writes the credential row, and the legacy column is then cleared.
  Until that happens the legacy hash remains the only door for that member —
  which is why it is kept readable rather than dropped.
- **PIN values are not unique across employees — by decision (#953).** Two
  members of a business may hold the same PIN: refusing a duplicate told the
  person choosing it what a colleague's PIN was, so migration `0221` dropped the
  blind index and its unique index, and the PIN door always names the member
  first (`employeeId` is required by `/api/auth/pin-login`). The only reuse that
  is refused is a member rotating to **their own current PIN** (`pin_unchanged`,
  #854 F07). Neither cross-member uniqueness nor a unique PIN blind index is a
  goal of this issue; any checklist wording asking to refuse "other members'
  duplicate PINs" is superseded by #953.
- **`issueCredential` / `verifyCredential` were dead code and are removed.**
  The audit found no route, job, script, dynamic import or test calling them;
  they were a parallel bcrypt PIN path outside `employee_credentials`, so they
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
never end factorless, plus the pass-4 deterministic contention suite: held-lock
orderings (replacement-first and removal-first converge on the same
non-factorless end state), serialised two-factor removals, the stale-challenge
destination binding and its replay refusal, and a wrong-code rollback),
`integration/team.integration.test.ts` (P1.12's four transition
cases, now exercising the reason rule, the pass-4 rehire ceremony — success,
every refusal code, MFA factor survival across the relink, same-email rehire
with history preserved — and the membership→party sync cases), plus the updated
`integration/{team,auth-account-security,phone-otp,iam-login-credentials,parties}.integration.test.ts`
(parties including the canonical-ownership refusals).

Rendered component contracts (jsdom, real components against a fake server):
`src/app/(app)/settings/two-factor-settings.test.tsx` — the replacement form is
reachable with a confirmed SMS factor, the enrol/confirm/resend bodies carry the
new number, the swap waits behind its dialog and cancellation sends nothing,
factor removal and recovery regeneration are dialog-gated, a reload resumes a
fresh enrolment from the server's pending row, a 429 surfaces the limiter's
message, and Persian/Arabic-Indic digits typed into the number and code fields
reach the API as ASCII (pass 4) — and `src/components/auth/webauthn-manager.test.tsx` — the profile's
WebAuthn card lists devices, renders the empty state, gates removal behind the
confirmation (cancellation sends no DELETE), and a read-only deployment surface
renders the notice without controls. These exist because the service tests
proved the backend of P2.21 while the screen still hid the form — the layer the
issue said was broken.

Screen contracts without rendering: `src/lib/admin-screen-contracts.test.ts`
holds the admin screens to the same rules the routes enforce, including P1.19 —
both doors import the shared picker, keep the pending choice in the shared hook,
and check `capture(data)` *before* treating the response as a sign-in.
`src/app/dashboard/team/team-manager.test.ts` pins the pass-4 Team wiring the
same way: the personnel directory mounts only behind `canViewParties`, the
suspend/reactivate button renders only for non-offboarded members while
«بازگشت به کار» renders only for offboarded ones, the rehire dialog POSTs to
the dedicated ceremony endpoint with a mandatory reason, and the route keeps
both permission gates and the service's lock/reason enforcement.

## Remaining work

Every P0, P1 and P2 finding is now closed end to end. The items pass 3 carried
as recorded product decisions were closed in pass 4:

- **P2.5** — canonical ownership defined and enforced in both directions
  (conflicting personnel writes refused; membership writes repair the party).
- **P2.7** — the conditional-render fix the issue lists first; a dedicated
  membership-scoped personnel read path stays a *possible* future change, not a
  requirement of the issue, since no broken subsection remains.
- **P2.8 / P2.9** — the rehire ceremony replaces the "reactivate an offboarded
  row" dead end; same-email recovery goes through it instead of colliding.

No security invariant is deferred. P2.20's two phone numbers — the membership's
login phone and the identity's MFA SMS factor — remain deliberately separate
and labelled; the rationale is in its row above (the issue's own fix for P2.20
is labelling, not collapsing).

## Verification pass (round 5)

Every finding above was re-opened against the code — not the doc — on the
round-4 head: for each of P0.1–P0.9, P1.1–P1.20 and P2.1–P2.28 the enforcing
file was read and the test claimed for it located. The audit confirmed every
fix exists and the Tenant (`platform_user`) and Platform console
(`platform_admin`) realms remain separate throughout. Two rows were carrying
fixes without a regression test and were completed during the pass:

- **P0.6** — the PIN door's `mfa_required` refusal now has three integration
  cases (policy-required owner refused; a privileged account holding a
  confirmed factor refused even under a permissive policy; an uncovered
  PIN-role member still signs in), asserting the status, the error code and
  that no `employee_sessions` row is minted by a refusal.
- **P1.16** — the self phone change's duplicate pre-check is now driven
  through the real `/api/auth/phone/self` route with a signed session: the
  taken number is refused with no SMS spent, and the verify-side re-check
  refuses a number taken mid-window without stamping anything.
- **P1.18** — the multi-business phone door now has a case proving the list
  of businesses appears only after the code redeems: the send and a wrong
  code both answer without any `businesses` field, and the proven code alone
  unlocks the selection with its token.

The full finding-by-finding table with file:line evidence and test names is
kept in the pull request description so review can check it against this
document.

## Follow-up audit (2026-10-11): the Profile security surface, F01–F13

The issue's follow-up comment re-audited the Profile page after PR #889 and listed
thirteen findings. Each was reproduced against `main` (`916df45`) before it was
changed — all thirteen were still reachable — and the new tests were run
against that base as well as the fix (35 of the 43 database cases and most of the
component cases fail on `916df45`; the rest guard behaviour that must not
regress). The guiding rule matches the rest of this page: one policy, applied by
the server, with the screen reading the server's answer instead of guessing.

| Finding | Fix | Proof |
|---|---|---|
| **F01** ending one session had no recent-auth bar | `revoke_one` in `src/app/api/sessions/self/route.ts` now needs recent authentication unless the target is the caller's *current* session (ending that one is a sign-out and clears the cookie). The check runs before the lookup, so a stale session cannot probe ids; a malformed id is `session_not_found` instead of a 500; the UPDATE and its `self.session_revoked` audit row share one tenant transaction. `revoke_others` (this business) and `revoke_all` (every business of the identity) are unchanged. The sessions card routes a `recent_auth_required` through the step-up prompt and retries the same session | `integration/profile-security-854.integration.test.ts` «F01» (stale/fresh, current-session exemption, another member's / another tenant's / malformed id, audit rollback, bulk scopes across two businesses of one identity); `profile-section.test.tsx` «F01» |
| **F02** biometric offered to roles the API refuses | One rule, `src/lib/webauthn-policy.ts` (client-safe), resolved server-side by `src/lib/webauthn-access.ts`: every member may **list and remove** their own authenticators; only the PIN roles (`cashier`, `waiter`, `kitchen`) may **enrol**, and only where the deployment surface is writable. Both registration routes, the list and the delete route ask it; `GET /api/auth/webauthn/credentials` returns `canRegister`/`canRemove`/`registerBlockedBy`; the Profile page shows the card only if the role may enrol or already holds an authenticator. PIN-role biometric login and the P0.6 MFA gate are untouched — no privileged role gains a WebAuthn door | `webauthn-policy.test.ts` (all seven roles); integration «F02 / F12» (seven roles × Cloud/Hybrid/Local: page prop ⇔ route answer; a held authenticator stays listed and removable for every role; another member's / tenant's credential is 404) |
| **F03** step-up advertised WebAuthn but verified a text code | `VERIFIABLE_STEP_UP_METHODS` in `src/lib/auth-contracts.ts` drops `webauthn` until a real challenge/response step-up exists: `GET /api/auth/step-up` never advertises it, `POST` answers `unsupported_method`, `challengeToken`/`hasWebauthn` are gone, and the prompt renders only verifiable methods. The success audit is written *before* the recent-auth cookie (a failed audit grants nothing); audits go through `recordSecurityAudit` | `auth-contracts.test.ts`, `step-up-prompt.test.tsx` «F03»; integration «F03» (a passkey holder is offered PIN only; PIN with Persian digits, password and confirmed TOTP still verify; audit failure ⇒ no cookie) |
| **F04** password committed, then an audit failure lost the refreshed cookie | `changeOwnPassword` (`src/lib/password-reset.ts`) runs bcrypt outside and everything else inside one identity transaction: a compare-and-swap on the verified hash, the token-version bump, every other session's revocation (all businesses of the identity), the lockout reset and — through `beforeCommit` — the route's audit row and token signing. Any failure rolls all of it back and answers `500 credential_change_failed`; success returns `{ ok, tokenVersion }` and the cookie together | integration «F04» (injected audit failure ⇒ same hash, same token version, no session revoked, old cookie still valid; success ⇒ both businesses' sessions revoked, caller's kept, old cookie dead, new one valid); `security-audit.test.ts` |
| **F05** phone audits swallowed by `.catch(() => {})` | `stampPhoneVerified({ audit })` (`src/lib/phone-otp.ts`) writes the stamp and its `auth.self_phone_changed` / `auth.self_phone_verified` row in one tenant transaction; the route answers `409 phone_taken` for the unique-index race and `500 credential_change_failed` otherwise, logging only the error message. OTP purpose and destination binding are unchanged; the audit carries the masked number only | integration «F05» (injected failure ⇒ number unchanged, no row; then both commit; payload has no full number or code) |
| **F06** resend after a reload targeted the old number | The ceremony is the server's challenge row: `action: "resend"` re-sends to the live challenge's candidate under its own purpose (a `phone` in the body is ignored), `action: "cancel"` burns the self-service codes (no step-up needed — it only removes capability), a fresh send burns the other self purpose, and a re-verification whose number changed meanwhile is `409 code_wrong_phone`. The card renders from `pendingChallenge` and names nothing but the code on verify | integration «F06» (reload+resend, single use/replay, cancel, expiry, one ceremony at a time, admin-changed number); `profile-section.test.tsx` «F06» |
| **F07** the current PIN accepted as the new one | `setPin` in `src/lib/team-service.ts`, for `selfService` only, bcrypt-compares the member's **own** active PIN under the membership lock and throws `pin_unchanged`; it also accepts a `beforeCommit` so `/api/auth/pin/self` writes its audit inside the rotation. An administrator's reset and a colleague's identical PIN stay allowed: **confirmed product decision** — different employees may use identical PINs (#953), so the audit checklist's request to refuse other members' duplicates is withdrawn, not deferred | integration «F07» (route + service layer, Persian digits, #953 shared PIN, audit rollback) |
| **F08** PINs readable on screen | `PIN_INPUT_PROPS` (`type="password"`, `inputMode="numeric"`, `autoComplete="off"`) on all three Profile PIN fields; the step-up PIN field is masked too; `normalizeSecurityDigits` still maps Persian/Arabic-Indic digits | `profile-section.test.tsx` «F08 / F07», `step-up-prompt.test.tsx` «F08» |
| **F09** a failed WebAuthn removal stranded the card | removal uses `api()` inside `try/finally`; busy is always released, the list stays, the error is explained and the action can be retried; a stale session goes through step-up | `webauthn-manager.test.tsx` «F09» |
| **F10** sign-out reported success on failure | One typed contract, `src/lib/logout-contract.ts`, for the route and every caller (see "Sign-out, end to end" below): the card leaves only on a confirmed outcome, stays put on a server or network failure with the reason and a retry, and tells an *unconfirmed* end (cookie cleared, server unconfirmed) apart — retrying it through the server's retry ticket | `logout-contract.test.ts`, `sign-out.test.ts`, `profile-section.test.tsx` «F10 + logout», integration «sign-out», `scripts/e2e-profile-security.mjs` |
| **F11** read-only credentials still had pending forms | `two-factor-settings.tsx` no longer adopts a pending enrolment when the factor set is read-only and guards every enrol/confirm/resend form; the phone card renders no pending verification when the login phone is read-only. The routes already refused (`409 login_managed_by_cloud`) — now the screen agrees | `two-factor-settings.test.tsx` «F11»; integration «F11» (Cloud/Hybrid/Local: every surface the page marks read-only is refused by its route, including a code requested before pairing and MFA confirm/resend; cancel and the staff PIN stay available) |
| **F12** unsupported browser hid registered devices | browser support gates only *registration*; the list and removal follow `canRemove` | `webauthn-manager.test.tsx` «F12» |
| **F13** hard-coded branch | `settings/profile/page.tsx` resolves the active branch (`resolveActiveLocation`) and the member's home branch under the tenant scope; `describeProfileBranches` (`src/lib/profile-branch.ts`, pure) sends only id and name, and states the home branch's relation explicitly (`homeStatus`: same / different / unassigned / unavailable) — the first version returned `home: null` for both "same as active" and "missing or deactivated", and the card then labelled the active branch «شعبهٔ اصلی شما» for a member with no home branch at all | `profile-branch.test.ts` (missing, inactive, equal, different, foreign id), `profile-section.test.tsx` «F13» (all four rendered), integration «F13» (all four through the real page props; another tenant's branch in the session is never shown) |

**Shared seams with #947.** The phone-change transaction ends where #947's
`ensurePersonnelFileForMembership` begins: that hook is designed to run after the
commit, so on merge it belongs after `stampPhoneVerified`'s transaction (at the
"post-commit" comment), never inside it. The `setPin` change is confined to the
self-service branch; #947's Team doors (`createMembership`, `updateMembership`,
`rehireMembership`, `setMemberPhone`, invitation acceptance) are untouched, and
`/settings/team` is not modified.

### Second pass (2026-10-15): sign-out end to end, and what the first pass missed

**Sign-out, end to end.** `POST /api/auth/logout` used to swallow every
revocation failure and answer `{ ok: true }`; the sidebar menu ignored the HTTP
status, and the signed-in notice called a *rejected* request a sign-out. Now:

- `revokeSession` (`src/lib/employee-service.ts`) ends the `employee_sessions`
  row and writes its `employee.session_revoked` audit row in **one tenant
  transaction** — previously two writes on two connections, so an audit failure
  left an ended session with no record (this also makes the security center's
  `DELETE /api/sessions/[id]` atomic). A sign-out restricts it to the caller's own
  row (`ownedBy`), and a malformed id is a miss rather than a database error.
- The route still clears the cookie on **every** answer — its one unconditional
  job — but now answers the shared contract (`src/lib/logout-contract.ts`):
  `revoked` / `already_ended` / `not_tracked` (a session minted without a
  server-side record — retired in the third pass, below, once every door opened
  one) / `no_session`, or `unconfirmed` (HTTP 503) when ending the row failed.
- An unconfirmed sign-out is finishable: the route sets an httpOnly,
  `SameSite=Strict` **retry ticket** scoped to `/api/auth/logout`
  (`src/lib/logout-retry.ts`) naming only the session(s) the signed token named,
  signed under a realm claim `verifySession` refuses. `POST
  /api/auth/logout/retry` (session-less by necessity — middleware's public list,
  with the Origin-mismatch rule) reads only that ticket, ends only those rows, and
  never touches the session cookie; a later sign-out on the same browser also
  retries pending entries.
- Every caller reads the contract through `src/components/auth/sign-out.ts`
  (`useSignOut`: the busy flag is released on every path, and after an
  unconfirmed end the next attempt is the retry route, never a second plain
  sign-out that would "succeed" with no cookie). The Profile card explains inline
  and offers both the retry and the way to /login; the sidebar menu (its panel is
  gone by then) uses a persistent toast with «تلاش دوباره» that survives the
  navigation; the signed-in notice says «حساب قبلی خارج شد» only on a confirmed
  end and otherwise says the previous session is still open (or unconfirmed),
  with a retry. Account switching navigates only once this browser is signed
  out — including when the cookie was cleared despite a server error.

**Branch display.** See the F13 row: `homeStatus` replaces the ambiguous
`home: null`.

**Phone OTP digits at the API boundary.** `/api/auth/phone/self` rejected
«۱۲۳۴۵۶» with an ASCII-only regex before the shared verifier ever saw it. It now
uses `normalizeOtpCode` (`src/lib/otp-challenge.ts`) exactly as the door does
(`phone-otp/verify`, #885 L11); purpose, destination, expiry, the five-attempt
limit and single-use redemption are all still enforced by `redeemOtpChallenge`.

**Step-up by SMS and recovery code** now has route-level regressions: a code
minted for login or enrolment is not a step-up code, a pending SMS enrolment is
not a factor (no code is sent, none accepted), codes are single-use, another
account's recovery code never works, and an audit failure grants no recent-auth
window (the code it spent stays spent).

**Browser evidence.** `scripts/e2e-profile-security.mjs` (`npm run
test:e2e:profile`) drives the real Profile page in Chromium against a production
build: RTL, the branch facts, F02/F12 with WebAuthn present (a credential
registered through Chromium's **virtual** authenticator) and removed, F09
removal retry, F11 across Cloud/Hybrid/Local, F08 masking, keyboard reach of
sign-out, axe-core on the Profile content, a 390px phone frame, and the sign-out
paths above — including a real server-side audit failure, the retained-token
check before and after the retry, the sidebar toast retry and the /login switch.

**Known gap at the end of this pass (closed by the third pass, below).** A
session minted without an `employee_sessions` row — a business switch,
first-run setup, the desktop hand-off — had nothing a sign-out could end: the
route cleared the cookie and answered `not_tracked`, but a copy of that token
kept elsewhere stayed valid until it expired (or until the identity's token
version moved, e.g. «خروج از همهٔ کسب‌وکارها» or a password change). This pass
deferred it to the session-coherence work (#948); #948 closed (PR #950)
without taking it on, so the third pass fixed it here.

**Still not verified, and why.** A *physical* authenticator and a real SMS
provider are outside any sandbox run: WebAuthn was exercised with Chromium's
virtual authenticator, and SMS through the provider seam the integration suite
mocks. WebAuthn *login* for privileged roles off-cloud stays behind the P0.6 MFA
gate, unchanged; a WebAuthn step-up needs a real assertion ceremony before
`webauthn` can return to `VERIFIABLE_STEP_UP_METHODS`.

**Overlap with #947 (re-checked against its head `4c3a7205`).** A trial merge
(`git merge-tree`) conflicts in one file only, `src/lib/phone-otp.ts`: keep both
import lines, and place #947's `ensurePersonnelFileForMembership(...)` after the
new stamp-plus-audit transaction (at the "post-commit" comment), never inside it.
`docs/audits/auth-hardening-854.md`, `src/lib/team-service.ts` and `package.json`
merge cleanly; none of the sign-out, branch, OTP-digit or step-up files is
touched by #947, and `/settings/team` is not modified here.

### Third pass (2026-10-15): every tenant session is revocable

**The gap.** Six doors set a tenant session cookie with no `employee_sessions`
row behind it: the business switch, first-run bootstrap, public signup, desktop
pairing, the desktop app's cloud hand-off and the company staff hand-off. A
sign-out could only clear the cookie (`not_tracked`). Every server-side
revocation path — the security center, deactivation, «خروج از همهٔ دستگاه‌ها», a
password change — works on rows. And the step-up and credential re-mints
re-signed such a token with a fresh expiry. So a retained copy outlived every
sign-out. #948 closed (PR #950) without covering these doors, so the fix is here.

**One mechanism, the existing one.** No new token type, no deny-list, no
parallel session store:

- Every door opens its row through the same `createSession` the sign-in doors
  use, and signs the row id into the token (`employeeSessionId`). The door is
  recorded in `login_method`. Migration `0226_employee_session_login_methods.sql`
  widens 0211's CHECK by exactly `business_switch`, `setup`, `desktop_handoff`
  and `company_handoff`. `SESSION_LOGIN_METHODS` mirrors that list, and
  `session-contract.test.ts` reads the newest migration to keep the two equal.
- `checkEmployeeSession` (`src/lib/auth.ts`) refuses a tenant token that names
  no row, unless it is a support session, which is bound to its grant
  (`checkImpersonation`). `getSession()`, every `require*` guard, the re-mint
  routes, the WebSocket upgrade and an open socket's periodic re-check
  (`resolveSessionFromToken`) all go through it. The row lookup is bound to the token's business **and member**
  (`employee_id = sub`), so a token naming another member's row id — in the same
  business or another — names no session.
- **Legacy tokens.** A token minted before this change (no row, no grant) is
  refused on its next request. The member signs in once more, into a session
  that can be ended. A token-hash deny-list was rejected: re-mints create
  sibling tokens, so a list could never be complete.

| Door | `login_method` | If the row cannot be opened |
|---|---|---|
| `POST /api/auth/switch-business` | `business_switch` | Nothing changes: the target row is opened first, so a failure leaves the old cookie working |
| `POST /api/setup/bootstrap`, `/api/setup/signup`, `/api/setup/pair` | `setup` | `200 { ok: true, signedIn: false }`, no cookie (see below) |
| `GET /api/auth/desktop-session` | `desktop_handoff` | No cookie; `303` to `/login?next=…` |
| `GET /api/auth/company-handoff` | `company_handoff` | `503 session_unavailable`, no cookie; the console issues a fresh hand-off |

**Business switch: the session moves; it is not copied.** The source row is
ended in the same request (`employee.session_revoked` with `via:
"business_switch"`). If it cannot be ended, the row just opened is ended again
and the caller gets `503 switch_unconfirmed` with the old cookie intact. One
browser never ends up holding two live sessions.

**First-run doors fail without losing the business.** Bootstrap, signup and
pairing open the row after the business exists, so a failure there cannot be a
500. A 500 would lose bootstrap's TOTP secret and recovery codes, which are shown
exactly once. It would also invite a second signup, and so a second business.
The answer is `ok` with `signedIn: false`:

- the welcome wizard keeps the factor on screen, says the automatic sign-in did
  not happen, and continues through `/login?next=/setup/business`;
- the pairing form says the device is connected and offers the sign-in page.

**Support sessions.** A support operator signed in as the business is bound to
the grant. «خروج» from the sidebar, Profile or the signed-in notice now closes it
through `closeSupportSession`, the banner's own service. It uses the same
operator closer and audit trail, recorded with channel `tenant_sign_out`
(`tenant_sign_out_retry` from the retry ticket). The answer carries `redirectTo`
(the console's support tab). Clients follow it only after validating it as a
same-origin path with `safeLoginNextPath`. Fixed alongside: the middleware's
read-only guard answered `403` to a read-only support session's `POST
/api/auth/logout`, so its «خروج» did nothing. `isSupportSessionExitRequest` now
lets exactly that request through.

**Contract.** `not_tracked` is retired. `LOGOUT_OUTCOMES` is now `revoked` /
`already_ended` / `no_session` / `unconfirmed`, and a legacy token's sign-out is
`already_ended`. A retry ticket entry names either a member row
(`employee_session`) or a support grant (`support_grant`), de-duplicated per
target. Each is restricted to its own member or its own operator and business.

**Security center.** Each row is labelled by its recorded door before falling
back to the credential. A setup or switch session used to read as «پین».

**Failed password step-up is audited.** A wrong password at `POST
/api/auth/step-up` wrote no `auth.step_up_failed` row, because the per-method
flag was never set for `password`. Every failed verification now writes exactly
one row, carrying `{ method }` only, after the lockout attempt is recorded. If
the audit write fails, the answer is a 500 and the attempt still counts towards
the lockout.

**Ownership.** #948 is closed, so this lands in #957. #947's Team, personnel and
invitation surfaces are untouched. The shared `employee-service` changes are
additive: a typed `loginMethod`, `SessionEndVia`, and `loginMethod` on the
business session list.

**Tests.** `integration/session-revocation-854.integration.test.ts` (20 cases)
covers each door end to end against a real schema: row → authenticated →
«خروج» `revoked` → the retained copy refused. It also covers:

- the switch's isolation, its failure on either row, and the all-or-nothing
  rule;
- legacy tokens, including a step-up re-mint attempt;
- cross-member and cross-business row ids;
- support sign-out, an unauditable close finished by the retry ticket, and a
  forged ticket closing nothing;
- an unconfirmed switched session finished from a session another door opened.

Pairing's retained-token check lives in `hybrid-credential-sync`, where the
two-database cloud stub is. `profile-security-854` adds the password step-up
audit cases (and an audit failure that still counts the attempt). Component
coverage: `security-center-settings.test.tsx` and `welcome-signed-in.test.tsx`,
plus the updated sign-out, Profile, sidebar-menu and signed-in-notice suites.

**The Profile page read two facts outside the tenant scope.** This surfaced when
main started CI's media E2E server with `DEPLOYMENT_ROLE=central`.
`readDeploymentProfile` and `readSelfCredentialState` ran outside `withTenant`.
A server page cannot borrow `getSession()`'s scope (`withTenantScope` in
`src/lib/auth.ts` explains why), and under the production runtime role RLS
answers such a read with no rows. Two things went wrong:

- the page rendered the runtime role's guess instead of the business's stored
  profile. For a Hybrid business served by the central server, it offered
  editable login-phone, password and authenticator-app (TOTP) cards whose
  routes then refused with `login_managed_by_cloud` (F11);
- it lost the member's credential state, so two-step sign-in followed the role
  fallback: a cashier with a global identity was not offered it.

Both reads now run inside the tenant scope, like the page's other reads.
`profile-security-854` could not see this: its pool is the superuser, which RLS
ignores. `integration/profile-page-rls-854.integration.test.ts` renders the page
and calls `GET /api/auth/phone/self` through an unprivileged role, on both
server roles and all three profiles. Without the fix, 3 of its 9 cases fail.

**The browser run follows the server's role.** `scripts/e2e-profile-security.mjs`
reads `E2E_DEPLOYMENT_ROLE`: `site` by default (what a server started without
`DEPLOYMENT_ROLE` infers), `central` in CI, and any other value is refused. On a
site, a Hybrid business's Profile is the cloud pane. On the central server it is
the local screen: the login phone is read-only and says why, and the staff PIN
stays self-service.

**An open socket outlived its session.** The upgrade authenticates `/ws` once,
through `resolveSessionFromToken`. The socket's 30-second re-check
(`registerConnection` in `src/lib/realtime.ts`) then called only `authorize()`.
That looks at the membership and the identity's token version, not at the
`employee_sessions` row or the support grant. So a socket opened before «خروج»
kept receiving the business's live events for as long as it stayed open. The
same held after the session was ended from the security center, or after a
support grant closed.

The upgrade now hands the socket its cookie. Every re-check runs it through
`resolveSessionFromToken` before `authorize()`, exactly as a request is
authenticated. A socket whose session has ended closes with `1008 Session
Ended` within one interval. A check that fails closes it with `1011`, as before.
Sign-out does not reach into the registry: the registry is per process, and the
re-check covers whichever server instance holds the socket.

**An owner's socket heard every business.** `broadcast(locationId, …)` matched
a connection with a null `locationId` to every location on the server. Such a
connection belongs to an owner or a roaming manager. On a central server
hosting several businesses, every owner with a screen open received every other
business's order, table, table-session and low-stock events. Those events carry
ids, and a low-stock event also carries the item's name and quantity.

An all-locations connection now carries its own business's location ids. (The
fourth pass, below, narrows this to the branches the member may act in, and
checks pinned connections too.) They
are read inside that business's tenant scope when the socket opens, and again
on every re-check, so a branch opened later reaches it from the next one. Until
the first read answers, the connection receives nothing; if the read fails, the
socket closes. A pinned connection is unchanged: location ids are unique, so its
exact match was always isolated. No caller of `broadcast` changed.

`src/lib/realtime.test.ts` covers both with a stand-in socket (10 cases).
`integration/realtime-session-854.integration.test.ts` (3 cases) drives the real
registry, the real session check and the real logout route through an
unprivileged role, so an unscoped read fails under RLS. Each regression fails
part of it: without the token re-check, 2 of the 3 cases fail; with an unscoped
location read, 2 fail; with the old filter, 1 fails.

**Every other producer, end to end.** `session-revocation-854` covers the doors
that used to mint row-less sessions. `integration/session-producers-854.integration.test.ts`
(15 cases) covers every other route that hands out a tenant cookie, each through
its real handler: the password door (directly and through a second factor),
phone OTP, PIN, WebAuthn, invitation acceptance (directly and through a second
factor); the re-mints (step-up, branch switch, the member's own password change
from Profile and from Team, native device registration); and the support doors
(the console's start route, the host hand-off, resume). For each, the cookie
names a live row of exactly its member and business (or names the grant),
«خروج» ends it, and every retained copy — including the copy from before a
re-mint — is refused by the authenticator and by a real route. The WebAuthn case
is not stubbed: a software P-256 authenticator signs a real assertion over the
server's challenge and the unmodified verification checks it (a forged
challenge is refused). The desktop's cloud-login callback gets the same
retained-cookie check in `hybrid-credential-sync`, where its cloud stub lives.
Mutations: letting a revoked row authenticate fails the 12 row cases; letting an
ended grant authenticate fails the 3 support cases; expecting another RP id fails
the WebAuthn case.

**The password door records its door (P2.27).** `/api/auth/login` opened its
row without a `login_method`, and MFA completion recorded one only for the
phone-OTP door, so password sign-ins — and invitations finished through a
second factor — were labelled by the credential fallback. The pending-MFA token
is signed and already names its door (`primaryAuth`, and `invitationId` for an
invitation), so MFA completion now records `phone_otp`, `invitation` or
`password` from it, and the direct password door records `password`. No
migration: both values were already allowed.

**Not changed in the third pass** (both closed in the fourth pass, below):
`createSession` wrote its row and its audit row on two connections, and the
desktop's cloud-login callback recorded no `login_method`.

### Fourth pass (2026-10-16): atomic sessions, the cloud-account door, branch-scoped live events

**A session and its audit are one transaction.** `createSession`
(`src/lib/employee-service.ts`) wrote the employee profile, the
`employee_sessions` row and its `employee.session_created` audit row as three
autocommits on two connections (the audit went to the pool directly). A failed
audit write therefore left a live row that no token named: it could not
authenticate, but Profile and the security center listed it as an active
session with no record of who opened it. All three now run in one
`withTenantTransaction`; inside a caller's transaction `createSession` joins it
(`isPinnedToTransaction`) instead of opening a second one. Every door already
answered a throw before signing a token or setting a cookie, so no door changed
except the company hand-off.

**The company hand-off's platform audit is in the same transaction.** The
route committed the session first and wrote `platform_company.handoff.redeemed`
afterwards: a failure there answered 500 and left an active session in the
company that no cookie named and no platform record explained. The session, its
audit and the platform audit (which now also names the session id) are now one
transaction. `platform_audit_log` is still omitted from tenant exports
(`EXEMPT_TABLES`), but its optional `business_id` is now protected by migration
0228's standard FORCE RLS policy. The tenant transaction can write the row
because its business id matches the active scope; cross-business platform
access uses the documented bypass. If any of the three fails, nothing is
committed and the answer is `503 session_unavailable` with no cookie; the
redeemed token stays spent.

**The desktop's cloud-account sign-in records its door.**
`/api/auth/cloud-login/callback` recorded no `login_method`, and the security
center labels a row with no door and no credential id «پین», so every desktop
cloud-account session was shown as a local PIN sign-in. It now records
`cloud_account` («ورود با حساب ابری»). Migration
`0227_employee_session_cloud_account_login.sql` adds exactly that value to
0226's CHECK; `SESSION_LOGIN_METHODS`, its label and every read model (the
Profile device list via `/api/sessions/self`, the security center via
`listActiveSessionsForBusiness`) share one list, and `session-contract.test.ts` pins it
to the newest migration. Cloud identity readiness, member resolution, credential
authority, MFA and revocation are untouched — the callback only says which door
it is.

**Live events follow the member's branch access.** An all-locations connection
received every branch of its own business whatever the member's scope, so a
member limited to selected branches with no home branch heard all of them; and
a pinned connection was served from the moment it opened, before anyone asked
whether the member could still act in its branch (the first check came 30
seconds later). Now:

- `resolveRealtimeScope` (`src/lib/realtime.ts`) decides what a session may hear
  with the canonical evaluator: `authorize(session, { locationId: pinned })` —
  `canActInLocation`, the branch check every route makes — for a pinned
  connection, and `actionableLocationIds(membership)` for one with no pinned
  branch. `actionableLocationIds` (`src/lib/authorize.ts`) is
  `canActInLocation`'s decision for every branch at once: the same tenant
  boundary, the same `accessibleLocationIds` policy over the same membership
  context (including a Hybrid site's local branch restriction). There is no
  second branch policy.
- `server.ts` resolves the scope **before** the socket opens: an unauthorized
  pinned branch or a gone membership is refused (403/401), and a failed read
  answers 503 — an unresolved scope delivers nothing, and a refused upgrade
  makes the client back off instead of reconnecting every second.
- Every connection carries exactly the branches it may hear; `broadcast` matches
  only that set, which never holds another business's branch.
- Every 30-second re-check re-authenticates the token and re-decides the scope:
  an added branch starts, a removed branch stops, a withdrawn pinned branch or a
  suspended membership closes the socket (`1008 Authorization Revoked`), an ended
  session or closed support grant closes it (`1008 Session Ended`), and a failed
  read empties the scope and closes it (`1011`).

| Requirement | Code | Tests |
|---|---|---|
| Session row + audit atomic | `employee-service.ts` `createSession` → `withTenantTransaction` / joins a caller's | `session-revocation-854` «createSession — the row and its audit are one transaction» (2): an audit failure rolls the row back; inside a caller's transaction nothing is visible before its commit and its rollback takes the row |
| No usable cookie or row after a failure, per door | unchanged doors; `company-handoff` route | password and password + TOTP (`session-producers-854`, 2 cases); business switch, desktop hand-off, bootstrap, signup, company hand-off (`session-revocation-854`, each now also asserts no row and no audit row) |
| Company hand-off platform audit atomic | `company-handoff/route.ts` | `session-revocation-854`: platform-audit failure → 503, no cookie, no session row, no audit rows, token spent; the success path's platform audit names the session |
| Cloud-account door labelled | `0227_employee_session_cloud_account_login.sql`, `session-contract.ts`, `cloud-login/callback` | `session-contract.test.ts` (list = newest CHECK; label); `security-center-settings.test.tsx` (not «پین»); `profile-section.test.tsx`; `hybrid-credential-sync` (row records `cloud_account`) |
| Branch scope for every connection | `authorize.ts` `actionableLocationIds`; `realtime.ts` `resolveRealtimeScope`, `registerConnection`, `broadcast`; `server.ts` upgrade | `realtime.test.ts` (18); `realtime-session-854` (9, unprivileged role): two businesses × several branches; `all`, `selected`, `home`, `none`; selected with no home; authorized and refused pinned branches; an added and a removed branch and a narrowed scope on an open socket; a withdrawn pinned branch and a suspended membership; a closed support grant; «خروج» and a security-center revocation; a real failed scope read (the role loses `SELECT` on `user_locations`) |

Mutations, each restored: `createSession` back to separate autocommits fails 7
cases; the previous company route (audit after commit) fails 2; an unpinned
socket hearing every branch fails 4 of the 9 realtime cases; skipping the pinned
check fails 2 (and 3 unit cases); a re-check that keeps the old scope fails 2;
a failed re-check that stays open fails 1; reading branches across businesses
fails 2.

**Not verified here, stated plainly.** Live events were exercised on one server
process: that each instance re-checks the sockets it holds against the shared
database is the design, not a multi-instance run. A physical authenticator, a
real SMS provider and a two-machine Electron hand-off remain unverified.

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

## Follow-up: team consolidation (issue #947)

The pass-4 work above shipped the *rules*; #947 consolidated the doors they are applied
at, and its own record is the Team section of the manual plus
`src/lib/personnel-file.ts`, `src/lib/personnel-access.ts` and migration
`0221_personnel_links.sql`. Three of that issue's findings revise notes on this page:

- **P2.5 (canonical identity)** — the propagation door is no longer a per-route call. One
  idempotent operation owns it and records a durable debt (`personnel_file_drift`) when it
  cannot complete; a failure is never swallowed. Migration `0223_personnel_file_obligation`
  moved the *obligation* into the membership's own transaction (a trigger on `users`), so a
  committed membership can no longer be file-less without a recorded reason, and
  `listPersonnelFileDebts` (`users` × `parties`) is the inventory the sweep reads — the
  drift table is bookkeeping about a debt, not the evidence of one. Migration
  `0226_personnel_file_obligation_phone_cleared` corrects that trigger's phone arm
  (forward-only, 0223 is applied and unedited): a membership phone that is *cleared* is
  canonical and must clear the file's, so it records the debt like every other mismatch. The
  operation is also the single failure boundary for the propagation — `canonicalIdentity`
  included — because every caller invokes it after committing, and therefore gets an
  explicit `{ ok, reason, error, recorded }` instead of an exception. The seams this shares
  with the floor audit (#916) are written down in `docs/integrations/issue-947-integration-contracts.md`.
- **P2.7 (personnel subsection)** — unchanged: the subsection still mounts only behind
  `canViewParties`. What #947 added is the *field* projection behind it: `parties.view`
  opens the directory, and the sensitive half of an Employee file (identity numbers,
  address, HR notes, bank block) additionally needs `team.view`/`team.manage` or
  `payroll.view` (`personnel-access.ts`), so a cashier's customer lookup can no longer
  read a colleague's national ID through the same endpoint.
- **Branch policy** — the §8/X notes about `location_scope` reflected a `CASE … ELSE
  'all'` in the membership writers. That last arm is gone: a creation or rehire that
  names no branch policy takes the business's default branch, and an edit that clears a
  member's branches takes `none` (`resolveMembershipBranchPolicy`,
  `location-access.ts`).
