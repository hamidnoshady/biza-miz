/**
 * Issue #1003 item 7 — what the session-less liveness probe says, and to whom.
 *
 * /api/health is public by necessity (status strips, platform health checks,
 * the Android sync worker — every one of which reads only the status code),
 * and it used to hand any caller two things that were never theirs:
 *
 *  - `version`, the exact build commit. That tells a scanner precisely which
 *    release — and so which known bugs — a deployment is running. Its one
 *    legitimate reader is the post-publish rollout check
 *    (scripts/verify-production-deploy.mjs), which now presents a deploy token
 *    (`HEALTH_VERSION_TOKEN`) to get it.
 *  - `instanceId`, the desktop installation's secret nonce. Electron compares
 *    it before opening its window, so any local process that can reach
 *    127.0.0.1 could read it and then impersonate this installation's backend
 *    to the next launch. It is never sent now: Electron sends a random
 *    challenge and the server answers with an HMAC keyed by the id
 *    (`instanceProof`), which proves knowledge of it without revealing it.
 *    The Electron half is `instanceProofFor` in electron/backend-manager.js;
 *    health-response.test.ts holds the two to the same construction.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The deploy token header the rollout check sends to read `version`. */
export const HEALTH_TOKEN_HEADER = "x-health-token";

/** The header Electron sends its random challenge in. */
export const DESKTOP_INSTANCE_CHALLENGE_HEADER = "x-desktop-instance-challenge";

/**
 * A challenge worth answering: URL-safe, at least 16 characters (Electron sends
 * 32 random bytes as base64url, 43 characters). Anything else is ignored, so
 * the probe cannot be made to HMAC arbitrary attacker-chosen input of any size.
 */
const CHALLENGE = /^[A-Za-z0-9_-]{16,128}$/;

/** HMAC-SHA256(key = instance id, "desktop-instance:" + challenge), hex. */
export function desktopInstanceProof(instanceId: string, challenge: string): string {
  return createHmac("sha256", instanceId).update(`desktop-instance:${challenge}`).digest("hex");
}

/**
 * Whether the presented deploy token is the configured one. Unset (or blank)
 * configuration matches nothing, so a deployment that never set the secret
 * simply never reveals its version. Both sides are hashed first so the
 * comparison is constant-time whatever their lengths.
 */
export function healthTokenMatches(presented: string | null | undefined, configured: string | null | undefined): boolean {
  const expected = configured?.trim();
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface HealthEnv {
  APP_IMAGE_SHA?: string;
  DESKTOP_INSTANCE_ID?: string;
  HEALTH_VERSION_TOKEN?: string;
}

export interface HealthBody {
  ok: true;
  /** Only for a caller presenting `HEALTH_VERSION_TOKEN`. */
  version?: string;
  /** Only on the desktop, and only in answer to a well-formed challenge. */
  instanceProof?: string;
  at: string;
}

/** The probe's JSON body for a request with these headers. */
export function healthBody(
  headers: { get(name: string): string | null },
  env: HealthEnv,
  now: Date = new Date(),
): HealthBody {
  const body: HealthBody = { ok: true, at: now.toISOString() };
  if (healthTokenMatches(headers.get(HEALTH_TOKEN_HEADER), env.HEALTH_VERSION_TOKEN)) {
    // Baked into production images by Dockerfile's GIT_SHA build argument.
    body.version = env.APP_IMAGE_SHA || "unknown";
  }
  const challenge = headers.get(DESKTOP_INSTANCE_CHALLENGE_HEADER);
  if (env.DESKTOP_INSTANCE_ID && challenge && CHALLENGE.test(challenge)) {
    body.instanceProof = desktopInstanceProof(env.DESKTOP_INSTANCE_ID, challenge);
  }
  return body;
}
