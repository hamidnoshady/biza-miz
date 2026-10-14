/**
 * Where a customer, lead or deal came from.
 *
 * ## Why a vocabulary and not free text
 *
 * "Where did this customer come from?" is the question every marketing budget
 * turns on, and it is unanswerable the moment the column is free text: one
 * business ends up with «اینستاگرام», «اینستا», «instagram» and «IG» as four
 * different sources, and no report can add them up. So the vocabulary is
 * closed, and anything outside it goes in `sourceDetail` — which *is* free
 * text, because «کمپین نوروز ۱۴۰۴» genuinely cannot be enumerated in advance.
 *
 * ## First-touch, never overwritten
 *
 * `acquisition_source` records how a person first arrived and is written
 * exactly once. A customer who found the shop on Instagram and later bought
 * online is still an Instagram acquisition; overwriting it with `woocommerce`
 * would silently reattribute every historical acquisition to whichever channel
 * touched the customer most recently, and the Instagram spend would look
 * worthless. `last_source` tracks the most recent touch separately, so both
 * questions have their own answer instead of one column giving a wrong answer
 * to both. Both rules are enforced in SQL at the two write sites — lead
 * conversion in `crm-lead-service.ts` and the online store's party creation in
 * `crm-external-identity.ts` — which stamp `acquisition_source` only where it
 * is NULL.
 */

/** The closed vocabulary. Order is the order the UI lists them in. */
export const CRM_SOURCES = [
  "pos",
  "woocommerce",
  "website_form",
  "instagram",
  "telegram",
  "whatsapp",
  "phone",
  "walk_in",
  "referral",
  "campaign",
  "event",
  "marketplace",
  "import",
  "manual",
  "other",
] as const;

export type CrmSource = (typeof CRM_SOURCES)[number];

/**
 * The label each source is shown with.
 *
 * Added when the automations screen needed to *name* a source in a select: the
 * vocabulary existed and the keys were English identifiers, so every screen that
 * showed one would have had to invent its own wording — which is how one source
 * ends up «وب‌سایت» on one screen and «فرم سایت» on the next.
 */
export const CRM_SOURCE_LABELS: Record<CrmSource, string> = {
  pos: "صندوق فروش",
  woocommerce: "فروشگاه آنلاین",
  website_form: "فرم وب‌سایت",
  instagram: "اینستاگرام",
  telegram: "تلگرام",
  whatsapp: "واتس‌اپ",
  phone: "تماس تلفنی",
  walk_in: "مراجعهٔ حضوری",
  referral: "معرفی دیگران",
  campaign: "کمپین بازاریابی",
  event: "رویداد",
  marketplace: "بازارگاه",
  import: "ورود داده",
  manual: "ورود دستی",
  other: "دیگر",
};

export function isCrmSource(value: unknown): value is CrmSource {
  return typeof value === "string" && (CRM_SOURCES as readonly string[]).includes(value);
}

/**
 * Coerce a stored value into the vocabulary for display.
 *
 * Never throws and never discards: a row written before this vocabulary
 * existed, or by an integration using its own word, still has to render. It
 * falls back to `other` for grouping while the original string stays in the
 * column — losing it would destroy the only evidence of what the source
 * actually was.
 */
export function normaliseSource(value: string | null | undefined): CrmSource {
  if (!value) return "manual";
  const trimmed = value.trim().toLowerCase();
  if (isCrmSource(trimmed)) return trimmed;
  // A few aliases that predate the vocabulary, so historical rows group with
  // the channel they actually mean rather than all landing in «سایر».
  const aliases: Record<string, CrmSource> = {
    woo: "woocommerce",
    wordpress: "woocommerce",
    online: "woocommerce",
    shop: "pos",
    store: "pos",
    counter: "pos",
    sms: "campaign",
    ig: "instagram",
  };
  return aliases[trimmed] ?? "other";
}
