/**
 * Identity migration diagnostics and audited conflict / national-ID remediation
 * (ESH-199 / #1384).
 *
 * Design rules:
 *   1. Never auto-merge two `platform_users` identities. If two identities
 *      historically verified the same mobile number, both identities and all
 *      their `users` memberships stay intact until a human confirms ownership
 *      or the owner proves the number again via live SMS OTP.
 *   2. Never leak raw national IDs, ciphertexts, blind-index digests, or
 *      unmasked personal contact strings in diagnostic reports.
 *   3. Every operator mutation requires an active `platform_admins` actor,
 *      runs inside an `identity`-scoped transaction, preserves the
 *      `platform_users_credential_channel` invariant, and appends an immutable
 *      row to `platform_identity_events`.
 */
import { query, withoutTenantScope, withoutTenantScopeTransaction } from "../db";
import { decryptSecret } from "../integrations/secrets";
import { getMasterKey } from "../master-key";
import { isMobilePhone, normalizePhone } from "../phone";
import { STAFF_PIN_ROLES_SQL } from "../login-eligibility";
import { nationalIdBlindIndex, normalizeNationalId } from "./identity-profile";

export interface CrossIdentityPhoneConflictEntry {
  maskedPhone: string;
  identityCount: number;
  platformUserIds: string[];
  businessIds: string[];
  membershipCount: number;
  lastVerifiedAt: string | null;
}

export interface SingleIdentityMultiPhoneConflictEntry {
  platformUserId: string;
  numberCount: number;
  maskedPhones: string[];
  businessIds: string[];
  membershipCount: number;
  lastVerifiedAt: string | null;
}

export interface PhoneAnomalyEntry {
  sourceScope: "membership" | "platform_user";
  platformUserId: string;
  businessId: string | null;
  membershipId: string | null;
  maskedRawPhone: string;
  anomalyKind: string;
  verifiedAt: string | null;
}

export type NationalIdAnomalyReason =
  | "key_unavailable"
  | "decrypt_failed"
  | "invalid_decrypted_shape"
  | "blind_index_mismatch";

export interface NationalIdAnomalyEntry {
  platformUserId: string;
  reason: NationalIdAnomalyReason;
}

export interface IdentityMigrationReport {
  generatedAt: string;
  healthy: boolean;
  summary: {
    totalIdentities: number;
    verifiedGlobalPhones: number;
    verifiedGlobalEmails: number;
    passwordlessIdentities: number;
    phoneOnlyIdentities: number;
    nationalIdStoredCount: number;
    crossIdentityPhoneConflictCount: number;
    singleIdentityMultiPhoneConflictCount: number;
    phoneAnomalyCount: number;
    nationalIdAnomalyCount: number;
    unlinkedStaffPinMemberships: number;
    unlinkedNonPinMemberships: number;
  };
  repairAuditCounts: Record<string, number>;
  crossIdentityPhoneConflicts: CrossIdentityPhoneConflictEntry[];
  singleIdentityMultiPhoneConflicts: SingleIdentityMultiPhoneConflictEntry[];
  phoneAnomalies: PhoneAnomalyEntry[];
  nationalIdAnomalies: NationalIdAnomalyEntry[];
}

/** Mask a phone number for safe operator diagnostics without exposing full PII. */
export function maskPhoneForReport(raw: string | null | undefined): string {
  if (!raw) return "<empty>";
  const trimmed = raw.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 5)}***${trimmed.slice(-3)}`;
}

function classifyNationalIdEnvelope(
  ciphertext: string,
  bidx: string,
  key: Buffer | null,
): NationalIdAnomalyReason | null {
  if (!key) return "key_unavailable";
  let plaintext: string;
  try {
    plaintext = decryptSecret(ciphertext, key);
  } catch {
    return "decrypt_failed";
  }
  const normalized = normalizeNationalId(plaintext);
  if (!normalized || normalized !== plaintext) {
    return "invalid_decrypted_shape";
  }
  if (nationalIdBlindIndex(normalized, key) !== bidx) {
    return "blind_index_mismatch";
  }
  return null;
}

/**
 * Collect a read-only, PII-redacted health report of global identity
 * invariants across `platform_users`, `users`, conflict/anomaly views, and
 * encrypted national-ID envelopes.
 */
export async function collectIdentityMigrationReport(): Promise<IdentityMigrationReport> {
  return withoutTenantScope("platform", async () => {
    const [
      countsRes,
      membershipRes,
      auditRes,
      crossConflictsRes,
      identityConflictsRes,
      phoneAnomaliesRes,
      nationalIdsRes,
    ] = await Promise.all([
      query<{
        total_identities: string;
        verified_global_phones: string;
        verified_global_emails: string;
        passwordless_identities: string;
        phone_only_identities: string;
        national_id_stored_count: string;
      }>(
        `SELECT count(*)::text AS total_identities,
                count(*) FILTER (WHERE phone_e164 IS NOT NULL AND phone_verified_at IS NOT NULL)::text AS verified_global_phones,
                count(*) FILTER (WHERE email IS NOT NULL AND email_verified_at IS NOT NULL)::text AS verified_global_emails,
                count(*) FILTER (WHERE password_hash IS NULL)::text AS passwordless_identities,
                count(*) FILTER (WHERE email IS NULL)::text AS phone_only_identities,
                count(*) FILTER (WHERE national_id_ciphertext IS NOT NULL)::text AS national_id_stored_count
           FROM platform_users`,
      ),
      query<{
        unlinked_staff_pin: string;
        unlinked_non_pin: string;
      }>(
        `SELECT count(*) FILTER (WHERE platform_user_id IS NULL AND role IN ${STAFF_PIN_ROLES_SQL})::text AS unlinked_staff_pin,
                count(*) FILTER (WHERE platform_user_id IS NULL AND role NOT IN ${STAFF_PIN_ROLES_SQL})::text AS unlinked_non_pin
           FROM users`,
      ),
      query<{ action: string; count: string }>(
        `SELECT action, count(*)::text AS count
           FROM platform_identity_events
          WHERE action IN (
            'phone_backfill_cleared',
            'phone_backfilled_normalized',
            'phone_conflict_repaired',
            'national_id_pair_cleared',
            'national_id_remediated'
          )
          GROUP BY action
          ORDER BY action`,
      ),
      query<{
        phone_e164: string;
        identity_count: number;
        platform_user_ids: string[];
        business_ids: string[];
        membership_count: number;
        last_verified_at: Date | null;
      }>(
        `SELECT phone_e164, identity_count, platform_user_ids, business_ids, membership_count, last_verified_at
           FROM v_platform_verified_phone_conflicts
          ORDER BY identity_count DESC, phone_e164 ASC`,
      ),
      query<{
        platform_user_id: string;
        number_count: number;
        phone_numbers: string[];
        last_verified_at: Date | null;
        business_ids: string[];
        membership_count: number;
      }>(
        `SELECT platform_user_id, number_count, phone_numbers, last_verified_at, business_ids, membership_count
           FROM v_platform_verified_phone_identity_conflicts
          ORDER BY number_count DESC, platform_user_id ASC`,
      ),
      query<{
        source_scope: "membership" | "platform_user";
        platform_user_id: string;
        business_id: string | null;
        membership_id: string | null;
        raw_phone: string;
        anomaly_kind: string;
        verified_at: Date | null;
      }>(
        `SELECT source_scope, platform_user_id, business_id, membership_id, raw_phone, anomaly_kind, verified_at
           FROM v_platform_verified_phone_anomalies
          ORDER BY source_scope ASC, platform_user_id ASC`,
      ),
      query<{
        id: string;
        national_id_ciphertext: string;
        national_id_bidx: string;
      }>(
        `SELECT id, national_id_ciphertext, national_id_bidx
           FROM platform_users
          WHERE national_id_ciphertext IS NOT NULL
             OR national_id_bidx IS NOT NULL
          ORDER BY id ASC`,
      ),
    ]);

    const key = getMasterKey();
    const nationalIdAnomalies: NationalIdAnomalyEntry[] = [];
    for (const row of nationalIdsRes.rows) {
      const reason = classifyNationalIdEnvelope(
        row.national_id_ciphertext,
        row.national_id_bidx,
        key,
      );
      if (reason) {
        nationalIdAnomalies.push({ platformUserId: row.id, reason });
      }
    }

    const repairAuditCounts: Record<string, number> = {};
    for (const row of auditRes.rows) {
      repairAuditCounts[row.action] = Number(row.count);
    }

    const counts = countsRes.rows[0];
    const memberships = membershipRes.rows[0];
    const unlinkedNonPinMemberships = Number(memberships?.unlinked_non_pin ?? 0);

    const crossIdentityPhoneConflicts: CrossIdentityPhoneConflictEntry[] =
      crossConflictsRes.rows.map((row) => ({
        maskedPhone: maskPhoneForReport(row.phone_e164),
        identityCount: row.identity_count,
        platformUserIds: row.platform_user_ids,
        businessIds: row.business_ids,
        membershipCount: row.membership_count,
        lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
      }));

    const singleIdentityMultiPhoneConflicts: SingleIdentityMultiPhoneConflictEntry[] =
      identityConflictsRes.rows.map((row) => ({
        platformUserId: row.platform_user_id,
        numberCount: row.number_count,
        maskedPhones: row.phone_numbers.map((p) => maskPhoneForReport(p)),
        businessIds: row.business_ids,
        membershipCount: row.membership_count,
        lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
      }));

    const phoneAnomalies: PhoneAnomalyEntry[] = phoneAnomaliesRes.rows.map((row) => ({
      sourceScope: row.source_scope,
      platformUserId: row.platform_user_id,
      businessId: row.business_id,
      membershipId: row.membership_id,
      maskedRawPhone: maskPhoneForReport(row.raw_phone),
      anomalyKind: row.anomaly_kind,
      verifiedAt: row.verified_at?.toISOString() ?? null,
    }));

    const globalPhoneAnomalies = phoneAnomalies.filter(
      (a) => a.sourceScope === "platform_user",
    ).length;

    const healthy =
      globalPhoneAnomalies === 0 &&
      nationalIdAnomalies.filter((a) => a.reason !== "key_unavailable").length === 0 &&
      unlinkedNonPinMemberships === 0;

    return {
      generatedAt: new Date().toISOString(),
      healthy,
      summary: {
        totalIdentities: Number(counts?.total_identities ?? 0),
        verifiedGlobalPhones: Number(counts?.verified_global_phones ?? 0),
        verifiedGlobalEmails: Number(counts?.verified_global_emails ?? 0),
        passwordlessIdentities: Number(counts?.passwordless_identities ?? 0),
        phoneOnlyIdentities: Number(counts?.phone_only_identities ?? 0),
        nationalIdStoredCount: Number(counts?.national_id_stored_count ?? 0),
        crossIdentityPhoneConflictCount: crossIdentityPhoneConflicts.length,
        singleIdentityMultiPhoneConflictCount: singleIdentityMultiPhoneConflicts.length,
        phoneAnomalyCount: phoneAnomalies.length,
        nationalIdAnomalyCount: nationalIdAnomalies.length,
        unlinkedStaffPinMemberships: Number(memberships?.unlinked_staff_pin ?? 0),
        unlinkedNonPinMemberships,
      },
      repairAuditCounts,
      crossIdentityPhoneConflicts,
      singleIdentityMultiPhoneConflicts,
      phoneAnomalies,
      nationalIdAnomalies,
    };
  });
}

export type RepairPhoneConflictInput =
  | {
      mode: "assign_canonical_from_membership";
      platformUserId: string;
      phone: string;
      actorPlatformAdminId: string;
    }
  | {
      mode: "clear_global_phone_for_reverification";
      platformUserId: string;
      actorPlatformAdminId: string;
    };

export type RepairPhoneConflictResult =
  | { ok: true; phoneE164: string | null }
  | {
      ok: false;
      error:
        | "forbidden"
        | "identity_missing"
        | "invalid_mobile_phone"
        | "not_verified_on_membership"
        | "cross_identity_phone_taken"
        | "credential_channel_required";
    };

async function verifyActiveAdmin(adminId: string): Promise<boolean> {
  if (!adminId) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM platform_admins WHERE id = $1 AND is_active = true`,
    [adminId],
  );
  return rows.length === 1;
}

/**
 * Audited operator resolution for a verified-phone conflict on `platform_users`.
 *
 * Never merges two identities and never touches `users` memberships; it either
 * promotes one already-verified membership mobile onto the identity (after
 * checking no other identity holds it globally) or clears the global phone on
 * an email-reachable identity so the person can complete a fresh OTP claim.
 */
export async function repairIdentityVerifiedPhoneConflict(
  input: RepairPhoneConflictInput,
): Promise<RepairPhoneConflictResult> {
  return withoutTenantScopeTransaction("identity", async () => {
    if (!(await verifyActiveAdmin(input.actorPlatformAdminId))) {
      return { ok: false as const, error: "forbidden" as const };
    }

    const { rows: identities } = await query<{
      id: string;
      email: string | null;
      phone_e164: string | null;
      phone_verified_at: Date | null;
    }>(
      `SELECT id, email::text AS email, phone_e164, phone_verified_at
         FROM platform_users
        WHERE id = $1
        FOR UPDATE`,
      [input.platformUserId],
    );
    const identity = identities[0];
    if (!identity) return { ok: false as const, error: "identity_missing" as const };

    if (input.mode === "clear_global_phone_for_reverification") {
      if (!identity.email) {
        return { ok: false as const, error: "credential_channel_required" as const };
      }
      await query(
        `UPDATE platform_users
            SET phone_e164 = NULL,
                phone_verified_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [input.platformUserId],
      );
      await query(
        `INSERT INTO platform_identity_events (
           platform_user_id, action, actor_platform_admin_id, reason_code
         ) VALUES ($1, 'phone_conflict_repaired', $2, 'operator_cleared_for_reverification')`,
        [input.platformUserId, input.actorPlatformAdminId],
      );
      return { ok: true as const, phoneE164: null };
    }

    const normalized = normalizePhone(input.phone);
    if (!normalized.e164 || !isMobilePhone(input.phone)) {
      return { ok: false as const, error: "invalid_mobile_phone" as const };
    }
    const canonical = normalized.e164;

    const { rows: membershipProofs } = await query<{ verified_at: Date }>(
      `SELECT max(u.phone_verified_at) AS verified_at
         FROM users u
        WHERE u.platform_user_id = $1
          AND u.phone_e164 IS NOT NULL
          AND u.phone_verified_at IS NOT NULL
          AND canonical_iran_mobile_e164(u.phone_e164) = $2
        HAVING count(*) > 0`,
      [input.platformUserId, canonical],
    );
    if (membershipProofs.length === 0) {
      return { ok: false as const, error: "not_verified_on_membership" as const };
    }

    const { rows: otherHolders } = await query<{ id: string }>(
      `SELECT id FROM platform_users
        WHERE id <> $1
          AND phone_e164 = $2
          AND phone_verified_at IS NOT NULL`,
      [input.platformUserId, canonical],
    );
    if (otherHolders.length > 0) {
      return { ok: false as const, error: "cross_identity_phone_taken" as const };
    }

    await query(
      `UPDATE platform_users
          SET phone_e164 = $2,
              phone_verified_at = COALESCE(phone_verified_at, $3, now()),
              updated_at = now()
        WHERE id = $1`,
      [input.platformUserId, canonical, membershipProofs[0].verified_at],
    );
    await query(
      `INSERT INTO platform_identity_events (
         platform_user_id, action, actor_platform_admin_id, reason_code
       ) VALUES ($1, 'phone_conflict_repaired', $2, 'operator_selected_membership_mobile')`,
      [input.platformUserId, input.actorPlatformAdminId],
    );
    return { ok: true as const, phoneE164: canonical };
  });
}

export type RemediateNationalIdResult =
  | { ok: true; reason: Exclude<NationalIdAnomalyReason, "key_unavailable"> }
  | {
      ok: false;
      error:
        | "forbidden"
        | "identity_missing"
        | "encryption_unavailable"
        | "not_corrupted";
    };

/**
 * Audited operator remediation for a corrupted or blind-index-mismatched
 * `(national_id_ciphertext, national_id_bidx)` pair on `platform_users`.
 *
 * Refuses `not_corrupted` when the stored pair decrypts cleanly and matches
 * its blind index, preventing accidental erasure of valid personal data.
 */
export async function remediateNationalIdAnomaly(input: {
  platformUserId: string;
  actorPlatformAdminId: string;
}): Promise<RemediateNationalIdResult> {
  const key = getMasterKey();
  if (!key) return { ok: false, error: "encryption_unavailable" };

  return withoutTenantScopeTransaction("identity", async () => {
    if (!(await verifyActiveAdmin(input.actorPlatformAdminId))) {
      return { ok: false as const, error: "forbidden" as const };
    }

    const { rows } = await query<{
      national_id_ciphertext: string | null;
      national_id_bidx: string | null;
    }>(
      `SELECT national_id_ciphertext, national_id_bidx
         FROM platform_users
        WHERE id = $1
        FOR UPDATE`,
      [input.platformUserId],
    );
    const row = rows[0];
    if (!row) return { ok: false as const, error: "identity_missing" as const };
    if (!row.national_id_ciphertext || !row.national_id_bidx) {
      return { ok: false as const, error: "not_corrupted" as const };
    }

    const anomaly = classifyNationalIdEnvelope(
      row.national_id_ciphertext,
      row.national_id_bidx,
      key,
    );
    if (!anomaly || anomaly === "key_unavailable") {
      return { ok: false as const, error: "not_corrupted" as const };
    }

    await query(
      `UPDATE platform_users
          SET national_id_ciphertext = NULL,
              national_id_bidx = NULL,
              updated_at = now()
        WHERE id = $1`,
      [input.platformUserId],
    );
    await query(
      `INSERT INTO platform_identity_events (
         platform_user_id, action, actor_platform_admin_id, reason_code
       ) VALUES ($1, 'national_id_remediated', $2, $3)`,
      [input.platformUserId, input.actorPlatformAdminId, anomaly],
    );
    return { ok: true as const, reason: anomaly };
  });
}
