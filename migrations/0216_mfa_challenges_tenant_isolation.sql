-- Issue #885 L02 follow-up — `mfa_challenges` is no longer tenant-free.
--
-- Migration 0215 added `business_id`, `purpose` and `destination` to this table
-- so a phone-OTP code could be bound to the exact subject, tenant, purpose and
-- destination it was issued for. That made the row tenant data, but the table
-- was still listed in `src/lib/tenant-tables.ts` `EXEMPT_TABLES` — the set of
-- tables with no row-level security, on the reasoning that a login challenge
-- exists before any business is known.
--
-- The reasoning stopped holding the moment the row carried a business. An
-- exempt table is readable from any tenant-scoped connection, so a member of
-- business A could reach business B's challenge rows — including `destination`,
-- which is a member's phone number. `integration/tenant-isolation.integration
-- .test.ts` asserts exactly this invariant, and it was right to fail.
--
-- A separate migration rather than an edit to 0215 because 0215 has already
-- run on the development database; editing it would leave that database
-- unprotected with nothing to re-apply the fix.
--
-- Safe to apply without touching the callers, audited as follows. The
-- platform realms (`platform_user`, `platform_admin`) leave `business_id`
-- NULL and are reached only through `withoutTenantScope("platform", …)`, which
-- sets `app.rls_bypass` and so ignores the policy: `mfa-verify.ts` (verify,
-- attempt increment, delete), `mfa-enrol.ts` (retire, insert) and
-- `mfa-service.ts` (unenrol sweep). The `employee_phone` realm writes through
-- the same bypass in `phone-otp.ts` (`reserveOtpSend`, the dispatch-failure
-- delete) and reads under `withTenant(businessId, …)` in
-- `verifyEmployeePhoneOtp`, where the row's `business_id` is the one being
-- checked. So every existing path either bypasses or matches.
--
-- The effect on the platform rows is the point, not a side effect: with
-- `business_id IS NULL` they now match no tenant predicate at all, so they are
-- invisible to every tenant-scoped connection and reachable only through the
-- deliberate, auditable bypass.
ALTER TABLE mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_challenges FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mfa_challenges FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
