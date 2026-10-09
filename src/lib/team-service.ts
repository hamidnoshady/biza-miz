/**
 * Phase 13 — teams & permissions: the DB-touching half (not unit-tested
 * directly, per repo convention; the pure rules it enforces live in team.ts
 * and are covered by team.test.ts).
 *
 * This module is the ONLY place a membership is created. That matters: Phase
 * 12 moved the login identity into `platform_users`, and a member created
 * without one has a row in `users` and no way to sign in. Routing every
 * creation path — the setup wizard, the team screen, invitation acceptance —
 * through `createMembership` is what keeps that from happening again.
 */
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { BCRYPT_COST } from "@/lib/password-hashing";
import type { PoolClient } from "pg";
import { getPool, query, withoutTenantScope } from "./db";
import type { Role } from "./auth-edge";
import { appendIamEvent } from "./iam/service";
import { readDeploymentProfile } from "./deployment-mode";
import { restrictSiteMember } from "./iam/site-policy";
import {
  effectivePermissions,
  parseOverrides,
  type PermissionOverrides,
} from "./permissions";
import { activeMemberCount } from "./plan-limits";
import { resolveLimitCeiling } from "./entitlement-service";
import {
  checkLastOwner,
  generateInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  isPasswordRole,
  isPinRole,
  resolveMemberLocationAssignment,
  type InvitationStatus,
  type MemberSummary,
} from "./team";
import {
  issueDeliveredPasswordReset,
  revokeMembershipSessions,
  revokePlatformUserSessions,
  validatePasswordStrength,
} from "./password-reset";
import { pinBlindIndex } from "./otp-challenge";
import { loginCredentialModelForRole } from "./roles";
import {
  isSensitiveAccessChange,
  loadCustomRole,
  validateAccessChangeReason,
} from "./membership-authority";
import { lockMembership } from "./membership-lock";
import { maySelfServiceWrite } from "./credential-authority";

export class TeamError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Reading the team
// ---------------------------------------------------------------------------

export interface TeamMember {
  id: string;
  role: Role;
  customRoleId: string | null;
  customRoleName: string | null;
  fullName: string;
  email: string | null;
  isActive: boolean;
  status: "invited" | "active" | "suspended" | "locked" | "inactive" | "offboarded";
  locationScope: "all" | "selected" | "home" | "none";
  hasPin: boolean;
  /** Whether this membership can sign in with a password (has a global identity). */
  hasLogin: boolean;
  /**
   * Phase 42 — the member's login phone (E.164) and whether it has been
   * proven by an OTP yet. Unproven numbers show «تأیید‌نشده» in the team
   * screen and cannot be used for the direct phone login until the member
   * verifies them.
   */
  phone: string | null;
  phoneVerified: boolean;
  locationIds: string[];
  defaultLocationId: string | null;
  overrides: PermissionOverrides;
  effectivePermissions: string[];
  createdAt: string;
}

interface MemberRow extends Record<string, unknown> {
  id: string;
  role: Role;
  custom_role_id: string | null;
  custom_role_name: string | null;
  custom_role_permissions: string[] | null;
  full_name: string;
  email: string | null;
  is_active: boolean;
  membership_status: TeamMember["status"];
  location_scope: TeamMember["locationScope"];
  has_pin: boolean;
  has_login: boolean;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  default_location_id: string | null;
  permissions: unknown;
  location_ids: string[] | null;
  created_at: Date;
}

function toMember(row: MemberRow): TeamMember {
  const overrides = parseOverrides(row.permissions);
  return {
    id: row.id,
    role: row.role,
    customRoleId: row.custom_role_id,
    customRoleName: row.custom_role_name,
    fullName: row.full_name,
    email: row.email,
    isActive: row.is_active,
    status: row.membership_status,
    locationScope: row.location_scope,
    hasPin: row.has_pin,
    hasLogin: row.has_login,
    phone: row.phone_e164,
    phoneVerified: row.phone_verified_at !== null,
    locationIds: row.location_ids ?? [],
    defaultLocationId: row.default_location_id,
    overrides,
    effectivePermissions: [...effectivePermissions(row.role, overrides, row.custom_role_permissions)].sort(),
    createdAt: row.created_at.toISOString(),
  };
}

/** Every membership of the current business. RLS confines this to one tenant. */
export async function listMembers(businessId: string): Promise<TeamMember[]> {
  const { rows } = await query<MemberRow>(
    `SELECT u.id, u.role, u.custom_role_id, tr.name custom_role_name,
            CASE WHEN tr.is_active THEN ARRAY(SELECT jsonb_array_elements_text(tr.permissions)) END custom_role_permissions,
            u.full_name, u.email, u.is_active,
            u.membership_status, u.location_scope,
            (u.pin_hash IS NOT NULL OR EXISTS (
              SELECT 1 FROM employee_credentials ec
               WHERE ec.employee_id = u.id AND ec.business_id = u.business_id
                 AND ec.credential_type = 'pin' AND ec.status = 'active'
            )) AS has_pin,
            (u.platform_user_id IS NOT NULL) AS has_login,
            u.phone_e164, u.phone_verified_at,
            u.location_id AS default_location_id,
            u.permissions, u.created_at,
            coalesce(
              (SELECT array_agg(ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id),
              '{}'
            ) AS location_ids
       FROM users u
       LEFT JOIN tenant_roles tr ON tr.id=u.custom_role_id AND tr.business_id=u.business_id
      WHERE u.business_id = $1
      ORDER BY u.created_at`,
    [businessId],
  );
  return rows.map(toMember);
}

/** The reduced view the lockout rules need. */
async function memberSummaries(businessId: string): Promise<MemberSummary[]> {
  const { rows } = await query<{ id: string; role: Role; is_active: boolean }>(
    `SELECT id, role, is_active FROM users WHERE business_id = $1`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, role: r.role, isActive: r.is_active }));
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Anything that can run a statement — a pooled client inside a transaction, or
 * the pool itself for a standalone write.
 */
interface Executor {
  query: PoolClient["query"];
}

/**
 * Records a membership change. Every mutation in this module writes one, with
 * the actor, the target, and enough before/after to answer "who changed this".
 */
async function auditMembership(
  client: Executor,
  params: {
    businessId: string;
    actorId: string | null;
    action: string;
    targetUserId: string;
    before?: unknown;
    after?: unknown;
    /**
     * Issue #854 (P2.4) — the operator's justification, for changes that grant
     * or revoke access. Null for the administrative edits that carry none.
     */
    reason?: string | null;
    /** What changed about access, in the audit row's own words. */
    accessChange?: {
      role: { from: string; to: string | undefined } | null;
      customRoleId: { from: string | null; to: string | null } | null;
      permissionsChanged: boolean;
    } | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'user', $4, $5)`,
    [
      params.businessId,
      params.actorId,
      params.action,
      params.targetUserId,
      JSON.stringify({
        before: params.before ?? null,
        after: params.after ?? null,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.accessChange ? { accessChange: params.accessChange } : {}),
      }),
    ],
  );
}

/**
 * A stable string form of an override set, for "did this request actually change
 * anything" comparisons (issue #854 P2.4).
 *
 * Sorted, because the same grants in a different order are the same grants and
 * must not look like a change.
 */
function sortOverrides(overrides: PermissionOverrides): {
  granted: string[];
  revoked: string[];
} {
  return {
    granted: [...(overrides.granted ?? [])].sort(),
    revoked: [...(overrides.revoked ?? [])].sort(),
  };
}

// ---------------------------------------------------------------------------
// Creating a membership — the one path
// ---------------------------------------------------------------------------

export interface CreateMembershipInput {
  businessId: string;
  role: Role;
  fullName: string;
  /** Required for password roles; ignored for PIN roles. */
  email?: string | null;
  /** Required for a password role whose identity doesn't exist yet. */
  password?: string | null;
  /** Required for PIN roles. */
  pin?: string | null;
  /**
   * Phase 42 — the member's login phone, already canonicalised by the caller
   * (canonicalMemberPhone). Stored unverified: the member proves it with an
   * OTP at their first door login, or from the security center.
   */
  phoneE164?: string | null;
  locationIds?: string[];
  defaultLocationId?: string | null;
  locationScope?: "all" | "selected" | "home" | "none";
  overrides?: PermissionOverrides;
  /** Issue #854 (P0.1) — the custom role the creation assigns, if any. */
  customRoleId?: string | null;
  /** Issue #854 (P2.4) — why this membership is being created with this access. */
  reason?: string;
  actorId: string | null;
}

/**
 * Creates a membership, and the global identity behind it when the role signs
 * in with a password.
 *
 * If the email already belongs to the platform the existing identity is
 * *linked* rather than duplicated — that is how a person ends up a member of
 * two businesses, and it is why no password is needed in that case: they
 * already have one, and this doesn't change it.
 */
export async function createMembership(
  input: CreateMembershipInput,
): Promise<{ userId: string }> {
  const profile = (await readDeploymentProfile(input.businessId)).profile;
  if (profile === "hybrid") throw new TeamError("cloud_confirmation_required", 409);
  const eventOrigin = profile === "local" ? "local" : "cloud";
  const fullName = input.fullName.trim();
  const email = input.email?.trim().toLowerCase() || null;

  if (!fullName) throw new TeamError("missing_fields");

  if (isPasswordRole(input.role) && !email)
    throw new TeamError("email_required");
  if (isPinRole(input.role) && !input.pin) throw new TeamError("pin_required");

  // Override-aware member ceiling (entitlement-service): a business
  // exception (§25) raises or lowers the plan's own limit.
  const ceiling = await resolveLimitCeiling(input.businessId, "member_limit");
  if (
    ceiling.limit !== null &&
    (await activeMemberCount(input.businessId)) >= ceiling.limit
  ) {
    throw new TeamError("member_limit_exceeded", 403);
  }

  /**
   * Issue #854 (P2.4) — creating a member *is* granting access, and the reason
   * rule applies with the same logic the update path uses: a plain hire at a
   * preset role needs no prose, while handing the new account a custom role or
   * capability overrides is exactly the "who gave whom what, and why" the
   * requirement exists to answer.
   */
  const createGrantsExtraAccess =
    (input.customRoleId ?? null) !== null ||
    (input.overrides !== undefined && sortOverrides(input.overrides).granted.length > 0);
  let accessChangeReason: string | null = null;
  if (createGrantsExtraAccess) {
    const validated = validateAccessChangeReason(input.reason);
    if (!validated.ok) throw new TeamError(validated.error, 400);
    accessChangeReason = validated.reason;
  }

  // Issue #854 (GAP 7): the membership id is chosen up front so the shared
  // advisory lock can be taken before any door state is read or written —
  // creation participates in the same protocol as every other door change.
  const newMembershipId = randomUUID();

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMembership(client, input.businessId, newMembershipId);

    let platformUserId: string | null = null;
    if (isPasswordRole(input.role) && email) {
      // The identity lookup spans tenants by nature — the same person may
      // already be a member elsewhere — so it runs bypassed, briefly and
      // explicitly, on this same connection.
      await client.query("SELECT set_config('app.rls_bypass', 'on', true)");
      const { rows: existing } = await client.query<{ id: string }>(
        "SELECT id FROM platform_users WHERE email = $1",
        [email],
      );

      if (existing[0]) {
        platformUserId = existing[0].id;
      } else {
        if (!input.password || input.password.length < 8) {
          await client.query("ROLLBACK");
          throw new TeamError("weak_password");
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO platform_users (email, password_hash, full_name)
           VALUES ($1, $2, $3) RETURNING id`,
          [email, await bcrypt.hash(input.password, BCRYPT_COST), fullName],
        );
        platformUserId = rows[0].id;
      }
      await client.query("SELECT set_config('app.rls_bypass', '', true)");
      await client.query("SELECT set_config('app.business_id', $1, true)", [
        input.businessId,
      ]);

      const { rows: dup } = await client.query(
        "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
        [input.businessId, platformUserId],
      );
      if (dup.length > 0) {
        await client.query("ROLLBACK");
        throw new TeamError("already_a_member", 409);
      }
    }

    /**
     * Issue #854 (GAP 10) — the custom role's `default_location_scope` finally
     * means something. Until now the column was stored, replicated and shown,
     * but nothing read it at assignment time: a member created without an
     * explicit branch policy got the legacy fallback regardless of the role
     * they were wearing. The rule: when a creation names a custom role and no
     * branch policy, the role's default governs — except when it cannot be
     * honoured ("selected" with no branches, "home" with no home), which is a
     * refusal rather than a silent widening to "all".
     */
    let customRoleDefaultScope: "all" | "selected" | "home" | "none" | null = null;
    if (input.customRoleId) {
      const { rows: roleRows } = await client.query<{
        default_location_scope: "all" | "selected" | "home" | "none";
      }>(
        `SELECT default_location_scope
           FROM tenant_roles
          WHERE business_id = $1 AND id = $2 AND is_active`,
        [input.businessId, input.customRoleId],
      );
      if (!roleRows[0]) {
        await client.query("ROLLBACK");
        throw new TeamError("custom_role_not_found", 404);
      }
      customRoleDefaultScope = roleRows[0].default_location_scope;
    }
    const namesBranchPolicy =
      input.locationScope !== undefined ||
      (input.locationIds?.length ?? 0) > 0 ||
      Boolean(input.defaultLocationId);
    let effectiveLocationScope = input.locationScope ?? null;
    if (!namesBranchPolicy && customRoleDefaultScope && input.role !== "owner") {
      if (customRoleDefaultScope === "selected") {
        await client.query("ROLLBACK");
        throw new TeamError("selected_locations_required", 400);
      }
      if (customRoleDefaultScope === "home") {
        await client.query("ROLLBACK");
        throw new TeamError("home_location_required", 400);
      }
      effectiveLocationScope = customRoleDefaultScope;
    }

    const pinHash = input.pin ? await bcrypt.hash(input.pin, BCRYPT_COST) : null;
    /**
     * Issue #854 (P2.13): the keyed blind index that backs the unique PIN
     * constraint, written on the same statement as the credential itself.
     * Without it a concurrent `isPinTaken` check and insert can both pass;
     * with it the database refuses the second writer.
     */
    const pinIndex = input.pin ? await pinBlindIndex(input.businessId, input.pin) : null;

    // Branch ids come from a request body; nothing downstream re-checks they
    // belong to this business, so this is where a foreign id stops.
    const locations = await resolveMemberLocations(
      client,
      input.businessId,
      input.locationIds,
      input.defaultLocationId,
    );

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO users
         (id, business_id, platform_user_id, role, full_name, email, pin_hash,
          phone_e164, location_id, permissions, location_scope, custom_role_id)
       VALUES ($13, $1, $2, $3, $4, $5, $6, $7, $8, $9,
               CASE WHEN $3::user_role = 'owner'::user_role THEN 'all'::location_scope
                    WHEN $11::text IS NOT NULL THEN $11::location_scope
                    WHEN cardinality($10::uuid[]) > 0 THEN 'selected'::location_scope
                    WHEN $8::uuid IS NOT NULL THEN 'home'::location_scope
                    ELSE 'all'::location_scope END,
               $12) RETURNING id`,
      [
        input.businessId,
        platformUserId,
        input.role,
        fullName,
        email,
        // The PIN hash is written to `employee_credentials` below; the legacy
        // `users.pin_hash` column stays NULL so there is one source of truth.
        null,
        input.phoneE164 ?? null,
        locations.defaultLocationId,
        JSON.stringify(input.overrides ?? {}),
        locations.locationIds,
        effectiveLocationScope,
        input.customRoleId ?? null,
        newMembershipId,
      ],
    );
    const userId = created[0].id;

    // Site-local secrets belong to the revocable credential store. Keep the
    // legacy users.pin_hash column read-only so pre-migration rows can still
    // sign in without creating a second source of truth.
    if (pinHash) {
      await client.query(
        `INSERT INTO employees (id, business_id) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [userId, input.businessId],
      );
      /**
       * Issue #854 (P2.13): the unique index on
       * `(business_id, pin_blind_index)` is the real guarantee — `isPinTaken`
       * above answers the friendly case, and this answers the racing one. The
       * conflict must surface as the same `pin_taken` refusal every other PIN
       * surface produces, or the caller sees a raw Postgres error name instead
       * of a sentence about the PIN they just chose.
       */
      try {
        await client.query(
          `INSERT INTO employee_credentials
             (employee_id, business_id, credential_type, secret_hash, pin_blind_index)
           VALUES ($1, $2, 'pin', $3, $4)`,
          [userId, input.businessId, pinHash, pinIndex],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          await client.query("ROLLBACK");
          throw new TeamError("pin_taken", 409);
        }
        throw err;
      }
    }

    if (locations.locationIds.length > 0) {
      await client.query(
        "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
        [userId, locations.locationIds],
      );
    }

    await appendIamEvent(client, { businessId: input.businessId, type: "membership.created", entityId: userId,
      /**
       * Issue #854 — the payload must describe the row that was just written.
       *
       * `customRoleId` was hard-coded `null` here while the INSERT three dozen
       * lines above stored `input.customRoleId ?? null`. The event is not
       * decorative: `src/lib/iam/sync.ts` applies `membership.created` by
       * inserting `users` with `member.customRoleId` as `custom_role_id`, so
       * every membership replicated from the cloud to a Hybrid/Local site
       * arrived wearing the plain role preset — the custom role decided on the
       * cloud was silently narrowed on the site, and the two installs then
       * disagreed about what that member could do. A replica that grants less
       * than the cloud is a bug report; the reverse would be an incident.
       */
      payload: { membership: { id: userId, businessId: input.businessId, cloudIdentityRef: platformUserId,
        role: input.role, customRoleId: input.customRoleId ?? null, fullName, email, isActive: true, status: "active",
        overrides: input.overrides ?? {}, locationScope: input.role === "owner" ? "all" : (effectiveLocationScope ?? (locations.locationIds.length ? "selected" : locations.defaultLocationId ? "home" : "all")),
        defaultLocationId: locations.defaultLocationId, locationIds: locations.locationIds, revision: 1 }, revision: 1,
        // Issue #854 (P2.4) — the reason travels with the event so a Hybrid or
        // Local site applying this creation holds the same justification.
        reason: accessChangeReason },
      actorUserId: input.actorId, origin: eventOrigin });

    await auditMembership(client, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "team.member_created",
      targetUserId: userId,
      after: { role: input.role, fullName, email, isActive: true },
      reason: accessChangeReason,
      accessChange: {
        role: { from: "", to: input.role },
        customRoleId: { from: null, to: input.customRoleId ?? null },
        permissionsChanged: input.overrides !== undefined,
      },
    });

    await client.query("COMMIT");
    return { userId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Whether a 4-digit PIN is already in use within a business.
 *
 * PINs are bcrypt-hashed, so this can't be a unique index — every candidate
 * has to be compared against every active PIN in the business. Scoped to the
 * business (not, as before Phase 12, to the whole table).
 */
export async function isPinTaken(
  businessId: string,
  pin: string,
  exceptUserId?: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string; pin_hash: string }>(
    `SELECT u.id, coalesce(ec.secret_hash, u.pin_hash) AS pin_hash
       FROM users u
       LEFT JOIN LATERAL (
         SELECT secret_hash FROM employee_credentials
          WHERE employee_id = u.id AND business_id = u.business_id
            AND credential_type = 'pin' AND status = 'active'
          ORDER BY created_at DESC LIMIT 1
       ) ec ON true
      WHERE u.business_id = $1 AND u.is_active
        AND coalesce(ec.secret_hash, u.pin_hash) IS NOT NULL`,
    [businessId],
  );
  for (const row of rows) {
    if (row.id === exceptUserId) continue;
    if (await bcrypt.compare(pin, row.pin_hash)) return true;
  }
  return false;
}

/**
 * Phase 42 — whether a login phone is already another member's. Unlike the
 * PIN (bcrypt, so only comparable by trial), the phone is stored canonical,
 * so this is one indexed lookup. The unique index from migration 0139 backs
 * it up; this pre-check exists to answer *before* the write with a 409 the
 * UI can name, rather than surfacing a constraint violation.
 */
export async function isPhoneTaken(
  businessId: string,
  phoneE164: string,
  exceptUserId?: string,
): Promise<boolean> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users
      WHERE business_id = $1 AND phone_e164 = $2 AND id <> COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')`,
    [businessId, phoneE164, exceptUserId ?? null],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Updating a membership
// ---------------------------------------------------------------------------

export interface UpdateMembershipInput {
  businessId: string;
  userId: string;
  actorId: string | null;
  role?: Role;
  customRoleId?: string | null;
  fullName?: string;
  isActive?: boolean;
  overrides?: PermissionOverrides;
  locationIds?: string[];
  defaultLocationId?: string | null;
  locationScope?: "all" | "selected" | "home" | "none";
  /**
   * Issue #854 (P2.4) — why this access change is being made.
   *
   * Required (and validated here, not only in the route) whenever the write
   * changes the role, the custom role or a permission override. Stored on the
   * IAM event and the audit row together with the actor and the change, because
   * the audit trail's job is to answer "who gave whom what, and why" — and
   * "why" was the part no surface could answer.
   */
  reason?: string;
}

/**
 * Branch ids a write may attach to a membership — the DB half of the rule in
 * `resolveMemberLocationAssignment` (team.ts): read the business's locations,
 * hand the known ids to the pure validator, and translate its refusal into the
 * `unknown_location` the API reports.
 *
 * The ids arrive from a request body, and until now nothing checked they
 * belonged to *this* business: an owner (or anyone holding `team.manage`) could
 * name another business's location id and have it stored as the member's
 * assignment. RLS kept the *listing* honest, but `user_locations` rows were
 * written under the acting business's scope with a foreign id — garbage at best,
 * a cross-tenant reference at worst. Every branch-touching write now goes
 * through here, on the same connection as the write it feeds.
 */
async function resolveMemberLocations(
  client: Executor,
  businessId: string,
  locationIds: readonly string[] | undefined,
  defaultLocationId: string | null | undefined,
): Promise<{ locationIds: string[]; defaultLocationId: string | null }> {
  const asked = [...new Set((locationIds ?? []).filter(Boolean))];
  const hasDefault = Boolean(defaultLocationId);
  if (asked.length === 0 && !hasDefault) return { locationIds: [], defaultLocationId: null };

  const ids = [...new Set([...asked, ...(defaultLocationId ? [defaultLocationId] : [])])];
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[])",
    [businessId, ids],
  );
  const resolved = resolveMemberLocationAssignment(
    rows.map((row) => row.id),
    locationIds,
    defaultLocationId,
  );
  if (!resolved) throw new TeamError("unknown_location", 400);
  return resolved;
}


/**
 * Issue #854 (P1.12) — a role transition must not strand the membership.
 *
 * Roles split into two credential models (`loginCredentialModelForRole`): a
 * password role signs in with the global identity behind the tenant login
 * screen, a PIN role signs in at the staff door. Moving a member between the two
 * *changes which door exists for them*, and until this check the transition
 * committed regardless — a cashier moved to manager kept `platform_user_id =
 * null` and had no way in, and a manager moved to cashier had the login screen
 * and no PIN.
 *
 * The rule is a refusal, not a repair: provisioning a password identity or a PIN
 * on the administrator's behalf is a credential the member never chose, and the
 * screens already offer both (invite/recover for a password identity, the
 * credential reset for a PIN). So a transition that would leave an **active**
 * membership without its door says which door is missing and stops. Suspended
 * memberships move freely — nobody signs in with them — and reactivation is
 * checked, because that is the moment the door is needed again.
 *
 * It runs on the caller's connection, inside the same transaction as the write:
 * a credential revoked between the check and the commit cannot slip past, and a
 * refused transition leaves nothing half-applied.
 */
async function assertRoleTransitionKeepsLoginPath(
  client: PoolClient,
  input: {
    businessId: string;
    userId: string;
    fromRole: Role;
    toRole: Role;
    /** Whether the membership was active *before* this write. */
    priorActive: boolean;
    willBeActive: boolean;
  },
): Promise<void> {
  if (!input.willBeActive) return;
  const from = loginCredentialModelForRole(input.fromRole);
  const to = loginCredentialModelForRole(input.toRole);
  /**
   * Two ways to arrive at "active membership, credential model X, credential
   * missing": changing into X, and reactivating a membership that is already X.
   * The second one is why this is not simply `from !== to` — a suspended cashier
   * whose PIN was stripped must not become an active cashier without one either.
   */
  const changesModel = from !== to;
  const activates = input.priorActive === false;
  if (!changesModel && !activates) return;

  if (to === "password") {
    const { rows } = await client.query<{
      platform_user_id: string | null;
      is_active: boolean | null;
      password_hash: string | null;
    }>(
      `SELECT u.platform_user_id, p.is_active, p.password_hash
         FROM users u
         LEFT JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1 AND u.business_id = $2`,
      [input.userId, input.businessId],
    );
    const row = rows[0];
    // No linked identity at all: the member has no username to sign in with.
    if (!row?.platform_user_id) throw new TeamError("identity_required", 409);
    if (row.is_active === false || row.is_active === null) {
      throw new TeamError("identity_inactive", 409);
    }
    if (!row.password_hash) throw new TeamError("password_not_set", 409);
    return;
  }

  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2
        AND credential_type = 'pin' AND status = 'active'
      LIMIT 1`,
    [input.userId, input.businessId],
  );
  if (!rows[0]) throw new TeamError("pin_required", 409);
}

export async function updateMembership(
  input: UpdateMembershipInput,
): Promise<void> {
  const profile = (await readDeploymentProfile(input.businessId)).profile;
  if (profile === "hybrid") {
    const attemptsExpansion = input.role !== undefined || input.customRoleId !== undefined || input.fullName !== undefined || input.isActive === true ||
      (input.overrides?.granted?.length ?? 0) > 0 || input.locationScope === "all";
    if (attemptsExpansion) throw new TeamError("cloud_confirmation_required", 409);
    await restrictSiteMember({ businessId: input.businessId, userId: input.userId, actorId: input.actorId ?? input.userId,
      permissionDenies: input.overrides?.revoked, allowedLocationIds: input.locationIds,
      isLocallySuspended: input.isActive === false, reason: "team_screen_site_restriction" });
    return;
  }
  const eventOrigin = profile === "local" ? "local" : "cloud";
  const members = await memberSummaries(input.businessId);
  const target = members.find((m) => m.id === input.userId);
  if (!target) throw new TeamError("not_found", 404);



  const lockout = checkLastOwner(members, input.userId, {
    role: input.role,
    isActive: input.isActive,
  });
  if (lockout) throw new TeamError(lockout, 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Issue #854: every door-touching decision for this membership goes through
    // one advisory lock, so the login-path assertion below and the credential
    // writes it reads cannot interleave (see src/lib/membership-lock.ts).
    await lockMembership(client, input.businessId, input.userId);
    if (input.customRoleId) {
      const role = await client.query(`SELECT 1 FROM tenant_roles WHERE business_id=$1 AND id=$2 AND is_active`, [input.businessId,input.customRoleId]);
      if (!role.rowCount) throw new TeamError("custom_role_not_found",404);
    }

    const { rows: beforeRows } = await client.query(
      `SELECT role, full_name, email, is_active, permissions, location_id, custom_role_id
         FROM users WHERE id = $1 AND business_id = $2`,
      [input.userId, input.businessId],
    );
    const before = beforeRows[0];
    if (!before) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }

    /**
     * Issue #854 (P2.4) — the reason rule, enforced on the write.
     *
     * Applied here rather than in the route for the same reason the escalation
     * rule is: an invariant that only one route checks is an invariant the next
     * route forgets. The service is the only place a membership changes, so this
     * is the only place the requirement can be guaranteed.
     *
     * "Sensitive" means the write actually *changes* the role, the custom role
     * or a permission override — not merely that the body mentions one. The
     * comparison is against the row as the database holds it, read on this
     * transaction's connection, so a form that re-submits an unchanged role
     * while renaming somebody is an administrative edit and needs no prose;
     * demanding a justification for those is how a required reason becomes
     * ritual filler.
     */
    const changesRole = input.role !== undefined && input.role !== before.role;
    const changesCustomRole =
      input.customRoleId !== undefined &&
      (input.customRoleId ?? null) !== ((before.custom_role_id as string | null) ?? null);
    const changesPermissions =
      input.overrides !== undefined &&
      JSON.stringify(sortOverrides(input.overrides)) !==
        JSON.stringify(sortOverrides(parseOverrides(before.permissions)));
    let accessChangeReason: string | null = null;
    if (isSensitiveAccessChange({ changesRole, changesCustomRole, changesPermissions })) {
      const validated = validateAccessChangeReason(input.reason);
      if (!validated.ok) {
        await client.query("ROLLBACK");
        throw new TeamError(validated.error, 400);
      }
      accessChangeReason = validated.reason;
    }

    /**
     * Issue #854 (P1.12) — decide the credential lifecycle *before* committing
     * the role, on this connection and inside this transaction. See the helper's
     * comment for why this is a refusal rather than an automatic provisioning.
     */
    const nextRole = input.role ?? (before.role as Role);
    const nextActive = input.isActive ?? before.is_active === true;
    if (input.role !== undefined || input.isActive === true) {
      await assertRoleTransitionKeepsLoginPath(client, {
        businessId: input.businessId,
        userId: input.userId,
        fromRole: before.role as Role,
        toRole: nextRole,
        priorActive: before.is_active === true,
        willBeActive: nextActive,
      });
    }

    // Branch ids arrive from a request body: validate them here, on the same
    // connection as the write, before they reach `user_locations`/`location_id`.
    // The three shapes keep their own semantics — a full assignment replaces,
    // a default alone only moves the home branch, and neither named leaves
    // both alone — but every id that is stored has been proven ours.
    let locationIds: string[] | null = null;
    let defaultLocationId: string | null | undefined = undefined;
    if (input.locationIds !== undefined && input.defaultLocationId !== undefined) {
      const resolved = await resolveMemberLocations(
        client,
        input.businessId,
        input.locationIds,
        input.defaultLocationId,
      );
      locationIds = resolved.locationIds;
      defaultLocationId = resolved.defaultLocationId;
    } else if (input.locationIds !== undefined) {
      locationIds = (
        await resolveMemberLocations(client, input.businessId, input.locationIds, null)
      ).locationIds;
    } else if (input.defaultLocationId !== undefined) {
      defaultLocationId = (
        await resolveMemberLocations(client, input.businessId, [], input.defaultLocationId)
      ).defaultLocationId;
    }

    await client.query(
      `UPDATE users
          SET role        = coalesce($3, role),
              full_name   = coalesce($4, full_name),
              is_active   = coalesce($5, is_active),
              membership_status = CASE WHEN $5::boolean IS TRUE THEN 'active'::membership_status
                                       WHEN $5::boolean IS FALSE THEN 'suspended'::membership_status
                                       ELSE membership_status END,
              permissions = coalesce($6, permissions),
              custom_role_id = CASE WHEN $12::boolean THEN $13::uuid ELSE custom_role_id END,
              location_id = CASE WHEN $7::boolean THEN $8::uuid ELSE location_id END,
              location_scope = CASE
                WHEN coalesce($3::user_role, role) = 'owner'::user_role THEN 'all'::location_scope
                WHEN $11::text IS NOT NULL THEN $11::location_scope
                WHEN $9::boolean THEN CASE WHEN cardinality($10::uuid[]) > 0
                                           THEN 'selected'::location_scope
                                           WHEN coalesce($8::uuid, location_id) IS NOT NULL
                                           THEN 'home'::location_scope
                                           ELSE 'all'::location_scope END
                ELSE location_scope END,
              membership_revision = membership_revision + 1,
              updated_at  = now()
        WHERE id = $1 AND business_id = $2`,
      [
        input.userId,
        input.businessId,
        input.role ?? null,
        input.fullName?.trim() ?? null,
        input.isActive ?? null,
        input.overrides ? JSON.stringify(input.overrides) : null,
        defaultLocationId !== undefined,
        defaultLocationId ?? null,
        locationIds !== null,
        locationIds ?? [],
        input.locationScope ?? null,
        input.customRoleId !== undefined,
        input.customRoleId ?? null,
      ],
    );

    if (locationIds !== null) {
      await client.query("DELETE FROM user_locations WHERE user_id = $1", [
        input.userId,
      ]);
      if (locationIds.length > 0) {
        await client.query(
          "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
          [input.userId, locationIds],
        );
      }
    }

    const { rows: afterRows } = await client.query(
      `SELECT role, full_name, email, is_active, permissions, location_id, membership_revision
         FROM users WHERE id = $1`,
      [input.userId],
    );

    const eventType = input.role !== undefined ? "membership.system_role_changed"
      : input.customRoleId !== undefined ? "membership.custom_role_changed"
      : input.overrides !== undefined ? "membership.permissions_changed"
      : input.locationIds !== undefined ? "membership.locations_changed"
      : input.locationScope !== undefined || input.defaultLocationId !== undefined ? "membership.location_policy_changed"
      : input.isActive === false ? "membership.suspended"
      : input.isActive === true ? "membership.reactivated" : "membership.profile_updated";
    await appendIamEvent(client, { businessId: input.businessId, type: eventType, entityId: input.userId,
      payload: {
        revision: Number((afterRows[0] as { membership_revision?: string })?.membership_revision ?? 1),
        changes: input,
        /**
         * Issue #854 (P2.4) — the reason travels with the event, not only with
         * the audit row. A Hybrid/Local site applies these events, and the
         * person reviewing *that* install's access history needs the same
         * sentence the cloud holds.
         */
        reason: accessChangeReason,
      },
      actorUserId: input.actorId, origin: eventOrigin });

    await auditMembership(client, {
      businessId: input.businessId,
      actorId: input.actorId,
      action: "team.member_updated",
      targetUserId: input.userId,
      before,
      after: afterRows[0],
      // Issue #854 (P2.4): actor + change + reason in one row.
      reason: accessChangeReason,
      accessChange: {
        role: changesRole ? { from: before.role as string, to: input.role } : null,
        customRoleId: changesCustomRole
          ? {
              from: (before.custom_role_id as string | null) ?? null,
              to: input.customRoleId ?? null,
            }
          : null,
        permissionsChanged: changesPermissions,
      },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Removes a membership.
 *
 * Decision (Phase 13 Q3): historical rows stay attributed. Every foreign key
 * to `users` is ON DELETE SET NULL, so deleting would silently orphan "who
 * opened this order" across the ledger and the audit trail. A removed member
 * is deactivated and stripped of credentials instead — they can no longer sign
 * in by any route, while the history stays readable.
 *
 * Phase 20 Wave 2: also revokes any active `employee_credentials`/
 * `employee_sessions` rows, the same deactivation the `pin_hash`/
 * `password_hash` strip below already does for the pre-Phase-20 credential
 * columns. Landing this alongside Wave 2's login wiring (rather than in
 * Wave 1, which only added the tables) is deliberate — see the phase doc's
 * "Open questions for Wave 2": before pin-login mints sessions, a removed
 * member's still-`active` row here was inert, so revoking it earlier would
 * have bought nothing.
 */
export async function removeMembership(
  businessId: string,
  userId: string,
  actorId: string | null,
): Promise<void> {
  const profile = (await readDeploymentProfile(businessId)).profile;
  if (profile === "hybrid") {
    await restrictSiteMember({ businessId, userId, actorId: actorId ?? userId, isLocallySuspended: true,
      localLoginLocked: true, reason: "local_offboarding_request" });
    return;
  }
  const eventOrigin = profile === "local" ? "local" : "cloud";
  const members = await memberSummaries(businessId);
  if (!members.some((m) => m.id === userId))
    throw new TeamError("not_found", 404);

  const lockout = checkLastOwner(members, userId, { remove: true });
  if (lockout) throw new TeamError(lockout, 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMembership(client, businessId, userId);
    const { rows: before } = await client.query(
      "SELECT role, full_name, email, is_active FROM users WHERE id = $1 AND business_id = $2",
      [userId, businessId],
    );
    if (!before[0]) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }

    const { rows: removedRows } = await client.query<{ membership_revision: string }>(
      `UPDATE users
          SET is_active = false, membership_status = 'offboarded',
              location_scope = 'none', pin_hash = NULL, password_hash = NULL,
              platform_user_id = NULL, membership_revision = membership_revision + 1, updated_at = now()
        WHERE id = $1 AND business_id = $2 RETURNING membership_revision`,
      [userId, businessId],
    );
    await client.query("DELETE FROM user_locations WHERE user_id = $1", [
      userId,
    ]);
    await client.query(
      `UPDATE employee_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND status = 'active'`,
      [userId, businessId],
    );
    await client.query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
      [userId, businessId],
    );
    // Phase 20 Wave 5 — a removed member's shift (if left open) would
    // otherwise stay open forever now that nothing else about their access
    // is still live.
    await client.query(
      `UPDATE employee_shifts
          SET ended_at = now(), closed_by = $3
        WHERE employee_id = $1 AND business_id = $2 AND ended_at IS NULL`,
      [userId, businessId, actorId],
    );

    await appendIamEvent(client, { businessId, type: "membership.offboarded", entityId: userId,
      payload: { status: "offboarded", revision: Number(removedRows[0].membership_revision) }, actorUserId: actorId, origin: eventOrigin });

    await auditMembership(client, {
      businessId,
      actorId,
      action: "team.member_removed",
      targetUserId: userId,
      before: before[0],
      after: { isActive: false, credentialsRevoked: true },
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Sets a member's PIN (owner action) or their own (self-service). */
export async function setPin(
  businessId: string,
  userId: string,
  pin: string,
  actorId: string | null,
  /**
   * Issue #854 (P1.7): the proof the caller offered when rotating a PIN they
   * already own. An *administrator* reset does not need it (that is the point
   * of an admin reset — a member who forgot their PIN has no proof to give),
   * but a self-service rotation must show the current PIN, so holding an
   * unlocked terminal is not enough to take the credential over. `null` means
   * "this caller is not rotating their own PIN"; `undefined` means "self-service
   * without proof", which is refused before any write.
   */
  options: { selfService?: boolean; currentPinVerified?: boolean } = {},
): Promise<void> {
  const profile = (await readDeploymentProfile(businessId)).profile;
  const eventOrigin = profile === "cloud" ? "cloud" : "local";

  /**
   * Issue #854 (P1.14): a Hybrid site may apply and remove *replicated* PIN
   * state, but a PIN it originates is a credential the cloud never sees. The
   * shared authority table is the one place that decides this.
   */
  if (options.selfService && !maySelfServiceWrite(profile, "staff_pin")) {
    throw new TeamError("login_managed_by_cloud", 409);
  }
  if (options.selfService && options.currentPinVerified !== true) {
    throw new TeamError("current_pin_required", 403);
  }

  if (await isPinTaken(businessId, pin, userId)) throw new TeamError("pin_taken", 409);

  const pinHash = await bcrypt.hash(pin, BCRYPT_COST);
  const blindIndex = await pinBlindIndex(businessId, pin);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Same protocol as the role-transition check: a PIN write and a door
    // decision for this membership must not run at the same time.
    await lockMembership(client, businessId, userId);
    const member = await client.query(
      "SELECT 1 FROM users WHERE id = $1 AND business_id = $2 FOR UPDATE",
      [userId, businessId],
    );
    if (!member.rowCount) throw new TeamError("not_found", 404);
    await client.query(
      `INSERT INTO employees (id, business_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [userId, businessId],
    );
    await client.query(
      `UPDATE employee_credentials
          SET status = 'revoked', revoked_at = now(), pin_blind_index = NULL
        WHERE employee_id = $1 AND business_id = $2
          AND credential_type = 'pin' AND status = 'active'`,
      [userId, businessId],
    );
    /**
     * The unique index on `(business_id, pin_blind_index)` is the real
     * guarantee (issue #854 P2.13): `isPinTaken` above answers the friendly
     * case, and this answers the racing one. A conflict is translated to the
     * same `pin_taken` refusal the pre-check produces, so the caller sees one
     * answer whichever path caught it.
     */
    try {
      await client.query(
        `INSERT INTO employee_credentials
           (employee_id, business_id, credential_type, secret_hash, pin_blind_index)
         VALUES ($1, $2, 'pin', $3, $4)`,
        [userId, businessId, pinHash, blindIndex],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        await client.query("ROLLBACK");
        throw new TeamError("pin_taken", 409);
      }
      throw err;
    }
    // Once a canonical PIN exists, erase any compatibility copy.
    await client.query(
      "UPDATE users SET pin_hash = NULL, updated_at = now() WHERE id = $1 AND business_id = $2",
      [userId, businessId],
    );
    if (profile !== "hybrid") {
      await appendIamEvent(client, { businessId, type: "credential.rotated", entityId: userId,
        payload: { credentialType: "pin" }, actorUserId: actorId, origin: eventOrigin });
    }
    await auditMembership(client, {
      businessId,
      actorId,
      action: options.selfService ? "team.self_pin_changed" : "team.pin_changed",
      targetUserId: userId,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 42 — an owner/manager sets (or clears) a member's login phone.
 *
 * The number is stored *unverified* — an owner typing a number proves
 * nothing about who holds it — so a change always clears `phone_verified_at`
 * and the member re-proves possession with an OTP at their next door login
 * (or from the security center). A member changing their *own* number
 * verifies it in the same breath through `/api/auth/phone/self`; this path
 * is the force-set for somebody else's row, which is exactly why it cannot
 * hand out verification.
 */
export async function setMemberPhone(
  businessId: string,
  userId: string,
  phoneE164: string | null,
  actorId: string | null,
): Promise<void> {
  if (phoneE164 && (await isPhoneTaken(businessId, phoneE164, userId))) {
    throw new TeamError("phone_taken", 409);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE users
          SET phone_e164 = $3,
              phone_verified_at = NULL,
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [userId, businessId, phoneE164],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      throw new TeamError("not_found", 404);
    }
    await auditMembership(client, {
      businessId,
      actorId,
      action: "team.phone_changed",
      targetUserId: userId,
      after: { phone: phoneE164 },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Changes the password on the identity behind a membership (self-service only).
 *
 * Per Issue #809 (Findings 2 & 3):
 *   1. A tenant administrator in Business A must NEVER directly overwrite the
 *      global `platform_users` password of another user (`actorId !== userId`),
 *      because `platform_users` is shared across businesses. Admin recovery for
 *      another user goes through `requestMemberPasswordReset` instead.
 *   2. Changing a password atomically increments `platform_users.token_version`
 *      and revokes existing sessions/impersonations so stolen or stale tokens
 *      stop working immediately.
 */
export async function setPassword(
  businessId: string,
  userId: string,
  newPassword: string,
  actorId: string | null,
  options: { keepEmployeeSessionId?: string | null } = {},
): Promise<{ tokenVersion: number }> {
  if (!actorId || actorId !== userId) {
    throw new TeamError("cross_user_password_reset_forbidden", 403);
  }
  const strength = validatePasswordStrength(newPassword);
  if (!strength.ok) throw new TeamError("weak_password", 400);

  const { rows } = await query<{ platform_user_id: string | null }>(
    "SELECT platform_user_id FROM users WHERE id = $1 AND business_id = $2",
    [userId, businessId],
  );
  const platformUserId = rows[0]?.platform_user_id;
  if (!rows[0]) throw new TeamError("not_found", 404);
  if (!platformUserId) throw new TeamError("no_login", 409);

  const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
  let tokenVersion = 2;
  await withoutTenantScope("identity", async () => {
    const updated = await query<{ token_version: number }>(
      `UPDATE platform_users
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING token_version`,
      [platformUserId, hash],
    );
    tokenVersion = updated.rows[0]?.token_version ?? 2;
  });

  await revokePlatformUserSessions(platformUserId, {
    bumpTokenVersion: false,
    keepEmployeeSessionId: options.keepEmployeeSessionId ?? null,
    endImpersonation: true,
  });

  await auditMembership(getPool(), {
    businessId,
    actorId,
    action: "team.password_changed",
    targetUserId: userId,
  });

  return { tokenVersion };
}

/**
 * Issues a single-use, user-controlled password reset token for a team member
 * (Issue #809 — Finding 2).
 *
 * Replaces direct cross-user password overwrite: the tenant administrator can
 * trigger recovery, but only the account holder chooses the new password.
 */
export async function requestMemberPasswordReset(
  businessId: string,
  userId: string,
  actorId: string | null,
  options: { origin: string },
): Promise<{
  /** Where the recovery credential was sent. Masked — never the number itself. */
  deliveredTo: string;
  channel: "sms";
  expiresAt: string;
  email: string;
}> {
  const { rows } = await query<{
    platform_user_id: string | null;
    email: string | null;
    phone_e164: string | null;
    phone_verified_at: Date | null;
  }>(
    `SELECT platform_user_id, email::text AS email, phone_e164, phone_verified_at
       FROM users
      WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  const member = rows[0];
  if (!member) throw new TeamError("not_found", 404);
  if (!member.platform_user_id) throw new TeamError("no_login", 409);

  let email = member.email;
  if (!email) {
    email = await withoutTenantScope("identity", async () => {
      const p = await query<{ email: string }>(
        `SELECT email::text AS email FROM platform_users WHERE id = $1`,
        [member.platform_user_id],
      );
      return p.rows[0]?.email ?? null;
    });
  }
  if (!email) throw new TeamError("no_login", 409);

  /**
   * Issue #854 (P0.3) — the delivery channel.
   *
   * The reset token is a credential that changes the shared
   * `platform_users` password, so it may only travel to the **account holder**.
   * There is no mail transport in this system, which leaves the one channel the
   * holder and nobody else reads: a **verified** phone number. The verified
   * number may live on any of their memberships (they might be a cashier here
   * and the accountant there), so the search spans the identity — but a number
   * that has merely been *typed by an administrator* does not count, because
   * possession of it was never proven.
   *
   * When there is no verified number anywhere, the recovery is refused. The
   * tempting fallback — return the link to the administrator who asked — is
   * exactly the takeover this finding describes, so it is not available.
   */
  const verifiedPhone =
    member.phone_e164 && member.phone_verified_at ? member.phone_e164 : null;
  const phoneFromOtherMembership = verifiedPhone
    ? null
    : await withoutTenantScope("identity", async () => {
        const { rows: phones } = await query<{ phone_e164: string }>(
          `SELECT u.phone_e164
             FROM users u
            WHERE u.platform_user_id = $1
              AND u.phone_e164 IS NOT NULL
              AND u.phone_verified_at IS NOT NULL
              AND u.is_active = true
            ORDER BY (u.business_id = $2) DESC, u.phone_verified_at DESC
            LIMIT 1`,
          [member.platform_user_id, businessId],
        );
        return phones[0]?.phone_e164 ?? null;
      });

  const deliveryPhone = verifiedPhone ?? phoneFromOtherMembership;
  if (!deliveryPhone) throw new TeamError("no_verified_channel", 409);

  const delivered = await issueDeliveredPasswordReset({
    subjectRealm: "platform_user",
    subjectId: member.platform_user_id,
    email,
    membershipId: userId,
    createdById: actorId,
    phoneE164: deliveryPhone,
    origin: options.origin,
  });

  await auditMembership(getPool(), {
    businessId,
    actorId,
    action: "team.password_reset_requested",
    targetUserId: userId,
    // The delivery target is masked and the token is absent, by construction.
    after: {
      email,
      channel: "sms",
      deliveredTo: delivered.maskedPhone,
      expiresAt: delivered.expiresAt.toISOString(),
    },
  });

  return {
    deliveredTo: delivered.maskedPhone,
    channel: "sms",
    expiresAt: delivered.expiresAt.toISOString(),
    email,
  };
}

/**
 * Revokes all active tenant sessions (`employee_sessions`) and support
 * impersonation grants for a member within `businessId`.
 */
export async function revokeMemberTenantSessions(
  businessId: string,
  userId: string,
  actorId: string | null,
): Promise<{ revokedCount: number }> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  if (!rows[0]) throw new TeamError("not_found", 404);

  const revokedCount = await revokeMembershipSessions(businessId, userId);

  await auditMembership(getPool(), {
    businessId,
    actorId,
    action: "team.sessions_revoked",
    targetUserId: userId,
    after: { revokedCount },
  });

  return { revokedCount };
}

/** Verifies a person's current password — required before they change it themselves. */
export async function verifyPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  return withoutTenantScope("login", async () => {
    const { rows } = await query<{ password_hash: string }>(
      `SELECT p.password_hash FROM users u
         JOIN platform_users p ON p.id = u.platform_user_id
        WHERE u.id = $1`,
      [userId],
    );
    if (!rows[0]) return false;
    return bcrypt.compare(password, rows[0].password_hash);
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  /**
   * Issue #854 (P2.11/P2.12) — what the invitation will actually grant. Null
   * scope/inactive role means the pre-0211 reading (the membership's own
   * defaults), which is why the UI renders them only when present.
   */
  locationScope?: "all" | "selected" | "home" | "none" | null;
  defaultLocationId?: string | null;
  customRoleId?: string | null;
  customRoleName?: string | null;
}

export async function listInvitations(
  businessId: string,
): Promise<InvitationSummary[]> {
  const { rows } = await query<{
    id: string;
    email: string;
    role: Role;
    full_name: string;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
    location_scope: InvitationSummary["locationScope"];
    default_location_id: string | null;
    custom_role_id: string | null;
    custom_role_name: string | null;
  }>(
    /**
     * Issue #854 (P2.11/P2.12): the invitation carries a branch policy and a
     * custom role now, and a list that hides them invites the reader to assume
     * the invitee will land with the defaults. The join is `LEFT` because both
     * columns are nullable — a plain invite has neither.
     */
    `SELECT i.id, i.email::text AS email, i.role, i.full_name, i.expires_at,
            i.accepted_at, i.revoked_at, i.created_at,
            i.location_scope, i.default_location_id, i.custom_role_id,
            r.name AS custom_role_name
       FROM invitations i
       LEFT JOIN tenant_roles r ON r.id = i.custom_role_id
      WHERE i.business_id = $1
      ORDER BY i.created_at DESC`,
    [businessId],
  );

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    fullName: r.full_name,
    status: invitationStatus({
      expiresAt: r.expires_at,
      acceptedAt: r.accepted_at,
      revokedAt: r.revoked_at,
    }),
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    locationScope: r.location_scope,
    defaultLocationId: r.default_location_id,
    customRoleId: r.custom_role_id,
    customRoleName: r.custom_role_name,
  }));
}

export interface CreateInvitationInput {
  businessId: string;
  email: string;
  role: Role;
  fullName: string;
  overrides?: PermissionOverrides;
  locationIds?: string[];
  /** Explicit branch policy (#854 P2.11) — see `resolveMemberLocations`. */
  locationScope?: "all" | "selected" | "home" | "none" | null;
  defaultLocationId?: string | null;
  /** Issue #854 (P0.2) — the custom role the eventual membership will wear. */
  customRoleId?: string | null;
  /**
   * Issue #854 (P2.4) — why the eventual membership gets this access. Required
   * when the invitation grants extra access (custom role or granted overrides);
   * validated here and stored, so the acceptance audit carries the original
   * justification instead of inventing one at the door.
   */
  reason?: string;
  actorId: string | null;
}

/**
 * Creates an invitation and returns the one-time token.
 *
 * Re-inviting an address supersedes any invitation still pending for it — the
 * partial unique index in migration 0022 would otherwise reject the insert,
 * and leaving several live tokens for one person is worse than replacing them.
 */
export async function createInvitation(
  input: CreateInvitationInput,
): Promise<{ token: string; invitationId: string }> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!email || !fullName) throw new TeamError("missing_fields");
  if (!isPasswordRole(input.role)) throw new TeamError("role_not_invitable");

  /**
   * Issue #854 (P1.13): direct member creation already refused to originate a
   * membership on a Hybrid site (`cloud_confirmation_required`); invitations
   * did not, so the same membership could be conjured through the other door.
   * "This site must not locally create memberships the cloud does not own" is a
   * property of *creating a membership*, not of one route.
   */
  const profile = (await readDeploymentProfile(input.businessId)).profile;
  if (profile === "hybrid") throw new TeamError("cloud_confirmation_required", 409);

  const { rows: existingMember } = await query(
    `SELECT 1 FROM users WHERE business_id = $1 AND email = $2 AND is_active`,
    [input.businessId, email],
  );
  if (existingMember.length > 0) throw new TeamError("already_a_member", 409);

  /**
   * Issue #854 (P2.4) — an invitation that names a custom role or grants
   * capability overrides is a sensitive access decision made *now*, even though
   * the membership materialises at acceptance. The same rule direct creation
   * applies is applied here, and the validated reason is stored on the row so
   * the acceptance audit answers "who gave them this, and why".
   */
  const inviteGrantsExtraAccess =
    (input.customRoleId ?? null) !== null ||
    (input.overrides !== undefined && sortOverrides(input.overrides).granted.length > 0);
  let invitationReason: string | null = null;
  if (inviteGrantsExtraAccess) {
    const validated = validateAccessChangeReason(input.reason);
    if (!validated.ok) throw new TeamError(validated.error, 400);
    invitationReason = validated.reason;
  }

  /**
   * Issue #854 (P0.5): branch ids arrive from a request body and used to be
   * stored unvalidated, then applied under the privileged acceptance path.
   * A crafted invitation could therefore carry another tenant's location uuid.
   * The same rule normal member create/edit already applies is applied here —
   * on the same connection, before the row exists — and `acceptInvitation`
   * validates again on the way out (defence in depth).
   */
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locations = await resolveMemberLocations(
      client,
      input.businessId,
      input.locationIds,
      input.defaultLocationId ?? input.locationIds?.[0] ?? null,
    );

    // P2.10: a scope that claims "selected" with nothing selected, or "home"
    // with no branch, is an unusable membership. Refused here rather than
    // discovered at the invitee's first login.
    let scope = input.locationScope ?? null;
    /**
     * Issue #854 (GAP 10) — the same inheritance direct creation applies: an
     * invitation that names a custom role but no branch policy stores the
     * role's `default_location_scope`, so the member arriving through the link
     * wears the branch policy that was decided with the role. The unusable
     * combinations refuse here instead of widening to "all" at acceptance.
     */
    if (scope === null && input.customRoleId && input.role !== "owner") {
      const snapshot = await loadCustomRole(input.businessId, input.customRoleId);
      if (!snapshot) throw new TeamError("custom_role_not_found", 404);
      if (snapshot.defaultLocationScope === "selected") {
        throw new TeamError("selected_locations_required", 400);
      }
      if (snapshot.defaultLocationScope === "home") {
        throw new TeamError("home_location_required", 400);
      }
      scope = snapshot.defaultLocationScope;
    }
    if (scope === "selected" && locations.locationIds.length === 0) {
      throw new TeamError("selected_locations_required", 400);
    }
    if (scope === "home" && !locations.defaultLocationId) {
      throw new TeamError("home_location_required", 400);
    }

    const { token, tokenHash } = generateInvitationToken();

    await client.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE business_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [input.businessId, email],
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO invitations
         (business_id, email, role, full_name, permissions, location_ids, token_hash,
          expires_at, invited_by, location_scope, default_location_id, custom_role_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        input.businessId,
        email,
        input.role,
        fullName,
        JSON.stringify(input.overrides ?? {}),
        locations.locationIds,
        tokenHash,
        invitationExpiry(),
        input.actorId,
        scope,
        locations.defaultLocationId,
        input.customRoleId ?? null,
        invitationReason,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'team.invited', 'invitation', $3, $4)`,
      [
        input.businessId,
        input.actorId,
        rows[0].id,
        // The authority context is recorded with the invitation, so a later
        // review can answer "who handed this out and with what standing".
        JSON.stringify({
          email,
          role: input.role,
          locationIds: locations.locationIds,
          locationScope: scope,
          overrides: input.overrides ?? {},
        }),
      ],
    );

    await client.query("COMMIT");
    return { token, invitationId: rows[0].id };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeInvitation(
  businessId: string,
  invitationId: string,
  actorId: string | null,
): Promise<void> {
  const { rowCount } = await query(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, businessId],
  );
  if (!rowCount) throw new TeamError("not_found", 404);

  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id)
     VALUES ($1, $2, 'team.invitation_revoked', 'invitation', $3)`,
    [businessId, actorId, invitationId],
  );
}

export interface InvitationPreview {
  businessName: string;
  email: string;
  fullName: string;
  role: Role;
  /** True when this email already has a platform login, so no password is needed. */
  hasExistingLogin: boolean;
}

/**
 * Looks up an invitation by its presented token.
 *
 * Runs bypassed: whoever is accepting has no session yet, and by definition no
 * membership of the business that invited them. The token is the credential.
 */
export async function previewInvitation(
  token: string,
): Promise<InvitationPreview> {
  return withoutTenantScope("login", async () => {
    const { rows } = await query<{
      email: string;
      full_name: string;
      role: Role;
      business_name: string;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      has_login: boolean;
    }>(
      `SELECT i.email::text AS email, i.full_name, i.role, b.name AS business_name,
              i.expires_at, i.accepted_at, i.revoked_at,
              EXISTS (SELECT 1 FROM platform_users p WHERE p.email = i.email) AS has_login
         FROM invitations i
         JOIN businesses b ON b.id = i.business_id
        WHERE i.token_hash = $1`,
      [hashInvitationToken(token)],
    );

    const invitation = rows[0];
    if (!invitation) throw new TeamError("invalid_invitation", 404);

    const status = invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    if (status !== "pending") throw new TeamError(`invitation_${status}`, 409);

    return {
      businessName: invitation.business_name,
      email: invitation.email,
      fullName: invitation.full_name,
      role: invitation.role,
      hasExistingLogin: invitation.has_login,
    };
  });
}

export interface AcceptInvitationResult {
  businessId: string;
  businessSlug: string;
  businessSubdomain: string;
  userId: string;
  platformUserId: string;
  role: Role;
  fullName: string;
  locationId: string | null;
  /** The branch policy the membership was created under (#854 P2.11). */
  locationScope: "all" | "selected" | "home" | "none";
}

export interface AcceptInvitationResult {
  businessId: string;
  businessSlug: string;
  businessSubdomain: string;
  userId: string;
  platformUserId: string;
  role: Role;
  fullName: string;
  locationId: string | null;
  /** The branch policy the membership was created under (#854 P2.11). */
  locationScope: "all" | "selected" | "home" | "none";
}

/**
 * What `beginInvitationAcceptance` proved, before any membership exists.
 *
 * Issue #854 (P0.4) — the ceremony an invitation link has to satisfy is
 *
 *     invitation token
 *       → identify intended account/business
 *       → primary authentication
 *       → required MFA
 *       → accept membership
 *       → tenant session
 *
 * and the middle two steps are why this type exists. The previous shape created
 * the membership first and evaluated MFA afterwards, which meant a member who
 * abandoned the second factor kept a membership nobody had finished accepting —
 * and, on a brand-new address, an account whose only credential was a password
 * typed into a form that was never completed. So validation and primary
 * authentication now commit on their own (`beginInvitationAcceptance`) and the
 * membership is written only once every factor has been proven
 * (`completeInvitationAcceptance`).
 *
 * The invitation row is *re-locked and re-checked* in the second phase rather
 * than trusted from the first: the MFA ceremony takes as long as it takes, and a
 * link revoked in the meantime must not still land.
 */
export interface StagedInvitationAcceptance {
  invitationId: string;
  businessId: string;
  businessSlug: string;
  businessSubdomain: string;
  email: string;
  role: Role;
  fullName: string;
  platformUserId: string;
  /** False when the identity was created by this call (a first-time invitee). */
  identityExisted: boolean;
}

/**
 * Phase 1 — validate the invitation and prove the primary factor.
 *
 * Runs in its own transaction and commits: the invitation stays `pending` (it is
 * only marked accepted in phase 2), and for a first-time invitee the identity is
 * created here because it is the *subject* of the second factor — MFA enrolments
 * hang off `platform_users`, so an account that cannot exist yet cannot be
 * protected. What must not exist yet is the membership.
 */
export async function beginInvitationAcceptance(
  token: string,
  password: string | null,
): Promise<StagedInvitationAcceptance> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Acceptance necessarily crosses the boundary: the acceptor is not yet a
    // member of the business that invited them.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const invitation = await lockPendingInvitation(client, token);
    const { platformUserId, identityExisted } = await authenticateInvitee(
      client,
      invitation.email,
      invitation.full_name,
      password,
    );

    /**
     * The duplicate check belongs in phase 1: it needs no MFA and its answer
     * cannot change between the phases (phase 2 re-checks it under the lock
     * anyway, because nothing that costs an SMS should be spent on a membership
     * that already exists).
     */
    const { rows: dup } = await client.query(
      "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
      [invitation.business_id, platformUserId],
    );
    if (dup.length > 0) {
      await client.query("ROLLBACK");
      throw new TeamError("already_a_member", 409);
    }

    await client.query("COMMIT");
    return {
      invitationId: invitation.id,
      businessId: invitation.business_id,
      businessSlug: invitation.business_slug,
      businessSubdomain: invitation.business_subdomain,
      email: invitation.email,
      role: invitation.role,
      fullName: invitation.full_name,
      platformUserId,
      identityExisted,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Phase 2 — write the membership, once every factor has been proven.
 *
 * Idempotent for the member it already accepted: a retry, a refresh, or a second
 * in-flight `/api/auth/mfa/verify` for the same identity finds the accepted row
 * and gets the membership back rather than a refusal, because by then the
 * ceremony *has* been completed and re-running it changes nothing.
 */
export async function completeInvitationAcceptance(staged: {
  invitationId: string;
  platformUserId: string;
}): Promise<AcceptInvitationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const { rows } = await client.query<InvitationRow>(
      `SELECT i.id, i.business_id, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain, i.email::text AS email,
              i.role, i.full_name, i.permissions, i.location_ids, i.location_scope,
              i.default_location_id, i.custom_role_id, i.reason, i.expires_at, i.accepted_at,
              i.revoked_at, i.accepted_user_id
         FROM invitations i
         JOIN businesses b ON b.id = i.business_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [staged.invitationId],
    );
    const invitation = rows[0];
    if (!invitation) {
      await client.query("ROLLBACK");
      throw new TeamError("invalid_invitation", 404);
    }

    /**
     * Already accepted by *this* identity: the ceremony is done, hand back what
     * exists. Accepted by somebody else — a different link holder won the race —
     * keeps the original refusal.
     */
    if (invitation.accepted_at !== null) {
      const existing = await invitationResult(client, invitation, staged.platformUserId);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      await client.query("ROLLBACK");
      throw new TeamError("invitation_accepted", 409);
    }

    const status = invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    if (status !== "pending") {
      await client.query("ROLLBACK");
      throw new TeamError(`invitation_${status}`, 409);
    }

    const result = await writeInvitationMembership(client, invitation, staged.platformUserId);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Accepts an invitation, creating the membership (and the identity if this is
 * the person's first business).
 *
 * This is the convenience wrapper for callers that face no second factor: it
 * runs the two phases in sequence — `beginInvitationAcceptance` (validate +
 * authenticate, committing nothing membership-shaped) and then
 * `completeInvitationAcceptance` (the membership write). The phases do **not**
 * share one connection or one transaction: each opens and commits its own.
 * What keeps the pair safe instead of a single transaction is the shape of the
 * phases — phase 1 writes no membership at all, and phase 2 re-locks the
 * invitation row by id, refuses anything no longer pending, and is idempotent
 * for the identity it already accepted. The routes that meet an MFA step use
 * the two phases explicitly, with the pending token carrying `invitationId`.
 */
export async function acceptInvitation(
  token: string,
  password: string | null,
): Promise<AcceptInvitationResult> {
  const staged = await beginInvitationAcceptance(token, password);
  return completeInvitationAcceptance({
    invitationId: staged.invitationId,
    platformUserId: staged.platformUserId,
  });
}

interface InvitationRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  business_slug: string;
  business_subdomain: string;
  email: string;
  role: Role;
  full_name: string;
  permissions: unknown;
  location_ids: string[] | null;
  location_scope: "all" | "selected" | "home" | "none" | null;
  default_location_id: string | null;
  custom_role_id: string | null;
  reason: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  accepted_user_id: string | null;
}

/** Lock the invitation row by token hash and refuse anything not still pending. */
async function lockPendingInvitation(
  client: PoolClient,
  token: string,
): Promise<InvitationRow> {
  const { rows } = await client.query<InvitationRow>(
    `SELECT i.id, i.business_id, b.slug::text AS business_slug,
            b.subdomain::text AS business_subdomain, i.email::text AS email,
            i.role, i.full_name, i.permissions, i.location_ids, i.location_scope,
            i.default_location_id, i.custom_role_id, i.reason, i.expires_at, i.accepted_at,
            i.revoked_at, i.accepted_user_id
       FROM invitations i
       JOIN businesses b ON b.id = i.business_id
      WHERE i.token_hash = $1 FOR UPDATE OF i`,
    [hashInvitationToken(token)],
  );

  const invitation = rows[0];
  if (!invitation) throw new TeamError("invalid_invitation", 404);

  if (
    invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    }) !== "pending"
  ) {
    const status = invitationStatus({
      expiresAt: invitation.expires_at,
      acceptedAt: invitation.accepted_at,
      revokedAt: invitation.revoked_at,
    });
    throw new TeamError(`invitation_${status}`, 409);
  }
  return invitation;
}

/**
 * Primary authentication for the invitee.
 *
 * Issue #854 (P0.4) — invitation possession is not proof of identity.
 *
 * An invitation token says "somebody at this business wants this address to
 * join"; it says nothing about *who is holding the link*. For an address that
 * already has a global identity the offered `password` must verify against that
 * identity's **existing** hash, or the accepting caller is refused. Without this
 * anyone holding a forwarded (or intercepted) invitation for a known address
 * received that person's membership with no password and no MFA.
 *
 * For an address with no identity the invitation *is* the permission to create
 * one, and the password given here becomes its credential — through the shared
 * strength validator, so an invitation cannot plant a blank one.
 */
async function authenticateInvitee(
  client: PoolClient,
  email: string,
  fullName: string,
  password: string | null,
): Promise<{ platformUserId: string; identityExisted: boolean }> {
  const { rows: identityRows } = await client.query<{
    id: string;
    password_hash: string;
  }>(
    "SELECT id, password_hash FROM platform_users WHERE email = $1 AND is_active = true",
    [email],
  );

  if (identityRows[0]) {
    if (!password || password.length === 0) {
      throw new TeamError("authentication_required", 401);
    }
    const authentic = await bcrypt.compare(password, identityRows[0].password_hash);
    if (!authentic) throw new TeamError("invalid_credentials", 401);
    return { platformUserId: identityRows[0].id, identityExisted: true };
  }

  const strength = validatePasswordStrength(password ?? "");
  if (!strength.ok) throw new TeamError(strength.error, 400);
  const { rows: created } = await client.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [email, await bcrypt.hash(password!, BCRYPT_COST), fullName],
  );
  return { platformUserId: created[0].id, identityExisted: false };
}

/** The result shape for an invitation this identity already accepted. */
async function invitationResult(
  client: PoolClient,
  invitation: InvitationRow,
  platformUserId: string,
): Promise<AcceptInvitationResult | null> {
  const { rows } = await client.query<{
    id: string;
    location_id: string | null;
    location_scope: "all" | "selected" | "home" | "none";
  }>(
    `SELECT id, location_id, location_scope FROM users
      WHERE business_id = $1 AND platform_user_id = $2`,
    [invitation.business_id, platformUserId],
  );
  const member = rows[0];
  if (!member) return null;
  return {
    businessId: invitation.business_id,
    businessSlug: invitation.business_slug,
    businessSubdomain: invitation.business_subdomain,
    userId: member.id,
    platformUserId,
    role: invitation.role,
    fullName: invitation.full_name,
    locationId: member.location_id,
    locationScope: member.location_scope,
  };
}

/** The membership write itself: locations, ceiling, row, invitation, audit. */
async function writeInvitationMembership(
  client: PoolClient,
  invitation: InvitationRow,
  platformUserId: string,
): Promise<AcceptInvitationResult> {
  const { rows: dup } = await client.query(
    "SELECT 1 FROM users WHERE business_id = $1 AND platform_user_id = $2",
    [invitation.business_id, platformUserId],
  );
  if (dup.length > 0) throw new TeamError("already_a_member", 409);

  /**
   * Issue #854 (P0.5), defence in depth: every location id the invitation
   * carries is re-checked against the invitation's business **here**, under
   * the same connection as the write, even though `createInvitation` already
   * proved them. An invitation row can be written by more than one path over
   * the life of the schema (a pairing apply, a restore, an older release), and
   * this is the last moment before a foreign uuid would be attached to a
   * membership under the privileged acceptance window.
   */
  const resolvedLocations = await resolveMemberLocations(
    client,
    invitation.business_id,
    invitation.location_ids ?? [],
    invitation.default_location_id ?? null,
  );

  // This route has no session — `client` has app.rls_bypass/app.business_id
  // set by hand above, so the check must run on this same connection (see
  // plan-limits.ts's module comment for why a fresh pool connection would
  // silently under-count here). The ceiling read rides the same client so
  // the override layer is visible under the same GUCs.
  const invitationCeiling = await resolveLimitCeiling(
    invitation.business_id,
    "member_limit",
    client,
  );
  if (
    invitationCeiling.limit !== null &&
    (await activeMemberCount(invitation.business_id, client)) >= invitationCeiling.limit
  ) {
    throw new TeamError("member_limit_exceeded", 403);
  }

  /**
   * The branch policy (#854 P2.11). A pre-0211 row has `location_scope` NULL
   * and keeps the legacy reading — an empty `location_ids` meant "all" — so a
   * link already in somebody's inbox does not silently narrow. New rows state
   * it explicitly, and "the inviter never saw a branch field" is no longer
   * interpreted as "give them everything".
   */
  const scope =
    invitation.location_scope ??
    (resolvedLocations.locationIds.length > 0
      ? "selected"
      : resolvedLocations.defaultLocationId
        ? "home"
        : "all");
  const defaultLocationId =
    scope === "home" || scope === "selected"
      ? (resolvedLocations.defaultLocationId ?? resolvedLocations.locationIds[0] ?? null)
      : null;
  const assignedLocationIds = scope === "selected" ? resolvedLocations.locationIds : [];

  /**
   * Issue #854 (P2.12): the custom role the invitation named comes across
   * with it. Without this the invitation looked right on the Team screen and
   * the member arrived wearing the plain role preset — a silent downgrade of
   * exactly the access somebody approved. An `owner` never wears one.
   */
  const customRoleId = invitation.role === "owner" ? null : invitation.custom_role_id;

  // Issue #854 (GAP 7): same protocol as direct creation — pick the id, take
  // the membership lock, then write, all inside the acceptance transaction.
  const newMembershipId = randomUUID();
  await lockMembership(client, invitation.business_id, newMembershipId);

  const { rows: member } = await client.query<{ id: string }>(
    `INSERT INTO users
       (id, business_id, platform_user_id, role, full_name, email, location_id, permissions,
        location_scope, membership_status, custom_role_id)
     VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9) RETURNING id`,
    [
      invitation.business_id,
      platformUserId,
      invitation.role,
      invitation.full_name,
      invitation.email,
      defaultLocationId,
      JSON.stringify(invitation.permissions ?? {}),
      invitation.role === "owner" ? "all" : scope,
      customRoleId,
      newMembershipId,
    ],
  );
  const userId = member[0].id;

  if (assignedLocationIds.length > 0) {
    await client.query(
      "INSERT INTO user_locations (user_id, location_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
      [userId, assignedLocationIds],
    );
  }

  await client.query(
    "UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1",
    [invitation.id, userId],
  );

  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, 'team.invitation_accepted', 'user', $3, $4)`,
    [
      invitation.business_id,
      userId,
      // Separate parameter from user_id above: entity_id is text and user_id
      // is uuid, and Postgres cannot deduce one type for a shared parameter.
      userId,
      JSON.stringify({
        invitationId: invitation.id,
        locationScope: scope,
        locationIds: assignedLocationIds,
        customRoleId,
        // Issue #854 (P2.4): the justification recorded when the access was
        // decided (invite time), not reconstructed after the fact.
        reason: invitation.reason ?? null,
      }),
    ],
  );

  return {
    businessId: invitation.business_id,
    businessSlug: invitation.business_slug,
    businessSubdomain: invitation.business_subdomain,
    userId,
    platformUserId,
    role: invitation.role,
    fullName: invitation.full_name,
    locationId: defaultLocationId,
    locationScope: scope,
  };
}
