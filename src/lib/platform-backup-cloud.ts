/**
 * The cloud half of the whole-platform backup, as decisions a unit test can pin
 * (issue #1296).
 *
 * The live failure this module answers, in the operator's own words: a fresh
 * 319 MB artifact was written locally and encrypted correctly, its upload died
 * as a bare `NetworkError`, a second attempt was left `running` by a worker that
 * never came back, and a 2.84 MB *September* object in the bucket kept the
 * console reading "cloud: success". Three separate lies were possible at once —
 * "running" without a deadline, "retryable" without a classifier, and
 * "protected" without comparing the current artifact with what is actually
 * off-site. Each of those is a decision, so each lives here, pure:
 *
 *   • `classifyCloudAttempt` — is this `running` row genuinely in flight, or an
 *     orphan whose lease ran out? (No process can be asked: the worker that
 *     owned it may be gone, and the row is the only durable evidence.)
 *   • `planCloudUpload` — try now, wait for a backoff, or stop? Bounded attempts
 *     with exponential backoff and jitter, a slow retry once the ladder is
 *     spent (so a fixed network is never suppressed forever), and an immediate
 *     attempt when a lease is reclaimed.
 *   • `assessCloudProtection` — is the *current* local artifact off-site? The
 *     newest confirmed remote object is reported as what it is, including when
 *     it is historical, and the console must never be allowed to read an older
 *     success as "the latest backup is protected".
 *
 * What is deliberately *not* here: multipart upload. The issue's instruction is
 * "only if proven necessary", and nothing observed proves it — the artifact is
 * uploaded as a single streamed, signed `PUT` of a local file whose SHA-256 was
 * computed before the request, so a truncated body cannot even be signed. The
 * failure modes that *were* observed are an unclassified transport error and an
 * unbounded `running` row, and both are fixed by classes and leases, not by
 * chunking. A wrong signature must keep failing fast instead of being hidden
 * behind a retry ladder.
 */
import { CLOUD_RETRY_MS } from "./backup";

/**
 * How long an upload may go without *any* sign of life before another instance
 * may declare it abandoned. Renewed by the uploader's own progress reports, so
 * a slow-but-moving transfer keeps its lease and a dead one loses it.
 */
export const CLOUD_LEASE_MS = 5 * 60 * 1000;

/**
 * Grace on top of the transfer's own deadline. `s3PutFile` aborts the request
 * when its size-derived timeout expires, so start + timeout + grace is a
 * *provable* upper bound on how long a live attempt can last — which is what
 * makes reclaiming it safe rather than a guess.
 */
export const CLOUD_ATTEMPT_GRACE_MS = 2 * 60 * 1000;

/** First retry delay; the tenant pipeline uses the same ten minutes. */
export const CLOUD_RETRY_BASE_MS = CLOUD_RETRY_MS;
/** Backoff ceiling — a nightly artifact is still retried several times a day. */
export const CLOUD_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Attempts per artifact before the ladder is spent. */
export const CLOUD_MAX_ATTEMPTS = 8;
/**
 * Once the ladder is spent, keep one slow attempt a day. The issue's acceptance
 * criterion is "no permanent retry suppression": an operator who fixes the
 * uplink at noon must not wait for the next nightly artifact, and a broken
 * destination must not be hammered either.
 */
export const CLOUD_EXHAUSTED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The lease this attempt is started with: its own transfer budget + grace. */
export function cloudLeaseMs(transferTimeoutMs: number): number {
  return Math.max(CLOUD_LEASE_MS, transferTimeoutMs + CLOUD_ATTEMPT_GRACE_MS);
}

// ---------------------------------------------------------------------------
// Attempts (the durable half of "is something actually happening?")
// ---------------------------------------------------------------------------

export type CloudAttemptStatus = "running" | "success" | "failed";

export interface CloudAttempt {
  id: string | null;
  status: CloudAttemptStatus;
  startedAt: Date;
  /** when this attempt's owner last proved it was alive (or its start, if never) */
  leaseExpiresAt: Date | null;
  /** started + the transfer's own abort deadline + grace */
  hardDeadlineAt?: Date | null;
}

export type CloudAttemptVerdict =
  | { verdict: "none" }
  | { verdict: "succeeded" }
  | { verdict: "failed" }
  | { verdict: "in_flight"; leaseExpiresAt: Date }
  | { verdict: "abandoned"; overdueMs: number; runId: string | null };

/**
 * What one `platform_backup_runs` row means right now.
 *
 * A `running` row is only believed while it holds a live lease; past that (its
 * lease, or the hard deadline the transfer itself cannot exceed) it is
 * abandoned, and the caller may close it as failed and start a fresh attempt
 * under the same artifact. This is the branch the old catch-up was missing —
 * `if (last?.status === "running") return;` with no age check, which let one
 * crashed worker suppress catch-up indefinitely.
 */
export function classifyCloudAttempt(
  attempt: CloudAttempt | null | undefined,
  opts: { now?: Date; leaseMs?: number } = {},
): CloudAttemptVerdict {
  if (!attempt) return { verdict: "none" };
  if (attempt.status === "success") return { verdict: "succeeded" };
  if (attempt.status === "failed") return { verdict: "failed" };

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const leaseMs = Math.max(0, opts.leaseMs ?? CLOUD_LEASE_MS);
  const leaseAt = attempt.leaseExpiresAt ?? new Date(attempt.startedAt.getTime() + leaseMs);
  // Two independent ceilings: the renewable lease (progress) and the deadline
  // the transfer cannot outlive (its own abort). Whichever passes first ends
  // the attempt's credibility.
  const deadlineAt = attempt.hardDeadlineAt ?? null;
  if (nowMs < leaseAt.getTime() && (!deadlineAt || nowMs < deadlineAt.getTime())) {
    return { verdict: "in_flight", leaseExpiresAt: leaseAt };
  }
  const overdueFrom = Math.min(
    leaseAt.getTime(),
    deadlineAt ? deadlineAt.getTime() : Number.POSITIVE_INFINITY,
  );
  return { verdict: "abandoned", overdueMs: nowMs - overdueFrom, runId: attempt.id };
}

// ---------------------------------------------------------------------------
// Retry planning
// ---------------------------------------------------------------------------

export type CloudUploadDecision =
  | {
      decision: "upload";
      reason: "first_attempt" | "previous_failed" | "lease_expired" | "retry_due" | "slow_retry";
      /** 1-based attempt number this upload will be recorded as */
      attempt: number;
      /** the abandoned `running` row this attempt takes over from, if any */
      reclaimRunId: string | null;
      notBefore: null;
    }
  | {
      decision: "wait";
      reason: "uploaded" | "in_flight" | "backoff" | "exhausted_cooldown";
      /** when the next attempt becomes due, when that is knowable */
      notBefore: Date | null;
    };

/**
 * The backoff before attempt `attemptsSoFar + 1`: ten minutes, doubling, capped
 * at six hours, with ±20 % jitter so a fleet that all retried on the same tick
 * does not arrive together.
 */
export function cloudBackoffMs(
  attemptsSoFar: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number; random?: () => number } = {},
): number {
  const base = Math.max(1, opts.baseDelayMs ?? CLOUD_RETRY_BASE_MS);
  const max = Math.max(base, opts.maxDelayMs ?? CLOUD_RETRY_MAX_MS);
  const exponent = Math.min(30, Math.max(0, attemptsSoFar - 1));
  const nominal = Math.min(max, base * 2 ** exponent);
  const random = opts.random ?? Math.random;
  const jitter = 1 + (random() * 2 - 1) * 0.2;
  return Math.max(base / 2, Math.round(nominal * jitter));
}

/**
 * Whether the newest local artifact should be uploaded again on this tick.
 *
 * The ordering matters, and is the fix for the stuck run: an *abandoned* lease
 * beats the "running means leave it alone" rule, so recovery is possible
 * without an operator and without two live uploads of one artifact (the caller
 * also takes a per-artifact lock before it starts).
 */
export function planCloudUpload(input: {
  lastAttempt: CloudAttempt | null | undefined;
  /** finished (or reclaimed) attempts recorded for this artifact */
  attempts: number;
  now?: Date;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  leaseMs?: number;
  cooldownMs?: number;
  random?: () => number;
}): CloudUploadDecision {
  const now = input.now ?? new Date();
  const maxAttempts = Math.max(1, input.maxAttempts ?? CLOUD_MAX_ATTEMPTS);
  const cooldownMs = Math.max(0, input.cooldownMs ?? CLOUD_EXHAUSTED_COOLDOWN_MS);
  const verdict = classifyCloudAttempt(input.lastAttempt, { now, leaseMs: input.leaseMs });
  const nextAttempt = Math.max(1, input.attempts + 1);

  switch (verdict.verdict) {
    case "succeeded":
      return { decision: "wait", reason: "uploaded", notBefore: null };
    case "in_flight":
      return { decision: "wait", reason: "in_flight", notBefore: verdict.leaseExpiresAt };
    case "abandoned":
      // Take the row over: no waiting — the whole point is that its owner is
      // gone. The attempt number still advances so the history stays honest.
      return {
        decision: "upload",
        reason: "lease_expired",
        attempt: nextAttempt,
        reclaimRunId: verdict.runId,
        notBefore: null,
      };
    case "none":
      return { decision: "upload", reason: "first_attempt", attempt: nextAttempt, reclaimRunId: null, notBefore: null };
    case "failed": {
      const lastStart = input.lastAttempt?.startedAt.getTime() ?? 0;
      if (input.attempts >= maxAttempts) {
        const notBefore = new Date(lastStart + cooldownMs);
        if (now.getTime() < notBefore.getTime()) {
          return { decision: "wait", reason: "exhausted_cooldown", notBefore };
        }
        return { decision: "upload", reason: "slow_retry", attempt: nextAttempt, reclaimRunId: null, notBefore: null };
      }
      const notBefore = new Date(
        lastStart + cloudBackoffMs(input.attempts, {
          baseDelayMs: input.baseDelayMs,
          maxDelayMs: input.maxDelayMs,
          random: input.random,
        }),
      );
      if (now.getTime() < notBefore.getTime()) {
        return { decision: "wait", reason: "backoff", notBefore };
      }
      return {
        decision: "upload",
        reason: input.attempts === 0 ? "first_attempt" : "retry_due",
        attempt: nextAttempt,
        reclaimRunId: null,
        notBefore: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Proof: what the bucket actually holds for the artifact we care about
// ---------------------------------------------------------------------------

export interface LocalArtifactRef {
  artifact: string;
  sizeBytes: number | null;
  /** ISO timestamp the artifact was captured, from its own name */
  capturedAt: string | null;
}

export interface CloudObjectRef {
  /** the plain artifact name (a key's last segment; the prefix is not identity) */
  artifact: string;
  sizeBytes: number | null;
}

/**
 * A per-artifact confirmation row: the object was seen in the bucket *and*
 * checked against what we meant to upload. `verifyMode` is deliberately three-
 * valued — `size` is a cheap HEAD after every upload, `sha256` is a full
 * re-download and hash, and neither is ever inferred from the provider's ETag
 * (Arvan/AWS/MinIO disagree about what it means, and it is not always the
 * SHA-256).
 */
export interface CloudConfirmation {
  /** plain artifact name (not the key) */
  artifact: string;
  confirmedAt: string | null;
  verifyMode: "size" | "sha256" | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export type CloudMirrorState =
  | "disabled"
  | "no_local_artifact"
  | "uploading"
  | "pending"
  | "failed"
  | "unavailable"
  | "current";

export interface CloudProtection {
  state: CloudMirrorState;
  currentArtifact: string | null;
  currentCapturedAt: string | null;
  currentSizeBytes: number | null;
  /** the current artifact has a confirmed object in the bucket */
  currentConfirmed: boolean;
  latestConfirmedArtifact: string | null;
  latestConfirmedAt: string | null;
  latestConfirmedSizeBytes: number | null;
  latestVerifyMode: "size" | "sha256" | null;
  /**
   * How much older the newest confirmed copy is than the newest local artifact.
   * `null` when nothing is confirmed at all — not zero.
   */
  behindMs: number | null;
  /** objects older than the current artifact: the September copy, labelled as such */
  historical: { artifact: string; sizeBytes: number | null; capturedAt: string | null }[];
  /** the last failed attempt for this artifact, and its recorded cause */
  lastFailure: { at: string; message: string | null } | null;
  /**
   * The newest *recorded* capture's file is gone from disk. Not retryable as an
   * upload (issue #1296 defect 4): the row is kept as history, the artifact is
   * shown as unavailable, and nothing prunes the copies that do exist.
   */
  localArtifactMissing: boolean;
  /** the newest recorded capture, when its file is the missing one */
  missingArtifact: string | null;
  /** when the next attempt is due, per `planCloudUpload` */
  nextAttemptAt: string | null;
  attempts: number;
  retryExhausted: boolean;
  /**
   * The newest capture — the newest one on disk, or the newest one recorded at
   * all — has no confirmed remote copy and has been sitting that way past the
   * RPO window. The P1 alert condition: "the newest local backup lacks a
   * confirmed cloud mirror".
   */
  rpoBreached: boolean;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The plain artifact name from a key that may carry the configured prefix. */
export function artifactNameFromKey(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] ?? key;
}

/**
 * Compare the newest local artifact with what the bucket confirms.
 *
 * This is the invariant the console was missing: a cloud run that succeeded in
 * September is not evidence about today's artifact, and the health line must
 * say "local only" until the *current* capture has a confirmed object. Nothing
 * here trusts a run's `success` on its own — an object must be present in the
 * provider's listing, and confirmed by a verification row, before it counts as
 * an off-site copy of anything.
 */
export function assessCloudProtection(input: {
  cloudEnabled: boolean;
  /** newest local artifact that still has a file on disk, if any */
  currentArtifact: LocalArtifactRef | null;
  /** whether the newest recorded capture's file is present */
  localArtifactExists?: boolean | null;
  cloudObjects: CloudObjectRef[];
  confirmations?: CloudConfirmation[];
  /**
   * The newest capture the run history records, whether or not its file is
   * still on disk. When it is not, that is reported (`localArtifactMissing`) but
   * it does not become "the artifact to protect" — the newest *existing* file
   * is, because that is the one a restore could actually use.
   */
  newestRecorded?: LocalArtifactRef | null;
  lastAttempt?: CloudAttempt | null;
  /** the error text recorded on that attempt, if it failed */
  lastError?: string | null;
  /**
   * Whether the *last* attempt's failure was classified as transient. `false` is
   * a terminal answer (issue #1296: a wrong signature, a missing permission):
   * no bounded ladder can fix it, so it is reported as `failed` on the first
   * attempt instead of being dressed up as "waiting to retry". `null` means the
   * row predates the diagnostics column and the count is all we know.
   */
  lastRetryable?: boolean | null;
  attempts?: number;
  /** how long a missing remote copy of the newest local capture may last */
  rpoMs: number;
  now?: Date;
  leaseMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}): CloudProtection {
  const now = input.now ?? new Date();
  const confirmations = input.confirmations ?? [];
  const lastError = input.lastError ?? null;
  const attempts = Math.max(0, input.attempts ?? 0);
  const byName = new Map<string, CloudObjectRef>();
  for (const object of input.cloudObjects) byName.set(artifactNameFromKey(object.artifact), object);
  const confirmationByName = new Map<string, CloudConfirmation>();
  for (const confirmation of confirmations) confirmationByName.set(confirmation.artifact, confirmation);

  // Newest confirmed copy that is *still in the bucket*. A confirmation row for
  // an object retention has since deleted is history, not protection.
  let latestConfirmed: { artifact: string; confirmation: CloudConfirmation } | null = null;
  for (const name of byName.keys()) {
    const confirmation = confirmationByName.get(name);
    if (!confirmation?.confirmedAt) continue;
    if (!latestConfirmed || name > latestConfirmed.artifact) latestConfirmed = { artifact: name, confirmation };
  }
  const current = input.currentArtifact;
  const currentObject = current ? byName.get(current.artifact) : undefined;
  const currentConfirmation = current ? confirmationByName.get(current.artifact) : undefined;
  const currentConfirmed = Boolean(
    current && currentObject && currentConfirmation?.confirmedAt && confirmationSizeAgrees(current, currentObject, currentConfirmation),
  );

  const currentCapturedMs = toMs(current?.capturedAt ?? null);
  const confirmedCapturedMs = latestConfirmed ? toMs(capturedAtFromName(latestConfirmed.artifact)) : null;
  // "How far behind cloud is" is a duration between two captures, so it needs
  // both: no confirmed copy at all is `null`, not zero.
  const behindMs =
    currentCapturedMs !== null && confirmedCapturedMs !== null
      ? Math.max(0, currentCapturedMs - confirmedCapturedMs)
      : null;

  // Everything in the bucket that is *older* than the current local capture.
  // This is where the 2.84 MB September object belongs, and it is what the
  // console must show instead of calling it the latest protected copy.
  const historical = [...byName.values()]
    .filter((object) => {
      const name = artifactNameFromKey(object.artifact);
      return current ? name < current.artifact : true;
    })
    .map((object) => ({
      artifact: object.artifact,
      sizeBytes: object.sizeBytes,
      capturedAt: capturedAtFromName(artifactNameFromKey(object.artifact)),
    }))
    .sort((a, b) => (a.artifact < b.artifact ? 1 : -1));

  const newestRecorded = input.newestRecorded ?? null;
  const localArtifactMissing = Boolean(
    newestRecorded &&
      (!current || newestRecorded.artifact > current.artifact) &&
      input.localArtifactExists === false,
  );
  // The artifact we are asked to protect is the newest one with a file, unless
  // that file is missing — in which case its own state is `unavailable`. It is
  // never reported as "uploading", because no upload can bring the file back.
  const currentExists = current ? current.artifact === newestRecorded?.artifact ? input.localArtifactExists !== false : true : true;
  const attempt = input.lastAttempt ?? null;
  const verdict = classifyCloudAttempt(attempt, { now, leaseMs: input.leaseMs });
  const plan = planCloudUpload({
    lastAttempt: attempt,
    attempts,
    now,
    leaseMs: input.leaseMs,
    maxAttempts: input.maxAttempts,
    baseDelayMs: input.baseDelayMs,
    maxDelayMs: input.maxDelayMs,
    random: input.random,
  });
  // A deterministic refusal is terminal on its first attempt: the operator has a
  // configuration to fix, and telling them "we will try again" would be a lie the
  // scheduler cannot keep.
  const terminal = verdict.verdict === "failed" && input.lastRetryable === false;
  const retryExhausted =
    terminal || (attempts >= Math.max(1, input.maxAttempts ?? CLOUD_MAX_ATTEMPTS) && verdict.verdict !== "succeeded");

  let state: CloudMirrorState;
  if (!input.cloudEnabled) state = "disabled";
  else if (!current) state = localArtifactMissing ? "unavailable" : "no_local_artifact";
  else if (currentConfirmed && !localArtifactMissing) state = "current";
  else if (!currentExists) state = "unavailable";
  // The newest *recorded* capture's file is gone, but an older artifact — very
  // possibly a confirmed one — is still on disk. That is neither a failure of
  // this upload nor a success: it is "pending", with the gap reported separately
  // so the console can say «فایل فلان روی دیسک نیست» instead of either blaming
  // the bucket or reading the older copy as if it were today's.
  else if (localArtifactMissing) state = "pending";
  else if (verdict.verdict === "in_flight") state = "uploading";
  // "Failed" has exactly two meanings, and both are terminal for the scheduler:
  // a spent ladder (attempts exhausted, cooldown running — the operator has to
  // act) and a deterministic refusal (a wrong signature will never heal). Any
  // other recorded failure is "pending": a retry is still coming, and the card
  // shows the last failure beside it.
  else if (retryExhausted) state = "failed";
  else state = "pending";

  // Any recorded failure is shown, not only a spent ladder's: "the last attempt
  // failed, here is what it said" is what makes a *pending* retry actionable, and
  // #1296's acceptance list asks for the last failure beside the state. The error
  // text is the redacted summary the service recorded (code/status/attempts), so
  // nothing here can carry a key, a header or a signed URL.
  const lastFailure =
    attempt && attempt.status === "failed"
      ? { at: attempt.startedAt.toISOString(), message: lastError ?? null }
      : null;

  return {
    state,
    currentArtifact: current?.artifact ?? null,
    currentCapturedAt: current?.capturedAt ?? null,
    currentSizeBytes: current?.sizeBytes ?? null,
    currentConfirmed,
    latestConfirmedArtifact: latestConfirmed?.artifact ?? null,
    latestConfirmedAt: latestConfirmed?.confirmation.confirmedAt ?? null,
    latestConfirmedSizeBytes: latestConfirmed?.confirmation.sizeBytes ?? null,
    latestVerifyMode: latestConfirmed?.confirmation.verifyMode ?? null,
    behindMs,
    historical,
    lastFailure,
    localArtifactMissing,
    missingArtifact: localArtifactMissing ? (newestRecorded?.artifact ?? null) : null,
    nextAttemptAt: plan.decision === "upload" ? null : (plan.notBefore?.toISOString() ?? null),
    attempts,
    retryExhausted,
    rpoBreached: (() => {
      if (!input.cloudEnabled || currentConfirmed) return false;
      // Whichever capture is newest — the file on disk or the record whose file
      // is gone — the absence of a confirmed copy ages from *that* one.
      const newestCapturedMs = Math.max(
        currentCapturedMs ?? Number.NEGATIVE_INFINITY,
        toMs(newestRecorded?.capturedAt ?? null) ?? Number.NEGATIVE_INFINITY,
      );
      if (!Number.isFinite(newestCapturedMs)) return false;
      return now.getTime() - newestCapturedMs > Math.max(0, input.rpoMs);
    })(),
  };
}

/** A confirmation only counts if its own size matches the object the provider lists. */
function confirmationSizeAgrees(
  local: LocalArtifactRef,
  object: CloudObjectRef,
  confirmation: CloudConfirmation,
): boolean {
  const expected = confirmation.sizeBytes ?? local.sizeBytes ?? object.sizeBytes;
  if (expected === null || expected === undefined) return object.sizeBytes === null;
  if (object.sizeBytes !== null && object.sizeBytes !== expected) return false;
  if (local.sizeBytes !== null && confirmation.sizeBytes !== null && local.sizeBytes !== confirmation.sizeBytes) {
    // Only comparable when the confirmation describes the *upload payload*
    // (the encrypted file), which is what a size check proves.
    return false;
  }
  return true;
}

/** Which calendar capture a platform artifact's own name carries. */
export function capturedAtFromName(artifact: string): string | null {
  const match = /^pos-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(artifact);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** Human-scale "how far behind" for the console and the MCP contract. */
export function describeBehind(behindMs: number | null): { value: number; unit: "minutes" | "hours" | "days" } | null {
  if (behindMs === null || !Number.isFinite(behindMs)) return null;
  const minutes = Math.round(behindMs / 60_000);
  if (minutes < 120) return { value: Math.max(0, minutes), unit: "minutes" };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { value: hours, unit: "hours" };
  return { value: Math.round(hours / 24), unit: "days" };
}
