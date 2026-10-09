import { NextRequest, NextResponse } from "next/server";
import { withTenant } from "@/lib/db";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { requestHost } from "@/lib/host";
import { resolveLoginBusinessId } from "@/lib/employee-service";
import { phoneOtpEnforcementFor } from "@/lib/phone-otp";

/**
 * Issue #885 L04 — what this install can actually do, before anyone signs in.
 *
 * The bug this exists to fix: the login chooser offered «ورود آفلاین (محلی)»
 * with an unconditional «نیازی به اینترنت ندارد» on every deployment,
 * including the hosted cloud origin. Pressing it did not go anywhere local —
 * it mounted the same same-origin staff form and said the same thing, on a
 * site that is by definition reached over the Internet. A promise the
 * platform cannot keep is worse than no button, because the member believes
 * the till can be opened without a connection when it cannot.
 *
 * So the door asks first. This endpoint answers two questions the client is
 * not allowed to answer for itself:
 *
 *  - **Which deployment is this?** `cloud`, `hybrid` or `local`, from the
 *    business's own stored profile. Only on a local or hybrid install is
 *    "no Internet needed" a true statement about the server it is talking to.
 *  - **Can a phone code even be delivered?** The phone-OTP policy pauses as
 *    `pending_sms` when no SMS provider is configured, which is exactly the
 *    local/offline case. When enforcement *is* live, an offline login still
 *    needs a fresh SMS once the member's seven-day window has closed — and the
 *    door must say so rather than let the member discover it at the keypad.
 *
 * Deliberately thin, because it is public and pre-session:
 *
 *  - No secrets. Not the Kavenegar key, not a sync token, not the SMTP
 *    config — `phoneOtpEnforcementFor` already reads only configured-ness.
 *  - No membership directory. It never names a member, a role or a count.
 *  - No internal error detail. A host that resolves to no business answers
 *    the same neutral shape as one that does, so the endpoint cannot be used
 *    to enumerate which hostnames a business occupies.
 *
 * A `GET`, so it is not one of the pre-session mutations the middleware's
 * login-CSRF Origin check covers and cannot be forged into doing anything.
 */
export async function GET(request: NextRequest) {
  const { businessId } = await resolveLoginBusinessId({
    host: requestHost(request.headers),
  });

  // No business on this host: the honest answer is "nothing is known about
  // this install", not an error. The client falls back to its neutral copy,
  // which is the same copy a cloud install gets for anything it cannot ask.
  if (!businessId) {
    return NextResponse.json(neutralCapabilities());
  }

  try {
    const [deployment, enforcement] = await withTenant(businessId, async () =>
      Promise.all([
        readDeploymentProfile(businessId),
        phoneOtpEnforcementFor(businessId),
      ]),
    );

    return NextResponse.json({
      deploymentProfile: deployment.profile,
      /**
       * `pending_sms` means no provider is configured, which on a local
       * install is the normal state rather than a fault — the door reads it as
       * "phone verification is not required here yet", not as an error.
       */
      phoneOtpEnforcement: enforcement.state,
      phoneOtpDaysLeft: enforcement.daysLeft,
    });
  } catch (err) {
    // A capability probe that throws must not become a broken login screen.
    console.error("Login capability probe failed", err);
    return NextResponse.json(neutralCapabilities());
  }
}

/**
 * The answer for "we could not determine anything".
 *
 * `cloud` is the conservative default: it is the profile under which the
 * offline claim is *not* made, so an install whose profile cannot be read
 * does not get told it can work without a connection.
 */
function neutralCapabilities() {
  return {
    deploymentProfile: "cloud" as const,
    phoneOtpEnforcement: "off" as const,
    phoneOtpDaysLeft: null,
  };
}
