/** Product-facing reasoning modes. Provider/model aliases stay platform-owned. */
export const AI_REASONING_MODES = ["auto", "instant", "thinking", "deep_research"] as const;
export type AiReasoningMode = (typeof AI_REASONING_MODES)[number];

export const AI_MODE_LABELS: Record<AiReasoningMode, string> = {
  auto: "خودکار",
  instant: "فوری",
  thinking: "تحلیلی",
  deep_research: "پژوهش عمیق",
};

/** Deep research is deliberately unavailable until a tenant-safe web research
 * runtime exists. A label must never imply capabilities the backend lacks. */
export const AI_MODE_DIRECTIVES: Record<AiReasoningMode, string> = {
  auto: "حالت پاسخ‌گویی را متناسب با سؤال انتخاب کن و پاسخ را کوتاه و grounded نگه دار.",
  instant: "حالت فوری: با کمترین رفت‌وبرگشت ابزار، پاسخ کوتاه و دقیق بده؛ دادهٔ واقعی را فدای سرعت نکن.",
  thinking: "حالت تحلیلی: قبل از پاسخ داده‌های لازم را از ابزارهای مجاز جمع کن و نتیجه را با چند نکتهٔ روشن توضیح بده.",
  deep_research: "",
};

export function isAiReasoningMode(value: unknown): value is AiReasoningMode {
  return typeof value === "string" && (AI_REASONING_MODES as readonly string[]).includes(value);
}

export function isAiReasoningModeAvailable(value: AiReasoningMode): boolean {
  return value !== "deep_research";
}
