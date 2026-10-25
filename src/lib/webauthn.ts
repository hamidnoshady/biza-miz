/**
 * Phase 20 Wave 3 — WebAuthn/biometric authentication: the @simplewebauthn
 * wrapper plus the short-lived ceremony-challenge token. This module wraps a
 * library (the same way team.ts wraps bcrypt) rather than being fully
 * framework-free, but it has no database access of its own —
 * employee-service.ts calls into it exactly the way it calls into team.ts's
 * isValidPin, and owns everything that touches employee_credentials.
 *
 * A WebAuthn ceremony (register or authenticate) is two calls: "begin" hands
 * the browser a challenge to sign, "complete" verifies what came back
 * against that same challenge. Every other credential/session in this phase
 * gets a server-side row (employee_sessions, employee_credentials) because
 * it needs to be listable and revocable — a ceremony challenge needs neither;
 * it exists for under two minutes and is worthless the moment it's used or
 * expires. So instead of a table, the challenge travels as a short-lived,
 * signed JWT (`signChallenge`/`verifyChallenge`, same JWT_SECRET and `jose`
 * signing helper as auth-edge.ts's session token) handed to the caller
 * alongside the WebAuthn options and echoed back unmodified on the follow-up
 * call — the caller/browser never reads it, just relays it.
 */
import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getJwtSecret } from "./jwt-secret";
import { parseHost, preferredProto } from "./host";
import { BRAND_NAME_FA } from "./brand";

/** Long enough for a fingerprint/face prompt; short enough that a stale token is useless. */
const CHALLENGE_TTL_SECONDS = 120;

export const CHALLENGE_PURPOSES = ["webauthn-register", "webauthn-authenticate"] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/**
 * The Relying Party ID — the domain a credential is bound to.
 *
 * One deployment == one RP (see auth-edge.ts's REALM comment on the shared
 * JWT_SECRET), and under per-business origins that RP has to be the *root*
 * domain rather than any one business's host: a browser only accepts an RP ID
 * that is a registrable suffix of the page's origin, so an RP ID of
 * `acme.$ROOT_DOMAIN` would make every ceremony on `beta.$ROOT_DOMAIN` fail.
 * ROOT_DOMAIN is therefore the default, and a credential registered at one
 * business's address keeps working at the deployment's others.
 *
 * WEBAUTHN_RP_ID still wins when set, for a deployment that serves from one
 * fixed host; setting it to anything that is not a suffix of the origins
 * actually served is a misconfiguration the browser will reject.
 */
export function rpId(): string {
  return process.env.WEBAUTHN_RP_ID?.trim() || process.env.ROOT_DOMAIN?.trim() || "localhost";
}

export function rpName(): string {
  return process.env.WEBAUTHN_RP_NAME || BRAND_NAME_FA;
}

export function expectedOrigin(): string | string[] {
  const raw = process.env.WEBAUTHN_ORIGIN;
  if (!raw) return "http://localhost:3000";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The origins a ceremony is allowed to have been performed on, for one request.
 *
 * WEBAUTHN_ORIGIN names the fixed ones, and under per-business origins there
 * is one more for every business — a list that cannot be written out in
 * advance, since a new business is a database row. So the request's own origin
 * is added, but only when its host parses as a name this deployment answers on
 * (`parseHost` against ROOT_DOMAIN, the same check the tenant boundary uses).
 *
 * A forged `Host` header cannot widen this: a name outside ROOT_DOMAIN parses
 * as "unknown" and is dropped, and the names inside it are ones the deployment
 * owns and holds a certificate for. The host is kept verbatim (port included)
 * because a browser's origin carries the port it was actually served on.
 *
 * The scheme comes from `x-forwarded-proto` when a terminating proxy set it,
 * and from `fallbackProto` (the request's own scheme) otherwise — never
 * assumed to be HTTPS. Hard-coding https was a bug on plain-HTTP origins
 * (local dev over localtest.me, an HTTP-only staging box): the derived origin
 * could never match the browser's, so every ceremony there failed
 * verification.
 */
export function expectedOriginsFor(
  hostHeader: string | null | undefined,
  forwardedProto: string | null | undefined,
  fallbackProto: string,
): string | string[] {
  const configured = expectedOrigin();
  const base = Array.isArray(configured) ? configured : [configured];

  const root = process.env.ROOT_DOMAIN?.trim() ?? "";
  const host = (hostHeader ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!root || !host || parseHost(host, root).kind === "unknown") return configured;

  const derived = `${preferredProto(forwardedProto, fallbackProto)}://${host}`;
  return base.includes(derived) ? configured : [...base, derived];
}

export interface ChallengeClaims {
  purpose: ChallengePurpose;
  employeeId: string;
  businessId: string;
  challenge: string;
}

/** Exported (rather than kept module-private) so webauthn.test.ts can cover the sign/verify round trip without a real authenticator — the same reasoning employee.ts's generateSessionToken/hashSessionToken are exported for. */
export async function signChallenge(claims: ChallengeClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(getJwtSecret("webauthn ceremony challenges"));
}

/** Returns the original challenge string if `token` is a live, matching challenge — null otherwise (expired, tampered, or for a different employee/business/purpose). */
export async function verifyChallenge(
  token: string,
  purpose: ChallengePurpose,
  employeeId: string,
  businessId: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret("webauthn ceremony challenges"), {
      algorithms: ["HS256"],
    });
    const claims = payload as unknown as ChallengeClaims;
    if (claims.purpose !== purpose || claims.employeeId !== employeeId || claims.businessId !== businessId) {
      return null;
    }
    return claims.challenge;
  } catch {
    return null;
  }
}

export interface CredentialDescriptor {
  id: string;
  transports?: AuthenticatorTransportFuture[] | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function buildRegistrationOptions(
  employeeId: string,
  businessId: string,
  displayName: string,
  excludeCredentials: CredentialDescriptor[],
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    // Not employees.id itself — WebAuthn user handles are visible to the
    // authenticator/OS credential manager, and randomUUID() keeps that
    // opaque the same way employee_sessions' token does, rather than
    // exposing our own primary key to the device.
    userID: new TextEncoder().encode(randomUUID()),
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    excludeCredentials: excludeCredentials.map((c) => ({
      id: c.id,
      transports: c.transports ?? undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeToken = await signChallenge({
    purpose: "webauthn-register",
    employeeId,
    businessId,
    challenge: options.challenge,
  });
  return { options, challengeToken };
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
}

/** Verifies a completed registration ceremony against the challenge it was issued for. Null on any failure — caller doesn't need to distinguish why. */
export async function verifyRegistration(
  employeeId: string,
  businessId: string,
  response: RegistrationResponseJSON,
  challengeToken: string,
  /** The origins this request may have come from; defaults to the configured ones. */
  origins: string | string[] = expectedOrigin(),
): Promise<VerifiedRegistration | null> {
  const challenge = await verifyChallenge(challengeToken, "webauthn-register", employeeId, businessId);
  if (!challenge) return null;

  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId(),
    });
    if (!result.verified || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      signCount: credential.counter,
      transports: credential.transports ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function buildAuthenticationOptions(
  employeeId: string,
  businessId: string,
  allowCredentials: CredentialDescriptor[],
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: allowCredentials.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
    userVerification: "preferred",
  });
  const challengeToken = await signChallenge({
    purpose: "webauthn-authenticate",
    employeeId,
    businessId,
    challenge: options.challenge,
  });
  return { options, challengeToken };
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
}

/** Verifies a completed authentication ceremony against `stored` (the row matching response.id). Returns the authenticator's new signature counter on success, null on any failure. */
export async function verifyAuthentication(
  employeeId: string,
  businessId: string,
  response: AuthenticationResponseJSON,
  challengeToken: string,
  stored: StoredCredential,
  /** The origins this request may have come from; defaults to the configured ones. */
  origins: string | string[] = expectedOrigin(),
): Promise<{ newSignCount: number } | null> {
  const challenge = await verifyChallenge(challengeToken, "webauthn-authenticate", employeeId, businessId);
  if (!challenge) return null;

  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpId(),
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64")),
        counter: stored.signCount,
        transports: stored.transports ?? undefined,
      },
    });
    if (!result.verified) return null;
    return { newSignCount: result.authenticationInfo.newCounter };
  } catch {
    return null;
  }
}
