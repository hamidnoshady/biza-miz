import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isLocationScope } from "@/lib/location-access";
import { toLatinDigits } from "@/lib/digits";
import { isPinRole, isValidPin, sanitizeOverrides } from "@/lib/team";
import {
  TeamError,
  createMembership,
  isPhoneTaken,
  isPinTaken,
  listMembers,
} from "@/lib/team-service";
import {
  grantRefusalMessage,
  loadCustomRole,
  membershipGrantRefusal,
  projectGrantedPermissions,
  resolveMembershipAuthority,
} from "@/lib/membership-authority";
import { listBranches } from "@/lib/branch-service";
import { canonicalMemberPhone } from "@/lib/phone-otp";
import { ASSIGNABLE_ROLES } from "@/lib/roles";
import type { Role } from "@/lib/auth";
import { readDeploymentProfile } from "@/lib/deployment-mode";

/**
 * The business's members, with their effective permissions resolved, and the
 * business's branches — the team screen assigns members to branches, and it
 * reads both through this one permission (`locations.manage` alone, which the
 * branch tab needs, is deliberately *not* required: a manager who may manage
 * the team but not open branches can still see the names of the places they
 * are assigning people to).
 */
export const GET = withTenantScope(async () => {
  // `team.view` OR `team.manage`: the list is a read, and carving out a
  // read-only key would be pointless if it did not actually open the read.
  // The wider key still passes — a member granted only `team.manage` must not
  // be locked out of the list they are allowed to edit.
  const { session, error } = await requireAnyPermission(
    PERMISSIONS.teamView,
    PERMISSIONS.teamManage,
  );
  if (error) return error;

  const [members, branches, deployment] = await Promise.all([
    listMembers(session.businessId),
    listBranches(session.businessId),
    readDeploymentProfile(session.businessId),
  ]);
  return NextResponse.json({
    deploymentProfile: deployment.profile,
    members,
    locations: branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      isActive: branch.isActive,
    })),
  });
});

/**
 * Adds a member directly.
 *
 * PIN staff are created outright — they work a shared device and have no email
 * to invite. Password roles can also be created directly (with a password, or
 * by linking an email that already has a platform login), but inviting is the
 * better path for those and is what the UI leads with.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  let body: {
    role?: Role;
    fullName?: string;
    email?: string;
    password?: string;
    pin?: string;
    phone?: string;
    locationIds?: string[];
    defaultLocationId?: string | null;
    /** 'all' | 'selected' | 'home' — the explicit branch policy (migration 0170). */
    locationScope?: string;
    permissions?: unknown;
    /** Issue #854 (P0.1) — custom-role assignment is part of the grant. */
    customRoleId?: string | null;
    /** Issue #854 (P2.4) — why this membership is being created with this access. */
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const role = body.role;
  if (!role || !ASSIGNABLE_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }

  /**
   * Issue #854 (P0.1) — the anti-escalation rule, applied to *creation*.
   *
   * `team.manage` can be delegated, and the old guard here only refused
   * creating another `owner`. Everything else — a role more powerful than the
   * actor's, permission overrides the actor does not hold, a custom role whose
   * capabilities out-rank the actor — was accepted. A delegated team manager
   * who could not *edit* a colleague into `payments.refund` could simply create
   * one that had it. The decision now goes through the same shared function
   * that guards member editing and invitations, so the three doors cannot
   * disagree about what the actor is allowed to hand out.
   */
  const actor = await resolveMembershipAuthority(session.businessId, session.sub);
  if (!actor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const overrides = sanitizeOverrides(body.permissions);
  const customRole = body.customRoleId ? await loadCustomRole(session.businessId, body.customRoleId) : null;
  if (body.customRoleId && !customRole) {
    return NextResponse.json({ error: "custom_role_not_found" }, { status: 400 });
  }

  const refusal = membershipGrantRefusal({
    actor,
    nextRole: role,
    nextPermissions: projectGrantedPermissions({
      role,
      overrides,
      customRolePermissions: customRole?.permissions ?? null,
    }),
    customRole,
    isSelf: false,
    isCreation: true,
    roleChanges: true,
    changesAccess: true,
  });
  if (refusal) {
    return NextResponse.json(
      { error: refusal, message: grantRefusalMessage(refusal) },
      { status: 403 },
    );
  }

  // Refused rather than ignored: silently dropping an unrecognised scope would
  // create the member on a policy the caller did not ask for.
  if (body.locationScope !== undefined && !isLocationScope(body.locationScope)) {
    return NextResponse.json({ error: "invalid_location_scope" }, { status: 400 });
  }
  /**
   * Issue #854 (P2.10): the branch-scope invariants, enforced on create as well
   * as on update. `selected` with nothing selected and `home` with no branch
   * both produce a membership whose access resolves to nothing — an "active"
   * member who cannot open a single screen.
   */
  if (body.locationScope === "selected" && (body.locationIds?.length ?? 0) === 0) {
    return NextResponse.json({ error: "selected_locations_required" }, { status: 400 });
  }
  if (body.locationScope === "home" && !body.defaultLocationId) {
    return NextResponse.json({ error: "home_location_required" }, { status: 400 });
  }

  let pin: string | null = null;
  if (isPinRole(role)) {
    pin = body.pin ? toLatinDigits(String(body.pin)) : "";
    if (!isValidPin(pin)) return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
    // PINs are bcrypt-hashed, so uniqueness can't be a constraint — it's
    // checked here, across the business (not, as before Phase 12, the world).
    if (await isPinTaken(session.businessId, pin)) {
      return NextResponse.json({ error: "pin_taken" }, { status: 409 });
    }
  }

  // Phase 42 — the login phone, optional but recommended: it is what every
  // member eventually signs in with. Stored unverified; the member proves it
  // with an OTP at their first door login.
  let phone: string | null = null;
  if (body.phone && String(body.phone).trim()) {
    phone = canonicalMemberPhone(body.phone);
    if (!phone) return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
    if (await isPhoneTaken(session.businessId, phone)) {
      return NextResponse.json({ error: "phone_taken" }, { status: 409 });
    }
  }

  try {
    const { userId } = await createMembership({
      businessId: session.businessId,
      role,
      fullName: body.fullName ?? "",
      email: body.email ?? null,
      password: body.password ?? null,
      pin,
      phoneE164: phone,
      locationIds: body.locationIds ?? [],
      defaultLocationId: body.defaultLocationId ?? null,
      locationScope: isLocationScope(body.locationScope) ? body.locationScope : undefined,
      overrides,
      customRoleId: body.customRoleId ?? null,
      actorId: session.sub,
      reason: body.reason,
    });
    // Every staff account is also a party of role `Employee` in the shared table —
    // the same record the payroll row and the personnel phone number come from, so
    // a wage or a shift note attached to a person never becomes a second person
    // (`src/lib/parties-scopes.ts`, scope `team`).
    //
    // Deliberately *after* `createMembership` returns and deliberately swallowed:
    // the membership is the account, the party is the file around it, and losing a
    // login because a display name was blank would be the worse failure by far. The
    // directory's own add form (or a later edit of this member) creates the row.
    try {
      const { ensureEmployeeParty } = await import("@/lib/parties-service");
      await ensureEmployeeParty(session.businessId, userId, {
        displayName: body.fullName?.trim() || null,
        email: body.email ?? null,
      });
    } catch {
      /* no party row yet — see the comment above */
    }
    return NextResponse.json({ id: userId }, { status: 201 });
  } catch (err) {
    if (err instanceof TeamError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
});
