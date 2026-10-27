/**
 * Drafting a product's short and long description with the platform AI —
 * the pure half: the prompt pair and the reply parser. The network call and
 * the wallet are `ai-product-description-service.ts` and its route.
 *
 * Two rules carry the design, the same two the website-draft actions keep:
 *
 *  - **The draft is built from the facts the owner already recorded** (name,
 *    SKU, brand, unit, variant attributes, what they had already written).
 *    The prompt forbids inventing a specification, a material, a certificate,
 *    a price or a promise, because a plausible invented claim under the
 *    business's name is worse than a short, plain description.
 *  - **Nothing is saved by the model.** The route returns text for the form
 *    to show; the owner edits it and saves it through the ordinary product
 *    write path. «مدل نمی‌فرستد، مدل ذخیره نمی‌کند.»
 */
import {
  PRODUCT_LONG_DESCRIPTION_MAX,
  PRODUCT_SHORT_DESCRIPTION_MAX,
} from "./product-content";

export interface ProductDescriptionFacts {
  name: string;
  sku?: string | null;
  brand?: string | null;
  category?: string | null;
  unit?: string | null;
  attributes?: { name: string; value: string }[];
  /** What the owner has already written; the draft improves it instead of discarding it. */
  existingShort?: string | null;
  existingLong?: string | null;
  /** A one-line steer from the owner («لحن رسمی»، «برای خریدار عمده»). */
  instruction?: string | null;
}

export const PRODUCT_DESCRIPTION_SYSTEM_PROMPT = [
  "تو نویسندهٔ متن محصول برای فروشگاه اینترنتی ایرانی هستی و به فارسی روان و دقیق می‌نویسی.",
  "فقط از واقعیت‌هایی استفاده کن که در پیام کاربر آمده است.",
  "هرگز ویژگی فنی، جنس، ابعاد، گارانتی، مجوز، قیمت، تخفیف یا ادعای تضمینی نساز که در داده‌ها نیست؛ اگر اطلاعات کم است، متن کوتاه و ساده بنویس.",
  "خروجی متن ساده است: بدون HTML، بدون مارک‌داون، بدون ایموجی و بدون نقل قول دور متن.",
  `توضیح کوتاه یک تا دو جمله و حداکثر ۳۰۰ نویسه است. توضیح کامل حداکثر ${PRODUCT_LONG_DESCRIPTION_MAX.toLocaleString("en-US")} نویسه است، در چند بند کوتاه، و فقط همان واقعیت‌ها را شرح می‌دهد.`,
  'پاسخ را فقط به صورت یک شیء JSON بده: {"short":"…","long":"…"}.',
].join("\n");

export function buildProductDescriptionUserPrompt(facts: ProductDescriptionFacts): string {
  const lines: string[] = [`نام محصول: ${facts.name.trim()}`];
  const add = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (text) lines.push(`${label}: ${text}`);
  };
  add("کد کالا (SKU)", facts.sku);
  add("برند", facts.brand);
  add("دسته‌بندی", facts.category);
  add("واحد", facts.unit);
  for (const attribute of facts.attributes ?? []) {
    if (attribute.name.trim() && attribute.value.trim()) lines.push(`${attribute.name.trim()}: ${attribute.value.trim()}`);
  }
  add("توضیح کوتاه فعلی", facts.existingShort);
  add("توضیح کامل فعلی", facts.existingLong);
  add("دستور مالک", facts.instruction);
  lines.push("برای این محصول توضیح کوتاه و توضیح کامل بنویس.");
  return lines.join("\n");
}

export interface ProductDescriptionDraft {
  shortDescription: string;
  longDescription: string;
}

/** The first `{…}` object in a reply that may be wrapped in a code fence or a sentence. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length <= max) return text;
  // Cut at a sentence/word boundary rather than mid-word.
  const cut = text.slice(0, max);
  const boundary = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("؟"), cut.lastIndexOf("!"), cut.lastIndexOf("\n"));
  return (boundary > max * 0.5 ? cut.slice(0, boundary + 1) : cut.slice(0, cut.lastIndexOf(" ")).trimEnd()).trim();
}

/** Null when the reply holds neither description — the route reports that, never a blank draft. */
export function parseProductDescriptionReply(text: string): ProductDescriptionDraft | null {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const shortDescription = clean(record.short ?? record.shortDescription, PRODUCT_SHORT_DESCRIPTION_MAX);
  const longDescription = clean(record.long ?? record.longDescription, PRODUCT_LONG_DESCRIPTION_MAX);
  if (!shortDescription && !longDescription) return null;
  return { shortDescription, longDescription };
}
