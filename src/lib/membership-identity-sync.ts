/**
 * Mirror identity contact fields onto every linked business membership.
 * Call on the writer's existing transaction client, after its membership lock.
 * Per-business unique violations propagate so the entire edit rolls back.
 * Keep users.email populated: rehire relinks identities by this retained copy.
 */
/** What to copy from the identity down onto every membership row. */
export interface MembershipIdentitySync {
  /** New login email for every membership of the identity. */
  email?: string;
  /** null clears the phone; a changed number always loses verification. */
  phoneE164?: string | null;
}

/** The minimum this module needs from a connection — a pool client or a transaction client. */
interface QueryExecutor {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export async function syncMembershipIdentity(
  client: QueryExecutor,
  platformUserId: string,
  sync: MembershipIdentitySync,
): Promise<void> {
  if (sync.email !== undefined) {
    await client.query(
      `UPDATE users
          SET email = $2, updated_at = now()
        WHERE platform_user_id = $1`,
      [platformUserId, sync.email],
    );
  }
  if (sync.phoneE164 !== undefined) {
    await client.query(
      `UPDATE users
          SET phone_e164 = $2, phone_verified_at = NULL, updated_at = now()
        WHERE platform_user_id = $1`,
      [platformUserId, sync.phoneE164],
    );
  }
}
