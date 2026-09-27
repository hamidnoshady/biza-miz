import { query, withoutTenantScope, withTenant } from "../../db";
import { decryptSecret, resolveEncryptionKey } from "../../integrations/secrets";
import { resolvePlatformCmsConfig } from "../../cms/platform-control-service";
import { signBillingBody, BILLING_KEY_HEADER, BILLING_SIGNATURE_HEADER, BILLING_TIMESTAMP_HEADER } from "../auth/sign";
import { parseEntitlementPush, type EntitlementPayloadV1 } from "../contract/v1";
import { buildCmsEntitlementPayload } from "./cms-payload";
import { billingLog } from "../observability";
import { assertPublicHttpsUrl } from "../../ssrf";

const MAX_ATTEMPTS = 8;
const LEASE_MS = 10 * 60 * 1000;

function backoffMs(attempts: number): number {
  const base = Math.min(60 * 60 * 1000, 1000 * 2 ** attempts);
  return base + Math.floor(Math.random() * 1000);
}

async function readOutboundCredential(): Promise<{ keyId: string; secret: string; baseUrl: string } | null> {
  const config = await resolvePlatformCmsConfig();
  if (!config?.baseUrl) return null;
  const { rows } = await withoutTenantScope("cms-entitlement-credential", () =>
    query<{ billing_entitlement_key_id: string; billing_entitlement_secret_ciphertext: string | null }>(
      `SELECT billing_entitlement_key_id, billing_entitlement_secret_ciphertext
         FROM platform_cms_config WHERE id = true`,
    ),
  );
  const row = rows[0];
  if (!row?.billing_entitlement_key_id || !row.billing_entitlement_secret_ciphertext) return null;
  try {
    const secret = decryptSecret(row.billing_entitlement_secret_ciphertext, resolveEncryptionKey(process.env));
    return { baseUrl: config.baseUrl.replace(/\/+$/, ""), keyId: row.billing_entitlement_key_id, secret };
  } catch {
    return null;
  }
}

export async function enqueueCmsEntitlementDelivery(businessId: string, siteId: string): Promise<number> {
  return withoutTenantScope("cms-entitlement-enqueue", async () => {
    const { rows: current } = await query<{ version: string }>(
      `SELECT version FROM cms_entitlement_projections WHERE site_id = $1`,
      [siteId],
    );
    const nextVersion = Number(current[0]?.version ?? 0) + 1;
    const payload = await withTenant(businessId, () =>
      buildCmsEntitlementPayload({ businessId, siteId, version: nextVersion }),
    );

    await query(
      `INSERT INTO cms_entitlement_projections (site_id, business_id, version, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (site_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             business_id = EXCLUDED.business_id,
             version = EXCLUDED.version,
             synced_at = now()`,
      [siteId, businessId, nextVersion, JSON.stringify(payload)],
    );

    await query(
      `INSERT INTO cms_entitlement_outbox (site_id, business_id, version, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, $4::jsonb, 'pending', now())
       ON CONFLICT (site_id, version) DO NOTHING`,
      [siteId, businessId, nextVersion, JSON.stringify(payload)],
    );

    billingLog("billing.entitlement.enqueued", { businessId, siteId, version: nextVersion });
    return nextVersion;
  });
}

export async function refreshEntitlementsForBusiness(businessId: string): Promise<void> {
  await withoutTenantScope("cms-entitlement-refresh", async () => {
    const { rows } = await query<{ site_id: string }>(
      `SELECT site_id FROM eshobe_cms_connections WHERE business_id = $1 ORDER BY created_at DESC`,
      [businessId],
    );
    for (const row of rows) {
      await enqueueCmsEntitlementDelivery(businessId, row.site_id);
    }
  });
}

async function pushPayload(
  cred: { keyId: string; secret: string; baseUrl: string },
  payload: EntitlementPayloadV1,
): Promise<{ ok: true } | { ok: false; permanent: boolean; error: string }> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signBillingBody(cred.secret, timestamp, body);
  const url = `${cred.baseUrl}/api/platform/billing/entitlements/v1`;

  const target = await assertPublicHttpsUrl(url);
  if (!target.ok) {
    return { ok: false, permanent: true, error: `ssrf_blocked: ${target.reason}` };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BILLING_KEY_HEADER]: cred.keyId,
        [BILLING_TIMESTAMP_HEADER]: timestamp,
        [BILLING_SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 409) {
      return { ok: true };
    }
    if (response.ok) return { ok: true };
    const permanent = response.status === 400 || response.status === 404;
    const text = await response.text().catch(() => "");
    return { ok: false, permanent, error: text.slice(0, 500) || `http_${response.status}` };
  } catch (err) {
    return { ok: false, permanent: false, error: err instanceof Error ? err.message : "network_error" };
  }
}

export async function runCmsEntitlementOutboxTick(limit = 20): Promise<number> {
  const cred = await readOutboundCredential();
  if (!cred) return 0;

  const claimed = await withoutTenantScope("cms-entitlement-drain", async () => {
    const { rows } = await query<{ id: string; site_id: string; business_id: string; version: string; payload: EntitlementPayloadV1; attempts: number }>(
      `UPDATE cms_entitlement_outbox
          SET status = 'sending', updated_at = now()
        WHERE id IN (
          SELECT id FROM cms_entitlement_outbox
           WHERE status IN ('pending', 'failed')
             AND next_attempt_at <= now()
           ORDER BY next_attempt_at, created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, site_id, business_id, version, payload, attempts`,
      [limit],
    );
    return rows;
  });

  let delivered = 0;
  for (const row of claimed) {
    const payload = row.payload;
    payload.version = Number(row.version);
    payload.siteId = row.site_id;
    const validated = parseEntitlementPush(payload);
    if ("error" in validated) {
      await withoutTenantScope("cms-entitlement-update", async () => {
        await query(
          `UPDATE cms_entitlement_outbox SET status = 'dead_letter', last_error = $2, updated_at = now() WHERE id = $1`,
          [row.id, validated.error],
        );
      });
      continue;
    }
    const result = await pushPayload(cred, validated.payload);
    await withoutTenantScope("cms-entitlement-update", async () => {
      if (result.ok) {
        await query(
          `UPDATE cms_entitlement_outbox
              SET status = 'sent', delivered_at = now(), last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        await query(
          `UPDATE cms_entitlement_projections
              SET last_delivered_version = $2, last_delivery_at = now()
            WHERE site_id = $1`,
          [row.site_id, row.version],
        );
        delivered += 1;
        return;
      }
      const attempts = row.attempts + 1;
      const dead = result.permanent || attempts >= MAX_ATTEMPTS;
      await query(
        `UPDATE cms_entitlement_outbox
            SET status = $2,
                attempts = $3,
                last_error = $4,
                next_attempt_at = now() + ($5::text || ' milliseconds')::interval,
                updated_at = now()
          WHERE id = $1`,
        [row.id, dead ? "dead_letter" : "failed", attempts, result.error, String(backoffMs(attempts))],
      );
    });
  }

  // Release stale sending rows (crashed worker).
  await withoutTenantScope("cms-entitlement-lease", () =>
    query(
      `UPDATE cms_entitlement_outbox
          SET status = 'pending', updated_at = now()
        WHERE status = 'sending'
          AND updated_at < now() - ($1::text || ' milliseconds')::interval`,
      [String(LEASE_MS)],
    ),
  );

  if (delivered > 0) billingLog("billing.entitlement.delivered", { count: delivered });
  return delivered;
}
