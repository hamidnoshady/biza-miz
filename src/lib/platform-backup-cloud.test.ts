/**
 * Issue #1296 — the cloud half of the whole-platform backup, as decisions.
 *
 * What this file pins, in the order the production incident happened:
 *
 *  1. **`running` is not a state, it is a lease.** A worker that dies mid-upload
 *     leaves a row behind; the row must stop suppressing catch-up once its lease
 *     has passed, and must not be reclaimed one millisecond earlier (two live
 *     uploads of one key is the other way to corrupt a backup).
 *  2. **A generic transport failure is retryable, a rejection is not.** The
 *     recorded failure was a bare `NetworkError`; retrying it a bounded number
 *     of times is correct, retrying a 403 `SignatureDoesNotMatch` is masking a
 *     misconfiguration.
 *  3. **Proof, not history.** A September object must never answer for
 *     November's artifact: `currentConfirmed` is false, the old copy is listed as
 *     historical with its own size, and `behindMs` says how far behind cloud is.
 */
import { describe, expect, it } from "vitest";
import {
  assessCloudProtection,
  artifactNameFromKey,
  capturedAtFromName,
  classifyCloudAttempt,
  cloudBackoffMs,
  cloudLeaseMs,
  CLOUD_EXHAUSTED_COOLDOWN_MS,
  CLOUD_MAX_ATTEMPTS,
  CLOUD_RETRY_BASE_MS,
  describeBehind,
  planCloudUpload,
  type CloudAttempt,
} from "./platform-backup-cloud";

const NOW = new Date("2026-11-07T09:00:00Z");
const minutes = (n: number) => n * 60_000;

function running(startedMinutesAgo: number, leaseMinutesLeft: number | null): CloudAttempt {
  return {
    id: "run-1",
    status: "running",
    startedAt: new Date(NOW.getTime() - minutes(startedMinutesAgo)),
    leaseExpiresAt: leaseMinutesLeft === null ? null : new Date(NOW.getTime() + minutes(leaseMinutesLeft)),
  };
}

function failed(startedMinutesAgo: number): CloudAttempt {
  return {
    id: "run-2",
    status: "failed",
    startedAt: new Date(NOW.getTime() - minutes(startedMinutesAgo)),
    leaseExpiresAt: null,
  };
}

describe("classifyCloudAttempt — a running row is only believed while its lease lives", () => {
  it("calls a live lease in flight", () => {
    expect(classifyCloudAttempt(running(2, 3), { now: NOW })).toEqual({
      verdict: "in_flight",
      leaseExpiresAt: new Date(NOW.getTime() + minutes(3)),
    });
  });

  it("calls an expired lease abandoned, and reports how far past it is", () => {
    const verdict = classifyCloudAttempt(running(30, -12), { now: NOW });
    expect(verdict.verdict).toBe("abandoned");
    if (verdict.verdict === "abandoned") {
      expect(verdict.overdueMs).toBe(minutes(12));
      expect(verdict.runId).toBe("run-1");
    }
  });

  it("treats a legacy row with no lease as started_at + the default lease", () => {
    // This is the production row: written before the column existed, so nothing
    // renews it and nothing could ever reclaim it. After the default lease it is
    // recoverable without an operator.
    expect(classifyCloudAttempt(running(1, null), { now: NOW }).verdict).toBe("in_flight");
    expect(classifyCloudAttempt(running(45, null), { now: NOW }).verdict).toBe("abandoned");
  });

  it("ends an attempt at its hard deadline even while the lease claims life", () => {
    const attempt: CloudAttempt = {
      ...running(20, 10),
      hardDeadlineAt: new Date(NOW.getTime() - minutes(1)),
    };
    expect(classifyCloudAttempt(attempt, { now: NOW }).verdict).toBe("abandoned");
  });

  it("passes through terminal rows and an absent history", () => {
    expect(classifyCloudAttempt(null, { now: NOW })).toEqual({ verdict: "none" });
    expect(classifyCloudAttempt({ ...failed(5), status: "success" }, { now: NOW }).verdict).toBe("succeeded");
    expect(classifyCloudAttempt(failed(5), { now: NOW }).verdict).toBe("failed");
  });
});

describe("planCloudUpload — bounded retries, never permanent suppression", () => {
  it("uploads the first time", () => {
    expect(planCloudUpload({ lastAttempt: null, attempts: 0, now: NOW })).toMatchObject({
      decision: "upload",
      reason: "first_attempt",
      attempt: 1,
    });
  });

  it("leaves a live upload alone", () => {
    expect(planCloudUpload({ lastAttempt: running(2, 4), attempts: 1, now: NOW })).toMatchObject({
      decision: "wait",
      reason: "in_flight",
    });
  });

  it("reclaims an expired lease immediately instead of waiting for the backoff", () => {
    // The whole defect in one assertion: this used to be `wait` forever.
    expect(
      planCloudUpload({ lastAttempt: running(120, -100), attempts: 3, now: NOW }),
    ).toMatchObject({ decision: "upload", reason: "lease_expired", attempt: 4, reclaimRunId: "run-1" });
  });

  it("waits out the backoff after a failure, then retries", () => {
    // One attempt has finished; the first delay is ten minutes (±20 %).
    const justFailed = planCloudUpload({
      lastAttempt: failed(1),
      attempts: 1,
      now: NOW,
      random: () => 0.5,
    });
    expect(justFailed.decision).toBe("wait");
    if (justFailed.decision === "wait") {
      expect(justFailed.reason).toBe("backoff");
      expect(justFailed.notBefore?.getTime()).toBe(NOW.getTime() - minutes(1) + CLOUD_RETRY_BASE_MS);
    }

    const later = planCloudUpload({ lastAttempt: failed(11), attempts: 1, now: NOW, random: () => 0.5 });
    expect(later).toMatchObject({ decision: "upload", reason: "retry_due", attempt: 2 });
  });

  it("never suppresses retries once the ladder is spent — it slows them to once a day", () => {
    const exhausted = planCloudUpload({
      lastAttempt: failed(30),
      attempts: CLOUD_MAX_ATTEMPTS,
      now: NOW,
    });
    expect(exhausted.decision).toBe("wait");
    if (exhausted.decision === "wait") {
      expect(exhausted.reason).toBe("exhausted_cooldown");
      expect(exhausted.notBefore?.getTime()).toBe(NOW.getTime() - minutes(30) + CLOUD_EXHAUSTED_COOLDOWN_MS);
    }
    expect(
      planCloudUpload({
        lastAttempt: failed(CLOUD_EXHAUSTED_COOLDOWN_MS / 60_000 + 5),
        attempts: CLOUD_MAX_ATTEMPTS,
        now: NOW,
      }),
    ).toMatchObject({ decision: "upload", reason: "slow_retry" });
  });

  it("stops asking once the artifact is uploaded", () => {
    expect(
      planCloudUpload({ lastAttempt: { ...failed(5), status: "success" }, attempts: 2, now: NOW }),
    ).toMatchObject({ decision: "wait", reason: "uploaded" });
  });

  it("backs off exponentially with jitter inside the ceiling", () => {
    const nominal = cloudBackoffMs(3, { random: () => 0.5 });
    expect(nominal).toBe(CLOUD_RETRY_BASE_MS * 4);
    // ±20 % envelope.
    expect(cloudBackoffMs(3, { random: () => 0 })).toBe(Math.round(CLOUD_RETRY_BASE_MS * 4 * 0.8));
    expect(cloudBackoffMs(3, { random: () => 1 })).toBe(Math.round(CLOUD_RETRY_BASE_MS * 4 * 1.2));
    // Capped, never unbounded.
    expect(cloudBackoffMs(40, { random: () => 0.5 })).toBeLessThanOrEqual(6 * 60 * 60 * 1000 * 1.2);
  });

  it("derives the lease from the transfer's own deadline plus grace", () => {
    // A 319 MB artifact: the PUT's abort (120 s + 1 s/MiB) is the floor.
    expect(cloudLeaseMs(440_000)).toBe(440_000 + 120_000);
    // A tiny probe still gets the minimum lease.
    expect(cloudLeaseMs(1_000)).toBe(5 * 60_000);
  });
});

describe("assessCloudProtection — the newest capture, not the last success", () => {
  const novemberLocal = {
    artifact: "pos-backup-20261107-060247-7e2e5bb6.dump.enc",
    sizeBytes: 319_067_831,
    capturedAt: "2026-11-07T06:02:47.000Z",
  };
  const septemberObject = {
    artifact: "pos-backup-20260913-094519.dump.enc",
    sizeBytes: 2_840_000,
  };

  it("reports the September object as historical while November is local-only", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [septemberObject],
      confirmations: [
        {
          artifact: septemberObject.artifact,
          confirmedAt: "2026-09-13T09:50:00.000Z",
          verifyMode: "size",
          sizeBytes: septemberObject.sizeBytes,
          sha256: null,
        },
      ],
      lastAttempt: failed(120),
      attempts: 1,
      // One hour: the capture is three hours old, so the RPO has passed.
      rpoMs: 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.state).toBe("pending");
    expect(protection.currentConfirmed).toBe(false);
    expect(protection.currentArtifact).toBe(novemberLocal.artifact);
    expect(protection.latestConfirmedArtifact).toBe(septemberObject.artifact);
    expect(protection.latestConfirmedSizeBytes).toBe(2_840_000);
    expect(protection.historical.map((h) => h.artifact)).toEqual([septemberObject.artifact]);
    expect(protection.behindMs).toBeGreaterThan(50 * 24 * 60 * 60 * 1000);
    // And with no failure to blame, the breach is reported as an RPO breach.
    expect(protection.rpoBreached).toBe(true);
  });

  it("is `current` only when the object is listed AND its size matches", () => {
    const confirmations = [
      {
        artifact: novemberLocal.artifact,
        confirmedAt: "2026-11-07T06:10:00.000Z",
        verifyMode: "size" as const,
        sizeBytes: 319_067_831,
        sha256: null,
      },
    ];
    const listed = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [{ artifact: novemberLocal.artifact, sizeBytes: 319_067_831 }],
      confirmations,
      lastAttempt: { ...failed(1), status: "success" },
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(listed.state).toBe("current");
    expect(listed.currentConfirmed).toBe(true);
    expect(listed.rpoBreached).toBe(false);
    expect(listed.behindMs).toBe(0);

    // A truncated object (a streamed PUT that lost bytes) is not a copy.
    const truncated = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [{ artifact: novemberLocal.artifact, sizeBytes: 319_067_831 - 4096 }],
      confirmations,
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(truncated.currentConfirmed).toBe(false);
    expect(truncated.state).not.toBe("current");
  });

  it("does not count a confirmation whose object retention has deleted", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      confirmations: [
        {
          artifact: novemberLocal.artifact,
          confirmedAt: "2026-11-07T06:10:00.000Z",
          verifyMode: "sha256",
          sizeBytes: 319_067_831,
          sha256: "abc",
        },
      ],
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.currentConfirmed).toBe(false);
    expect(protection.latestConfirmedArtifact).toBeNull();
    expect(protection.state).toBe("pending");
  });

  it("says `uploading` while a lease is alive, not `failed`", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [septemberObject],
      attempts: 2,
      lastAttempt: running(3, 5),
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.state).toBe("uploading");
    expect(protection.nextAttemptAt).toBe(new Date(NOW.getTime() + minutes(5)).toISOString());
  });

  it("marks a missing local file as unavailable and does not call it retryable work", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: {
        artifact: "pos-backup-20261101-030000-aaaaaaaa.dump.enc",
        sizeBytes: 10,
        capturedAt: "2026-11-01T03:00:00.000Z",
      },
      localArtifactExists: false,
      newestRecorded: {
        artifact: "pos-backup-20261106-030000-bbbbbbbb.dump.enc",
        sizeBytes: 20,
        capturedAt: "2026-11-06T03:00:00.000Z",
      },
      cloudObjects: [septemberObject],
      attempts: 9,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.localArtifactMissing).toBe(true);
    expect(protection.missingArtifact).toBe("pos-backup-20261106-030000-bbbbbbbb.dump.enc");
    // The newest *existing* file is still the thing to protect.
    expect(protection.currentArtifact).toBe("pos-backup-20261101-030000-aaaaaaaa.dump.enc");
    expect(protection.state).toBe("pending");
    // The missing capture is a day old with nothing confirmed off-site: that is
    // a real breach, reported next to the gap so neither is hidden by the other.
    expect(protection.rpoBreached).toBe(true);
  });

  it("is `unavailable` when the artifact it must protect has no file", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: null,
      localArtifactExists: false,
      newestRecorded: {
        artifact: "pos-backup-20261106-030000-bbbbbbbb.dump.enc",
        sizeBytes: 20,
        capturedAt: "2026-11-06T03:00:00.000Z",
      },
      cloudObjects: [],
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.state).toBe("unavailable");
    expect(protection.localArtifactMissing).toBe(true);
  });

  it("reports nothing to protect honestly rather than green", () => {
    const protection = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: null,
      cloudObjects: [],
      attempts: 0,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.state).toBe("no_local_artifact");
    expect(protection.currentConfirmed).toBe(false);
    expect(protection.latestConfirmedArtifact).toBeNull();
    expect(protection.behindMs).toBeNull();
  });

  it("is `disabled` when cloud is off, without inventing a failure", () => {
    const protection = assessCloudProtection({
      cloudEnabled: false,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      attempts: 0,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(protection.state).toBe("disabled");
    expect(protection.rpoBreached).toBe(false);
  });

  it("carries the failure text through to the card without inventing one", () => {
    const withError = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      lastAttempt: failed(20),
      lastError: "upload platform-backups/x.dump.enc: ECONNRESET [code=ECONNRESET attempts=2]",
      attempts: 2,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
      random: () => 0.5,
    });
    // The retry is due now (the ten-minute backoff has passed), so the state is
    // "waiting to upload" — but the operator still sees what went wrong and when.
    expect(withError.state).toBe("pending");
    expect(withError.lastFailure?.message).toContain("ECONNRESET");
    expect(withError.retryExhausted).toBe(false);
    expect(withError.nextAttemptAt).toBeNull();
  });

  it("reads `failed` only when the automatic ladder has been spent", () => {
    const spent = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      lastAttempt: failed(30),
      lastError: "HTTP 403 SignatureDoesNotMatch",
      attempts: CLOUD_MAX_ATTEMPTS,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(spent.state).toBe("failed");
    expect(spent.retryExhausted).toBe(true);
    expect(spent.nextAttemptAt).toBe(
      new Date(NOW.getTime() - minutes(30) + CLOUD_EXHAUSTED_COOLDOWN_MS).toISOString(),
    );
    // …and it still says whether a retry is even expected to help: a 403 is the
    // operator's to fix, not the scheduler's.
    expect(spent.lastFailure?.message).toContain("SignatureDoesNotMatch");
  });
});

describe("artifact identity helpers", () => {
  it("takes the plain name out of a prefixed key", () => {
    expect(artifactNameFromKey("platform-backups/pos-backup-20261107-060247-7e2e5bb6.dump.enc")).toBe(
      "pos-backup-20261107-060247-7e2e5bb6.dump.enc",
    );
    expect(artifactNameFromKey("pos-backup-20261107-060247-7e2e5bb6.dump.enc")).toBe(
      "pos-backup-20261107-060247-7e2e5bb6.dump.enc",
    );
  });

  it("reads the capture time from the artifact's own name", () => {
    expect(capturedAtFromName("pos-backup-20261107-060247-7e2e5bb6.dump.enc")).toBe("2026-11-07T06:02:47.000Z");
    expect(capturedAtFromName("notes.dump")).toBeNull();
  });

  it("describes how far behind in a unit a human reads", () => {
    expect(describeBehind(minutes(30))).toEqual({ value: 30, unit: "minutes" });
    expect(describeBehind(minutes(60 * 5))).toEqual({ value: 5, unit: "hours" });
    expect(describeBehind(minutes(60 * 24 * 3))).toEqual({ value: 3, unit: "days" });
    expect(describeBehind(null)).toBeNull();
  });
});

describe("terminal refusals and the last-failure line", () => {
  const novemberLocal = {
    artifact: "pos-backup-20261107-060247-7e2e5bb6.dump.enc",
    sizeBytes: 319_067_831,
    capturedAt: "2026-11-07T06:02:47.000Z",
  };
  const septemberObject = {
    artifact: "pos-backup-20260913-094519.dump.enc",
    sizeBytes: 2_840_000,
  };

  it("reports a deterministic refusal as `failed` on the first attempt", () => {
    // A 403 SignatureDoesNotMatch is not something a ladder can fix, and #1296
    // asks for a terminal status rather than an endless "waiting to retry".
    const refused = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [septemberObject],
      lastAttempt: failed(1),
      lastError: "upload x.dump.enc: HTTP 403 SignatureDoesNotMatch [code=SignatureDoesNotMatch http=403 phase=uploading attempts=1]",
      lastRetryable: false,
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(refused.state).toBe("failed");
    expect(refused.retryExhausted).toBe(true);
    expect(refused.lastFailure?.message).toContain("SignatureDoesNotMatch");
  });

  it("shows the last failure even while a retry is still expected", () => {
    // `pending` means "a retry is coming", not "nothing went wrong": the console's
    // «تلاش دوباره» button is only actionable if the card says what failed.
    const transient = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      lastAttempt: failed(1),
      lastError: "upload x.dump.enc: ECONNRESET [code=ECONNRESET attempts=1]",
      lastRetryable: true,
      attempts: 1,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
      random: () => 0.5,
    });
    expect(transient.state).toBe("pending");
    expect(transient.lastFailure?.message).toContain("ECONNRESET");
    expect(transient.lastFailure?.at).toBe(new Date(NOW.getTime() - minutes(1)).toISOString());
  });

  it("stays `uploading` when a live lease exists even after an earlier terminal refusal", () => {
    const live = assessCloudProtection({
      cloudEnabled: true,
      currentArtifact: novemberLocal,
      localArtifactExists: true,
      cloudObjects: [],
      lastAttempt: running(1, 5),
      lastRetryable: false,
      attempts: 2,
      rpoMs: 6 * 60 * 60 * 1000,
      now: NOW,
    });
    expect(live.state).toBe("uploading");
  });
});
