import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, query, withTenant, withTenantTransaction, withoutTenantScope } from "./db";
import { readDeploymentProfile } from "./deployment-mode";
import { deploymentRole } from "./deployment-role";

export const CLOUD_EXCEPTION_RELAY_INTERVAL_MS = 15_000;

export const CLOUD_EXCEPTION_KINDS = [
  "support.ticket.created",
  "support.message.created",
  "bug_report.created",
] as const;
export type CloudExceptionKind = (typeof CLOUD_EXCEPTION_KINDS)[number];

export async function enqueueCloudException(
  client: PoolClient,
  input: { businessId: string; kind: CloudExceptionKind; aggregateId: string; payload: Record<string, unknown> },
): Promise<void> {
  if (deploymentRole() !== "site") return;
  await client.query(
    `INSERT INTO cloud_exception_outbox (business_id,kind,aggregate_id,payload)
     VALUES ($1,$2,$3,$4)`,
    [input.businessId, input.kind, input.aggregateId, JSON.stringify(input.payload)],
  );
}

interface OutboxRow {
  event_id: string;
  kind: CloudExceptionKind;
  aggregate_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

function relayConfig(): { url: string; token: string; installationId: string } | null {
  const base = process.env.SUPPORT_CLOUD_URL?.trim().replace(/\/+$/, "");
  const token = process.env.SUPPORT_RELAY_TOKEN?.trim();
  const installationId = process.env.SUPPORT_INSTALLATION_ID?.trim();
  if (!base || !token || !installationId) return null;
  return { url: `${base}/api/cloud-exceptions/relay`, token, installationId };
}

/**
 * Claims and delivers a small tenant-scoped batch. The lease makes concurrent
 * status requests harmless; failure records only a classified code, never a
 * provider response or credential. Successful delivery is idempotent remotely.
 */
export async function deliverCloudExceptions(businessId: string): Promise<{ delivered: number; pending: number; configured: boolean }> {
  if (deploymentRole() !== "site") return { delivered: 0, pending: 0, configured: false };
  // Issue #974: Full Offline (`local`) installations strictly submit Support
  // tickets and Bug Reports online-only via explicit user action; any legacy
  // outbox rows remain marked unsent and are never auto-submitted in background.
  const deployment = await readDeploymentProfile(businessId);
  if (deployment.profile === "local" && deployment.source !== "inferred") {
    const pendingResult = await query<{ count: string }>(
      "SELECT count(*)::text count FROM cloud_exception_outbox WHERE business_id=$1",
      [businessId],
    );
    return {
      delivered: 0,
      pending: Number(pendingResult.rows[0]?.count ?? 0),
      configured: false,
    };
  }
  const config = relayConfig();
  const client = await getPool().connect();
  let rows: OutboxRow[] = [];
  try {
    await client.query("BEGIN");
    const claimed = await client.query<OutboxRow>(
      `WITH due AS (
         SELECT event_id FROM cloud_exception_outbox
          WHERE business_id=$1 AND next_attempt_at<=now()
            AND (lease_until IS NULL OR lease_until<now())
          ORDER BY occurred_at LIMIT 2 FOR UPDATE SKIP LOCKED
       )
       UPDATE cloud_exception_outbox o
          SET lease_until=now()+interval '30 seconds', attempt_count=attempt_count+1
         FROM due WHERE o.event_id=due.event_id
       RETURNING o.event_id::text,o.kind,o.aggregate_id::text,o.payload,o.occurred_at::text`,
      [businessId],
    );
    rows = claimed.rows;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let deliveredCount = 0;
  if (rows.length && config) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    let delivered = false;
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ installationId: config.installationId, events: rows.map((row) => ({
          eventId: row.event_id, kind: row.kind, aggregateId: row.aggregate_id,
          payload: row.payload, occurredAt: row.occurred_at,
        })) }),
        signal: controller.signal,
      });
      delivered = response.ok;
    } catch {
      delivered = false;
    } finally {
      clearTimeout(timeout);
    }
    const ids = rows.map((row) => row.event_id);
    if (delivered) {
      deliveredCount = rows.length;
      await query("DELETE FROM cloud_exception_outbox WHERE business_id=$1 AND event_id=ANY($2::uuid[])", [businessId, ids]);
    } else {
      await query(
        `UPDATE cloud_exception_outbox
            SET lease_until=NULL,
                next_attempt_at=now()+LEAST(interval '1 hour', interval '15 seconds' * power(2,LEAST(attempt_count,8))),
                last_error_code=$3
          WHERE business_id=$1 AND event_id=ANY($2::uuid[])`,
        [businessId, ids, config ? "relay_unreachable" : "relay_not_configured"],
      );
    }
  } else if (rows.length) {
    await query(
      `UPDATE cloud_exception_outbox SET lease_until=NULL,next_attempt_at=now()+interval '5 minutes',last_error_code='relay_not_configured'
        WHERE business_id=$1 AND event_id=ANY($2::uuid[])`,
      [businessId, rows.map((row) => row.event_id)],
    );
  }

  const pendingResult = await query<{ count: string }>(
    "SELECT count(*)::text count FROM cloud_exception_outbox WHERE business_id=$1",
    [businessId],
  );
  const pending = Number(pendingResult.rows[0]?.count ?? 0);
  return { delivered: deliveredCount, pending, configured: Boolean(config) };
}

/** Background delivery independent of an open dashboard/browser. */
export async function runCloudExceptionRelayTick(): Promise<number> {
  if (deploymentRole() !== "site") return 0;
  let delivered = await pullCloudExceptionResponses();
  const businesses = await withoutTenantScope("cloud-exception-relay-tick", () => query<{ business_id: string }>(
    `SELECT DISTINCT business_id FROM cloud_exception_outbox
      WHERE next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY business_id LIMIT 100`,
  ));
  for (const row of businesses.rows) {
    try {
      const result = await withTenant(row.business_id, async () => {
        const deployment = await readDeploymentProfile(row.business_id);
        if (deployment.profile === "local") {
          return { delivered: 0, pending: 0, configured: false };
        }
        return deliverCloudExceptions(row.business_id);
      });
      delivered += result.delivered;
    } catch {
      // One installation/business must never stop the remaining durable queue.
    }
  }
  return delivered;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function authenticateCloudExceptionInstallation(installationId: string, token: string): Promise<boolean> {
  const hash = tokenHash(token);
  const result = await withoutTenantScope("cloud-exception-relay", () => query<{ token_hash: string }>(
    "SELECT token_hash FROM cloud_exception_installations WHERE installation_id=$1 AND is_active",
    [installationId],
  ));
  const stored = result.rows[0]?.token_hash ?? "";
  const a = Buffer.from(hash);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Platform provisioning returns the bearer once; only its SHA-256 hash persists. */
export interface CloudExceptionResponse {
  responseId: string;
  ticketId: string;
  body: string;
  createdAt: string;
}

export async function queueCloudExceptionResponse(
  inboxId: string,
  adminId: string,
  body: string,
): Promise<{ id: string }> {
  const clean = body.trim();
  if (!clean || clean.length > 5000) throw new Error("invalid_response_body");
  return withoutTenantScope("cloud-exception-response", async () => {
    const source = await query<{ installation_id: string; aggregate_id: string; kind: string }>(
      "SELECT installation_id,aggregate_id::text,kind FROM cloud_exception_inbox WHERE id=$1",
      [inboxId],
    );
    const event = source.rows[0];
    if (!event) throw new Error("cloud_exception_not_found");
    if (!event.kind.startsWith("support.")) throw new Error("response_not_supported");
    const inserted = await query<{ id: string }>(
      `INSERT INTO cloud_exception_responses(installation_id,ticket_id,body,admin_id)
       VALUES($1,$2,$3,$4) RETURNING id::text`,
      [event.installation_id, event.aggregate_id, clean, adminId],
    );
    return inserted.rows[0];
  });
}

export async function pendingCloudExceptionResponses(installationId: string): Promise<CloudExceptionResponse[]> {
  return withoutTenantScope("cloud-exception-response-pull", async () => {
    const result = await query<{ responseId: string; ticketId: string; body: string; createdAt: string }>(
      `SELECT id::text AS "responseId",ticket_id::text AS "ticketId",body,created_at::text AS "createdAt"
         FROM cloud_exception_responses
        WHERE installation_id=$1 AND acknowledged_at IS NULL
        ORDER BY created_at,id LIMIT 50`,
      [installationId],
    );
    return result.rows;
  });
}

export async function acknowledgeCloudExceptionResponses(installationId: string, ids: string[]): Promise<void> {
  if (!ids.length || ids.length > 50) return;
  await withoutTenantScope("cloud-exception-response-ack", () => query(
    `UPDATE cloud_exception_responses SET acknowledged_at=COALESCE(acknowledged_at,now())
      WHERE installation_id=$1 AND id=ANY($2::uuid[])`,
    [installationId, ids],
  ));
}

/** Pulls and atomically materialises operator replies into Local Support threads. */
export async function pullCloudExceptionResponses(): Promise<number> {
  if (deploymentRole() !== "site") return 0;
  const config = relayConfig();
  if (!config) return 0;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let responses: CloudExceptionResponse[] = [];
  try {
    const response = await fetch(config.url, {
      headers: { authorization: `Bearer ${config.token}`, "x-installation-id": config.installationId },
      signal: controller.signal,
    });
    if (!response.ok) return 0;
    const body = await response.json() as { responses?: unknown };
    if (!Array.isArray(body.responses) || body.responses.length > 50) return 0;
    responses = body.responses.filter((entry): entry is CloudExceptionResponse => {
      const item = entry as Partial<CloudExceptionResponse>;
      return typeof item.responseId === "string" && typeof item.ticketId === "string" &&
        typeof item.body === "string" && item.body.length > 0 && item.body.length <= 5000 &&
        typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt));
    });
  } catch {
    return 0;
  } finally {
    clearTimeout(timeout);
  }

  const applied: string[] = [];
  for (const response of responses) {
    const owner = await withoutTenantScope("cloud-exception-response-owner", () => query<{ business_id: string }>(
      "SELECT business_id::text FROM support_tickets WHERE id=$1",
      [response.ticketId],
    ));
    const businessId = owner.rows[0]?.business_id;
    if (!businessId) continue;
    await withTenantTransaction(businessId, async () => {
      const receipt = await query(
        `INSERT INTO cloud_exception_response_receipts(response_id,business_id,ticket_id)
         VALUES($1,$2,$3) ON CONFLICT(response_id) DO NOTHING RETURNING response_id`,
        [response.responseId, businessId, response.ticketId],
      );
      if (receipt.rowCount === 1) {
        await query(
          `INSERT INTO support_ticket_messages(ticket_id,business_id,author_type,body,created_at)
           VALUES($1,$2,'admin',$3,$4)`,
          [response.ticketId, businessId, response.body, response.createdAt],
        );
        await query(
          "UPDATE support_tickets SET status='waiting_customer',updated_at=GREATEST(updated_at,$2::timestamptz) WHERE id=$1",
          [response.ticketId, response.createdAt],
        );
      }
      applied.push(response.responseId);
    });
  }
  if (applied.length) {
    await fetch(config.url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ installationId: config.installationId, responseIds: applied }),
    }).catch(() => undefined);
  }
  return applied.length;
}

/** Platform provisioning returns the bearer once; only its SHA-256 hash persists. */
export async function provisionCloudExceptionInstallation(label: string): Promise<{ installationId: string; token: string }> {
  const installationId = randomUUID();
  const token = `SUP1-${randomBytes(32).toString("base64url")}`;
  await query(
    "INSERT INTO cloud_exception_installations (installation_id,label,token_hash) VALUES ($1,$2,$3)",
    [installationId, label.trim().slice(0, 200), tokenHash(token)],
  );
  return { installationId, token };
}

export async function acceptCloudExceptionBatch(input: {
  installationId: string;
  events: Array<{ eventId: string; kind: CloudExceptionKind; aggregateId: string; payload: Record<string, unknown>; occurredAt: string }>;
}): Promise<void> {
  await withoutTenantScope("cloud-exception-relay", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const event of input.events) {
        await client.query(
          `INSERT INTO cloud_exception_inbox (installation_id,event_id,kind,aggregate_id,payload,occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (installation_id,event_id) DO NOTHING`,
          [input.installationId, event.eventId, event.kind, event.aggregateId, JSON.stringify(event.payload), event.occurredAt],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
