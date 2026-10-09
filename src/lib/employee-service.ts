/**
 * Phase 20 Wave 1 — employee identity: the DB-touching half (not unit-tested
 * directly, per repo convention; the pure rules it uses live in employee.ts
 * and team.ts and are covered by their own *.test.ts files).
 *
 * Every function here takes businessId explicitly and includes it in every
 * WHERE/JOIN condition — RLS already confines all of this to one tenant, but
 * matching team-service.ts's belt-and-suspenders style keeps the intent
 * readable without relying on RLS alone.
 *
 * Not wired into any route yet: the PIN-login route and JWT session model
 * (src/app/api/auth/pin-login/route.ts, auth-edge.ts) are untouched by this
 * wave. This module is the foundation Wave 2 (Login Experience Redesign)
 * will call into.
 */
import { PASSWORD_ROLES_SQL, STAFF_PIN_ROLES_SQL } from "./login-eligibility";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "@/lib/password-hashing";
import type { PoolClient } from "pg";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import { getPool, query, withoutTenantScope } from "./db";
import { hostRoutingEnabled, leadingHostLabel, parseHost, rootDomain } from "./host";
import { postgresDateToIso } from "./jalali";
import { resolveBusinessByLabel } from "./host-resolution";
import { isValidPin } from "./team";
import { readDeploymentProfile } from "./deployment-mode";
import {
  generateSessionToken,
  isIssuableCredentialType,
  lockoutStatus,
  sessionExpiry,
  LOGIN_LOCKOUT_THRESHOLD,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  type EmployeeCredentialType,
  type LockoutStatus,
} from "./employee";
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type CredentialDescriptor,
} from "./webauthn";
import {
  employeeLoginMode,
  memberPhoneState,
  pinWindowActive,
  type EmployeeLoginMode,
  type MemberPhoneState,
} from "./phone-otp-policy";
import { phoneOtpEnforcementFor } from "./phone-otp";

export class EmployeeError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Anything that can run a statement — a pooled client, or the pool itself. */
interface Executor {
  query: PoolClient["query"];
}

async function auditEmployee(
  client: Executor,
  params: {
    businessId: string;
    actorId: string | null;
    action: string;
    employeeId: string;
    payload?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'employee', $4, $5)`,
    [
      params.businessId,
      params.actorId,
      params.action,
      params.employeeId,
      JSON.stringify(params.payload ?? null),
    ],
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export interface EmployeeProfile {
  id: string;
  businessId: string;
  employeeCode: string | null;
  phone: string | null;
  photoUrl: string | null;
  hiredAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EmployeeRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  employee_code: string | null;
  phone: string | null;
  photo_url: string | null;
  hired_at: Date | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: EmployeeRow): EmployeeProfile {
  return {
    id: row.id,
    businessId: row.business_id,
    employeeCode: row.employee_code,
    phone: row.phone,
    photoUrl: row.photo_url,
    // users.hired_at is a Postgres `date` (local-midnight Date from
    // node-postgres) — see postgresDateToIso for why toISOString is wrong.
    hiredAt: row.hired_at ? postgresDateToIso(row.hired_at) : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Creates the employee profile row for a membership if it doesn't exist yet,
 * and returns it either way. `employeeId` is users.id — employees is a 1:1
 * extension of an existing membership, not a new identity of its own.
 */
export async function ensureEmployeeProfile(
  employeeId: string,
  businessId: string,
): Promise<EmployeeProfile> {
  const { rows } = await query<EmployeeRow>(
    `INSERT INTO employees (id, business_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET updated_at = employees.updated_at
     RETURNING id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at`,
    [employeeId, businessId],
  );
  return toProfile(rows[0]);
}

export async function getEmployeeProfile(
  employeeId: string,
  businessId: string,
): Promise<EmployeeProfile | null> {
  const { rows } = await query<EmployeeRow>(
    `SELECT id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at
       FROM employees WHERE id = $1 AND business_id = $2`,
    [employeeId, businessId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

export interface UpdateEmployeeProfileInput {
  employeeCode?: string | null;
  phone?: string | null;
  photoUrl?: string | null;
  hiredAt?: string | null;
  notes?: string | null;
}

export async function updateEmployeeProfile(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  input: UpdateEmployeeProfileInput,
): Promise<EmployeeProfile> {
  await ensureEmployeeProfile(employeeId, businessId);
  const { rows } = await query<EmployeeRow>(
    `UPDATE employees
        SET employee_code = COALESCE($3, employee_code),
            phone = COALESCE($4, phone),
            photo_url = COALESCE($5, photo_url),
            hired_at = COALESCE($6, hired_at),
            notes = COALESCE($7, notes),
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING id, business_id, employee_code, phone, photo_url, hired_at, notes, created_at, updated_at`,
    [
      employeeId,
      businessId,
      input.employeeCode ?? null,
      input.phone ?? null,
      input.photoUrl ?? null,
      input.hiredAt ?? null,
      input.notes ?? null,
    ],
  );
  if (!rows[0]) throw new EmployeeError("employee_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.profile_updated",
    employeeId,
    payload: input,
  });
  return toProfile(rows[0]);
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface EmployeeCredentialSummary {
  id: string;
  employeeId: string;
  credentialType: EmployeeCredentialType;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  credential_type: EmployeeCredentialType;
  status: "active" | "revoked";
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}

function toCredentialSummary(row: CredentialRow): EmployeeCredentialSummary {
  return {
    id: row.id,
    employeeId: row.employee_id,
    credentialType: row.credential_type,
    status: row.status,
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export async function listCredentials(
  employeeId: string,
  businessId: string,
): Promise<EmployeeCredentialSummary[]> {
  const { rows } = await query<CredentialRow>(
    `SELECT id, employee_id, credential_type, status, last_used_at, created_at, revoked_at
       FROM employee_credentials
      WHERE employee_id = $1 AND business_id = $2
      ORDER BY created_at DESC`,
    [employeeId, businessId],
  );
  return rows.map(toCredentialSummary);
}

/**
 * Issues a new credential, revoking any previously active credential of the
 * same type first — an employee has at most one live PIN at a time. Only
 * `pin` is issuable in Wave 1 (see employee.ts's ISSUABLE_CREDENTIAL_TYPES).
 */
export async function issueCredential(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  credentialType: EmployeeCredentialType,
  secret: string,
): Promise<EmployeeCredentialSummary> {
  if (!isIssuableCredentialType(credentialType)) {
    throw new EmployeeError("credential_type_not_issuable");
  }
  if (credentialType === "pin" && !isValidPin(secret)) {
    throw new EmployeeError("invalid_pin");
  }

  await ensureEmployeeProfile(employeeId, businessId);
  const secretHash = await bcrypt.hash(secret, BCRYPT_COST);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE employee_credentials
          SET status = 'revoked', revoked_at = now()
        WHERE employee_id = $1 AND business_id = $2 AND credential_type = $3 AND status = 'active'`,
      [employeeId, businessId, credentialType],
    );
    const { rows } = await client.query<CredentialRow>(
      `INSERT INTO employee_credentials (employee_id, business_id, credential_type, secret_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, employee_id, credential_type, status, last_used_at, created_at, revoked_at`,
      [employeeId, businessId, credentialType, secretHash],
    );
    await auditEmployee(client, {
      businessId,
      actorId,
      action: "employee.credential_issued",
      employeeId,
      payload: { credentialType },
    });
    await client.query("COMMIT");
    return toCredentialSummary(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeCredential(
  credentialId: string,
  businessId: string,
  actorId: string | null,
  /** Wave 3 — pass the caller's own employee id for a self-service revoke, so a guessed credential id belonging to someone else can't be revoked; omitted for an admin-initiated revoke. */
  ownerEmployeeId?: string,
): Promise<void> {
  const params = [credentialId, businessId];
  let ownerFilter = "";
  if (ownerEmployeeId) {
    params.push(ownerEmployeeId);
    ownerFilter = "AND employee_id = $3";
  }
  const { rows } = await query<{ employee_id: string }>(
    `UPDATE employee_credentials
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active' ${ownerFilter}
      RETURNING employee_id`,
    params,
  );
  if (!rows[0]) throw new EmployeeError("credential_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.credential_revoked",
    employeeId: rows[0].employee_id,
    payload: { credentialId },
  });
}

/**
 * Checks a presented secret against every active credential of the given
 * type in the business, the same linear bcrypt-compare scan pin-login and
 * isPinTaken already use for the low-entropy, per-business-unique PIN case —
 * hashed secrets can't be looked up by equality.
 */
export async function verifyCredential(
  businessId: string,
  credentialType: EmployeeCredentialType,
  secret: string,
): Promise<string | null> {
  const { rows } = await query<{ id: string; employee_id: string; secret_hash: string }>(
    `SELECT id, employee_id, secret_hash
       FROM employee_credentials
      WHERE business_id = $1 AND credential_type = $2 AND status = 'active'`,
    [businessId, credentialType],
  );
  for (const row of rows) {
    if (await bcrypt.compare(secret, row.secret_hash)) {
      await query(`UPDATE employee_credentials SET last_used_at = now() WHERE id = $1`, [row.id]);
      return row.employee_id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebAuthn (Wave 3 — biometric authentication)
// ---------------------------------------------------------------------------
//
// A parallel path alongside issueCredential/verifyCredential above, not a
// caller of them: those two are built around a bcrypt-hashed shared secret,
// which a public-key credential isn't (see employee.ts's
// ISSUABLE_CREDENTIAL_TYPES comment). webauthn.ts owns the cryptography;
// everything here is what employee_credentials needs around it — resolving
// which rows to exclude/allow in a ceremony, and persisting what a verified
// one returns.

interface WebauthnCredentialRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  webauthn_credential_id: string;
  webauthn_public_key: string;
  webauthn_sign_count: string;
  webauthn_transports: string[] | null;
  display_hint: string | null;
  device_label: string | null;
  created_at: Date;
  last_used_at: Date | null;
}

/**
 * `deviceId` narrows to credentials registered on that one paired device
 * (Wave 4) OR never bound to a device at all (`device_id IS NULL` — every
 * credential registered before this wave, or from a terminal that was never
 * paired) — never to *only* device-bound rows, so an unpaired employee or
 * terminal keeps Wave 3's unnarrowed behaviour. Omitting `deviceId` (or
 * passing null/undefined) applies no filter at all — used by registration's
 * exclude-list and by the self-service "your devices" listing, where every
 * one of the employee's own credentials is the right answer regardless of
 * which device the caller happens to be browsing from right now.
 */
async function activeWebauthnCredentials(
  employeeId: string,
  businessId: string,
  deviceId?: string | null,
): Promise<WebauthnCredentialRow[]> {
  const { rows } = await query<WebauthnCredentialRow>(
    `SELECT c.id, c.employee_id, c.webauthn_credential_id, c.webauthn_public_key, c.webauthn_sign_count,
            c.webauthn_transports, c.display_hint, d.label AS device_label, c.created_at, c.last_used_at
       FROM employee_credentials c
       LEFT JOIN pos_devices d ON d.id = c.device_id
      WHERE c.employee_id = $1 AND c.business_id = $2 AND c.credential_type = 'webauthn' AND c.status = 'active'
        AND ($3::uuid IS NULL OR c.device_id = $3 OR c.device_id IS NULL)`,
    [employeeId, businessId, deviceId ?? null],
  );
  return rows;
}

function toDescriptor(row: WebauthnCredentialRow): CredentialDescriptor {
  return {
    id: row.webauthn_credential_id,
    transports: (row.webauthn_transports as AuthenticatorTransportFuture[] | null) ?? null,
  };
}

export interface WebauthnCredentialSummary {
  id: string;
  label: string | null;
  /** The paired device (Wave 4) this credential was registered from, or null if it was registered before pairing existed or from an unpaired terminal — never narrowed, always the true owner's view. */
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** The caller's own registered authenticators — for a self-service "your devices" list, never exposed to another employee. */
export async function listWebauthnCredentials(
  employeeId: string,
  businessId: string,
): Promise<WebauthnCredentialSummary[]> {
  const rows = await activeWebauthnCredentials(employeeId, businessId);
  return rows.map((row) => ({
    id: row.id,
    label: row.display_hint,
    deviceLabel: row.device_label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  }));
}

/** Step 1 of registering a new authenticator — self-service, called by the already-authenticated employee. */
export async function beginWebauthnRegistration(
  employeeId: string,
  businessId: string,
  displayName: string,
) {
  await ensureEmployeeProfile(employeeId, businessId);
  const existing = await activeWebauthnCredentials(employeeId, businessId);
  return buildRegistrationOptions(employeeId, businessId, displayName, existing.map(toDescriptor));
}

/**
 * Step 2: verifies what the authenticator returned and stores the new
 * credential. `deviceId` (Wave 4) — resolved by the route from a device
 * token the caller's browser may be carrying — binds the new credential to
 * that one paired terminal so the login picker/ceremony only offer it there;
 * omitted (no token, or an unpaired terminal), the credential stays visible
 * everywhere, exactly as Wave 3 behaved.
 */
export async function completeWebauthnRegistration(
  employeeId: string,
  businessId: string,
  actorId: string | null,
  response: RegistrationResponseJSON,
  challengeToken: string,
  deviceLabel?: string | null,
  deviceId?: string | null,
  /** The origins the ceremony may have been performed on — see expectedOriginsFor. */
  origins?: string | string[],
): Promise<EmployeeCredentialSummary> {
  const verified = await verifyRegistration(employeeId, businessId, response, challengeToken, origins);
  if (!verified) throw new EmployeeError("webauthn_verification_failed");

  await ensureEmployeeProfile(employeeId, businessId);
  try {
    const { rows } = await query<CredentialRow>(
      `INSERT INTO employee_credentials
         (employee_id, business_id, credential_type, display_hint,
          webauthn_credential_id, webauthn_public_key, webauthn_sign_count, webauthn_transports, device_id)
       VALUES ($1, $2, 'webauthn', $3, $4, $5, $6, $7, $8)
       RETURNING id, employee_id, credential_type, status, last_used_at, created_at, revoked_at`,
      [
        employeeId,
        businessId,
        deviceLabel ?? null,
        verified.credentialId,
        verified.publicKey,
        verified.signCount,
        verified.transports,
        deviceId ?? null,
      ],
    );
    await auditEmployee(getPool(), {
      businessId,
      actorId,
      action: "employee.webauthn_registered",
      employeeId,
      payload: { credentialId: rows[0].id },
    });
    return toCredentialSummary(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new EmployeeError("credential_already_registered");
    }
    throw err;
  }
}

/**
 * Step 1 of a biometric login — public, called before any session exists.
 * `employeeId` is already known (the picker chose them before offering PIN
 * or biometric, same as pin-login's `employeeId` narrowing); null means this
 * employee has no active authenticator to offer *on this device* (Wave 4's
 * `deviceId`, resolved by the route from a device token — see
 * activeWebauthnCredentials), so the caller falls back to the PIN pad
 * instead of showing a biometric prompt with nothing to sign.
 */
export async function beginWebauthnAuthentication(
  employeeId: string,
  businessId: string,
  deviceId?: string | null,
) {
  const existing = await activeWebauthnCredentials(employeeId, businessId, deviceId);
  if (existing.length === 0) return null;
  return buildAuthenticationOptions(employeeId, businessId, existing.map(toDescriptor));
}

/**
 * Step 2: verifies the signed assertion against whichever of the employee's
 * credentials it claims to be (`response.id`), advances that row's signature
 * counter (replay/clone detection), and returns the credential id used —
 * `pin-login`-style session/JWT minting happens in the route, same as PIN.
 *
 * Deliberately not device-filtered, unlike step 1: `deviceId` only narrows
 * what step 1 *offers*, it is never part of what proves the assertion — an
 * authenticator's signature over the challenge is the entire security
 * boundary, so a device-id mismatch here would just be second-guessing a
 * cryptographic proof that already succeeded.
 */
export async function completeWebauthnAuthentication(
  employeeId: string,
  businessId: string,
  response: AuthenticationResponseJSON,
  challengeToken: string,
  /** The origins the ceremony may have been performed on — see expectedOriginsFor. */
  origins?: string | string[],
): Promise<{ credentialId: string } | null> {
  const candidates = await activeWebauthnCredentials(employeeId, businessId);
  const match = candidates.find((row) => row.webauthn_credential_id === response.id);
  if (!match) return null;

  const result = await verifyAuthentication(
    employeeId,
    businessId,
    response,
    challengeToken,
    {
      credentialId: match.webauthn_credential_id,
      publicKey: match.webauthn_public_key,
      signCount: Number(match.webauthn_sign_count),
      transports: (match.webauthn_transports as AuthenticatorTransportFuture[] | null) ?? null,
    },
    origins,
  );
  if (!result) return null;

  await query(
    `UPDATE employee_credentials SET webauthn_sign_count = $2, last_used_at = now() WHERE id = $1`,
    [match.id, result.newSignCount],
  );
  return { credentialId: match.id };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface EmployeeSession {
  id: string;
  employeeId: string;
  businessId: string;
  locationId: string | null;
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  business_id: string;
  location_id: string | null;
  issued_at: Date;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function toSession(row: SessionRow): EmployeeSession {
  return {
    id: row.id,
    employeeId: row.employee_id,
    businessId: row.business_id,
    locationId: row.location_id,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export interface CreateSessionInput {
  locationId?: string | null;
  credentialId?: string | null;
  deviceLabel?: string | null;
  /** The paired device (Wave 4) this session was opened from, if the login route resolved one — lets revoking that device revoke this session too (see device-service.ts's revokeDevice). */
  deviceId?: string | null;
}

/** Issues a new, server-side-revocable session and returns the one-time plaintext token alongside it. */
export async function createSession(
  employeeId: string,
  businessId: string,
  input: CreateSessionInput = {},
): Promise<{ token: string; session: EmployeeSession }> {
  await ensureEmployeeProfile(employeeId, businessId);
  const { token, tokenHash } = generateSessionToken();
  const { rows } = await query<SessionRow>(
    `INSERT INTO employee_sessions
       (employee_id, business_id, location_id, credential_id, token_hash, device_label, device_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, employee_id, business_id, location_id, issued_at, expires_at, last_seen_at, revoked_at`,
    [
      employeeId,
      businessId,
      input.locationId ?? null,
      input.credentialId ?? null,
      tokenHash,
      input.deviceLabel ?? null,
      input.deviceId ?? null,
      sessionExpiry(),
    ],
  );
  const session = toSession(rows[0]);
  // Phase 20 Wave 6 — the first audit_log row a login itself ever produces
  // (earlier waves only audited revocation). credentialId/deviceId are
  // carried in the payload rather than resolved to a label here so
  // audit-service.ts's read side can join employee_credentials/pos_devices
  // live, the same "read back on demand, don't duplicate" choice
  // shift-service.ts made for a shift's cash summary.
  await auditEmployee(getPool(), {
    businessId,
    actorId: employeeId,
    action: "employee.session_created",
    employeeId,
    payload: { sessionId: session.id, credentialId: input.credentialId ?? null, deviceId: input.deviceId ?? null },
  });
  return { token, session };
}

export async function listActiveSessions(
  employeeId: string,
  businessId: string,
): Promise<EmployeeSession[]> {
  const { rows } = await query<SessionRow>(
    `SELECT id, employee_id, business_id, location_id, issued_at, expires_at, last_seen_at, revoked_at
       FROM employee_sessions
      WHERE employee_id = $1 AND business_id = $2 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY issued_at DESC`,
    [employeeId, businessId],
  );
  return rows.map(toSession);
}

export interface ActiveSessionSummary {
  id: string;
  employeeId: string;
  employeeName: string;
  role: string;
  locationId: string | null;
  /** The paired device (Wave 4) this session was opened from, or the raw user-agent snippet recorded at login when no device was paired — never both. */
  deviceLabel: string | null;
  /** Presence alone says how this session was opened — see audit.ts's `credentialKindFromId` (null means PIN). */
  credentialId: string | null;
  issuedAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
}

interface ActiveSessionRow extends Record<string, unknown> {
  id: string;
  employee_id: string;
  employee_name: string;
  role: string;
  location_id: string | null;
  device_label: string | null;
  credential_id: string | null;
  issued_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
}

/**
 * Business-wide "who is currently signed in, on which device" (Wave 7 —
 * resolves this doc's Wave 6 open question 4: `listActiveSessions` above has
 * existed since Wave 1 but was never reachable through any route). Mirrors
 * `listShifts`/`listAuditLog`'s own business-wide, most-recent-first shape
 * for the same `team.manage` admin audience.
 */
export async function listActiveSessionsForBusiness(businessId: string): Promise<ActiveSessionSummary[]> {
  const { rows } = await query<ActiveSessionRow>(
    `SELECT s.id, s.employee_id, u.full_name AS employee_name, u.role::text AS role,
            s.location_id, coalesce(s.device_label, d.label) AS device_label,
            s.credential_id, s.issued_at, s.last_seen_at, s.expires_at
       FROM employee_sessions s
       JOIN users u ON u.id = s.employee_id
       LEFT JOIN pos_devices d ON d.id = s.device_id
      WHERE s.business_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
      ORDER BY s.issued_at DESC`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    role: row.role,
    locationId: row.location_id,
    deviceLabel: row.device_label,
    credentialId: row.credential_id,
    issuedAt: row.issued_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    expiresAt: row.expires_at.toISOString(),
  }));
}

/**
 * Records a failed PIN or biometric login attempt (Wave 7 — resolves this
 * doc's Wave 6 open question 3). No actor: nothing was authenticated, so
 * `user_id` stays null the same way an anonymous request already reads
 * `audit_log.user_id`; `employeeId` (when the attempt named one — the Wave 2
 * picker or a webauthn ceremony always does, a bare legacy PIN scan may not)
 * goes in `entity_id` so audit-service.ts's `listAuditLog` can resolve it
 * back to a name via its `entityName` join, same pattern as
 * `credentialType`/`deviceLabel`.
 */
export async function auditLoginFailure(
  businessId: string,
  employeeId: string | null,
  reason: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, NULL, 'employee.login_failed', 'employee', $2, $3)`,
    [businessId, employeeId, JSON.stringify({ reason })],
  );
}

// ---------------------------------------------------------------------------
// Login lockout (Wave 8 — resolves this doc's Wave 7 open question 2: does a
// pattern of failed attempts trigger anything beyond being visible?)
// ---------------------------------------------------------------------------

/** Kept in one place so checkLoginLockout and listLockedEmployees read the exact same rows. */
const LOCKOUT_ACTIONS = ["employee.login_failed", "employee.session_created", "employee.login_unlocked"];

/**
 * Whether `employeeId` is currently locked out of PIN/biometric login.
 * Reads the same `audit_log` rows Wave 6/7 already write (LOGIN_LOCKOUT_THRESHOLD
 * of the most recent ones is always enough to answer this), so no new table —
 * the same "computed on demand" choice this phase already made for a shift's
 * cash summary and a session's credential/device label.
 */
export async function checkLoginLockout(businessId: string, employeeId: string): Promise<LockoutStatus> {
  const { rows } = await query<{ action: string; created_at: Date }>(
    `SELECT action, created_at
       FROM audit_log
      WHERE business_id = $1 AND entity = 'employee' AND entity_id = $2 AND action = ANY($3)
      ORDER BY id DESC
      LIMIT $4`,
    [businessId, employeeId, LOCKOUT_ACTIONS, LOGIN_LOCKOUT_THRESHOLD],
  );
  return lockoutStatus(rows.map((row) => ({ action: row.action, createdAt: row.created_at })));
}

export interface LockedEmployeeSummary {
  employeeId: string;
  employeeName: string;
  failedCount: number;
  lockedUntil: string;
}

/**
 * Business-wide "who is currently locked out" for the security center tab —
 * one window-function query instead of one checkLoginLockout round trip per
 * employee, the same N+1 Wave 7 already fixed for shift cash variance
 * (listShifts's LATERAL join). Computes the identical rule lockoutStatus does:
 * a leading, unbroken run of LOGIN_LOCKOUT_THRESHOLD-or-more `employee.login_failed`
 * rows, still within LOGIN_LOCKOUT_WINDOW_MINUTES of the most recent one.
 */
export async function listLockedEmployees(businessId: string): Promise<LockedEmployeeSummary[]> {
  const { rows } = await query<{
    employee_id: string;
    employee_name: string;
    failed_count: string;
    last_failed_at: Date;
  }>(
    `WITH ranked AS (
       SELECT nullif(entity_id, '')::uuid AS employee_id, action, created_at,
              row_number() OVER (PARTITION BY entity_id ORDER BY id DESC) AS rn
         FROM audit_log
        WHERE business_id = $1 AND entity = 'employee' AND entity_id IS NOT NULL AND action = ANY($2)
     ),
     windowed AS (
       SELECT employee_id,
              count(*) AS failed_count,
              bool_or(action <> 'employee.login_failed') AS hit_break,
              max(created_at) AS last_failed_at
         FROM ranked
        WHERE rn <= $3
        GROUP BY employee_id
     )
     SELECT w.employee_id, u.full_name AS employee_name, w.failed_count, w.last_failed_at
       FROM windowed w
       JOIN users u ON u.id = w.employee_id
      WHERE w.failed_count >= $3
        AND NOT w.hit_break
        AND w.last_failed_at > now() - make_interval(mins => $4::int)
      ORDER BY w.last_failed_at DESC`,
    [businessId, LOCKOUT_ACTIONS, LOGIN_LOCKOUT_THRESHOLD, LOGIN_LOCKOUT_WINDOW_MINUTES],
  );
  return rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    failedCount: Number(row.failed_count),
    lockedUntil: new Date(row.last_failed_at.getTime() + LOGIN_LOCKOUT_WINDOW_MINUTES * 60_000).toISOString(),
  }));
}

/**
 * Admin override — ends a lockout immediately (e.g. the employee confirmed
 * by phone) rather than waiting out LOGIN_LOCKOUT_WINDOW_MINUTES. Writes the
 * same `employee.login_unlocked` row that breaks the streak for both
 * checkLoginLockout and listLockedEmployees above.
 */
export async function clearLoginLockout(
  businessId: string,
  employeeId: string,
  actorId: string | null,
): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND business_id = $2`,
    [employeeId, businessId],
  );
  if (!rows[0]) throw new EmployeeError("employee_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.login_unlocked",
    employeeId,
  });
}

export async function touchSession(sessionId: string, businessId: string): Promise<void> {
  await query(
    `UPDATE employee_sessions SET last_seen_at = now() WHERE id = $1 AND business_id = $2`,
    [sessionId, businessId],
  );
}

export async function revokeSession(
  sessionId: string,
  businessId: string,
  actorId: string | null,
): Promise<void> {
  const { rows } = await query<{ employee_id: string }>(
    `UPDATE employee_sessions
        SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING employee_id`,
    [sessionId, businessId],
  );
  // Its own code: `session_not_found` belongs to table (میز) sessions, whose
  // mapped Persian message reads «نشست میز پیدا نشد.» — nonsense when what the
  // owner was ending was an employee's login from the security center.
  if (!rows[0]) throw new EmployeeError("employee_session_not_found", 404);
  await auditEmployee(getPool(), {
    businessId,
    actorId,
    action: "employee.session_revoked",
    employeeId: rows[0].employee_id,
    payload: { sessionId },
  });
}

// ---------------------------------------------------------------------------
// Login (Wave 2 — Login Experience Redesign)
// ---------------------------------------------------------------------------

/**
 * Resolves which business a PIN-login-family request (the PIN itself, the
 * employee-picker roster that precedes it, or a biometric ceremony) is for.
 * Lifted verbatim out of `pin-login/route.ts` (Wave 1 predates this module
 * having a caller for it) so `pin-login/roster/route.ts` doesn't duplicate the
 * same business-scoping rules — see that route's original comment for why each
 * fallback exists.
 *
 * **The host decides, when there is one.** Under subdomain routing the origin
 * *is* the tenant, so it outranks everything in the body: a request that
 * arrived on `acme.$ROOT_DOMAIN` is acme's, whatever it claims. This is both
 * the boundary (a body naming another business must not reach that business's
 * roster) and the only thing that makes these routes work at all on a
 * multi-tenant deployment — the last fallback below answers "the only active
 * business", which on a platform holding two is `business_required`, i.e. no
 * cashier could sign in.
 *
 * A login that arrives on the apex, the console host, or an unknown name is
 * refused rather than falling back to the body: on a host-routed deployment
 * there is no legitimate PIN login anywhere but a business's own origin.
 *
 * With host tenancy **off** the host is not the boundary, but it is still the
 * best hint available: the first label is matched against `businesses`
 * (see `leadingHostLabel`) before the last-resort "the only active business",
 * so a platform serving several businesses from `{subdomain}.{domain}` with
 * `ROOT_DOMAIN` unset keeps a working staff login instead of refusing every
 * one of them with `business_required`.
 */
export async function resolveLoginBusinessId(body: {
  businessId?: string;
  businessSlug?: string;
  locationId?: string;
  /** The request's `Host` header, so the origin can answer first. */
  host?: string | null;
}): Promise<{ businessId: string | null; error: string | null }> {
  if (hostRoutingEnabled()) {
    const parsed = parseHost(body.host, rootDomain());
    if (parsed.kind !== "business") return { businessId: null, error: "unknown_business" };
    const business = await resolveBusinessByLabel(parsed.label);
    // An alias host (a business's old name after a rename) must not mint a
    // session for the same reason /api/auth/login refuses it: the session
    // would name the *current* subdomain on a cookie scoped to the old host,
    // which middleware then rejects on the next request. The canonical host
    // is where the login family runs; aliases only forward there.
    if (!business || business.status !== "active" || business.viaAlias) {
      return { businessId: null, error: "unknown_business" };
    }
    return { businessId: business.businessId, error: null };
  }

  return withoutTenantScope("login", async () => {
    if (body.businessId) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE id = $1 AND status = 'active'`,
        [body.businessId],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.businessSlug) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM businesses WHERE slug = $1 AND status = 'active'`,
        [body.businessSlug],
      );
      return { businessId: rows[0]?.id ?? null, error: rows[0] ? null : "unknown_business" };
    }

    if (body.locationId) {
      const { rows } = await query<{ business_id: string }>(
        `SELECT l.business_id FROM locations l
           JOIN businesses b ON b.id = l.business_id
          WHERE l.id = $1 AND b.status = 'active'`,
        [body.locationId],
      );
      return {
        businessId: rows[0]?.business_id ?? null,
        error: rows[0] ? null : "unknown_location",
      };
    }

    // Host tenancy is off, but the origin may still name its business.
    //
    // A deployment reached at `titea.app.eshobe.com` with no `ROOT_DOMAIN`
    // (or with `SUBDOMAIN_ROUTING=off` while its wildcard certificate is
    // sorted out) parses every host as "unknown", so nothing above answers
    // and the fallback below refuses outright the moment a second business
    // exists — which is how the staff picker came to say «دریافت فهرست
    // کارکنان ممکن نشد» on an origin whose first label is a business's own
    // subdomain. The owner's email login was unaffected because it resolves
    // a tenant from that person's memberships instead, which is exactly the
    // "admin works, staff doesn't" shape this fixes.
    //
    // This is a lookup, not a guess: the label decides nothing unless a
    // `businesses` row (or one of its rename aliases) claims it. Nor is it a
    // boundary being relaxed — with host routing off the session cookie is
    // not host-scoped and `handleHostIsolation` does not run, so no origin
    // check depends on which host a session was minted from; the PIN is
    // still checked against an employee of the business resolved here.
    const label = leadingHostLabel(body.host);
    if (label) {
      const { rows } = await query<{ id: string }>(
        `SELECT b.id
           FROM businesses b
          WHERE b.status = 'active'
            AND (b.subdomain = $1
                 OR EXISTS (SELECT 1
                              FROM business_subdomain_aliases a
                             WHERE a.business_id = b.id AND a.alias = $1))
          LIMIT 1`,
        [label],
      );
      if (rows[0]) return { businessId: rows[0].id, error: null };
    }

    const { rows } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE status = 'active' LIMIT 2`,
    );
    if (rows.length === 1) return { businessId: rows[0].id, error: null };
    return { businessId: null, error: rows.length === 0 ? "unknown_business" : "business_required" };
  });
}

export interface LoginRosterEntry {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
  /** Wave 3 — whether the login screen should offer a biometric prompt for this name before falling back to the PIN pad. */
  hasWebauthn: boolean;
  /**
   * Phase 42 — which step the door shows after this name is picked: the PIN
   * pad, the OTP screen, or the PIN pad followed by a set-and-verify number.
   * Computed server-side (employeeLoginMode) from the business's phone-OTP
   * policy plus this member's phone state and 7-day window, so the client
   * never re-derives a security decision.
   */
  loginMode: EmployeeLoginMode;
  /** Phase 42 — this member's phone state, for the door's optional «تأیید شماره» nudge during the adoption window. */
  phoneState: MemberPhoneState;
}

interface RosterRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  role: string;
  photo_url: string | null;
  has_webauthn: boolean;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  otp_login_at: Date | null;
}

/**
 * The name+photo picker shown before the PIN pad (Wave 2). Deliberately the
 * same eligibility rule pin-login itself checks (`is_active`, a PIN role, a
 * PIN actually set) so a name never appears here that pin-login would then
 * reject — and nothing more sensitive than a name, role, and photo (plus,
 * since Wave 3, a plain boolean for whether a biometric prompt makes sense,
 * and since Phase 42 a coarse phone state, never the number itself) is
 * returned, since this runs before any credential has been presented.
 *
 * `deviceId` (Wave 4) — resolved by the route from a device token the
 * caller's browser may be carrying — narrows `hasWebauthn` to credentials
 * actually registered on this terminal (or never bound to one); an unpaired
 * terminal passes no deviceId and sees exactly Wave 3's unnarrowed roster.
 */
export async function loginRoster(
  businessId: string,
  locationId?: string | null,
  deviceId?: string | null,
): Promise<LoginRosterEntry[]> {
  const profile = (await readDeploymentProfile(businessId)).profile;
  const allowPrivilegedSitePin = profile === "hybrid" || profile === "local";
  const params: unknown[] = [deviceId ?? null, allowPrivilegedSitePin];
  let locationFilter = "";
  if (locationId) {
    params.push(locationId);
    locationFilter = "AND u.location_id = $3";
  }
  const { rows } = await query<RosterRow>(
    `SELECT u.id, u.full_name, u.role::text AS role, e.photo_url,
            u.phone_e164, u.phone_verified_at, u.otp_login_at,
            EXISTS (
              SELECT 1 FROM employee_credentials c
               WHERE c.employee_id = u.id AND c.credential_type = 'webauthn' AND c.status = 'active'
                 AND ($1::uuid IS NULL OR c.device_id = $1 OR c.device_id IS NULL)
            ) AS has_webauthn
       FROM users u
       LEFT JOIN employees e ON e.id = u.id
      WHERE u.is_active
        AND (u.role IN ${STAFF_PIN_ROLES_SQL} OR ($2::boolean AND u.role IN ${PASSWORD_ROLES_SQL}))
        AND (u.pin_hash IS NOT NULL OR EXISTS (
          SELECT 1 FROM employee_credentials pin
           WHERE pin.employee_id = u.id AND pin.business_id = u.business_id
             AND pin.credential_type = 'pin' AND pin.status = 'active'
        ))
        ${locationFilter}
      ORDER BY u.full_name`,
    params,
  );

  // Phase 42 — one policy read for the whole roster, then the per-member
  // step is pure (employeeLoginMode): verified-number members inside their
  // 7-day window keep the PIN pad, everyone else is routed to the OTP.
  const { state } = await phoneOtpEnforcementFor(businessId);
  return rows.map((row) => {
    const phoneState = memberPhoneState(row.phone_e164, row.phone_verified_at);
    return {
      id: row.id,
      fullName: row.full_name,
      role: row.role,
      photoUrl: row.photo_url,
      hasWebauthn: row.has_webauthn,
      loginMode: employeeLoginMode({
        enforcement: state,
        phoneState,
        pinWindow: pinWindowActive(row.otp_login_at),
      }),
      phoneState,
    };
  });
}
