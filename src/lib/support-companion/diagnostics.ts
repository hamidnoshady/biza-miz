/**
 * Issue #984 — ticket-driven diagnostic requests and runs.
 *
 * A request binds one ticket + verified installation + generation + named
 * initiator; the companion resolves and verifies it locally before running
 * anything. Runs append structured, timestamped history to the same ticket —
 * a new run never overwrites an old one, and appending a report never
 * resolves or closes the ticket.
 *
 * Scope is always derived server-side from the verified ticket and
 * installation rows — never from client-supplied business ids.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db";
import {
  SUPPORT_REQUEST_DEFAULT_MINUTES,
  isSupportRequestState,
  isSupportRunState,
  isTerminalRequestState,
  normalizeSupportModules,
  type SupportDiagnosticModule,
  type SupportOperation,
  type SupportRequestState,
  type SupportRunState,
  type SupportUploadState,
} from "./types";
import { getInstallation } from "./installations";
import { operatorSupportBlocked } from "./policy";
import { emptyRedactionSummary, redactValue, type RedactionSummary } from "./redaction";

export interface DiagnosticRequest {
  id: string;
  businessId: string;
  ticketId: string;
  locationId: string | null;
  installationId: string;
  installationGeneration: number;
  initiatedBy: "operator" | "member" | "support_ai";
  operatorAdminId: string | null;
  memberUserId: string | null;
  modules: SupportDiagnosticModule[];
  reason: string;
  allowedOperations: SupportOperation[];
  expiresAt: string;
  idempotencyKey: string;
  state: SupportRequestState;
  contextSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface RequestRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  ticket_id: string;
  location_id: string | null;
  installation_id: string;
  installation_generation: number;
  initiated_by: "operator" | "member" | "support_ai";
  operator_admin_id: string | null;
  member_user_id: string | null;
  modules: SupportDiagnosticModule[];
  reason: string;
  allowed_operations: SupportOperation[];
  expires_at: string;
  idempotency_key: string;
  state: SupportRequestState;
  context_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const REQUEST_SELECT = `
  SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
         location_id::text AS location_id, installation_id::text AS installation_id,
         installation_generation, initiated_by, operator_admin_id::text AS operator_admin_id,
         member_user_id::text AS member_user_id, modules, reason, allowed_operations,
         expires_at, idempotency_key, state, context_snapshot, created_at, updated_at
    FROM support_diagnostic_requests
`;

function toRequest(row: RequestRow): DiagnosticRequest {
  return {
    id: row.id,
    businessId: row.business_id,
    ticketId: row.ticket_id,
    locationId: row.location_id,
    installationId: row.installation_id,
    installationGeneration: row.installation_generation,
    initiatedBy: row.initiated_by,
    operatorAdminId: row.operator_admin_id,
    memberUserId: row.member_user_id,
    modules: row.modules ?? [],
    reason: row.reason,
    allowedOperations: row.allowed_operations ?? [],
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    contextSnapshot: row.context_snapshot ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DiagnosticRun {
  id: string;
  businessId: string;
  requestId: string;
  ticketId: string;
  installationId: string;
  state: SupportRunState;
  collectorVersions: Record<string, unknown>;
  coverage: Record<string, unknown>;
  findings: unknown[];
  severityOverall: "ok" | "warning" | "failed" | "unknown";
  observedAt: string | null;
  receivedAt: string;
  uploadState: SupportUploadState;
  serverAckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  request_id: string;
  ticket_id: string;
  installation_id: string;
  state: SupportRunState;
  collector_versions: Record<string, unknown>;
  coverage: Record<string, unknown>;
  findings: unknown[];
  severity_overall: "ok" | "warning" | "failed" | "unknown";
  observed_at: string | null;
  received_at: string;
  upload_state: SupportUploadState;
  server_ack_at: string | null;
  created_at: string;
  updated_at: string;
}

const RUN_SELECT = `
  SELECT id::text AS id, business_id::text AS business_id, request_id::text AS request_id,
         ticket_id::text AS ticket_id, installation_id::text AS installation_id, state,
         collector_versions, coverage, findings, severity_overall, observed_at, received_at,
         upload_state, server_ack_at, created_at, updated_at
    FROM support_diagnostic_runs
`;

function toRun(row: RunRow): DiagnosticRun {
  return {
    id: row.id,
    businessId: row.business_id,
    requestId: row.request_id,
    ticketId: row.ticket_id,
    installationId: row.installation_id,
    state: row.state,
    collectorVersions: row.collector_versions ?? {},
    coverage: row.coverage ?? {},
    findings: Array.isArray(row.findings) ? row.findings : [],
    severityOverall: row.severity_overall,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    uploadState: row.upload_state,
    serverAckAt: row.server_ack_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ticketBusinessId(ticketId: string): Promise<string | null> {
  const { rows } = await query<{ business_id: string }>(
    `SELECT business_id::text AS business_id FROM support_tickets WHERE id = $1::uuid`,
    [ticketId],
  );
  return rows[0]?.business_id ?? null;
}

export type CreateDiagnosticRequestResult =
  | { ok: true; request: DiagnosticRequest; duplicate: boolean }
  | {
      ok: false;
      error:
        | "ticket_not_found"
        | "installation_not_found"
        | "installation_not_active"
        | "reason_required"
        | "support_access_disabled";
    };

/**
 * Persists a diagnostic request for one verified ticket + installation.
 * The ticket and the installation must belong to the same business —
 * forged cross-tenant bindings are refused. Retrying with the same
 * idempotency key returns the original row instead of duplicating it.
 */
export async function createDiagnosticRequest(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  initiatedBy: "operator" | "member" | "support_ai";
  operatorAdminId?: string | null;
  memberUserId?: string | null;
  modules?: unknown;
  reason: string;
  allowedOperations?: SupportOperation[];
  expiresInMinutes?: number;
  idempotencyKey?: string;
}): Promise<CreateDiagnosticRequestResult> {
  if (!input.reason.trim()) return { ok: false, error: "reason_required" };
  // The tenant's own policy: a business that turned support off does not get
  // operator-requested device work. A customer filing their own request is
  // never gated by it.
  if (input.initiatedBy !== "member" && (await operatorSupportBlocked(input.businessId))) {
    return { ok: false, error: "support_access_disabled" };
  }
  const ownerBusinessId = await ticketBusinessId(input.ticketId);
  if (!ownerBusinessId || ownerBusinessId !== input.businessId) {
    return { ok: false, error: "ticket_not_found" };
  }
  const installation = await getInstallation(input.businessId, input.installationId);
  if (!installation) return { ok: false, error: "installation_not_found" };
  if (installation.enrollmentState !== "active") return { ok: false, error: "installation_not_active" };

  const modules = normalizeSupportModules(input.modules);
  const expiresMinutes = Math.min(
    Math.max(Math.floor(input.expiresInMinutes ?? SUPPORT_REQUEST_DEFAULT_MINUTES), 5),
    7 * 24 * 60,
  );
  const idempotencyKey = (input.idempotencyKey ?? randomUUID()).slice(0, 120);
  const contextSnapshot = {
    ticketId: input.ticketId,
    businessId: input.businessId,
    locationId: installation.locationId,
    installationId: installation.id,
    installationGeneration: installation.generation,
    siteDeviceId: installation.siteDeviceId,
    displayName: installation.displayName,
    mainVersion: installation.mainVersion,
    companionVersion: installation.companionVersion,
    schemaCompat: installation.schemaCompat,
    initiatedBy: input.initiatedBy,
    operatorAdminId: input.operatorAdminId ?? null,
    memberUserId: input.memberUserId ?? null,
    modules,
    capturedAt: new Date().toISOString(),
  };

  const { rows } = await query<RequestRow>(
    `INSERT INTO support_diagnostic_requests
       (business_id, ticket_id, location_id, installation_id, installation_generation,
        initiated_by, operator_admin_id, member_user_id, modules, reason,
        allowed_operations, expires_at, idempotency_key, context_snapshot)
     VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(mins => $12), $13, $14)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING
     RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
       location_id::text AS location_id, installation_id::text AS installation_id,
       installation_generation, initiated_by, operator_admin_id::text AS operator_admin_id,
       member_user_id::text AS member_user_id, modules, reason, allowed_operations,
       expires_at, idempotency_key, state, context_snapshot, created_at, updated_at`,
    [
      input.businessId,
      input.ticketId,
      installation.locationId,
      input.installationId,
      installation.generation,
      input.initiatedBy,
      input.operatorAdminId ?? null,
      input.memberUserId ?? null,
      modules,
      input.reason.trim().slice(0, 2000),
      input.allowedOperations ?? ["diagnostics.run"],
      expiresMinutes,
      idempotencyKey,
      JSON.stringify(contextSnapshot),
    ],
  );
  if (rows[0]) return { ok: true, request: toRequest(rows[0]), duplicate: false };

  const { rows: existing } = await query<RequestRow>(
    `${REQUEST_SELECT} WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, idempotencyKey],
  );
  if (!existing[0]) return { ok: false, error: "ticket_not_found" };
  return { ok: true, request: toRequest(existing[0]), duplicate: true };
}

export async function getDiagnosticRequest(
  businessId: string,
  requestId: string,
): Promise<DiagnosticRequest | null> {
  const { rows } = await query<RequestRow>(`${REQUEST_SELECT} WHERE id = $1::uuid AND business_id = $2`, [
    requestId,
    businessId,
  ]);
  return rows[0] ? toRequest(rows[0]) : null;
}

export async function listTicketDiagnosticRequests(
  businessId: string,
  ticketId: string,
): Promise<DiagnosticRequest[]> {
  const { rows } = await query<RequestRow>(
    `${REQUEST_SELECT} WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toRequest);
}

/**
 * What a verified companion polls: its installation's live, unexpired
 * requests only. Metadata the locked welcome screen may show (ticket,
 * scope, expiry) — never execution authority by itself.
 */
export async function listPendingInstallationRequests(
  businessId: string,
  installationId: string,
): Promise<DiagnosticRequest[]> {
  const { rows } = await query<RequestRow>(
    `${REQUEST_SELECT}
      WHERE business_id = $1 AND installation_id = $2::uuid
        AND state IN ('pending', 'delivered') AND expires_at > now()
      ORDER BY created_at ASC`,
    [businessId, installationId],
  );
  return rows.map(toRequest);
}

export type TransitionRequestResult =
  | { ok: true; request: DiagnosticRequest }
  | { ok: false; error: "request_not_found" | "terminal_state" | "invalid_state" | "expired" };

/**
 * Moves a request between states. Terminal states never move; an expired
 * request lands in `expired` instead of the requested state. Reconnect or a
 * queued request cannot silently initiate repairs or remote control — those
 * need their own authorization records.
 */
export async function transitionDiagnosticRequest(
  businessId: string,
  requestId: string,
  to: string,
): Promise<TransitionRequestResult> {
  if (!isSupportRequestState(to)) return { ok: false, error: "invalid_state" };
  const current = await getDiagnosticRequest(businessId, requestId);
  if (!current) return { ok: false, error: "request_not_found" };
  if (isTerminalRequestState(current.state)) return { ok: false, error: "terminal_state" };
  const landed: SupportRequestState =
    new Date(current.expiresAt).getTime() <= Date.now() && to !== "expired" ? "expired" : to;
  const { rows } = await query<RequestRow>(
    `UPDATE support_diagnostic_requests SET state = $3, updated_at = now()
      WHERE id = $1::uuid AND business_id = $2
      RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
        location_id::text AS location_id, installation_id::text AS installation_id,
        installation_generation, initiated_by, operator_admin_id::text AS operator_admin_id,
        member_user_id::text AS member_user_id, modules, reason, allowed_operations,
        expires_at, idempotency_key, state, context_snapshot, created_at, updated_at`,
    [requestId, businessId, landed],
  );
  return { ok: true, request: toRequest(rows[0]) };
}

export type RecordRunResult =
  | { ok: true; run: DiagnosticRun; redaction: RedactionSummary }
  | {
      ok: false;
      error: "request_not_found" | "request_not_running" | "invalid_state" | "scope_mismatch";
    };

const FINDING_MAX = 200;

/**
 * Persists one run's redacted findings for a live request. Findings are
 * redacted before persistence (blocked fields + secret patterns) and the
 * summary is returned so the ticket can show exclusions. Server receipt is
 * acknowledged (`received`) on this insert — the companion's `not_sent`
 * label clears only through this path, never by assuming delivery.
 */
export async function recordDiagnosticRun(input: {
  businessId: string;
  requestId: string;
  state: string;
  collectorVersions?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  findings?: unknown[];
  severityOverall?: "ok" | "warning" | "failed" | "unknown";
  observedAt?: string | null;
  /**
   * The caller's verified ticket/installation scope. When provided, the
   * resolved request must belong to exactly this scope — a session issued
   * for ticket A can never file findings against ticket B's request.
   */
  expectTicketId?: string;
  expectInstallationId?: string;
}): Promise<RecordRunResult> {
  if (!isSupportRunState(input.state)) return { ok: false, error: "invalid_state" };
  const request = await getDiagnosticRequest(input.businessId, input.requestId);
  if (!request) return { ok: false, error: "request_not_found" };
  if (input.expectTicketId && request.ticketId !== input.expectTicketId) {
    return { ok: false, error: "scope_mismatch" };
  }
  if (input.expectInstallationId && request.installationId !== input.expectInstallationId) {
    return { ok: false, error: "scope_mismatch" };
  }
  if (isTerminalRequestState(request.state)) return { ok: false, error: "request_not_running" };

  const summary = emptyRedactionSummary();
  const findings = (Array.isArray(input.findings) ? input.findings : [])
    .slice(0, FINDING_MAX)
    .map((finding) => redactValue(finding, summary));
  const coverage = redactValue(input.coverage ?? {}, summary);
  const collectorVersions = redactValue(input.collectorVersions ?? {}, summary);

  const { rows } = await query<RunRow>(
    `INSERT INTO support_diagnostic_runs
       (business_id, request_id, ticket_id, installation_id, state,
        collector_versions, coverage, findings, severity_overall, observed_at,
        upload_state, server_ack_at)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, 'received', now())
     RETURNING id::text AS id, business_id::text AS business_id, request_id::text AS request_id,
       ticket_id::text AS ticket_id, installation_id::text AS installation_id, state,
       collector_versions, coverage, findings, severity_overall, observed_at, received_at,
       upload_state, server_ack_at, created_at, updated_at`,
    [
      input.businessId,
      input.requestId,
      request.ticketId,
      request.installationId,
      input.state,
      JSON.stringify(collectorVersions),
      JSON.stringify(coverage),
      JSON.stringify(findings),
      input.severityOverall ?? "unknown",
      input.observedAt ?? null,
    ],
  );

  // The request mirrors the run's truthful outcome; terminal run states land
  // the request terminally too. This never resolves/closes the ticket itself.
  const landed: SupportRequestState =
    input.state === "completed"
      ? "completed"
      : input.state === "partial"
        ? "partial"
        : input.state === "failed"
          ? "failed"
          : input.state === "cancelled"
            ? "cancelled"
            : input.state === "declined"
              ? "declined"
              : "running";
  await transitionDiagnosticRequest(input.businessId, input.requestId, landed);

  return { ok: true, run: toRun(rows[0]), redaction: summary };
}

export async function listTicketDiagnosticRuns(
  businessId: string,
  ticketId: string,
): Promise<DiagnosticRun[]> {
  const { rows } = await query<RunRow>(
    `${RUN_SELECT} WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toRun);
}

export async function getDiagnosticRun(businessId: string, runId: string): Promise<DiagnosticRun | null> {
  const { rows } = await query<RunRow>(`${RUN_SELECT} WHERE id = $1::uuid AND business_id = $2`, [
    runId,
    businessId,
  ]);
  return rows[0] ? toRun(rows[0]) : null;
}

export type SupportRunStateName = SupportRunState;
