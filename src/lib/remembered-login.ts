/**
 * #1585 — the remembered-login service.
 *
 * This is authority **C** from the issue's model, and it is deliberately not
 * confused with the other two:
 *
 *  - **A. the access session** (`employee_sessions` + the signed JWT) is what
 *    every request is checked against, and it stays short-lived.
 *  - **B. the seven-day trusted-device exemption** (`trusted_devices`) waives a
 *    routine MFA challenge and authorises nothing at all.
 *  - **C. this** is a renewable authorization whose only power is to mint a
 *    fresh A after the server re-validates everything. It is not a session, it
 *    is not an MFA exemption, and neither of the other two mints it.
 *
 * The pieces that carry the security properties:
 *
 *  - **Opaque, high-entropy secrets.** 256 random bits, prefixed, carried in a
 *    host-only HttpOnly cookie. Only its HMAC-SHA256 digest is ever stored, so
 *    reading the table cannot produce a usable credential.
 *  - **Rotation with a chain.** Each secret is one row. Rotating supersedes it
 *    and inserts the next generation. A presented secret whose row is already
 *    superseded is therefore *recognisable* as a replay — which a single
 *    "current hash" column cannot do — and the family is revoked and audited.
 *  - **A bounded concurrency grace.** Parallel tabs legitimately race: the
 *    winner rotates, the loser presents the same secret microseconds later. It
 *    gets `concurrent` (retry with the cookie the winner just set) rather than
 *    a family revocation. The grace is a few seconds, it hands back **no**
 *    session and **no** new credential, and once it has passed the same
 *    presentation is treated as a stolen token. There is no reusable window.
 *  - **Two deadlines.** `idle_expires_at` rolls forward on use;
 *    `absolute_expires_at` never does. A renewal is clamped to the latter.
 *  - **Assurance is copied, never raised.** `mfa_verified`, `otp_only_assurance`
 *    and `authenticated_at` are the values from the login that created the
 *    family. A refresh re-signs them; it never upgrades them, and `recentAuthAt`
 *    does not move — see #1386 and `requireSensitiveRecentAuth`.
 *  - **Tenant identity is re-derived.** The membership and the global identity
 *    are re-read on every rotation; nothing tenant- or person-shaped is taken
 *    from the request. A removed membership, a stale `token_version`, a
 *    suspended business or a revoked platform identity ends the family.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isPinnedToTransaction,
  query,
  withoutTenantScope,
  withoutTenantScopeTransaction,
  withTenantTransaction,
} from "./db";
import { getRealmSecret } from "./jwt-secret";
import { recordSecurityAudit, SECURITY_AUDIT_ACTIONS, transactionAuditExecutor } from "./security-audit";
import {
  EMPTY_DEVICE_CONTEXT,
  classifyRenewalRisk,
  type DeviceContext,
  type RenewalRiskDecision,
} from "./login-risk";
import type { Role } from "./auth-edge";
import type { SessionLoginMethod } from "./session-contract";

/**
 * The credential's cookie.
 *
 * HttpOnly (no script can read it), SameSite=Lax (a cross-site POST cannot
 * carry it, which is the CSRF boundary for the refresh endpoint), Secure in
 * production, and — load-bearing — **no `Domain` attribute**, so it is
 * host-only and cannot cross tenant subdomains, exactly like `pos_session` and
 * `pos_trusted_device`.
 *
 * The path is narrowed to `/api/auth`: this credential is only ever read by the
 * refresh and sign-out routes, and narrowing it means the browser does not
 * attach it to ordinary application requests at all.
 */
export const REMEMBERED_LOGIN_COOKIE = "pos_remember";
export const REMEMBERED_LOGIN_COOKIE_PATH = "/api/auth";

const TOKEN_PREFIX = "rlog_";

/** How long two racing presentations of the same secret are read as one browser. */
export const REMEMBERED_CONCURRENCY_GRACE_MS = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Approved policy values.
 *
 * The issue proposes 30-day idle and a configurable absolute maximum (90 days)
 * and says to treat them as proposals. They are the shipped defaults here,
 * overridable by deployment configuration (`REMEMBERED_LOGIN_IDLE_DAYS`,
 * `REMEMBERED_LOGIN_ABSOLUTE_DAYS`) so the security owner can tighten them
 * without a code change. The absolute maximum is never allowed below the idle
 * window: a family that must die before it may be refreshed is not a feature.
 */
export function rememberedLoginPolicy(): {
  idleDays: number;
  absoluteDays: number;
  idleMs: number;
  absoluteMs: number;
} {
  const idleDays = positiveInt(process.env.REMEMBERED_LOGIN_IDLE_DAYS, 30);
  const absoluteDays = Math.max(
    idleDays,
    positiveInt(process.env.REMEMBERED_LOGIN_ABSOLUTE_DAYS, 90),
  );
  return {
    idleDays,
    absoluteDays,
    idleMs: idleDays * DAY_MS,
    absoluteMs: absoluteDays * DAY_MS,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * The two deadlines a family issued at `now` carries.
 *
 * Pure and clock-injected so the boundary is pinned by a test rather than
 * inferred: the idle deadline may never sit past the absolute one.
 */
export function rememberedLoginExpiries(
  now: Date,
  policy = rememberedLoginPolicy(),
): { idleExpiresAt: Date; absoluteExpiresAt: Date } {
  return {
    idleExpiresAt: new Date(now.getTime() + policy.idleMs),
    absoluteExpiresAt: new Date(now.getTime() + policy.absoluteMs),
  };
}

/**
 * A renewal's new idle deadline: `now + idle`, clamped to the family's hard
 * deadline. This is the whole "a renewal must never extend beyond the maximum"
 * rule, in one expression.
 */
export function nextIdleExpiry(
  now: Date,
  absoluteExpiresAt: Date,
  policy = rememberedLoginPolicy(),
): Date {
  const rolled = new Date(now.getTime() + policy.idleMs);
  return rolled.getTime() < absoluteExpiresAt.getTime() ? rolled : absoluteExpiresAt;
}

/**
 * Cookie lifetime: the shorter of the idle window and the family's remaining
 * absolute life. A cookie that outlived the row would only produce a lookup
 * miss; one that expired early would silently end a valid remembered login.
 */
export function rememberedLoginCookieMaxAge(absoluteExpiresAt: Date, now = new Date()): number {
  const remaining = Math.floor((absoluteExpiresAt.getTime() - now.getTime()) / 1000);
  const idleCap = Math.floor(rememberedLoginPolicy().idleMs / 1000);
  return Math.max(0, Math.min(remaining, idleCap));
}

export function rememberedLoginCookieOptions(absoluteExpiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    // No `domain`: host-only, so one tenant's cookie is never sent to another's
    // origin. See the constant's comment.
    path: REMEMBERED_LOGIN_COOKIE_PATH,
    maxAge: rememberedLoginCookieMaxAge(absoluteExpiresAt),
  };
}

/** The cleared form of that cookie, for sign-out and revocation. */
export function clearedRememberedLoginCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: REMEMBERED_LOGIN_COOKIE_PATH,
    maxAge: 0,
  };
}

/** A fresh opaque secret. 256 bits, base64url, prefixed for cheap rejection. */
export function generateRememberedSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * The digest of a secret, purpose-bound.
 *
 * HMAC-SHA256 with the tenant realm secret, over a domain-separated string, so
 * a digest from this table can never be replayed into another table that hashes
 * a different kind of credential with the same key.
 */
async function hashRememberedSecret(secret: string): Promise<string> {
  const key = await getRealmSecret("tenant");
  return createHmac("sha256", Buffer.from(key))
    .update(`remembered-login:${secret}`)
    .digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The *string* lengths are compared first, not just the decoded buffer lengths:
 * `Buffer.from("abcde", "hex")` silently drops the odd trailing character and
 * would compare equal to `Buffer.from("abcd", "hex")`. A length check after
 * decoding is therefore not a length check at all.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** The remembered credential this request is carrying, if any. */
export function readRememberedLoginToken(request: {
  cookies: { get(name: string): { value: string } | undefined };
}): string | null {
  const value = request.cookies.get(REMEMBERED_LOGIN_COOKIE)?.value;
  if (!value || !value.trim()) return null;
  return value.trim();
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssueRememberedLoginInput {
  businessId: string;
  /** `users.id` — the membership. */
  userId: string;
  platformUserId?: string | null;
  /** `platform_users.token_version` right now; compared on every renewal. */
  platformTokenVersion?: number | null;
  loginMethod: SessionLoginMethod;
  mfaVerified: boolean;
  otpOnlyAssurance: boolean;
  /** When the human actually authenticated. Copied into every renewed session. */
  authenticatedAt: Date;
  deviceLabel?: string | null;
  device?: DeviceContext;
}

export interface IssuedRememberedLogin {
  secret: string;
  familyId: string;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
}

/**
 * Mint a remembered-login family, after every required factor has passed.
 *
 * Only the sign-in doors may call this, and only when the person explicitly
 * ticked the box. It is never called from a refresh, from an MFA exemption, or
 * from any path that did not just authenticate a human.
 */
export async function issueRememberedLogin(
  input: IssueRememberedLoginInput,
): Promise<IssuedRememberedLogin> {
  if (isPinnedToTransaction()) return issueInTransaction(input);
  return withTenantTransaction(input.businessId, () => issueInTransaction(input));
}

async function issueInTransaction(
  input: IssueRememberedLoginInput,
): Promise<IssuedRememberedLogin> {
  const now = new Date();
  const policy = rememberedLoginPolicy();
  const { idleExpiresAt, absoluteExpiresAt } = rememberedLoginExpiries(now, policy);
  const secret = generateRememberedSecret();
  const tokenHash = await hashRememberedSecret(secret);
  const device = input.device ?? EMPTY_DEVICE_CONTEXT;

  const { rows } = await query<{ id: string }>(
    `INSERT INTO remembered_login_families
       (business_id, user_id, platform_user_id, platform_token_version,
        login_method, mfa_verified, otp_only_assurance, authenticated_at,
        device_label, browser_family, os_family, region_hint, issued_at,
        last_used_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now(), $13, $14)
     RETURNING id`,
    [
      input.businessId,
      input.userId,
      input.platformUserId ?? null,
      input.platformTokenVersion ?? null,
      input.loginMethod,
      input.mfaVerified,
      input.otpOnlyAssurance,
      input.authenticatedAt,
      input.deviceLabel ?? null,
      device.browserFamily,
      device.osFamily,
      device.regionHint,
      idleExpiresAt,
      absoluteExpiresAt,
    ],
  );
  const familyId = rows[0].id;

  await query(
    `INSERT INTO remembered_login_credentials
       (family_id, business_id, token_hash, generation)
     VALUES ($1, $2, $3, 1)`,
    [familyId, input.businessId, tokenHash],
  );

  await recordSecurityAudit(
    {
      realm: "tenant",
      action: SECURITY_AUDIT_ACTIONS.rememberedLoginIssued,
      businessId: input.businessId,
      actorUserId: input.userId,
      platformUserId: input.platformUserId ?? null,
      entity: "remembered_login",
      entityId: familyId,
      payload: {
        familyId,
        loginMethod: input.loginMethod,
        mfaVerified: input.mfaVerified,
        otpOnlyAssurance: input.otpOnlyAssurance,
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      },
    },
    transactionAuditExecutor(),
  );

  return { secret, familyId, absoluteExpiresAt, idleExpiresAt };
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** The assurance a family carries, copied into each renewed session verbatim. */
export interface FamilyAssurance {
  authenticatedAt: Date;
  mfaVerified: boolean;
  otpOnlyAssurance: boolean;
}

export interface FamilyScope {
  familyId: string;
  businessId: string;
  userId: string;
  platformUserId: string | null;
  loginMethod: string | null;
}

export type RememberedRotation =
  | {
      status: "rotated";
      secret: string;
      idleExpiresAt: Date;
      absoluteExpiresAt: Date;
      family: FamilyScope;
      assurance: FamilyAssurance;
      risk: RenewalRiskDecision;
    }
  /** Another tab of the same browser won the race; retry with the new cookie. */
  | { status: "concurrent" }
  /**
   * The credential is credible but the context changed. The caller may present
   * a purpose-bound password — *only* where the MFA policy allows password-only
   * verification — and call again with `stepUpVerified: true`.
   */
  | {
      status: "step_up_required";
      family: FamilyScope;
      assurance: FamilyAssurance;
      risk: RenewalRiskDecision;
    }
  /** Refuse and send the person to a full sign-in. */
  | {
      status: "reauth_required";
      reason: string;
      risk: RenewalRiskDecision;
    };

interface FamilyRow extends Record<string, unknown> {
  family_id: string;
  credential_id: string;
  generation: number;
  superseded_at: Date | null;
  business_id: string;
  user_id: string;
  platform_user_id: string | null;
  platform_token_version: number | null;
  login_method: string | null;
  mfa_verified: boolean;
  otp_only_assurance: boolean;
  authenticated_at: Date;
  browser_family: string | null;
  os_family: string | null;
  region_hint: string | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface RotateRememberedLoginInput {
  secret: string;
  /** Coarse context of this request. */
  device: DeviceContext;
  /**
   * Set only by the route, and only after it verified the account's password
   * under the existing MFA policy. Never taken from the request body directly.
   */
  stepUpVerified?: boolean;
  now?: Date;
}

/**
 * Atomically rotate a remembered login and return the secret to set.
 *
 * Runs under the documented `login` bypass because the caller has no session
 * yet — the credential *is* the identity claim, and the membership it names is
 * re-read and re-checked inside this transaction before anything is minted.
 */
export async function rotateRememberedLogin(
  input: RotateRememberedLoginInput,
): Promise<RememberedRotation> {
  const secret = input.secret.trim();
  if (!secret.startsWith(TOKEN_PREFIX)) {
    return { status: "reauth_required", reason: "invalid", risk: { level: "high", reasons: ["credential_unknown"] } };
  }
  const tokenHash = await hashRememberedSecret(secret);
  const now = input.now ?? new Date();

  return withoutTenantScopeTransaction("login", async () => {
    // Lock the family row: concurrent rotations serialize here, so exactly one
    // of them supersedes generation N and the rest observe the result.
    const { rows } = await query<FamilyRow>(
      `SELECT c.id AS credential_id, c.generation, c.superseded_at,
              f.id AS family_id, f.business_id, f.user_id, f.platform_user_id,
              f.platform_token_version, f.login_method, f.mfa_verified, f.otp_only_assurance,
              f.authenticated_at, f.browser_family, f.os_family, f.region_hint,
              f.idle_expires_at, f.absolute_expires_at, f.revoked_at
         FROM remembered_login_credentials c
         JOIN remembered_login_families f ON f.id = c.family_id
        WHERE c.token_hash = $1
        FOR UPDATE OF f`,
      [tokenHash],
    );
    const row = rows[0];

    if (!row) {
      return {
        status: "reauth_required",
        reason: "invalid",
        risk: { level: "high", reasons: ["credential_unknown"] },
      };
    }

    const stored: DeviceContext = {
      browserFamily: (row.browser_family as DeviceContext["browserFamily"]) ?? "unknown",
      osFamily: (row.os_family as DeviceContext["osFamily"]) ?? "unknown",
      regionHint: row.region_hint ?? null,
    };

    // A superseded credential: either a sibling tab inside the grace window, or
    // a replay. The distinction is time-bounded and one-directional — the
    // concurrent branch returns nothing usable.
    //
    // The age is measured by the database, in a statement of its own, because
    // the local subtraction this replaced was wrong in the one case that
    // matters. A request that loses the rotation race only sees
    // `superseded_at` after it has blocked on the family lock and the winner
    // has committed, so that timestamp is *newer* than this request's `now`
    // (taken before it waited): the difference is negative, read as "superseded
    // long ago", and revoked the whole family — five tabs renewing at once
    // signed the user out. `now()` could not measure the gap either, since it is
    // the transaction timestamp, fixed before the wait began. `clock_timestamp()`
    // asked in a fresh READ COMMITTED statement sees the committed supersession
    // and the real elapsed time.
    if (row.superseded_at) {
      const { rows: supersession } = await query<{ superseded_age_ms: string | null }>(
        `SELECT EXTRACT(EPOCH FROM (clock_timestamp() - superseded_at)) * 1000 AS superseded_age_ms
           FROM remembered_login_credentials
          WHERE id = $1`,
        [row.credential_id],
      );
      const age = Number(supersession[0]?.superseded_age_ms ?? Number.POSITIVE_INFINITY);
      if (age >= 0 && age <= REMEMBERED_CONCURRENCY_GRACE_MS) {
        return { status: "concurrent" };
      }
      await revokeFamilyInTransaction(row.family_id, row.business_id, row.user_id, {
        reason: "replay",
        platformUserId: row.platform_user_id,
      });
      return {
        status: "reauth_required",
        reason: "replay",
        risk: { level: "high", reasons: ["credential_replayed"] },
      };
    }

    const expired =
      now.getTime() >= new Date(row.absolute_expires_at).getTime() ||
      now.getTime() >= new Date(row.idle_expires_at).getTime();

    // Identity, membership and token version are re-derived, never trusted from
    // the request. A failure on any of them ends the family: it is no longer a
    // truthful statement about who may be signed in.
    const identity = row.platform_user_id
      ? await query<{ is_active: boolean; token_version: number }>(
          `SELECT is_active, token_version FROM platform_users WHERE id = $1`,
          [row.platform_user_id],
        )
      : null;

    const membership = await query<{
      id: string;
      business_status: string;
      role: Role;
      full_name: string;
      location_id: string | null;
      business_name: string;
      business_slug: string;
      business_subdomain: string;
    }>(
      `SELECT u.id, b.status AS business_status, u.role, u.full_name, u.location_id,
              b.name AS business_name, b.slug::text AS business_slug,
              b.subdomain::text AS business_subdomain
         FROM users u
         JOIN businesses b ON b.id = u.business_id
        WHERE u.id = $1 AND u.business_id = $2 AND u.is_active`,
      [row.user_id, row.business_id],
    );
    const member = membership.rows[0];
    const membershipActive = Boolean(member && member.business_status === "active");
    const identityActive = row.platform_user_id ? identity?.rows[0]?.is_active === true : true;
    /*
     * A recorded version that no longer matches means something bumped it —
     * a password change, a reset, a global sign-out. A family that survived
     * such an event must not be able to mint a session. An unrecorded version
     * (a membership with no global identity, or a row from before this column)
     * is "not compared", never "mismatched".
     */
    const tokenVersionMatches = row.platform_user_id
      ? row.platform_token_version === null || identity?.rows[0]?.token_version === row.platform_token_version
      : true;

    const risk = classifyRenewalRisk({
      credentialValid: true,
      familyRevoked: row.revoked_at !== null,
      familyExpired: expired,
      identityActive,
      membershipActive,
      tokenVersionMatches,
      stored,
      current: input.device,
    });

    const assurance: FamilyAssurance = {
      authenticatedAt: new Date(row.authenticated_at),
      mfaVerified: row.mfa_verified === true,
      otpOnlyAssurance: row.otp_only_assurance === true,
    };
    const family: FamilyScope = {
      familyId: row.family_id,
      businessId: row.business_id,
      userId: row.user_id,
      platformUserId: row.platform_user_id,
      loginMethod: row.login_method,
    };

    if (risk.level === "high") {
      await revokeFamilyInTransaction(row.family_id, row.business_id, row.user_id, {
        reason: risk.reasons[0] ?? "risk",
        platformUserId: row.platform_user_id,
      });
      return { status: "reauth_required", reason: risk.reasons[0] ?? "risk", risk };
    }

    if (risk.level === "moderate" && input.stepUpVerified !== true) {
      // No rotation, no revocation: the credential is credible, the context is
      // not yet. The route decides whether a password satisfies the account's
      // policy; this service never weakens a mandatory MFA.
      return { status: "step_up_required", family, assurance, risk };
    }

    const absoluteExpiresAt = new Date(row.absolute_expires_at);
    const idleExpiresAt = nextIdleExpiry(now, absoluteExpiresAt);
    if (now.getTime() >= absoluteExpiresAt.getTime()) {
      // Belt and braces: `expired` already covered this, but a clamped idle
      // deadline equal to a passed absolute one must never be rotated.
      await revokeFamilyInTransaction(row.family_id, row.business_id, row.user_id, {
        reason: "expired",
        platformUserId: row.platform_user_id,
      });
      return {
        status: "reauth_required",
        reason: "expired",
        risk: { level: "high", reasons: ["family_expired"] },
      };
    }

    const nextSecret = generateRememberedSecret();
    const nextHash = await hashRememberedSecret(nextSecret);

    // Compare-and-swap: the UPDATE is conditional on this credential still
    // being un-superseded, so even a caller that somehow reached here twice
    // cannot supersede one credential twice.
    const superseded = await query(
      `UPDATE remembered_login_credentials
          SET superseded_at = now(), superseded_reason = 'rotation'
        WHERE id = $1 AND superseded_at IS NULL`,
      [row.credential_id],
    );
    if ((superseded.rowCount ?? 0) === 0) {
      return { status: "concurrent" };
    }

    await query(
      `INSERT INTO remembered_login_credentials
         (family_id, business_id, token_hash, generation)
       VALUES ($1, $2, $3, $4)`,
      [row.family_id, row.business_id, nextHash, row.generation + 1],
    );

    await query(
      `UPDATE remembered_login_families
          SET last_used_at = now(),
              idle_expires_at = $2,
              browser_family = $3,
              os_family = $4,
              region_hint = COALESCE($5, region_hint),
              updated_at = now()
        WHERE id = $1`,
      [
        row.family_id,
        idleExpiresAt,
        input.device.browserFamily,
        input.device.osFamily,
        input.device.regionHint,
      ],
    );

    await recordSecurityAudit(
      {
        realm: "tenant",
        action: SECURITY_AUDIT_ACTIONS.rememberedLoginRefreshed,
        businessId: row.business_id,
        actorUserId: row.user_id,
        platformUserId: row.platform_user_id,
        entity: "remembered_login",
        entityId: row.family_id,
        payload: {
          familyId: row.family_id,
          generation: row.generation + 1,
          risk: risk.level,
          reasons: risk.reasons,
        },
      },
      transactionAuditExecutor(),
    );

    return {
      status: "rotated",
      secret: nextSecret,
      idleExpiresAt,
      absoluteExpiresAt,
      family,
      assurance,
      risk,
    };
  });
}

/** Revoke one family inside the caller's transaction, with its audit row. */
async function revokeFamilyInTransaction(
  familyId: string,
  businessId: string,
  userId: string,
  options: { reason: string; platformUserId?: string | null },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE remembered_login_families
        SET revoked_at = now(), revoked_reason = $2, updated_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [familyId, options.reason],
  );
  if (!rowCount) return false;
  await recordSecurityAudit(
    {
      realm: "tenant",
      action: SECURITY_AUDIT_ACTIONS.rememberedLoginRevoked,
      businessId,
      actorUserId: userId,
      platformUserId: options.platformUserId ?? null,
      entity: "remembered_login",
      entityId: familyId,
      payload: { familyId, reason: options.reason },
    },
    transactionAuditExecutor(),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * The family a presented secret belongs to, or null.
 *
 * Used to mark the current browser in the device list and to let a member end
 * *this* browser's authorization without a recent authentication. It resolves
 * scope only — it never mints, rotates or extends anything.
 */
export async function resolveRememberedFamilyId(
  secret: string | null | undefined,
): Promise<string | null> {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (!value.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = await hashRememberedSecret(value);
  const { rows } = await withoutTenantScope("login", () =>
    query<{ family_id: string }>(
      `SELECT family_id FROM remembered_login_credentials WHERE token_hash = $1`,
      [tokenHash],
    ),
  );
  return rows[0]?.family_id ?? null;
}

/** Revoke one family the member owns. Idempotent. */
export async function revokeRememberedLoginFamily(options: {
  businessId: string;
  userId: string;
  familyId: string;
  reason: string;
}): Promise<boolean> {
  return withTenantTransaction(options.businessId, () =>
    revokeFamilyInTransaction(options.familyId, options.businessId, options.userId, {
      reason: options.reason,
    }),
  );
}

/** Revoke by the browser's own cookie — what sign-out does. */
export async function revokeRememberedLoginBySecret(options: {
  secret: string;
  reason: string;
}): Promise<{ revoked: boolean; familyId: string | null }> {
  const secret = options.secret.trim();
  if (!secret.startsWith(TOKEN_PREFIX)) return { revoked: false, familyId: null };
  const tokenHash = await hashRememberedSecret(secret);

  return withoutTenantScope("login", async () => {
    const { rows } = await query<{
      family_id: string;
      business_id: string;
      user_id: string;
      platform_user_id: string | null;
      revoked_at: Date | null;
    }>(
      `SELECT f.id AS family_id, f.business_id, f.user_id, f.platform_user_id, f.revoked_at
         FROM remembered_login_credentials c
         JOIN remembered_login_families f ON f.id = c.family_id
        WHERE c.token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row || row.revoked_at) return { revoked: false, familyId: row?.family_id ?? null };
    const revoked = await withTenantTransaction(row.business_id, () =>
      revokeFamilyInTransaction(row.family_id, row.business_id, row.user_id, {
        reason: options.reason,
        platformUserId: row.platform_user_id,
      }),
    );
    return { revoked, familyId: row.family_id };
  });
}

/**
 * Revoke every remembered login a membership holds in one business.
 *
 * Password change, MFA reset, lockout, deactivation and "sign out everywhere"
 * all come through here. The *session* revocations stay where they are
 * (`revokeMembershipSessions`); this is the independent authority, so it is
 * revoked independently rather than inferred from a session table.
 */
export async function revokeRememberedLoginsForMember(options: {
  businessId: string;
  userId: string;
  reason: string;
  keepFamilyId?: string | null;
}): Promise<number> {
  return withTenantTransaction(options.businessId, async () => {
    const { rowCount } = await query(
      `UPDATE remembered_login_families
          SET revoked_at = now(), revoked_reason = $3, updated_at = now()
        WHERE business_id = $1 AND user_id = $2 AND revoked_at IS NULL
          AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [options.businessId, options.userId, options.reason, options.keepFamilyId ?? null],
    );
    if (!rowCount) return 0;
    await recordSecurityAudit(
      {
        realm: "tenant",
        action: SECURITY_AUDIT_ACTIONS.rememberedLoginRevoked,
        businessId: options.businessId,
        actorUserId: options.userId,
        entity: "remembered_login",
        entityId: options.userId,
        payload: { revokedCount: rowCount, reason: options.reason, scope: "member" },
      },
      transactionAuditExecutor(),
    );
    return rowCount ?? 0;
  });
}

/** Revoke every remembered login a *global identity* holds, across tenants. */
export async function revokeRememberedLoginsForPlatformUser(options: {
  platformUserId: string;
  reason: string;
}): Promise<number> {
  return withoutTenantScope("identity", async () => {
    const { rowCount } = await query(
      `UPDATE remembered_login_families
          SET revoked_at = now(), revoked_reason = $2, updated_at = now()
        WHERE platform_user_id = $1 AND revoked_at IS NULL`,
      [options.platformUserId, options.reason],
    );
    return rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Listing and cleanup
// ---------------------------------------------------------------------------

export interface RememberedDeviceListing {
  id: string;
  deviceLabel: string | null;
  browserFamily: string | null;
  osFamily: string | null;
  issuedAt: Date;
  lastUsedAt: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * One member's remembered browsers in this business.
 *
 * Revoked families are included so the member can see that a sign-out or a
 * security event ended one, exactly as the trusted-device list does. No secret,
 * digest or context beyond the coarse browser/OS family is ever returned.
 */
export async function listRememberedLogins(
  businessId: string,
  userId: string,
): Promise<RememberedDeviceListing[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, device_label, browser_family, os_family, issued_at, last_used_at,
            idle_expires_at, absolute_expires_at, revoked_at
       FROM remembered_login_families
      WHERE business_id = $1 AND user_id = $2
      ORDER BY issued_at DESC`,
    [businessId, userId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    deviceLabel: (r.device_label as string | null) ?? null,
    browserFamily: (r.browser_family as string | null) ?? null,
    osFamily: (r.os_family as string | null) ?? null,
    issuedAt: new Date(r.issued_at as string | Date),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string | Date) : null,
    idleExpiresAt: new Date(r.idle_expires_at as string | Date),
    absoluteExpiresAt: new Date(r.absolute_expires_at as string | Date),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string | Date) : null,
  }));
}

/**
 * Drop rows that can no longer authorise anything.
 *
 * Families are kept for a retention tail after their hard deadline so a member
 * (and an auditor) can still see that one existed and when it ended; the
 * deletion is deliberately not immediate. Credentials are pruned on the same
 * tail, which also keeps the rotation chain from growing without bound.
 */
export async function cleanupRememberedLogins(
  options: { retentionDays?: number; now?: Date } = {},
): Promise<{ families: number; credentials: number }> {
  const retentionDays = options.retentionDays ?? 30;
  return withoutTenantScope("platform", async () => {
    const families = await query(
      `DELETE FROM remembered_login_families
        WHERE absolute_expires_at < now() - ($1::int * interval '1 day')`,
      [retentionDays],
    );
    const credentials = await query(
      `DELETE FROM remembered_login_credentials c
        WHERE c.superseded_at IS NOT NULL
          AND c.superseded_at < now() - ($1::int * interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM remembered_login_credentials live
             WHERE live.family_id = c.family_id AND live.superseded_at IS NULL
          )`,
      [retentionDays],
    );
    return { families: families.rowCount ?? 0, credentials: credentials.rowCount ?? 0 };
  });
}
