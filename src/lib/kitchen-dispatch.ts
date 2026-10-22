import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { deploymentRole } from "./deployment-role";
import { readDeploymentProfile } from "./deployment-mode";

export type KitchenDispatchOwner = "local_runtime" | "hybrid_site" | "cloud_station";

/** Return the one runtime allowed to print physical kitchen tickets. */
export function kitchenDispatchOwner(
  profile: "local" | "hybrid" | "cloud",
  runtime: "site" | "central",
): KitchenDispatchOwner | null {
  if (profile === "local") return "local_runtime";
  if (profile === "hybrid") return runtime === "site" ? "hybrid_site" : null;
  return runtime === "central" ? "cloud_station" : null;
}

/**
 * Enqueue one immutable dispatch intent inside the order mutation transaction.
 * The unique key names the order and the exact line-id set, so replaying the
 * same create/add-items event cannot generate another physical print request.
 */
export async function enqueueKitchenDispatch(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    orderId: string;
    itemIds: readonly string[];
  },
): Promise<string | null> {
  if (input.itemIds.length === 0) return null;
  const profile = await readDeploymentProfile(input.businessId);
  const ownerMode = kitchenDispatchOwner(profile.profile, deploymentRole());
  if (!ownerMode) return null;

  const canonicalIds = [...new Set(input.itemIds)].sort();
  if (canonicalIds.length !== input.itemIds.length) {
    throw new Error("duplicate_kitchen_dispatch_item");
  }
  const digest = createHash("sha256").update(canonicalIds.join("\n")).digest("hex");
  const idempotencyKey = `kitchen:${input.orderId}:${digest}`;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO kitchen_dispatch_jobs
       (business_id,location_id,order_id,item_ids,idempotency_key,owner_mode)
     VALUES ($1,$2,$3,$4::uuid[],$5,$6)
     ON CONFLICT (location_id,idempotency_key) DO UPDATE
       SET idempotency_key=EXCLUDED.idempotency_key
     RETURNING id`,
    [input.businessId, input.locationId, input.orderId, canonicalIds, idempotencyKey, ownerMode],
  );
  return rows[0]?.id ?? null;
}
