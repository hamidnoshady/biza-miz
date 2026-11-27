/**
 * The database half of complimentary app grants (GitHub #1579 / ESH-226).
 *
 * It owns exactly two things:
 *
 *   1. the append-only signup policy catalogue (`signup_app_policies`), and
 *   2. the tenant-scoped grant rows (`business_complimentary_grants`).
 *
 * It never moves money, never activates a service and never writes an
 * activation state. The canonical activation service calls
 * `issueComplimentaryGrantTx` inside its own transaction, so "one activation →
 * one grant → one start instant" is a database fact rather than a convention,
 * and the resolver reads `readActiveComplimentaryGrant` for coverage.
 */
import {
  query,
  withTenant,
  withTenantTransaction,
  withoutTenantScope,
  withoutTenantScopeTransaction,
  type PoolClient,
} from "./db";
import { readBusinessIndustry } from "./business-industry";
import type { ServiceIdentity, ServiceKind } from "./service-activation/catalog";
import { isServiceKey, isServiceKind } from "./service-activation/catalog";
import {
  coverageEnd,
  grantExpiryFor,
  grantStatusAt,
  isComplimentaryMode,
  normalizeSignupPolicyInput,
  resolveSignupAppPolicy,
  type ComplimentaryGrant,
  type GrantSource,
  type NormalizedPolicyInput,
  type SignupAppPolicy,
  type SignupPolicyMode,
  type SignupPolicyScope,
  type SignupPolicyStatus,
} from "./complimentary-grants";

interface PolicyDbRow {
  [key: string]: unknown;
  id: string;
  service_kind: string;
  service_key: string;
  version: number;
  scope: string;
  business_type: string | null;
  business_id: string | null;
  mode: string;
  free_days: number | null;
  waive_setup: boolean;
  waive_rental: boolean;
  status: string;
  effective_from: Date | string;
  effective_until: Date | string | null;
  reason: string;
  created_at: Date | string;
}

interface GrantDbRow {
  [key: string]: unknown;
  id: string;
  business_id: string;
  service_kind: string;
  service_key: string;
  runtime_instance_id: string;
  policy_id: string | null;
  policy_version: number | null;
  source: string;
  scope: string;
  status: string;
  starts_at: Date | string;
  expires_at: Date | string | null;
  waive_setup: boolean;
  waive_rental: boolean;
  activation_id: string | null;
  revoked_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toSignupPolicy(row: PolicyDbRow): SignupAppPolicy {
  return {
    id: row.id,
    serviceKind: row.service_kind as ServiceKind,
    serviceKey: row.service_key,
    version: Number(row.version),
    scope: row.scope as SignupPolicyScope,
    businessType: row.business_type,
    businessId: row.business_id,
    mode: row.mode as SignupPolicyMode,
    freeDays: row.free_days == null ? null : Number(row.free_days),
    waiveSetup: row.waive_setup,
    waiveRental: row.waive_rental,
    status: row.status as SignupPolicyStatus,
    effectiveFrom: iso(row.effective_from)!,
    effectiveUntil: iso(row.effective_until),
    reason: row.reason,
    createdAt: iso(row.created_at) ?? undefined,
  };
}

export function toComplimentaryGrant(row: GrantDbRow): ComplimentaryGrant {
  return {
    id: row.id,
    businessId: row.business_id,
    serviceKind: row.service_kind as ServiceKind,
    serviceKey: row.service_key,
    runtimeInstanceId: row.runtime_instance_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    source: row.source as GrantSource,
    scope: row.scope as SignupPolicyScope,
    status: row.status as ComplimentaryGrant["status"],
    startsAt: iso(row.starts_at)!,
    expiresAt: iso(row.expires_at),
    waiveSetup: row.waive_setup,
    waiveRental: row.waive_rental,
    activationId: row.activation_id,
    revokedAt: iso(row.revoked_at),
  };
}

const POLICY_COLUMNS = `id, service_kind, service_key, version, scope, business_type,
       business_id, mode, free_days, waive_setup, waive_rental, status,
       effective_from, effective_until, reason, created_at`;

const GRANT_COLUMNS = `id, business_id, service_kind, service_key, runtime_instance_id,
       policy_id, policy_version, source, scope, status, starts_at, expires_at,
       waive_setup, waive_rental, activation_id, revoked_at`;

// ---------------------------------------------------------------------------
// Policy catalogue
// ---------------------------------------------------------------------------

/** Every policy revision, newest first — the console's history table. */
export async function listSignupAppPolicies(): Promise<SignupAppPolicy[]> {
  return withoutTenantScope("signup policies are a global commercial catalogue", async () => {
    const { rows } = await query<PolicyDbRow>(
      `SELECT ${POLICY_COLUMNS}
         FROM signup_app_policies
        ORDER BY service_kind, service_key, scope, version DESC`,
    );
    return rows.map(toSignupPolicy);
  });
}

/** The revisions in force for one service (one per scope target at most). */
export async function listSignupPoliciesForService(
  kind: ServiceKind,
  key: string,
): Promise<SignupAppPolicy[]> {
  const raw = await listSignupAppPolicies();
  return raw.filter(
    (policy) =>
      policy.serviceKind === kind && policy.serviceKey === key && policy.status === "active",
  );
}

export interface SaveSignupPolicyInput extends NormalizedPolicyInput {
  adminId?: string | null;
}

export class SignupPolicyWriteError extends Error {
  constructor(public code: "unknown_service" | "no_change") {
    super(code);
  }
}

/**
 * Append a policy revision. The previous open revision for the same target is
 * closed at the new revision's effective instant, so exactly one revision is
 * in force and an already-issued grant keeps the `policy_id`/version it was
 * made under. Existing grants are never rewritten here.
 */
export async function saveSignupAppPolicy(
  input: SaveSignupPolicyInput,
): Promise<SignupAppPolicy> {
  if (!isServiceKind(input.serviceKind) || !isServiceKey(input.serviceKind, input.serviceKey)) {
    throw new SignupPolicyWriteError("unknown_service");
  }
  const normalized = normalizeSignupPolicyInput(input);
  const effectiveFrom = normalized.effectiveFrom ?? new Date().toISOString();

  return withoutTenantScopeTransaction(
    "signup app policy is a platform-wide commercial decision",
    async () => {
      const target = [
        normalized.serviceKind,
        normalized.serviceKey,
        normalized.scope,
        normalized.businessType ?? "",
        normalized.businessId ?? "",
      ].join(":");
      // One writer per target: two simultaneous saves must not both claim the
      // next version or close each other's fresh revision.
      await query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
        `signup_app_policy:${target}`,
      ]);

      await query(
        `UPDATE signup_app_policies
            SET effective_until = $6::timestamptz,
                status = 'retired'
          WHERE service_kind = $1 AND service_key = $2 AND scope = $3
            AND COALESCE(business_type, '') = $4
            AND COALESCE(business_id::text, '') = $5
            AND status = 'active' AND effective_until IS NULL`,
        [
          normalized.serviceKind,
          normalized.serviceKey,
          normalized.scope,
          normalized.businessType ?? "",
          normalized.businessId ?? "",
          effectiveFrom,
        ],
      );

      const { rows: versionRows } = await query<{ next_version: string }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM signup_app_policies
          WHERE service_kind = $1 AND service_key = $2 AND scope = $3
            AND COALESCE(business_type, '') = $4
            AND COALESCE(business_id::text, '') = $5`,
        [
          normalized.serviceKind,
          normalized.serviceKey,
          normalized.scope,
          normalized.businessType ?? "",
          normalized.businessId ?? "",
        ],
      );
      const version = Number(versionRows[0]?.next_version ?? 1);

      const { rows } = await query<PolicyDbRow>(
        `INSERT INTO signup_app_policies
           (service_kind, service_key, version, scope, business_type, business_id,
            mode, free_days, waive_setup, waive_rental, status, effective_from,
            effective_until, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11::timestamptz,$12::timestamptz,$13,$14)
         RETURNING ${POLICY_COLUMNS}`,
        [
          normalized.serviceKind,
          normalized.serviceKey,
          version,
          normalized.scope,
          normalized.businessType,
          normalized.businessId,
          normalized.mode,
          normalized.freeDays,
          normalized.waiveSetup,
          normalized.waiveRental,
          effectiveFrom,
          normalized.effectiveUntil,
          normalized.reason,
          input.adminId ?? null,
        ],
      );
      return toSignupPolicy(rows[0]);
    },
  );
}

// ---------------------------------------------------------------------------
// Effective offer resolution
// ---------------------------------------------------------------------------

export interface EffectiveSignupOffer {
  /** Null when no policy applies — ordinary published commercial pricing. */
  policy: SignupAppPolicy | null;
  mode: SignupPolicyMode;
  freeDays: number | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  selectable: boolean;
  /** The scope that produced this decision, for the console's audit view. */
  scope: SignupPolicyScope | null;
  policyVersion: number | null;
}

const STANDARD_OFFER: EffectiveSignupOffer = {
  policy: null,
  mode: "standard",
  freeDays: null,
  waiveSetup: false,
  waiveRental: false,
  selectable: true,
  scope: null,
  policyVersion: null,
};

/** Resolve one service's effective offer for a tenant at an instant. */
export async function resolveSignupOfferForBusiness(input: {
  businessId: string;
  businessType: string | null;
  identity: Pick<ServiceIdentity, "kind" | "key">;
  at?: string;
}): Promise<EffectiveSignupOffer> {
  const at = input.at ?? new Date().toISOString();
  const policies = await listSignupPoliciesForService(input.identity.kind, input.identity.key);
  const chosen = resolveSignupAppPolicy(policies, {
    businessId: input.businessId,
    businessType: input.businessType,
    serviceKind: input.identity.kind,
    serviceKey: input.identity.key,
    at,
  });
  if (!chosen) return STANDARD_OFFER;
  return {
    policy: chosen,
    mode: chosen.mode,
    freeDays: chosen.freeDays,
    waiveSetup: chosen.waiveSetup,
    waiveRental: chosen.waiveRental,
    // `standard` and the two free modes are selectable; only `not_selectable`
    // removes the card from the signup offer. Technical eligibility is decided
    // separately and always wins.
    selectable: chosen.mode !== "not_selectable",
    scope: chosen.scope,
    policyVersion: chosen.version,
  };
}

/** Resolve every app's offer for one tenant — the signup catalog's input. */
export async function resolveSignupOffersForBusiness(
  businessId: string,
  appKeys: readonly string[],
  at?: string,
): Promise<Map<string, EffectiveSignupOffer>> {
  const atIso = at ?? new Date().toISOString();
  const businessType = (await readBusinessIndustry(businessId)) ?? null;
  const entries = await Promise.all(
    appKeys.map(
      async (key) =>
        [
          key,
          await resolveSignupOfferForBusiness({
            businessId,
            businessType,
            identity: { kind: "app", key },
            at: atIso,
          }),
        ] as const,
    ),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** The grant covering this identity at `at`, or null. Reads the tenant only. */
export async function readActiveComplimentaryGrant(input: {
  businessId: string;
  identity: ServiceIdentity;
  at?: string;
  client?: PoolClient;
}): Promise<ComplimentaryGrant | null> {
  const at = input.at ?? new Date().toISOString();
  const sql = `SELECT ${GRANT_COLUMNS}
                 FROM business_complimentary_grants
                WHERE business_id = $1
                  AND service_kind = $2 AND service_key = $3
                  AND runtime_instance_id = $4
                  AND status = 'active'
                  AND starts_at <= $5::timestamptz
                  AND (expires_at IS NULL OR expires_at > $5::timestamptz)
                ORDER BY starts_at DESC
                LIMIT 1`;
  const params = [
    input.businessId,
    input.identity.kind,
    input.identity.key,
    input.identity.runtimeInstanceId ?? "",
    at,
  ];
  const run = async () => {
    const { rows } = input.client
      ? await input.client.query<GrantDbRow>(sql, params)
      : await query<GrantDbRow>(sql, params);
    return rows[0] ? toComplimentaryGrant(rows[0]) : null;
  };
  // Inside a caller's transaction the row is already RLS-scoped; a standalone
  // read opens the tenant scope explicitly.
  return input.client ? run() : withTenant(input.businessId, run);
}

export interface IssueGrantInput {
  businessId: string;
  identity: Required<ServiceIdentity>;
  policy: SignupAppPolicy;
  activationId: string;
  startsAt: string;
  actor?: string | null;
  reason?: string | null;
}

/**
 * Issue the grant for a successful complimentary activation, inside the
 * activation transaction.
 *
 * `ON CONFLICT (activation_id)` is the idempotency key: a retried activation
 * returns the existing row instead of opening a new free period, and the
 * partial unique index on an active (tenant, identity) refuses a second
 * overlapping grant rather than silently double-waiving.
 */
export async function issueComplimentaryGrantTx(
  client: PoolClient,
  input: IssueGrantInput,
): Promise<ComplimentaryGrant> {
  const expiresAt = grantExpiryFor(input.policy, input.startsAt);
  const { rows } = await client.query<GrantDbRow>(
    `INSERT INTO business_complimentary_grants
       (business_id, service_kind, service_key, runtime_instance_id, policy_id,
        policy_version, source, scope, status, starts_at, expires_at,
        waive_setup, waive_rental, activation_id, actor, reason)
     VALUES ($1,$2,$3,$4,$5,$6,'signup_policy',$7,'active',$8::timestamptz,$9::timestamptz,
             $10,$11,$12,$13,$14)
     ON CONFLICT (activation_id) DO UPDATE
       SET updated_at = now()
     RETURNING ${GRANT_COLUMNS}`,
    [
      input.businessId,
      input.identity.kind,
      input.identity.key,
      input.identity.runtimeInstanceId,
      input.policy.id,
      input.policy.version,
      input.policy.scope,
      input.startsAt,
      expiresAt,
      input.policy.waiveSetup,
      input.policy.waiveRental,
      input.activationId,
      input.actor ?? null,
      input.reason ?? input.policy.reason,
    ],
  );
  return toComplimentaryGrant(rows[0]);
}

/** Every grant for a business (the billing page's grant history). */
export async function listBusinessComplimentaryGrants(
  businessId: string,
): Promise<ComplimentaryGrant[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<GrantDbRow>(
      `SELECT ${GRANT_COLUMNS}
         FROM business_complimentary_grants
        WHERE business_id = $1
        ORDER BY starts_at DESC`,
      [businessId],
    );
    return rows.map(toComplimentaryGrant);
  });
}

export class GrantMutationError extends Error {
  constructor(
    public code:
      | "not_found"
      | "not_active"
      | "already_revoked"
      | "invalid_expiry"
      | "expiry_in_past",
  ) {
    super(code);
  }
}

function grantStatusOf(row: GrantDbRow, atIso: string): ComplimentaryGrant["status"] {
  return grantStatusAt(toComplimentaryGrant(row), atIso);
}

/**
 * Extend (or convert an indefinite grant into a bounded one) an active grant.
 * Audited and concurrency-safe: the row is locked and must still be active at
 * the new expiry, so two simultaneous extensions cannot produce an overlap.
 */
export async function extendComplimentaryGrant(input: {
  businessId: string;
  grantId: string;
  expiresAt: string | null;
  actor: string;
  reason: string;
  now?: Date;
}): Promise<ComplimentaryGrant> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new GrantMutationError("invalid_expiry");
  }
  return withTenantTransaction(input.businessId, async (client) => {
    const { rows } = await client.query<GrantDbRow>(
      `SELECT ${GRANT_COLUMNS} FROM business_complimentary_grants
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.grantId, input.businessId],
    );
    const row = rows[0];
    if (!row) throw new GrantMutationError("not_found");
    if (row.status === "revoked") throw new GrantMutationError("already_revoked");
    if (grantStatusOf(row, nowIso) !== "active") throw new GrantMutationError("not_active");
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(nowIso)) {
      throw new GrantMutationError("expiry_in_past");
    }
    const updated = await client.query<GrantDbRow>(
      `UPDATE business_complimentary_grants
          SET expires_at = $2::timestamptz,
              extended_at = $3::timestamptz,
              extended_by = $4,
              reason = CASE WHEN $5 = '' THEN reason ELSE $5 END,
              updated_at = now()
        WHERE id = $1
        RETURNING ${GRANT_COLUMNS}`,
      [input.grantId, expiresAt, nowIso, input.actor, input.reason.trim()],
    );
    return toComplimentaryGrant(updated.rows[0]);
  });
}

/** Revoke a grant. Coverage stops at the revocation instant, not retroactively. */
export async function revokeComplimentaryGrant(input: {
  businessId: string;
  grantId: string;
  actor: string;
  reason: string;
  now?: Date;
}): Promise<ComplimentaryGrant> {
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    const { rows } = await client.query<GrantDbRow>(
      `SELECT ${GRANT_COLUMNS} FROM business_complimentary_grants
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.grantId, input.businessId],
    );
    const row = rows[0];
    if (!row) throw new GrantMutationError("not_found");
    if (row.status === "revoked") throw new GrantMutationError("already_revoked");
    const updated = await client.query<GrantDbRow>(
      `UPDATE business_complimentary_grants
          SET status = 'revoked',
              revoked_at = $2::timestamptz,
              revoked_by = $3,
              revoke_reason = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING ${GRANT_COLUMNS}`,
      [input.grantId, nowIso, input.actor, input.reason.trim()],
    );
    return toComplimentaryGrant(updated.rows[0]);
  });
}

export interface ExpiredGrant {
  grantId: string;
  businessId: string;
  serviceKind: ServiceKind;
  serviceKey: string;
  runtimeInstanceId: string;
  expiresAt: string;
  activationId: string | null;
}

/**
 * Mark grants whose exact expiry instant has passed as `expired`, once each.
 *
 * This is a status sweep, not a billing action: it never starts paid rental,
 * never debits a wallet, never subscribes the business and never deletes data.
 * The caller (the runtime tick) decides whether commercial access must be
 * suspended through the existing suspension path, which distinguishes a grant
 * expiry from a customer disable and therefore never starts a purge.
 */
export async function expireDueComplimentaryGrants(
  now: Date = new Date(),
): Promise<ExpiredGrant[]> {
  const nowIso = now.toISOString();
  return withoutTenantScopeTransaction(
    "expiry sweep across tenants; returns only the identities to re-evaluate",
    async () => {
      const { rows } = await query<{
        id: string;
        business_id: string;
        service_kind: string;
        service_key: string;
        runtime_instance_id: string;
        expires_at: Date | string;
        activation_id: string | null;
      }>(
        `UPDATE business_complimentary_grants
            SET status = 'expired', updated_at = now()
          WHERE status = 'active'
            AND expires_at IS NOT NULL
            AND expires_at <= $1::timestamptz
          RETURNING id, business_id, service_kind, service_key, runtime_instance_id,
                    expires_at, activation_id`,
        [nowIso],
      );
      return rows.map((row) => ({
        grantId: row.id,
        businessId: row.business_id,
        serviceKind: row.service_kind as ServiceKind,
        serviceKey: row.service_key,
        runtimeInstanceId: row.runtime_instance_id,
        expiresAt: iso(row.expires_at)!,
        activationId: row.activation_id,
      }));
    },
  );
}

/** A grant's last instant of coverage, or null when indefinite. */
export function grantCoverageEnd(grant: ComplimentaryGrant): string | null {
  return coverageEnd(grant);
}

/** Whether a grant is currently complimentary for runtime billing. */
export function grantWaivesRentalNow(grant: ComplimentaryGrant, atIso: string): boolean {
  return grant.waiveRental && grantStatusAt(grant, atIso) === "active";
}

export { isComplimentaryMode };
