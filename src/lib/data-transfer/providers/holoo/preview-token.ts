import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveEncryptionKey } from "@/lib/integrations/secrets";
import type { HolooTransferSource, HolooWorkbookScope } from "./service";

export interface HolooPreviewClaims {
  businessId: string;
  actorUserId: string;
  connectionId: string;
  locationId?: string | null;
  source: HolooTransferSource;
  profileKey: string;
  profileVersion: number;
  scopes: readonly HolooWorkbookScope[];
  inputFingerprint: string;
}

interface SignedHolooPreview extends HolooPreviewClaims {
  expiresAt: number;
}

const PREVIEW_LIFETIME_MS = 15 * 60 * 1000;

function signingKey(): Buffer {
  return resolveEncryptionKey(process.env);
}

function canonical(claims: HolooPreviewClaims): Omit<HolooPreviewClaims, "scopes"> & { scopes: HolooWorkbookScope[] } {
  return {
    businessId: claims.businessId,
    actorUserId: claims.actorUserId,
    connectionId: claims.connectionId,
    locationId: claims.locationId ?? null,
    source: claims.source,
    profileKey: claims.profileKey,
    profileVersion: claims.profileVersion,
    inputFingerprint: claims.inputFingerprint,
    scopes: [...new Set(claims.scopes)].sort(),
  };
}

function signature(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload, "utf8").digest();
}

/** A short-lived, tenant/user-bound approval for an exact Holoo dry-run. */
export function issueHolooPreviewToken(claims: HolooPreviewClaims, key = signingKey(), now = Date.now()): string {
  const tokenPayload: SignedHolooPreview = {
    ...canonical(claims),
    expiresAt: now + PREVIEW_LIFETIME_MS,
  };
  const payload = Buffer.from(JSON.stringify(tokenPayload), "utf8").toString("base64url");
  return `${payload}.${signature(payload, key).toString("base64url")}`;
}

/** Verify the preview approval against the freshly re-read source snapshot. */
export function verifyHolooPreviewToken(
  token: string,
  expected: HolooPreviewClaims,
  key = signingKey(),
  now = Date.now(),
): boolean {
  if (!token || token.length > 4096) return false;
  const [payload, presented, extra] = token.split(".");
  if (!payload || !presented || extra !== undefined) return false;
  const expectedSignature = signature(payload, key);
  const presentedSignature = Buffer.from(presented, "base64url");
  if (presentedSignature.length !== expectedSignature.length || !timingSafeEqual(presentedSignature, expectedSignature)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SignedHolooPreview;
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= now) return false;
    return JSON.stringify(canonical(claims)) === JSON.stringify(canonical(expected));
  } catch {
    return false;
  }
}
