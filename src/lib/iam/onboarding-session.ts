/**
 * ESH-200 / #1385 — the short-lived continuation from verified signup to the
 * business onboarding door (#1387).
 *
 * A person who has proved their mobile has a personal identity but no business,
 * so there is no tenant to scope the ordinary session cookie to. Minting one
 * anyway would be the "identity pretending to be a tenant" lie the epic forbids.
 * This cookie is the narrow alternative:
 *
 *  - **encrypted, not merely signed** (`dir` + `A256GCM`), like the phone
 *    pending token, so the identity id inside is not readable by the holder;
 *  - **purpose-bound** (`realm: "onboarding"`), so it cannot be replayed as a
 *    tenant session or as a phone challenge;
 *  - **short-lived**, and it grants access only to the onboarding entry point.
 *    That route re-reads the identity from the database on every request, so a
 *    deactivated person loses the continuation immediately.
 *
 * It creates no business, membership or session row. Provisioning is #1387's
 * explicit, separate act.
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
 * The database read is deliberate: the token says who they were, the database
 * says whether they may still continue (active, phone still verified). A token
 * for an identity that has since been deactivated is worth nothing.
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
