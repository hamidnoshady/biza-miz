/**
 * The business directory's sort contract (audit F14), shared by the page, the
 * API route and the SQL builder so the arrow the operator sees is the order
 * the server actually returns.
 *
 *   sort  — one of the sort keys below (`newest`/`oldest` are the legacy
 *           created-date values and keep working).
 *   dir   — optional `asc` | `desc`. When omitted, each key uses its natural
 *           default (names ascend; counts and activity descend).
 *
 * Every ordering ends with `b.id` as a tie-breaker so pagination is stable.
 * Pure and client-safe.
 */
export const BUSINESS_SORT_KEYS = ["created", "name", "orders", "members", "activity"] as const;
export type BusinessSortKey = (typeof BUSINESS_SORT_KEYS)[number];

/** Every value the API accepts for `sort` (legacy + canonical). */
export const BUSINESS_SORT_VALUES = ["newest", "oldest", ...BUSINESS_SORT_KEYS] as const;
export type BusinessSortValue = (typeof BUSINESS_SORT_VALUES)[number];

export type SortDirection = "asc" | "desc";

export interface ResolvedBusinessSort {
  key: BusinessSortKey;
  dir: SortDirection;
}

const DEFAULT_DIR: Record<BusinessSortKey, SortDirection> = {
  created: "desc",
  name: "asc",
  orders: "desc",
  members: "desc",
  activity: "desc",
};

export function isBusinessSortValue(value: unknown): value is BusinessSortValue {
  return typeof value === "string" && (BUSINESS_SORT_VALUES as readonly string[]).includes(value);
}

export function parseSortDirection(value: unknown): SortDirection | undefined {
  return value === "asc" || value === "desc" ? value : undefined;
}

/**
 * Resolve a requested sort + optional direction to the key and direction the
 * SQL uses. Legacy `newest` / `oldest` map to `created` desc / asc unless the
 * caller explicitly sends a direction.
 */
export function resolveBusinessSort(
  sort: string | null | undefined,
  dir?: string | null,
): ResolvedBusinessSort {
  const explicit = parseSortDirection(dir ?? undefined);
  if (sort === "newest") return { key: "created", dir: explicit ?? "desc" };
  if (sort === "oldest") return { key: "created", dir: explicit ?? "asc" };
  const key = (BUSINESS_SORT_KEYS as readonly string[]).includes(sort ?? "")
    ? (sort as BusinessSortKey)
    : "created";
  return { key, dir: explicit ?? DEFAULT_DIR[key] };
}

/** The direction the directory shows for a key when no explicit one is set. */
export function defaultSortDirection(key: BusinessSortKey): SortDirection {
  return DEFAULT_DIR[key];
}
