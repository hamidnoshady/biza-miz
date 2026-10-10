/**
 * The one Persian-aware `ILIKE` search — the SQL half of the search box.
 *
 * The app's pickers fold what a person typed through `normalizePosSearchText`
 * before matching, so «علي» finds «علی» and a Persian-keyboard «۱۲» finds
 * «12». When the same search moves into SQL — because filtering in JS means
 * shipping a business's whole history to the server process to discard most of
 * it (see `listReceipts`) — the *column* has to be folded into that same
 * alphabet, or the two halves of one search disagree: «علی» would be found in
 * the picker and not in the list beside it.
 *
 * `installments-service` grew this first, for the voucher lists. It lives here
 * because the receivables/payables balance lists are now searched in SQL too,
 * and three private copies of a `translate()` character map is three chances
 * for one screen to stop matching «ي».
 *
 * Inline `translate` rather than a stored function on purpose: one expression,
 * no migration, and the fold is visible at each call site that uses it.
 */

import { normalizePosSearchText } from "./pos-selection";

/**
 * The character map, as a SQL `translate()` template: Arabic ي/ك → Persian
 * ی/ک and both digit sets → ASCII. `%s` is the expression to fold.
 */
export const SEARCH_FOLD = "translate(%s, 'يك٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'یک01234567890123456789')";

/** `SEARCH_FOLD` applied to one expression — `foldForSearch("p.name")`. */
export function foldForSearch(expression: string): string {
  return SEARCH_FOLD.replace("%s", expression);
}

/**
 * The `q` argument as a LIKE pattern, or null when there is nothing to search
 * for. The needle is normalized exactly the way the client-side pickers
 * normalize it (the same `normalizePosSearchText`), then the LIKE wildcards it
 * may contain are escaped — «%» must find a literal «%», not swallow the table.
 *
 * Null is the caller's signal to leave the filter out entirely (`$n::text IS
 * NULL OR …`), so an empty search is a no-op rather than a `%%` that matches
 * every row.
 */
export function searchPattern(q: string | null | undefined): string | null {
  const needle = normalizePosSearchText(q ?? "");
  if (!needle) return null;
  return `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
