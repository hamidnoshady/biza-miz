/**
 * The register's client-safe vocabulary — the sorts, their labels and the
 * posting states (#923 P2).
 *
 * Deliberately a separate module from `warehouse-document-register.ts`: that
 * one is the *server* half (it imports the pool to build queries), and the two
 * screens are `"use client"`. Importing a runtime value from the server module
 * from a client component drags `src/lib/db.ts` and `pg` into the browser
 * bundle — a `next build` failure that type-check, ESLint and the unit suite
 * all pass (see `client-bundle-boundary.test.ts`). The server module re-exports
 * everything here, so server callers keep one import.
 */

/**
 * How the register is ordered. Every key is keyset-pageable: `(sortValue, id)`
 * compared strictly after the cursor, so a page never shifts while documents
 * keep posting — an offset would.
 */
export const WAREHOUSE_REGISTER_SORTS = [
  "created_desc",
  "created_asc",
  "date_desc",
  "date_asc",
  "amount_desc",
  "amount_asc",
] as const;
export type WarehouseRegisterSort = (typeof WAREHOUSE_REGISTER_SORTS)[number];

export const WAREHOUSE_REGISTER_SORT_LABELS: Record<WarehouseRegisterSort, string> = {
  created_desc: "جدیدترین ثبت",
  created_asc: "قدیمی‌ترین ثبت",
  date_desc: "تاریخ سند: جدید به قدیم",
  date_asc: "تاریخ سند: قدیم به جدید",
  amount_desc: "مبلغ: زیاد به کم",
  amount_asc: "مبلغ: کم به زیاد",
};

export function isWarehouseRegisterSort(value: unknown): value is WarehouseRegisterSort {
  return typeof value === "string" && (WAREHOUSE_REGISTER_SORTS as readonly string[]).includes(value);
}

/**
 * A document's posting state as the register can filter on it.
 *
 * A warehouse document is created and posted in one transaction, so
 * `missing` is not a normal state — it is a repaired/legacy voucher whose
 * journal entry is absent, exactly what the detail's `not_posted` badge
 * reports. The filter exists so an accountant can *find* those instead of
 * clicking through the register until one shows up.
 */
export const WAREHOUSE_POSTING_STATES = ["posted", "missing"] as const;
export type WarehousePostingState = (typeof WAREHOUSE_POSTING_STATES)[number];

export function isWarehousePostingState(value: unknown): value is WarehousePostingState {
  return value === "posted" || value === "missing";
}

