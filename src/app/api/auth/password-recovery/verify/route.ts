import { NextRequest, NextResponse } from "next/server";
import { boundedString } from "@/lib/login-contract";
import { verifyPhonePasswordRecovery } from "@/lib/password-recovery";

/**
 * #1386 — redeem a purpose-bound `password_recovery` code and set the password.
 *
 * Refusals collapse to `invalid_code`: no-challenge, expired, wrong code, wrong
 * phone and an identity that vanished all look the same to an unauthenticated
 * caller. A weak password is the only 400 that names a different reason,
 * because the caller can act on it and it says nothing about account existence.
 *
 * No session is minted here. The member signs in normally afterwards.
 */
export async function POST(request: NextRequest) {
  let body: {
    phone?: unknown;
    code?: unknown;
    newPassword?: unknown;
    confirmPassword?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await verifyPhonePasswordRecovery({
    phone: body.phone,
    code: body.code,
    newPassword: boundedString(body.newPassword, { max: 128, trim: false }) ?? "",
    confirmPassword:
      boundedString(body.confirmPassword, { max: 128, trim: false, required: false }) ?? undefined,
  });

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      passwordChanged: true,
      tokenVersion: result.tokenVersion,
      revokedSessions: result.revokedSessions,
    });
  }

  if (result.error === "invalid_phone") {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  if (result.error === "invalid_code") {
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }
  if (result.error === "invalid_identity") {
    // Same answer as a wrong code: the caller must not learn that a challenge
    // was valid but the account disappeared between the two reads.
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  return NextResponse.json({ error: result.error }, { status: 400 });
}
