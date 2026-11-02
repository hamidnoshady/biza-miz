/**
 * Issue #1207 §D — the store panel's failures, in the reader's words.
 *
 * The panel used to append the server's raw code to a generic sentence
 * (`publication_plugin_update_required`, `publication_review:link_sku_mismatch`),
 * which is a debugging token, not an instruction: an owner cannot act on
 * `publication_connection_unavailable` any more than on a stack trace. §D asks
 * for friendly offline and plugin-incompatible states instead of raw codes.
 *
 * So every refusal the publication path can throw maps to one sentence that
 * names the cause and the next step. The code is not thrown away — the panel
 * keeps it in `data-error-code` and in the hover text, so support still has the
 * exact reason without the reader having to parse it.
 *
 * Framework-free and DB-free per repo convention: the unit suite pins the map,
 * including the "unknown code" and "no code at all" (the request never arrived)
 * shapes.
 */

/** What a failure is asking the reader to do. */
export type PublicationFailureTone = "offline" | "plugin" | "data" | "review" | "permission" | "unknown";

export interface PublicationFailureCopy {
  /** One sentence: what happened. */
  message: string;
  /** The shape of the problem, for the panel's own styling and for tests. */
  tone: PublicationFailureTone;
  /** Whether pressing the same button again could plausibly work. */
  retryable: boolean;
}

/**
 * The map. Keys are the exact strings `product-publication-service` and the
 * outbox throw; `publication_review:*` codes are matched by their prefix below,
 * because the review token carries the reason as a suffix.
 */
const COPY: Record<string, PublicationFailureCopy> = {
  // — The store cannot be reached or is not accepting work (offline). —
  publication_connection_unavailable: {
    message:
      "این فروشگاه در دسترس نیست یا اتصال آن متوقف شده است. اتصال فروشگاه را بررسی و دوباره وصل کنید؛ پس از آن دوباره تلاش کنید.",
    tone: "offline",
    retryable: true,
  },
  publication_awaiting_ack: {
    message:
      "ارسال قبلی هنوز از فروشگاه تأیید نشده است. تا رسیدن تأیید صبر کنید؛ ارسال دوباره پیش از آن، ردیف تکراری می‌سازد.",
    tone: "offline",
    retryable: true,
  },
  // — The plugin on the store is too old for this job type. —
  publication_plugin_update_required: {
    message:
      "نسخهٔ افزونهٔ وردپرس این فروشگاه قدیمی‌تر از آن است که این نوع ارسال را بپذیرد. ابتدا افزونه را در سایت به‌روزرسانی کنید، سپس دوباره تلاش کنید.",
    tone: "plugin",
    retryable: false,
  },
  // — The row or the chosen store product cannot carry this send (data). —
  publication_product_not_found: {
    message: "این محصول دیگر در این شعبه نیست؛ فهرست را تازه کنید.",
    tone: "data",
    retryable: true,
  },
  publication_product_not_sellable: {
    message: "این محصول غیرفعال یا غیر قابل فروش است و به فروشگاه ارسال نمی‌شود.",
    tone: "data",
    retryable: false,
  },
  publication_select_parent_family: {
    message: "ردیف‌های تنوع به‌تنهایی منتشر نمی‌شوند؛ خانوادهٔ آن (محصول اصلی) را انتخاب کنید تا همهٔ تنوع‌ها با هم ارسال شوند.",
    tone: "data",
    retryable: false,
  },
  publication_sale_price_missing: {
    message: "برای این محصول قیمت فروش ثبت نشده است؛ ابتدا از «ورود کالا / قیمت» قیمت را تعیین کنید.",
    tone: "data",
    retryable: false,
  },
  publication_already_linked: {
    message:
      "این محصول از قبل به محصول دیگری از همین فروشگاه پیوند دارد. برای تغییر پیوند، ابتدا پیوند فعلی را در «مدیریت فروشگاه» بررسی کنید.",
    tone: "data",
    retryable: false,
  },
  publication_link_one_store: {
    message: "برای پیوند به محصول موجود، فقط یک فروشگاه را انتخاب کنید.",
    tone: "data",
    retryable: false,
  },
  publication_family_link_requires_individual_review: {
    message:
      "پیوند یک خانواده به محصول موجود باید تنوع‌به‌تنوع بررسی شود؛ این کار را از صفحهٔ محصولات همان فروشگاه انجام دهید.",
    tone: "data",
    retryable: false,
  },
  publication_invalid_remote_ack: {
    message: "فروشگاه شناسهٔ محصول نامعتبر برگرداند؛ ارسال ثبت نشد. دوباره تلاش کنید و اگر تکرار شد با پشتیبانی تماس بگیرید.",
    tone: "data",
    retryable: true,
  },
  publication_echo_mismatch: {
    message: "پاسخ فروشگاه با محصول ارسالی هم‌خوانی ندارد؛ چیزی ثبت نشد. پیوند و شناسهٔ محصول را بررسی کنید.",
    tone: "data",
    retryable: false,
  },
  publication_preview_changed: {
    message: "وضعیت این محصول از زمان بازبینی تغییر کرده است؛ بازبینی تازه انجام دهید تا چیزی که تأیید می‌کنید همان چیزی باشد که ارسال می‌شود.",
    tone: "review",
    retryable: true,
  },
  publication_link_sku_mismatch: {
    message: "کد کالای محصول انتخاب‌شده در فروشگاه با این ردیف یکسان نیست؛ پیوند انجام نشد.",
    tone: "review",
    retryable: false,
  },
  publication_remote_type_mismatch: {
    message: "نوع محصول در فروشگاه با این ردیف نمی‌خواند (ساده در برابر خانواده)؛ چیزی تغییر نکرد.",
    tone: "review",
    retryable: false,
  },
  publication_local_already_linked: {
    message: "این ردیف در همین حال به محصول دیگری از این فروشگاه پیوند خورده است؛ صفحه را تازه کنید.",
    tone: "review",
    retryable: true,
  },
  publication_remote_already_linked: {
    message: "محصول انتخاب‌شده در فروشگاه از قبل به ردیف دیگری از این کسب‌وکار پیوند دارد؛ آن ردیف را بررسی کنید.",
    tone: "review",
    retryable: false,
  },
  publication_sku_already_exists: {
    message: "فروشگاه محصولی با همین کد کالا دارد؛ به‌جای ساخت محصول تازه، آن را پیوند دهید تا ردیف تکراری ساخته نشود.",
    tone: "review",
    retryable: false,
  },
  publication_invalid_publication_selection: {
    message: "انتخاب ارسال کامل نیست؛ دست‌کم یک فروشگاه را انتخاب کنید.",
    tone: "data",
    retryable: false,
  },
  attribute_mapping_required: {
    message: "برای بعضی ویژگی‌ها نگاشت ویژگی ووکامرس تعیین نشده است؛ ابتدا نگاشت ویژگی‌ها را کامل کنید.",
    tone: "data",
    retryable: false,
  },
  attribute_options_mismatch: {
    message: "گزینه‌های ویژگی در فروشگاه با تعریف این محصول نمی‌خواند؛ نگاشت ویژگی‌ها را به‌روز کنید.",
    tone: "data",
    retryable: false,
  },
  // — The caller may read but not send. —
  publication_permission_denied: {
    message: "برای ارسال به فروشگاه دسترسی «مدیریت اتصال‌ها» لازم است؛ از مدیر کسب‌وکار بخواهید آن را بدهد.",
    tone: "permission",
    retryable: false,
  },
};

/** The fallback when the server sent a code this build does not know. */
const UNKNOWN: PublicationFailureCopy = {
  message: "ارسال انجام نشد. قیمت فروش، نگاشت ویژگی‌ها و وضعیت اتصال فروشگاه را بررسی و دوباره تلاش کنید.",
  tone: "unknown",
  retryable: true,
};

/** The fallback when the request never reached the server at all. */
const OFFLINE: PublicationFailureCopy = {
  message: "ارتباط با سرور برقرار نشد؛ تغییری ارسال نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.",
  tone: "offline",
  retryable: true,
};

/**
 * The two codes the shared `api()` helper invents when no response arrived
 * (`ui.tsx`): a dropped connection and a read deadline. Both are "the request
 * did not get there", not a refusal by the store.
 */
const TRANSPORT_CODES = new Set(["network_error", "timeout"]);

/**
 * The copy for one refusal. `code` is whatever the API returned — the panel
 * passes `undefined` when the fetch itself failed, which is the offline case
 * and not the same thing as an unknown code.
 */
export function publicationFailureCopy(code: string | undefined | null): PublicationFailureCopy {
  if (!code) return OFFLINE;
  if (TRANSPORT_CODES.has(code)) return OFFLINE;
  const exact = COPY[code];
  if (exact) return exact;
  // The review checks throw `publication_review:<reason>`; the reason-specific
  // copy above covers the ones a reader can act on, so anything else falls to
  // the review tone rather than to "unknown".
  if (code.startsWith("publication_review:")) {
    return {
      message: "بازبینی ارسال با وضعیت فعلی فروشگاه هم‌خوان نیست؛ چیزی ارسال نشد. بازبینی تازه انجام دهید.",
      tone: "review",
      retryable: true,
    };
  }
  if (code.startsWith("attribute_")) {
    return {
      message: "نگاشت ویژگی‌ها کامل نیست؛ پیش از ارسال، نگاشت ویژگی‌های ووکامرس را بررسی کنید.",
      tone: "data",
      retryable: false,
    };
  }
  return UNKNOWN;
}

/**
 * The same copy for the store-list read, which fails as a whole rather than per
 * product: no permission is a different sentence from "nothing was returned".
 */
export function storeListFailureCopy(code: string | undefined | null): string {
  if (!code || TRANSPORT_CODES.has(code)) return "فهرست فروشگاه‌ها خوانده نشد؛ اتصال شبکه را بررسی و دوباره تلاش کنید.";
  if (code === "forbidden" || code === "unauthorized") {
    return "برای دیدن فروشگاه‌ها دسترسی «مدیریت اتصال‌ها» لازم است.";
  }
  return "فهرست فروشگاه‌ها خوانده نشد؛ دوباره تلاش کنید.";
}
