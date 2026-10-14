import { NextRequest, NextResponse } from "next/server";
import {
  consumePasswordResetToken,
  previewPasswordResetToken,
} from "@/lib/password-reset";

/**
 * Public user-controlled password reset / recovery endpoint (Issue #809 —
 * Findings 2, 3 & 6).
 *
 * Previews (`GET`) and redeems (`POST`) a single-use `auth_password_resets`
 * token so only the account holder sets their permanent password.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const preview = await previewPasswordResetToken(token);
  if (!preview) {
    return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  }

  return NextResponse.json({
    email: preview.email,
    subjectRealm: preview.subjectRealm,
    expiresAt: preview.expiresAt,
    status: preview.status,
  });
}

export async function POST(request: NextRequest) {
  let body: { token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!token || !password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const result = await consumePasswordResetToken({ token, newPassword: password });
  if (!result.ok) {
    const status =
      result.error === "invalid_token"
        ? 404
        : result.error === "token_expired" ||
            result.error === "token_used" ||
            result.error === "token_revoked"
          ? 409
          : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({
    ok: true,
    subjectRealm: result.subjectRealm,
    email: result.email,
  });
}
