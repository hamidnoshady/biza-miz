/**
 * ESH-200 / #1385 — start a phone-first public signup.
 *
 * The route takes exactly the three fields the screen asks for. It never takes
 * a business, membership, email, password or app: none exists at this point,
 * and the number being proven is the only input that matters.
 *
 * The response is the same whether the number is new or already belongs to an
 * account. Verification is where account existence may be mentioned, and only
 * after the caller has proved control of the number.
 */
import { NextRequest, NextResponse } from "next/server";
import { requestSignupOtp, type SignupRequestResult } from "@/lib/iam/public-signup";

function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function respond(result: SignupRequestResult, status: number): NextResponse {
  return noStore(NextResponse.json(result, { status }));
}

export async function POST(request: NextRequest) {
  let body: { firstName?: unknown; lastName?: unknown; phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return noStore(NextResponse.json({ error: "bad_request" }, { status: 400 }));
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
