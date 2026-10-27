/**
 * The storefront-facing text of a product: its publish status and its short
 * and long description.
 *
 * Client-safe on purpose (no database, no `node:` imports): the add-product
 * form, the list editor, the route validators and the AI prompt all read the
 * same vocabulary and the same limits from here, so a number typed in the
 * form can never differ from the one the database CHECK enforces
 * (migration 0260).
 */

export const PRODUCT_PUBLISH_STATUSES = ["published", "draft", "private"] as const;
export type ProductPublishStatus = (typeof PRODUCT_PUBLISH_STATUSES)[number];

export const PRODUCT_PUBLISH_STATUS_LABELS: Record<ProductPublishStatus, string> = {
  published: "منتشرشده",
  draft: "پیش‌نویس",
  private: "خصوصی",
};

export const PRODUCT_PUBLISH_STATUS_HINTS: Record<ProductPublishStatus, string> = {
  published: "برای نمایش در فروشگاه و وب‌سایت آماده است.",
  draft: "در فروشگاه و وب‌سایت نمایش داده نمی‌شود تا منتشر کنید.",
  private: "فقط برای مدیران فروشگاه قابل مشاهده است.",
};

/** Mirrors the CHECK constraints in migration 0260. */
export const PRODUCT_SHORT_DESCRIPTION_MAX = 1000;
export const PRODUCT_LONG_DESCRIPTION_MAX = 20000;

export function isProductPublishStatus(value: unknown): value is ProductPublishStatus {
  return typeof value === "string" && (PRODUCT_PUBLISH_STATUSES as readonly string[]).includes(value);
}

/**
 * Trims and bounds one description. Blank becomes `null` (not an empty
 * string) so "no description" has exactly one stored shape; an over-long value
 * is reported to the caller rather than silently truncated.
 */
export function normalizeProductDescription(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false; reason: "invalid_text" | "text_too_long" } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, reason: "invalid_text" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > max) return { ok: false, reason: "text_too_long" };
  return { ok: true, value: trimmed };
}
