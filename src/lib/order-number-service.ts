/**
 * The single order-number allocator (migration 0318).
 *
 * ## The one authority
 *
 * A location's numbers come from one place: `order_number_sequence`, owned by
 * the cloud (or by a Local install, which has no peer to share them with). A
 * paired till never advances that sequence itself. It leases a block
 * (`order_number_lease`), stores it in its own database, and mints inside the
 * block. Minting is a local UPDATE, so selling does not need the cloud at all;
 * only the next block does, and it is fetched before the current one runs out.
 *
 * ## Why the receiving side may trust a number
 *
 * A block belongs to one site device, and the cloud's sequence never hands any
 * part of it to anyone else. So an order the till pushes can be stored under
 * the same number its receipt already shows. `applyOrderState` /
 * `createOrder` therefore insert the sender's number verbatim; they no longer
 * renumber a pulled bill, and a genuine collision is a dead letter and an
 * alert instead of a silent rewrite.
 *
 * ## Cloud-created and website orders
 *
 * CMS, WordPress/WooCommerce, imported sales, retail invoices and orders rung
 * up in the cloud all call `allocateOrderNumber`, so they draw from the very
 * same sequence the leases come out of. No second counter exists.
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * contract lives in `order-number-lease.ts` and the database behaviour is
 * covered by `integration/order-number-lease.integration.test.ts`.
 */
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { deploymentRole } from "./deployment-role";
import { resolveDeploymentProfile } from "./deployment-mode";
import { getSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import {
  ORDER_NUMBER_BLOCK_SIZE,
  ORDER_NUMBER_LEASE_RETRY_MS,
  isOrderNumberValue,
  leaseNeedsRenewal,
  leaseStartFor,
  parseOrderNumberLeaseGrant,
  type OrderNumberLeaseGrant,
} from "./order-number-lease";

/**
 * This side has no number to hand out. On a paired till that means the cloud
 * could not be reached before the current block ran out: the sale is refused
 * rather than written under a number somebody else may already own.
 */
export class OrderNumberLeaseExhausted extends Error {
  constructor(message = "order_number_lease_exhausted") {
    super(message);
    this.name = "OrderNumberLeaseExhausted";
  }
}

export type OrderNumberSource = "sequence" | "lease";

export interface OrderNumberLeaseStatus {
  source: OrderNumberSource;
  /** Numbers the active lease can still hand out, or null when this side owns the sequence. */
  remaining: number | null;
  renewed: boolean;
  error: string | null;
}

/**
 * Which authority issues this business's numbers on this database.
 *
 * `hybrid` is the only profile that leases: it is the one with a cloud peer
 * that also creates orders for the branch. `local` and `cloud` both own their
 * sequence, so they are the same code path here.
 */
export async function resolveOrderNumberSource(
  client: PoolClient,
  businessId: string,
): Promise<OrderNumberSource> {
  // A central process owns the sequence; it can never lease from itself. This
  // is also the hot path for cloud/website orders, so skip the settings read.
  if (deploymentRole() !== "site") return "sequence";
  const { rows } = await client.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = ANY($2::text[])`,
    [businessId, [SETTING_KEYS.deploymentProfile, SETTING_KEYS.deploymentMode]],
  );
  // The same compatibility order as readDeploymentProfile(): the new key wins,
  // the pre-0172 `deployment.mode` is read only when it is absent.
  const stored =
    rows.find((row) => row.key === SETTING_KEYS.deploymentProfile)?.value ??
    rows.find((row) => row.key === SETTING_KEYS.deploymentMode)?.value ??
    null;
  const profile = resolveDeploymentProfile(stored, deploymentRole()).profile;
  return profile === "hybrid" ? "lease" : "sequence";
}

/**
 * Mint one number from this database's own sequence.
 *
 * The sequence row is created lazily and is self-healing: its first value is
 * one above the highest number the location already has, so a location whose
 * history predates this migration (or a test that inserted orders directly)
 * can never be handed a number that is already in use. The `ON CONFLICT`
 * branch does the same check on every later call, which is what turns a
 * manually inserted order into a skip instead of a unique-violation.
 */
export async function allocateSequenceOrderNumber(
  client: PoolClient,
  locationId: string,
): Promise<number> {
  const { rows } = await client.query<{ number: string }>(
    `INSERT INTO order_number_sequence AS s (location_id, next_number, updated_at)
     SELECT $1,
            greatest(
              coalesce((SELECT max(o.order_number) FROM orders o WHERE o.location_id = $1), 0) + 1,
              1
            ) + 1,
            now()
     ON CONFLICT (location_id) DO UPDATE
        SET next_number = greatest(
              s.next_number,
              coalesce((SELECT max(o.order_number) FROM orders o WHERE o.location_id = $1), 0) + 1
            ) + 1,
            updated_at = now()
     RETURNING (next_number - 1)::text AS number`,
    [locationId],
  );
  const minted = Number(rows[0]?.number);
  if (!isOrderNumberValue(minted)) throw new Error("invalid_order_number_sequence");
  return minted;
}

/** The active site device for a location, as this install knows it. */
async function siteDeviceIdForLocation(
  client: PoolClient,
  locationId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM site_devices
      WHERE location_id = $1 AND status = 'active' AND revoked_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [locationId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Mint one number from this device's active lease, oldest block first so an
 * ordinary renewal (new block fetched at the low watermark, old one still
 * holding its last numbers) stays in ascending order.
 */
export async function mintLeasedOrderNumber(
  client: PoolClient,
  params: { locationId: string; siteDeviceId?: string | null },
): Promise<number> {
  const siteDeviceId =
    params.siteDeviceId ?? (await siteDeviceIdForLocation(client, params.locationId));
  if (!siteDeviceId) throw new OrderNumberLeaseExhausted("order_number_lease_not_paired");

  const { rows } = await client.query<{ number: string }>(
    `WITH picked AS (
       SELECT id FROM order_number_lease
        WHERE location_id = $1 AND site_device_id = $2
          AND consumed_at IS NULL AND next_number <= to_number
        ORDER BY from_number
        LIMIT 1
        FOR UPDATE
     )
     UPDATE order_number_lease leased
        SET next_number = leased.next_number + 1,
            consumed_at = CASE
              WHEN leased.next_number + 1 > leased.to_number THEN now()
              ELSE leased.consumed_at
            END
       FROM picked
      WHERE leased.id = picked.id
      RETURNING (leased.next_number - 1)::text AS number`,
    [params.locationId, siteDeviceId],
  );
  const minted = Number(rows[0]?.number);
  if (!rows[0] || !isOrderNumberValue(minted)) throw new OrderNumberLeaseExhausted();
  return minted;
}

/**
 * The one call every order-creating path uses.
 *
 * `source` is resolved by the caller's own connection (`resolveOrderNumberSource`)
 * so a transaction never opens a second one merely to read the setting.
 */
export async function allocateOrderNumber(
  client: PoolClient,
  params: { locationId: string; source: OrderNumberSource },
): Promise<number> {
  if (params.source === "sequence") return allocateSequenceOrderNumber(client, params.locationId);
  return mintLeasedOrderNumber(client, { locationId: params.locationId });
}

/**
 * How many numbers the device can still mint, summed across every active
 * block. Summing matters at the renewal boundary: the new block is fetched
 * while the old one still holds its tail, and both are usable until the tail
 * is consumed. Reading only the oldest block would see "20 left" forever and
 * fetch a fresh block on every tick.
 */
async function activeLeaseRemaining(
  client: PoolClient,
  locationId: string,
  siteDeviceId: string,
): Promise<number> {
  const { rows } = await client.query<{ remaining: string }>(
    `SELECT coalesce(sum(to_number - next_number + 1), 0)::text AS remaining
       FROM order_number_lease
      WHERE location_id = $1 AND site_device_id = $2
        AND consumed_at IS NULL AND next_number <= to_number`,
    [locationId, siteDeviceId],
  );
  const remaining = Number(rows[0]?.remaining ?? 0);
  return Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 0;
}

async function highestLocalOrderNumber(client: PoolClient, locationId: string): Promise<number> {
  const { rows } = await client.query<{ highest: string }>(
    `SELECT coalesce(max(order_number), 0)::text AS highest FROM orders WHERE location_id = $1`,
    [locationId],
  );
  const highest = Number(rows[0]?.highest ?? 0);
  return Number.isSafeInteger(highest) && highest > 0 ? highest : 0;
}

/**
 * Cloud side: reserve the next block for one site device.
 *
 * `highestLocalOrderNumber` is the site's own high-water mark. The cloud starts
 * the block above BOTH its sequence and that mark, so a sale the till made
 * while its last push was still in flight can never be shadowed by a number
 * the cloud already handed out.
 */
export async function leaseOrderNumberBlock(
  client: PoolClient,
  params: {
    locationId: string;
    siteDeviceId: string;
    highestLocalOrderNumber?: number | null;
    blockSize?: number;
  },
): Promise<OrderNumberLeaseGrant> {
  const device = await client.query(
    `SELECT 1 FROM site_devices
      WHERE id = $1 AND location_id = $2 AND status = 'active' AND revoked_at IS NULL`,
    [params.siteDeviceId, params.locationId],
  );
  if (device.rowCount !== 1) throw new Error("site_device_not_active");

  const blockSize = params.blockSize ?? ORDER_NUMBER_BLOCK_SIZE;
  if (!Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 10_000) {
    throw new Error("invalid_order_number_block_size");
  }
  const highest = params.highestLocalOrderNumber ?? 0;
  if (!Number.isSafeInteger(highest) || highest < 0) throw new Error("invalid_order_number_high_water");

  const { rows } = await client.query<{
    id: string;
    location_id: string;
    site_device_id: string;
    from_number: string;
    to_number: string;
  }>(
    `WITH seq AS (
       INSERT INTO order_number_sequence AS s (location_id, next_number, updated_at)
       SELECT $1,
              greatest(
                coalesce((SELECT max(o.order_number) FROM orders o WHERE o.location_id = $1), 0) + 1,
                $2::bigint + 1,
                1
              ) + $3::bigint,
              now()
       ON CONFLICT (location_id) DO UPDATE
          SET next_number = greatest(
                s.next_number,
                coalesce((SELECT max(o.order_number) FROM orders o WHERE o.location_id = $1), 0) + 1,
                $2::bigint + 1
              ) + $3::bigint,
              updated_at = now()
       RETURNING (s.next_number - $3::bigint) AS from_number,
                 (s.next_number - 1) AS to_number
     )
     INSERT INTO order_number_lease (location_id, site_device_id, from_number, to_number, next_number)
     SELECT $1, $4::uuid, seq.from_number, seq.to_number, seq.from_number
       FROM seq
     RETURNING id, location_id, site_device_id, from_number::text, to_number::text`,
    [params.locationId, highest, blockSize, params.siteDeviceId],
  );
  const row = rows[0];
  if (!row) throw new Error("order_number_lease_not_created");
  const fromNumber = Number(row.from_number);
  const toNumber = Number(row.to_number);
  if (!isOrderNumberValue(fromNumber) || !isOrderNumberValue(toNumber) || toNumber < fromNumber) {
    throw new Error("invalid_order_number_lease");
  }
  return {
    id: row.id,
    locationId: row.location_id,
    siteDeviceId: row.site_device_id,
    fromNumber,
    toNumber,
  };
}

/**
 * Site side: keep the block the cloud granted. The local cursor starts above
 * any order this install already holds, even if one was written after the
 * high-water mark was reported.
 */
export async function recordOrderNumberLease(
  client: PoolClient,
  grant: OrderNumberLeaseGrant,
  highestLocalOrderNumber: number | null,
): Promise<void> {
  const start = leaseStartFor(grant, highestLocalOrderNumber);
  if (start > grant.toNumber) return; // The whole block is already behind local history.
  await client.query(
    `INSERT INTO order_number_lease
       (id, location_id, site_device_id, from_number, to_number, next_number)
     VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::bigint)
     ON CONFLICT (id) DO NOTHING`,
    [grant.id, grant.locationId, grant.siteDeviceId, grant.fromNumber, grant.toNumber, start],
  );
}

async function fetchLeaseGrant(
  config: ServerSyncConfig,
  highestLocalOrderNumber: number,
): Promise<OrderNumberLeaseGrant> {
  const response = await fetch(
    `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/order-number-lease`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ highestLocalOrderNumber }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error(`order_number_lease_rejected: HTTP ${response.status}`);
  const body = (await response.json()) as { lease?: unknown };
  const grant = parseOrderNumberLeaseGrant(body?.lease);
  if (!grant) throw new Error("invalid_order_number_lease");
  if (grant.locationId !== config.locationId || grant.siteDeviceId !== config.siteDeviceId) {
    throw new Error("order_number_lease_scope_mismatch");
  }
  return grant;
}

/**
 * At most one renewal per (business, location) at a time, and a failed cloud
 * call is not retried on every sale: the till keeps selling from its remaining
 * numbers while the gate waits.
 */
const renewalInFlight = new Map<string, Promise<OrderNumberLeaseStatus>>();
const renewalRetryAfter = new Map<string, number>();

/** Tests only: forget the in-process renewal gate. */
export function resetOrderNumberLeaseGate(): void {
  renewalInFlight.clear();
  renewalRetryAfter.clear();
}

/**
 * Keep this till's block ahead of its sales. A no-op unless the business is
 * paired (profile `hybrid`) and the current block is at or below the low
 * watermark. Never throws for a cloud-side failure: it reports it, and the
 * sale path decides whether it still has numbers.
 *
 * Deliberately does NOT hold a database connection across the cloud call: a
 * lease is granted once every 200 bills, and pinning a pooled connection for
 * the duration of the HTTP round trip would be a self-inflicted way to starve
 * the till's pool. Every read is its own short checkout.
 */
export async function ensureOrderNumberLease(
  businessId: string,
  options: { locationId?: string | null; allowCloud?: boolean; now?: Date } = {},
): Promise<OrderNumberLeaseStatus> {
  if (deploymentRole() !== "site") {
    return { source: "sequence", remaining: null, renewed: false, error: null };
  }
  const config = await getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
  const locationId = options.locationId ?? config?.locationId ?? null;
  if (
    !config?.enabled ||
    !config.remoteUrl?.trim() ||
    !config.token?.trim() ||
    !config.siteDeviceId ||
    !locationId
  ) {
    // Which authority this business uses is still reported honestly; an
    // unpaired install is not an error the sale path acts on.
    const client = await getPool().connect();
    try {
      const source = await resolveOrderNumberSource(client, businessId);
      return { source, remaining: null, renewed: false, error: source === "lease" ? "not_configured" : null };
    } finally {
      client.release();
    }
  }
  const siteDeviceId = config.siteDeviceId;
  if (options.locationId && config.locationId && options.locationId !== config.locationId) {
    // This install is paired to one branch. A bill for another location is not
    // ours to number locally: refuse rather than reserve a block for the wrong
    // branch.
    return { source: "lease", remaining: 0, renewed: false, error: "location_not_paired" };
  }

  const readClient = await getPool().connect();
  let source: OrderNumberSource;
  let remaining: number;
  try {
    source = await resolveOrderNumberSource(readClient, businessId);
    if (source !== "lease") {
      return { source, remaining: null, renewed: false, error: null };
    }
    remaining = await activeLeaseRemaining(readClient, locationId, siteDeviceId);
  } finally {
    readClient.release();
  }
  if (!leaseNeedsRenewal(remaining)) {
    return { source, remaining, renewed: false, error: null };
  }
  if (options.allowCloud === false) {
    return { source, remaining, renewed: false, error: "deferred" };
  }

  const gateKey = `${businessId}:${locationId}`;
  const nowMs = (options.now ?? new Date()).getTime();
  if (nowMs < (renewalRetryAfter.get(gateKey) ?? 0)) {
    return { source, remaining, renewed: false, error: "retry_later" };
  }
  const inFlight = renewalInFlight.get(gateKey);
  if (inFlight) return inFlight;

  const renewal = (async (): Promise<OrderNumberLeaseStatus> => {
    try {
      const highWaterClient = await getPool().connect();
      let highest: number;
      try {
        highest = await highestLocalOrderNumber(highWaterClient, locationId);
      } finally {
        highWaterClient.release();
      }
      const grant = await fetchLeaseGrant(config, highest);
      const recordClient = await getPool().connect();
      let refreshed: number;
      try {
        // One transaction so the grant is on disk together with its cursor;
        // the block is useless to anybody else either way, so a lost race here
        // is a gap, never a duplicate number.
        await recordClient.query("BEGIN");
        await recordOrderNumberLease(recordClient, grant, highest);
        refreshed = await activeLeaseRemaining(recordClient, locationId, siteDeviceId);
        await recordClient.query("COMMIT");
      } catch (error) {
        await recordClient.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        recordClient.release();
      }
      renewalRetryAfter.delete(gateKey);
      return {
        source,
        remaining: refreshed,
        renewed: true,
        error: null,
      };
    } catch (error) {
      renewalRetryAfter.set(gateKey, nowMs + ORDER_NUMBER_LEASE_RETRY_MS);
      return {
        source,
        remaining,
        renewed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  })();
  renewalInFlight.set(gateKey, renewal);
  try {
    return await renewal;
  } finally {
    renewalInFlight.delete(gateKey);
  }
}
