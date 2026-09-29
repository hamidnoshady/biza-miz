/**
 * The master-data tables that synchronise continuously between a desktop
 * site and the central server, merged field by field (migration 0190).
 *
 * This list and the `trg_sync_capture` trigger arguments in the migration are
 * one contract: `triggerArgs()` renders exactly what the trigger was created
 * with, and an integration test compares the two, so a column cannot be
 * merged on one side while the trigger ignores it on the other.
 *
 * Order matters: parents before children, so a batch that carries a new
 * category and the item that uses it applies in one pass.
 */

export type MasterScope =
  | { kind: "business" }
  | { kind: "location" }
  | { kind: "parent"; table: string; column: string };

export interface MasterTableConfig {
  table: string;
  pk: readonly string[];
  scope: MasterScope;
  /**
   * Columns each side derives for itself and never merges: running costs from
   * stock movements, CRM scores, table occupancy, ciphertext under a key only
   * one install holds, and bookkeeping timestamps.
   */
  excluded: readonly string[];
  /**
   * Nullable references that may point at something the receiver does not
   * hold (another branch, a login that was never paired here). When the
   * reference is missing the column is written as NULL instead of blocking
   * the row forever.
   */
  optionalRefs: readonly string[];
  /** A soft delete for rows that other records still point at. */
  softDeleteColumn?: string;
  /** Receiver sets this to now() whenever it writes the row. */
  touchColumn?: string;
}

export const MASTER_SYNC_TABLES: readonly MasterTableConfig[] = [
  {
    table: "party_categories",
    pk: ["id"],
    scope: { kind: "business" },
    excluded: ["updated_at"],
    optionalRefs: [],
    softDeleteColumn: "is_active",
    touchColumn: "updated_at",
  },
  {
    table: "parties",
    pk: ["id"],
    scope: { kind: "business" },
    excluded: [
      "updated_at",
      "rfm_recency",
      "rfm_frequency",
      "rfm_monetary",
      "rfm_scored_at",
      "last_interaction_at",
      "last_source",
      "phone_enc",
      "phone_bidx",
      "phone_e164",
      "phone_last4",
      "phone_kind",
      "address_enc",
      "notes_enc",
      "national_id_enc",
      "national_id_bidx",
      "economic_code_enc",
      "profile_image_asset_id",
    ],
    optionalRefs: ["location_id", "category_id", "merged_into_id", "employee_user_id", "crm_owner_user_id"],
    softDeleteColumn: "is_active",
    touchColumn: "updated_at",
  },
  {
    table: "payment_methods",
    pk: ["id"],
    scope: { kind: "business" },
    excluded: [],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "menu_categories",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: [],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "modifier_groups",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: [],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "modifiers",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: [],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "inventory_items",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: ["avg_cost", "carrying_value_rial", "image_media_id"],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "menu_items",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: ["updated_at", "image_media_id"],
    optionalRefs: ["category_id"],
    softDeleteColumn: "is_active",
    touchColumn: "updated_at",
  },
  {
    table: "dining_tables",
    pk: ["id"],
    scope: { kind: "location" },
    excluded: ["status", "section_id"],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "menu_item_modifier_groups",
    pk: ["menu_item_id", "modifier_group_id"],
    scope: { kind: "parent", table: "menu_items", column: "menu_item_id" },
    excluded: [],
    optionalRefs: [],
    softDeleteColumn: "is_active",
  },
  {
    table: "menu_item_ingredients",
    pk: ["menu_item_id", "inventory_item_id"],
    scope: { kind: "parent", table: "menu_items", column: "menu_item_id" },
    excluded: [],
    optionalRefs: [],
  },
  {
    table: "modifier_ingredients",
    pk: ["modifier_id", "inventory_item_id"],
    scope: { kind: "parent", table: "modifiers", column: "modifier_id" },
    excluded: [],
    optionalRefs: [],
  },
];

const BY_TABLE = new Map(MASTER_SYNC_TABLES.map((config) => [config.table, config]));

export function masterTableConfig(table: unknown): MasterTableConfig | null {
  return typeof table === "string" ? BY_TABLE.get(table) ?? null : null;
}

/** Apply order: a parent table sorts before its children. */
export function masterTableRank(table: string): number {
  const index = MASTER_SYNC_TABLES.findIndex((config) => config.table === table);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/** Exactly the three arguments `trg_sync_capture` is created with in migration 0190. */
export function triggerArgs(config: MasterTableConfig): [string, string, string] {
  const scope =
    config.scope.kind === "parent" ? `parent:${config.scope.table}:${config.scope.column}` : config.scope.kind;
  return [config.pk.join(","), scope, config.excluded.join(",")];
}

/** A composite key is the pk values joined by `|`, as the trigger builds it. */
export function rowKey(config: MasterTableConfig, row: Record<string, unknown>): string {
  return config.pk.map((column) => String(row[column])).join("|");
}

export function splitRowKey(config: MasterTableConfig, key: string): Record<string, string> | null {
  const parts = key.split("|");
  if (parts.length !== config.pk.length || parts.some((part) => !part)) return null;
  return Object.fromEntries(config.pk.map((column, index) => [column, parts[index]]));
}
