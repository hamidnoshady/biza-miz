import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import {
  listBusinessOwnerProfiles,
  updateBusinessOwnerProfile,
  type OwnerProfileError,
} from "@/lib/platform-owner-profile";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Where each refusal lands. Uniqueness and cross-business impact are conflicts. */
const ERROR_STATUS: Record<OwnerProfileError, number> = {
  member_not_found: 404,
  missing_fields: 400,
  invalid_email: 400,
  invalid_phone: 400,
  no_changes: 400,
  email_taken: 409,
  cross_business_confirmation_required: 409,
  identity_missing: 409,
};

/**
 * Who owns and runs one business — the owner/manager profiles (issue #755 §1).
 *
 * Reads ride `businesses.read` (every admin role), so support can look up the
 * owner's name, email and phone while diagnosing an account. Writes need
 * `business.edit` (owner-only), which is also what editing the business's own
 * name needs: this is the same act — changing what the record says — with a
 * bigger blast radius, because the email is a login.
 *
 * The response carries no credential of any kind: no password hash, no TOTP
 * secret, no recovery-code material, no token. Security state is reported as
 * *state* — enrolled or not, by which method, which phone an OTP would go to,
 * how many unused recovery codes remain.
 */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformCapability("businesses.read");
  if (error) return error;

  const { id } = await ctx.params;
  if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ profiles: await listBusinessOwnerProfiles(id) });
});

export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.edit");
  if (error) return error;

  const { id } = await ctx.params;
  let body: {
    membershipId?: string;
    fullName?: string;
    email?: string;
    phone?: string;
    isActive?: boolean;
    confirmCrossBusiness?: boolean;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  for (const key of ["fullName", "email", "phone"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await updateBusinessOwnerProfile(id, {
    membershipId: String(body.membershipId ?? ""),
    fullName: body.fullName,
    email: body.email,
    phone: body.phone,
    isActive: body.isActive,
    confirmCrossBusiness: body.confirmCrossBusiness === true,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }

  const reason = body.reason?.trim() || null;
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "business.owner_profile.updated",
    entity: "user",
    entityId: result.after.membershipId,
    // Before/after, and nothing else: an audit row that carried a credential
    // would be worse than no audit row (same rule as provisioning).
    payload: {
      reason,
      before: {
        fullName: result.before.fullName,
        email: result.before.email,
        phone: result.before.mfa.phoneE164,
        membershipActive: result.before.membershipActive,
      },
      after: {
        fullName: result.after.fullName,
        email: result.after.email,
        phone: result.after.mfa.phoneE164,
        membershipActive: result.after.membershipActive,
      },
      notices: result.notices,
    },
  });

  return NextResponse.json({
    profiles: await listBusinessOwnerProfiles(id),
    notices: result.notices,
  });
});
