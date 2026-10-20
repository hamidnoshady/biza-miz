/**
 * Phase 13 — teams & permissions: the framework-free half.
 *
 * Invitation tokens and the rules that stop a business locking itself out of
 * its own account. Both are pure and unit-tested (team.test.ts); everything
 * that touches the database lives in team-service.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Role } from "./auth-edge";
import {
  memberHasHistory,
  memberHistoryLabels,
  type MemberHistoryFlags,
} from "./member-history";
import { ALL_PERMISSIONS, isOwnerOnlyPermission, type PermissionOverrides } from "./permissions";

// ---------------------------------------------------------------------------
// Invitation tokens
// ---------------------------------------------------------------------------

/** How long an invitation stays usable. Long enough to be practical, short enough to expire. */
export const INVITATION_TTL_DAYS = 7;

/** Prefix makes a leaked token recognisable in a log or a paste. */
const TOKEN_PREFIX = "inv_";

/**
 * A new invitation token: the plaintext to hand to the invitee, and the hash
 * to store.
 *
 * Only the hash is persisted (migration 0022), so the plaintext is shown once
 * and is unrecoverable afterwards — the same rule the Phase 9 rollup tokens
 * follow. A database read can never yield a usable invitation.
 */
export function generateInvitationToken(): { token: string; tokenHash: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function invitationExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface InvitationState {
  expiresAt: Date | string;
  acceptedAt: Date | string | null;
  revokedAt: Date | string | null;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** Why an invitation can't be used, or "pending" when it can. */
export function invitationStatus(
  invitation: InvitationState,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt) return "accepted";
  if (invitation.revokedAt) return "revoked";
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return "expired";
  return "pending";
}

// ---------------------------------------------------------------------------
// Roles an owner may hand out
// ---------------------------------------------------------------------------

// The role taxonomy lives in `roles.ts` so that `"use client"` components can
// import it without dragging in this file's `node:crypto`. Re-exported here for
// the server callers that already read it from `team.ts` — the same
// arrangement made for `pin-policy.ts` below.
export {
  ALL_ROLES,
  ASSIGNABLE_ROLES,
  INVITABLE_ROLES,
  PASSWORD_ROLES,
  PIN_ROLES,
  isPasswordRole,
  isPinRole,
} from "./roles";

// ---------------------------------------------------------------------------
// Lockout guards
// ---------------------------------------------------------------------------

/**
 * A business's members, reduced to what the lockout rules need to know.
 * `id` is users.id — the membership, not the person.
 */
export interface MemberSummary {
  id: string;
  role: Role;
  isActive: boolean;
}

export type LockoutReason = "last_owner" | null;

/**
 * Whether a business would still have a way in after this change.
 *
 * Decision (Phase 13 Q2): a business may have **several owners**. That makes
 * this a counting rule rather than a "the owner is special" rule: the last
 * *active* owner cannot be demoted, suspended or removed, but any owner above
 * that floor can be.
 *
 * Without this, an owner could demote themselves to cashier and leave the
 * business with nobody able to manage the team, invite anyone, or undo it —
 * recoverable only by a developer with database access.
 */
export function checkLastOwner(
  members: MemberSummary[],
  targetId: string,
  change: { role?: Role; isActive?: boolean; remove?: boolean },
): LockoutReason {
  const target = members.find((m) => m.id === targetId);
  if (!target) return null;

  // Only changes that take an active owner *out* of the owner set can lock anyone out.
  const wasActiveOwner = target.role === "owner" && target.isActive;
  if (!wasActiveOwner) return null;

  const stillActiveOwner =
    !change.remove &&
    (change.role ?? target.role) === "owner" &&
    (change.isActive ?? target.isActive);
  if (stillActiveOwner) return null;

  const otherActiveOwners = members.filter(
    (m) => m.id !== targetId && m.role === "owner" && m.isActive,
  ).length;

  return otherActiveOwners === 0 ? "last_owner" : null;
}

/** Persian message for a lockout refusal. */
export function lockoutMessage(reason: Exclude<LockoutReason, null>): string {
  switch (reason) {
    case "last_owner":
      return "این تنها مالک فعال کسب‌وکار است؛ ابتدا مالک دیگری اضافه کنید.";
  }
}

// ---------------------------------------------------------------------------
// Hard membership removal (issue #1007)
// ---------------------------------------------------------------------------

/**
 * Why a hard delete («حذف عضو») was refused, or null when it may proceed.
 *
 * The issue's safety rules live here as one deterministic decision:
 *
 *  - **Never yourself.** The deletion is recorded with the actor in the audit
 *    trail (`audit_log.user_id`); deleting your own membership would orphan the
 *    very row being written to announce the delete — and an owner removing
 *    themselves is the shortest path to a business with no owner left who knew
 *    what happened. The screen hides the button on your own row; the server
 *    refuses it regardless.
 *  - **Never the last owner.** The same counting rule `checkLastOwner` applies
 *    to offboarding — a business may have several owners, but the last *active*
 *    one is the way back in and stays.
 *  - **Never a member with business history.** Orders, shifts, journal entries,
 *    payroll, audit references and a non-empty personnel file all attribute
 *    their work to the membership row; deleting it would orphan that
 *    attribution (every FK to `users` is ON DELETE SET NULL). Such a member is
 *    soft-removed instead («قطع همکاری» / بایگانی).
 */
export type HardDeleteRefusal = "self_delete" | "last_owner" | "has_history";

export interface HardDeleteCheck {
  /** The business's members, as `checkLastOwner` wants them. */
  members: MemberSummary[];
  targetId: string;
  /** Who is deleting; null for a system actor (no self rule to apply). */
  actorId: string | null;
  /** What the target has done in the business (issue #1007's eligibility gate). */
  history: MemberHistoryFlags;
}

/**
 * Whether a hard delete may proceed. Pure, so team.test.ts can pin the matrix
 * without a database; `deleteMembership` (team-service.ts) applies it twice —
 * once before the transaction for the error message, once inside it (against a
 * re-read of the history) so a racing order cannot slip a deletable member past
 * the gate.
 *
 * Order is deterministic for a stable error code: the actor's own row first
 * (`self_delete`, whatever else is true), then the business-lockout rule, then
 * history.
 */
export function hardDeleteRefusal(check: HardDeleteCheck): HardDeleteRefusal | null {
  if (check.actorId !== null && check.targetId === check.actorId) return "self_delete";
  if (checkLastOwner(check.members, check.targetId, { remove: true })) return "last_owner";
  if (memberHasHistory(check.history)) return "has_history";
  return null;
}

/** Persian sentence for a hard-delete refusal — the UI shows it as-is. */
export function hardDeleteRefusalMessage(
  refusal: HardDeleteRefusal,
  history: MemberHistoryFlags,
): string {
  switch (refusal) {
    case "self_delete":
      return "نمی‌توانید حساب کاربری خودتان را حذف کنید؛ برای پایان همکاری از «قطع همکاری» استفاده کنید.";
    case "last_owner":
      return lockoutMessage("last_owner");
    case "has_history": {
      // The labels name what was found; a refusal caught by a foreign key the
      // flags did not enumerate still deserves the plain sentence.
      const labels = memberHistoryLabels(history);
      const because = labels.length > 0 ? ` (${labels.join("، ")})` : "";
      return `این عضو سابقهٔ کاری دارد و قابل حذف نیست${because}. برای پایان همکاری از «قطع همکاری» استفاده کنید تا سوابق حفظ شوند.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Branch assignment
// ---------------------------------------------------------------------------

/**
 * What a membership's branch assignment becomes after validation — the pure
 * answer `resolveMemberLocations` (team-service.ts) reaches after reading the
 * business's locations out of the database.
 */
export interface MemberLocationAssignment {
  /** Deduplicated, order preserved; the default folded in when it was named. */
  locationIds: string[];
  defaultLocationId: string | null;
}

/**
 * The rule a branch-touching membership write obeys, given the ids that really
 * exist in this business.
 *
 * Branch ids arrive from a request body, so nothing downstream may trust them:
 * a foreign business's location id used to be stored as-is into
 * `user_locations`/`location_id` (RLS kept the *listing* honest, not the
 * write). Every such write validates here, and anything the business does not
 * own is refused — `null` is the refusal, `unknown_location` is what the
 * service reports.
 *
 * The rule for the default: it must be one of the branches being assigned (the
 * UI ticks it in the same list), so it is folded in rather than rejected — a
 * default outside the assignment is unreachable by `location-access.ts`, which
 * is a confusing state, not a dangerous one.
 *
 * Pure and framework-free: the DB half (which ids *are* ours) stays in
 * team-service.ts, and this half is what team.test.ts pins.
 */
export function resolveMemberLocationAssignment(
  knownLocationIds: Iterable<string>,
  locationIds: readonly string[] | undefined,
  defaultLocationId: string | null | undefined,
): MemberLocationAssignment | null {
  // Empty strings and duplicates are folded away before anything is compared.
  const asked = [...new Set((locationIds ?? []).filter(Boolean))];
  const hasDefault = Boolean(defaultLocationId);
  if (asked.length === 0 && !hasDefault) return { locationIds: [], defaultLocationId: null };

  const known = new Set(knownLocationIds);
  const ids = [...new Set([...asked, ...(defaultLocationId ? [defaultLocationId] : [])])];
  if (ids.some((id) => !known.has(id))) return null;

  // Preserve the caller's order (minus duplicates) with the default folded in,
  // so an audit diff and the UI's checkbox list agree.
  const ordered = asked.filter((id) => ids.includes(id));
  if (defaultLocationId && !ordered.includes(defaultLocationId)) ordered.push(defaultLocationId);
  return { locationIds: ordered, defaultLocationId: defaultLocationId ?? null };
}

// ---------------------------------------------------------------------------
// Permission override validation
// ---------------------------------------------------------------------------

/**
 * Cleans a permission-override payload coming from the team UI.
 *
 * Unknown keys are dropped rather than rejected — the catalogue changes
 * between releases and a stale browser tab shouldn't produce a 400. A key in
 * both lists is kept in both; `effectivePermissions` already resolves that
 * deterministically (revoke wins), so there is no ambiguity to reject.
 */
export function sanitizeOverrides(input: unknown): PermissionOverrides {
  const known = new Set<string>(ALL_PERMISSIONS.filter((permission) => !isOwnerOnlyPermission(permission)));
  const clean = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((v): v is string => typeof v === "string" && known.has(v)))].sort()
      : [];

  // Always the same shape, including for junk input, so callers never have to
  // distinguish "no overrides" from "unusable overrides".
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { granted: [], revoked: [] };
  }
  const raw = input as Record<string, unknown>;
  return { granted: clean(raw.granted), revoked: clean(raw.revoked) };
}

/** True when the overrides carry no actual adjustment (so it can be stored as {}). */
export function overridesAreEmpty(overrides: PermissionOverrides): boolean {
  return (overrides.granted?.length ?? 0) === 0 && (overrides.revoked?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

// The PIN policy lives in `pin-policy.ts` so client components can validate
// against the same rule the backend gates on without importing this file's
// `node:crypto`. Re-exported here for the server callers that already read it
// from `team.ts`.
export { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPin } from "./pin-policy";

// ---------------------------------------------------------------------------
// Privilege escalation
// ---------------------------------------------------------------------------

/** Why a membership edit that changes access was refused, or null when allowed. */
export type EscalationRefusal = "self_role_change" | "grants_beyond_actor";

export interface EscalationCheck {
  /** The editor's role as the database holds it. */
  actorRole: Role;
  /** The editor's own effective permissions. */
  actorPermissions: ReadonlySet<string>;
  /** True when the editor is editing their own membership row. */
  isSelf: boolean;
  /** What the target may do right now. */
  currentPermissions: ReadonlySet<string>;
  /** What the target would be able to do if this edit were applied. */
  nextPermissions: ReadonlySet<string>;
  /** Set only when the request actually changes the target's role. */
  roleChanges: boolean;
}

/**
 * Whether an edit that changes a member's access is an escalation, and so must
 * be refused.
 *
 * `team.permissions.manage` exists so that an owner can delegate day-to-day
 * access administration without handing over the business. Delegation is only
 * safe if the delegate cannot use it to out-rank the person who delegated it,
 * and two distinct moves would let them:
 *
 * 1. Granting a capability they do not hold themselves. A team administrator
 *    without `payments.refund` could tick it onto a colleague — or onto their
 *    own row — and the refund route would honour it, because the route asks
 *    only whether the *member* holds the key. So the permissions an edit
 *    *adds* must be a subset of what the editor already has. Only additions
 *    are tested: taking access away is never an escalation, and checking the
 *    whole resulting set instead would wrongly block a manager from adjusting
 *    an accountant whose preset contains `ledger.post` that the manager lacks.
 *
 * 2. Changing their own role. The permission delta alone does not catch this,
 *    because a handful of decisions are deliberately made on role *identity*
 *    rather than capability — the AI autonomous-approval routes and the
 *    first-run wizard among them (see JUSTIFIED_ROLE_CHECKS in
 *    authorization-contract.test.ts). Someone could move themselves to a role
 *    whose permission set is a subset of their current one and still cross one
 *    of those role-identity gates. Self-promotion is therefore refused
 *    outright rather than measured.
 *
 * An owner is exempt: they already hold everything, so neither move can gain
 * them anything, and the last-owner rule is what protects the business from
 * an owner demoting themselves.
 *
 * Pure, so team.test.ts can pin the matrix without a database.
 */
export function escalationRefusal(check: EscalationCheck): EscalationRefusal | null {
  if (check.actorRole === "owner") return null;

  if (check.isSelf && check.roleChanges) return "self_role_change";

  for (const permission of check.nextPermissions) {
    if (check.currentPermissions.has(permission)) continue;
    // A capability being added that the editor cannot exercise themselves.
    if (!check.actorPermissions.has(permission)) return "grants_beyond_actor";
  }
  return null;
}
