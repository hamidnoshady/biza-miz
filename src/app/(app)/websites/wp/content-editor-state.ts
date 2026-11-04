/** Pure state helpers for the WordPress post/page editor. */
export interface WpEditorValues {
  editorTitle: string;
  content: string;
  excerpt: string;
  slug: string;
  status: string;
  /**
   * When a `future` post should publish, as an ISO instant (empty when the
   * owner has not chosen one). It travels beside the wp/v2 fields because the
   * app translates it into WordPress's own `date_gmt` rather than letting a
   * free-form date reach the site.
   */
  scheduledFor: string;
}

const API_FIELD_BY_EDITOR_FIELD: Record<keyof WpEditorValues, string> = {
  editorTitle: "title",
  content: "content",
  excerpt: "excerpt",
  slug: "slug",
  status: "status",
  scheduledFor: "scheduledFor",
};

/**
 * Send only fields the owner actually changed. This is a data-safety rule,
 * not merely an optimisation: an old mirror may not contain a raw post body,
 * and including its empty editor fallback in a title-only save would erase the
 * real body on WordPress.
 */
export function wpEditorPatch(
  initial: WpEditorValues,
  current: WpEditorValues,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const key of Object.keys(current) as (keyof WpEditorValues)[]) {
    if (current[key] !== initial[key]) patch[API_FIELD_BY_EDITOR_FIELD[key]] = current[key];
  }
  return patch;
}

export function wpEditorIsDirty(initial: WpEditorValues | null, current: WpEditorValues): boolean {
  return initial !== null && Object.keys(wpEditorPatch(initial, current)).length > 0;
}

/**
 * Categories and tags travel as id lists, not as wp/v2 text fields, so they
 * have their own patch and their own dirty rule — the same one: send only what
 * the owner changed. A save that includes an unchanged list would rewrite the
 * site's terms with whatever the mirror last saw.
 */
export interface WpEditorTaxonomies {
  categories: number[];
  tags: number[];
}

export interface WpEditorTermPatch {
  categories?: number[];
  tags?: number[];
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

export function wpTaxonomyPatch(
  initial: WpEditorTaxonomies,
  current: WpEditorTaxonomies,
): WpEditorTermPatch {
  const patch: WpEditorTermPatch = {};
  if (!sameIds(initial.categories, current.categories)) patch.categories = [...current.categories];
  if (!sameIds(initial.tags, current.tags)) patch.tags = [...current.tags];
  return patch;
}

export function wpTaxonomiesDirty(
  initial: WpEditorTaxonomies | null,
  current: WpEditorTaxonomies,
): boolean {
  return initial !== null && Object.keys(wpTaxonomyPatch(initial, current)).length > 0;
}

/** Toggle one term in a selection, keeping the order the owner picked it in. */
export function toggleTermId(ids: readonly number[], id: number): number[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}
