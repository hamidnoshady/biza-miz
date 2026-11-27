# Login assurance policy (#1386)

This document records the owner-approved login policy for the cloud account
door, the one intentional change from the #854 baseline, and why the change
does not weaken a stronger factor.

## The three doors

| Door | Primary credential | Routine second step | Sensitive-action step-up |
| --- | --- | --- | --- |
| Cloud account password | verified phone (or legacy email) + password | enrolled TOTP / SMS / recovery code, subject to role policy and trusted-device exemption | `requireRecentAuth` on credential and security routes |
| Cloud passwordless login | verified phone + one SMS OTP (`purpose = login`) | **none** for a routine sign-in; a distinct factor only for a privileged role or an untrusted device with a stronger factor | `requireSensitiveRecentAuth`: the session is `mfaVerified: false` and `otpOnlyAssurance: true`, so on an account holding a TOTP a credential change first needs TOTP or a recovery code (see below) |
| Password recovery | verified phone + one SMS OTP (`purpose = password_recovery`) | none — it replaces the password and mints **no** session | the OTP is the proof; the write revokes sessions and device trust |

PIN, biometric, invitation, Superadmin, Cloud, Hybrid and Full Offline doors are
unchanged. They continue to call the same `mfaAppliesToRole` / lockout /
session services.

## The policy change

Before #1386, the phone-OTP door used the password door's rule
(`shouldChallengeMfaOnLogin`): "if any confirmed factor exists, challenge". An
account whose only enrolled factor was SMS was therefore asked for a second
factor on every OTP login. There was no distinct method left to offer, so the
step was either a duplicate SMS challenge or a dead end (`availableMethods: []`).

The approved change is narrow:

- **Routine OTP sign-in is complete after the code is redeemed.** SMS is not
  counted twice.
- **The password door is unchanged.** A password plus any confirmed factor still
  challenges, and a mandatory role still challenges after its grace window.
- **Stronger factors are not bypassed.** A new/untrusted device with an enrolled
  TOTP still performs the TOTP step, and a privileged role (`owner`, `admin`, or
  manager/accountant where the business opted in) still has to complete a
  distinct factor on the OTP path. If the privileged account holds only SMS, the
  MFA step requires enrolling TOTP rather than accepting the same SMS factor
  twice.
- **The existing trusted-device exemption is preserved.** A device that earned
  trust through a completed ceremony may skip the routine challenge on either
  door, within its seven-day expiry, until the member or a security event
  revokes it. A login that was exempted never re-mints trust.

The pure rule lives in `src/lib/login-assurance.ts`; the route composes it in
`src/app/api/auth/phone-otp/verify/route.ts`.

## Sensitive changes after an OTP-only sign-in

Letting one SMS code complete a routine sign-in must not also let that SMS code
**remove the stronger factor**. Otherwise a SIM swap could sign in, delete the
TOTP, and then own the account on both doors. Before this rule, the OTP login
stamped the same fresh `recentAuthAt` as any other door, and
`requireRecentAuth` only asked *when* the session last authenticated. So SMS
alone could disable TOTP, change the login phone, or register or remove a
passkey.

**The claim.** A session records what its latest authentication actually
proved, in `SessionPayload.otpOnlyAssurance` (a JWT claim, so no migration is
needed):

| Event | `otpOnlyAssurance` after it |
| --- | --- |
| Phone-OTP login completed without a distinct factor (direct or after business selection) | `true` |
| Phone-first onboarding (the business is created on an SMS-proven identity) | `true` |
| Login that passed the MFA step (TOTP / recovery code) | absent |
| Password, PIN, biometric, invitation or legacy login | absent |
| Step-up with `totp` or `recovery` | `false` (cleared) |
| Step-up with `sms_otp` | `true` |
| Step-up with `password` or `pin` | unchanged; it refreshes the clock but does not upgrade |
| Business / location switch or native-device re-mint | carried forward |

Tokens minted before #1386 have no claim and are judged exactly as before.

**The guard.** `requireSensitiveRecentAuth` (`src/lib/sensitive-step-up.ts`)
runs `requireRecentAuth` first, so a stale session gets the same refusal it
always got. Then, only when `otpOnlyAssurance` is `true` **and** the account
holds a confirmed TOTP, it refuses with the existing
`403 recent_auth_required` contract plus `distinctFactorRequired: true` and
`allowedMethods: ["totp", "recovery"]`. The step-up `GET` narrows its method
list the same way and reports `recentAuth: false`, so the prompt never offers
a method that the retried change would refuse again. The decision itself is
the pure `decideSensitiveStepUp` in `login-assurance.ts`. It reuses
`distinctSecondFactorMethods`, the list the OTP login policy uses, so the two
cannot disagree about which factor is stronger.

| Route | Guard |
| --- | --- |
| `mfa/self` (enrol, confirm, remove a factor, regenerate recovery codes) | sensitive |
| `phone/self` (change the verified login phone) | sensitive |
| `webauthn/register/options`, `webauthn/register/verify` (add a passkey) | sensitive |
| `webauthn/credentials/[credentialId]` DELETE (remove a passkey) | sensitive |
| `password/self` (change or create a password) | plain `requireRecentAuth`, on purpose: SMS recovery already resets a password without TOTP by design, and a new password never removes the TOTP the password door demands |
| `pin/self` (rotate the staff PIN) | plain `requireRecentAuth`: the PIN is a device-local quick-unlock code for the staff door, not an account factor, and it never satisfies a distinct-factor step-up |
| `connections/telegram` POST (link Telegram, which is itself a login door: `tenant_telegram`) | sensitive |
| Sign out other sessions, revoke trusted devices, unlink Telegram | plain: these are protective, and the owner must never be slowed down defending the account |

An account whose only factor is SMS (or that has none) is not gated. There is
nothing stronger to ask for, and refusing would block the member from enrolling
the very factor that would protect them. Privileged-role policy is unchanged.

## Step-up identity key

The step-up route used to read the membership's `users.email` as its lockout
and SMS rate-limit key. A phone-first identity has no email, so it had:

- no step-up lockout at all;
- a password method that was offered but always refused;
- a bcrypt `Illegal arguments` 500 when the identity had no password hash;
- every phone-first member's step-up SMS sharing one `""` rate-limit bucket.

It now uses the global identity's key, the same one the password door and the
MFA step use: identity email, else the verified E.164 number. The membership
email is used only for a member with no global identity, and the platform user
id is a unique last resort. `verifyPassword` returns `false` for a NULL hash.

## Login screen copy

The account door (`src/components/auth/account-login-form.tsx`) defaults to
phone + password and offers:

- «ورود با رمز یک‌بارمصرف» (both the switch button and the OTP screen heading);
- «فراموشی رمز عبور؟».

The password field has a show/hide toggle. It is a real `button` with
`aria-pressed`, `aria-controls` and the labels «نمایش رمز عبور» /
«پنهان کردن رمز عبور», and it resets to hidden whenever the password is
cleared. The OTP phone field has a real `<label>`, `type="tel"` and
`autocomplete="tel"`. The page heading is «ورود به حساب کاربری».

## Threat model

| Threat | Control |
| --- | --- |
| Attacker with a stolen password and no second factor | Password door keeps the enrolled-factor challenge and mandatory-role rule. OTP policy does not touch it. |
| Attacker who also controls the SMS number | This is the same "something you have" the OTP door already trusts. Privileged accounts still need a distinct enrolled TOTP; recovery revokes every session and all device trust. |
| Attacker tries to skip TOTP by choosing the OTP door | A privileged role or an untrusted device with an enrolled distinct factor still gets the distinct-factor step. |
| Attacker replays a login code as a password reset | Purposes are distinct (`login` vs `password_recovery`), bound to the challenge row, and redemption is single-use and atomic (`SELECT … FOR UPDATE`). |
| Attacker probes whether a number has an account | Login and recovery answer known/unknown numbers with the same shape; recovery never sends to an unverified number and logs dispatch failures without exposing them. |
| Business administrator controls an employee's membership phone | Login and recovery resolve the canonical **global** verified number first (`platform_users.phone_e164`). A membership phone may stand in only for a legacy membership with no global number yet; it never rotates or authenticates the global identity. |
| Attacker uses an old trusted device forever | Trust has a seven-day expiry, is scoped to business + membership, is revoked on password change/reset/lockout/policy tightening, and a waived login does not extend it. |
| Privilege escalation from tenant to platform | Tenant sessions never mint platform-admin authority; the realms keep separate cookies, tokens and routes. |
| SIM swap → MFA downgrade: attacker signs in with the SMS code alone, then removes the TOTP, changes the login phone, adds/removes a passkey or links Telegram | `otpOnlyAssurance` + `requireSensitiveRecentAuth`. While the account holds a TOTP, those changes need TOTP or a recovery code; an `sms_otp`, password or PIN step-up cannot clear the claim. The step-up prompt offers only the methods that satisfy it. |
| Phone-first identity abuses the step-up route (no lockout, shared SMS bucket) | Step-up lockout and SMS limits are keyed on the global identity's email, else verified phone, never a shared empty key; a NULL password hash is a failed verification, not a 500. |
| Two parallel verifies spend one code twice | `redeemOtpChallenge` locks the row `FOR UPDATE`. Real-Postgres tests race 5 parallel login redemptions and 5 parallel recoveries on one code, and exactly one wins each race (`integration/password-recovery.integration.test.ts`). |
| Recovery as an account-takeover path | The code is purpose-bound, expiry/attempt/replay limited, and a successful reset revokes sessions, impersonations and device trust in one transaction with an audit row. Recovery is keyed on the **canonical global** verified number (`platform_users.phone_e164`), never an employer-controlled membership phone. |

## Out of scope of this change

- No new identity or MFA system. The policy composes the existing
  `mfa_enrolments`, `mfa_challenges`, trusted-device and session services.
- No change to the Superadmin realm's own stronger requirements.
- No change to PIN, biometric, invitation, Cloud/Hybrid handoff or Full Offline
  entry points.
- Signup identity creation (#1385) and business provisioning (#1387) are
  separate. An OTP login never creates an identity or a business.
