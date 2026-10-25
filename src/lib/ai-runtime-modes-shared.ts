/**
 * Issue #812 §7 — the three user-facing AI runtime modes, as pure vocabulary.
 *
 * Split from `ai-runtime-modes.ts` so the browser can name a mode, label it and
 * normalize a stored value without pulling the database layer into the client
 * bundle. The platform's configured aliases live in `ai-runtime-modes.ts`.
 *
 * Thinking is a real LiteLLM model-profile choice, separate from the bounded
 * and cost-approved Deep Research workflow.
 */
export const AI_RUNTIME_MODES = ["auto", "instant", "thinking", "deep_research"] as const;
export type AiRuntimeMode = (typeof AI_RUNTIME_MODES)[number];
/** The three everyday chat modes; Deep Research remains a separate workflow. */
export const AI_CHAT_MODES = ["auto", "instant", "thinking"] as const;

/** Persian labels for the mode picker. */
export const AI_MODE_LABELS: Record<AiRuntimeMode, string> = {
  auto: "خودکار",
  instant: "سریع",
  thinking: "تفکر عمیق",
  deep_research: "پژوهش عمیق",
};

/** One line under each label in the picker. */
export const AI_MODE_HINTS: Record<AiRuntimeMode, string> = {
  auto: "پاسخ عمومی و دقیق، با ابزارهای لازم",
  instant: "سریع‌ترین پاسخ با کمترین رفت‌وبرگشت ابزار",
  thinking: "پاسخ تحلیلی با مدل اختصاصی تنظیم‌شده توسط مدیر پلتفرم",
  deep_research: "پژوهش جداگانه و هزینه‌دار، با نتیجهٔ مستندشده",
};

/** The default mode when a request names none, or names a retired one. */
export const DEFAULT_AI_MODE: AiRuntimeMode = "auto";

export function isAiRuntimeMode(value: unknown): value is AiRuntimeMode {
  return typeof value === "string" && (AI_RUNTIME_MODES as readonly string[]).includes(value);
}

/**
 * Resolves a stored/requested mode value. Unknown or stale values become
 * `auto` instead of selecting an arbitrary provider.
 */
export function normalizeAiRuntimeMode(value: unknown): AiRuntimeMode {
  return isAiRuntimeMode(value) ? value : DEFAULT_AI_MODE;
}

/** Whether a member may select this mode at all right now. */
export function isAiRuntimeModeAvailable(mode: AiRuntimeMode, deepResearchEnabled: boolean): boolean {
  if (mode === "deep_research") return deepResearchEnabled;
  return true;
}

