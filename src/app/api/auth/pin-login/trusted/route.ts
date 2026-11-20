import { NextRequest, NextResponse } from "next/server";
import { query, withTenant } from "@/lib/db";
import { resolveDeviceId } from "@/lib/device-service";
import { requestHost } from "@/lib/host";
import { resolveLoginBusinessId } from "@/lib/employee-service";
import { readTrustedDeviceToken, resolveTrustedDeviceSubject } from "@/lib/trusted-device";

interface TrustedMemberRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  role: string;
  photo_url: string | null;
  has_webauthn: boolean;
  has_pin: boolean;
}

/**
 * «فقط پین» on the cloud door.
 *
 * After a member signs in with email/phone + password + second factor and ticks
 * «اعتماد به این دستگاه برای ۷ روز», the next visit should not show the account
 * form again — it should ask for the PIN they set. The decision is entirely
 * server-side: this route reads the seven-day trust cookie, resolves the one
 * member it belongs to, and answers that member *only if* they hold an active
 * PIN. No cookie, an expired/revoked trust, or a member without a PIN answers
 * `{ employee: null }` and the caller shows the account form.
 *
 * It reads that one member directly instead of the roster: the Cloud roster is
 * staff-only by policy, so an owner found through it could never be greeted by
 * the PIN pad even after the product's own remember-me flow. The trust record
 * already names the person, and nothing else is returned — no roster, no
 * counts, no credential.
 */
export async function GET(request: NextRequest) {
  const { businessId } = await resolveLoginBusinessId({
    host: requestHost(request.headers),
  });
  if (!businessId) return NextResponse.json({ employee: null });

  return withTenant(businessId, async () => {
    const trusted = await resolveTrustedDeviceSubject({
      businessId,
      token: readTrustedDeviceToken(request),
    });
    if (!trusted) return NextResponse.json({ employee: null });

    const deviceId = await resolveDeviceId(null, businessId);
    const { rows } = await query<TrustedMemberRow>(
      `SELECT u.id, u.full_name, u.role::text AS role, e.photo_url,
              EXISTS (
                SELECT 1 FROM employee_credentials c
                 WHERE c.employee_id = u.id AND c.credential_type = 'webauthn'
                   AND c.status = 'active'
                   AND ($2::uuid IS NULL OR c.device_id = $2 OR c.device_id IS NULL)
              ) AS has_webauthn,
              coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL AS has_pin
         FROM users u
         LEFT JOIN employees e ON e.id = u.id
         LEFT JOIN LATERAL (
           SELECT secret_hash FROM employee_credentials
            WHERE employee_id = u.id AND business_id = u.business_id
              AND credential_type = 'pin' AND status = 'active'
            ORDER BY created_at DESC LIMIT 1
         ) ec ON true
        WHERE u.business_id = $1 AND u.id = $3 AND u.is_active`,
      [businessId, deviceId, trusted.userId],
    );
    const member = rows[0];
    if (!member || !member.has_pin) return NextResponse.json({ employee: null });

    return NextResponse.json({
      employee: {
        id: member.id,
        fullName: member.full_name,
        role: member.role,
        photoUrl: member.photo_url,
        hasWebauthn: member.has_webauthn,
        // The device is trusted, so the routine phone gate is waived for it
        // (`pinGateCloses` with `deviceTrusted: true`); the PIN is the step.
        loginMode: "pin" as const,
        phoneState: "verified" as const,
      },
    });
  });
}
