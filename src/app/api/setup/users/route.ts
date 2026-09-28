import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { markStepDone } from "@/lib/settings";
import { resolveActiveLocation, requireManager } from "@/lib/setup-state";
import { toLatinDigits } from "@/lib/digits";
import { isPasswordRole, isPinRole, isValidPin } from "@/lib/team";
import { SETUP_CREATABLE_ROLES } from "@/lib/roles";
import { TeamError, createMembership, isPhoneTaken, isPinTaken } from "@/lib/team-service";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import type { Role } from "@/lib/auth";
import { withTenantScope } from "@/lib/auth";

/** Step 5 — roles & initial users (owner already exists from bootstrap/seed). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const { rows: users } = await query(
    `SELECT id, role, full_name, email, is_active,
            (pin_hash IS NOT NULL OR EXISTS (
              SELECT 1 FROM employee_credentials ec
               WHERE ec.employee_id = users.id AND ec.business_id = users.business_id
                 AND ec.credential_type = 'pin' AND ec.status = 'active'
            )) AS has_pin
       FROM users WHERE business_id = $1
      ORDER BY created_at`,
    [session.businessId],
  );
  return NextResponse.json({ users });
});

/**
 * The roles the wizard may create. The owner exists from bootstrap; the two
 * password roles (manager, accountant) and the three PIN roles are creatable
 * here. The accountant was missing for no recorded reason while the team
 * screen offered it — a business setting up its books in the wizard had to
 * stop halfway and finish in Settings.
 */

/**
 * Creates a member during the setup wizard.
 *
 * Delegates to `createMembership` rather than inserting directly. That is not
 * tidiness: since Phase 12 the login identity lives in `platform_users`, and
 * this route's own INSERT created a `users` row without one — leaving every
 * manager added through the wizard unable to sign in, because login resolves
 * by identity. One creation path is what keeps that fixed.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: {
    role?: Role;
    fullName?: string;
    email?: string;
    password?: string;
    pin?: string;
    phone?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const role = body.role;
  const fullName = body.fullName?.trim();
  if (!fullName || !role || !SETUP_CREATABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  let pin: string | null = null;
  let locationId: string | null = null;

  if (isPasswordRole(role)) {
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "invalid_email" }, { status: 400 });
    }
    if ((body.password ?? "").length < 8) {
      return NextResponse.json({ error: "weak_password" }, { status: 400 });
    }
    const { rows: dup } = await query(
      "SELECT 1 FROM users WHERE business_id = $1 AND email = $2",
      [session.businessId, email],
    );
    if (dup.length > 0) {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
  } else if (isPinRole(role)) {
    // Fold Persian digits before the shape check — the numeric pad emits
    // Persian glyphs, and the same rule the team route applies keeps a
    // «۱۲۳۴» typed in the wizard from becoming an invalid pin.
    pin = toLatinDigits(body.pin ?? "");
    if (!isValidPin(pin)) {
      return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
    }
    const location = await resolveActiveLocation(session);
    if (!location) {
      return NextResponse.json({ error: "no_location" }, { status: 409 });
    }
    locationId = location.id;
    if (await isPinTaken(session.businessId, pin)) {
      return NextResponse.json({ error: "pin_taken" }, { status: 409 });
    }
  }

  // Phase 42 — the login phone, optional: stored unverified, proven by the
  // member with an OTP at their first door login.
  let phone: string | null = null;
  if (body.phone && String(body.phone).trim()) {
    phone = canonicalMemberPhone(body.phone);
    if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    if (await isPhoneTaken(session.businessId, phone)) {
      return NextResponse.json({ error: "phone_taken" }, { status: 409 });
    }
  }

  try {
    await createMembership({
      businessId: session.businessId,
      role,
      fullName,
      email: isPasswordRole(role) ? (body.email ?? null) : null,
      password: isPasswordRole(role) ? (body.password ?? null) : null,
      pin,
      phoneE164: phone,
      defaultLocationId: locationId,
      locationIds: locationId ? [locationId] : [],
      actorId: session.sub,
    });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const progress = await markStepDone(session.businessId, "users");
  return NextResponse.json({ ok: true, progress });
});
