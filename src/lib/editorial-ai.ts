/**
 * The editorial assistant's pure half: what each action means, the prompt pair
 * and the reply parser (issue #1215, P2‑5). The network call and the wallet are
 * `ai-editorial-service.ts` and its route.
 *
 * Three rules carry the design, the same ones the product-copy draft keeps:
 *
 *  - **The assistant works on the owner's own text.** Every action other than
 *    a blank-page outline is given the current title, body and excerpt; the
 *    prompt says to keep the facts and change only what the action names.
 *  - **It never invents a fact.** No award, certification, price, deadline,
 *    address or person may appear that was not in the text handed to it — an
 *    invented claim published under the business's name is worse than a plain
 *    sentence.
 *  - **It returns text and nothing else.** No route here writes to WordPress;
 *    the draft lands beside the editor, the human reads it, and it reaches the
 *    site only through the ordinary save path with its version check.
 */

/** Every editorial action the assistant offers. */
export const EDITORIAL_ACTIONS = [
  "outline",
  "title",
  "excerpt",
  "body",
  "rewrite",
  "shorten",
  "expand",
  "translate",
  "tone",
] as const;
export type EditorialAction = (typeof EDITORIAL_ACTIONS)[number];

export const EDITORIAL_ACTION_LABELS: Record<EditorialAction, string> = {
  outline: "طرح کلی پیشنهادی",
  title: "عنوان",
  excerpt: "خلاصه",
  body: "متن کامل",
  rewrite: "بازنویسی",
  shorten: "کوتاه‌کردن",
  expand: "گسترش",
  translate: "ترجمه",
  tone: "تغییر لحن",
};

/** Tones the assistant can aim at; the label is what the prompt receives. */
export const EDITORIAL_TONES = [
  "formal",
  "friendly",
  "concise",
  "story",
] as const;
export type EditorialTone = (typeof EDITORIAL_TONES)[number];

export const EDITORIAL_TONE_LABELS: Record<EditorialTone, string> = {
  formal: "رسمی",
  friendly: "دوستانه",
  concise: "کوتاه و بی‌حاشیه",
  story: "روایت‌محور",
};

/** Languages the translate action may target. */
export const EDITORIAL_LANGUAGES = ["en", "ar", "tr", "fa"] as const;
export type EditorialLanguage = (typeof EDITORIAL_LANGUAGES)[number];

export const EDITORIAL_LANGUAGE_LABELS: Record<EditorialLanguage, string> = {
  fa: "فارسی",
  en: "انگلیسی",
  ar: "عربی",
  tr: "ترکی",
};

/** The bounds the route and the editor share, so a request cannot outgrow what the mirror holds. */
export const EDITORIAL_LIMITS = {
  title: 200,
  excerpt: 1000,
  /** The body is Gutenberg HTML; same ceiling the editor applies. */
  content: 40000,
  instruction: 300,
  keywords: 300,
} as const;

export interface EditorialRequest {
  action: EditorialAction;
  /** The post/page title as the editor holds it (may be empty for a new page). */
  title?: string | null;
  /** The body as the editor holds it — Gutenberg HTML, verbatim. */
  content?: string | null;
  excerpt?: string | null;
  tone?: EditorialTone | null;
  language?: EditorialLanguage | null;
  /** A one-line steer from the owner. */
  instruction?: string | null;
  /** Optional SEO keywords the owner wants the draft to work in. */
  keywords?: string | null;
}

export interface EditorialDraft {
  /** The text the action produces — plain text, never HTML. */
  text: string;
}

export function isEditorialAction(value: unknown): value is EditorialAction {
  return typeof value === "string" && (EDITORIAL_ACTIONS as readonly string[]).includes(value);
}

export function isEditorialTone(value: unknown): value is EditorialTone {
  return typeof value === "string" && (EDITORIAL_TONES as readonly string[]).includes(value);
}

export function isEditorialLanguage(value: unknown): value is EditorialLanguage {
  return typeof value === "string" && (EDITORIAL_LANGUAGES as readonly string[]).includes(value);
}

const SYSTEM_PROMPT = [
  "تو دستیار تحریریهٔ یک کسب‌وکار ایرانی هستی و به فارسی روشن و درست می‌نویسی.",
  "فقط از اطلاعاتی استفاده کن که در متن کاربر آمده است.",
  "هیچ واقعیت تازه‌ای نساز: نه جایزه، نه مجوز، نه گارانتی، نه قیمت، نه تاریخ، نه نام شخص یا مرجع، نه آمار.",
  "اگر متن کافی نیست، کوتاه و ساده بنویس و کمبود را با جمله‌های تزئینی پر نکن.",
  "خروجی، متن ساده است: بدون HTML، بدون مارک‌داون، بدون ایموجی و بدون نقل‌قول دور متن.",
  "فقط کار خواسته‌شده را انجام بده؛ عنوان و متن را همزمان بازنویسی نکن مگر اینکه صریحاً خواسته شود.",
  'پاسخ را فقط به صورت یک شیء JSON بده: {"text":"…"}.',
].join("\n");

/** What each action is asked to do with the material it is given. */
function instructionFor(request: EditorialRequest): string {
  switch (request.action) {
    case "outline":
      return "برای این موضوع یک طرح کلی با ۳ تا ۶ سرفصل کوتاه بنویس، هر سرفصل در یک خط.";
    case "title":
      return "فقط یک عنوان پیشنهاد بده: کوتاه، روشن و بدون کلیک‌بیت؛ حداکثر ۹۰ نویسه.";
    case "excerpt":
      return "فقط یک خلاصهٔ دو تا سه جمله‌ای پیشنهاد بده که خواننده را برای خواندن متن آماده کند.";
    case "body":
      return "بر پایهٔ همین اطلاعات، متن کامل را در چند بند کوتاه بنویس.";
    case "rewrite":
      return "همین متن را بازنویسی کن: همان معنا و همان واقعیت‌ها، جمله‌بندی روان‌تر.";
    case "shorten":
      return "همین متن را کوتاه‌تر کن: تکرارها و جمله‌های تزئینی بروند، هیچ واقعیتی حذف نشود.";
    case "expand":
      return "همین متن را گسترش بده: همان واقعیت‌ها را روشن‌تر توضیح بده؛ واقعیت تازه اضافه نکن.";
    case "translate": {
      const language = request.language ? EDITORIAL_LANGUAGE_LABELS[request.language] : "انگلیسی";
      return `همین متن را به ${language} برگردان؛ نام‌های خاص و اصطلاح‌های برند را تغییر نده.`;
    }
    case "tone": {
      const tone = request.tone ? EDITORIAL_TONE_LABELS[request.tone] : "دوستانه";
      return `همین متن را با لحن «${tone}» بازنویسی کن؛ معنا و واقعیت‌ها ثابت بمانند.`;
    }
  }
}

export function buildEditorialUserPrompt(request: EditorialRequest): string {
  const lines: string[] = [instructionFor(request)];
  const add = (label: string, value: string | null | undefined, max: number) => {
    const text = value?.trim();
    if (text) lines.push(`${label}: ${text.slice(0, max)}`);
  };
  add("عنوان فعلی", request.title, EDITORIAL_LIMITS.title);
  add("خلاصهٔ فعلی", request.excerpt, EDITORIAL_LIMITS.excerpt);
  add("متن فعلی", request.content, EDITORIAL_LIMITS.content);
  add("کلیدواژه‌های دلخواه", request.keywords, EDITORIAL_LIMITS.keywords);
  add("دستور مالک", request.instruction, EDITORIAL_LIMITS.instruction);
  return lines.join("\n");
}

export const EDITORIAL_SYSTEM_PROMPT = SYSTEM_PROMPT;

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

/**
 * Reads the draft out of a model reply.
 *
 * A reply that is not the documented object is *not* salvaged into a draft: an
 * unparsed answer shown as text is exactly the invented-content risk this
 * feature must not have. The one concession is a bare reply with no JSON at all
 * (some models ignore the shape) — it is accepted only when it is plain text,
 * because there the model did the work and simply answered directly.
 */
export function parseEditorialReply(raw: string): EditorialDraft | null {
  const parsed = extractJsonObject(raw);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).text;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return { text };
    }
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("{") || trimmed.includes("}")) return null;
  return { text: trimmed };
}
