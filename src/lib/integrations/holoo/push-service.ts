/**
 * Phase 26 (issue #125) Wave 8 — writing into Holoo.
 *
 * The loop closes here: a sale/receipt/purchase recorded in this app's till
 * appears in Holoo's own UI, so the customer's accountant keeps seeing
 * everything in Holoo. Documents are drained from `integration_outbox_events`
 * with the existing backoff/dead-letter policy, keyed idempotently on the
 * source document, and the returned Holoo document number is stored on the
 * mapping and surfaced on the invoice.
 *
 * `write_mode = 'web_service'` is preferred (Holoo validates, so the customer's
 * books cannot be corrupted). `write_mode = 'direct_sql'` is the guarded
 * fallback behind **all** of the rails in direct-sql.ts — pinned profile,
 * typed arming, mandatory dry-run — plus one MSSQL transaction per document
 * and a `holoo.write` audit row per executed statement.
 */
import { query, withoutTenantScope, withTenant } from "../../db";
import { getConnection } from "../connections-service";
import { getHolooSettingsRow, holooSqlConfigFor, holooWebServiceConfigFor, type HolooSettingsRow } from "./connection-service";
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "../retry";
import { armDirectSql, buildDirectSqlPreview, isPinnedProfile, type HolooDocument } from "./direct-sql";
import { connectHolooSql, connectHolooSqlWriter, createHolooWebServiceClient } from "./client";
import { diagnoseProfile, profileForKey } from "./schema-profile";
import { probeHolooSchema } from "./schema-probe";
import { writeIntegrationAudit } from "../audit";

export const HOLOO_PUSH_TICK_INTERVAL_MS = 60 * 1000;
export const HOLOO_PUSH_DRAIN_BATCH = 25;
const DRAIN_BATCH = HOLOO_PUSH_DRAIN_BATCH;

export type HolooOutboxKind = "holoo_sale" | "holoo_receipt" | "holoo_purchase";

interface DueEvent extends Record<string, unknown> {
  id: string;
  entity_type: HolooOutboxKind;
  local_id: string | null;
  payload: unknown;
  attempts: number;
}

/**
 * Push one connection's due outbox events.
 *
 * `web_service` documents go through the official API (preferred); `direct_sql`
 * documents are refused unless the probed profile is the pinned one and the
 * mode has been armed with the typed confirmation phrase — and then the exact
 * statements are rendered (dry-run) and executed one transaction per document,
 * with a `holoo.write` audit row per statement.
 */
export async function pushForConnection(businessId: string, connectionId: string): Promise<{ attempted: number; sent: number }> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) return { attempted: 0, sent: 0 };

  // Claim each batch atomically. Manual sends and the scheduled tick can race;
  // SELECT+UPDATE in separate pool queries could otherwise send one document
  // twice. Expired processing leases are reclaimable after a crashed worker.
  const { rows } = await query<DueEvent>(
    `WITH due AS (
       SELECT id
         FROM integration_outbox_events
        WHERE connection_id = $1
          AND (
            (status IN ('pending', 'failed') AND next_attempt_at <= now())
            OR (status = 'processing' AND (leased_until IS NULL OR leased_until <= now()))
          )
        ORDER BY next_attempt_at, created_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE integration_outbox_events AS event
        SET status = 'processing', leased_until = now() + interval '5 minutes', updated_at = now()
       FROM due
      WHERE event.id = due.id
     RETURNING event.id, event.entity_type, event.local_id, event.payload, event.attempts`,
    [connectionId, DRAIN_BATCH],
  );

  let pushed = 0;
  for (const event of rows) {
    try {
      const document = event.payload as HolooDocument & { sourceId: string };
      const holooDocumentNumber = await writeDocument(settings, event.entity_type, document);
      await query(
        `UPDATE integration_outbox_events SET status = 'sent', sent_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()
          WHERE id = $1`,
        [event.id],
      );
      if (event.local_id) {
        await query(
          `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id, last_pushed_payload)
           VALUES ($1, $2, 'holoo_document', $3, $4, $5)
           ON CONFLICT (connection_id, entity_type, remote_id)
           DO UPDATE SET last_pushed_payload = EXCLUDED.last_pushed_payload, updated_at = now()`,
          [businessId, connectionId, document.sourceId, event.local_id, JSON.stringify({ holooDocumentNumber })],
        );
      }
      pushed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      if (isDeadAfterAttempts(attempts, OUTBOX_MAX_ATTEMPTS)) {
        await query(
          `UPDATE integration_outbox_events SET status = 'dead', attempts = $2, last_error = $3, leased_until = NULL, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message],
        );
        await writeIntegrationAudit({
          businessId,
          connectionId,
          action: "outbox.dead_lettered",
          entityType: event.entity_type,
          error: (err as Error).message,
        });
      } else {
        const delay = backoffDelayMs(attempts);
        await query(
          `UPDATE integration_outbox_events
              SET status = 'failed', attempts = $2, last_error = $3, leased_until = NULL,
                  next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
            WHERE id = $1`,
          [event.id, attempts, (err as Error).message, delay],
        );
      }
    }
  }
  return { attempted: rows.length, sent: pushed };
}

/**
 * Manually drain the already-produced integration outbox from Data Transfer.
 * This deliberately creates no documents and has no second HTTP/SQL client;
 * it delegates to the same retry-safe push worker used by scheduled sync.
 */
export async function sendPendingHolooOutbox(businessId: string, connectionId: string): Promise<{
  attempted: number;
  sent: number;
  remainingDue: number;
  retryScheduled: number;
  inFlight: number;
  deadLettered: number;
}> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) throw new Error("holoo_connection_not_found");
  if (settings.write_mode !== "web_service") throw new Error("holoo_web_service_required");
  if (!settings.companion_activated_at) throw new Error("holoo_companion_not_active");
  if (!settings.web_service_base_url || !settings.ws_user_ciphertext || !settings.ws_password_ciphertext) {
    throw new Error("holoo_web_service_credentials_missing");
  }

  const drain = await pushForConnection(businessId, connectionId);
  const [{ rows: afterRows }, { rows: scheduledRows }, { rows: processingRows }, { rows: deadRows }] = await Promise.all([
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_outbox_events
        WHERE connection_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at <= now()`,
      [connectionId],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_outbox_events
        WHERE connection_id = $1 AND status IN ('pending', 'failed') AND next_attempt_at > now()`,
      [connectionId],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_outbox_events
        WHERE connection_id = $1 AND status = 'processing' AND leased_until > now()`,
      [connectionId],
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM integration_outbox_events
        WHERE connection_id = $1 AND status = 'dead'`,
      [connectionId],
    ),
  ]);
  return {
    attempted: drain.attempted,
    sent: drain.sent,
    remainingDue: Number(afterRows[0]?.count ?? 0),
    retryScheduled: Number(scheduledRows[0]?.count ?? 0),
    inFlight: Number(processingRows[0]?.count ?? 0),
    deadLettered: Number(deadRows[0]?.count ?? 0),
  };
}

/** Write one document through the configured mode; returns the Holoo doc number. */
async function writeDocument(settings: HolooSettingsRow, kind: HolooOutboxKind, document: HolooDocument & { sourceId: string }): Promise<string> {
  if (settings.write_mode === "web_service") {
    const client = createHolooWebServiceClient(holooWebServiceConfigFor(settings));
    try {
      const body = {
        sourceId: document.sourceId,
        values: document.values,
        ...(document.payload ?? {}),
      };
      const holooDocumentNumber =
        kind === "holoo_sale"
          ? await client.createSaleInvoice(body)
          : kind === "holoo_receipt"
            ? await client.createReceiptPayment(body)
            : await client.createPurchaseInvoice(body);
      await writeIntegrationAudit({
        businessId: settings.businessId,
        connectionId: settings.connectionId,
        action: "holoo.push_web_service",
        remoteId: document.sourceId,
        payload: { holooDocumentNumber, kind },
      });
      return holooDocumentNumber;
    } finally {
      await client.close();
    }
  }

  if (settings.write_mode === "direct_sql") {
    return writeDirectSql(settings, kind, document);
  }

  throw new Error("holoo_write_mode_none");
}

/**
 * The guarded direct-SQL path. Every rail is mandatory: pinned profile,
 * previously armed mode, and the dry-run preview rendered before execution.
 */
async function writeDirectSql(settings: HolooSettingsRow, kind: HolooOutboxKind, document: HolooDocument & { sourceId: string }): Promise<string> {
  const profile = settings.schema_profile ? profileForKey(settings.schema_profile) : null;
  // Unknown probed profile → refuse outright (a structure we have not
  // catalogued must never be written to).
  if (!profile) {
    throw new Error("holoo_direct_sql_unknown_profile");
  }
  if (!profile.capabilities.directSqlWrite) {
    throw new Error("holoo_direct_sql_profile_read_only");
  }
  // A stored key is not proof that the external database still has that
  // structure. Re-probe immediately before opening the write-capable client.
  const probeClient = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const current = diagnoseProfile(await probeHolooSchema(probeClient)).profile;
    if (!current || current.key !== profile.key) {
      throw new Error("holoo_direct_sql_schema_changed");
    }
  } finally {
    await probeClient.close();
  }
  // Armed only via the typed confirmation phrase (armDirectSqlFor below), and
  // the exact probed profile must still match the profile pinned at arming.
  if (!settings.direct_sql_armed_at) {
    throw new Error("holoo_direct_sql_not_armed");
  }
  if (!isPinnedProfile(settings.schema_profile, settings.direct_sql_profile_key)) {
    throw new Error("holoo_direct_sql_profile_not_pinned");
  }

  const tableFor = (docKind: HolooDocument["kind"]) =>
    docKind === "sale"
      ? profile.tables.invoices
      : docKind === "receipt"
        ? profile.tables.receipt_payment
        : profile.tables.purchases;
  const { statements } = buildDirectSqlPreview([document], tableFor);

  await writeIntegrationAudit({
    businessId: settings.businessId,
    connectionId: settings.connectionId,
    action: "holoo.write_dry_run",
    remoteId: document.sourceId,
    payload: { statements, kind },
  });

  const client = await connectHolooSqlWriter(holooSqlConfigFor(settings));
  try {
    await client.executeTransaction(statements);
  } finally {
    await client.close();
  }

  for (const statement of statements) {
    await writeIntegrationAudit({
      businessId: settings.businessId,
      connectionId: settings.connectionId,
      action: "holoo.write",
      remoteId: document.sourceId,
      payload: { statement, kind },
    });
  }
  return document.sourceId;
}

/** Arm direct-SQL writes with the typed confirmation phrase. */
export async function armDirectSqlFor(
  businessId: string,
  connectionId: string,
  confirmation: string,
  armedBy: string,
): Promise<{
  ok: true;
} | { ok: false; error: "confirmation_mismatch" | "not_found" | "unknown_profile" | "direct_sql_not_supported" | "schema_changed" }> {
  const settings = await getHolooSettingsRow(businessId, connectionId);
  if (!settings) return { ok: false, error: "not_found" };
  const profile = settings.schema_profile ? profileForKey(settings.schema_profile) : null;
  if (!profile) return { ok: false, error: "unknown_profile" };
  if (!profile.capabilities.directSqlWrite) return { ok: false, error: "direct_sql_not_supported" };

  // Pin only a live, exact structural match. A stale test result must never
  // arm SQL writes after the remote database has changed.
  const probeClient = await connectHolooSql(holooSqlConfigFor(settings));
  try {
    const current = diagnoseProfile(await probeHolooSchema(probeClient)).profile;
    if (!current || current.key !== profile.key) return { ok: false, error: "schema_changed" };
  } finally {
    await probeClient.close();
  }

  const result = armDirectSql(confirmation);
  if (!result.ok) return result;
  await query(
    `UPDATE holoo_connection_settings
        SET direct_sql_armed_at = now(), direct_sql_armed_by = $3,
            direct_sql_profile_key = schema_profile, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2`,
    [businessId, connectionId, armedBy],
  );
  await writeIntegrationAudit({ businessId, connectionId, action: "holoo.direct_sql_armed", payload: { profile: settings.schema_profile, profileVersion: profile.profileVersion } });
  return { ok: true };
}

export async function runHolooPushTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'holoo'`,
    ),
  );
  for (const { business_id, id } of rows) {
    await withTenant(business_id, async () => {
      try {
        const connection = await getConnection(business_id, id);
        if (!connection || connection.status !== "active") return;
        await pushForConnection(business_id, id);
      } catch (err) {
        console.error(`holoo push tick failed for connection ${id}:`, (err as Error).message);
      }
    });
  }
}
