/**
 * Shared #1118 entry-point, first-contact, webhook-deferral, and outbound
 * publication guards across Data Transfer, Holoo, WooCommerce, and WordPress.
 */

import { query, withTenantTransaction } from "../db";
import { remoteEditFingerprint } from "./field-authority";
import { canPublishOutbound } from "./lifecycle";
import { isRemoteEditSuppressed } from "./service";
import type { ReconciliationDomain, ReconciliationRunStatus } from "./types";

function canonicalFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = (typeof value === "string" ? value : String(value)).trim();
  if (!raw) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const [intPart, decPart] = raw.split(".");
    const cleanDec = decPart ? decPart.replace(/0+$/, "") : "";
    return cleanDec ? `${intPart}.${cleanDec}` : intPart;
  }
  return raw;
}

export interface ActiveRunRef {
  id: string;
  domain: ReconciliationDomain;
  status: ReconciliationRunStatus;
}

/**
 * Any non-terminal reconciliation run on a connection+domain blocks blind
 * mutations and defers overlapping inbound webhooks until reviewed.
 */
export async function findActiveRunForConnection(
  businessId: string,
  connectionId: string,
  domain?: ReconciliationDomain,
): Promise<ActiveRunRef | null> {
  const params: unknown[] = [businessId, connectionId];
  const domainClause = domain ? `AND domain = $3` : "";
  if (domain) params.push(domain);
  const { rows } = await query<{ id: string; domain: ReconciliationDomain; status: ReconciliationRunStatus }>(
    `SELECT id::text AS id, domain, status
       FROM import_reconciliation_runs
      WHERE business_id = $1
        AND connection_id::text = $2
        ${domainClause}
        AND status IN ('discovering', 'staged', 'in_review', 'applying', 'partially_applied', 'stale')
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Checks whether canonical rows already exist in the tenant for a given domain.
 */
export async function hasCanonicalOverlapForDomain(
  businessId: string,
  domain: ReconciliationDomain,
  locationId?: string | null,
): Promise<boolean> {
  if (domain === "product") {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM items i
            JOIN locations l ON l.id = i.location_id
           WHERE l.business_id = $1
             AND ($2::uuid IS NULL OR i.location_id = $2::uuid)
         )
         OR EXISTS (
           SELECT 1 FROM menu_items m
            JOIN locations l ON l.id = m.location_id
           WHERE l.business_id = $1
             AND ($2::uuid IS NULL OR m.location_id = $2::uuid)
         )
       ) AS exists`,
      [businessId, locationId ?? null],
    );
    return rows[0]?.exists === true;
  }
  if (domain === "party") {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM parties
          WHERE business_id = $1 AND merged_into_id IS NULL
       ) AS exists`,
      [businessId],
    );
    return rows[0]?.exists === true;
  }
  if (domain === "inventory") {
    const { rows } = await query<{ exists: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM item_stock s
            JOIN items i ON i.id = s.item_id
            JOIN locations l ON l.id = i.location_id
           WHERE l.business_id = $1 AND s.quantity <> 0
         )
         OR EXISTS (
           SELECT 1 FROM stock_movements sm
            JOIN locations l ON l.id = sm.location_id
           WHERE l.business_id = $1
         )
       ) AS exists`,
      [businessId],
    );
    return rows[0]?.exists === true;
  }
  const { rows } = await query<{ exists: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM orders o
          JOIN locations l ON l.id = o.location_id
         WHERE l.business_id = $1
       )
       OR EXISTS (
         SELECT 1 FROM journal_entries WHERE business_id = $1
       )
     ) AS exists`,
    [businessId],
  );
  return rows[0]?.exists === true;
}

export async function hasCanonicalOverlapForImportEntity(
  businessId: string,
  entityKey: string,
  locationId?: string | null,
): Promise<boolean> {
  if (entityKey === "inventory.items") {
    const { rows: bizRows } = await query<{ industry: string }>(
      `SELECT industry FROM businesses WHERE id = $1`,
      [businessId],
    );
    if (bizRows[0]?.industry === "food_service") {
      const { rows } = await query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM inventory_items ii
            JOIN locations l ON l.id = ii.location_id
           WHERE l.business_id = $1
             AND ($2::uuid IS NULL OR ii.location_id = $2::uuid)
         ) AS exists`,
        [businessId, locationId ?? null],
      );
      return rows[0]?.exists === true;
    }
    return hasCanonicalOverlapForDomain(businessId, "product", locationId);
  }
  if (entityKey === "pos.products") {
    return hasCanonicalOverlapForDomain(businessId, "product", locationId);
  }
  if (entityKey === "crm.customers" || entityKey === "crm.companies") {
    return hasCanonicalOverlapForDomain(businessId, "party", locationId);
  }
  return false;
}

/**
 * Checks whether a product/customer/order webhook topic should be deferred
 * because an active reconciliation run is open for that connection & domain.
 */
export function webhookTopicDomain(topic: string): ReconciliationDomain | null {
  if (/^product\.|^catalogue\./.test(topic)) return "product";
  if (/^customer\./.test(topic)) return "party";
  if (/^order\.|^refund\./.test(topic)) return "financial_document";
  return null;
}

export async function shouldDeferWebhookForReconciliation(
  businessId: string,
  connectionId: string,
  topic: string,
): Promise<boolean> {
  const domain = webhookTopicDomain(topic);
  if (!domain) return false;
  return (await findActiveRunForConnection(businessId, connectionId, domain)) !== null;
}

/**
 * Lists all rejected/canonical-locked remote edit fingerprints for a connection so
 * outbox refresh can suppress re-proposing/re-pushing values in a single query.
 */
export async function listSuppressedRemoteEditsForConnection(
  businessId: string,
  connectionId: string,
): Promise<Set<string>> {
  const { rows } = await query<{
    external_id: string;
    field: string;
    fingerprint: string;
  }>(
    `SELECT DISTINCT re.external_id, re.field, re.fingerprint
       FROM import_reconciliation_rejected_edits re
      WHERE re.business_id = $1
        AND re.domain = 'product'
        AND (
          re.source_key IN ($2, 'woo:' || $2, 'woocommerce:' || $2)
          OR EXISTS (
            SELECT 1 FROM import_reconciliation_runs r
             WHERE r.business_id = re.business_id
               AND r.connection_id::text = $2
               AND r.source_key = re.source_key
          )
        )`,
    [businessId, connectionId],
  );
  const suppressed = new Set<string>();
  for (const row of rows) {
    suppressed.add(`${row.external_id}\0${row.fingerprint}`);
    const eqIdx = row.fingerprint.indexOf("=");
    if (eqIdx !== -1) {
      const rawVal = row.fingerprint.slice(eqIdx + 1);
      const norm = canonicalFieldValue(rawVal);
      if (norm) suppressed.add(`${row.external_id}\0${row.field}\0${norm}`);
    }
  }
  return suppressed;
}

export function isOutboxFieldSuppressed(
  suppressedSet: ReadonlySet<string>,
  remoteId: string,
  field: "stock_quantity" | "regular_price",
  value: unknown,
): boolean {
  if (suppressedSet.size === 0) return false;
  if (suppressedSet.has(`${remoteId}\0${remoteEditFingerprint(field, value)}`)) return true;
  const aliasField = field === "regular_price" ? "price" : "stock";
  if (suppressedSet.has(`${remoteId}\0${remoteEditFingerprint(aliasField, value)}`)) return true;
  const norm = canonicalFieldValue(value);
  if (!norm) return false;
  if (suppressedSet.has(`${remoteId}\0${field}\0${norm}`)) return true;
  if (suppressedSet.has(`${remoteId}\0${aliasField}\0${norm}`)) return true;
  return false;
}

export async function canPublishConnectionOutbound(
  businessId: string,
  connection: { id: string; source_of_truth?: string | null },
): Promise<{ allowed: boolean; reason?: string }> {
  if (connection.source_of_truth === "store") {
    return { allowed: false, reason: "source_of_truth_store" };
  }
  const activeRun = await findActiveRunForConnection(businessId, connection.id, "product");
  if (activeRun) {
    return { allowed: false, reason: "reconciliation_active" };
  }
  return { allowed: true };
}

/**
 * Checks if a specific mapped product is safe to queue for manual outbound push.
 */
export async function checkManualProductOutboundGuard(
  businessId: string,
  connection: { id: string; source_of_truth?: string | null },
  remoteId: string,
  patch: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const connGate = await canPublishConnectionOutbound(businessId, connection);
  if (!connGate.allowed) {
    return { ok: false, reason: connGate.reason ?? "outbound_blocked" };
  }
  // Check any latest run item for this remoteId to honour `canPublishOutbound`
  const { rows: itemRows } = await query<{
    run_status: ReconciliationRunStatus;
    item_status: string;
    canonical_id: string | null;
    cutover_authority: string | null;
    ownership_confirmed: boolean;
  }>(
    `SELECT r.status AS run_status,
            i.status AS item_status,
            COALESCE(i.resolved_canonical_id, i.canonical_id)::text AS canonical_id,
            r.cutover_authority,
            (r.cutover_authority IS NOT NULL OR COALESCE((r.policy_snapshot->>'ownershipConfirmed')::boolean, false)) AS ownership_confirmed
       FROM import_reconciliation_items i
       JOIN import_reconciliation_runs r ON r.id = i.run_id
      WHERE i.business_id = $1 AND r.business_id = $1 AND r.connection_id::text = $2
        AND r.domain = 'product' AND i.external_key = $3
      ORDER BY r.created_at DESC, i.id DESC
      LIMIT 1`,
    [businessId, connection.id, remoteId],
  );
  const latest = itemRows[0];
  if (latest && latest.run_status !== "cancelled" && latest.run_status !== "applied") {
    const allowed = canPublishOutbound({
      mappingCommitted: Boolean(latest.canonical_id),
      ownershipConfirmed: latest.ownership_confirmed,
      itemStatus: latest.item_status as never,
      runStatus: latest.run_status,
    });
    if (!allowed) return { ok: false, reason: "reconciliation_unapplied" };
  }
  const suppressedSet = await listSuppressedRemoteEditsForConnection(businessId, connection.id);
  for (const field of ["regular_price", "stock_quantity"] as const) {
    if (field in patch) {
      if (isOutboxFieldSuppressed(suppressedSet, remoteId, field, patch[field])) {
        return { ok: false, reason: "rejected_edit_suppressed" };
      }
      const suppressedDirect = await isRemoteEditSuppressed(
        businessId,
        connection.id,
        "product",
        "product",
        remoteId,
        field,
        patch[field],
      );
      if (suppressedDirect) return { ok: false, reason: "rejected_edit_suppressed" };
    }
  }
  return { ok: true };
}

/**
 * Ensures first-contact WooCommerce plugin connections on businesses with
 * existing canonical data open a staged reconciliation gate rather than blind
 * unreviewed imports.
 */
export async function ensureFirstContactReconciliationGate(
  businessId: string,
  connectionId: string,
  locationId: string | null,
): Promise<{ gatedDomains: ReconciliationDomain[] }> {
  const gatedDomains: ReconciliationDomain[] = [];
  for (const domain of ["product", "party"] as const) {
    const overlap = await hasCanonicalOverlapForDomain(businessId, domain, locationId);
    if (!overlap) continue;
    const { rows: existing } = await query<{ id: string }>(
      `SELECT id::text AS id FROM import_reconciliation_runs
        WHERE business_id = $1 AND connection_id = $2::uuid AND domain = $3
          AND status IN ('staged', 'in_review', 'applying', 'partially_applied', 'applied')
        LIMIT 1`,
      [businessId, connectionId, domain],
    );
    if (existing.length > 0) {
      const active = await findActiveRunForConnection(businessId, connectionId, domain);
      if (active) gatedDomains.push(domain);
      continue;
    }
    await withTenantTransaction(businessId, async (client) => {
      await client.query(
        `INSERT INTO import_reconciliation_runs
           (business_id, location_id, domain, source_kind, provider, source_key, connection_id,
            import_mode, status, source_fingerprint, policy_version, scope, cursor, evidence,
            created_by_name)
         VALUES ($1, $2, $3, 'provider', 'woocommerce', $4, $5::uuid,
                 'live_link', 'staged', $6, 1, '{}'::jsonb, '{}'::jsonb, $7::jsonb, 'سامانه')
         ON CONFLICT DO NOTHING`,
        [
          businessId,
          locationId,
          domain,
          connectionId,
          connectionId,
          `first_contact:${connectionId}:${domain}`,
          JSON.stringify({ firstContact: true, reason: "canonical_overlap" }),
        ],
      );
    });
    gatedDomains.push(domain);
  }
  return { gatedDomains };
}
