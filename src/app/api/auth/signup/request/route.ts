/**
 * ESH-200 / #1385 — the public signup's HTTP surface.
 *
 * Two routes, one proof: `request` mints and sends the code, `verify` redeems it
 * and resolves the person. Neither trusts a business id, a membership id or a
 * session: there is none yet, and the number being proven is the only input that
 * matters.
 */
import { NextRequest, NextResponse } from "next/server";
import { requestSignupOtp, type SignupRequestResult } from "@/lib/iam/public-signup";

function respond(result: SignupRequestResult, status: number): NextResponse {
  const res = NextResponse.json(result, { status });
  // A proof in flight is per-request state; never cache it, in any intermediary.
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function POST(request: NextRequest) {
  let body: { firstName?: unknown; lastName?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await requestSignupOtp(body);
  if (result.ok) return respond(result, 200);
  switch (result.error) {
    case "signup_disabled":
      return respond(result, 403);
    case "rate_limited":
      return respond(result, 429);
    case "sms_dispatch_failed":
      return respond(result, 502);
    default:
      return respond(result, 400);
  }
}
