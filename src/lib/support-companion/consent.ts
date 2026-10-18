/**
 * Issue #984 — the durable customer consent / Stop journal.
 *
 * The customer approves or denies requested collection and remote access per
 * subject, sees permitted reports, and stops access — without those controls
 * ever granting diagnostic execution privileges. Every decision is an
 * append-only event; the live answer is always the latest event for the
 * (installation, subject) pair, and anything but a live `granted` fails
 * closed. The remote operator can never self-approve customer consent.
 */
import { query } from "../db";
import {
  isSupportConsentSubject,
  type SupportConsentDecision,
  type SupportConsentSubject,
} from "./types";

export interface ConsentEvent {
  id: string;
  businessId: string;
  ticketId: string;
  installationId: string;
  subject: SupportConsentSubject;
  decision: SupportConsentDecision;
  grantedBy: "customer" | "operator" | "system";
  scope: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
}

interface ConsentRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  ticket_id: string;
  installation_id: string;
  subject: SupportConsentSubject;
  decision: SupportConsentDecision;
  granted_by: "customer" | "operator" | "system";
  scope: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
}

function toEvent(row: ConsentRow): ConsentEvent {
  return {
    id: row.id,
    businessId: row.business_id,
    ticketId: row.ticket_id,
    installationId: row.installation_id,
    subject: row.subject,
    decision: row.decision,
    grantedBy: row.granted_by,
    scope: row.scope ?? {},
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export type RecordConsentResult =
  | { ok: true; event: ConsentEvent }
  | { ok: false; error: "ticket_not_found" | "installation_not_found" | "invalid_subject" | "invalid_decision" };

export async function recordConsentEvent(input: {
  businessId: string;
  ticketId: string;
  installationId: string;
  subject: string;
  decision: string;
  grantedBy?: "customer" | "operator" | "system";
  scope?: Record<string, unknown>;
  expiresInMinutes?: number | null;
}): Promise<RecordConsentResult> {
  if (!isSupportConsentSubject(input.subject)) return { ok: false, error: "invalid_subject" };
  if (!["granted", "denied", "revoked", "expired"].includes(input.decision)) {
    return { ok: false, error: "invalid_decision" };
  }
  const { rows: tickets } = await query<{ business_id: string }>(
    `SELECT business_id::text AS business_id FROM support_tickets WHERE id = $1::uuid`,
    [input.ticketId],
  );
  if (!tickets[0] || tickets[0].business_id !== input.businessId) {
    return { ok: false, error: "ticket_not_found" };
  }
  const { rows: installations } = await query<{ id: string }>(
    `SELECT id FROM support_installations WHERE id = $1::uuid AND business_id = $2`,
    [input.installationId, input.businessId],
  );
  if (!installations[0]) return { ok: false, error: "installation_not_found" };

  // Customer consent is granted by the customer (or expires by the system).
  // An operator recording `granted` on the customer's behalf is refused —
  // consent cannot be self-approved by the remote operator.
  const grantedBy = input.grantedBy ?? "customer";
  if (grantedBy === "operator" && input.decision === "granted") {
    return { ok: false, error: "invalid_decision" };
  }

  const { rows } = await query<ConsentRow>(
    `INSERT INTO support_consent_events
       (business_id, ticket_id, installation_id, subject, decision, granted_by, scope, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7,
             CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(mins => $8) END)
     RETURNING id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
       installation_id::text AS installation_id, subject, decision, granted_by, scope,
       expires_at, created_at`,
    [
      input.businessId,
      input.ticketId,
      input.installationId,
      input.subject,
      input.decision,
      grantedBy,
      JSON.stringify(input.scope ?? {}),
      input.expiresInMinutes ?? null,
    ],
  );
  return { ok: true, event: toEvent(rows[0]) };
}

/** The latest decision for an (installation, subject) pair, if any. */
export async function latestConsent(
  businessId: string,
  installationId: string,
  subject: SupportConsentSubject,
): Promise<ConsentEvent | null> {
  const { rows } = await query<ConsentRow>(
    `SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
            installation_id::text AS installation_id, subject, decision, granted_by, scope,
            expires_at, created_at
       FROM support_consent_events
      WHERE business_id = $1 AND installation_id = $2::uuid AND subject = $3
      ORDER BY created_at DESC LIMIT 1`,
    [businessId, installationId, subject],
  );
  return rows[0] ? toEvent(rows[0]) : null;
}

/**
 * Whether work under `subject` may proceed right now: the latest decision
 * must be a live (unexpired) `granted`. Anything else — denied, revoked,
 * expired, or never asked — fails closed.
 */
export async function consentAllows(
  businessId: string,
  installationId: string,
  subject: SupportConsentSubject,
): Promise<boolean> {
  const latest = await latestConsent(businessId, installationId, subject);
  if (!latest || latest.decision !== "granted") return false;
  if (latest.expiresAt && new Date(latest.expiresAt).getTime() <= Date.now()) return false;
  return true;
}

export async function listTicketConsentEvents(
  businessId: string,
  ticketId: string,
): Promise<ConsentEvent[]> {
  const { rows } = await query<ConsentRow>(
    `SELECT id::text AS id, business_id::text AS business_id, ticket_id::text AS ticket_id,
            installation_id::text AS installation_id, subject, decision, granted_by, scope,
            expires_at, created_at
       FROM support_consent_events
      WHERE business_id = $1 AND ticket_id = $2::uuid ORDER BY created_at DESC`,
    [businessId, ticketId],
  );
  return rows.map(toEvent);
}
