/**
 * Issue #894 Wave 2 — authenticating Torob's calls to a shop's product endpoint.
 *
 * Torob signs each request with **its own** Ed25519 private key and the shop
 * verifies with Torob's public key (`torob/Torob-Sync` →
 * `torob_api_token_guide.md`). Two headers carry it:
 *
 *     X-Torob-Token: <jwt>
 *     X-Torob-Token-Version: 1
 *
 * The claims are `aud`, `exp` and `nbf`. Everything else in this file exists
 * because of one sentence in that guide: *"Always validate the `aud` claim matches
 * your API hostname. This prevents tokens generated for other shops from being
 * used on your endpoint."* So `aud` is compared against the **shop's own stored
 * domain**, never against the request's `Host` header — a caller that sends
 * `Host: other-shop.example` must not be able to make its own token valid.
 *
 * Failures are a closed vocabulary rather than a boolean, because a 401 with no
 * reason is the hardest thing to debug on a partner integration, and because the
 * distinction between "no token", "wrong shop" and "expired" is exactly what an
 * operator needs at 2am.
 */
import { importSPKI, jwtVerify, type JWTPayload } from "jose";

/**
 * Torob's published verification key (Ed25519, SPKI PEM) — the one in their
 * token guide. Overridable through `TOROB_API_PUBLIC_KEY` so a rotation (or a
 * test) does not need a code change; the default is their documented key so a
 * deployment that configures nothing still verifies real traffic.
 */
export const TOROB_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt6Mu4T0pBORY11W+QeM35UsmLO3vsf+6yKpFDEImFk0=
-----END PUBLIC KEY-----`;

/** The only token version the guide currently defines. */
export const TOROB_TOKEN_VERSION = "1";

export const TOROB_TOKEN_HEADER = "x-torob-token";
export const TOROB_TOKEN_VERSION_HEADER = "x-torob-token-version";

export type TorobAuthFailure =
  | "missing_token"
  | "missing_token_version"
  | "unsupported_token_version"
  | "invalid_token"
  | "expired"
  | "not_yet_valid"
  | "audience_mismatch"
  | "wrong_algorithm";

export type TorobAuthResult =
  | { ok: true; audience: string; expiresAt: number | null }
  | { ok: false; reason: TorobAuthFailure };

/** The public key this deployment verifies with. */
export function torobPublicKey(env: Record<string, string | undefined> = process.env): string {
  const configured = env.TOROB_API_PUBLIC_KEY?.trim();
  if (!configured) return TOROB_PUBLIC_KEY_PEM;
  // Accept either a PEM block or the bare base64 body a dashboard tends to copy.
  return configured.includes("BEGIN PUBLIC KEY")
    ? configured
    : `-----BEGIN PUBLIC KEY-----\n${configured}\n-----END PUBLIC KEY-----`;
}

/**
 * Normalise a host for comparison.
 *
 * `aud` is the request's hostname, and the guide's own table shows it may carry a
 * port (`api.example.com:8080`). The shop's stored domain never does, so the port
 * is compared only when the audience supplies one — and the comparison itself is
 * case-insensitive and trailing-dot-insensitive, which are the two ways the same
 * host is spelled differently by two systems that are both right.
 */
export function hostForAudience(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function audienceMatches(audience: string | string[] | undefined, expectedHost: string): boolean {
  if (audience === undefined) return false;
  const expected = hostForAudience(expectedHost);
  const candidates = Array.isArray(audience) ? audience : [audience];
  return candidates.some((candidate) => {
    if (typeof candidate !== "string") return false;
    const normalised = hostForAudience(candidate);
    // A port is allowed; anything else must match exactly.
    return normalised === expected || normalised.replace(/:\d+$/, "") === expected;
  });
}

/**
 * Verify one request's token against one shop's domain.
 *
 * The caller passes the headers it actually received and the domain it resolved
 * from its own database; nothing here reads a header to decide which shop this is.
 */
export async function verifyTorobToken(input: {
  token: string | null;
  tokenVersion: string | null;
  /** The shop's own host, from the shop record — never from the request. */
  expectedHost: string;
  publicKeyPem?: string;
  /** Injectable clock for tests; defaults to now. */
  now?: Date;
}): Promise<TorobAuthResult> {
  const token = input.token?.trim();
  if (!token) return { ok: false, reason: "missing_token" };

  const version = input.tokenVersion?.trim();
  if (!version) return { ok: false, reason: "missing_token_version" };
  if (version !== TOROB_TOKEN_VERSION) return { ok: false, reason: "unsupported_token_version" };

  const key = await importSPKI(input.publicKeyPem ?? torobPublicKey(), "EdDSA");

  let claims: JWTPayload;
  try {
    const verified = await jwtVerify(token, key, {
      algorithms: ["EdDSA"],
      // Checked below against the shop's own domain, so a mismatch is reported as
      // an audience failure rather than an anonymous "invalid".
      audience: undefined,
      clockTolerance: 0,
      currentDate: input.now,
    });
    claims = verified.payload;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      const claim = (error as { claim?: string }).claim;
      if (claim === "nbf") return { ok: false, reason: "not_yet_valid" };
      if (claim === "exp") return { ok: false, reason: "expired" };
      return { ok: false, reason: "invalid_token" };
    }
    if (code === "ERR_JOSE_ALG_NOT_ALLOWED") return { ok: false, reason: "wrong_algorithm" };
    return { ok: false, reason: "invalid_token" };
  }

  if (!audienceMatches(claims.aud, input.expectedHost)) {
    return { ok: false, reason: "audience_mismatch" };
  }

  return {
    ok: true,
    audience: hostForAudience(input.expectedHost),
    expiresAt: typeof claims.exp === "number" ? claims.exp : null,
  };
}

/**
 * The header pair, read from a request's `Headers`.
 *
 * Kept beside the verifier so the two header names are spelled once: a typo in a
 * route is a shop that silently 401s every Torob request.
 */
export function torobAuthHeaders(headers: Headers): { token: string | null; tokenVersion: string | null } {
  return {
    token: headers.get(TOROB_TOKEN_HEADER),
    tokenVersion: headers.get(TOROB_TOKEN_VERSION_HEADER),
  };
}

/** What an operator reads in the log for each failure — never shown to Torob. */
export const TOROB_AUTH_FAILURE_NOTE: Readonly<Record<TorobAuthFailure, string>> = {
  missing_token: "no X-Torob-Token header",
  missing_token_version: "no X-Torob-Token-Version header",
  unsupported_token_version: "token version is not the one this platform implements",
  invalid_token: "signature, format or claims could not be verified",
  expired: "token exp has passed (check server clock synchronisation)",
  not_yet_valid: "token nbf is in the future (check server clock synchronisation)",
  audience_mismatch: "token aud does not name this shop's domain",
  wrong_algorithm: "token is not signed with EdDSA",
};
