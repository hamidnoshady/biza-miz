/**
 * Issue #902 — managed child accounts, the operational half.
 *
 * Everything expensive happens in a durable queue, never in a tenant request:
 * activating Growth, opening the messaging workbench or an operator clicking
 * "create" writes a job row and returns. This service owns the worker that
 * turns those rows into provider state, plus the console reads and the internal
 * master -> child credit journal.
 *
 * Three invariants, each backed by a database constraint rather than a comment:
 *
 *   1. **One child per business.** `UNIQUE (business_id)` and
 *      `UNIQUE (localid)` (migration 0258). Two workers cannot both "win" a
 *      create, and a lost response cannot produce a second account.
 *   2. **Look before you write.** Every retry first calls
 *      `client/fetchbylocalid` (the local id is the business UUID), and a
 *      `duplicate localid` is treated as "it landed" rather than an error.
 *   3. **An unknown funding outcome is not retried blindly.** A transfer is
 *      written `pending` before the provider call; a transport failure marks it
 *      `unknown`, and only provider balance evidence can resolve it.
 *
 * Provider names appear freely in this file: it is internal, Superadmin-only
 * surface. It must never be imported by a tenant-facing route — the
 * tenant-facing views come from `credentials.ts`, which has no provider
 * vocabulary at all.
 */
import { query, withTenant, withoutTenantScope } from "../db";
import { isAppAvailable } from "../app-availability-service";
import { resolveBusinessCapability } from "../entitlement-service";
import { getKavenegarMasterKey } from "../sms-config";
import {
  isLocalIdCollision,
  isUsernameCollision,
  type KavenegarChildAccount,
} from "./client";
import { KavenegarManagementClient, KavenegarManagementError, KavenegarTransportError } from "./rest";
import { getManagedChildPolicy, type ManagedChildPolicy } from "./policy";
import { readMasterBalanceMirror, type MasterBalanceMirror } from "./master-balance";
import { listFleetCampaignDemand } from "./pricing-service";
import { raiseServiceAlert, resolveServiceAlert } from "./alert-service";
import {
  buildChildProvisioningRequest,
  decideProvisionAction,
  generatePanelPassword,
  provisionRetryDelayMs,
  transitionProvisionState,
  type ProvisionState,
} from "./provisioning";
import {
  readAccountApiKey,
  readBusinessAccount,
  writeAccountApiKey,
  type BusinessAccountRow,
} from "./credentials";

/** Long enough for a provider round trip; short enough to reclaim a dead worker. */
export const PROVISIONING_LEASE_MS = 5 * 60_000;
/** Jobs per tick. Provisioning is low-volume and rate-limited by the provider. */
export const PROVISIONING_BATCH_SIZE = 5;
/** Businesses examined per tick for automatic provisioning. */
export const BACKFILL_CANDIDATE_LIMIT = 25;

export type ProvisioningJobKind = "provision" | "sync" | "suspend" | "reactivate" | "rotate_key" | "adopt";

export type ProvisioningJobRow = {
  id: string;
  business_id: string;
  account_id: string | null;
  job_kind: ProvisioningJobKind;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  last_error_code: string | null;
  requested_by: string | null;
};

export interface JobOutcome {
  jobId: string;
  businessId: string;
  kind: ProvisioningJobKind;
  result: "succeeded" | "retry" | "failed" | "skipped";
  code: string | null;
}

/** A failure the job should retry, with the reason recorded on the account. */
class JobRetryError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string = "",
  ) {
    super(code);
    this.name = "JobRetryError";
  }
}

/** A failure only an operator can resolve. */
class JobPermanentError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string = "",
  ) {
    super(code);
    this.name = "JobPermanentError";
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Write a provisioning job, idempotently.
 *
 * The partial unique index on `(business_id, job_kind) WHERE state IN
 * ('queued','running')` is what makes this safe to call from a hot path: five
 * simultaneous activations insert one row, and the other four read "already
 * queued". The account row's state is moved through the pure transition table
 * first, so an `active` account is never reset to `pending` by a stray call.
 */
export async function enqueueManagedAccountJob(input: {
  businessId: string;
  kind: ProvisioningJobKind;
  requestedBy?: string | null;
}): Promise<{ enqueued: boolean; state: ProvisionState | null }> {
  return withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<{ id: string; provision_state: ProvisionState }>(
      `SELECT id, provision_state FROM kavenegar_business_accounts WHERE business_id = $1`,
      [input.businessId],
    );
    const existing = rows[0] ?? null;

    if (!existing && !canCreateAccountFor(input.kind)) {
      return { enqueued: false, state: null };
    }

    const current: ProvisionState = existing?.provision_state ?? "not_provisioned";
    let state = current;
    let reason: string | null = null;

    if (input.kind === "provision") {
      try {
        const transition = transitionProvisionState(current, "request_provision");
        state = transition.state;
        reason = transition.reason;
      } catch {
        // Already active (or already being provisioned): the job is still
        // useful for `adopt`, but a plain provision must not disturb `active`.
        state = current;
        reason = null;
        if (input.kind === "provision" && current === "active") {
          return { enqueued: false, state: current };
        }
      }
    } else if (input.kind === "suspend") {
      try {
        const transition = transitionProvisionState(current, "suspend");
        state = transition.state;
        reason = transition.reason;
      } catch {
        return { enqueued: false, state: current };
      }
    } else if (input.kind === "reactivate") {
      try {
        const transition = transitionProvisionState(current, "reactivate");
        state = transition.state;
        reason = transition.reason;
      } catch {
        return { enqueued: false, state: current };
      }
    }

    let accountId = existing?.id ?? null;
    if (existing) {
      await query(
        `UPDATE kavenegar_business_accounts
            SET provision_state = $2, attention_reason = $3, updated_at = now()
          WHERE id = $1`,
        [existing.id, state, reason],
      );
    } else {
      const inserted = await query<{ id: string }>(
        `INSERT INTO kavenegar_business_accounts
           (business_id, localid, username, provision_state, attention_reason)
         VALUES ($1::uuid, $1::text, $2, $3, $4)
         ON CONFLICT (business_id) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [input.businessId, `bm${input.businessId.replace(/-/g, "").slice(0, 16)}`, state, reason],
      );
      accountId = inserted.rows[0]?.id ?? null;
    }

    const job = await query<{ id: string }>(
      `INSERT INTO kavenegar_provisioning_jobs (business_id, account_id, job_kind, requested_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (business_id, job_kind) WHERE state IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [input.businessId, accountId, input.kind, input.requestedBy ?? null],
    );

    return { enqueued: job.rowCount === 1, state };
  });
}

function canCreateAccountFor(kind: ProvisioningJobKind): boolean {
  return kind === "provision" || kind === "adopt";
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Lease exactly one job. `FOR UPDATE SKIP LOCKED` plus the lease timestamp is
 * what lets several app instances run this tick without doing the same provider
 * call twice.
 */
export async function claimNextProvisioningJob(workerId: string): Promise<ProvisioningJobRow | null> {
  return withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<ProvisioningJobRow>(
      `UPDATE kavenegar_provisioning_jobs j
          SET state = 'running',
              attempts = j.attempts + 1,
              locked_by = $1,
              lease_expires_at = now() + ($2::int * interval '1 millisecond'),
              updated_at = now()
        WHERE j.id = (
          SELECT id
            FROM kavenegar_provisioning_jobs
           WHERE (state = 'queued' AND next_attempt_at <= now())
              OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now())
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING j.id, j.business_id, j.account_id, j.job_kind, j.state,
                  j.attempts, j.max_attempts, j.next_attempt_at,
                  j.last_error_code, j.requested_by`,
      [workerId, PROVISIONING_LEASE_MS],
    );
    return rows[0] ?? null;
  });
}

async function finishJob(jobId: string, state: "succeeded" | "failed"): Promise<void> {
  await withoutTenantScope("kavenegar-provisioning", async () => {
    await query(
      `UPDATE kavenegar_provisioning_jobs
          SET state = $2, finished_at = now(), locked_by = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE id = $1`,
      [jobId, state],
    );
  });
}

async function retryJob(job: ProvisioningJobRow, code: string, detail: string): Promise<JobOutcome> {
  if (job.attempts >= job.max_attempts) {
    await markAttentionRequired(job.business_id, "attempts_exhausted");
    await withoutTenantScope("kavenegar-provisioning", async () => {
      await query(
        `UPDATE kavenegar_provisioning_jobs
            SET state = 'failed', last_error_code = $2, last_error_detail = $3,
                locked_by = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [job.id, "attempts_exhausted", truncate(detail)],
      );
    });
    return { jobId: job.id, businessId: job.business_id, kind: job.job_kind, result: "failed", code: "attempts_exhausted" };
  }

  const event = code === "username_collision"
    ? ("username_collision" as const)
    : code === "outcome_unknown"
      ? ("outcome_unknown" as const)
      : ("transient_failure" as const);

  await withTenant(job.business_id, async () => {
    const account = await readBusinessAccount(job.business_id);
    if (!account) return;
    let nextState: ProvisionState = "retry_pending";
    let reason: string | null = code;
    try {
      const transition = transitionProvisionState(account.provision_state, event);
      nextState = transition.state;
      reason = transition.reason ?? code;
    } catch {
      // `active`/`suspended` accounts have no retry transition: a failed sync
      // must not take a working child out of service.
      if (account.provision_state === "active" || account.provision_state === "suspended") {
        nextState = account.provision_state;
      }
    }
    await query(
      `UPDATE kavenegar_business_accounts
          SET provision_state = $2, attention_reason = $3, updated_at = now()
        WHERE id = $1`,
      [account.id, nextState, reason],
    );
  });

  const delay = provisionRetryDelayMs(job.attempts);
  await withoutTenantScope("kavenegar-provisioning", async () => {
    await query(
      `UPDATE kavenegar_provisioning_jobs
          SET state = 'queued',
              next_attempt_at = now() + ($2::int * interval '1 millisecond'),
              last_error_code = $3,
              last_error_detail = $4,
              locked_by = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [job.id, delay, code, truncate(detail)],
    );
  });
  return { jobId: job.id, businessId: job.business_id, kind: job.job_kind, result: "retry", code };
}

async function failPermanently(job: ProvisioningJobRow, code: string, detail: string): Promise<JobOutcome> {
  await markAttentionRequired(job.business_id, code);
  await withoutTenantScope("kavenegar-provisioning", async () => {
    await query(
      `UPDATE kavenegar_provisioning_jobs
          SET state = 'failed', last_error_code = $2, last_error_detail = $3,
              locked_by = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [job.id, code, truncate(detail)],
    );
  });
  // A job that will never be retried is a Superadmin action item, not a log
  // line (issue #902 §3: "failed transfers", and the same reasoning applies to a
  // child that could not be created at all). Raised after the state change so a
  // failed alert write cannot roll back a job outcome.
  await raiseServiceAlert({
    kind: "provisioning_failed",
    businessId: job.business_id,
    detail: { code, jobKind: job.job_kind, attempts: job.attempts },
  }).catch(() => undefined);
  return { jobId: job.id, businessId: job.business_id, kind: job.job_kind, result: "failed", code };
}

async function markAttentionRequired(businessId: string, reason: string): Promise<void> {
  await withoutTenantScope("kavenegar-provisioning", async () => {
    await query(
      `UPDATE kavenegar_business_accounts
          SET provision_state = 'attention_required', attention_reason = $2, updated_at = now()
        WHERE business_id = $1`,
      [businessId, reason],
    );
  });
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

/**
 * Process one claimed job. Exported for the integration test, which drives a
 * fake transport so no provider call ever leaves the process.
 */
export async function processProvisioningJob(
  job: ProvisioningJobRow,
  client: KavenegarManagementClient,
): Promise<JobOutcome> {
  try {
    await withTenant(job.business_id, async () => {
      switch (job.job_kind) {
        case "provision":
          await provisionChild(job, client);
          return;
        case "adopt":
          await adoptChildByProviderLookup(job, client, true);
          return;
        case "sync":
          await syncChild(job, client);
          return;
        case "suspend":
          await suspendChild(job, client);
          return;
        case "reactivate":
          await reactivateChild(job, client);
          return;
        case "rotate_key":
          await rotateChildKey(job, client);
          return;
      }
    });
    await finishJob(job.id, "succeeded");
    // The account is in step again: whatever the last attempt failed at is no
    // longer true. Closing here (rather than in the console) is what keeps the
    // alert ledger a statement about now.
    await resolveServiceAlert({ kind: "provisioning_failed", businessId: job.business_id }).catch(
      () => undefined,
    );
    return { jobId: job.id, businessId: job.business_id, kind: job.job_kind, result: "succeeded", code: null };
  } catch (error) {
    return handleJobError(job, error);
  }
}

async function handleJobError(job: ProvisioningJobRow, error: unknown): Promise<JobOutcome> {
  if (error instanceof JobPermanentError) {
    return failPermanently(job, error.code, error.detail);
  }
  if (error instanceof JobRetryError) {
    return retryJob(job, error.code, error.detail);
  }
  if (error instanceof KavenegarManagementError) {
    const classification = error.classification;
    if (classification.retryable) return retryJob(job, classification.code, error.operatorUrl);
    return failPermanently(job, classification.code, classification.operatorMessage);
  }
  if (error instanceof KavenegarTransportError) {
    return retryJob(
      job,
      error.ambiguous ? "outcome_unknown" : error.timeout ? "timeout" : "network",
      error.message,
    );
  }
  if (error instanceof Error && error.name === "KavenegarParseError") {
    // A body we cannot read is a provider incident, not a tenant's fault.
    return retryJob(job, "invalid_response", error.message);
  }
  console.error(
    `kavenegar provisioning job ${job.id} (${job.job_kind}) failed unexpectedly:`,
    error instanceof Error ? error.message : error,
  );
  return retryJob(job, "unexpected_error", error instanceof Error ? error.message : "unknown");
}

async function requireAccount(businessId: string): Promise<BusinessAccountRow> {
  const account = await readBusinessAccount(businessId);
  if (!account) throw new JobPermanentError("account_missing", "no account row for this business");
  return account;
}

async function provisionChild(job: ProvisioningJobRow, client: KavenegarManagementClient): Promise<void> {
  const account = await requireAccount(job.business_id);

  // Already done — the queue was retried after a successful create.
  if (account.provision_state === "active") {
    const credential = await readAccountApiKey(account.id);
    if (credential.ok) return;
    // `active` with no usable key is not usable: reconcile below and re-store.
  }

  const readFirst =
    account.provisioned_at !== null ||
    account.provision_state === "retry_pending" ||
    account.provision_state === "attention_required" ||
    job.attempts > 1;

  let child: KavenegarChildAccount | null = null;
  if (readFirst) {
    child = await fetchIfExists(client, account.localid);
  }

  // Only a create knows the tariff WE asked for; an adopted child's plan is
  // whatever the provider already had (and stays NULL until an operator sets
  // it), so a recovery must not overwrite it with a guess.
  let createdPlanId: number | null = null;
  if (!child) {
    const policy = await getManagedChildPolicy();
    const businessName = await readBusinessName(job.business_id);
    const request = buildChildProvisioningRequest({
      businessId: job.business_id,
      businessName,
      policy: {
        planId: policy.planId,
        minAllowedCreditRial: policy.minAllowedCreditRial,
        senderLines: policy.senderLines,
      },
      // A username collision (provider 502) is retried with a new name; the
      // suffix is the attempt number so the retry is deterministic.
      usernameAttempt: Math.max(0, job.attempts - 1),
      password: generatePanelPassword(),
    });
    try {
      child = await client.addChild(request);
      createdPlanId = request.planId;
    } catch (error) {
      if (error instanceof KavenegarManagementError && isLocalIdCollision(error.classification)) {
        // An earlier create DID land and its response was lost. Recover it.
        child = await fetchIfExists(client, account.localid);
        if (!child) {
          throw new JobRetryError("localid_conflict_unresolved", "local id exists but cannot be fetched");
        }
      } else if (error instanceof KavenegarManagementError && isUsernameCollision(error.classification)) {
        throw new JobRetryError("username_collision", "provider username collision");
      } else {
        throw error;
      }
    }
  }

  if (!child.apiKey) {
    throw new JobPermanentError("missing_child_key", "provider returned no child API key");
  }

  await activateAccount(account, child, { readFirst, adopted: false, planId: createdPlanId });
}

async function adoptChildByProviderLookup(
  job: ProvisioningJobRow,
  client: KavenegarManagementClient,
  markAdopted: boolean,
): Promise<void> {
  const account = await requireAccount(job.business_id);
  let child: KavenegarChildAccount | null = null;

  const credential = await readAccountApiKey(account.id);
  if (credential.ok) {
    try {
      child = await client.fetchChild(credential.credential.apiKey);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (!child) child = await fetchIfExists(client, account.localid);
  if (!child) throw new JobPermanentError("child_not_found", "no child account matches this local id");
  if (!child.apiKey) throw new JobPermanentError("missing_child_key", "provider returned no child API key");

  await activateAccount(account, child, { readFirst: true, adopted: markAdopted });
}

async function syncChild(job: ProvisioningJobRow, client: KavenegarManagementClient): Promise<void> {
  const account = await requireAccount(job.business_id);
  const credential = await readAccountApiKey(account.id);
  if (!credential.ok) throw new JobRetryError("credential_unavailable", credential.reason);

  let child: KavenegarChildAccount;
  try {
    child = await client.fetchChild(credential.credential.apiKey);
  } catch (error) {
    if (isNotFound(error)) {
      throw new JobPermanentError("child_not_found", "provider no longer knows this child");
    }
    throw error;
  }

  await storeSnapshot(account.id, child, {
    adopted: account.adopted,
    balanceRial: child.remainCreditRial,
  });
  if (child.status === "removed") {
    throw new JobPermanentError("provider_revoked", "provider reports the child as removed");
  }
}

async function suspendChild(job: ProvisioningJobRow, client: KavenegarManagementClient): Promise<void> {
  const account = await requireAccount(job.business_id);
  const credential = await readAccountApiKey(account.id);
  if (!credential.ok) throw new JobRetryError("credential_unavailable", credential.reason);

  await client.setChildStatus(credential.credential.apiKey, "0");
  await query(
    `UPDATE kavenegar_business_accounts
        SET provision_state = 'suspended', attention_reason = 'suspended',
            suspended_at = now(), updated_at = now()
      WHERE id = $1`,
    [account.id],
  );
}

async function reactivateChild(job: ProvisioningJobRow, client: KavenegarManagementClient): Promise<void> {
  const account = await requireAccount(job.business_id);
  const credential = await readAccountApiKey(account.id);
  if (!credential.ok) throw new JobRetryError("credential_unavailable", credential.reason);

  await client.setChildStatus(credential.credential.apiKey, "2");
  // `retry_pending` rather than `pending`: the child provably exists, so the
  // confirmation job must READ it before it writes anything. A `pending` row
  // would go straight to `client/add` and rely on the provider's duplicate
  // local id to stop a second account — correct, but by accident.
  await query(
    `UPDATE kavenegar_business_accounts
        SET provision_state = 'retry_pending', attention_reason = 'reactivated',
            suspended_at = NULL, updated_at = now()
      WHERE id = $1`,
    [account.id],
  );
  // Confirm the child really is usable before the next drain trusts it.
  await enqueueManagedAccountJob({ businessId: job.business_id, kind: "provision" });
}

async function rotateChildKey(job: ProvisioningJobRow, client: KavenegarManagementClient): Promise<void> {
  const account = await requireAccount(job.business_id);
  const credential = await readAccountApiKey(account.id);
  if (!credential.ok) throw new JobRetryError("credential_unavailable", credential.reason);

  let rotated: KavenegarChildAccount | null = null;
  try {
    rotated = await client.renewChildKey({ childApiKey: credential.credential.apiKey });
  } catch (error) {
    // A rotate whose response was lost may already have invalidated the old
    // key. Reading the child back by its stable local id reveals the new key.
    if (error instanceof KavenegarTransportError && error.ambiguous) {
      rotated = await fetchIfExists(client, account.localid);
    } else {
      throw error;
    }
  }
  if (!rotated?.apiKey) throw new JobRetryError("rotation_unconfirmed", "provider returned no new key");

  await storeSnapshot(account.id, rotated, { adopted: account.adopted });
  await writeAccountApiKey(account.id, rotated.apiKey);
}

// ---------------------------------------------------------------------------
// Shared writes
// ---------------------------------------------------------------------------

async function activateAccount(
  account: BusinessAccountRow,
  child: KavenegarChildAccount,
  options: { readFirst: boolean; adopted: boolean; planId?: number | null },
): Promise<void> {
  const event = account.provision_state === "provisioning" && !options.readFirst ? "succeeded" : "adopted";
  let state: ProvisionState = "active";
  try {
    state = transitionProvisionState(account.provision_state, event).state;
  } catch {
    state = "active";
  }

  await storeSnapshot(account.id, child, {
    adopted: options.adopted,
    planId: options.planId,
    balanceRial: child.remainCreditRial,
  });
  await query(
    `UPDATE kavenegar_business_accounts
        SET provision_state = $2,
            attention_reason = NULL,
            suspended_at = NULL,
            provisioned_at = COALESCE(provisioned_at, now()),
            updated_at = now()
      WHERE id = $1`,
    [account.id, state],
  );
  await writeAccountApiKey(account.id, child.apiKey);
}

async function storeSnapshot(
  accountId: string,
  child: KavenegarChildAccount,
  options: {
    adopted: boolean;
    planId?: number | null;
    /**
     * The balance the provider just reported, when the response actually
     * carried one. `client/renewkey` does not, and writing 0 there would make
     * the funding planner believe the child was empty and fund it again.
     */
    balanceRial?: number | null;
  },
): Promise<void> {
  await query(
    `UPDATE kavenegar_business_accounts
        SET provider_status = $2,
            username = CASE WHEN $3 <> '' THEN $3 ELSE username END,
            plan_id = COALESCE($11, plan_id),
            pricing_name = COALESCE($4, pricing_name),
            sms_farsi_cost_rial = COALESCE($5, sms_farsi_cost_rial),
            sms_english_cost_rial = COALESCE($6, sms_english_cost_rial),
            min_allowed_credit_rial = COALESCE($7, min_allowed_credit_rial),
            sender_lines = CASE WHEN cardinality($8::text[]) > 0 THEN $8::text[] ELSE sender_lines END,
            localid = CASE WHEN $9 <> '' THEN $9 ELSE localid END,
            provider_balance_rial = COALESCE($12::bigint, provider_balance_rial),
            provider_balance_at = CASE WHEN $12::bigint IS NULL THEN provider_balance_at ELSE now() END,
            adopted = adopted OR $10,
            last_synced_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [
      accountId,
      child.status,
      child.username,
      child.pricingName,
      child.smsFarsiCostRial,
      child.smsEnglishCostRial,
      child.minAllowedCreditRial,
      child.assignedLines,
      child.localId,
      options.adopted,
      options.planId ?? null,
      options.balanceRial === undefined || options.balanceRial === null
        ? null
        : Math.max(0, Math.trunc(options.balanceRial)),
    ],
  );
}

async function fetchIfExists(
  client: KavenegarManagementClient,
  localId: string,
): Promise<KavenegarChildAccount | null> {
  try {
    return await client.fetchChildByLocalId(localId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof KavenegarManagementError && error.classification.code === "not_found";
}

async function readBusinessName(businessId: string): Promise<string> {
  const { rows } = await query<{ name: string }>(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
  return rows[0]?.name ?? "Bizamiz";
}

function truncate(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}…`;
}

// ---------------------------------------------------------------------------
// Internal provider credit journal
// ---------------------------------------------------------------------------

export type CreditTransferRow = {
  id: string;
  business_id: string;
  account_id: string;
  amount_rial: string | number;
  idempotency_key: string;
  state: "pending" | "applied" | "unknown" | "failed";
  last_error_code: string | null;
  balance_after_rial: string | number | null;
  created_at: Date;
  applied_at: Date | null;
};

/**
 * Move provider credit from the master account to one child.
 *
 * This is **operational pre-funding**, not a tenant transaction: the tenant
 * bought retail credit into the central wallet, and the platform decides when
 * and how much provider credit a child needs. The row is written before the
 * provider call so a crash cannot lose the fact that money may have moved; a
 * transport failure leaves it `unknown`, and the reconciliation read is the
 * only thing allowed to resolve it.
 */
export async function transferManagedCredit(input: {
  businessId: string;
  amountRial: number;
  idempotencyKey: string;
  requestedBy?: string | null;
  reason?: string;
  client?: KavenegarManagementClient;
}): Promise<{ transfer: CreditTransferRow; duplicate: boolean }> {
  const amount = Math.trunc(input.amountRial);
  if (amount === 0 || Math.abs(amount) < 1_000) {
    throw new Error("credit_transfer_amount_invalid");
  }

  const account = await withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<{ id: string; provision_state: ProvisionState }>(
      `SELECT id, provision_state FROM kavenegar_business_accounts WHERE business_id = $1`,
      [input.businessId],
    );
    return rows[0] ?? null;
  });
  if (!account) throw new Error("credit_transfer_account_missing");
  if (account.provision_state !== "active") throw new Error("credit_transfer_account_not_active");

  const inserted = await withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<CreditTransferRow>(
      `INSERT INTO kavenegar_credit_transfers
         (business_id, account_id, amount_rial, idempotency_key, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, business_id, account_id, amount_rial, idempotency_key, state,
                 last_error_code, balance_after_rial, created_at, applied_at`,
      [input.businessId, account.id, amount, input.idempotencyKey, input.reason ?? null, input.requestedBy ?? null],
    );
    return rows[0] ?? null;
  });

  if (!inserted) {
    // The key was already used. Answer from the committed row; never move money
    // twice, and never "repair" an unknown outcome by retrying.
    const existing = await withoutTenantScope("kavenegar-provisioning", async () => {
      const { rows } = await query<CreditTransferRow>(
        `SELECT id, business_id, account_id, amount_rial, idempotency_key, state,
                last_error_code, balance_after_rial, created_at, applied_at
           FROM kavenegar_credit_transfers WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      return rows[0] ?? null;
    });
    if (!existing) throw new Error("credit_transfer_conflict_unresolved");
    return { transfer: existing, duplicate: true };
  }

  const client = input.client ?? (await requireClient());
  return {
    transfer: await applyReservedCreditTransfer({ transfer: inserted, client }),
    duplicate: false,
  };
}

/**
 * Attempt a transfer row that is already committed as `pending`.
 *
 * Splitting the request out of `transferManagedCredit` is what makes the
 * funding pass safe under concurrency (issue #902 §3): the *decision* — caps,
 * limits, the master floor, the idempotency key — is taken and committed inside
 * one short transaction that holds an advisory lock, and only then does the
 * provider call happen, outside any transaction. A provider call must never be
 * made while holding a database lock, and a decision must never be taken
 * without one.
 *
 * Every failure lands in a state that reconciles:
 *   * a transport failure whose request may have arrived ⇒ `unknown`, never
 *     retried automatically (the reconciliation read resolves it);
 *   * a definite provider rejection ⇒ `failed` with its internal code;
 *   * a missing credential ⇒ `failed`, because nothing was sent.
 */
export async function applyReservedCreditTransfer(input: {
  transfer: CreditTransferRow;
  client: KavenegarManagementClient;
}): Promise<CreditTransferRow> {
  const amount = Number(input.transfer.amount_rial);
  const credential = await readAccountApiKey(input.transfer.account_id);
  if (!credential.ok) {
    return markTransfer(input.transfer.id, "failed", "credential_unavailable", null);
  }
  try {
    const child = await input.client.chargeChildCredit({
      childApiKey: credential.credential.apiKey,
      creditRial: amount,
      description: "Bizamiz managed service funding",
    });
    return markTransfer(input.transfer.id, "applied", null, child.remainCreditRial);
  } catch (error) {
    if (error instanceof KavenegarTransportError) {
      const code = error.ambiguous ? "outcome_unknown" : error.timeout ? "timeout" : "network";
      return markTransfer(input.transfer.id, error.ambiguous ? "unknown" : "failed", code, null);
    }
    if (error instanceof KavenegarManagementError) {
      return markTransfer(input.transfer.id, "failed", error.classification.code, null);
    }
    throw error;
  }
}

async function markTransfer(
  id: string,
  state: CreditTransferRow["state"],
  code: string | null,
  balanceAfter: number | null,
): Promise<CreditTransferRow> {
  return withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<CreditTransferRow>(
      `UPDATE kavenegar_credit_transfers
          SET state = $2,
              last_error_code = $3,
              balance_after_rial = $4,
              applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, business_id, account_id, amount_rial, idempotency_key, state,
                  last_error_code, balance_after_rial, created_at, applied_at`,
      [id, state, code, balanceAfter],
    );
    const transfer = rows[0];
    if (transfer && state === "applied" && balanceAfter !== null) {
      // Keep the account's cached balance in step with what the provider just
      // reported. Funding and reconciliation read this column, and a stale value
      // would either fund twice or report drift that is not there.
      await query(
        `UPDATE kavenegar_business_accounts
            SET provider_balance_rial = $2, provider_balance_at = now(), updated_at = now()
          WHERE id = $1`,
        [transfer.account_id, Math.max(0, Math.trunc(balanceAfter))],
      );
    }
    return transfer;
  });
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface ManagedServiceTickResult {
  enqueued: number;
  processed: number;
  failed: number;
}

/**
 * One pass: enqueue what eligibility says should exist, then drain a bounded
 * number of jobs. Swallows its own failures — a provider outage must never take
 * down a request path.
 */
export async function runKavenegarManagedServiceTick(
  options: { client?: KavenegarManagementClient; now?: Date } = {},
): Promise<ManagedServiceTickResult> {
  const policy = await getManagedChildPolicy();
  if (!policy.enabled) return { enqueued: 0, processed: 0, failed: 0 };

  let enqueued = 0;
  try {
    enqueued = await enqueueEligibleBusinesses(policy);
  } catch (error) {
    console.error("kavenegar eligibility sweep failed:", error instanceof Error ? error.message : error);
  }

  let client = options.client ?? null;
  if (!client) {
    try {
      client = await requireClient();
    } catch {
      return { enqueued, processed: 0, failed: 0 };
    }
  }

  let processed = 0;
  let failed = 0;
  for (let index = 0; index < PROVISIONING_BATCH_SIZE; index += 1) {
    const job = await claimNextProvisioningJob(`tick:${process.pid}`);
    if (!job) break;
    const outcome = await processProvisioningJob(job, client);
    processed += 1;
    if (outcome.result === "failed") failed += 1;
  }
  return { enqueued, processed, failed };
}

async function enqueueEligibleBusinesses(policy: ManagedChildPolicy): Promise<number> {
  const candidates = await withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT b.id AS business_id
         FROM businesses b
        WHERE NOT EXISTS (
                SELECT 1 FROM kavenegar_business_accounts a WHERE a.business_id = b.id
              )
          AND EXISTS (
                SELECT 1 FROM business_features f
                 WHERE f.business_id = b.id
                   AND f.flag_key IN ('app.growth', 'cloud.messaging')
                   AND f.enabled
              )
        ORDER BY b.created_at
        LIMIT $1`,
      [BACKFILL_CANDIDATE_LIMIT],
    );
    const { rows: retries } = await query<{ business_id: string }>(
      // `active` is included on purpose: a lapse in entitlement is a change in
      // the OTHER direction, and nothing writes a row when Growth expires. The
      // sweep is the only thing that notices, so it must look at working
      // accounts too — bounded, oldest-checked first.
      `SELECT a.business_id
         FROM kavenegar_business_accounts a
        WHERE a.provision_state IN ('retry_pending', 'suspended', 'active')
          AND NOT EXISTS (
                SELECT 1 FROM kavenegar_provisioning_jobs j
                 WHERE j.business_id = a.business_id AND j.state IN ('queued', 'running')
              )
        ORDER BY a.updated_at
        LIMIT $1`,
      [BACKFILL_CANDIDATE_LIMIT],
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of [...rows, ...retries]) {
      if (seen.has(row.business_id)) continue;
      seen.add(row.business_id);
      out.push(row.business_id);
    }
    return out;
  });

  let enqueued = 0;
  for (const businessId of candidates) {
    try {
      const decision = await withTenant(businessId, async () => {
        const [entitlement, appAvailable, account] = await Promise.all([
          resolveBusinessCapability(businessId, "cloud.messaging"),
          isAppAvailable(businessId, "growth"),
          readBusinessAccount(businessId),
        ]);
        return decideProvisionAction({
          policyEnabled: policy.enabled,
          entitled: entitlement.allowed,
          appAvailable,
          existingState: account?.provision_state ?? null,
          now: new Date(),
          lastAttemptAt: account?.updated_at ?? null,
        });
      });

      if (decision.action === "provision" || decision.action === "reactivate") {
        const result = await enqueueManagedAccountJob({
          businessId,
          kind: decision.action === "reactivate" ? "reactivate" : "provision",
        });
        if (result.enqueued) enqueued += 1;
      } else if (decision.action === "suspend") {
        const result = await enqueueManagedAccountJob({ businessId, kind: "suspend" });
        if (result.enqueued) enqueued += 1;
      }
    } catch (error) {
      console.error(
        `kavenegar eligibility check failed for business ${businessId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return enqueued;
}

async function requireClient(): Promise<KavenegarManagementClient> {
  const master = await getKavenegarMasterKey();
  if (!master.apiKey) throw new Error("kavenegar_master_key_missing");
  return new KavenegarManagementClient(master.apiKey);
}

/**
 * The privileged adapter for the console's on-demand actions (probe, funding,
 * reconciliation, template submission).
 *
 * It resolves the SAME master credential as the OTP path and the worker; a
 * second way to construct a client would be a second place for the account to
 * disagree with itself. Tests inject their own client and never call this.
 */
export async function createKavenegarManagementClient(): Promise<KavenegarManagementClient> {
  return requireClient();
}

// ---------------------------------------------------------------------------
// Console reads
// ---------------------------------------------------------------------------

export interface ManagedAccountConsoleRow {
  id: string;
  businessId: string;
  businessName: string | null;
  localId: string;
  username: string;
  state: ProvisionState;
  attentionReason: string | null;
  providerStatus: string | null;
  keyHint: string | null;
  planId: number | null;
  pricingName: string | null;
  smsFarsiCostRial: number | null;
  smsEnglishCostRial: number | null;
  minAllowedCreditRial: number | null;
  senderLines: string[];
  adopted: boolean;
  /** Wholesale credit the provider last reported. Internal; never tenant copy. */
  providerBalanceRial: number | null;
  providerBalanceAt: string | null;
  provisionedAt: string | null;
  lastSyncedAt: string | null;
  suspendedAt: string | null;
}

/** Superadmin-only list. Provider detail is allowed here; tenants never call it. */
export async function listManagedAccountsForConsole(): Promise<ManagedAccountConsoleRow[]> {
  const { rows } = await withoutTenantScope("platform", async () =>
    query<{
      id: string;
      business_id: string;
      business_name: string | null;
      localid: string;
      username: string;
      provision_state: ProvisionState;
      attention_reason: string | null;
      provider_status: string | null;
      api_key_hint: string | null;
      plan_id: number | null;
      pricing_name: string | null;
      sms_farsi_cost_rial: string | number | null;
      sms_english_cost_rial: string | number | null;
      min_allowed_credit_rial: string | number | null;
      sender_lines: string[];
      adopted: boolean;
      provider_balance_rial: string | number | null;
      provider_balance_at: Date | null;
      provisioned_at: Date | null;
      last_synced_at: Date | null;
      suspended_at: Date | null;
    }>(
      `SELECT a.id, a.business_id, b.name AS business_name, a.localid, a.username,
              a.provision_state, a.attention_reason, a.provider_status, c.api_key_hint,
              a.plan_id, a.pricing_name, a.sms_farsi_cost_rial, a.sms_english_cost_rial,
              a.min_allowed_credit_rial, a.sender_lines, a.adopted,
              a.provider_balance_rial, a.provider_balance_at,
              a.provisioned_at, a.last_synced_at, a.suspended_at
         FROM kavenegar_business_accounts a
         JOIN businesses b ON b.id = a.business_id
         LEFT JOIN kavenegar_account_credentials c ON c.account_id = a.id
        ORDER BY a.updated_at DESC
        LIMIT 500`,
    ),
  );

  return rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name,
    localId: row.localid,
    username: row.username,
    state: row.provision_state,
    attentionReason: row.attention_reason,
    providerStatus: row.provider_status,
    keyHint: row.api_key_hint,
    planId: row.plan_id,
    pricingName: row.pricing_name,
    smsFarsiCostRial: numericOrNull(row.sms_farsi_cost_rial),
    smsEnglishCostRial: numericOrNull(row.sms_english_cost_rial),
    minAllowedCreditRial: numericOrNull(row.min_allowed_credit_rial),
    senderLines: row.sender_lines ?? [],
    adopted: row.adopted,
    providerBalanceRial: numericOrNull(row.provider_balance_rial),
    providerBalanceAt: row.provider_balance_at?.toISOString() ?? null,
    provisionedAt: row.provisioned_at?.toISOString() ?? null,
    lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
    suspendedAt: row.suspended_at?.toISOString() ?? null,
  }));
}

export interface ManagedServiceConsoleSnapshot {
  policy: ManagedChildPolicy;
  accounts: ManagedAccountConsoleRow[];
  /**
   * The master's credit as the last funding pass observed it, with the age and
   * the failed-read flag — `masterBalanceView` turns it into a verdict for the
   * screen. Provider-facing and platform-only, like every other field here.
   */
  masterBalance: MasterBalanceMirror;
  /**
   * Queued SMS work per business, in segments — the input the funding planner
   * sizes transfers against since §9 item 1. Counts only; the money it implies
   * is the planner's arithmetic, not the console's.
   */
  pendingDemand: { businessId: string; messages: number; segments: number; campaigns: number }[];
  recentJobs: {
    id: string;
    businessId: string;
    kind: ProvisioningJobKind;
    state: string;
    attempts: number;
    lastErrorCode: string | null;
    createdAt: string;
  }[];
  unresolvedTransfers: {
    id: string;
    businessId: string;
    amountRial: number;
    state: string;
    createdAt: string;
  }[];
}

export async function getManagedServiceConsoleSnapshot(): Promise<ManagedServiceConsoleSnapshot> {
  const [policy, masterBalance, accounts, demand, jobs, transfers] = await Promise.all([
    getManagedChildPolicy(),
    // Issue #902 §9 item 4: what the last funding pass saw the provider report,
    // so an operator reads the console instead of asking the provider by hand.
    readMasterBalanceMirror(),
    listManagedAccountsForConsole(),
    // Issue #902 §9 item 1: the queue each child is holding, so an operator can
    // see the demand the planner is sizing transfers against.
    listFleetCampaignDemand(),
    withoutTenantScope("platform", async () => {
      const { rows } = await query<{
        id: string;
        business_id: string;
        job_kind: ProvisioningJobKind;
        state: string;
        attempts: number;
        last_error_code: string | null;
        created_at: Date;
      }>(
        `SELECT id, business_id, job_kind, state, attempts, last_error_code, created_at
           FROM kavenegar_provisioning_jobs
          ORDER BY created_at DESC
          LIMIT 50`,
      );
      return rows;
    }),
    withoutTenantScope("platform", async () => {
      const { rows } = await query<{
        id: string;
        business_id: string;
        amount_rial: string | number;
        state: string;
        created_at: Date;
      }>(
        `SELECT id, business_id, amount_rial, state, created_at
           FROM kavenegar_credit_transfers
          WHERE state IN ('pending', 'unknown')
          ORDER BY created_at DESC
          LIMIT 50`,
      );
      return rows;
    }),
  ]);

  return {
    policy,
    accounts,
    masterBalance,
    pendingDemand: demand,
    recentJobs: jobs.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      kind: row.job_kind,
      state: row.state,
      attempts: row.attempts,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at.toISOString(),
    })),
    unresolvedTransfers: transfers.map((row) => ({
      id: row.id,
      businessId: row.business_id,
      amountRial: Number(row.amount_rial),
      state: row.state,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

/**
 * Probe the master account's eligibility for the customer-management API.
 *
 * The provider restricts it to high-volume accounts, so "is this master allowed
 * to create children?" has to be answered before the console enables the
 * switch — and answered by the provider, not by a guess. `client/list` is the
 * cheapest read that only an eligible master can perform.
 */
export async function probeCustomerManagementEligibility(
  client?: KavenegarManagementClient,
): Promise<{ eligible: boolean; code: string | null }> {
  try {
    const active = client ?? (await requireClient());
    await active.listChildren();
    return { eligible: true, code: null };
  } catch (error) {
    if (error instanceof KavenegarManagementError) {
      return { eligible: false, code: error.classification.code };
    }
    if (error instanceof KavenegarTransportError) {
      return { eligible: false, code: error.timeout ? "timeout" : "network" };
    }
    return { eligible: false, code: "unknown" };
  }
}

function numericOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
