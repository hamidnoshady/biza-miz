import { createHmac } from "node:crypto";
import { query } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { LockoutPolicy, lockoutStatus, LockoutStatus } from "./login-lockout";

export type AuthRealm = "tenant_password" | "tenant_telegram" | "platform_admin" | "directory";

/** One row of `auth_login_attempts` (migration 0070). */
interface AuthLoginAttemptRow extends Record<string, unknown> {
  outcome: string;
  createdAt: Date;
}

export async function identityKeyFor(email: string): Promise<string> {
  const pepperBase = process.env.LOGIN_ATTEMPT_PEPPER;
  let secret: Uint8Array;
  if (pepperBase) {
    secret = new TextEncoder().encode(pepperBase);
  } else {
    try {
      secret = await getRealmSecret("platform");
    } catch {
      secret = await getRealmSecret("platform", true); // Fallback to previous key if needed
    }
  }
  const hmac = createHmac("sha256", secret);
  hmac.update(email.toLowerCase());
  return hmac.digest("hex");
}

export async function checkAuthLockout(
  realm: AuthRealm,
  email: string,
  policy: LockoutPolicy
): Promise<LockoutStatus> {
  const identityKey = await identityKeyFor(email);
  const { rows } = await query<AuthLoginAttemptRow>(
    `SELECT outcome, created_at AS "createdAt"
     FROM auth_login_attempts
     WHERE realm = $1 AND identity_key = $2
     ORDER BY id DESC LIMIT $3`,
    [realm, identityKey, policy.threshold]
  );

  // `lockoutStatus` speaks the shared audit vocabulary (`action`), while this
  // table stores the same value in its own `outcome` column — map across.
  const events = rows.map((row) => ({ action: row.outcome, createdAt: row.createdAt }));
  return lockoutStatus(events, policy);
}

export async function recordAuthFailure(realm: AuthRealm, email: string) {
  const identityKey = await identityKeyFor(email);
  await query(
    `INSERT INTO auth_login_attempts (realm, identity_key, outcome) VALUES ($1, $2, 'failed')`,
    [realm, identityKey]
  );
}

export async function recordAuthSuccess(realm: AuthRealm, email: string) {
  const identityKey = await identityKeyFor(email);
  await query(
    `INSERT INTO auth_login_attempts (realm, identity_key, outcome) VALUES ($1, $2, 'success')`,
    [realm, identityKey]
  );
}

export async function clearAuthLockout(realm: AuthRealm, email: string) {
  const identityKey = await identityKeyFor(email);
  await query(
    `INSERT INTO auth_login_attempts (realm, identity_key, outcome) VALUES ($1, $2, 'unlocked')`,
    [realm, identityKey]
  );
}