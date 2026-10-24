# AI gateway secret cutover — operator checklist (issue #757)

Copy-paste checklist for applying migration `0209_ai_gateway_secret_cutover.sql`
on a real deployment. It assumes Coolify-managed container(s) backed by a
Postgres database, and only uses commands and flags that exist in this
repository today — `scripts/migrate.ts`, `scripts/encrypt-ai-gateway-secrets.ts`,
`src/lib/ai-gateway-secret-cutover-policy.ts`, and
`src/lib/migration-status-service.ts`. It does not replace
[`docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md`](../phases/Phase-39-LiteLLM-Only-AI-Platform.md#secret-cutover-and-required-rollout)
("Secret cutover and required rollout") — that section is the authoritative
summary; this file is the same procedure expanded into exact commands, stop
conditions, and the redacted evidence to keep for each step.

**No step here was invented for this checklist.** Every command below is an
existing `npm run` script, an existing environment flag read by
`src/lib/ai-gateway-secret-cutover-policy.ts`, or a feature that already ships
in `/platform/system` or `/platform/backup`. Nothing bypasses the guards in
migration `0209` itself — `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true` is read by
the migration runner and set as a session-local Postgres flag; the migration's
own `DO $$ … $$` block still independently refuses to drop a column while any
plaintext secret lacks a ciphertext twin, or while that flag is unset and a
credential of either kind is stored. Setting the flag is an operator
*attestation* that steps 1–6 below are done — it is not, and cannot be, proof
by itself. Treat a `✅ PASS — confirmed` line as the only acceptable result at
every checkpoint; anything else means **stop** and follow that step's "If this
fails" note before continuing.

## Scope: which processes this actually touches

The AI gateway (LiteLLM) and its stored credentials are **central/cloud-only**
(`docs/architecture/deployment-architecture.md`: "AI … execute in cloud and require Cloud or
Hybrid" and "AI … [is] central-only"). A business running in `local` profile
never calls this code path, and a `hybrid` site's own local server does not
either — only the central/cloud app process(es) read `platform_ai_gateway` and
`ai_business_gateway`. "Every running instance" throughout this checklist means
**every replica of the central/cloud app**, not every customer's site install.
If Coolify runs this service as a single container, that is one instance to
check; if it is scaled to more than one replica, check every one of them by
name before proceeding.

## 0. Prerequisites

- [ ] You hold the Coolify project/service admin role for this deployment, and
      a `platform` console session with the `owner` role (needed for
      `/platform/backup`'s restore capability, `backup.restore`, if recovery is
      ever needed) and `ai.config.manage` (needed to use the Verify button on
      `/platform/ai`).
- [ ] You have shell access to the running app container (Coolify's
      "Execute Command" / terminal feature for the service, or SSH to the host
      and `docker exec` into it) — migrations must run with the same
      privileged `DATABASE_URL` the container's own entrypoint uses (see
      `docker-entrypoint.sh`), **not** the restricted `pos_app`/
      `RUNTIME_DATABASE_URL` the app server runs requests with. The restricted
      role cannot `ALTER TABLE`, so running this from a connection scoped to
      it will simply fail — that failure is expected and safe, not a sign to
      find a way around it.
- [ ] Confirm the currently deployed image is built from a commit that
      contains this cutover's code — at minimum PR #962/#969 (issue #757),
      ideally current `main`. From outside the deployment:
      ```bash
      curl -s https://<live-business-host>/api/health
      ```
      Compare the returned `version` (the image's `GIT_SHA` build arg) against
      `git rev-parse HEAD` for the commit you intend to certify. Record the
      exact SHA in your evidence log — every later step's evidence is only
      meaningful for *this* SHA.
      **If this fails:** do not continue. Redeploy to the intended SHA first
      (see `docs/deployment/production-deployment-verification.md`), then restart this
      checklist from Prerequisites.

## 1. Backup and recovery plan (before touching anything)

- [ ] From the console, `/platform/backup` → force a whole-system backup now
      (do not wait for the schedule). This is a `pg_dump` of the **entire**
      database — every business, every platform table including
      `platform_ai_gateway` and `ai_business_gateway` — encrypted if a
      platform passphrase is configured, written with a `.manifest.json`
      sidecar (`src/lib/platform-backup-service.ts`: app version, migration
      count, Postgres major, business count, size, sha256).
- [ ] Record, redacted: the artifact filename, its sha256 from the manifest,
      and the migration count the manifest reports. **Never** record the
      passphrase, the artifact's contents, or any decrypted value.
- [ ] Recovery plan if anything in steps 2–7 goes wrong: `/platform/backup` →
      restore this exact artifact. The restore flow validates it into a
      scratch database first (`<name>_restore_verify`, row-count checked, then
      dropped) with **nothing on the live server touched**, and only a second,
      explicit step with a typed confirmation phrase and the `backup.restore`
      capability performs the real swap — which itself takes its own emergency
      copy immediately before replacing the live database, and rolls that copy
      back automatically if the post-restore role re-grant or read-check
      fails. You do not need a separate manual `pg_dump`/`pg_restore` runbook
      for this: use this built-in path.
      **Stop condition:** if you cannot produce a successful backup here, do
      not proceed to step 2. Nothing below is reversible by hand once
      migration `0209` has run.

## 2. Safe backfill (steps 1–3 are also what the entrypoint already runs)

The container entrypoint already runs
`encrypt-ai-gateway-secrets.ts --keep-plaintext` on every boot — ciphertext for
any legacy plaintext key should already be present if this image has booted
even once. This step is the operator's own independent confirmation, run
explicitly and read carefully, not a rerun "just in case."

```bash
# Inside the running app container, using the privileged DATABASE_URL:
npm run db:encrypt-ai-secrets -- --dry-run
```
Expect output naming `0` or more rows that "would encrypt". Any number here is
fine — it only describes what the next command would do.

```bash
npm run db:encrypt-ai-secrets
```
Expect `encrypted N row(s)` (N may be 0) for each table, then
`ciphertext: verified M secret(s)` with **M equal to every row that holds a
credential** — this is the decrypt-verification step: it re-decrypts each
ciphertext and compares it byte-for-byte against the plaintext still present,
and only clears a row's plaintext once that specific row's ciphertext is
confirmed to decrypt correctly.

```bash
npm run db:encrypt-ai-secrets -- --verify-only
```
**Required result: `verified N row(s)` reporting `0` outstanding and no
`ciphertext_invalid` error.**
**If this fails** (a `ciphertext_invalid` throw, or any row count not
decreasing to the expected value): stop. Do not proceed to step 3 or step 6.
This means a ciphertext does not match its plaintext — investigate
`INTEGRATIONS_ENCRYPTION_KEY`/`JWT_SECRET` consistency across however this was
backfilled before going further; the plaintext column is still intact and
nothing has been lost.

**Evidence to record (redacted counts only, never the keys themselves):**
```
dry-run:     platform_ai_gateway: would encrypt <N>, ai_business_gateway: would encrypt <N>
backfill:    platform_ai_gateway: encrypted <N>, ai_business_gateway: encrypted <N>, ciphertext: verified <N>
verify-only: platform_ai_gateway: verified <N>, ai_business_gateway: verified <N>, ciphertext: verified <N>
```

## 3. Proof that every running instance uses ciphertext-backed reads

The running code already reads ciphertext-first (migration 0183 added the
columns; the current gateway readers in `src/lib/ai-gateway-service.ts`
(`readStoredCredential`) never read the legacy plaintext column for the
master or virtual key). This step proves it is actually working for live
data, not merely that the code path exists.

- [ ] On `/platform/ai`, for the platform gateway itself: use **تأیید اتصال**
      (the connection probe) and confirm it succeeds.
- [ ] For a sample of businesses that hold a virtual key — not just one —
      including at least one with a branch-level key: open each on
      `/platform/ai`, click **Verify**, and confirm `probe.ok: true` with a
      real latency reported. Repeat for every running replica if there is more
      than one app instance (hit the console through each instance directly
      if your load balancer can be pinned per-request, or redeploy nothing and
      wait for your balancer to naturally route a few requests to each).
      A probe succeeding through one replica does not prove another replica
      — possibly still running an older image, or configured with a different
      `INTEGRATIONS_ENCRYPTION_KEY`/`JWT_SECRET` — can read the same ciphertext.
- [ ] Confirm `/platform/system` reports the cutover block with
      `legacyColumnsPresent: true` (expected — 0209 has not run yet),
      `rowsMissingCiphertext: 0`, and `legacyPlaintextRows: 0` (after step 2).
      This is `GET /api/platform/system`, gated behind `requirePlatformAdmin()`
      (owner role) — read it from the authenticated console, not a public URL.

**If any probe fails:** stop. Do not proceed past this step. A failed probe on
even one instance means that instance cannot authenticate to LiteLLM right
now — dropping the plaintext column in step 6 would make that failure
permanent and undiagnosable from the row itself (the encrypted value stays
whatever it is; the discrepancy is in the environment, not the data). Fix the
environment or the credential first, confirmed by a passing probe on every
instance, then restart this step.

**Evidence to record:** which businesses/branches were probed (IDs, not keys),
`probe.ok` result per probe, and the `/platform/system` cutover block's
redacted JSON (`legacyColumnsPresent`, `rowsMissingCiphertext`,
`legacyPlaintextRows`, `deferFlag`, `verifiedFlag`, `flagsConflict`,
`blockedBy` — never a credential value).

## 4. Drain old instances

- [ ] In Coolify, confirm every replica of this service is running the image
      SHA you verified in step 0 — not an older one from before PR #962/#969
      (issue #757) landed. An instance predating that work could still be
      reading or writing the plaintext column directly; once step 6 drops it,
      that instance would start failing every AI gateway call.
- [ ] If Coolify is mid-rollout (old and new containers briefly coexist during
      a deploy), wait for the rollout to finish and confirm the old
      container(s) have actually stopped (Coolify's deployment log / container
      list), not merely that a new one started.
      **Stop condition:** if you cannot confirm every replica is the same,
      current SHA, do not proceed to step 6. Redeploy to converge them first.

**Evidence to record:** Coolify deployment/container list showing one image
digest across every replica, with its SHA matching step 0's `/api/health`
check.

## 5. Set the one-time confirmation and apply migration 0209

```bash
# Inside the running app container, with the privileged DATABASE_URL:
AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate
```

Expected output: `Applying 0209_ai_gateway_secret_cutover.sql ... ok` followed
by `Applied 1 migration(s).` (possibly alongside other, unrelated pending
migrations applied in the same run — that is normal).

**If you instead see** `ai_gateway_secret_backfill_required`: step 2 was not
actually clean on this database — go back to step 2, do not set the flag
again until `--verify-only` passes with zero outstanding rows.

**If you instead see** `Deferred 0209_ai_gateway_secret_cutover.sql` (i.e. the
flag was not read): confirm the variable is set in the *same shell/process*
invoking `npm run db:migrate` — Coolify's "Execute Command" feature may not
inherit the service's configured environment variables; export it explicitly
in that one command as shown above. Do **not** set
`AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true` as a standing service environment
variable — it is a one-time operator confirmation, not a deployment default
(`docs/phases/Phase-39-LiteLLM-Only-AI-Platform.md`), and a standing `true`
would let a *later*, unrelated plaintext key reach this migration unverified
on some future re-run against a different database.

Do not run this against the restricted runtime connection string — it lacks
`ALTER TABLE` privileges and will fail safely rather than partially apply.

## 6. Verify the migration record and that both legacy columns are gone

```bash
# Inside the running app container:
AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:encrypt-ai-secrets -- --keep-plaintext
```
Expected: `ai gateway secrets: legacy plaintext columns are gone (migration
0209 applied); nothing to do` — this is the same idempotent check the
container entrypoint runs on every future boot; seeing it here confirms the
columns are actually gone, not just that the migration file ran without
error.

Then, from the console (not a bare SQL client, so this is checked the same
way an operator without direct database access would see it):
- [ ] `/platform/system` → the cutover block now reports
      `applied: true`, `gated: false`, `legacyColumnsPresent: false`,
      `reasonCode: "ai_gateway_secret_cutover_applied"`.
- [ ] If you do have direct database access for an independent check:
      ```sql
      SELECT filename, applied_at FROM schema_migrations
       WHERE filename = '0209_ai_gateway_secret_cutover.sql';
      -- expect exactly one row

      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND ((table_name = 'platform_ai_gateway' AND column_name = 'master_key')
           OR (table_name = 'ai_business_gateway' AND column_name = 'virtual_key'));
      -- expect zero rows
      ```

**If `/platform/system` still shows `gated: true` or either column query
returns a row:** stop immediately and treat this as an incident, not a retry
target — re-running `npm run db:migrate` is safe (migrations are idempotent
and `0209` is now recorded if it actually applied), but if the column is
genuinely still present after an `Applied 1 migration(s).` result, that is
unexpected and should be investigated with the backup from step 1 in hand
before doing anything else.

**Afterwards:** confirm the `AI_GATEWAY_SECRET_CUTOVER_VERIFIED` variable is
not left set anywhere as a standing environment variable for this service —
it was only needed for the one command in step 5.

**Evidence to record:** the `schema_migrations` row (filename + `applied_at`),
the empty column query result, and `/platform/system`'s post-cutover cutover
block (same redacted fields as step 3).

## 7. Post-cutover checks

- [ ] **Health:** repeat step 0's `/api/health` check on every instance;
      confirm the app did not restart into a crash loop after the migration.
- [ ] **Credential-lifecycle regression:** on `/platform/ai`, for one test
      business/branch (not a real tenant's live key if avoidable), exercise
      Verify → Rotate → Verify again, and confirm the rotated key's `Verify`
      succeeds and the old one no longer does
      (`integration/ai-gateway-hardening.integration.test.ts` covers this
      programmatically; this is the same flow by hand against the real
      gateway).
- [ ] **Authorization:** confirm a session without `ai.config.manage` gets a
      403 from `PUT`/`POST /api/platform/ai/gateway`, and that the GET
      response never contains `virtualKey`/`masterKey` plaintext — only
      `credentialState`, `hasVirtualKey`, `keyAlias` (see
      `toPublicBusinessGateway`/`toPublicGatewayConfig` in
      `src/lib/ai-gateway.ts` and `src/lib/ai-gateway-service.ts`).
- [ ] **Tenant/branch isolation:** confirm a business-scoped session cannot
      address another business's `businessId` through the console's business
      lifecycle actions (refused with `ai_gateway_location_business_mismatch`
      for a location that is not that business's own, per
      `locationBelongsToBusiness()`), and that `/platform/ai`'s per-business
      rows never cross-leak between businesses (the fleet/branch readiness
      query is explicitly scoped to the businesses the signed-in admin's
      session can see).
- [ ] **No secrets in logs:** spot-check the container's recent logs for the
      cutover window; `sync_error`/audit payloads are designed to never
      contain a key value (see `CREDENTIAL_UNDECRYPTABLE_ERROR` and
      `recordCredentialSyncError` in `src/lib/ai-gateway-service.ts`) — confirm
      that held in practice, not just in the source.

**Evidence to record:** pass/fail for each bullet above, with business/branch
IDs (never key values) for the ones exercised against real data.

## Final sign-off template (paste into the issue/ops log)

```
AI gateway secret cutover — production verification
Deployment: <coolify project/service name>
App SHA verified: <sha>   (step 0)
Backup artifact: <filename>  sha256=<sha256>  (step 1)
Backfill:        dry-run / apply / verify-only — all clean (step 2)
Ciphertext reads verified on: <N businesses/branches>, <N instances> (step 3)
Instances drained/converged on <sha>: yes (step 4)
Migration 0209 applied at: <timestamp from schema_migrations> (step 5)
Legacy columns confirmed dropped: platform_ai_gateway.master_key,
  ai_business_gateway.virtual_key (step 6)
/platform/system cutover block: applied=true gated=false
  legacyColumnsPresent=false rowsMissingCiphertext=0 legacyPlaintextRows=0
Post-cutover health/authorization/tenant-isolation/credential-lifecycle
  checks: pass (step 7)
Operator: <name>   Date: <date>
```

Only a filled-in copy of this template — not a merged PR, not a passing CI
run, and not `AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true` by itself — is
sufficient evidence to close the production half of issue #757.
