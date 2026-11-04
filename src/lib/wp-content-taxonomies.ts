/**
 * A post's categories and tags (issue #1215, P2‑5): the terms the picker
 * offers, the ids it may send, and the capability that says whether a store can
 * accept them at all.
 *
 * Three rules, each one from a way this can go wrong:
 *
 *  - **Only existing terms are offered.** The app has no way to create a tag on
 *    a site it cannot reach in plugin mode, and a half-created tag in REST mode
 *    would be a second, silent write. Terms are picked from what the site
 *    already has; new ones are made in WordPress.
 *  - **Both transports carry ids, never names.** WordPress accepts names too,
 *    but a name that matches two terms is a coin flip, and a renamed tag would
 *    silently stop matching.
 *  - **A page has no categories.** WordPress attaches categories to posts only,
 *    so the write path refuses them for pages rather than letting core drop
 *    them silently.
 */

/** How many terms one save may carry. A post with more than this is a mistake. */
export const MAX_POST_CATEGORIES = 20;
export const MAX_POST_TAGS = 50;

/** How many terms the picker renders (search narrows the list further). */
export const MAX_PICKER_TERMS = 200;

/** What a store's plugin reports in its handshake, per taxonomy. */
export const MAX_REPORTED_TERMS = 60;

export type WpTaxonomy = "category" | "post_tag";

export const WP_TAXONOMY_LABELS: Record<WpTaxonomy, string> = {
  category: "دسته‌ها",
  post_tag: "برچسب‌ها",
};

/** The wp/v2 collection that lists a taxonomy. */
export const WP_TAXONOMY_ENDPOINTS: Record<WpTaxonomy, string> = {
  category: "categories",
  post_tag: "tags",
};

export interface WpTermOption {
  id: number;
  name: string;
  parent: number;
  /** How many posts use it — the order the picker shows. */
  count: number;
}

function positiveId(value: unknown): number | null {
  const id = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Terms from either wp/v2 (`{ id, name, parent, count }`) or the plugin's
 * handshake payload. Junk is dropped, duplicates keep their first entry, and
 * the list is cut to `limit` — ordered by usage so the cut keeps the terms an
 * owner actually uses.
 */
export function normaliseWpTerms(raw: unknown, limit: number = MAX_PICKER_TERMS): WpTermOption[] {
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  const terms: WpTermOption[] = [];
  for (const entry of entries) {
    if (terms.length >= limit) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = positiveId(record.id);
    const name = typeof record.name === "string" ? record.name.trim().slice(0, 200) : "";
    if (id === null || !name || seen.has(id)) continue;
    seen.add(id);
    terms.push({
      id,
      name,
      parent: positiveId(record.parent) ?? 0,
      count: Number.isFinite(Number(record.count)) ? Math.max(0, Math.trunc(Number(record.count))) : 0,
    });
  }
  return terms;
}

/** The terms a connection's plugin reported for one taxonomy, if it reported any. */
export function postTermsFromCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
  taxonomy: WpTaxonomy,
): WpTermOption[] {
  const key = taxonomy === "category" ? "postCategories" : "postTags";
  return normaliseWpTerms(capabilities?.[key], MAX_PICKER_TERMS);
}

/**
 * Whether this connection's plugin accepts `categories`/`tags` on a
 * `post_upsert` and reports the site's own terms.
 */
export function pluginSupportsPostTaxonomies(
  capabilities: Record<string, unknown> | null | undefined,
): boolean {
  return capabilities?.contentTaxonomies === true;
}

/**
 * The term ids a save may carry: positive integers, de-duplicated, bounded. A
 * silent `all` or a stray name is refused rather than coerced.
 */
export function normaliseTermIds(
  raw: unknown,
  max: number,
): { ok: true; ids: number[] } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false };
  if (raw.length > max) return { ok: false };
  const ids: number[] = [];
  for (const entry of raw) {
    const id = positiveId(entry);
    if (id === null) return { ok: false };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

/** Same membership, same order — what "did the owner touch this?" means. */
export function sameTermIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}
