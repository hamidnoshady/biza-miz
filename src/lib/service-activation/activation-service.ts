/**
 * The service activation lifecycle and the enabled-time settlement engine
 * (issue #1041 §B and §C).
 *
 * One stable identity — an app key, a My Workspace business capability, or a
 * published agent/routine plus its runtime instance — has exactly one
 * activation row per business. That row owns:
 *
 *   - the once-per-identity setup debit (`service_setup_charges`),
 *   - the canonical enabled-time intervals (`service_activation_intervals`),
 *   - the settled hourly segments (`service_runtime_charges`),
 *   - the retention deadline and the queued destruction (`retention-service.ts`).
 *
 * The money always moves through the ONE canonical wallet
 * (`wallet-service.postWalletEntryTx`), inside the same transaction that writes
 * the interval cursor and the usage event. That single transaction is what
 * makes "never bill the same second twice" true across worker restarts,
 * duplicate POSTs and concurrent requests:
 *
 *   * the activation identity is serialised with an advisory lock,
 *   * the interval row is locked `FOR UPDATE` and its cursor only moves forward,
 *   * a segment's `(interval_id, period_start)` is unique, and
 *   * its usage event id is deterministic (`service_runtime:<interval>:<start>`).
 *
 * Suspension is NOT a customer disable: it closes the billable interval, leaves
 * `disabled_at`/`retention_deadline` untouched and therefore never starts a
 * deletion countdown.
 */
import {
  query,
  withoutTenantScope,
  withTenant,
  withTenantTransaction,
  type PoolClient,
} from "../db";
import { appendUsageEvent } from "../billing/runtime";
import {
  postWalletEntryTx,
  WalletInsufficientFundsError,
} from "../wallet-service";
import { isAppAvailable } from "../app-availability-service";
import type { AppKey } from "../apps";
import {
  APP_SERVICE_DEFINITIONS,
  MINIMUM_BILLING_UNIT_SECONDS,
  SERVICE_STATE_META,
  SUSPENSION_STATE,
  WORKSPACE_SERVICE_DEFINITIONS,
  billableSecondsBetween,
  enabledRialForSeconds,
  firstHourRial,
  isServiceKey,
  quoteServiceActivation,
  serviceIdentityKey,
  serviceLabel,
  type ActivationQuote,
  type ServiceDefinition,
  type ServiceIdentity,
  type ServiceKind,
  type RetentionPolicy,
  type ServiceState,
  type SuspensionReason,
} from "./catalog";
import { serviceTariffAt, type ServicePriceRow } from "./pricing-service";
import { effectiveRetentionPolicy } from "./retention-service";

// ---------------------------------------------------------------------------
// Rows and types
// ---------------------------------------------------------------------------

export type PurgeState =
  | "none"
  | "scheduled"
  | "cancelled"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "blocked";

export interface ServiceActivationRow {
  id: string;
  businessId: string;
  kind: ServiceKind;
  key: string;
  runtimeInstanceId: string;
  label: string;
  state: ServiceState;
  setupPaid: boolean;
  setupPaidAt: string | null;
  setupAmountRial: number | null;
  setupPriceVersion: number | null;
  setupQuote: Record<string, unknown>;
  provisionedAt: string | null;
  activatedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  retentionDeadline: string | null;
  purgeState: PurgeState;
  dataPurgedAt: string | null;
  activationRequestId: string | null;
  lastSettledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActivationDbRow {
  [key: string]: unknown;
  id: string;
  business_id: string;
  service_kind: string;
  service_key: string;
  runtime_instance_id: string;
  label: string;
  state: string;
  setup_paid: boolean;
  setup_paid_at: Date | string | null;
  setup_amount_rial: string | number | null;
  setup_price_version: number | null;
  setup_quote: Record<string, unknown>;
  provisioned_at: Date | string | null;
  activated_at: Date | string | null;
  disabled_at: Date | string | null;
  disabled_reason: string | null;
  suspended_at: Date | string | null;
  suspension_reason: string | null;
  retention_deadline: Date | string | null;
  purge_state: string;
  data_purged_at: Date | string | null;
  activation_request_id: string | null;
  last_settled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ACTIVATION_COLUMNS = `id, business_id, service_kind, service_key, runtime_instance_id,
        label, state, setup_paid, setup_paid_at, setup_amount_rial,
        setup_price_version, setup_quote, provisioned_at, activated_at,
        disabled_at, disabled_reason, suspended_at, suspension_reason,
        retention_deadline, purge_state, data_purged_at, activation_request_id,
        last_settled_at, created_at, updated_at`;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toActivation(row: ActivationDbRow): ServiceActivationRow {
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.service_kind as ServiceKind,
    key: row.service_key,
    runtimeInstanceId: row.runtime_instance_id,
    label: row.label,
    state: row.state as ServiceState,
    setupPaid: row.setup_paid,
    setupPaidAt: iso(row.setup_paid_at),
    setupAmountRial: row.setup_amount_rial == null ? null : Number(row.setup_amount_rial),
    setupPriceVersion: row.setup_price_version,
    setupQuote: row.setup_quote ?? {},
    provisionedAt: iso(row.provisioned_at),
    activatedAt: iso(row.activated_at),
    disabledAt: iso(row.disabled_at),
    disabledReason: row.disabled_reason,
    suspendedAt: iso(row.suspended_at),
    suspensionReason: row.suspension_reason,
    retentionDeadline: iso(row.retention_deadline),
    purgeState: row.purge_state as PurgeState,
    dataPurgedAt: iso(row.data_purged_at),
    activationRequestId: row.activation_request_id,
    lastSettledAt: iso(row.last_settled_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export class ServiceActivationError extends Error {
  constructor(
    public code:
      | "unknown_service"
      | "not_found"
      | "invalid_identity"
      | "invalid_amount"
      | "not_purgeable",
  ) {
    super(code);
  }
}

function identityOf(identity: ServiceIdentity): Required<ServiceIdentity> {
  const key = identity.key?.trim() ?? "";
  if (!isServiceKey(identity.kind, key)) throw new ServiceActivationError("unknown_service");
  return { kind: identity.kind, key, runtimeInstanceId: identity.runtimeInstanceId?.trim() || "" };
}

function labelFor(identity: Required<ServiceIdentity>): string {
  return serviceLabel(identity.kind, identity.key);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getServiceActivation(
  businessId: string,
  identity: ServiceIdentity,
): Promise<ServiceActivationRow | null> {
  const id = identityOf(identity);
  return withTenant(businessId, async () => {
    const { rows } = await query<ActivationDbRow>(
      `SELECT ${ACTIVATION_COLUMNS}
         FROM business_service_activations
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
          AND runtime_instance_id = $4`,
      [businessId, id.kind, id.key, id.runtimeInstanceId],
    );
    return rows[0] ? toActivation(rows[0]) : null;
  });
}

export async function listBusinessServiceActivations(
  businessId: string,
): Promise<ServiceActivationRow[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<ActivationDbRow>(
      `SELECT ${ACTIVATION_COLUMNS}
         FROM business_service_activations
        WHERE business_id = $1
        ORDER BY service_kind, service_key, runtime_instance_id`,
      [businessId],
    );
    return rows.map(toActivation);
  });
}

/** The tenant's «سرویس‌ها» list: every sellable service plus its live state. */
export interface TenantServiceSummary {
  identity: ServiceIdentity;
  definition: ServiceDefinition | null;
  activation: ServiceActivationRow | null;
  /** 'draft' = never activated (no row yet). */
  state: ServiceState | "draft";
  stateLabel: string;
  enabled: boolean;
  setupPaid: boolean;
  retentionDeadline: string | null;
  purgeState: PurgeState;
  wizardStep: string | null;
  lastSettledAt: string | null;
}

export async function listBusinessServices(businessId: string): Promise<TenantServiceSummary[]> {
  const activations = await listBusinessServiceActivations(businessId);
  const wizard = await listWizardStates(businessId);
  const byIdentity = new Map(
    activations.map((row) => [serviceIdentityKey(row), row] as const),
  );
  const wizardByIdentity = new Map(
    wizard.map((row) => [serviceIdentityKey(row.identity), row] as const),
  );

  const definitions: ServiceDefinition[] = [
    ...APP_SERVICE_DEFINITIONS,
    ...WORKSPACE_SERVICE_DEFINITIONS,
  ];
  // Agent/routine activations are dynamic: they appear only once the business
  // has one (the Superadmin publishes the agent and its tariff).
  for (const row of activations) {
    if (row.kind !== "agent") continue;
    definitions.push({
      kind: "agent",
      key: row.key,
      label: row.label || row.key,
      description: "عامل/روتین پس‌زمینهٔ منتشرشده توسط مدیر سامانه.",
    });
  }

  return definitions.map((definition) => {
    const identity: ServiceIdentity = {
      kind: definition.kind,
      key: definition.key,
      runtimeInstanceId: byIdentity.get(serviceIdentityKey(definition))?.runtimeInstanceId,
    };
    const identityKey = serviceIdentityKey(identity);
    const activation = byIdentity.get(identityKey) ?? null;
    const state = activation?.state ?? "draft";
    return {
      identity,
      definition,
      activation,
      state,
      stateLabel:
        state === "draft" ? "راه‌اندازی نشده" : SERVICE_STATE_META[state].label,
      enabled: state !== "draft" && SERVICE_STATE_META[state].enabled,
      setupPaid: activation?.setupPaid ?? false,
      retentionDeadline: activation?.retentionDeadline ?? null,
      purgeState: activation?.purgeState ?? "none",
      wizardStep: wizardByIdentity.get(identityKey)?.step ?? null,
      lastSettledAt: activation?.lastSettledAt ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Resumable, per-service setup wizard state
// ---------------------------------------------------------------------------

export interface ServiceWizardState {
  identity: ServiceIdentity;
  step: string;
  progress: Record<string, unknown>;
  version: number;
  completedAt: string | null;
  updatedAt: string;
}

interface WizardDbRow {
  [key: string]: unknown;
  service_kind: string;
  service_key: string;
  runtime_instance_id: string;
  step: string;
  progress: Record<string, unknown>;
  version: number;
  completed_at: Date | string | null;
  updated_at: Date | string;
}

function toWizard(row: WizardDbRow): ServiceWizardState {
  return {
    identity: {
      kind: row.service_kind as ServiceKind,
      key: row.service_key,
      runtimeInstanceId: row.runtime_instance_id,
    },
    step: row.step,
    progress: row.progress ?? {},
    version: row.version,
    completedAt: iso(row.completed_at),
    updatedAt: iso(row.updated_at)!,
  };
}

async function listWizardStates(businessId: string): Promise<ServiceWizardState[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<WizardDbRow>(
      `SELECT service_kind, service_key, runtime_instance_id, step, progress,
              version, completed_at, updated_at
         FROM business_service_wizard_state
        WHERE business_id = $1`,
      [businessId],
    );
    return rows.map(toWizard);
  });
}

export async function getServiceWizardState(
  businessId: string,
  identity: ServiceIdentity,
): Promise<ServiceWizardState | null> {
  const id = identityOf(identity);
  return withTenant(businessId, async () => {
    const { rows } = await query<WizardDbRow>(
      `SELECT service_kind, service_key, runtime_instance_id, step, progress,
              version, completed_at, updated_at
         FROM business_service_wizard_state
        WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
          AND runtime_instance_id = $4`,
      [businessId, id.kind, id.key, id.runtimeInstanceId],
    );
    return rows[0] ? toWizard(rows[0]) : null;
  });
}

/**
 * Save the app's own setup progress. This is deliberately NOT
 * `businesses.setup_progress/completedAt`: the platform's first-run onboarding
 * (PR #838) must never reopen because an app's wizard was resumed.
 */
export async function saveServiceWizardState(input: {
  businessId: string;
  identity: ServiceIdentity;
  step: string;
  progress: Record<string, unknown>;
  completed?: boolean;
  actorUserId?: string | null;
}): Promise<ServiceWizardState> {
  const id = identityOf(input.identity);
  return withTenantTransaction(input.businessId, async (client) => {
    const { rows } = await client.query<WizardDbRow>(
      `INSERT INTO business_service_wizard_state
         (business_id, service_kind, service_key, runtime_instance_id, step,
          progress, version, completed_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1,
               CASE WHEN $7 THEN now() ELSE NULL END, $8, now())
       ON CONFLICT (business_id, service_kind, service_key, runtime_instance_id)
       DO UPDATE SET step = EXCLUDED.step,
                     progress = EXCLUDED.progress,
                     version = business_service_wizard_state.version + 1,
                     completed_at = COALESCE(EXCLUDED.completed_at, business_service_wizard_state.completed_at),
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()
       RETURNING service_kind, service_key, runtime_instance_id, step, progress,
                 version, completed_at, updated_at`,
      [
        input.businessId,
        id.kind,
        id.key,
        id.runtimeInstanceId,
        input.step,
        JSON.stringify(input.progress ?? {}),
        input.completed === true,
        input.actorUserId ?? null,
      ],
    );
    return toWizard(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

async function lockIdentity(
  client: PoolClient,
  businessId: string,
  identity: Required<ServiceIdentity>,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
    `service_activation:${businessId}:${serviceIdentityKey(identity)}`,
  ]);
}

async function lockActivationRow(
  client: PoolClient,
  businessId: string,
  identity: Required<ServiceIdentity>,
): Promise<ServiceActivationRow | null> {
  const { rows } = await client.query<ActivationDbRow>(
    `SELECT ${ACTIVATION_COLUMNS}
       FROM business_service_activations
      WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
        AND runtime_instance_id = $4
      FOR UPDATE`,
    [businessId, identity.kind, identity.key, identity.runtimeInstanceId],
  );
  return rows[0] ? toActivation(rows[0]) : null;
}

async function lockWallet(client: PoolClient, businessId: string): Promise<number> {
  await client.query(
    `INSERT INTO business_wallets (business_id) VALUES ($1)
     ON CONFLICT (business_id) DO NOTHING`,
    [businessId],
  );
  const { rows } = await client.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1 FOR UPDATE`,
    [businessId],
  );
  return Number(rows[0]?.balance_rial ?? 0);
}

async function openInterval(
  client: PoolClient,
  input: {
    businessId: string;
    activationId: string;
    atIso: string;
    tariff: ServicePriceRow;
    trigger: "activation" | "reenable";
  },
): Promise<void> {
  await client.query(
    `INSERT INTO service_activation_intervals
       (business_id, activation_id, started_at, last_settled_at,
        hourly_rate_rial, hourly_price_version, minimum_unit_seconds, trigger)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz, $4, $5, $6, $7)`,
    [
      input.businessId,
      input.activationId,
      input.atIso,
      input.tariff.hourlyRateRial,
      input.tariff.version,
      MINIMUM_BILLING_UNIT_SECONDS,
      input.trigger,
    ],
  );
}

async function logEvent(
  client: PoolClient,
  input: {
    businessId: string;
    activationId: string;
    kind: ServiceKind;
    key: string;
    action: string;
    actorUserId?: string | null;
    platformAdminId?: string | null;
    amountRial?: number | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO service_activation_events
       (business_id, activation_id, service_kind, service_key, action,
        actor_user_id, platform_admin_id, amount_rial, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      input.businessId,
      input.activationId,
      input.kind,
      input.key,
      input.action,
      input.actorUserId ?? null,
      input.platformAdminId ?? null,
      input.amountRial ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/** Append the setup usage event; returns the usage event id when recorded. */
async function recordSetupUsage(
  client: PoolClient,
  input: {
    businessId: string;
    activationId: string;
    atIso: string;
    amountRial: number;
    identity: Required<ServiceIdentity>;
  },
): Promise<string | null> {
  const result = await appendUsageEvent(
    {
      eventId: `service_setup:${input.activationId}`,
      businessId: input.businessId,
      meterKey: "service.setup",
      source: "service_setup",
      quantity: 1,
      unit: "activation",
      occurredAt: input.atIso,
      resource: "service_activation",
      resourceId: input.activationId,
      dimensions: {
        service_kind: input.identity.kind,
        service_key: input.identity.key,
        runtime_instance_id: input.identity.runtimeInstanceId,
      },
      ratedAmountRial: input.amountRial,
      sourceReference: input.activationId,
    },
    client,
  );
  return result.status === "rejected" ? null : result.id;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export type ActivateServiceResult =
  | {
      status: "activated";
      activation: ServiceActivationRow;
      quote: ActivationQuote;
      chargedSetupRial: number;
    }
  | { status: "already_active"; activation: ServiceActivationRow }
  | { status: "reenabled"; activation: ServiceActivationRow; chargedSetupRial: 0 }
  | { status: "not_configured" }
  | { status: "not_found" }
  | { status: "insufficient_credit"; requiredRial: number; balanceRial: number }
  | { status: "unavailable"; reason: string }
  | { status: "conflict"; reason: "legal_hold" | "purge_in_progress" };

export interface ActivateServiceInput {
  businessId: string;
  identity: ServiceIdentity;
  /** The client's idempotency key for this attempt, kept for audit. */
  requestId?: string | null;
  actorUserId?: string | null;
  now?: Date;
}

/**
 * First activation of a service.
 *
 * Preconditions: permission (the caller checks `billing.manage`), the app's
 * platform availability, a *published* tariff (fail closed), and wallet cover
 * for the setup fee plus the first enabled hour. The debit, the interval, the
 * setup evidence and the usage event commit together — a failed or cancelled
 * attempt leaves the wallet untouched and no half-provisioned activation
 * behind.
 */
export async function activateService(input: ActivateServiceInput): Promise<ActivateServiceResult> {
  const identity = identityOf(input.identity);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const businessId = input.businessId;

  // Platform availability is a precondition, never a commercial switch: an app
  // that is «به‌زودی»/«در حال تعمیر» cannot be activated, and the refusal is
  // distinct from the tenant's own disable state (issue #1041 §B).
  if (identity.kind === "app") {
    const available = await isAppAvailable(businessId, identity.key as AppKey);
    if (!available) return { status: "unavailable", reason: "app_unavailable" };
  }

  return withTenantTransaction(businessId, async (client) => {
    await lockIdentity(client, businessId, identity);
    const existing = await lockActivationRow(client, businessId, identity);

    if (existing) {
      if (existing.state === "active") {
        return { status: "already_active", activation: existing };
      }
      if (existing.state === "purging") {
        return { status: "conflict", reason: "purge_in_progress" };
      }
      if (existing.state === "legal_hold") {
        return { status: "conflict", reason: "legal_hold" };
      }
      // Re-enable after disable/suspension/purge: NO second setup fee. The
      // commercial evidence may already exist, so this path never debits setup.
      return reenableInTx(client, {
        businessId,
        existing,
        nowIso,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
      });
    }

    const tariff = await serviceTariffAt(identity, nowIso, client);
    if (!tariff) return { status: "not_configured" };

    const balance = await lockWallet(client, businessId);
    const quote = quoteServiceActivation({ identity, tariff, walletBalanceRial: balance, nowIso });
    if (!quote.eligible) {
      return {
        status: "insufficient_credit",
        requiredRial: quote.reserveRial,
        balanceRial: balance,
      };
    }

    const { rows } = await client.query<ActivationDbRow>(
      `INSERT INTO business_service_activations
         (business_id, service_kind, service_key, runtime_instance_id, label,
          state, setup_quote, provisioned_at, activated_at, last_settled_at,
          activation_request_id)
       VALUES ($1,$2,$3,$4,$5,'setup_in_progress',$6::jsonb,$7::timestamptz,$7::timestamptz,$7::timestamptz,$8)
       RETURNING ${ACTIVATION_COLUMNS}`,
      [
        businessId,
        identity.kind,
        identity.key,
        identity.runtimeInstanceId,
        labelFor(identity),
        JSON.stringify({
          setupRial: quote.setupRial,
          hourlyRial: quote.hourlyRial,
          firstHourRial: quote.firstHourRial,
          reserveRial: quote.reserveRial,
          priceVersion: tariff.version,
          quotedAt: nowIso,
        }),
        nowIso,
        input.requestId ?? null,
      ],
    );
    const activationId = rows[0].id;

    // Setup: charged exactly once, proof written beside the debit.
    let ledgerId: string | null = null;
    if (quote.setupRial > 0) {
      const entry = await postWalletEntryTx(client, {
        businessId,
        kind: "service_setup",
        direction: "debit",
        amountRial: quote.setupRial,
        note: `هزینهٔ راه‌اندازی «${labelFor(identity)}»`,
        userId: input.actorUserId ?? null,
        metadata: {
          activationId,
          serviceKind: identity.kind,
          serviceKey: identity.key,
          runtimeInstanceId: identity.runtimeInstanceId,
          priceVersion: tariff.version,
        },
      });
      ledgerId = entry.id;
    }
    const usageEventId = await recordSetupUsage(client, {
      businessId,
      activationId,
      atIso: nowIso,
      amountRial: quote.setupRial,
      identity,
    });
    await client.query(
      `INSERT INTO service_setup_charges
         (business_id, activation_id, service_kind, service_key, amount_rial,
          setup_mode, setup_equivalent_hours, hourly_rate_rial, price_version,
          quote, wallet_ledger_id, usage_event_id, charged_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::timestamptz)
       ON CONFLICT (activation_id) DO NOTHING`,
      [
        businessId,
        activationId,
        identity.kind,
        identity.key,
        quote.setupRial,
        tariff.setupMode,
        tariff.setupEquivalentHours,
        tariff.hourlyRateRial,
        tariff.version,
        JSON.stringify({
          setupRial: quote.setupRial,
          hourlyRial: quote.hourlyRial,
          firstHourRial: quote.firstHourRial,
          reserveRial: quote.reserveRial,
          quotedAt: nowIso,
        }),
        ledgerId,
        usageEventId,
        nowIso,
      ],
    );

    const { rows: activated } = await client.query<ActivationDbRow>(
      `UPDATE business_service_activations
          SET state = 'active',
              setup_paid = true,
              setup_paid_at = $2::timestamptz,
              setup_amount_rial = $3,
              setup_price_version = $4,
              activated_at = $2::timestamptz,
              provisioned_at = $2::timestamptz,
              last_settled_at = $2::timestamptz,
              disabled_at = NULL,
              disabled_reason = NULL,
              suspended_at = NULL,
              suspension_reason = NULL,
              retention_deadline = NULL,
              purge_state = 'none',
              updated_at = now()
        WHERE id = $1
        RETURNING ${ACTIVATION_COLUMNS}`,
      [activationId, nowIso, quote.setupRial, tariff.version],
    );

    await openInterval(client, {
      businessId,
      activationId,
      atIso: nowIso,
      tariff,
      trigger: "activation",
    });
    await logEvent(client, {
      businessId,
      activationId,
      kind: identity.kind,
      key: identity.key,
      action: "activated",
      actorUserId: input.actorUserId ?? null,
      amountRial: quote.setupRial,
      detail: { priceVersion: tariff.version, quote, requestId: input.requestId ?? null },
    });
    if (quote.setupRial > 0) {
      await logEvent(client, {
        businessId,
        activationId,
        kind: identity.kind,
        key: identity.key,
        action: "setup_charged",
        actorUserId: input.actorUserId ?? null,
        amountRial: quote.setupRial,
        detail: { walletLedgerId: ledgerId, priceVersion: tariff.version },
      });
    }

    return {
      status: "activated",
      activation: toActivation(activated[0]),
      quote,
      chargedSetupRial: quote.setupRial,
    };
  });
}

// ---------------------------------------------------------------------------
// Re-enable (no second setup fee)
// ---------------------------------------------------------------------------

export type ReenableServiceResult =
  | { status: "reenabled"; activation: ServiceActivationRow; chargedSetupRial: 0 }
  | { status: "already_active"; activation: ServiceActivationRow }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "insufficient_credit"; requiredRial: number; balanceRial: number }
  | { status: "conflict"; reason: "legal_hold" | "purge_in_progress" };

async function reenableInTx(
  client: PoolClient,
  input: {
    businessId: string;
    existing: ServiceActivationRow;
    nowIso: string;
    actorUserId: string | null;
    requestId: string | null;
  },
): Promise<ReenableServiceResult> {
  const { businessId, existing, nowIso } = input;
  const identity: Required<ServiceIdentity> = {
    kind: existing.kind,
    key: existing.key,
    runtimeInstanceId: existing.runtimeInstanceId,
  };

  // Locking order is always activation → purge queue, so re-enable and a
  // concurrent purge can never deadlock or both win.
  const { rows: queueRows } = await client.query<{ id: string; state: string }>(
    `SELECT id, state FROM service_purge_queue WHERE activation_id = $1 FOR UPDATE`,
    [existing.id],
  );
  const queue = queueRows[0] ?? null;

  const tariff = await serviceTariffAt(identity, nowIso, client);
  if (!tariff) return { status: "not_configured" };

  const balance = await lockWallet(client, businessId);
  const required = firstHourRial(tariff);
  if (balance < required) {
    return { status: "insufficient_credit", requiredRial: required, balanceRial: balance };
  }

  if (queue && queue.state !== "cancelled" && queue.state !== "completed") {
    await client.query(
      `UPDATE service_purge_queue
          SET state = 'cancelled', updated_at = now()
        WHERE id = $1`,
      [queue.id],
    );
    await logEvent(client, {
      businessId,
      activationId: existing.id,
      kind: existing.kind,
      key: existing.key,
      action: "purge_cancelled",
      actorUserId: input.actorUserId,
      detail: { queueId: queue.id, cancelledBy: "reenable" },
    });
  }

  const { rows } = await client.query<ActivationDbRow>(
    `UPDATE business_service_activations
        SET state = 'active',
            activated_at = $2::timestamptz,
            disabled_at = NULL,
            disabled_reason = NULL,
            suspended_at = NULL,
            suspension_reason = NULL,
            retention_deadline = NULL,
            purge_state = CASE WHEN purge_state = 'completed' THEN purge_state ELSE 'cancelled' END,
            last_settled_at = $2::timestamptz,
            activation_request_id = COALESCE($3, activation_request_id),
            updated_at = now()
      WHERE id = $1
      RETURNING ${ACTIVATION_COLUMNS}`,
    [existing.id, nowIso, input.requestId],
  );

  await openInterval(client, {
    businessId,
    activationId: existing.id,
    atIso: nowIso,
    tariff,
    trigger: "reenable",
  });
  await logEvent(client, {
    businessId,
    activationId: existing.id,
    kind: existing.kind,
    key: existing.key,
    action: "reenabled",
    actorUserId: input.actorUserId,
    detail: {
      chargedSetupRial: 0,
      priceVersion: tariff.version,
      previousState: existing.state,
    },
  });

  return { status: "reenabled", activation: toActivation(rows[0]), chargedSetupRial: 0 };
}

export async function reenableService(input: {
  businessId: string;
  identity: ServiceIdentity;
  requestId?: string | null;
  actorUserId?: string | null;
  now?: Date;
}): Promise<ReenableServiceResult> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    await lockIdentity(client, input.businessId, identity);
    const existing = await lockActivationRow(client, input.businessId, identity);
    if (!existing) return { status: "not_found" };
    if (existing.state === "active") return { status: "already_active", activation: existing };
    if (existing.state === "purging") return { status: "conflict", reason: "purge_in_progress" };
    if (existing.state === "legal_hold") return { status: "conflict", reason: "legal_hold" };
    return reenableInTx(client, {
      businessId: input.businessId,
      existing,
      nowIso,
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
    });
  });
}

// ---------------------------------------------------------------------------
// Interval settlement
// ---------------------------------------------------------------------------

export interface SettlementResult {
  status:
    | "settled"
    | "duplicate"
    | "not_due"
    | "no_open_interval"
    | "already_closed"
    | "insufficient_credit";
  billedSeconds?: number;
  amountRial?: number;
  periodStart?: string;
  periodEnd?: string;
}

interface IntervalRow {
  [key: string]: unknown;
  id: string;
  business_id: string;
  activation_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  last_settled_at: Date | string | null;
  hourly_rate_rial: string | number;
  hourly_price_version: number;
  minimum_unit_seconds: number;
}

/**
 * Settle one interval's as-yet-unsettled seconds up to `endIso`.
 *
 * `closing` is true when the interval is being closed (disable, suspension):
 * then every remaining second is billed, even below the minimum unit. The
 * wallet debit, the charge row, the usage event and the cursor advance are one
 * transaction; an insufficient balance throws and the caller decides whether
 * to suspend (the default) — no debt is ever created here.
 */
async function settleIntervalTx(
  client: PoolClient,
  intervalId: string,
  endIso: string,
  closing: boolean,
  actorUserId: string | null,
  allowUncovered = false,
): Promise<SettlementResult> {
  const { rows } = await client.query<IntervalRow>(
    `SELECT id, business_id, activation_id, started_at, ended_at, last_settled_at,
            hourly_rate_rial, hourly_price_version, minimum_unit_seconds
       FROM service_activation_intervals
      WHERE id = $1
      FOR UPDATE`,
    [intervalId],
  );
  const interval = rows[0];
  if (!interval) return { status: "no_open_interval" };

  const startedAt = iso(interval.started_at)!;
  const hardEnd = interval.ended_at ? iso(interval.ended_at)! : null;
  const cursor = iso(interval.last_settled_at) ?? startedAt;
  const target = hardEnd && hardEnd < endIso ? hardEnd : endIso;
  const seconds = billableSecondsBetween(cursor, target);
  if (seconds <= 0) return { status: "not_due" };
  if (!closing && !hardEnd && seconds < Number(interval.minimum_unit_seconds)) {
    return { status: "not_due" };
  }

  const rate = Number(interval.hourly_rate_rial);
  const amount = enabledRialForSeconds(seconds, rate);

  // Affordability is checked BEFORE anything is written, so a closing interval
  // can stop at the last covered second without aborting its transaction. A
  // non-closing pass (the worker) throws instead: the caller suspends the
  // service rather than letting it accrue uncovered debt.
  if (amount > 0) {
    const balance = await lockWallet(client, interval.business_id);
    if (balance < amount) {
      if (allowUncovered) return { status: "insufficient_credit" };
      throw new WalletInsufficientFundsError(amount, balance);
    }
  }

  // Claim the segment first. `(interval_id, period_start)` is the idempotency
  // key, so a retry that lost the race simply advances the cursor.
  const { rows: claim } = await client.query<{ id: string }>(
    `INSERT INTO service_runtime_charges
       (business_id, activation_id, interval_id, period_start, period_end,
        billed_seconds, hourly_rate_rial, hourly_price_version, amount_rial, metadata)
     VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (interval_id, period_start) DO NOTHING
     RETURNING id`,
    [
      interval.business_id,
      interval.activation_id,
      interval.id,
      cursor,
      target,
      seconds,
      rate,
      interval.hourly_price_version,
      amount,
      JSON.stringify({ closing }),
    ],
  );
  if (!claim[0]) {
    await client.query(
      `UPDATE service_activation_intervals
          SET last_settled_at = GREATEST(COALESCE(last_settled_at, started_at), $2::timestamptz)
        WHERE id = $1`,
      [interval.id, target],
    );
    return { status: "duplicate", billedSeconds: seconds, amountRial: 0, periodStart: cursor, periodEnd: target };
  }
  const chargeId = claim[0].id;

  let ledgerId: string | null = null;
  if (amount > 0) {
    const { rows: activationRows } = await client.query<{ label: string }>(
      `SELECT label FROM business_service_activations WHERE id = $1`,
      [interval.activation_id],
    );
    const label = activationRows[0]?.label || "سرویس";
    const entry = await postWalletEntryTx(client, {
      businessId: interval.business_id,
      kind: "service_runtime",
      direction: "debit",
      amountRial: amount,
      note: `هزینهٔ فعال بودن «${label}» — ${Math.ceil(seconds / 60)} دقیقه`,
      userId: actorUserId,
      metadata: {
        activationId: interval.activation_id,
        intervalId: interval.id,
        periodStart: cursor,
        periodEnd: target,
        billedSeconds: seconds,
        priceVersion: interval.hourly_price_version,
      },
    });
    ledgerId = entry.id;
  }

  const usage = await appendUsageEvent(
    {
      eventId: `service_runtime:${interval.id}:${cursor}`,
      businessId: interval.business_id,
      meterKey: "service.enabled_seconds",
      source: "service_runtime",
      quantity: seconds,
      unit: "second",
      occurredAt: target,
      periodStart: cursor,
      periodEnd: target,
      resource: "service_activation",
      resourceId: interval.activation_id,
      dimensions: {
        intervalId: interval.id,
        priceVersion: interval.hourly_price_version,
      },
      ratedAmountRial: amount,
      sourceReference: interval.id,
    },
    client,
  );
  const usageEventId = usage.status === "rejected" ? null : usage.id;

  await client.query(
    `UPDATE service_runtime_charges
        SET wallet_ledger_id = $2, usage_event_id = $3
      WHERE id = $1`,
    [chargeId, ledgerId, usageEventId],
  );
  await client.query(
    `UPDATE service_activation_intervals
        SET last_settled_at = $2::timestamptz
      WHERE id = $1`,
    [interval.id, target],
  );
  await client.query(
    `UPDATE business_service_activations
        SET last_settled_at = $2::timestamptz, updated_at = now()
      WHERE id = $1`,
    [interval.activation_id, target],
  );

  return { status: "settled", billedSeconds: seconds, amountRial: amount, periodStart: cursor, periodEnd: target };
}

/** Settle one activation's open interval up to now (a read-triggered catch-up). */
export async function settleServiceRuntime(input: {
  businessId: string;
  identity: ServiceIdentity;
  now?: Date;
  actorUserId?: string | null;
}): Promise<SettlementResult> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    const activation = await lockActivationRow(client, input.businessId, identity);
    if (!activation) return { status: "no_open_interval" };
    if (!SERVICE_STATE_META[activation.state]?.billable) return { status: "no_open_interval" };
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM service_activation_intervals
        WHERE activation_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [activation.id],
    );
    if (!rows[0]) return { status: "no_open_interval" };
    return settleIntervalTx(client, rows[0].id, nowIso, false, input.actorUserId ?? null);
  });
}

/**
 * Close an interval at `atIso`, settling every remaining second it can. An
 * uncovered final segment is left unbilled and the interval closes at the last
 * settled cursor, so the runtime always stops exactly where the money stopped.
 */
async function closeIntervalTx(
  client: PoolClient,
  intervalId: string,
  atIso: string,
  actorUserId: string | null,
): Promise<SettlementResult> {
  const result = await settleIntervalTx(client, intervalId, atIso, true, actorUserId, true);
  await client.query(
    `UPDATE service_activation_intervals
        SET ended_at = $2::timestamptz
      WHERE id = $1 AND ended_at IS NULL`,
    [intervalId, atIso],
  );
  return result;
}

// ---------------------------------------------------------------------------
// Disable (starts retention) and suspension (never does)
// ---------------------------------------------------------------------------

export type DisableServiceResult =
  | {
      status: "disabled";
      activation: ServiceActivationRow;
      retentionDeadline: string | null;
      settlement: SettlementResult;
    }
  | { status: "already_disabled"; activation: ServiceActivationRow }
  | { status: "not_found" }
  | { status: "not_active"; activation: ServiceActivationRow }
  | { status: "conflict"; reason: "purge_in_progress" };

/**
 * The customer's disable. It ends the billable interval immediately, keeps all
 * settings and data, and starts the Superadmin-defined retention countdown for
 * this service. Nothing is deleted here, ever.
 */
export async function disableService(input: {
  businessId: string;
  identity: ServiceIdentity;
  actorUserId?: string | null;
  now?: Date;
}): Promise<DisableServiceResult> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    await lockIdentity(client, input.businessId, identity);
    const activation = await lockActivationRow(client, input.businessId, identity);
    if (!activation) return { status: "not_found" };
    if (activation.state === "purging") return { status: "conflict", reason: "purge_in_progress" };
    if (SERVICE_STATE_META[activation.state].customerDisabled) {
      return { status: "already_disabled", activation };
    }

    let settlement: SettlementResult = { status: "no_open_interval" };
    const statesAllowed = ["active", "suspended_insufficient_credit", "platform_unavailable"];
    if (statesAllowed.includes(activation.state)) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM service_activation_intervals
          WHERE activation_id = $1 AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1
          FOR UPDATE`,
        [activation.id],
      );
      if (rows[0]) {
        settlement = await closeIntervalTx(client, rows[0].id, nowIso, input.actorUserId ?? null);
      }
    } else {
      return { status: "not_active", activation };
    }

    const policy = await effectiveRetentionPolicy(
      input.businessId,
      activation.kind,
      activation.key,
    );
    const deadline = policyDeadline(nowIso, policy);

    // Upsert the single queue row for this activation; queueing is the ONLY
    // destructive step a disable may take, and it deletes nothing by itself.
    if (deadline) {
      await client.query(
        `INSERT INTO service_purge_queue
           (business_id, activation_id, service_kind, service_key, scheduled_at,
            state, policy_source, policy_version, updated_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz,'scheduled',$6,$7, now())
         ON CONFLICT (activation_id) DO UPDATE
           SET scheduled_at = EXCLUDED.scheduled_at,
               state = 'scheduled',
               policy_source = EXCLUDED.policy_source,
               policy_version = EXCLUDED.policy_version,
               attempts = 0,
               last_error = NULL,
               updated_at = now()`,
        [
          input.businessId,
          activation.id,
          activation.kind,
          activation.key,
          deadline,
          policy.source === "business" ? "business" : "platform",
          policy.policyVersion,
        ],
      );
      await logEvent(client, {
        businessId: input.businessId,
        activationId: activation.id,
        kind: activation.kind,
        key: activation.key,
        action: "purge_scheduled",
        actorUserId: input.actorUserId ?? null,
        detail: { deadline, policy },
      });
    }

    const { rows } = await client.query<ActivationDbRow>(
      `UPDATE business_service_activations
          SET state = 'disabled_retained',
              disabled_at = $2::timestamptz,
              disabled_reason = 'customer',
              suspended_at = NULL,
              suspension_reason = NULL,
              retention_deadline = $3::timestamptz,
              purge_state = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING ${ACTIVATION_COLUMNS}`,
      [
        activation.id,
        nowIso,
        deadline,
        deadline ? "scheduled" : "none",
      ],
    );
    await logEvent(client, {
      businessId: input.businessId,
      activationId: activation.id,
      kind: activation.kind,
      key: activation.key,
      action: "disabled",
      actorUserId: input.actorUserId ?? null,
      detail: { retentionDeadline: deadline, settlement },
    });

    return {
      status: "disabled",
      activation: toActivation(rows[0]),
      retentionDeadline: deadline,
      settlement,
    };
  });
}

function policyDeadline(disabledAtIso: string, policy: RetentionPolicy): string | null {
  if (!policy.autoPurgeEnabled || policy.retentionDays == null) return null;
  const base = Date.parse(disabledAtIso);
  return new Date(base + policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export type SuspendServiceResult =
  | { status: "suspended"; activation: ServiceActivationRow; settlement: SettlementResult }
  | { status: "already_suspended"; activation: ServiceActivationRow }
  | { status: "not_found" }
  | { status: "not_active"; activation: ServiceActivationRow };

/**
 * Stop chargeable runtime for a reason that is NOT the customer's decision:
 * insufficient wallet credit, a provider/platform outage, maintenance or a
 * legal hold. It closes the interval (billing ends now) but never sets
 * `disabled_at`/`retention_deadline`, so no deletion countdown starts.
 */
export async function suspendService(input: {
  businessId: string;
  identity: ServiceIdentity;
  reason: SuspensionReason;
  actorUserId?: string | null;
  platformAdminId?: string | null;
  now?: Date;
}): Promise<SuspendServiceResult> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  const target = SUSPENSION_STATE[input.reason];
  return withTenantTransaction(input.businessId, async (client) => {
    await lockIdentity(client, input.businessId, identity);
    const activation = await lockActivationRow(client, input.businessId, identity);
    if (!activation) return { status: "not_found" };
    if (activation.state === target) return { status: "already_suspended", activation };
    if (activation.state !== "active") return { status: "not_active", activation };

    let settlement: SettlementResult = { status: "no_open_interval" };
    const { rows: intervals } = await client.query<{ id: string }>(
      `SELECT id FROM service_activation_intervals
        WHERE activation_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [activation.id],
    );
    if (intervals[0]) {
      settlement = await closeIntervalTx(client, intervals[0].id, nowIso, input.actorUserId ?? null);
    }

    const { rows } = await client.query<ActivationDbRow>(
      `UPDATE business_service_activations
          SET state = $2,
              suspended_at = $3::timestamptz,
              suspension_reason = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING ${ACTIVATION_COLUMNS}`,
      [activation.id, target, nowIso, input.reason],
    );
    await logEvent(client, {
      businessId: input.businessId,
      activationId: activation.id,
      kind: activation.kind,
      key: activation.key,
      action: "suspended",
      actorUserId: input.actorUserId ?? null,
      platformAdminId: input.platformAdminId ?? null,
      detail: { reason: input.reason, settlement },
    });
    return { status: "suspended", activation: toActivation(rows[0]), settlement };
  });
}

// ---------------------------------------------------------------------------
// Settlement worker
// ---------------------------------------------------------------------------

export interface RuntimeTickResult {
  scanned: number;
  settled: number;
  billedSeconds: number;
  billedRial: number;
  suspended: number;
  failed: number;
}

/**
 * The hourly/background settlement pass: settle every open interval that has
 * accumulated at least one minimum unit, and suspend a service whose wallet can
 * no longer cover its due segment. Enumeration runs under the documented
 * platform bypass and each business's work is wrapped in `withTenant` — the same
 * shape as every other background tick.
 *
 * Safe to call from several workers at once: the interval row lock plus the
 * unique `(interval_id, period_start)` claim make a concurrent pass a
 * duplicate, not a second debit.
 */
export async function settleDueServiceRuntime(
  options: { now?: Date; limit?: number } = {},
): Promise<RuntimeTickResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 200)));

  // Enumerate under the documented platform bypass (the same shape as every
  // other background tick), then do each business's work inside withTenant.
  const { rows: due } = await withoutTenantScope("platform", () =>
    query<{ id: string; business_id: string }>(
      `SELECT i.id, i.business_id
         FROM service_activation_intervals i
         JOIN business_service_activations a ON a.id = i.activation_id
        WHERE i.ended_at IS NULL
          AND a.state = 'active'
          AND COALESCE(i.last_settled_at, i.started_at)
              <= $1::timestamptz - make_interval(secs => i.minimum_unit_seconds)
        ORDER BY i.started_at
        LIMIT $2`,
      [nowIso, limit],
    ),
  );

  const result: RuntimeTickResult = {
    scanned: due.length,
    settled: 0,
    billedSeconds: 0,
    billedRial: 0,
    suspended: 0,
    failed: 0,
  };

  for (const interval of due) {
    try {
      const outcome = await withTenantTransaction(interval.business_id, async (client) =>
        settleIntervalTx(client, interval.id, nowIso, false, null),
      );
      if (outcome.status === "settled" || outcome.status === "duplicate") {
        result.settled += 1;
        result.billedSeconds += outcome.billedSeconds ?? 0;
        result.billedRial += outcome.amountRial ?? 0;
      }
    } catch (error) {
      if (!(error instanceof WalletInsufficientFundsError)) {
        result.failed += 1;
        continue;
      }
      // Out of credit: stop the runtime before spending uncovered money.
      try {
        const { rows } = await query<{ activation_id: string; business_id: string }>(
          `SELECT activation_id, business_id FROM service_activation_intervals WHERE id = $1`,
          [interval.id],
        );
        const row = rows[0];
        if (row) {
          await suspendActivationById(row.business_id, row.activation_id, nowIso);
          result.suspended += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}

/** Suspend by activation id (used by the worker, which only has the interval). */
async function suspendActivationById(
  businessId: string,
  activationId: string,
  nowIso: string,
): Promise<void> {
  await withTenantTransaction(businessId, async (client) => {
    const { rows } = await client.query<ActivationDbRow>(
      `SELECT ${ACTIVATION_COLUMNS}
         FROM business_service_activations
        WHERE id = $1 AND business_id = $2
        FOR UPDATE`,
      [activationId, businessId],
    );
    const activation = rows[0] ? toActivation(rows[0]) : null;
    if (!activation || activation.state !== "active") return;

    const { rows: intervals } = await client.query<{ id: string }>(
      `SELECT id FROM service_activation_intervals
        WHERE activation_id = $1 AND ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [activationId],
    );
    for (const interval of intervals) {
      await client.query(
        `UPDATE service_activation_intervals
            SET ended_at = GREATEST(COALESCE(last_settled_at, started_at), $2::timestamptz)
          WHERE id = $1 AND ended_at IS NULL`,
        [interval.id, nowIso],
      );
    }
    await client.query(
      `UPDATE business_service_activations
          SET state = 'suspended_insufficient_credit',
              suspended_at = $2::timestamptz,
              suspension_reason = 'insufficient_credit',
              updated_at = now()
        WHERE id = $1`,
      [activationId, nowIso],
    );
    await logEvent(client, {
      businessId,
      activationId,
      kind: activation.kind,
      key: activation.key,
      action: "suspended",
      detail: { reason: "insufficient_credit", source: "runtime_worker" },
    });
  });
}

// ---------------------------------------------------------------------------
// Legal / operational hold
// ---------------------------------------------------------------------------

export async function holdServiceActivation(input: {
  businessId: string;
  identity: ServiceIdentity;
  platformAdminId?: string | null;
  note?: string | null;
  now?: Date;
}): Promise<ServiceActivationRow> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    const activation = await lockActivationRow(client, input.businessId, identity);
    if (!activation) throw new ServiceActivationError("not_found");
    await client.query(
      `UPDATE service_purge_queue
          SET state = 'blocked', updated_at = now()
        WHERE activation_id = $1 AND state IN ('scheduled', 'failed')`,
      [activation.id],
    );
    const { rows } = await client.query<ActivationDbRow>(
      `UPDATE business_service_activations
          SET state = 'legal_hold',
              suspended_at = COALESCE(suspended_at, $2::timestamptz),
              suspension_reason = 'legal_hold',
              updated_at = now()
        WHERE id = $1
        RETURNING ${ACTIVATION_COLUMNS}`,
      [activation.id, nowIso],
    );
    await logEvent(client, {
      businessId: input.businessId,
      activationId: activation.id,
      kind: activation.kind,
      key: activation.key,
      action: "held",
      platformAdminId: input.platformAdminId ?? null,
      detail: { note: input.note ?? null, previousState: activation.state },
    });
    return toActivation(rows[0]);
  });
}

export async function releaseServiceActivation(input: {
  businessId: string;
  identity: ServiceIdentity;
  platformAdminId?: string | null;
  now?: Date;
}): Promise<ServiceActivationRow> {
  const identity = identityOf(input.identity);
  const nowIso = (input.now ?? new Date()).toISOString();
  return withTenantTransaction(input.businessId, async (client) => {
    const activation = await lockActivationRow(client, input.businessId, identity);
    if (!activation) throw new ServiceActivationError("not_found");
    const returnsToDisabled = activation.disabledAt != null;
    const { rows } = await client.query<ActivationDbRow>(
      `UPDATE business_service_activations
          SET state = $2,
              suspended_at = NULL,
              suspension_reason = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING ${ACTIVATION_COLUMNS}`,
      [activation.id, returnsToDisabled ? "disabled_retained" : "active"],
    );
    if (returnsToDisabled && activation.retentionDeadline) {
      await client.query(
        `UPDATE service_purge_queue
            SET state = 'scheduled',
                scheduled_at = GREATEST(scheduled_at, $2::timestamptz),
                updated_at = now()
          WHERE activation_id = $1`,
        [activation.id, nowIso],
      );
    }
    await logEvent(client, {
      businessId: input.businessId,
      activationId: activation.id,
      kind: activation.kind,
      key: activation.key,
      action: "released",
      platformAdminId: input.platformAdminId ?? null,
      detail: { state: returnsToDisabled ? "disabled_retained" : "active" },
    });
    return toActivation(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Read-only summary for the tenant's billing screen
// ---------------------------------------------------------------------------

export interface ServiceRuntimeSummary {
  activationId: string;
  identity: ServiceIdentity;
  label: string;
  state: ServiceState;
  /** Seconds since the current interval started (or the interval's total). */
  enabledSeconds: number;
  settledSeconds: number;
  chargedRial: number;
  upcomingHourRial: number;
}

export async function listServiceRuntimeSummary(
  businessId: string,
  now: Date = new Date(),
): Promise<ServiceRuntimeSummary[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{
      id: string;
      service_kind: string;
      service_key: string;
      runtime_instance_id: string;
      label: string;
      state: string;
      started_at: Date | string | null;
      ended_at: Date | string | null;
      last_settled_at: Date | string | null;
      hourly_rate_rial: string | number | null;
      settled_seconds: string | number | null;
      charged_rial: string | number | null;
    }>(
      `SELECT a.id, a.service_kind, a.service_key, a.runtime_instance_id, a.label, a.state,
              i.started_at, i.ended_at, i.last_settled_at, i.hourly_rate_rial,
              COALESCE((SELECT SUM(c.billed_seconds)
                          FROM service_runtime_charges c
                         WHERE c.activation_id = a.id), 0) AS settled_seconds,
              COALESCE((SELECT SUM(c.amount_rial)
                          FROM service_runtime_charges c
                         WHERE c.activation_id = a.id), 0) AS charged_rial
         FROM business_service_activations a
         LEFT JOIN LATERAL (
           SELECT started_at, ended_at, last_settled_at, hourly_rate_rial
             FROM service_activation_intervals i
            WHERE i.activation_id = a.id
            ORDER BY i.started_at DESC
            LIMIT 1
         ) i ON true
        WHERE a.business_id = $1
        ORDER BY a.service_kind, a.service_key`,
      [businessId],
    );
    return rows.map((row) => {
      const start = iso(row.started_at);
      const end = iso(row.ended_at) ?? now.toISOString();
      return {
        activationId: row.id,
        identity: {
          kind: row.service_kind as ServiceKind,
          key: row.service_key,
          runtimeInstanceId: row.runtime_instance_id,
        },
        label: row.label,
        state: row.state as ServiceState,
        enabledSeconds: start ? billableSecondsBetween(start, end) : 0,
        settledSeconds: Number(row.settled_seconds ?? 0),
        chargedRial: Number(row.charged_rial ?? 0),
        upcomingHourRial: Number(row.hourly_rate_rial ?? 0),
      };
    });
  });
}
