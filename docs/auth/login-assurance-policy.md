# Login assurance policy (#1386)

This document records the owner-approved login policy for the cloud account
door, the one intentional change from the #854 baseline, and why the change
does not weaken a stronger factor.

## The three doors

| Door | Primary credential | Routine second step | Sensitive-action step-up |
| --- | --- | --- | --- |
| Cloud account password | verified phone (or legacy email) + password | enrolled TOTP / SMS / recovery code, subject to role policy and trusted-device exemption | `requireRecentAuth` on credential and security routes |
| Cloud passwordless login | verified phone + one SMS OTP (`purpose = login`) | **none** for a routine sign-in; a distinct factor only for a privileged role or an untrusted device with a stronger factor | `requireRecentAuth`; the session is `mfaVerified: false` |
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
| Recovery as an account-takeover path | The code is purpose-bound, expiry/attempt/replay limited, and a successful reset revokes sessions, impersonations and device trust in one transaction with an audit row. Recovery is keyed on the **canonical global** verified number (`platform_users.phone_e164`), never an employer-controlled membership phone. |

## Out of scope of this change

- No new identity or MFA system. The policy composes the existing
  `mfa_enrolments`, `mfa_challenges`, trusted-device and session services.
- No change to the Superadmin realm's own stronger requirements.
- No change to PIN, biometric, invitation, Cloud/Hybrid handoff or Full Offline
  entry points.
- Signup identity creation (#1385) and business provisioning (#1387) are
  separate. An OTP login never creates an identity or a business.
