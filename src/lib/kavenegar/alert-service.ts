/**
 * Issue #902 §3 — the Superadmin attention ledger for the managed SMS service.
 *
 * The funding and reconciliation passes decide correctly and in silence. §3's
 * last bullet is the missing half: *"Alert Superadmin for low master credit,
 * child discrepancies, suspended accounts, failed transfers."* A `console.error`
 * is not an alert — nobody is watching a log at 02:00, and a line that repeats
 * every 15 minutes is worse than none.
 *
 * So the rules live here, in two halves:
 *
 *   * **pure** — `alertForFundingBlock`, `alertForTransferState`,
 *     `alertForReconciliation`, `alertForAccount`. Each maps an internal
 *     outcome to an alert *kind* (or nothing), and nothing is an answer: a
 *     healthy child, a scheduled strategy outside its window and a deficit
 *     smaller than the provider's minimum are all normal, and alerting on them
 *     would train an operator to ignore the panel.
 *   * **persistence** — `raiseServiceAlert`, `resolveServiceAlert`,
 *     `acknowledgeServiceAlert`, `listServiceAlerts`. One *open* row per
 *     condition, with `occurrences` counting how often it has been seen, so the
 *     panel answers "what needs me" rather than "what has ever happened".
 *
 * Alert text is first-party and provider-neutral, like every other operator
 * string in this service: an alert may say «اعتبار حساب اصلی در آستانهٔ پایان
 * است», never a supplier name or a raw provider code. The `detail` column is
 * internal diagnostics and is platform-only.
 */
import { query, withoutTenantScope } from "../db";
import type { FundingBlockedReason } from "./pricing-service";

const SCOPE = "kavenegar-alerts";

/** The closed set of conditions, mirrored by migration 0263's CHECK. */
export type ServiceAlertKind =
  | "master_credit_low"
  | "master_balance_unknown"
  | "fleet_cap_reached"
  | "child_cap_reached"
  | "daily_cap_reached"
  | "unresolved_transfer"
  | "funding_failed"
  | "reconciliation_drift"
  | "reconciliation_incomplete"
  | "account_suspended"
  | "provisioning_failed"
  | "tariff_missing";

export type ServiceAlertSeverity = "critical" | "warning" | "info";

/**
 * How much of a hurry each condition is.
 *
 * `critical` means money may already have moved or a tenant cannot send;
 * `warning` means a policy limit is stopping automation and a human should
 * decide; `info` means the pass could not prove something (an unreachable
 * provider read) and will try again.
 */
export const ALERT_SEVERITY: Readonly<Record<ServiceAlertKind, ServiceAlertSeverity>> = {
  master_credit_low: "critical",
  master_balance_unknown: "warning",
  fleet_cap_reached: "warning",
  child_cap_reached: "warning",
  daily_cap_reached: "warning",
  unresolved_transfer: "critical",
  funding_failed: "critical",
  reconciliation_drift: "critical",
  reconciliation_incomplete: "info",
  account_suspended: "critical",
  provisioning_failed: "warning",
  tariff_missing: "warning",
};

/** First-party operator copy. Never a supplier name, never a provider code. */
export const ALERT_TITLE: Readonly<Record<ServiceAlertKind, string>> = {
  master_credit_low: "اعتبار حساب اصلی در آستانهٔ پایان است",
  master_balance_unknown: "موجودی حساب اصلی نامشخص است؛ شارژ خودکار متوقف شد",
  fleet_cap_reached: "سقف روزانهٔ شارژ همهٔ کسب‌وکارها پر شده است",
  child_cap_reached: "سقف اعتبار مجاز این کسب‌وکار پر شده است",
  daily_cap_reached: "سقف شارژ روزانهٔ این کسب‌وکار پر شده است",
  unresolved_transfer: "یک انتقال اعتبار با نتیجهٔ نامشخص در انتظار بررسی است",
  funding_failed: "انتقال اعتبار به حساب سرویس این کسب‌وکار ناموفق بود",
  reconciliation_drift: "مغایرت بین موجودی تأمین‌کننده و دفتر داخلی",
  reconciliation_incomplete: "بازخوانی موجودی تأمین‌کننده انجام نشد",
  account_suspended: "وضعیت حساب سرویس با تأمین‌کننده هم‌خوان نیست",
  provisioning_failed: "راه‌اندازی حساب سرویس این کسب‌وکار ناموفق بود",
  tariff_missing: "تعرفهٔ تأمین‌کننده برای این کسب‌وکار ثبت نشده است",
};

/** The remedy an operator is expected to take, in the same first-party voice. */
export const ALERT_ACTION: Readonly<Record<ServiceAlertKind, string>> = {
  master_credit_low: "اعتبار حساب اصلی را شارژ کنید یا سقف‌های شارژ خودکار را بازبینی کنید.",
  master_balance_unknown: "موجودی حساب اصلی را از پنل تأمین‌کننده بخوانید و در پنل ثبت کنید.",
  fleet_cap_reached: "سقف روزانهٔ سراسری را بالا ببرید یا تا فردا صبر کنید.",
  child_cap_reached: "سقف اعتبار این کسب‌وکار را بالا ببرید یا موجودی آن را بازبینی کنید.",
  daily_cap_reached: "سقف شارژ روزانهٔ این کسب‌وکار را بازبینی کنید.",
  unresolved_transfer: "انتقال را در پنل تأمین‌کننده بررسی و نتیجه را ثبت کنید؛ انتقال دوباره انجام ندهید.",
  funding_failed: "پس از بررسی وضعیت حساب، شارژ دستی همان مبلغ را انجام دهید.",
  reconciliation_drift: "گردش حساب سرویس را بررسی و مغایرت را در پنل ثبت کنید.",
  reconciliation_incomplete: "اتصال به تأمین‌کننده را بررسی کنید؛ پاس بعدی دوباره تلاش می‌کند.",
  account_suspended: "وضعیت حساب را با پنل تأمین‌کننده هم‌خوان کنید و در صورت نیاز دوباره فعال کنید.",
  provisioning_failed: "کار راه‌اندازی را از پنل دوباره اجرا کنید و علت را بررسی کنید.",
  tariff_missing: "حساب را با تأمین‌کننده همگام کنید تا تعرفه ثبت شود.",
};

export interface ServiceAlertDescriptor {
  kind: ServiceAlertKind;
  /** The subject, when the condition is about one child. */
  businessId: string | null;
  subjectKey?: string;
  detail?: Record<string, unknown>;
}

/**
 * Which alert a blocked funding decision raises — or `null` for the four
 * non-conditions.
 *
 * Deliberately quiet:
 *   * `automatic_top_up_off` — the operator's own setting;
 *   * `outside_funding_window` — the operator's own window, working;
 *   * `healthy` — nothing to say;
 *   * `below_provider_minimum` — the deficit is smaller than one transfer, so
 *     the next send cycle closes it. Alerting on it would page someone about a
 *     rounding remainder.
 */
export function alertForFundingBlock(
  reason: FundingBlockedReason,
  businessId: string | null,
): ServiceAlertDescriptor | null {
  switch (reason) {
    case "master_floor":
      return { kind: "master_credit_low", businessId: null };
    case "master_balance_unknown":
      return { kind: "master_balance_unknown", businessId: null };
    case "global_daily_cap_reached":
      return { kind: "fleet_cap_reached", businessId: null };
    case "child_cap_reached":
      return { kind: "child_cap_reached", businessId };
    case "daily_cap_reached":
      return { kind: "daily_cap_reached", businessId };
    case "unresolved_transfer":
      // Quiet on purpose: an in-flight `pending` reservation blocks the next
      // pass for a few seconds by design (that is the double-funding guard
      // working). The incident an operator must see is an `unknown` *outcome*,
      // which raises this same kind from `alertForTransferState`.
      return null;
    case "tariff_unknown":
      return { kind: "tariff_missing", businessId };
    case "automatic_top_up_off":
    case "outside_funding_window":
    case "healthy":
    case "below_provider_minimum":
      return null;
    default:
      return null;
  }
}

/**
 * A transfer that did not end `applied`.
 *
 * `unknown` is the strictest case in the whole service: the request left this
 * process and we do not know whether the provider moved the credit, so it is
 * `critical`, deduped per transfer, and the remedy is explicitly *not* to
 * transfer again.
 */
export function alertForTransferState(
  state: "pending" | "applied" | "unknown" | "failed",
  businessId: string,
  transferId: string,
): ServiceAlertDescriptor | null {
  if (state === "applied") return null;
  if (state === "unknown") {
    return { kind: "unresolved_transfer", businessId, subjectKey: transferId };
  }
  if (state === "failed") {
    return { kind: "funding_failed", businessId, subjectKey: transferId };
  }
  // `pending` is the reservation phase of a transfer this same pass is about to
  // attempt; it becomes `unknown` or `failed` if it does not resolve.
  return null;
}

/** Reconciliation: drift is money, an unreadable balance is only a gap. */
export function alertForReconciliation(
  state: "ok" | "drift" | "incomplete",
  businessId: string,
): ServiceAlertDescriptor | null {
  if (state === "ok") return null;
  return { kind: state === "drift" ? "reconciliation_drift" : "reconciliation_incomplete", businessId };
}

/**
 * An `active` child the provider does not agree exists, or has disabled.
 *
 * This is the "suspended accounts" bullet of the issue, and it is the case the
 * provisioning state machine cannot see on its own: our row says `active`
 * because the last successful sync said so, while the provider has since
 * removed or un-approved the child — every send then fails with an internal
 * error nobody is watching.
 */
export function alertForAccount(input: {
  businessId: string;
  provisionState: string;
  providerStatus: string | null;
}): ServiceAlertDescriptor | null {
  if (input.provisionState !== "active") return null;
  if (input.providerStatus === "approved") return null;
  if (input.providerStatus === null || input.providerStatus === "unknown") {
    return {
      kind: "account_suspended",
      businessId: input.businessId,
      detail: { providerStatus: input.providerStatus },
    };
  }
  return {
    kind: "account_suspended",
    businessId: input.businessId,
    detail: { providerStatus: input.providerStatus },
  };
}

/** A provisioning job that exhausted its attempts. */
export function alertForProvisioningJob(input: {
  businessId: string;
  state: string;
  attempts: number;
  lastErrorCode: string | null;
}): ServiceAlertDescriptor | null {
  const exhausted = input.attempts >= 3;
  if (input.state !== "failed" && !(input.state === "retry_pending" && exhausted)) return null;
  return {
    kind: "provisioning_failed",
    businessId: input.businessId,
    detail: { attempts: input.attempts, errorCode: input.lastErrorCode },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface ServiceAlertRow {
  id: string;
  kind: ServiceAlertKind;
  severity: ServiceAlertSeverity;
  businessId: string | null;
  businessName: string | null;
  accountId: string | null;
  subjectKey: string;
  detail: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  acknowledgementNote: string | null;
  resolvedAt: string | null;
}

type AlertDbRow = {
  id: string;
  kind: ServiceAlertKind;
  severity: ServiceAlertSeverity;
  subject_business_id: string | null;
  business_name: string | null;
  account_id: string | null;
  subject_key: string;
  detail: Record<string, unknown> | null;
  occurrences: number;
  first_seen_at: Date;
  last_seen_at: Date;
  acknowledged_at: Date | null;
  acknowledgement_note: string | null;
  resolved_at: Date | null;
};

function toAlert(row: AlertDbRow): ServiceAlertRow {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    businessId: row.subject_business_id,
    businessName: row.business_name,
    accountId: row.account_id,
    subjectKey: row.subject_key,
    detail: row.detail ?? {},
    occurrences: row.occurrences,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    acknowledgementNote: row.acknowledgement_note,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}

const SELECT_ALERT = `
  SELECT a.id, a.kind, a.severity, a.subject_business_id, b.name AS business_name,
         a.account_id, a.subject_key, a.detail, a.occurrences,
         a.first_seen_at, a.last_seen_at, a.acknowledged_at,
         a.acknowledgement_note, a.resolved_at
    FROM kavenegar_service_alerts a
    LEFT JOIN businesses b ON b.id = a.subject_business_id`;

/**
 * Record that a condition has been observed.
 *
 * Upsert on the open-row index: the first observation inserts, every later one
 * moves `last_seen_at` and `occurrences` and takes the *latest* detail (which is
 * what an operator wants — the current numbers, not the numbers from when the
 * alert first fired). A resolved row is not matched by the index, so the same
 * condition raised again starts a fresh row with its own history.
 */
export async function raiseServiceAlert(
  descriptor: ServiceAlertDescriptor & { accountId?: string | null },
): Promise<ServiceAlertRow> {
  const severity = ALERT_SEVERITY[descriptor.kind];
  const subjectKey = descriptor.subjectKey ?? "";
  const businessId = descriptor.businessId ?? null;
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<AlertDbRow>(
      `WITH upserted AS (
         INSERT INTO kavenegar_service_alerts
           (kind, severity, subject_business_id, account_id, subject_key, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (kind,
                      coalesce(subject_business_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      subject_key)
           WHERE resolved_at IS NULL
           DO UPDATE SET
             last_seen_at = now(),
             occurrences = kavenegar_service_alerts.occurrences + 1,
             detail = EXCLUDED.detail,
             severity = EXCLUDED.severity,
             account_id = coalesce(EXCLUDED.account_id, kavenegar_service_alerts.account_id),
             updated_at = now()
         RETURNING *
       )
       SELECT u.id, u.kind, u.severity, u.subject_business_id, b.name AS business_name,
              u.account_id, u.subject_key, u.detail, u.occurrences,
              u.first_seen_at, u.last_seen_at, u.acknowledged_at,
              u.acknowledgement_note, u.resolved_at
         FROM upserted u
         LEFT JOIN businesses b ON b.id = u.subject_business_id`,
      [
        descriptor.kind,
        severity,
        businessId,
        descriptor.accountId ?? null,
        subjectKey,
        JSON.stringify(descriptor.detail ?? {}),
      ],
    );
    return toAlert(rows[0]);
  });
}

/**
 * Close an open alert because the condition is gone.
 *
 * Returns how many rows closed, so a pass can tell "the drift cleared" from
 * "there was nothing to clear" without a second read. `subjectKey` narrows a
 * resolution to one subject (one transfer) instead of the whole kind.
 */
export async function resolveServiceAlert(input: {
  kind: ServiceAlertKind;
  businessId?: string | null;
  subjectKey?: string;
}): Promise<number> {
  return withoutTenantScope(SCOPE, async () => {
    const params: unknown[] = [input.kind, input.businessId ?? null];
    let clause = "";
    if (input.subjectKey !== undefined) {
      params.push(input.subjectKey);
      clause = ` AND subject_key = $3`;
    }
    const { rowCount } = await query(
      `UPDATE kavenegar_service_alerts
          SET resolved_at = now(), updated_at = now()
        WHERE resolved_at IS NULL
          AND kind = $1
          AND subject_business_id IS NOT DISTINCT FROM $2::uuid${clause}`,
      params,
    );
    return rowCount ?? 0;
  });
}

/**
 * Close every open alert of `kinds` for one business except the one just
 * observed — the "the condition changed" case. Kept explicit rather than a
 * catch-all so an unrelated alert is never closed by side effect.
 */
export async function resolveOtherBusinessAlerts(input: {
  businessId: string;
  keepKind?: ServiceAlertKind | null;
  kinds: ServiceAlertKind[];
}): Promise<number> {
  if (input.kinds.length === 0) return 0;
  return withoutTenantScope(SCOPE, async () => {
    const { rowCount } = await query(
      `UPDATE kavenegar_service_alerts
          SET resolved_at = now(), updated_at = now()
        WHERE resolved_at IS NULL
          AND subject_business_id = $1
          AND kind = ANY($2::text[])
          AND ($3::text IS NULL OR kind <> $3)`,
      [input.businessId, input.kinds, input.keepKind ?? null],
    );
    return rowCount ?? 0;
  });
}

/** Acknowledge an alert: "a human has seen this". Does not resolve it. */
export async function acknowledgeServiceAlert(input: {
  alertId: string;
  adminId: string;
  note?: string | null;
}): Promise<ServiceAlertRow | null> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<AlertDbRow>(
      `WITH updated AS (
         UPDATE kavenegar_service_alerts
            SET acknowledged_at = coalesce(acknowledged_at, now()),
                acknowledged_by = coalesce(acknowledged_by, $2::uuid),
                acknowledgement_note = coalesce($3, acknowledgement_note),
                updated_at = now()
          WHERE id = $1
          RETURNING *
       )
       SELECT u.id, u.kind, u.severity, u.subject_business_id, b.name AS business_name,
              u.account_id, u.subject_key, u.detail, u.occurrences,
              u.first_seen_at, u.last_seen_at, u.acknowledged_at,
              u.acknowledgement_note, u.resolved_at
         FROM updated u
         LEFT JOIN businesses b ON b.id = u.subject_business_id`,
      [input.alertId, input.adminId, input.note ?? null],
    );
    return rows[0] ? toAlert(rows[0]) : null;
  });
}

/** The open ledger, most urgent first. */
export async function listServiceAlerts(options: { limit?: number; includeResolved?: boolean } = {}): Promise<
  ServiceAlertRow[]
> {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<AlertDbRow>(
      `${SELECT_ALERT}
        ${options.includeResolved ? "" : "WHERE a.resolved_at IS NULL"}
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 a.last_seen_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toAlert);
  });
}

export interface ServiceAlertSummary {
  critical: number;
  warning: number;
  info: number;
  unacknowledged: number;
  total: number;
}

/** The counts the console badge shows. */
export async function getServiceAlertSummary(): Promise<ServiceAlertSummary> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<{
      critical: string | number;
      warning: string | number;
      info: string | number;
      unacknowledged: string | number;
      total: string | number;
    }>(
      `SELECT count(*) FILTER (WHERE severity = 'critical') AS critical,
              count(*) FILTER (WHERE severity = 'warning')  AS warning,
              count(*) FILTER (WHERE severity = 'info')     AS info,
              count(*) FILTER (WHERE acknowledged_at IS NULL) AS unacknowledged,
              count(*) AS total
         FROM kavenegar_service_alerts
        WHERE resolved_at IS NULL`,
    );
    const row = rows[0];
    return {
      critical: Number(row?.critical ?? 0),
      warning: Number(row?.warning ?? 0),
      info: Number(row?.info ?? 0),
      unacknowledged: Number(row?.unacknowledged ?? 0),
      total: Number(row?.total ?? 0),
    };
  });
}
