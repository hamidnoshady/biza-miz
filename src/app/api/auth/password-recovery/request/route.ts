import { NextRequest, NextResponse } from "next/server";
import { boundedString } from "@/lib/login-contract";
import { requestPhonePasswordRecovery } from "@/lib/password-recovery";

/**
 * #1386 — start password recovery through a verified phone.
 *
 * Public by necessity: the caller cannot sign in, which is the only reason to
 * recover a password. The response never says whether the number belongs to an
 * account — a hit, a miss and a provider failure all answer the same neutral
 * `sent` shape. A malformed number is a 400 because the caller supplied it and
 * learns nothing about any account.
 *
 * A per-number limiter (shared with the SMS login budget, namespaced) runs
 * before the lookup, so an unknown number and a known one hit the same 429
 * after the same number of requests.
 */
export async function POST(request: NextRequest) {
  let body: { phone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = boundedString(body.phone, { max: 32, required: false });
  const result = await requestPhonePasswordRecovery(phone);

  if (!result.ok && result.error === "invalid_phone") {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  if (!result.ok && result.error === "rate_limited") {
    return NextResponse.json(
      { error: "rate_limited", retryAfterMs: result.retryAfterMs },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
        },
      },
    );
  }

  return NextResponse.json({
    ok: true,
    status: "sent",
    // The caller typed this number; mirroring it back masked is not a leak and
    // is what the code screen uses to confirm where the SMS went.
    ...(result.ok
      ? {
          maskedPhone: result.maskedPhone,
          expiresInSeconds: result.expiresInSeconds,
        }
      : {}),
    message:
      "اگر این شماره به حسابی متصل باشد، کد بازیابی رمز برایش پیامک می‌شود.",
  });
}
