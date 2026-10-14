# Tenant authorization architecture

## Decision flow

Tenant requests use this order:

1. verify the tenant-realm JWT;
2. revalidate an impersonation grant or employee session when present;
3. load the current `users` membership and linked platform identity;
4. require an active membership and active business;
5. compare the current platform `token_version` (password identities);
6. resolve the built-in role preset;
7. apply individual grants and then revocations (deny wins);
8. enforce app availability, feature entitlement and industry module availability;
9. enforce explicit `location_scope` and tenant-owned location IDs;
10. enforce project/resource policy where the feature has one;
11. allow or deny.

JWT role and permissions are never authorization authority. Role and permission changes take effect on the next request.

Platform administration is a separate JWT realm and capability system. Tenant Owner does not imply platform access.

## Identities and memberships

`platform_users` is a global login identity. `users` is a tenant membership. One platform identity may link to multiple memberships with different roles. PIN-only employees intentionally keep `platform_user_id = NULL` and use revocable `employee_sessions`.

Membership lifecycle values are `invited`, `active`, `suspended`, `locked`, `inactive`, and `offboarded`. Offboarding preserves the membership row and historical attribution while revoking credentials and sessions.

### Global vs. tenant credential boundaries

- **Tenant-local credentials (`employee_credentials` — PIN, WebAuthn)** belong to a single `(business_id, employee_id)` membership. A tenant administrator with `team.manage` may set or reset a member's PIN and revoke that member's active `employee_sessions` within their own business (`revokeMemberTenantSessions`).
- **Global credentials (`platform_users.password_hash`, `mfa_enrolments`, `mfa_recovery_codes`)** belong to the account holder across all businesses. A tenant administrator in Business A **cannot** directly choose or overwrite another user's global password (`cross_user_password_reset_forbidden`). Instead, tenant administrators and platform operators issue a single-use, expiring user-controlled recovery token (`auth_password_resets`, redeemed at `/reset-password`).
- **Password & credential revocation**: Every password change or reset (`changeOwnPassword`, `consumePasswordResetToken`) atomically increments `token_version = token_version + 1` on `platform_users` (or `platform_admins`), revokes active `employee_sessions` / `auth_admin_sessions` and `impersonation_grants`, and clears password lockouts. Hybrid desktop credential sync (`ReplicatedLoginCredential`) carries `tokenVersion` and confirmed MFA factors so stale sessions are invalidated offline as well.

### Multi-factor authentication & step-up security

- **Distinct second factor**: Phone OTP (`/api/auth/phone-otp/verify`) is a primary authentication method (`primaryAuth: "phone_otp"`), never a bypass of Owner/Manager MFA. When MFA applies to the membership or the identity has confirmed MFA enrolled, phone-OTP login mints an `mfa_pending` token and requires a **distinct** second factor (`totp` or recovery code — `sms_otp` is rejected when `primaryAuth === "phone_otp"`).
- **Two-step factor confirmation**: Enrolling TOTP or SMS MFA stages an unconfirmed row (`confirmed_at IS NULL, is_primary = false`). The factor only becomes active and eligible as primary (`confirmed_at = now()`) after the user proves possession with a valid code (`verifyAndConfirmMfaCode`). At most one confirmed primary factor exists per identity (`idx_mfa_enrolments_single_confirmed_primary`), selected deterministically via `selectPrimaryMfaEnrolment`.
- **Recent authentication (`requireRecentAuth`)**: Sensitive account mutations (changing password/phone, enrolling/removing/switching MFA factors, regenerating recovery codes, revoking all sessions) require authentication within the last 15 minutes (`RECENT_AUTH_WINDOW_SECONDS = 900`), refreshed in-place via `/api/auth/step-up` or `/api/platform/auth/step-up`.
- **Personal vs. policy surfaces**: Personal account security lives in `/settings/profile` (tenant) and `/platform/account` (superadmin), separate from business-wide MFA/session policy in `/settings` (Security Center) and platform-wide policy/roster in `/platform/security` and `/platform/admins`.

## Roles and effective permissions

Roles are presets. `owner` is an irreducible system rule; `admin` receives every delegatable capability; `manager` is an operational preset. Existing accountant, cashier, waiter and kitchen presets remain supported.

Effective permissions are:

`preset + valid individual grants - individual revocations`

Unknown stored keys are ignored. Revocation wins. `ownerOnly`/non-delegable keys are removed from override input and cannot be granted to Admin or custom member overrides.

The canonical catalogue and risk metadata are in `src/lib/permissions.ts`. API routes use `requirePermission` or `requirePermissions`. Error bodies use stable codes such as `MISSING_PERMISSION`.

## Location scope

`users.location_scope` is explicit:

- `all`: every active location belonging to the tenant;
- `selected`: intersection with `user_locations`;
- `home`: only `users.location_id`;
- `none`: no location access.

Owner is tenant-wide. Client location IDs are validated against the membership tenant before writes. Migration 0170 preserves legacy effective access while making the inferred policy explicit.

## Workspace projects

Tenant `workspace.*` permission is evaluated first. A `workspace_members` project role can narrow that permission for one project but can never grant a tenant capability the member lacks.

## Applications

An application is usable only when tenant entitlement, feature/module support, runtime availability, and member permission all allow it. Navigation uses the same effective permission set used by API routes.

## Remaining semantic role gates

The following role identity checks are intentional:

- WebAuthn employee credential routes: restricted to local/PIN employee categories because the credential belongs to the shared-terminal employee authentication model.
- Waiter board: restricted to cashier/waiter identities because it is the assigned-table shared-terminal workflow, not a general business capability.
- Owner target protection in team routes/UI: a delegated team manager cannot modify, demote, suspend, or offboard an Owner; final-active-owner protection is transactional.
- AI autonomous `auto` approval mode: Owner is the accountable security authority for unattended execution.
- Platform roles and impersonation: separate platform realm with its own capabilities.

All ordinary API domain gates were migrated away from `requireRole` to effective permissions. Sync event definitions also carry permission keys rather than role allowlists.

## Invitations

Invitation plaintext tokens are random, stored only as SHA-256 hashes, tenant-bound, expiring, revocable and single-use. Invitations carry role, member overrides and validated tenant location assignments. Acceptance links an existing global identity when possible instead of duplicating it.

## Auditing and offboarding

Team mutations write tenant-scoped before/after audit records. Offboarding disables the membership, marks it `offboarded`, sets location access to `none`, revokes credentials and employee sessions, closes open shifts, and keeps historical foreign-key attribution.

High-risk and critical permissions are identified in canonical permission metadata for warning, reason and audit behavior.
