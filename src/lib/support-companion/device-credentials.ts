/**
 * Issue #984 — support-only device identity for the Windows companion.
 *
 * The companion cannot borrow the main app's sync bearer token: that token is
 * sealed inside the main database's settings, exactly the database that may be
 * down when support is needed. Enrollment provisions an independent
 * support-device credential instead:
 *
 * - The tenant owner starts enrollment from their own session and reads a
 *   short single-use claim code (shown once, 30-minute expiry).
 * - The companion generates its own secret locally, and completes enrollment
 *   by presenting the claim code plus that secret over TLS. The server stores
 *   sha256(secret) only — the secret itself is DPAPI-sealed on the device and
 *   never leaves it again except as aBearer it presents.
 * - Every later device call presents the bearer; the hash resolves the
 *   installation/business (documented `support-companion-device-auth` bypass,
 *   the server-sync-auth shape), then everything runs tenant-scoped.
 *
 * Enrollment never activates Hybrid transaction sync and never bypasses #974's
 * activation gates — it only scopes support evidence and assistance to this
 * install. Rotation is staged (the old credential survives 24h until the new
 * one confirms), mirroring `site-device-service.ts`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { query, withTenant, withoutTenantScope } from "../db";

export interface SupportDeviceIdentity {
  businessId: string;
  locationId: string | null;
  installationId: string;
  siteDeviceId: string | null;
  credentialId: string;
  credentialState: "active" | "staged";
}

/** Crockford-ish alphabet without ambiguous characters, grouped XXXX-XXXX. */
function randomClaimCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) code += "-";
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashEqualsHex(aHex: string, bClear: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = createHash("sha256").update(bClear, "utf8").digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_CLAIM_ATTEMPTS = 5;

export interface BeginEnrollmentInput {
  businessId: string;
  approvedBy: string;
  siteDeviceId?: string | null;
  installationId?: string | null;
}

/**
 * Starts an owner-approved enrollment. Returns the claim code exactly once —
 * it is never stored or re-readable, only its hash.
 */
export async function beginEnrollment(input: BeginEnrollmentInput): Promise<{
  enrollmentId: string;
  claimCode: string;
  expiresAt: string;
}> {
  const claimCode = randomClaimCode();
  const { rows } = await query<{ id: string; expires_at: string }>(
    `INSERT INTO support_enrollments
       (business_id, installation_id, site_device_id, claim_code_hash, approved_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text AS id, expires_at::text AS expires_at`,
    [
      input.businessId,
      input.installationId ?? null,
      input.siteDeviceId ?? null,
      sha256Hex(claimCode),
      input.approvedBy,
    ],
  );
  return { enrollmentId: rows[0].id, claimCode, expiresAt: rows[0].expires_at };
}

export type CompleteEnrollmentResult =
  | { ok: true; installationId: string }
  | {
      ok: false;
      error:
        | "enrollment_not_found"
        | "enrollment_expired"
        | "claim_rejected"
        | "credential_rejected"
        | "installation_not_found";
    };

/**
 * Completes enrollment: the companion presents the claim code plus its own
 * locally-generated secret. The secret travels once over TLS and is stored
 * hash-only. For local-only installs the installation row is created here;
 * for hybrid it must already exist (bound at begin).
 */
export async function completeEnrollment(input: {
  enrollmentId: string;
  claimCode: string;
  credential: string;
  installation?: { displayName?: string; osBuild?: string | null; companionVersion?: string | null };
}): Promise<CompleteEnrollmentResult> {
  if (typeof input.credential !== "string" || input.credential.length < 32) {
    return { ok: false, error: "credential_rejected" };
  }
  return withoutTenantScope("support-companion-device-auth", async () => {
    const { rows } = await query<{
      id: string;
      business_id: string;
      installation_id: string | null;
      site_device_id: string | null;
      claim_code_hash: string;
      claim_attempts: number;
      state: string;
      expires_at: string;
    }>(
      `SELECT id::text AS id, business_id::text AS business_id,
              installation_id::text AS installation_id, site_device_id::text AS site_device_id,
              claim_code_hash, claim_attempts, state, expires_at::text AS expires_at
         FROM support_enrollments WHERE id = $1::uuid`,
      [input.enrollmentId],
    );
    const enrollment = rows[0];
    if (!enrollment || enrollment.state === "revoked") {
      return { ok: false, error: "enrollment_not_found" } as const;
    }
    if (
      enrollment.state === "expired" ||
      enrollment.state === "claimed" ||
      Date.parse(enrollment.expires_at) <= Date.now()
    ) {
      if (enrollment.state === "pending") {
        await query(`UPDATE support_enrollments SET state = 'expired' WHERE id = $1::uuid`, [
          input.enrollmentId,
        ]);
      }
      return { ok: false, error: "enrollment_expired" } as const;
    }
    if (!hashEqualsHex(enrollment.claim_code_hash, input.claimCode.trim())) {
      const attempts = enrollment.claim_attempts + 1;
      await query(
        `UPDATE support_enrollments
            SET claim_attempts = $2::integer,
                state = CASE WHEN $2::integer >= $3::integer THEN 'expired' ELSE state END
          WHERE id = $1::uuid`,
        [input.enrollmentId, attempts, MAX_CLAIM_ATTEMPTS],
      );
      return { ok: false, error: "claim_rejected" } as const;
    }

    return withTenant(enrollment.business_id, async () => {
      let installationId = enrollment.installation_id;
      if (!installationId) {
        // Local-only install: create the support-only installation row. No
        // site_devices entry, no sync activation — support scope only.
        const created = await query<{ id: string }>(
          `INSERT INTO support_installations
             (business_id, site_device_id, display_name, platform, os_build,
              companion_version, enrollment_state)
           VALUES ($1, NULL, $2, 'windows', $3, $4, 'active')
           RETURNING id::text AS id`,
          [
            enrollment.business_id,
            (input.installation?.displayName ?? "Support companion").slice(0, 200),
            input.installation?.osBuild ?? null,
            input.installation?.companionVersion ?? null,
          ],
        );
        installationId = created.rows[0].id;
      } else {
        const { rows: live } = await query<{ id: string }>(
          `SELECT id FROM support_installations WHERE id = $1::uuid AND business_id = $2`,
          [installationId, enrollment.business_id],
        );
        if (!live[0]) return { ok: false, error: "installation_not_found" } as const;
        await query(
          `UPDATE support_installations
              SET enrollment_state = 'active', revoked_at = NULL, updated_at = now(),
                  display_name = COALESCE(NULLIF($3, ''), display_name),
                  companion_version = COALESCE($4, companion_version)
            WHERE id = $1::uuid AND business_id = $2`,
          [
            installationId,
            enrollment.business_id,
            input.installation?.displayName?.slice(0, 200) ?? "",
            input.installation?.companionVersion ?? null,
          ],
        );
      }
      await query(
        `INSERT INTO support_device_credentials (business_id, installation_id, credential_hash, state)
         VALUES ($1, $2::uuid, $3, 'active')`,
        [enrollment.business_id, installationId, sha256Hex(input.credential)],
      );
      await query(
        `UPDATE support_enrollments SET state = 'claimed', installation_id = $2::uuid WHERE id = $1::uuid`,
        [input.enrollmentId, installationId],
      );
      return { ok: true, installationId } as const;
    });
  });
}

/**
 * Resolves a presented support-device bearer to its installation/business.
 * Returns null for unknown, revoked, expired or unenrolled credentials —
 * without distinguishing which, so the response cannot oracle credential
 * existence. Staged (rotating) credentials verify; promotion is explicit.
 */
export async function verifySupportDeviceCredential(
  bearer: string,
): Promise<SupportDeviceIdentity | null> {
  if (!bearer || bearer.length < 16) return null;
  const hash = sha256Hex(bearer);
  return withoutTenantScope("support-companion-device-auth", async () => {
    const { rows } = await query<{
      business_id: string;
      location_id: string | null;
      installation_id: string;
      site_device_id: string | null;
      credential_id: string;
      credential_state: "active" | "staged";
    }>(
      `SELECT c.business_id::text AS business_id, i.location_id::text AS location_id,
              c.installation_id::text AS installation_id, i.site_device_id::text AS site_device_id,
              c.id::text AS credential_id, c.state AS credential_state
         FROM support_device_credentials c
         JOIN support_installations i
           ON i.id = c.installation_id AND i.business_id = c.business_id
        WHERE c.credential_hash = $1 AND c.state IN ('active', 'staged')
          AND c.revoked_at IS NULL AND (c.valid_until IS NULL OR c.valid_until > now())
          AND i.enrollment_state = 'active'`,
      [hash],
    );
    const found = rows[0];
    if (!found) return null;
    await query(`UPDATE support_device_credentials SET last_seen_at = now() WHERE id = $1::uuid`, [
      found.credential_id,
    ]).catch(() => {});
    return {
      businessId: found.business_id,
      locationId: found.location_id,
      installationId: found.installation_id,
      siteDeviceId: found.site_device_id,
      credentialId: found.credential_id,
      credentialState: found.credential_state,
    };
  });
}

export type RotateCredentialResult =
  | { ok: true; staged: true }
  | { ok: false; error: "credential_rejected" | "device_not_found" };

/**
 * Stages a replacement credential. The current one keeps working until the
 * companion confirms the new one (or 24h passes) — a crash between server
 * rotation and the local DPAPI write cannot brick the device.
 */
export async function rotateSupportDeviceCredential(input: {
  businessId: string;
  installationId: string;
  currentBearer: string;
  newCredential: string;
}): Promise<RotateCredentialResult> {
  if (typeof input.newCredential !== "string" || input.newCredential.length < 32) {
    return { ok: false, error: "credential_rejected" };
  }
  const identity = await verifySupportDeviceCredential(input.currentBearer);
  if (
    !identity ||
    identity.businessId !== input.businessId ||
    identity.installationId !== input.installationId
  ) {
    return { ok: false, error: "device_not_found" };
  }
  return withTenant(input.businessId, async () => {
    await query(
      `INSERT INTO support_device_credentials
         (business_id, installation_id, credential_hash, state, valid_until)
       VALUES ($1, $2::uuid, $3, 'staged', now() + interval '24 hours')`,
      [input.businessId, input.installationId, sha256Hex(input.newCredential)],
    );
    return { ok: true, staged: true } as const;
  });
}

export type ConfirmRotationResult =
  | { ok: true }
  | { ok: false; error: "device_not_found" };

/** Promotes the staged credential and revokes every other one. */
export async function confirmSupportDeviceRotation(input: {
  businessId: string;
  installationId: string;
  newBearer: string;
}): Promise<ConfirmRotationResult> {
  const identity = await verifySupportDeviceCredential(input.newBearer);
  if (
    !identity ||
    identity.businessId !== input.businessId ||
    identity.installationId !== input.installationId ||
    identity.credentialState !== "staged"
  ) {
    return { ok: false, error: "device_not_found" };
  }
  return withTenant(input.businessId, async () => {
    await query(
      `UPDATE support_device_credentials
          SET state = 'active', valid_until = NULL, rotated_at = now()
        WHERE id = $1::uuid AND business_id = $2`,
      [identity.credentialId, input.businessId],
    );
    await query(
      `UPDATE support_device_credentials
          SET state = 'revoked', revoked_at = now()
        WHERE installation_id = $1::uuid AND business_id = $2 AND id <> $3::uuid
          AND state <> 'revoked'`,
      [input.installationId, input.businessId, identity.credentialId],
    );
    return { ok: true } as const;
  });
}

/** Revokes every credential of an installation (owner action, or on installation revoke). */
export async function revokeSupportDeviceCredentials(
  businessId: string,
  installationId: string,
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE support_device_credentials
        SET state = 'revoked', revoked_at = now()
      WHERE installation_id = $1::uuid AND business_id = $2 AND state <> 'revoked'`,
    [installationId, businessId],
  );
  return rowCount ?? 0;
}

export type EnrollmentDecisionResult = { ok: true } | { ok: false; error: "enrollment_not_found" };

/** Owner cancels a pending enrollment (e.g. the claim code leaked). */
export async function revokeEnrollment(
  businessId: string,
  enrollmentId: string,
): Promise<EnrollmentDecisionResult> {
  const { rowCount } = await query(
    `UPDATE support_enrollments SET state = 'revoked'
      WHERE id = $1::uuid AND business_id = $2 AND state = 'pending'`,
    [enrollmentId, businessId],
  );
  return rowCount ? { ok: true } : { ok: false, error: "enrollment_not_found" };
}

export interface PendingEnrollment {
  id: string;
  siteDeviceId: string | null;
  installationId: string | null;
  claimAttempts: number;
  state: string;
  expiresAt: string;
  createdAt: string;
}

/** Pending enrollments an owner can review/revoke. Claim codes are never re-readable. */
export async function listPendingEnrollments(businessId: string): Promise<PendingEnrollment[]> {
  const { rows } = await query<{
    id: string;
    site_device_id: string | null;
    installation_id: string | null;
    claim_attempts: number;
    state: string;
    expires_at: string;
    created_at: string;
  }>(
    `SELECT id::text AS id, site_device_id::text AS site_device_id,
            installation_id::text AS installation_id, claim_attempts, state,
            expires_at::text AS expires_at, created_at::text AS created_at
       FROM support_enrollments
      WHERE business_id = $1 AND state = 'pending'
      ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    siteDeviceId: row.site_device_id,
    installationId: row.installation_id,
    claimAttempts: row.claim_attempts,
    state: row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}
