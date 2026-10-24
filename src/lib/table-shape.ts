/**
 * The shapes a dining table may have. This is the vocabulary of
 * `dining_tables_shape_check` (migrations 0238_*): `circle` is the retired
 * spelling of `round` — migration 0238_dining_table_shape_normalise.sql converts
 * stored rows, and every writer maps it here so an older client, the assistant
 * or an MCP connector that still says `circle` keeps working.
 */
export const TABLE_SHAPES = ["rect", "round", "square", "booth"] as const;

export type TableShape = (typeof TABLE_SHAPES)[number];

/** The shape to store for a request value, or `null` when it is not a shape. */
export function normalizeTableShape(value: unknown): TableShape | null {
  if (value === "circle") return "round";
  return (TABLE_SHAPES as readonly unknown[]).includes(value) ? (value as TableShape) : null;
}
