import { NextRequest, NextResponse } from "next/server";
import {
  acknowledgeSigningSession,
  declineSigningSession,
  openSigningSession,
  requestSignerOtp,
  signingReceipt,
  submitSignature,
} from "@/lib/contracts/signing";
import { WorkspaceError } from "@/lib/workspace";

/**
 * The external signatory's API — `/api/sign/<token>`.
 *
 * This is the one surface in the product with no session behind it. The
 * authority is the token in the path: 256 random bits, stored only as an
 * HMAC-SHA-256 digest, bound to one signer on one frozen document version,
 * expiring, and revocable by the sender. That is why this route deliberately
 * takes **no** business, contract, version or signer id from the caller — every
 * id is resolved *from the token*, so a modified payload can only ever act on
 * the session it already holds.
 *
 * What it will not do, on purpose:
 *  - return a document that is not frozen (a draft has no hash and no consent);
 *  - accept a signature without an acknowledged consent and a fresh OTP;
 *  - say "sent" when no SMS provider is configured — the caller learns the
 *    truth and the sender is told to deliver the link another way.
 *
 * The three anti-replay rules live in the service, not here: one signature per
 * signer (unique index), a hash comparison against the envelope's version, and
 * a live envelope state that a completed or cancelled round no longer satisfies.
 */
export const dynamic = "force-dynamic";

/** Responses must never be cached: the body is one person's signed contract. */
function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

const ERROR_STATUS: Record<string, number> = {
  invalid_link: 404,
  link_expired: 410,
  link_revoked: 410,
  contract_version_mismatch: 409,
  signing_envelope_not_live: 409,
  signing_already_signed: 409,
  signing_not_your_turn: 409,
  signer_declined: 409,
  consent_required: 409,
  otp_required: 409,
  otp_invalid: 400,
  otp_expired: 400,
  otp_attempts_exhausted: 429,
  otp_rate_limited: 429,
  signature_invalid: 400,
  signer_phone_invalid: 400,
  signer_name_required: 400,
  decline_reason_required: 400,
  contract_signing_unavailable: 503,
};

function signError(error: unknown) {
  if (error instanceof WorkspaceError) {
    return privateJson({ error: error.code }, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}

/** The requesting client, for the evidence trail: truncated, never the full IP. */
function clientFacts(request: NextRequest): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0].trim() : request.headers.get("x-real-ip");
  return { ip, userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  try {
    const session = await openSigningSession(token, clientFacts(request));
    // The receipt is a SEPARATE read because it comes from the signature row,
    // not from the invitation: a signer whose link was rotated after signing
    // still gets the receipt for the signature they actually made.
    const receipt = session.state === "receipt" ? await signingReceipt(token) : null;
    return privateJson({ session, receipt });
  } catch (error) {
    return signError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const facts = clientFacts(request);
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    switch (String(body.action ?? "")) {
      case "acknowledge": {
        if (body.consent !== true) {
          return privateJson({ error: "consent_required" }, 409);
        }
        const session = await acknowledgeSigningSession(token, facts);
        return privateJson({ session });
      }
      case "otp": {
        const delivery = await requestSignerOtp(token, facts);
        return privateJson(delivery);
      }
      case "sign": {
        const receipt = await submitSignature(token, {
          code: typeof body.code === "string" ? body.code : "",
          fullName: typeof body.fullName === "string" ? body.fullName : "",
          drawnImage: typeof body.drawnImage === "string" ? body.drawnImage : "",
          ip: facts.ip,
          userAgent: facts.userAgent,
        });
        return privateJson(receipt);
      }
      case "decline": {
        const session = await declineSigningSession(token, {
          reason: typeof body.reason === "string" ? body.reason : "",
          ip: facts.ip,
          userAgent: facts.userAgent,
        });
        return privateJson({ session });
      }
      default:
        return privateJson({ error: "unknown_action" }, 400);
    }
  } catch (error) {
    return signError(error);
  }
}
