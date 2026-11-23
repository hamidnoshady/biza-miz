import { NextResponse } from "next/server";
import { consumeEmailVerification } from "@/lib/iam/identity-credentials";

function noStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/**
 * ESH-199 / #1384 follow-up — redeem a delivered email proof.
 *
 * A POST rather than a GET in the link so a mail scanner prefetching the URL
 * cannot spend the single-use token before the person opens it. The token is
 * the only credential; the service atomically consumes it and stamps
 * `email_verified_at` only if the address is still the one it was issued for.
 */
export async function POST(request: Request) {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return noStore({ error: "bad_request" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 256) {
    return noStore({ error: "invalid_token" }, { status: 400 });
  }

  const result = await consumeEmailVerification(token);
  if (!result.ok) return noStore(result, { status: 400 });
  // The address is intentionally not echoed back; the caller already holds the
  // link, and a generic success is all the page needs.
  return noStore({ ok: true });
}
