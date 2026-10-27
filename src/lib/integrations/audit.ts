/**
 * Phase 23 (issue #118) — audit trail for every integration action.
 * DB-touching (not unit-tested directly, per repo convention).
 */
import { query } from "../db";
import { scrubUrls } from "./url-redact";

export interface IntegrationAuditInput {
  businessId: string;
  connectionId?: string | null;
  action: string;
  entityType?: string | null;
  remoteId?: string | null;
  localId?: string | null;
  payload?: unknown;
  error?: string | null;
}

/** Best-effort: an audit write must never fail the action it records. */
export async function writeIntegrationAudit(input: IntegrationAuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO integration_audit_log
         (business_id, connection_id, action, entity_type, remote_id, local_id, payload, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.businessId,
        input.connectionId ?? null,
        input.action,
        input.entityType ?? null,
        input.remoteId ?? null,
        input.localId ?? null,
        // A signed download URL must never reach the append-only trail, whether it
        // arrives as a field of the payload or inside a plugin's error text.
        input.payload === undefined ? null : scrubUrls(JSON.stringify(input.payload)),
        input.error == null ? null : scrubUrls(input.error),
      ],
    );
  } catch (err) {
    console.error("integration_audit_write_failed", { action: input.action, error: (err as Error).message });
  }
}

export interface IntegrationAuditRow {
  id: string;
  connectionId: string | null;
  action: string;
  entityType: string | null;
  remoteId: string | null;
  localId: string | null;
  error: string | null;
  createdAt: string;
}

/** Newest-first audit entries for a connection (or the whole business when null). */
export async function listIntegrationAudit(
  businessId: string,
  connectionId: string | null,
  limit = 50,
): Promise<IntegrationAuditRow[]> {
  const { rows } = await query<{ id: string; connection_id: string | null; action: string; entity_type: string | null; remote_id: string | null; local_id: string | null; error: string | null; created_at: string }>(
    `SELECT id, connection_id, action, entity_type, remote_id, local_id, error, created_at
       FROM integration_audit_log
      WHERE business_id = $1 AND ($2::uuid IS NULL OR connection_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [businessId, connectionId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    connectionId: r.connection_id,
    action: r.action,
    entityType: r.entity_type,
    remoteId: r.remote_id,
    localId: r.local_id,
    error: r.error,
    createdAt: r.created_at,
  }));
}
