/** Atomic native product creation. No parallel product or stock model is made. */
import { withTenantTransaction } from "./db";
import { createItem, setWeightAttributes } from "./items-service";
import { upsertWatchAttributes, type WatchItemAttributesInput } from "./watch-attributes-service";

interface BaseInput {
  businessId: string;
  locationId: string;
  userId?: string | null;
  name: string;
  sku: string | null;
}

/** A model and its optional technical facts must commit or roll back together. */
export async function createWatchModel(input: BaseInput & {
  serviceIntervalMonths: number | null;
  attributes: WatchItemAttributesInput | null;
}) {
  return withTenantTransaction(input.businessId, async () => {
    const item = await createItem({ locationId: input.locationId, name: input.name, sku: input.sku, tracking: "serial", serviceIntervalMonths: input.serviceIntervalMonths });
    const attributes = input.attributes ? await upsertWatchAttributes(item.id, input.attributes) : null;
    return { ...item, attributes };
  }, { locationId: input.locationId, userId: input.userId });
}

/** A weighted piece cannot exist without its required weight/purity facts. */
export async function createJewelryPiece(input: BaseInput & {
  weight: { purity: string; grossWeight: string; netWeight: string; unitCostPerGram?: string | null };
}) {
  return withTenantTransaction(input.businessId, async () => {
    const item = await createItem({ locationId: input.locationId, name: input.name, sku: input.sku, tracking: "weight" });
    await setWeightAttributes(item.id, input.weight);
    return item;
  }, { locationId: input.locationId, userId: input.userId });
}
