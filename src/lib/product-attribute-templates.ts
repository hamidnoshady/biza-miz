/**
 * Per-category attribute templates for the product workspace (#1567 P0 2.2–2.3).
 *
 * A template is a named bundle of attribute definitions — «پوشاک», «کفش» —
 * that a tenant applies to its branch's attribute master in one action. It is
 * a *preset*, never a hardcoding: the inserted rows are ordinary
 * `item_attribute_definitions` rows the shop can rename, reorder, deactivate
 * or delete like anything it typed itself, and applying a template never
 * touches a definition that already exists (same skip-existing rule as the
 * chart of accounts).
 *
 * Pure and DB-free so both the browser (the attributes page offers the list)
 * and the server (provisioning seeds the default) read the same catalog.
 */
import type { Industry } from "./industries";
import {
  ATTRIBUTE_NAME_MAX_LENGTH,
  ATTRIBUTE_OPTION_MAX_LENGTH,
  ATTRIBUTE_OPTIONS_MAX_COUNT,
  attributeComparisonKey,
  normalizeAttributeText,
} from "./product-attributes";

export interface AttributeTemplateDefinition {
  name: string;
  options: string[];
}

export interface AttributeTemplate {
  /** Stable machine key used by the API and provisioning. */
  key: string;
  /** Persian label shown to the tenant. */
  label: string;
  description: string;
  /** Industries the template is offered for (template = per-category preset). */
  industries: readonly Industry[];
  /** Applied automatically when a business of `industries` is provisioned. */
  provisionByDefault?: boolean;
  attributes: readonly AttributeTemplateDefinition[];
}

const SHOE_SIZES: string[] = ["36", "37", "38", "39", "40", "41", "42", "43", "44", "45"];

const GARMENT_COLORS: string[] = [
  "سفید", "مشکی", "طوسی", "آبی", "سرمه‌ای", "قرمز", "سبز",
  "کرم", "قهوه‌ای", "زرد", "صورتی", "بژ", "سرخابی", "نارنجی",
];

const CARE_INSTRUCTIONS: string[] = [
  "ماشین‌شویی ۳۰ درجه", "شستشوی دستی", "خشک‌شویی", "اتوکشی ملایم", "سفیدکننده ممنوع",
];

const GENDER_OPTIONS: string[] = ["زنانه", "مردانه", "بچگانه", "یونیسکس"];

const SEASON_OPTIONS: string[] = ["بهار", "تابستان", "پاییز", "زمستان", "همه‌فصل"];

/**
 * The fashion preset set. «پوشاک» ships with the new tenant because almost
 * every fashion shop starts with garments; footwear and bags are offered as
 * separate category templates the tenant applies when it needs them.
 */
export const PRODUCT_ATTRIBUTE_TEMPLATES: readonly AttributeTemplate[] = [
  {
    key: "fashion_apparel",
    label: "پوشاک",
    description: "سایز لباس، رنگ، جنس پارچه، فرم، جنسیت، فصل، کالکشن، برند و دستور مراقبت.",
    industries: ["fashion_apparel"],
    provisionByDefault: true,
    attributes: [
      { name: "سایز", options: ["XS", "S", "M", "L", "XL", "XXL"] },
      { name: "رنگ", options: GARMENT_COLORS },
      { name: "طرح", options: ["ساده", "چهارخانه", "راه‌راه", "گلدار", "چاپی", "بافت"] },
      { name: "جنس", options: ["نخی", "کتان", "پشمی", "ابریشمی", "پلی‌استر", "ویسکوز", "مخمل", "کرپ", "فاستونی", "لی"] },
      { name: "فرم", options: ["معمولی", "جذب", "آزاد", "باریک", "اسلوپی"] },
      { name: "جنسیت", options: GENDER_OPTIONS },
      { name: "گروه سنی", options: ["بزرگسال", "نوجوان", "کودک", "نوزاد"] },
      { name: "فصل", options: SEASON_OPTIONS },
      // Collections and brands are the tenant's own words — the template
      // creates the axis, the shop fills it per season.
      { name: "کالکشن", options: [] },
      { name: "برند", options: [] },
      { name: "مراقبت", options: CARE_INSTRUCTIONS },
    ],
  },
  {
    key: "fashion_footwear",
    label: "کفش",
    description: "سایز کفش بین‌المللی (۳۶ تا ۴۵)، رنگ، جنس رویه، فرم و برند.",
    industries: ["fashion_apparel"],
    attributes: [
      { name: "سایز کفش", options: SHOE_SIZES },
      { name: "رنگ", options: GARMENT_COLORS },
      { name: "جنس", options: ["چرم طبیعی", "چرم مصنوعی", "جیر", "پارچه", "مخمل", "لاستیک"] },
      { name: "فرم", options: ["کلاسیک", "اسپرت", "رسمی", "راحتی"] },
      { name: "جنسیت", options: GENDER_OPTIONS },
      { name: "فصل", options: SEASON_OPTIONS },
      { name: "برند", options: [] },
    ],
  },
  {
    key: "fashion_bags_accessories",
    label: "کیف و اکسسوری",
    description: "رنگ، جنس، اندازه، جنسیت و برند برای کیف، کمربند و اکسسوری.",
    industries: ["fashion_apparel"],
    attributes: [
      { name: "رنگ", options: GARMENT_COLORS },
      { name: "جنس", options: ["چرم طبیعی", "چرم مصنوعی", "پارچه", "مخمل", "فلز", "اکریلیک"] },
      { name: "اندازه", options: ["کوچک", "متوسط", "بزرگ"] },
      { name: "جنسیت", options: GENDER_OPTIONS },
      { name: "برند", options: [] },
    ],
  },
];

/** The template a newly provisioned business of this industry starts with. */
export function defaultAttributeTemplateFor(industry: Industry): AttributeTemplate | null {
  return PRODUCT_ATTRIBUTE_TEMPLATES.find(
    (template) => template.provisionByDefault && template.industries.includes(industry),
  ) ?? null;
}

/** Every template offered to this industry, in catalog order. */
export function attributeTemplatesFor(industry: Industry): AttributeTemplate[] {
  return PRODUCT_ATTRIBUTE_TEMPLATES.filter((template) => template.industries.includes(industry));
}

export function attributeTemplateByKey(key: string): AttributeTemplate | null {
  return PRODUCT_ATTRIBUTE_TEMPLATES.find((template) => template.key === key) ?? null;
}

/**
 * Catalog invariants, asserted by the unit test and re-checked before an
 * insert: a template with an over-long name or over-sized option list would
 * otherwise fail deep inside the seeding loop with a database error.
 */
export function invalidTemplateDefinition(template: AttributeTemplate): string | null {
  const names = new Set<string>();
  for (const definition of template.attributes) {
    const name = normalizeAttributeText(definition.name);
    if (!name || Array.from(name).length > ATTRIBUTE_NAME_MAX_LENGTH) {
      return `نام ویژگی «${definition.name}» در قالب «${template.key}» خالی یا بلند است.`;
    }
    const key = attributeComparisonKey(name);
    if (names.has(key)) return `نام ویژگی «${definition.name}» در قالب «${template.key}» تکراری است.`;
    names.add(key);
    if (definition.options.length > ATTRIBUTE_OPTIONS_MAX_COUNT) {
      return `قالب «${template.key}» برای «${name}» بیش از ${ATTRIBUTE_OPTIONS_MAX_COUNT} مقدار دارد.`;
    }
    const optionKeys = new Set<string>();
    for (const raw of definition.options) {
      const option = normalizeAttributeText(raw);
      if (!option || Array.from(option).length > ATTRIBUTE_OPTION_MAX_LENGTH) {
        return `مقدار «${raw}» در قالب «${template.key}» خالی یا بلند است.`;
      }
      const optionKey = attributeComparisonKey(option);
      if (optionKeys.has(optionKey)) {
        return `مقدار «${option}» در قالب «${template.key}» برای «${name}» تکراری است.`;
      }
      optionKeys.add(optionKey);
    }
  }
  return null;
}
