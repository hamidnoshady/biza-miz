/**
 * ESH-203 / #1388 — the deployment-wide authentication switches.
 *
 * The public phone-first door (#1385) must be closable by an operator without a
 * deploy, and the decision must be auditable. Migration 0310 keeps that in a
 * singleton row rather than an environment variable, with one nuance that is
 * load-bearing:
 *
 *  - `configured = false` means no operator has ever touched the switch, so the
 *    effective answer is the pre-existing `ALLOW_PUBLIC_SIGNUP` environment
 *    decision. An install already serving self-service signup therefore keeps
 *    working through the deploy.
 *  - `configured = true` means an operator chose, and the stored boolean wins —
 *    including an explicit `false`, which must not be re-opened by an env var
 *    left over from before.
 *
 * The row carries no business_id (this is a property of the deployment), so it
 * lives under the `platform_only` policy and reads through the documented
 * platform/identity bypass.
 */
import { query, withoutTenantScope } from "../db";

export interface PlatformAuthSettings {
  /** The effective answer callers must enforce, server-side. */
  publicSignupEnabled: boolean;
  /** True once an operator saved the switch; false while it tracks the env. */
  configured: boolean;
  updatedAt: string | null;
}

/** The environment fallback, unchanged from the pre-#1388 contract. */
export function publicSignupEnvDefault(): boolean {
  return process.env.ALLOW_PUBLIC_SIGNUP === "true";
}

export async function readPlatformAuthSettings(): Promise<PlatformAuthSettings> {
  const { rows } = await withoutTenantScope("signup", () =>
    query<{ public_signup_enabled: boolean; configured: boolean; updated_at: Date }>(
      `SELECT public_signup_enabled, configured, updated_at
         FROM platform_auth_settings
        WHERE id = 1`,
    ),
  );
  const row = rows[0];
  return {
    publicSignupEnabled: row?.configured ? row.public_signup_enabled : publicSignupEnvDefault(),
    configured: row?.configured ?? false,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** The one predicate every public signup route enforces. */
export async function isPublicSignupEnabled(): Promise<boolean> {
  return (await readPlatformAuthSettings()).publicSignupEnabled;
}

/**
 * Record an operator's decision.
 *
 * The caller is responsible for the capability check and for the platform audit
 * row (`src/lib/platform-auth.ts`'s `platformAudit`), which is where every other
 * console write records its actor. This function only owns the row.
 */
export async function setPublicSignupEnabled(input: {
  enabled: boolean;
  updatedBy: string;
}): Promise<PlatformAuthSettings> {
  await withoutTenantScope("platform", () =>
    query(
      `UPDATE platform_auth_settings
          SET public_signup_enabled = $1,
              configured = true,
              updated_by = $2,
              updated_at = now()
        WHERE id = 1`,
      [input.enabled, input.updatedBy],
    ),
  );
  return readPlatformAuthSettings();
}
