/**
 * The membership → personnel-file guarantee (issue #947, TEAM-F04 / TEAM-F05).
 *
 * ## The two records, and why the link matters
 *
 * A `users` row is a business membership: it is the account, the role, the
 * branches, the credential. A `parties` row with `roles @> {Employee}` is the
 * accounting file around that person: it is what payroll and مساعده post against,
 * and it is the phone number the shift lead calls. They are deliberately separate
 * records — a supplier file needs none of the membership machinery, and a membership
 * needs no ledger account until the person is paid. `parties.employee_user_id` is the
 * one link between them, and it is what makes «the membership above and the file
 * below are two views of one person» true rather than a slogan.
 *
 * ## What was wrong (the finding)
 *
 * Every door that created a membership had its *own* answer for the file:
 *
 *   - `POST /api/team` called `ensureEmployeeParty` **after** the transaction had
 *     committed, and swallowed the error in an empty `catch`;
 *   - the setup wizard called `createMembership` and nothing else, so a business's
 *     first staff member had no file at all until somebody edited them;
 *   - invitation acceptance had a membership writer of its own
 *     (`writeInvitationMembership`) with no file step;
 *   - the rehire ceremony restored a membership and left the file to whatever the
 *     next edit did;
 *   - an IAM replica applied `membership.created` from the cloud and wrote neither.
 *
 * The old migration's backfill covered the rows that existed *then*; nothing
 * maintained the invariant afterwards. So two businesses could hold the same kind of
 * account and disagree about whether the person exists in the ledger.
 *
 * ## The guarantee
 *
 * One idempotent operation, called by every one of those paths (and by the phone
 * verification door, which moves the same field):
 *
 *   1. derive the membership's **canonical identity** from its own row — the name,
 *      the login phone and the email are the membership's, never a copy the caller
 *      supplies from somewhere else;
 *   2. create the file when it is missing, or bring the three shared fields back in
 *      line when it is stale, leaving every other field (address, notes, accounting
 *      code, category, avatar) exactly as the ledger holds it;
 *   3. when either step fails, record it in `personnel_file_drift` — durably, once
 *      per member — instead of swallowing it, and clear that record when the file
 *      matches again.
 *
 * ## Transaction boundary
 *
 * A new Team membership pins this service to its own transaction, so the
 * membership, linked party, accounting-code allocation and link audit commit or
 * roll back together. Repairs of an already-committed member (rename, phone
 * verification, replica reconciliation) remain best-effort with a durable drift
 * record: those callers must not undo the identity change the user already made.
 *
 * DB-touching, so per repo convention the pure half lives elsewhere; the decisions
 * here are all about ordering and durability, and the integration test drives them
 * against a real database.
 */
import { getPartyByEmployee, createParty, updateParty, PartyValidationError } from "./parties-service";
import { query } from "./db";
import { phoneE164 } from "./phone";

/** The three fields a membership owns, and the file mirrors. */
interface MembershipIdentity {
  displayName: string;
  phone: string | null;
  email: string | null;
}

/** Why a member's file is owed. Mirrors the CHECK on `personnel_file_drift.reason`. */
export type PersonnelFileDriftReason = "file_missing" | "identity_stale";

export interface PersonnelFileSyncResult {
  /** Whether the member now has a file carrying their canonical identity. */
  ok: boolean;
  fileId: string | null;
  reason?: PersonnelFileDriftReason;
  /** A machine-readable failure code — never a message from the database. */
  error?: string;
  /**
   * On a failure: whether the debt is *written down*. `false` means the obligation could
   * not be recorded either — the state the reconcile script prints as `recorded:false`,
   * and the one an operator has to see, because nothing will retry it from the table.
   */
  recorded?: boolean;
}

interface MembershipIdentityRow extends Record<string, unknown> {
  full_name: string;
  email: string | null;
  phone_e164: string | null;
}

/**
 * The canonical identity the file follows.
 *
 * `phoneE164()` is applied a second time on purpose: a membership's stored number is
 * already canonical when the app wrote it, and a row that predates that rule (or a
 * restored dump) must not push a non-canonical spelling into the file — the file's
 * own `phone_e164` column is what search and the OTP door match on.
 */
async function canonicalIdentity(
  businessId: string,
  userId: string,
): Promise<MembershipIdentity | null> {
  const { rows } = await query<MembershipIdentityRow>(
    `SELECT full_name, email::text AS email, phone_e164
       FROM users
      WHERE id = $1 AND business_id = $2`,
    [userId, businessId],
  );
  const member = rows[0];
  if (!member) return null;
  return {
    displayName: (member.full_name ?? "").trim(),
    phone: member.phone_e164 ? phoneE164(member.phone_e164) : null,
    email: member.email ?? null,
  };
}

/** The same three fields on an existing file, for the drift comparison. */
function fileIdentity(file: { displayName: string; phone: string | null; email: string | null }) {
  return {
    displayName: file.displayName.trim(),
    phone: file.phone ? phoneE164(file.phone) : null,
    email: file.email ?? null,
  };
}

/**
 * Is the file out of line with the membership that owns it?
 *
 * One function, because two readers ask this question and they must not answer it
 * differently: the projection (`reconcile`, below) decides whether to write, and the
 * inventory (`listPersonnelFileDebts`) decides whether to *report* — a report that
 * disagreed with the writer would either invent work or hide it. Both spellings it
 * compares are the app's canonical ones (`fileIdentity` normalizes the phone), which is
 * what keeps a legacy row from looking permanently stale.
 *
 * The email direction is deliberate and mirrored from the projection: a membership with
 * no email is not an instruction to clear the file's, so it is not a staleness either.
 */
function personnelFileIsStale(
  file: { displayName: string; phone: string | null; email: string | null },
  identity: MembershipIdentity,
): boolean {
  const current = fileIdentity(file);
  return (
    current.displayName !== identity.displayName ||
    current.phone !== identity.phone ||
    (identity.email !== null && current.email !== identity.email)
  );
}

/**
 * Records (or refreshes) the open drift row for one member.
 *
 * The partial unique index makes this the one open episode per member: a second
 * failure updates the attempt count and the error rather than stacking rows, so the
 * Team screen can say «این پرونده یک بار دیگر تلاش میشود» instead of listing the same
 * problem twenty times.
 */
export async function recordPersonnelFileDrift(params: {
  businessId: string;
  userId: string;
  reason: PersonnelFileDriftReason;
  error: string;
}): Promise<void> {
  await query(
    `INSERT INTO personnel_file_drift (business_id, user_id, reason, last_error)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, user_id) WHERE resolved_at IS NULL
     DO UPDATE SET reason = EXCLUDED.reason,
                   last_error = EXCLUDED.last_error,
                   attempts = personnel_file_drift.attempts + 1,
                   last_attempt_at = now()`,
    [params.businessId, params.userId, params.reason, params.error.slice(0, 500)],
  );
}

/**
 * Records the debt, and never lets the *recording* become the failure.
 *
 * The caller is a membership change that has already committed, so this function has to
 * answer «is it written down?» rather than raise: if `personnel_file_drift` itself is
 * unavailable (a locked table, a lost connection, a restore in progress) the request must
 * still return an explicit result instead of a 500 about a membership that exists. The
 * answer is returned so the caller can say `recorded: false` out loud.
 */
async function recordDriftBestEffort(
  businessId: string,
  userId: string,
  reason: PersonnelFileDriftReason,
  error: string,
): Promise<boolean> {
  try {
    await recordPersonnelFileDrift({ businessId, userId, reason, error });
    return true;
  } catch (recordingFailure) {
    console.error(
      `personnel file drift could not be recorded for membership ${userId}: ${
        (recordingFailure as Error)?.message ?? "unknown"
      }`,
    );
    return false;
  }
}

/**
 * Which debt a failed synchronization leaves: an identity that no longer matches
 * (`identity_stale`, the file exists but carries someone else's link) or a file that is
 * missing (`file_missing`). `employee_link_taken` is the only failure that means the
 * former — the link is held by a row the member cannot adopt.
 */
function synchronizationReason(error: unknown): PersonnelFileDriftReason {
  return error instanceof PartyValidationError && error.code === "employee_link_taken"
    ? "identity_stale"
    : "file_missing";
}

/**
 * The machine-readable code for a failed synchronization.
 *
 * `PartyValidationError` speaks first: its codes are the product's own vocabulary
 * (`employee_link_taken` is what turns a failure into a stale-identity case rather than a
 * missing file). Anything else is a statement the database refused, and for those the
 * honest identifier is PostgreSQL's SQLSTATE plus the object that refused it — a catalog
 * name, not row data, and the thing an operator looks up. Falling back to the JavaScript
 * error's own `name` alone would be worse than useless here: node-postgres sets
 * `name === "error"` for every server error, so the drift row would read `error` and say
 * nothing about what happened.
 */
function synchronizationFailureCode(error: unknown): string {
  if (error instanceof PartyValidationError) return error.code;
  const failure = error as { code?: unknown; constraint?: unknown; name?: unknown } | null;
  if (typeof failure?.code === "string" && failure.code) {
    return typeof failure.constraint === "string" && failure.constraint
      ? `${failure.code}:${failure.constraint}`
      : failure.code;
  }
  return typeof failure?.name === "string" && failure.name && failure.name !== "error"
    ? failure.name
    : "personnel_file_sync_failed";
}

/** Closes the open drift row — the file matches the membership again. */
export async function clearPersonnelFileDrift(businessId: string, userId: string): Promise<void> {
  await query(
    `UPDATE personnel_file_drift
        SET resolved_at = now()
      WHERE business_id = $1 AND user_id = $2 AND resolved_at IS NULL`,
    [businessId, userId],
  );
}

/**
 * Creates or refreshes one member's personnel file. **Never throws.**
 *
 * The caller is a membership change that has already committed: the account exists,
 * and the file is what this guarantees. A failure is recorded and reported, never
 * raised into a request that has already succeeded — the one thing that must not
 * happen is a member who exists in Team and not in the ledger with nobody knowing.
 */
export async function ensurePersonnelFileForMembership(
  businessId: string,
  userId: string,
): Promise<PersonnelFileSyncResult> {
  /**
   * Which step the failure surfaced on. It decides the honest reason and code: a
   * canonical-identity read that never returned a row compared *nothing*, so calling that
   * «identity_stale» would claim a measurement nobody made.
   */
  let stage: "identity" | "projection" = "identity";

  /*
   * ONE boundary around the whole synchronization: the identity lookup, the projection and
   * its recovery, and the drift bookkeeping itself. Each of those can fail, and until this
   * boundary was here two of them ran *outside* it — the lookup and the nameless case's
   * drift write — so a transient failure surfaced as a thrown error from a function whose
   * callers had already committed: `createMembership` had returned nothing to the client
   * while its row existed, and a retry answered «این ایمیل قبلاً استفاده شده است», or a
   * phone verification failed after its stamp. A failure here is a *result*.
   *
   * What this boundary does NOT promise: it cannot un-fail a database transaction. The
   * replica applies (`iam/sync.ts`) call this inside their own transaction, and a
   * statement-level failure there has already aborted it — the boundary keeps the caller
   * informed, it does not make the transaction committable, and a site whose transaction
   * rolled back must not pretend it recorded a membership it did not. The repair
   * obligation stays what it is: written by the database (migration 0223, and its phone
   * arm) and cleared by the one comparator in this file.
   */
  try {
    const identity = await canonicalIdentity(businessId, userId);
    // The membership is gone (offboarded and purged by a future policy, or a stale
    // event): there is nothing to guarantee and nothing to owe.
    if (!identity) return { ok: true, fileId: null };

    // A file's display name is a required column, so a nameless membership cannot be
    // given one. Refusing to invent a name is the deliberate choice: the alternative —
    // «کارمند» on a payroll row — is the kind of placeholder that ends up on a tax
    // filing. Creation and rename both require a name, so this is a data-repair case,
    // and it is recorded as one — through the recorder that cannot throw, because a
    // failure to write the note down is not a reason to fail the request.
    if (!identity.displayName) {
      const recorded = await recordDriftBestEffort(
        businessId,
        userId,
        "file_missing",
        "membership_name_missing",
      );
      return {
        ok: false,
        fileId: null,
        reason: "file_missing",
        error: "membership_name_missing",
        recorded,
      };
    }

    stage = "projection";
    return await synchronizePersonnelFile(businessId, userId, identity);
  } catch (error) {
    const code =
      stage === "identity" ? "identity_lookup_failed" : synchronizationFailureCode(error);
    const reason = synchronizationReason(error);
    console.error(
      `personnel file sync failed for membership ${userId} of business ${businessId}: ${code}`,
    );
    const recorded = await recordDriftBestEffort(businessId, userId, reason, code);
    return { ok: false, fileId: null, reason, error: code, recorded };
  }
}

/**
 * The projection half: bring an existing file in line, create one, or adopt the winner of
 * a create race. Extracted so the boundary above can wrap the stages it does not own, and
 * so this half keeps the recovery that only it can decide (a lost race is not a debt).
 */
async function synchronizePersonnelFile(
  businessId: string,
  userId: string,
  identity: MembershipIdentity,
): Promise<PersonnelFileSyncResult> {

  /**
   * Bring an existing file back in line, or confirm it already is.
   *
   * Extracted from the body below because the winner of a create race needs the same
   * treatment as a file that was already there: whichever door created it, the answer is
   * «this file is the member's, and its three shared fields follow the membership».
   */
  async function reconcile(
    file: NonNullable<Awaited<ReturnType<typeof getPartyByEmployee>>>,
    identity: MembershipIdentity,
  ): Promise<PersonnelFileSyncResult> {
    if (!personnelFileIsStale(file, identity)) {
      // A file that already agrees closes any open episode: the previous attempt may
      // have failed *after* writing, and a row left open would keep asking for a
      // repair that is not needed.
      await clearPersonnelFileDrift(businessId, userId);
      return { ok: true, fileId: file.id };
    }

    // Only the three membership-owned fields are written; everything else on the
    // file (address, notes, accounting code, category, tags, avatar) is left as the
    // ledger holds it — `updateParty` merges, and this patch names three keys.
    //
    // An email the membership does not have is not a reason to clear the file's:
    // `updateParty` would take a `null` literally. The direction of truth is
    // membership → file, and «the membership has none» is not an instruction.
    const patch: Parameters<typeof updateParty>[2] = { displayName: identity.displayName };
    patch.phone = identity.phone;
    if (identity.email !== null) patch.email = identity.email;
    await updateParty(businessId, file.id, patch);
    await clearPersonnelFileDrift(businessId, userId);
    return { ok: true, fileId: file.id };
  }

  try {
    const existing = await getPartyByEmployee(businessId, userId);
    if (existing) return await reconcile(existing, identity);

    const created = await createParty(businessId, {
      role: "Employee",
      roles: ["Employee"],
      personType: "Real",
      displayName: identity.displayName,
      firstName: identity.displayName,
      phone: identity.phone,
      email: identity.email,
      employeeUserId: userId,
    });
    await clearPersonnelFileDrift(businessId, userId);
    return { ok: true, fileId: created.id };
  } catch (error) {
    /*
     * Two doors raced for the same brand-new member — a create and an acceptance, or the
     * Team screen and the reconciliation script. `assertEmployeeLinkTarget` is a
     * check-then-write, so the loser loses to a real unique index; *which* index it loses
     * to (0137's link index, or the accounting code both computes in the same instant) is
     * not deterministic, and neither is a debt. So the question asked here is the one
     * that matters: does the member have a file now? If so it is this call's file —
     * adopt it. If the adoption itself fails, that failure is what gets recorded.
     */
    const appeared = await getPartyByEmployee(businessId, userId).catch(() => null);
    if (appeared) {
      try {
        return await reconcile(appeared, identity);
      } catch {
        // Fall through: the file exists but could not be brought in line — a real debt.
      }
    }

    const reason = synchronizationReason(error);
    const code = synchronizationFailureCode(error);
    /*
     * Logged as well as recorded. The drift row is what retries; the log line is what
     * an operator watching the process sees *now*, and this is exactly the failure the
     * issue was filed about — one that used to disappear into an empty catch.
     */
    console.error(
      `personnel file sync failed for membership ${userId} of business ${businessId}: ${code}`,
    );
    const recorded = await recordDriftBestEffort(businessId, userId, reason, code);
    return { ok: false, fileId: null, reason, error: code, recorded };
  }
}

export interface PersonnelFileDebt {
  userId: string;
  fullName: string;
  /** The linked file, or null when the member has none. */
  fileId: string | null;
  reason: PersonnelFileDriftReason;
  /** Whether `personnel_file_drift` already records this debt (it may not). */
  recorded: boolean;
}

/**
 * **The independent inventory** (issue #947, TEAM-F05).
 *
 * Which memberships are owed a personnel file — computed from `users` and `parties`
 * themselves, never from `personnel_file_drift`. That independence is the entire point:
 * a drift row is *bookkeeping about* a debt, and bookkeeping can be lost (a process that
 * died between the membership commit and the record, a writer that never recorded one,
 * an operator who cleaned the table). The debt is the difference between the two records
 * the platform actually has, and this reads it there.
 *
 * Three things follow from that, and each of them is load-bearing:
 *
 *   - **Missing and stale are both found.** A member with no file is `file_missing`; a
 *     member whose file does not carry their canonical name, phone or email is
 *     `identity_stale`. The comparison is `personnelFileIsStale`, the same function the
 *     projection writes by, so the inventory cannot demand a repair the projection would
 *     not make (or miss one it would).
 *   - **A clean drift table is not evidence of a healthy one.** A member whose obligation
 *     row was never written (or was resolved by an operator) still appears here as long as
 *     the data disagrees.
 *   - **`recorded: false` is the alarm, not a footnote.** It means the write path lost the
 *     obligation — the exact failure 0223's trigger now prevents for new memberships, and
 *     the reason `npm run personnel:reconcile` works from this list rather than from the
 *     table.
 *
 * Cost: one canonical party read per member that *has* a file. Deliberately not a leaner
 * projection of its own — a second reader of the encrypted phone column would be a second
 * opinion about a personnel file, which is what the whole finding was about.
 */
export async function listPersonnelFileDebts(businessId: string): Promise<PersonnelFileDebt[]> {
  const { rows } = await query<{
    user_id: string;
    full_name: string;
    file_id: string | null;
    recorded: boolean;
  }>(
    `SELECT u.id AS user_id, u.full_name,
            (SELECT p.id FROM parties p
              WHERE p.business_id = u.business_id AND p.employee_user_id = u.id) AS file_id,
            EXISTS (
              SELECT 1 FROM personnel_file_drift d
               WHERE d.business_id = u.business_id AND d.user_id = u.id AND d.resolved_at IS NULL
            ) AS recorded
       FROM users u
      WHERE u.business_id = $1
      ORDER BY u.created_at`,
    [businessId],
  );

  const debts: PersonnelFileDebt[] = [];
  for (const row of rows) {
    // No file, or a membership the projection also refuses to guess about: a nameless
    // member owes a file that cannot be written (nothing is invented for it, so it stays
    // owed), and a member with no file owes one outright. Both are the same debt here —
    // «this member has nothing» — even though only one of them is recordable.
    if (!row.file_id || !(row.full_name ?? "").trim()) {
      debts.push({
        userId: row.user_id,
        fullName: row.full_name,
        fileId: null,
        reason: "file_missing",
        recorded: row.recorded,
      });
      continue;
    }

    // The file through the canonical door, and the membership through the same reader the
    // projection uses, so this comparison sees exactly what a write would.
    const [file, canonical] = await Promise.all([
      getPartyByEmployee(businessId, row.user_id),
      canonicalIdentity(businessId, row.user_id),
    ]);
    if (file && canonical && personnelFileIsStale(file, canonical)) {
      debts.push({
        userId: row.user_id,
        fullName: row.full_name,
        fileId: file.id,
        reason: "identity_stale",
        recorded: row.recorded,
      });
    }
  }
  return debts;
}

export interface PersonnelFileDriftRow {
  userId: string;
  fullName: string;
  reason: PersonnelFileDriftReason;
  lastError: string | null;
  attempts: number;
  lastAttemptAt: string;
}

/** The open drift rows of one business — the read-only inventory, and the Team notice. */
export async function listPersonnelFileDrift(businessId: string): Promise<PersonnelFileDriftRow[]> {
  const { rows } = await query<{
    user_id: string;
    full_name: string;
    reason: PersonnelFileDriftReason;
    last_error: string | null;
    attempts: number;
    last_attempt_at: Date;
  }>(
    `SELECT d.user_id, u.full_name, d.reason, d.last_error, d.attempts, d.last_attempt_at
       FROM personnel_file_drift d
       JOIN users u ON u.id = d.user_id AND u.business_id = d.business_id
      WHERE d.business_id = $1 AND d.resolved_at IS NULL
      ORDER BY d.last_attempt_at`,
    [businessId],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    reason: row.reason,
    lastError: row.last_error,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at.toISOString(),
  }));
}

/**
 * Retries the members whose file is owed.
 *
 * Called from three places, all of them bounded:
 *
 *   - `GET /api/team` — the Team screen is where a missing file is visible, so opening
 *     it is the natural moment to repair one (at most a handful per request);
 *   - the reconciliation script (`npm run personnel:reconcile`), which passes the whole
 *     business and reports what remains;
 *   - nothing else: a background sweep that retries forever is a job queue, and this
 *     problem does not need one — a member's file is also refreshed by the next name,
 *     phone or role change.
 */
export async function retryPersonnelFileDrift(
  businessId: string,
  options: { userId?: string; limit?: number } = {},
): Promise<{ attempted: number; repaired: number; remaining: number }> {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 500));
  const { rows } = await query<{ user_id: string }>(
    `SELECT user_id
       FROM personnel_file_drift
      WHERE business_id = $1 AND resolved_at IS NULL
        AND ($2::uuid IS NULL OR user_id = $2::uuid)
      ORDER BY last_attempt_at
      LIMIT $3`,
    [businessId, options.userId ?? null, limit],
  );

  let repaired = 0;
  for (const row of rows) {
    const result = await ensurePersonnelFileForMembership(businessId, row.user_id);
    if (result.ok) repaired += 1;
  }

  const { rows: remaining } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM personnel_file_drift
      WHERE business_id = $1 AND resolved_at IS NULL
        AND ($2::uuid IS NULL OR user_id = $2::uuid)`,
    [businessId, options.userId ?? null],
  );
  return { attempted: rows.length, repaired, remaining: Number(remaining[0]?.count ?? 0) };
}
