/**
 * Issue #1115 §A.3 — the database half of browser-based Hybrid enrollment
 * (see `desktop-enroll.ts` for the protocol and why it exists).
 *
 * Two callers with no tenant context at all — the unpaired Windows app — read
 * and poll these rows, so those two functions run under the same documented
 * bypass pairing redemption uses and prove themselves with the device secret.
 * Everything the owner does (listing, approving, denying) runs inside the
 * ordinary tenant scope, so RLS confines the row to the business whose host
 * served the browser page.
 *
 * Only a SHA-256 of the device secret and an AES-encrypted pairing code are
 * stored, plus the id of the code that ciphertext holds. The code is minted by
 * the existing `issuePairingCode`, which means
 * browser approval and a typed code are the *same* credential going through
 * the *same* two-phase redemption — including its one-live-code-per-branch
 * rule: approving a browser request retires an older unused code for that
 * branch exactly as issuing a new one from the panel does.
 */
import {
  query,
  withTenant,
  withTenantTransaction,
  withoutTenantScope,
  withoutTenantScopeTransaction,
} from "./db";
import {
  deviceSecretMatches,
  ENROLLMENT_TTL_SECONDS,
  generateUserCode,
  pollEnrollment,
  type EnrollmentPoll,
  type EnrollmentState,
} from "./desktop-enroll";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./integrations/secrets";
import { issuePairingCode, revokePairingCode } from "./pairing-service";
import type { EnrollmentReadiness } from "./desktop-enrollment-readiness";
import { readEnrollmentReadiness } from "./desktop-enrollment-readiness-service";

type RequestRow = {
  id: string;
  business_id: string;
  installation_id: string;
  device_name: string;
  device_secret_hash: string;
  user_code: string;
  max_snapshot_version: number | null;
  state: EnrollmentState;
  location_id: string | null;
  pairing_code_ciphertext: string | null;
  pairing_code_id: string | null;
  expires_at: Date;
};

const ROW_COLUMNS = `id, business_id, installation_id, device_name, device_secret_hash, user_code,
                     max_snapshot_version, state, location_id, pairing_code_ciphertext,
                     pairing_code_id, expires_at`;

/**
 * Retire the pairing code an approval sealed against an enrollment row.
 *
 * That code exists only to be handed to the one device that holds the secret.
 * Once the reservation is denied or has run out, nothing may redeem it, so the
 * live code is revoked too — otherwise an abandoned approval keeps consuming
 * the branch's one-live-code slot for its whole TTL, long after the request it
 * belonged to is gone.
 *
 * The row records the code's id, so this names the code directly instead of
 * decrypting the sealed copy only to re-hash it into a lookup. Runs in the
 * caller's scope and is filtered by the row's own business id either way.
 * Returns whether a live code was actually retired — false also means the
 * device already redeemed it.
 */
async function revokeSealedPairingCode(
  businessId: string,
  pairingCodeId: string | null,
): Promise<boolean> {
  if (!pairingCodeId) return false;
  return revokePairingCode(businessId, pairingCodeId);
}

export interface StartedEnrollment {
  requestId: string;
  userCode: string;
  expiresAt: string;
}

/**
 * Reserve a pending enrollment for one install.
 *
 * Restarting the flow always supersedes the previous reservation for the same
 * installation, so a crashed first run cannot leave a pile of live codes and
 * the row an owner might confirm is always the current one.
 */
export async function startEnrollmentRequest(input: {
  businessId: string;
  installationId: string;
  deviceName: string;
  deviceSecretHash: string;
}): Promise<StartedEnrollment> {
  return withoutTenantScopeTransaction("desktop-enroll", async () => {
    // Restarting supersedes whatever this install still has live — including an
    // approval whose code was never redeemed — and revokes any code such an
    // approval sealed, so superseding it cannot leave a redeemable credential
    // behind.
    const { rows: superseded } = await query<{
      business_id: string;
      pairing_code_id: string | null;
    }>(
      `SELECT business_id, pairing_code_id
         FROM desktop_enrollment_requests
        WHERE business_id = $1 AND installation_id = $2
          AND state IN ('pending', 'approved')`,
      [input.businessId, input.installationId],
    );
    for (const row of superseded) {
      await revokeSealedPairingCode(row.business_id, row.pairing_code_id);
    }
    await query(
      `UPDATE desktop_enrollment_requests
          SET state = 'expired', pairing_code_ciphertext = NULL, pairing_code_id = NULL
        WHERE business_id = $1 AND installation_id = $2
          AND state IN ('pending', 'approved')`,
      [input.businessId, input.installationId],
    );
    // The unique live-code index can, very rarely, collide; retry with a fresh
    // value rather than surfacing a database error to a first-run wizard.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userCode = generateUserCode();
      try {
        const { rows } = await query<RequestRow>(
          `INSERT INTO desktop_enrollment_requests
             (business_id, installation_id, device_name, device_secret_hash, user_code, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
           RETURNING ${ROW_COLUMNS}`,
          [
            input.businessId,
            input.installationId,
            input.deviceName,
            input.deviceSecretHash,
            userCode,
            ENROLLMENT_TTL_SECONDS,
          ],
        );
        const row = rows[0];
        return { requestId: row.id, userCode: row.user_code, expiresAt: row.expires_at.toISOString() };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "23505" || attempt === 2) throw error;
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new Error("desktop enrollment: could not allocate a user code");
  });
}

/**
 * The app's poll. The request id alone is not a credential — without the
 * device secret every answer is `not_found`, which is also the answer for a
 * request that never existed, so the endpoint cannot be used to probe ids.
 */
export async function pollEnrollmentRequest(input: {
  requestId: string;
  deviceSecret: string;
}): Promise<EnrollmentPoll> {
  return withoutTenantScope("desktop-enroll", async () => {
    const { rows } = await query<RequestRow>(
      `SELECT ${ROW_COLUMNS} FROM desktop_enrollment_requests WHERE id = $1`,
      [input.requestId],
    );
    const row = rows[0];
    if (!row) return { status: "not_found" as const };
    if (!deviceSecretMatches(input.deviceSecret, row.device_secret_hash)) {
      return { status: "not_found" as const };
    }
    const now = new Date();
    if (
      row.expires_at.getTime() <= now.getTime() &&
      (row.state === "pending" || row.state === "approved")
    ) {
      // Expiry is terminal, so the approval's sealed code goes with it: a code
      // minted for a reservation that ran out must not stay redeemable.
      await revokeSealedPairingCode(row.business_id, row.pairing_code_id);
      await query(
        `UPDATE desktop_enrollment_requests
            SET state = 'expired', pairing_code_ciphertext = NULL, pairing_code_id = NULL
          WHERE id = $1 AND state IN ('pending', 'approved')`,
        [row.id],
      );
      row.state = "expired";
      row.pairing_code_ciphertext = null;
    }
    let pairingCode: string | null = null;
    if (row.state === "approved" && row.pairing_code_ciphertext) {
      try {
        pairingCode = decryptSecret(row.pairing_code_ciphertext, resolveEncryptionKey(process.env));
      } catch {
        // A row whose code cannot be decrypted must not read as approved: the
        // owner approves again, which re-mints it.
        pairingCode = null;
      }
    }
    await query(
      `UPDATE desktop_enrollment_requests SET last_polled_at = now() WHERE id = $1`,
      [row.id],
    ).catch(() => {
      // Telemetry only; a failed touch must never fail the poll.
    });
    return pollEnrollment(
      {
        state: row.state === "expired" ? "pending" : row.state,
        expiresAt: row.expires_at,
        hasPairingCode: pairingCode !== null,
      },
      pairingCode,
      now,
    );
  });
}

export interface EnrollmentRequestSummary {
  id: string;
  businessName: string;
  deviceName: string;
  installationId: string;
  userCode: string;
  state: EnrollmentState;
  expiresAt: string;
  maxSnapshotVersion: number | null;
  locationId: string | null;
  approvedAt: string | null;
}

/** The Cloud page's read: tenant-scoped, so only that business's owner sees it. */
export async function readEnrollmentRequest(
  businessId: string,
  requestId: string,
): Promise<EnrollmentRequestSummary | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<RequestRow & { approved_at: Date | null; business_name: string }>(
      `SELECT r.id, r.business_id, r.installation_id, r.device_name, r.device_secret_hash,
              r.user_code, r.max_snapshot_version, r.state, r.location_id,
              r.pairing_code_ciphertext, r.expires_at, r.approved_at,
              b.name AS business_name
         FROM desktop_enrollment_requests r
         JOIN businesses b ON b.id = r.business_id
        WHERE r.id = $1 AND r.business_id = $2`,
      [requestId, businessId],
    );
    const row = rows[0];
    if (!row) return null;
    const expired = row.state === "pending" && row.expires_at.getTime() <= Date.now();
    return {
      id: row.id,
      businessName: row.business_name,
      deviceName: row.device_name,
      installationId: row.installation_id,
      userCode: row.user_code,
      state: expired ? "expired" : row.state,
      expiresAt: row.expires_at.toISOString(),
      maxSnapshotVersion: row.max_snapshot_version,
      locationId: row.location_id,
      approvedAt: row.approved_at?.toISOString() ?? null,
    };
  });
}

/**
 * The owner's confirmation.
 *
 * Readiness is checked *before* anything is claimed, from persisted Cloud state
 * and for the branch actually being enrolled, so a device cannot be reserved
 * for a business whose setup is unfinished: the page shows the missing steps
 * and the owner resumes later. The pairing code is sealed against the row, and
 * only the holder of the device secret is ever handed it.
 */
export async function approveEnrollmentRequest(input: {
  businessId: string;
  requestId: string;
  locationId: string;
  approvedBy: string;
  issuedByPlatformUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: "not_found" | "not_ready"; readiness?: EnrollmentReadiness }> {
  const request = await readEnrollmentRequest(input.businessId, input.requestId);
  if (!request || request.state === "denied" || request.state === "expired") {
    return { ok: false, error: "not_found" };
  }

  const readiness = await readEnrollmentReadiness({
    businessId: input.businessId,
    locationId: input.locationId,
    clientMaxSnapshotVersion: request.maxSnapshotVersion,
  });
  if (!readiness.ready) return { ok: false, error: "not_ready", readiness };

  // Claim, mint and seal are one serialized step.
  //
  // Overlapping approvals happen in practice — a double click, two browser
  // tabs, a retry while the first response is still in flight. Minting while
  // the row still reads `approved` with no ciphertext let both of them claim
  // it and both call `issuePairingCode`, which retires the previous unused code
  // for the branch: the later approval revoked the earlier one's fresh code,
  // and that code could then be sealed into a row nobody could redeem. The
  // transaction-scoped advisory lock makes the second approver wait here; when
  // it gets in it sees the sealed ciphertext and reports the same request as
  // approved instead of minting again.
  //
  // Sealing in the same statement as the approval also means "approved without
  // a code" is never observable, and a crash before it leaves the request
  // pending — the owner simply approves again (see `canApprove`).
  return withTenantTransaction(input.businessId, async () => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `desktop-enroll:${input.requestId}`,
    ]);
    const { rows } = await query<{
      state: EnrollmentState;
      pairing_code_ciphertext: string | null;
      location_id: string | null;
      expires_at: Date;
    }>(
      `SELECT state, pairing_code_ciphertext, location_id, expires_at
         FROM desktop_enrollment_requests
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [input.requestId, input.businessId],
    );
    const row = rows[0];
    if (!row) return { ok: false as const, error: "not_found" as const };

    if (row.pairing_code_ciphertext) {
      // Already sealed by an earlier approve (a double click, or a retry after a
      // lost response) — that is success, not an error.
      return row.state === "approved" && row.location_id === input.locationId
        ? { ok: true as const }
        : { ok: false as const, error: "not_found" as const };
    }
    if (
      row.state === "denied" ||
      row.state === "expired" ||
      row.expires_at.getTime() <= Date.now()
    ) {
      return { ok: false as const, error: "not_found" as const };
    }

    const issued = await issuePairingCode(
      input.businessId,
      input.issuedByPlatformUserId,
      input.locationId,
    );
    if ("error" in issued) {
      // Nothing was written, so the request is still approvable once the branch
      // is valid again and nothing is stale.
      return { ok: false as const, error: "not_found" as const };
    }

    const { rowCount } = await query(
      `UPDATE desktop_enrollment_requests
          SET state = 'approved', approved_at = now(), approved_by = $3,
              location_id = $4, pairing_code_ciphertext = $5, pairing_code_id = $6
        WHERE id = $1 AND business_id = $2`,
      [
        input.requestId,
        input.businessId,
        input.approvedBy,
        input.locationId,
        encryptSecret(issued.code, resolveEncryptionKey(process.env)),
        issued.summary.id,
      ],
    );
    if (!rowCount) {
      // The seal did not land, so the freshly minted code must not stay live.
      await revokeSealedPairingCode(input.businessId, issued.summary.id);
      return { ok: false as const, error: "not_found" as const };
    }
    return { ok: true as const };
  });
}

/**
 * The owner's refusal; the app stops polling and the reservation dies.
 *
 * A refusal also ends an approval the owner already gave but has not seen the
 * device redeem yet (a second browser tab, or a change of mind): the code that
 * approval sealed is revoked in the same step, so refusing is not just a label
 * on a row while a redeemable credential stays live. Once the device has
 * redeemed it there is nothing left to refuse, and the answer is false.
 */
export async function denyEnrollmentRequest(input: {
  businessId: string;
  requestId: string;
  deniedBy: string;
}): Promise<boolean> {
  return withTenant(input.businessId, async () => {
    const { rows } = await query<{ pairing_code_id: string | null }>(
      `SELECT pairing_code_id FROM desktop_enrollment_requests
        WHERE id = $1 AND business_id = $2
          AND state IN ('pending', 'approved') AND expires_at > now()`,
      [input.requestId, input.businessId],
    );
    const row = rows[0];
    if (!row) return false;
    if (
      row.pairing_code_id &&
      !(await revokeSealedPairingCode(input.businessId, row.pairing_code_id))
    ) {
      // The device already redeemed this approval; denying it now would claim a
      // refusal that no longer means anything.
      return false;
    }
    const { rowCount } = await query(
      `UPDATE desktop_enrollment_requests
          SET state = 'denied', approved_at = now(), approved_by = $3,
              pairing_code_ciphertext = NULL, pairing_code_id = NULL
        WHERE id = $1 AND business_id = $2 AND state IN ('pending', 'approved')`,
      [input.requestId, input.businessId, input.deniedBy],
    );
    return (rowCount ?? 0) > 0;
  });
}
