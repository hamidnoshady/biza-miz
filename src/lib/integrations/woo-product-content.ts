import { query } from "../db";
import { PRODUCT_LONG_DESCRIPTION_MAX, PRODUCT_SHORT_DESCRIPTION_MAX } from "../product-content";
import { productQueueStates, type ProductQueueState } from "./woo-ops-service";

/**
 * What the store says about one product's *presentation* — the half of a
 * product the manager may edit on the storefront side (issue #1215, P1-2).
 *
 * The catalogue list already mirrors the store's price, stock, status and
 * imagery; this is the same mirror, one product at a time, plus the two
 * description fields. It exists as its own read for two reasons:
 *
 *  - **Size.** A long description is up to 20 000 characters of Gutenberg
 *    HTML. Sending one per card would multiply the list payload by a factor
 *    nobody looks at; the sheet asks for the one product it is opening.
 *  - **Honesty.** The fields come from the last complete read of the store
 *    (`recordProductShape`), never from Accounting's copy of the product. The
 *    sheet must be able to say "the store says this" — if it rendered
 *    Accounting's text, an owner would edit the wrong copy and believe the
 *    storefront was updated.
 *
 * Nothing here writes. The write path stays the one every product edit
 * already uses: `POST /store/products` → the outbox → the store, with the
 * halves of the patch each side owns (Accounting: inventory and base price;
 * the store: its media and descriptions).
 */
export interface WooProductContentImage {
  src: string;
  /** The store's alt text, verbatim — including an empty string, which is a fact. */
  alt: string;
}

export interface WooProductContent {
  remoteId: string;
  /** The Accounting item this product is mapped to, or null for an unmapped row. */
  localId: string | null;
  name: string | null;
  sku: string | null;
  wooType: string | null;
  remoteStatus: string | null;
  /** The store's short description, or null when it has none. */
  shortDescription: string | null;
  /** The store's long description (Gutenberg HTML as WooCommerce stores it). */
  description: string | null;
  image: WooProductContentImage | null;
  /** Every image after the primary, in the store's own order, capped by the mirror. */
  gallery: WooProductContentImage[];
  /** How many images the store actually has, which may exceed the mirrored gallery. */
  galleryCount: number | null;
  /** When WordPress last wrote this product — the store's own watermark. */
  remoteModifiedAt: string | null;
  /** When our sync last read this product's row. */
  lastSeenAt: string | null;
  queue: ProductQueueState | null;
}

/** The two description fields this screen may change, and nothing else. */
export const PRODUCT_CONTENT_FIELDS = ["short_description", "description"] as const;
export type ProductContentField = (typeof PRODUCT_CONTENT_FIELDS)[number];

/** The bounds the editor and the write path share (migration 0260 / product-content.ts). */
export const PRODUCT_CONTENT_LIMITS: Record<ProductContentField, number> = {
  short_description: PRODUCT_SHORT_DESCRIPTION_MAX,
  description: PRODUCT_LONG_DESCRIPTION_MAX,
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function imageOf(value: unknown): WooProductContentImage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const src = typeof raw.src === "string" && raw.src ? raw.src : null;
  if (!src) return null;
  return { src, alt: typeof raw.alt === "string" ? raw.alt : "" };
}

/**
 * Read the presentation half out of a product mapping's metadata. Pure, so the
 * "what does a store payload become" contract is testable without a database:
 * a malformed or half-written blob yields nulls, never a fabricated value.
 */
export function productContentFromMeta(meta: unknown): Omit<WooProductContent, "remoteId" | "localId" | "name" | "sku" | "wooType" | "lastSeenAt" | "queue"> {
  const m = (meta ?? {}) as Record<string, unknown>;
  const galleryRaw = Array.isArray(m.remoteGallery) ? m.remoteGallery : [];
  const gallery: WooProductContentImage[] = [];
  for (const entry of galleryRaw) {
    const image = imageOf(entry);
    if (image) gallery.push(image);
  }
  return {
    remoteStatus: text(m.remoteStatus),
    shortDescription: text(m.remoteShortDescription),
    description: text(m.remoteDescription),
    image: imageOf(
      m.remoteImageSrc ? { src: m.remoteImageSrc, alt: typeof m.remoteImageAlt === "string" ? m.remoteImageAlt : "" } : null,
    ),
    gallery,
    galleryCount: typeof m.remoteGalleryCount === "number" && Number.isFinite(m.remoteGalleryCount) ? m.remoteGalleryCount : null,
    remoteModifiedAt: text(m.remoteModifiedAt),
  };
}

interface MappingRow extends Record<string, unknown> {
  local_id: string | null;
  updated_at: Date | string | null;
  last_pushed_payload: Record<string, unknown> | null;
}

/**
 * One storefront presentation read, scoped to the tenant and the connection.
 *
 * Returns null when this connection has never mapped this remote id — the
 * route turns that into a 404 rather than showing an empty editor for a
 * product that belongs to another store.
 */
export async function wooProductContentFor(
  businessId: string,
  connectionId: string,
  remoteId: string,
): Promise<WooProductContent | null> {
  const { rows } = await query<MappingRow>(
    `SELECT local_id, updated_at, last_pushed_payload
       FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'product' AND remote_id = $3`,
    [businessId, connectionId, remoteId],
  );
  const mapping = rows[0];
  if (!mapping) return null;

  const base = productContentFromMeta(mapping.last_pushed_payload);

  let name: string | null = null;
  let sku: string | null = null;
  if (mapping.local_id) {
    // Joined through the location so a mapping that somehow points at another
    // tenant's item can never surface that item's name here.
    const { rows: items } = await query<{ name: string; sku: string | null }>(
      `SELECT i.name, i.sku
         FROM items i
         JOIN locations l ON l.id = i.location_id
        WHERE i.id = $1 AND l.business_id = $2`,
      [mapping.local_id, businessId],
    );
    name = items[0]?.name ?? null;
    sku = items[0]?.sku ?? null;
  }

  // The queue read is the catalogue's own, so the sheet and the card can never
  // disagree about whether an edit is still on its way to the store.
  const queue = (await productQueueStates(businessId, connectionId, [remoteId]))[remoteId] ?? null;

  const wooType = typeof mapping.last_pushed_payload?.wooType === "string" ? (mapping.last_pushed_payload.wooType as string) : null;

  return {
    remoteId,
    localId: mapping.local_id,
    name,
    sku,
    wooType,
    lastSeenAt: mapping.updated_at ? new Date(mapping.updated_at).toISOString() : null,
    // An idle state carries no news; the sheet shows nothing rather than a
    // green "no queue" badge nobody asked for.
    queue: queue && queue.state !== "idle" ? queue : null,
    ...base,
  };
}
