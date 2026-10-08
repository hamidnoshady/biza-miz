/**
 * Dashboard audit F13 — where a catalogue row came from.
 *
 * Two rows with the same name and SKU were indistinguishable on «لیست
 * محصولات». The integration mapping that owns a row is the one fact that tells
 * them apart (a store row says «ووکامرس · شناسه ۵۰۱»; its unmapped twin says
 * nothing), so the boards read it with this one fragment and the screen labels
 * it with `itemSourceLabel`. Database-free on purpose: a client component
 * imports the label.
 */
import { toPersianDigits } from "./digits";

export interface ItemSource {
  provider: string;
  remoteId: string;
}

/**
 * A correlated select for `items i` returning `{provider, remoteId}` of the
 * oldest mapping that owns the row, or NULL. Rides
 * `idx_integration_mappings_local (entity_type, local_id)`.
 */
export const ITEM_SOURCE_SQL = `(
  SELECT json_build_object('provider', c.provider, 'remoteId', m.remote_id)
    FROM integration_mappings m
    JOIN integration_connections c ON c.id = m.connection_id
   WHERE m.entity_type IN ('product', 'holoo_goods') AND m.local_id = i.id
   ORDER BY m.created_at, m.id
   LIMIT 1
)`;

const PROVIDER_LABEL: Record<string, string> = {
  woocommerce: "ووکامرس",
  holoo: "هلو",
};

/** «ووکامرس · شناسه ۵۰۱», or null for a row no integration owns. */
export function itemSourceLabel(source: ItemSource | null | undefined): string | null {
  if (!source || !source.remoteId) return null;
  const provider = PROVIDER_LABEL[source.provider] ?? source.provider;
  return `${provider} · شناسه ${toPersianDigits(source.remoteId)}`;
}
