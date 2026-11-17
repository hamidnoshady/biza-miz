import type { PoolClient } from "pg";
import { query, withTenant } from "../db";
import { resolveEncryptionKey } from "../integrations/secrets";
import { CmsApiError, cmsRequest } from "./client";
import { cmsConfigFromRow, type CmsConnectionRow } from "./connections";
import { logCmsCall } from "./observability";
import { inPlatformScope } from "./platform-control-service";

type Fulfillment = "accepted" | "rejected" | "preparing" | "ready" | "served" | "cancelled";
type Delivery = {
  id: string;
  business_id: string;
  cms_connection_id: string;
  cms_order_id: string;
  site_id: string;
  state: Fulfillment | "counter_payment";
  payment_amount: string | null;
  payment_reference: string | null;
  lease_token: string;
  attempts: number;
};

const MAX_ATTEMPTS = 12;

export async function enqueueCafeKitchenState(client: PoolClient, orderId: string): Promise<void> {
  // The caller holds the parent order lock. Aggregate all non-voided lines,
  // so a single ready or served line cannot advance a multi-line order.
  await client.query("SELECT cms_record_cafe_kitchen_state($1)", [orderId]);
}

async function claimDue(limit: number): Promise<Delivery[]> {
  // A dead-lettered predecessor blocks later fulfillment until it is retried.
  // Payment has its own lifecycle and can proceed while fulfillment waits.
  return inPlatformScope(async () => {
    const { rows } = await query<Delivery>(
      `WITH due AS (
          SELECT event.id
            FROM cms_order_state_outbox event
            JOIN eshobe_cms_connections c ON c.id = event.cms_connection_id AND c.business_id = event.business_id
           WHERE event.delivered_at IS NULL AND event.dead_lettered_at IS NULL
             AND event.next_attempt_at <= now()
             AND (event.lease_until IS NULL OR event.lease_until <= now())
             AND c.status = 'active'
             AND (event.state = 'counter_payment' OR NOT EXISTS (
                 SELECT 1 FROM cms_order_state_outbox prior
                  WHERE prior.cms_connection_id = event.cms_connection_id
                    AND prior.cms_order_id = event.cms_order_id AND prior.version < event.version
                    AND prior.delivered_at IS NULL AND prior.state <> 'counter_payment'
             ))
           ORDER BY event.next_attempt_at, event.version
           LIMIT $1 FOR UPDATE OF event SKIP LOCKED
       )
       UPDATE cms_order_state_outbox event
          SET lease_until = now() + interval '60 seconds', lease_token = gen_random_uuid(),
              attempts = event.attempts + 1
         FROM due WHERE event.id = due.id
       RETURNING event.*`,
      [limit],
    );
    return rows;
  });
}

async function send(event: Delivery): Promise<{ error: string; permanent: boolean } | null> {
  const { rows } = await query<CmsConnectionRow>(
    `SELECT id, business_id, site_id, site_domain, base_url, key_name, api_key_ciphertext,
            status, created_at, updated_at
       FROM eshobe_cms_connections
      WHERE id = $1 AND business_id = $2 AND status = 'active'`,
    [event.cms_connection_id, event.business_id],
  );
  const connection = rows[0];
  if (!connection) return { error: "connection_unavailable", permanent: false };
  if (connection.site_id !== event.site_id) return { error: "connection_site_changed", permanent: true };

  let body;
  if (event.state === "counter_payment") {
    const amount = Number(event.payment_amount);
    if (!event.payment_reference || event.payment_amount === null || !Number.isSafeInteger(amount) || amount < 0) {
      return { error: "invalid_counter_settlement", permanent: true };
    }
    body = { kind: "counter_payment", accountingReference: event.payment_reference, amount };
  } else {
    body = { kind: "fulfillment", fulfillment: event.state };
  }

  const start = Date.now();
  const audit = { operation: "cafe_order_state", actor: "scheduled", siteId: event.site_id };
  try {
    const config = cmsConfigFromRow(connection, resolveEncryptionKey(process.env));
    const response = await cmsRequest<{ ok?: boolean; result?: string } | null>(config, {
      path: `/api/site/cafe-orders/${encodeURIComponent(event.cms_order_id)}/state`,
      method: "PATCH",
      body,
    });
    if (response?.ok !== true || (response.result !== "applied" && response.result !== "already_applied")) {
      logCmsCall({ ...audit, durationMs: Date.now() - start, outcome: "api_error" });
      return { error: "unexpected_cms_response", permanent: false };
    }
    logCmsCall({ ...audit, durationMs: Date.now() - start, outcome: "ok" });
    return null;
  } catch (error) {
    const status = error instanceof CmsApiError ? error.status : undefined;
    logCmsCall({ ...audit, durationMs: Date.now() - start, outcome: status ? "api_error" : "network_error", status });
    return {
      error: status ? `cms_http_${status}` : "cms_connection_failed",
      permanent: status !== undefined && status < 500 && ![408, 425, 429].includes(status),
    };
  }
}

async function deliver(event: Delivery): Promise<void> {
  await withTenant(event.business_id, async () => {
    const failure = await send(event);
    const dead = failure !== null && (failure.permanent || event.attempts >= MAX_ATTEMPTS);
    const backoffSeconds = Math.min(3600, 15 * 2 ** Math.min(event.attempts - 1, 8)) + Math.random() * 10;
    await query(
      `UPDATE cms_order_state_outbox
          SET delivered_at = CASE WHEN $3::text IS NULL THEN now() END,
              last_error = $3,
              dead_lettered_at = CASE WHEN $4::boolean THEN now() END,
              next_attempt_at = now() + $5 * interval '1 second',
              lease_until = NULL, lease_token = NULL
        WHERE id = $1 AND lease_token = $2`,
      [event.id, event.lease_token, failure?.error ?? null, dead, backoffSeconds],
    );
  });
}

export async function runCafeOrderStateDeliveryTick(): Promise<void> {
  const results = await Promise.allSettled((await claimDue(20)).map(deliver));
  if (results.some((result) => result.status === "rejected")) throw new Error("cms_delivery_batch_incomplete");
}

type DeliveryFailure = {
  id: string;
  cms_order_id: string;
  order_number: string | null;
  state: Delivery["state"];
  last_error: string | null;
};

export async function listCafeOrderDeliveryFailures(businessId: string): Promise<DeliveryFailure[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<DeliveryFailure>(
      `SELECT event.id, event.cms_order_id, o.order_number::text, event.state, event.last_error
         FROM cms_order_state_outbox event
         LEFT JOIN orders o ON o.id = event.pos_order_id
        WHERE event.business_id = $1 AND event.dead_lettered_at IS NOT NULL
        ORDER BY event.dead_lettered_at DESC
        LIMIT 50`,
      [businessId],
    );
    return rows;
  });
}

export async function retryCafeOrderDelivery(businessId: string, id: string): Promise<void> {
  await withTenant(businessId, async () => {
    await query(
      `UPDATE cms_order_state_outbox
          SET dead_lettered_at = NULL, attempts = 0, next_attempt_at = now()
        WHERE business_id = $1 AND id = $2 AND delivered_at IS NULL AND dead_lettered_at IS NOT NULL`,
      [businessId, id],
    );
  });
}
