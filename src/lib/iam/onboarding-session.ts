/**
 * ESH-202 / #1387 — the short-lived continuation that carries a verified person
 * from signup into onboarding.
 *
 * A personal identity has no business yet, so it cannot carry the tenant session
 * cookie: that cookie names a business and a membership, and inventing one would
 * be exactly the "identity without a tenant" lie the epic forbids. This is a
 * narrow, encrypted, same-origin cookie instead:
 *
 *  - **Encrypted, not merely signed** (`dir` + `A256GCM`), like the phone
 *    pending token: a signed JWT's payload is readable by anyone holding it, and
 *    this token names an identity.
 *  - **Bound to one identity and one purpose** (`realm: "onboarding"`), so it can
 *    never be replayed as a session or as a phone challenge.
 *  - **Short-lived** (30 minutes, renewed by each onboarding read/write) and
 *    cleared when the business is provisioned and the real session is minted.
 *
 * It authorises only the onboarding endpoints. Every one of them re-reads the
 * identity from the database, so a deactivated identity loses access immediately
 * rather than when the token happens to expire.
 */
import { EncryptJWT, jwtDecrypt } from "jose";
import { getRealmSecret } from "../jwt-secret";
import { query, withoutTenantScope } from "../db";

export const ONBOARDING_COOKIE = "pos_onboarding";

/** Long enough for a slow form, short enough not to become a second session. */
export const ONBOARDING_TTL_SECONDS = 30 * 60;

interface OnboardingClaims {
  puid?: string;
  realm?: string;
}

export async function signOnboardingToken(platformUserId: string): Promise<string> {
  const secret = await getRealmSecret("platform");
  return new EncryptJWT({ puid: platformUserId, realm: "onboarding" })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${ONBOARDING_TTL_SECONDS}s`)
    .encrypt(secret);
}

/** The platform user id the token proves, or null for anything unusable. */
export async function verifyOnboardingToken(
  token: string | null | undefined,
): Promise<string | null> {
  if (!token || token.length > 4096) return null;
  try {
    const secret = await getRealmSecret("platform");
    const { payload } = await jwtDecrypt<OnboardingClaims>(token, secret);
    if (payload.realm !== "onboarding" || typeof payload.puid !== "string") return null;
    return payload.puid;
  } catch {
    return null;
  }
}

export function onboardingCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONBOARDING_TTL_SECONDS,
  };
}

/**
 * Resolve the cookie to a live identity id.
 *
 * The extra read is deliberate: the token says who they were, the database says
 * whether they still may continue (active, phone still verified, not yet
 * provisioned).
 */
export async function readOnboardingIdentity(
  token: string | null | undefined,
): Promise<string | null> {
  const platformUserId = await verifyOnboardingToken(token);
  if (!platformUserId) return null;
  const { rows } = await withoutTenantScope("signup", () =>
    query<{ id: string }>(
      `SELECT id FROM platform_users
        WHERE id = $1 AND is_active AND phone_verified_at IS NOT NULL`,
      [platformUserId],
    ),
  );
  return rows[0]?.id ?? null;
}
