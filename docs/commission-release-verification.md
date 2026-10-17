# Commission #869 — release verification (2026-10-16)

This record supplements the historical implementation plan. It distinguishes implementation,
acceptance, publication and deployment. **Release verification is still blocked; do not close
#869 or claim a successful production rollout.** No deployment, release or merge is authorized
by this document.

## Refreshed baseline

- Commission completion PR [#964](https://github.com/hamidnoshady/biza-miz/pull/964)
  merged as `530852d400307eaa56d88875c368586ed7f09c8d`.
- Current main at this audit: `cf2b39dd046aec1ed71be26d4f41f5618f0ab7a9`
  (Desktop 1.0.59). Its parent is application source
  `5f62f589f5340050f8bce15e422ec7fd244dfea4`; the child changes only the two
  Electron version metadata files. Later accounting, payroll-dimension, automotive
  sync and AI changes are preserved, not replaced with the older commission branch.
- The exact application source `5f62f58` passed the complete
  [test workflow 38789811744](https://github.com/hamidnoshady/biza-miz/actions/runs/38789811744)
  and [shippables 38789811748](https://github.com/hamidnoshady/biza-miz/actions/runs/38789811748).
  The test run includes real PostgreSQL financial/contention/RLS/payroll/sync tests,
  API permissions, unit/typecheck/lint/build/visual checks and successful separate
  **Commission multi-user lifecycle E2E (Rial)**, **(Toman)**, and **Commission real
  two-instance transport and authority** steps (media job `116611141785`).
- This maintains evidence for reconciliation snapshots, idempotent payout/reversal,
  payroll mutual exclusion, tenant isolation, permissions and statement paging/export.
  The controlled central/site transport is not customer-production, physical-pairing
  or full IAM-gated automatic-scheduler acceptance. Earlier local suite counts belong
  to `3b5bb80`, not this newer source; inherited unrelated skips are not new passes.

## Failures: what is and is not established

### Coolify: NOT superseded by a successful deployment

Both original [publish 38767127622](https://github.com/hamidnoshady/biza-miz/actions/runs/38767127622)
(job `116540978681`) and latest
[publish 38789811789](https://github.com/hamidnoshady/biza-miz/actions/runs/38789811789)
(job `116615568294`) fail at **Trigger Coolify redeploy**. On the latest run,
pre-publish lint/typecheck/unit/build, registry login and **Build and push** passed;
**Verify the published image and canonical routes are live** was skipped.

The API annotation contains only **Process completed with exit code 1.** It does
NOT establish HTTP status, response body, token validity, resource existence or live
revision. Full-run and individual-job log downloads were attempted; their redirects
to `results-receiver.actions.githubusercontent.com` / Azure blob log storage fail
with EOF in this restricted environment. The check-run output has no log body.
Consequently the Coolify root cause is **unresolved**, not assumed to be a bad token,
missing setting or code defect. An operator must read the failing step in Actions
and retain a sanitized HTTP status/body or network error. Do not paste tokens or
signed log URLs. No speculative Coolify fix or retry was made.

### Desktop: old failure superseded, unsafe workflow remains a confirmed defect

Original [Windows 38767128004](https://github.com/hamidnoshady/biza-miz/actions/runs/38767128004)
passed packaged E2E (`116533146749`) then failed **Commit the bump and tag desktop-vX.Y.Z**
(`116542675826`). Annotation: **Could not push desktop-v1.0.57**. Raw Git stderr is
unavailable through the blocked log downloads; do not assert a particular server
rejection/permission message.

Independent repository/ref evidence confirms a partial-update/provenance problem:
`desktop-v1.0.57` points at `9c03e45f92d7964a1d4138c4f8373bc2a486aae5`, whose
parent is original packaged source `530852d`. Main instead contains a separate
Desktop 1.0.57 bump `35f2cc4fc6cf42cba5016eaa61c3c841230a47c0`, parent `8c4571b`.
The workflow pushed main and tag non-atomically, rebased after failure, then used
`git tag -f` locally. Thus a rejected branch update could still publish the tag,
and a later retry could publish a rebased main bump but reject the already-created
tag. This is a confirmed unsafe algorithm/ref divergence, even without claiming
which raw push error first occurred. Existing history/tags must not be rewritten.

Newer [Windows 38789811769](https://github.com/hamidnoshady/biza-miz/actions/runs/38789811769)
passed packaged Windows E2E (`116611140653`) AND version/tag recording
(`116620352809`). `desktop-v1.0.59` points to current `cf2b39d`, parent `5f62f58`.
Artifact `12000024819` is **business-suite-desktop-installer-1.0.59**, artifact-archive
digest `sha256:9ae5f23d7a68bb99d8e4bf9d420bcd20970226a66967b06601a2550ff0898352`.
This is NOT an installer-file hash or container digest. No GitHub Release objects
were listed; distinguish a tag/Actions installer from a published signed release.
Windows Server packaged acceptance is not retail Windows 11 or signing attestation.
Do not rerun the old release or create another release to replace this success.

The focused fix uses `scripts/record-desktop-release.mjs`:
- Exact tested checkout and main-only eligibility; measurement/branch builds cannot release.
- A stale source is explicitly **superseded**, pushing no commit/tag.
- Version/lock consistency and forward-only canonical versions are required.
- The version commit directly follows the tested source and records source SHA,
  acceptance-run URL and installer artifact name. Embedded installer provenance stays
  untouched; no CI-generated build metadata is committed.
- One normal `git push --atomic` writes main and a new immutable tag together.
  Concurrent main/tag updates or branch protections reject both. No force, rebase,
  retry, permissions expansion or non-atomic fallback.
- Real temporary bare-remote tests cover success, stale source, racing main, racing
  tag, branch rejection, existing tag, dirty source, downgrade and inconsistent lock.
  They run in the existing Windows unit job. No release is performed by tests.

### Cancelled workflows: superseded, NOT successful

Original test `38767127951` annotation on job `116533150195`:
**Canceling since a higher priority waiting request for test-test-refs/heads/main exists**.
Original shippables `38767127836`, job `116543100764`:
**Canceling since a higher priority waiting request for verify-shippables-refs/heads/main exists**.
Both workflows deliberately use per-main concurrency with `cancel-in-progress: true`.
New main pushes arrived (first `8c4571b` at 16:30 UTC), and the originals were
cancelled, not green. The later successful test/shippables runs on `5f62f58` above
supersede that incomplete evidence. No cancellation bypass or weakened fan-in is needed.

## Operator handoff — production still unverified

1. **Refresh before acting.** If main/publication advanced beyond this record, use the
   newest successfully published, tested application SHA instead. Do NOT replay run
   `38767127622` or deploy image `sha-530852d`. At this checkpoint the correct known
   published image is **`ghcr.io/hamidnoshady/biza-miz:sha-5f62f58`**, source
   **`5f62f589f5340050f8bce15e422ec7fd244dfea4`** (not the metadata-only `cf2b39d`).
   `latest` is mutable: do not use it as immutable verification evidence.
2. **Obtain and pin the real digest.** GitHub package-version lookup returned
   **403 Resource not accessible by integration**; raw build logs/artifacts are also
   inaccessible here. The manifest digest is therefore **not verified** and is not
   fabricated from an artifact hash. An authorized registry operator should run:
   ```sh
   IMAGE=ghcr.io/hamidnoshady/biza-miz:sha-5f62f58
   docker pull "$IMAGE"
   docker image inspect "$IMAGE" --format '{{json .RepoDigests}} {{json .Config.Env}}'
   ```
   Retain the `ghcr.io/hamidnoshady/biza-miz@sha256:...` digest and
   `APP_IMAGE_SHA=5f62f58`, corroborated by the successful Build and push step.
3. **Read the actual error before changing Coolify.** Check Actions run
   `38789811789`, step **Trigger Coolify redeploy**. The configured request is POST
   `https://manage.eshobe.com/api/v1/services/jrfpvt0rctfkmzpw1ao5c1cb/restart?latest=true`.
   Check that UUID is the intended Docker-image **service**, its image/pull credentials
   match the verified digest, and repository secret **COOLIFY_API_TOKEN** has existing
   least-privilege access to restart that service. For actual 401/403 check token/access;
   for 404 check resource kind/UUID; for timeout/TLS/DNS check runner reachability.
   These are conditional checks, not diagnosed causes. Never log the token or broaden
   GitHub/Coolify permissions just to turn the job green.
4. **Only after explicit deployment approval**, deploy the verified current digest in
   the intended Coolify service and retain deployment ID/status. Do not blindly retry
   an ambiguous POST: first check whether it already queued a restart. Set non-secret
   repository variable **PRODUCTION_HEALTH_URL** to `https://<live-host>/api/health`.
   Then run (Node 24):
   ```sh
   node scripts/verify-production-deploy.mjs --health-url https://<live-host>/api/health --expected-sha 5f62f58
   ```
   Require health's baked revision and canonical authenticated-route redirects, plus
   Coolify's running image digest. A registry push/restart acknowledgment alone is insufficient.
5. **Retain migration and commission evidence.** Health is DB-free; also retain successful
   entrypoint migration/readiness logs and authenticated database access under the normal
   restricted role. In an isolated authorized smoke tenant, verify exact liability/GL
   reconciliation, partial payout + same-key retry + reversal, payroll/standalone mutual
   exclusion, permission/foreign-tenant refusals and statement paging/export. Record source
   payout/reversal/journal IDs and before/after balances; never perform test payments in a
   customer's live ledger or hide a real discrepancy. Retain the existing controlled
   central/site and packaged-Windows CI evidence separately from production smoke results.

## Review and issue update

The new workflow safety changes must earn relevant CI at their exact PR head before
merge approval is requested. No application financial logic, thresholds, security tests
or visual baselines are changed. The current PR and live CI outcomes belong in its body;
this versioned record must not pre-claim future runs passed.

#869 is OPEN. The prior close attempt was denied by integration permissions. Do not retry
closure while release verification is blocked. If issue update is denied, give this text
to a maintainer (and stop retrying the mutation):

> PR #964 is merged as 530852d. Newer source 5f62f58 passed full test/shippables,
> actual Rial/Toman commission browser and controlled central/site transport; Windows
> 1.0.59 passed packaged acceptance and its tag is cf2b39d. The original cancelled runs
> were superseded, not successful. Latest container publication passed, but Coolify
> redeploy failed and live verification was skipped. Coolify error body and registry
> digest could not be retrieved with this integration/network access. A focused,
> unmerged PR adds atomic source-pinned desktop version/tag recording; require its
> exact-head CI and review. Keep #869 OPEN pending the operator evidence and approved
> release/deployment work listed in docs/commission-release-verification.md. Do not
> mark production deployment or the full release-verification task complete yet.
