import { NextRequest, NextResponse } from "next/server";
import {
  isPlatformAccountId,
  findSignupAccount,
  revealSignupAccountContact,
} from "@/lib/iam/signup-events";
import { reserveSignupInspection } from "@/lib/iam/signup-controls";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

/**
 * Issue #1388 — safe inspection of one signup account.
 *
 * Search is **by global account id only** (`platform_users.id`), never by name,
 * phone or email, so this cannot become an identity-enumeration surface. The
 * default answer is masked: a partial phone and a partial email.
 *
 * `POST` reveals the unmasked contact details. It needs `signup.inspect`
 * (owner-only), is rate limited per admin, and writes a `signup.account.reveal`
 * audit row *before* answering. It still never returns an OTP, a password or
 * hash, a national ID, a session token or provider configuration.
 */
function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function rateLimited(retryAfterMs: number): NextResponse {
  const res = noStore(
    { error: "rate_limited", retryAfterMs },
    { status: 429 },
  );
  res.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res;
}

export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("signup.read");
  if (error) return error;

  const accountId = new URL(request.url).searchParams.get("accountId") ?? "";
  if (!isPlatformAccountId(accountId)) {
    return noStore({ error: "invalid_account_id" }, { status: 400 });
  }

  const limit = await reserveSignupInspection(session.padmin);
  if (!limit.allowed) return rateLimited(limit.retryAfterMs);

  const account = await findSignupAccount(accountId);
  if (!account) return noStore({ error: "account_not_found" }, { status: 404 });
  return noStore({ account });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("signup.inspect");
  if (error) return error;

  let body: { accountId?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStore({ error: "bad_request" }, { status: 400 });
  }
  if (!isPlatformAccountId(body.accountId)) {
    return noStore({ error: "invalid_account_id" }, { status: 400 });
  }
  const reason =
    typeof body.reason === "string" && body.reason.trim()
      ? body.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200)
      : null;

  const limit = await reserveSignupInspection(session.padmin);
  if (!limit.allowed) return rateLimited(limit.retryAfterMs);

  const contact = await revealSignupAccountContact(body.accountId);
  if (!contact) return noStore({ error: "account_not_found" }, { status: 404 });

  // Audited before the response: an unmasking with no record is the failure
  // this route exists to prevent. The payload names the fields, never values.
  await platformAudit({
    adminId: session.padmin,
    action: "signup.account.reveal",
    entity: "platform_user",
    entityId: contact.accountId,
    payload: { fields: ["phone", "email"], reason },
  });

  return noStore({ contact });
});
