# Off-site backup verification — closing issue #1296

What this is for: the *code* that protects the platform backup off-site has
shipped (verified uploads, classified failures, backoff, lease recovery, honest
health, a restore drill). What has not shipped is **proof that the deployment in
front of you is actually protected**. Those are different claims, and the issue
stays open until the second one is observed on a real host with real object
storage.

This is that observation. It is read-only except for one deliberate upload, it
touches no credentials, and it ends with a list you can paste into the issue.

> **Do not** run this against production during business hours, and **do not**
> apply a restore. Every step below is either a read or a verification.

---

## 0. What you need

| | |
|---|---|
| Console access | `/platform/backup`, with `backup.read` + `backup.verify` |
| Shell access | the app server, so you can read `platform_backup_runs` |
| Environment | a replica or staging host that points at **real object storage** (Arvan S3 or compatible) |
| Not needed | any credential change, any restore, any deletion |

A mock bucket cannot close this. The whole point is provider behaviour: TLS, the
signed-URL path, `Retry-After` on `503`, and how long 300 MB actually takes over
that link.

---

## 1. Establish the current state (before proving anything)

Run these and **write the answers down**. Step 5 is meaningless without them.

```bash
curl -s "$BASE/api/platform/backup/status" -H "cookie: $PLATFORM_COOKIE" | jq '{
  newestArtifact:   .health.newestArtifact,
  cloudState:       .health.cloud.state,          # current | stale | failed | never | …
  cloudReachable:   .health.cloudReachable,
  latestConfirmedAt:.health.cloud.latestConfirmedAt,
  alert:            .health.alert
}'
```

```sql
-- what actually happened, attempt by attempt
SELECT artifact, status, attempt, started_at, finished_at,
       cloud_verified_size, cloud_verified_sha256, cloud_verify_mode,
       lease_expires_at, local_missing_since
  FROM platform_backup_runs
 WHERE kind IN ('local','cloud')
 ORDER BY started_at DESC
 LIMIT 20;
```

Two things to check now, because they are the incident's symptoms:

- **Is the newest capture the one that is confirmed?** If `cloud.state` is
  `stale` while `latestConfirmedAt` is weeks old, the old object is *historical*.
  That is correct behaviour being reported honestly — it is not protection.
  Say so plainly in the issue; do not let an old successful upload read as
  current.
- **Is any row stuck `running` well past its lease?** If so, the next tick should
  reclaim it (`lease_expired: … reclaimed for a fresh attempt`). Watch one tick
  before intervening — a reclaimed row is the feature working.

---

## 2. Verify the existing object without uploading (30 s, no egress cost)

This is the read-only proof: a HEAD, or a full download when the artifact is small
enough for a one-pass hash to be worth it.

**Console:** the «تأیید دوباره با هش» button on the backup card.

**MCP** (identical path, never uploads):

```
verify_backup_cloud_object { "verify": "sha256" }
```

Expected answer:

| field | meaning |
|---|---|
| `status: "verified"` | exists and matches |
| `status: "missing"` | no object at that key — a failed upload, not corruption |
| `status: "mismatch"` | the bytes are not ours — **stop and escalate**; something rewrote the object |
| `reason` | provider-neutral and already redacted; quote it verbatim |

If this returns `mismatch`, do not proceed to step 3. You have a different
incident.

---

## 3. Prove the engine at incident scale (local, no bucket)

This runs the exact upload path — the 320 s size-derived timeout, the lease
arithmetic it feeds, the streaming digest and the post-upload proof — at the size
the incident named. It uses the test harness's stub bucket, so it proves the
*engine*, not the network.

```bash
LARGE_ARTIFACT_MIB=320 npm run test:db -- integration/platform-backup-cloud.integration.test.ts
```

Expect the large-artifact test to pass in well under a minute. If it fails, the
engine has a real defect and step 4 should not be attempted.

---

## 4. One real 300 MB upload into the real bucket

The only step that writes anything off-site, and the only one that proves the
*link*.

1. Take a fresh backup (console «پشتیبان‌گیری» or `run_backup_now`) and confirm
   the artifact on disk is a realistic size:
   ```bash
   ls -lh "$PLATFORM_BACKUP_DIR" | tail -5
   ```
2. Press retry / «تلاش دوباره» and let it run. **Do not close the tab** — the
   attempt row carries a lease, and a progress bar that lies is how the original
   incident felt.
3. When it finishes, confirm the *provider-side* facts, not the UI's:
   ```sql
   SELECT artifact, status, attempt, cloud_verify_mode,
          cloud_verified_size, cloud_verified_sha256
     FROM platform_backup_runs
    WHERE kind = 'cloud'
    ORDER BY started_at DESC LIMIT 3;
   ```
   - `status = 'ok'`
   - `cloud_verify_mode = 'sha256'` if you asked for a digest
   - `cloud_verified_size` equals the local file's byte count
4. Compare the digests yourself, once, end to end:
   ```bash
   sha256sum "$PLATFORM_BACKUP_DIR/<artifact>"
   ```
   against `cloud_verified_sha256`. The two must be the same string.
5. Re-read `/status`: `cloud.state` should now be `current`, `cloudReachable`
   true, `alert` empty. If the newest capture is still `stale`, the upload did
   not cover *that* artifact — the state is right and the wrong artifact was
   uploaded.

---

## 5. A failure that is classified, not a stack trace

Optional but cheap, and it is the half of the incident that made it unreadable.
With a throwaway bucket name or a revoked test key on a **replica**:

1. Trigger a retry.
2. Expect a terminal, classified answer rather than `TypeError: fetch failed`:
   ```json
   { "code": "SignatureDoesNotMatch", "providerStatus": 403,
     "phase": "request", "retryable": false, "runId": "<uuid>" }
   ```
3. Confirm `runId` appears in the console note (shortened) and in the audit row
   (`platform_backup.cloud.retry`).
4. Restore the good configuration and confirm recovery.

A `403` that reports as retryable, or a failure with no `code`, is a bug — capture
it.

---

## 6. What "done" looks like

Paste the answers from steps 1–5 into the issue. The criterion is met when all of
these are true **for the deployment you tested**:

- [ ] `cloud.state = "current"`, and it refers to the newest capture rather than an older object
- [ ] A ≥300 MB artifact uploaded, and its recorded size equals the local file's byte count
- [ ] `cloud_verified_sha256` equals a locally computed `sha256sum` of the same artifact
- [ ] `verify_backup_cloud_object` returns `verified` for that artifact
- [ ] The restore drill passes (`restorePlatformFromPlan`, `mode: "verify"`, scratch database only)
- [ ] A deliberate failure was classified, carried a `runId`, and recorded whether it was retryable
- [ ] No credential was rotated, no production restore was applied, nothing was deleted

Anything you cannot tick is the remaining work — name it in the issue rather than
ticking around it. "The object is there" was never the claim; "this deployment
would survive losing the box" is.

---

## When it goes wrong

| Symptom | Read it as | Do |
|---|---|---|
| `object_not_found` on verify | the upload never landed, or the key changed | retry once; if it recurs, check the prefix and bucket versioning |
| `object_size_mismatch` | a truncated or multipart-joined upload | re-upload; the local file is still the source of truth |
| `object_sha256_mismatch` | the object is not our bytes | **escalate** — someone or something rewrote it |
| `lease_expired` repeatedly | attempts die before their own timeout | check the link's throughput; the lease is derived from it, not guessed |
| `cloud.state` stuck `stale` with a healthy bucket | the newest capture is not the one being uploaded (often a missing local file) | check `local_missing_since` |
| `409` / `busy` / `upload_in_flight` | a concurrent attempt holds the per-artifact lock | wait; pressing again cannot start a second upload |

The console shows each of these in Persian with the technical code beside it. Quote
the code, not the translation, when you escalate.
