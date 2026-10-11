/**
 * Issue #854 (invariant 12) — one writer for every personal-security audit row,
 * and one stated policy for what happens when that write fails.
 *
 * ## Why this module exists
 *
 * The MFA and recovery surfaces had **no** audit writes at all: enrolling a
 * factor, confirming one with a code, removing one, changing which is primary,
 * regenerating recovery codes and every session revocation either wrote nothing
 * or wrote through a local helper that ended in `.catch(() => {})`. A security
 * invariant that says "every sensitive mutation is audited" cannot rest on
 * writes whose failures are invisible, and two of those surfaces contradicted
 * the shipped documentation — which claimed events that the code never emitted.
 *
 * ## The failure policy, stated once
 *
 * A security audit row is not telemetry; it is part of the mutation. So:
 *
 *  1. **When the caller has a transaction, the audit goes inside it.** Pass the
 *     client and the audit commits with the state change or not at all. There is
 *     no window in which the factor is gone and nothing says so. Every lifecycle
 *     mutation in `mfa-service` does this.
 *  2. **When the mutation has already committed, the audit must still be
 *     durable** — the write is retried once, and if it fails again the error is
 *     logged loudly and rethrown. It is never swallowed. A caller that gets a
 *     5xx while the mutation in fact succeeded has an operator-visible,
 *     contradictable record; a caller that gets a 200 on an unlogged credential
 *     change has nothing.
 *  3. **Nothing secret is ever logged.** The payload carries facts — which
 *     method, how many codes remain, which session ids — and never a code, a
 *     recovery credential, a token, a hash or a TOTP secret. `assertSecretFree`
 *     enforces that on the way in rather than leaving it to review, because the
 *     one time somebody passes `{ code }` for convenience is the one time it
 *     matters.
 *
 * ## Realms
 *
 * The tenant realm writes `audit_log` (business-scoped, RLS-protected, the table
 * the tenant's own audit screen reads). The platform realm writes
 * `platform_audit_log` (no tenant column; a platform administrator's factor is
 * not any business's business). They are separate on purpose — the same
 * separation the cookies and JWT realms have — and `recordSecurityAudit` takes
 * the realm from the caller rather than guessing it from the ids.
 */
import { query } from "./db";

/**
 * The minimum a writer needs from a connection.
 *
 * Structural rather than `Pick<PoolClient, "query">` so both the pool's
 * `query(text, params)` and a transaction client satisfy it — `pg`'s own
 * `query` is overloaded three ways, and the narrow structural form is what both
 * call sites actually use.
 */
export type AuditExecutor = {
  query(text: string, params?: unknown[]): Promise<unknown>;
};

/** Things that must never reach an audit row. Matched on key name. */
const FORBIDDEN_PAYLOAD_KEYS = [
  "code",
  "otp",
  "secret",
  "token",
  "password",
  "recoverycode",
  "recoverycodes",
  "hash",
  "credential",
  "challenge",
] as const;

export class SecretInAuditPayloadError extends Error {
  constructor(key: string) {
    super(
      `security audit payload refused: key "${key}" looks like a secret; ` +
        `audit rows record facts (which factor, how many, which id), never credentials`,
    );
    this.name = "SecretInAuditPayloadError";
  }
}

/**
 * Refuse a payload whose keys name a secret.
 *
 * Deliberately a key-name check and not a value-shape heuristic: a 6-digit code
 * and a "count: 6" are indistinguishable by value, and a heuristic that guesses
 * wrong in the permissive direction is worse than none. Key names are what a
 * reviewer reads, so they are what is enforced.
 */
export function assertSecretFree(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    const offending = FORBIDDEN_PAYLOAD_KEYS.find(
      (forbidden) =>
        normalized === forbidden ||
        normalized.endsWith(forbidden) ||
        normalized.startsWith(forbidden),
    );
    // `recoveryCodesRemaining` and `revokedCount` are facts; `recoveryCodes` is
    // the credential. Suffix matching catches the latter, so the allowlist below
    // names the counting spellings explicitly rather than loosening the rule.
    if (offending && !ALLOWED_FACT_KEYS.has(normalized)) {
      throw new SecretInAuditPayloadError(key);
    }
  }
}

/**
 * Spellings that contain a forbidden word but are counts or flags, not
 * credentials. Each one has to be added deliberately, with its reason.
 */
const ALLOWED_FACT_KEYS: ReadonlySet<string> = new Set([
  // "7 codes left" — a count the Profile card shows, not a code.
  "recoverycodesremaining",
  // "the recovery path was used" — a boolean, not a credential.
  "usedrecoverycode",
  "recoverycoderegenerated",
  // "the challenge was consumed" — a fact about the challenge, not its code.
  "challengeconsumed",
  "challengeid",
  // "the credential row" — an id or kind, never its secret.
  "credentialid",
  "credentialtype",
]);

/**
 * Who and where, with the action left to the writer.
 *
 * The lifecycle services know *which* action they are recording (they are the
 * ones changing the state); the route knows *who* is doing it and which business
 * to file it under. This type is the second half, so a caller cannot pass an
 * action that disagrees with the write it rides on.
 */
export type SecurityAuditAttribution = Omit<SecurityAuditEntry, "realm" | "action">;

export interface SecurityAuditEntry {
  /** Which realm's table this row belongs to. */
  realm: "tenant" | "platform";
  action: string;
  /** Facts only. Validated by `assertSecretFree`. */
  payload?: Record<string, unknown>;
  /** Tenant realm: the business the row is filed under. */
  businessId?: string | null;
  /** The membership that acted (tenant realm). */
  actorUserId?: string | null;
  /** The global identity the mutation was about. */
  platformUserId?: string | null;
  /** Entity kind/id for the audit screen's grouping. */
  entity?: string;
  entityId?: string | null;
}

const RETRY_DELAY_MS = 25;

/** The pool, viewed as the narrow executor this module needs. */
function poolExecutor(): AuditExecutor {
  return {
    query: (text: string, params?: unknown[]) => query(text, params),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write one security audit row.
 *
 * Pass `executor` (a `PoolClient` inside a transaction) to make the row atomic
 * with the mutation it describes — the preferred form, and the one every MFA
 * lifecycle mutation uses. Without it the row is written on its own connection,
 * retried once, and any remaining failure is logged and rethrown per the module
 * policy above.
 */
export async function recordSecurityAudit(
  entry: SecurityAuditEntry,
  executor?: AuditExecutor,
): Promise<void> {
  const payload = entry.payload ?? {};
  assertSecretFree(payload);

  if (entry.realm === "platform") {
    const write = async (run: AuditExecutor) =>
      run.query(
        `INSERT INTO platform_audit_log (platform_admin_id, business_id, action, entity, entity_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.platformUserId ?? entry.actorUserId ?? null,
          entry.businessId ?? null,
          entry.action,
          entry.entity ?? "platform_admin",
          entry.entityId ?? entry.platformUserId ?? null,
          JSON.stringify(payload),
        ],
      );
    if (executor) {
      await write(executor);
      return;
    }
    await runWithRetry("security audit (platform)", () => write(poolExecutor()));
    return;
  }

  if (!entry.businessId) {
    // A tenant row with no business has nowhere to live and would be filed
    // under NULL, which the audit screen reads as "every business". Refuse
    // rather than write it: a misplaced audit row is worse than a loud error.
    throw new Error("security audit requires a businessId in the tenant realm");
  }

  const write = async (run: AuditExecutor) =>
    run.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.businessId,
        entry.actorUserId ?? null,
        entry.action,
        entry.entity ?? "user",
        entry.entityId ?? entry.actorUserId ?? entry.platformUserId ?? null,
        JSON.stringify({
          ...payload,
          ...(entry.platformUserId ? { platformUserId: entry.platformUserId } : {}),
        }),
      ],
    );

  if (executor) {
    await write(executor);
    return;
  }
  await runWithRetry("security audit (tenant)", () => write(poolExecutor()));
}

/**
 * Retry once, then fail loudly. Never swallow.
 *
 * The single retry is for the transient class (a dropped pooled connection, a
 * serialization failure) where an immediate second attempt on a fresh
 * connection almost always succeeds. Anything else is a real problem an operator
 * needs to see, and hiding it behind a resolved promise is how a credential
 * mutation ends up with no record at all.
 */
async function runWithRetry(label: string, attempt: () => Promise<unknown>): Promise<void> {
  try {
    await attempt();
    return;
  } catch (first) {
    await sleep(RETRY_DELAY_MS);
    try {
      await attempt();
      console.warn(`${label}: audit write failed once, retry succeeded`);
      return;
    } catch (second) {
      console.error(`${label}: audit write failed twice`, second);
      throw second;
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers — the actions the issue names
// ---------------------------------------------------------------------------

/**
 * Every personal-security mutation this issue requires to be audited, in one
 * place so the list is readable and greppable.
 */
export const SECURITY_AUDIT_ACTIONS = {
  mfaEnrolStarted: "auth.mfa_enrol_started",
  mfaEnrolConfirmed: "auth.mfa_enrol_confirmed",
  mfaFactorRemoved: "auth.mfa_factor_removed",
  mfaFactorReplaced: "auth.mfa_factor_replaced",
  mfaPrimaryChanged: "auth.mfa_primary_changed",
  recoveryCodesRegenerated: "auth.mfa_recovery_codes_regenerated",
  recoveryCodeUsed: "auth.mfa_recovery_code_used",
  mfaChallengeSent: "auth.mfa_challenge_sent",
  stepUpSucceeded: "auth.step_up_succeeded",
  stepUpFailed: "auth.step_up_failed",
  sessionRevoked: "self.session_revoked",
  sessionsRevokedOthers: "self.sessions_revoked_others",
  signedOutEverywhere: "self.signed_out_everywhere",
} as const;

export type SecurityAuditAction =
  (typeof SECURITY_AUDIT_ACTIONS)[keyof typeof SECURITY_AUDIT_ACTIONS];
