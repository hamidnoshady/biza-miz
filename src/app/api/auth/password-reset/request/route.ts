import { NextRequest, NextResponse } from "next/server";
import { boundedString, loginEmailOrNull } from "@/lib/login-contract";
import { requestPlatformUserPasswordReset } from "@/lib/password-reset-request";

/**
 * Issue #885 L10 — forgotten-password initiation.
 *
 * Pre-session by necessity: the caller is, by definition, someone who cannot
 * get in. That makes this endpoint an account-existence oracle unless it is
 * written to answer identically in every case, so that is the whole design
 * here — there is one response shape and one status, and the service's
 * outcome is used for logs only.
 *
 * It is registered in `PUBLIC_PATHS` and in `BROWSER_LOGIN_MUTATION_PATHS`,
 * so it is reachable signed out but still carries the pre-session Origin
 * check that the other login mutations carry.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const rawEmail = boundedString((body as { email?: unknown })?.email, { max: 254, trim: true });
  const email = rawEmail ? loginEmailOrNull(rawEmail) : null;
  if (!email) {
    // A malformed address is refused outright rather than answered with the
    // neutral 200. This is not an enumeration leak: the caller supplied the
    // string, so it learns nothing about any account.
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const result = await requestPlatformUserPasswordReset(email);

  if (result.outcome !== "sent") {
    // One log line per non-delivery, so an operator can tell "nobody by that
    // name" from "SMTP is not configured on this deployment" without the
    // distinction ever reaching the client.
    console.info("password reset request not delivered", {
      email,
      outcome: result.outcome,
      ...(result.outcome === "not_configured" ? { reason: result.reason } : {}),
    });
  }

  // Identical for every outcome, including rate-limited and unknown-address:
  // a 429 or a differing body here would tell the caller the address exists.
  return NextResponse.json({
    ok: true,
    message:
      "اگر این نشانی در سامانه ثبت شده باشد، پیوند بازنشانی رمز عبور برایش ارسال می‌شود.",
  });
}
