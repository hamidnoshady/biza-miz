/**
 * Issue #894 Wave 4b — **the vocabulary for what Torob says**, and the shapes it
 * arrives in.
 *
 * Every wave before this one produced facts about the *platform's* side of the
 * channel: which website may enroll, what its feed contains, who may fetch it,
 * which products the merchant chose. This file is the other direction. Torob's
 * Shop API reports the shop's status and, per page, the statuses Torob itself is
 * applying — and the issue's sharpest rule is that these must never be conflated
 * with our own: *feed built*, *webhook accepted* and *actually indexed* are three
 * different claims with three different owners.
 *
 * So the vocabulary here is **purely Torob's**. `active` means Torob says the
 * shop's products are shown; `page_not_available` means Torob considers the page
 * out of stock. Nothing in this file is derived from our feed, and nothing here
 * invents a state Torob does not have — a status list that arrives with something
 * this build does not know is left to
 * `TOROB_PRODUCT_STATUSES`' own guard in `shop-api-client.ts` rather than being
 * folded into a nearby one.
 *
 * Pure and client-safe on purpose: the per-shop screen renders these sentences,
 * and a screen must not pull a database module into the browser to say "ناموجود
 * در ترب".
 */

/** Torob's `shop_status` values, in the order `shop_api.md` documents them. */
export const TOROB_SHOP_STATUSES = ["active", "blocked", "crawler_check", "crawler_active"] as const;
export type TorobShopStatus = (typeof TOROB_SHOP_STATUSES)[number];

/**
 * Torob's per-product statuses, in the document's own priority order: when a page
 * carries several, the first is the "main" one the Torob panel shows, and the
 * filter on `POST /products/` works on exactly that.
 */
export const TOROB_PRODUCT_STATUSES = [
  "page_deleted_permanent_content",
  "page_deleted_temporary_content",
  "page_deleted_temporary_technical",
  "page_not_active",
  "page_not_accessible",
  "in_progress_add",
  "page_not_available",
  "base_not_confirmed",
  "price_not_valid",
  "base_not_merged",
  "base_image_rejected",
] as const;
export type TorobProductStatus = (typeof TOROB_PRODUCT_STATUSES)[number];

/**
 * Why a read of Torob produced nothing.
 *
 * The first three are ours — the platform never called Torob — and they are in
 * the same list because a merchant asks one question ("why is this empty?") and
 * deserves one sentence per answer, not two vocabularies. The rest are Torob's
 * own refusals, mapped from their status codes.
 */
export const TOROB_OBSERVATION_ERRORS = [
  "not_authorized",
  "channel_disabled",
  "not_configured",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "invalid_request",
  "invalid_response",
  "timeout",
  "provider_error",
] as const;
export type TorobObservationError = (typeof TOROB_OBSERVATION_ERRORS)[number];

/** What each of Torob's shop statuses means, in the merchant's terms. */
export const TOROB_SHOP_STATUS_COPY: Readonly<
  Record<TorobShopStatus, { label: string; summary: string; tone: "positive" | "neutral" | "danger" }>
> = {
  active: {
    label: "فعال در ترب",
    summary: "ترب می‌گوید محصولات این فروشگاه در ترب نمایش داده می‌شود.",
    tone: "positive",
  },
  blocked: {
    label: "مسدود در ترب",
    summary: "ترب نمایش این فروشگاه را متوقف کرده است؛ دلیل آن فقط در پنل ترب دیده می‌شود.",
    tone: "danger",
  },
  crawler_check: {
    label: "در انتظار بررسی فنی",
    summary: "ترب باید نشانی این سایت را دوباره از نظر فنی بررسی کند تا فروشگاه فعال شود.",
    tone: "neutral",
  },
  crawler_active: {
    label: "در حال به‌روزرسانی قیمت‌ها",
    summary: "ترب قیمت‌ها را می‌خواند و پس از پایان آن، فروشگاه را فعال می‌کند.",
    tone: "neutral",
  },
};

/**
 * One sentence per Torob status.
 *
 * Deliberately flat sentences rather than "this product is broken": several of
 * these are Torob's own process (`in_progress_add`) and one is an ordinary
 * shopper fact (`page_not_available`). Calling all of them errors would make the
 * merchant chase things that are not theirs to fix.
 */
export const TOROB_PRODUCT_STATUS_COPY: Readonly<Record<TorobProductStatus, string>> = {
  page_deleted_permanent_content: "به دلیل محتوا برای همیشه از ترب حذف شده است.",
  page_deleted_temporary_content: "به دلیل محتوا موقتاً از ترب حذف شده است.",
  page_deleted_temporary_technical: "به دلیل فنی موقتاً از ترب حذف شده است.",
  page_not_active: "در ترب غیرفعال شده است.",
  page_not_accessible: "ترب نتوانسته صفحهٔ محصول را باز کند.",
  in_progress_add: "در حال افزودن به ترب است.",
  page_not_available: "ترب آن را ناموجود می‌داند.",
  base_not_confirmed: "دسته‌بندی آن در ترب در انتظار تأیید است.",
  price_not_valid: "ترب قیمت آن را نامعتبر دانسته است.",
  base_not_merged: "در دسته‌هایی که ادغام لازم دارند، ادغام نشده است.",
  base_image_rejected: "یک یا چند تصویر آن در ترب نمایش داده نمی‌شود.",
};

/**
 * Which statuses are the merchant's own work, and which are Torob's process.
 *
 * `needs_fix` is the only group a screen may present as a problem; the rest are
 * either pending on Torob's side or a plain "out of stock" that a store has every
 * day. The distinction is the same one the feed's four states make: a merchant
 * should be nagged about exactly what they can change.
 */
export function torobStatusTone(status: TorobProductStatus): "neutral" | "danger" {
  switch (status) {
    case "page_deleted_permanent_content":
    case "page_not_accessible":
    case "price_not_valid":
      return "danger";
    default:
      return "neutral";
  }
}

/** What each failure means, and what the merchant can do about it. */
export const TOROB_OBSERVATION_ERROR_COPY: Readonly<Record<TorobObservationError, string>> = {
  not_authorized: "این فروشگاه در ترب تأیید نشده است؛ ابتدا اتصال آن را کامل کنید.",
  channel_disabled: "کانال ترب این فروشگاه خاموش است؛ برای خواندن وضعیت آن را روشن کنید.",
  not_configured: "برای خواندن وضعیت از ترب، دسترسی این نصب یا توکن فروشگاه لازم است.",
  unauthorized: "ترب درخواست را نپذیرفت؛ توکن یا نشانی IP این سرور در ترب ثبت نشده است.",
  forbidden: "ترب اجازهٔ این کار را نداد؛ اتصال فروشگاه در ترب فعال نیست.",
  not_found: "این فروشگاه در ترب پیدا نشد.",
  rate_limited: "ترب شمار درخواست‌ها را محدود کرد؛ کمی بعد دوباره تلاش کنید.",
  invalid_request: "درخواست ما برای ترب معتبر نبود؛ این اشکال از سمت بیزامیز است.",
  invalid_response: "پاسخ ترب با مستندات آن خوانده نشد.",
  timeout: "پاسخ ترب در زمان مجاز نرسید.",
  provider_error: "پاسخ ترب خوانده نشد؛ کمی بعد دوباره تلاش کنید.",
};

/**
 * `GET /shop/`'s `product_summary`, as Torob sends it.
 *
 * `calculatedAt` is `null` for a shop Torob has not computed yet — all counts are
 * zero then, which is *not* the same as "this shop has no products", and the
 * screen has to say so.
 */
export interface TorobProductSummary {
  calculatedAt: string | null;
  total: number;
  available: number;
  notAvailable: number;
  notAccessible: number;
  notActive: number;
  deleted: number;
  notAccessibleErrors: { errorTitle: string; count: number }[];
}

/** The shop-level answer, as stored on `torob_shops`. */
export interface TorobObservation {
  shopStatus: TorobShopStatus;
  summary: TorobProductSummary;
  /** When the last **successful** read happened. */
  observedAt: string;
  /** Why the last attempt failed — set after a failure, cleared by a success. */
  error: TorobObservationError | null;
}

/** One page's statuses, as stored in `torob_product_states`. */
export interface TorobProductState {
  pageUnique: string;
  productId: string | null;
  statuses: TorobProductStatus[];
  /** `statuses[0]`, or null when Torob reports no problem at all. */
  mainStatus: TorobProductStatus | null;
  priceToman: number | null;
  availability: boolean | null;
  errorTitle: string | null;
  torobUpdatedAt: string | null;
  observedAt: string;
}

/**
 * The five groups of `product_summary`, in Torob's order.
 *
 * The document guarantees they do not overlap and add up to `total`; the screen
 * shows them as one row so a merchant can see that for themselves.
 */
export function summaryGroups(summary: TorobProductSummary): { key: string; label: string; value: number }[] {
  return [
    { key: "available", label: "موجود در ترب", value: summary.available },
    { key: "notAvailable", label: "ناموجود در ترب", value: summary.notAvailable },
    { key: "notAccessible", label: "صفحه در دسترس نبود", value: summary.notAccessible },
    { key: "notActive", label: "غیرفعال در ترب", value: summary.notActive },
    { key: "deleted", label: "حذف‌شده", value: summary.deleted },
  ];
}

/**
 * How many products the groups do not account for.
 *
 * Zero in a healthy response — the document says the groups add up. A non-zero
 * number means Torob sent something this build did not expect, and the screen
 * says so instead of quietly showing a total that its own parts contradict.
 */
export function summaryUnaccounted(summary: TorobProductSummary): number {
  const counted =
    summary.available + summary.notAvailable + summary.notAccessible + summary.notActive + summary.deleted;
  return summary.total - counted;
}

/**
 * The catalogue id a Torob page belongs to.
 *
 * The feed's `page_unique` is the product's own uuid, or `product~variant` for a
 * single variant (`~` cannot occur in a uuid) — so the prefix is the product and
 * `null` means "not one of ours", which the state table stores as an unlinked
 * row rather than guessing.
 */
export function productIdFromPageUnique(pageUnique: string): string | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:~[^~]*)?$/i.exec(
    pageUnique,
  );
  return match ? match[1].toLowerCase() : null;
}

/**
 * One shop's observation as the multi-shop overview needs it.
 *
 * Small on purpose: the section answers "which of my sites is in what state", so
 * it carries Torob's status and three numbers — the rest lives on the per-shop
 * page. `error` is the last failed attempt, kept beside the last good answer for
 * the same reason the panel keeps both.
 */
export interface TorobObservationBrief {
  shopId: string;
  shopStatus: TorobShopStatus | null;
  /** Pages Torob currently reports for this shop. */
  pages: number;
  /** Pages carrying at least one status — what somebody has to look at. */
  withProblem: number;
  /** Torob's own total from `product_summary`; not live, and `0` before its first calculation. */
  total: number;
  observedAt: string | null;
  error: TorobObservationError | null;
}

/** How many pages Torob currently has in one status. */
export interface TorobStatusCount {
  status: TorobProductStatus;
  count: number;
}

/** The last attempt to read Torob, as the runs table recorded it. */
export interface TorobStatusRun {
  outcome: "observed" | "failed";
  shopStatus: TorobShopStatus | null;
  productsSeen: number;
  productsWithProblem: number;
  truncated: boolean;
  error: TorobObservationError | null;
  finishedAt: string;
}

/**
 * Everything `/growth/torob/[shopId]`'s status panel renders, in one shape.
 *
 * `observation` is `null` until the first successful read — a different state
 * from "read, and Torob has nothing", which is why it is not an empty summary.
 * `latestRun` is the attempt history, so a channel that has failed for three days
 * is visibly failing rather than merely unset.
 */
export interface TorobShopStatusView {
  shop: {
    id: string;
    domain: string;
    kind: "woocommerce" | "eshobe_cms";
    authorizationState: "not_authorized" | "pending_approval" | "authorized" | "revoked";
    authMode: "partner" | "manual_token";
    enabled: boolean;
  };
  observation: TorobObservation | null;
  states: {
    /** Page rows Torob is currently reporting for this shop. */
    total: number;
    /** Rows with at least one status — what a merchant has to look at. */
    withProblem: number;
    byStatus: TorobStatusCount[];
  };
  latestRun: TorobStatusRun | null;
  /** The webhook queue, so the panel states the middle stage from data (§6f). */
  webhook: { sent: boolean; pending: number; dead: number };
  capabilities: { feed: boolean; sent: boolean; listing: boolean };
}

/**
 * The three stages of the channel, and which of them a screen is allowed to claim.
 *
 * Written down because the issue's central complaint is a product manager reading
 * "accepted" as "indexed". A surface picks its sentences from here, so no screen
 * invents a fourth stage or upgrades one by accident.
 */
export const TOROB_LISTING_STAGE_COPY: Readonly<
  Record<"feed" | "sent" | "listing", { label: string; summary: string }>
> = {
  feed: {
    label: "آماده در فید",
    summary: "بیزامیز این محصولات را برای ترب آماده می‌کند؛ این تنها چیزی است که خودمان می‌دانیم.",
  },
  sent: {
    label: "ارسال‌شده به ترب",
    summary: "ترب درخواست به‌روزرسانی را پذیرفته است؛ پذیرش به معنای نمایش نیست.",
  },
  listing: {
    label: "نمایش در ترب",
    summary: "خود ترب این وضعیت را گزارش کرده است؛ تنها این مرحله یعنی محصول در ترب دیده می‌شود.",
  },
};
