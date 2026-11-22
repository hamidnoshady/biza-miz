/**
 * Issue #812 §7 — the chat profiles and the retired research vocabulary.
 *
 * Split from `ai-runtime-modes.ts` so the browser can name a mode, label it and
 * normalize a stored value without pulling the database layer into the client
 * bundle. The platform's configured aliases live in `ai-runtime-modes.ts`.
 *
 * Issue #1367 — Deep Research is retired as a separate product experience and
 * **is not** the Thinking chat mode. The value `deep_research` is deliberately
 * kept in `AI_RUNTIME_MODES` and in the label maps so historical rows, prompt
 * scopes and settlements keep a meaning; it is removed from `AI_CHAT_MODES` and
 * `isAiRuntimeModeAvailable` reports it unavailable, so no new turn and no new
 * configuration can select it. Auto, Fast (instant) and Thinking are the three
 * modes the product still offers.
 */
export const AI_CHAT_MODES = ["auto", "instant", "thinking"] as const;

/** Modes that are no longer offered, kept only so history resolves. */
export const AI_RETIRED_MODES = ["deep_research"] as const;

/**
 * Every value a stored row may contain: the three active chat modes plus the
 * retired ones. Never use this list to build a picker — use `AI_CHAT_MODES`.
 */
export const AI_RUNTIME_MODES = [...AI_CHAT_MODES, ...AI_RETIRED_MODES] as const;

export type AiRuntimeMode = (typeof AI_RUNTIME_MODES)[number];

/** Persian labels for the mode picker and for historical rows. */
export const AI_MODE_LABELS: Record<AiRuntimeMode, string> = {
  auto: "خودکار",
  instant: "سریع",
  thinking: "تفکر عمیق",
  deep_research: "پژوهش عمیق (بازنشسته)",
};

/** One line under each label in the picker. */
export const AI_MODE_HINTS: Record<AiRuntimeMode, string> = {
  auto: "پاسخ عمومی و دقیق، با ابزارهای لازم",
  instant: "سریع‌ترین پاسخ با کمترین رفت‌وبرگشت ابزار",
  thinking: "پاسخ تحلیلی با مدل اختصاصی تنظیم‌شده توسط مدیر پلتفرم",
  deep_research: "پژوهش جداگانه و هزینه‌دار؛ بازنشسته شده و اجرای تازه ندارد",
};

/** The default mode when a request names none, or names an unknown one. */
export const DEFAULT_AI_MODE: AiRuntimeMode = "auto";

export function isAiRuntimeMode(value: unknown): value is AiRuntimeMode {
  return typeof value === "string" && (AI_RUNTIME_MODES as readonly string[]).includes(value);
}

/** True for a mode that exists only so historical rows keep their meaning. */
export function isRetiredAiRuntimeMode(value: unknown): boolean {
  return typeof value === "string" && (AI_RETIRED_MODES as readonly string[]).includes(value);
}

/**
 * The first retired mode in a list, or null. Configuration writes use this to
 * refuse a retired mode explicitly instead of silently dropping it, so an
 * operator is told the truth about what they just tried to save.
 */
export function firstRetiredAiRuntimeMode(values: readonly unknown[]): string | null {
  for (const value of values) {
    if (isRetiredAiRuntimeMode(value)) return String(value);
  }
  return null;
}

/**
 * Resolves a stored/requested mode value. Unknown or stale values become
 * `auto` instead of selecting an arbitrary provider. A *retired* value is NOT
 * silently remapped: callers that accept a request body must reject it first
 * (see the chat route), because turning Deep Research into Auto or Thinking
 * would misrepresent what the user asked for. This function only normalizes
 * storage and display values.
 */
export function normalizeAiRuntimeMode(value: unknown): AiRuntimeMode {
  return isAiRuntimeMode(value) ? value : DEFAULT_AI_MODE;
}

/**
 * Whether a member may select this mode for new work. Retired modes are always
 * unavailable, whatever a platform settings row still says.
 */
export function isAiRuntimeModeAvailable(mode: AiRuntimeMode): boolean {
  return !isRetiredAiRuntimeMode(mode);
}

export type AiRuntimeModeRequest =
  | { ok: true; mode: AiRuntimeMode }
  | { ok: false; reason: "retired" };

/**
 * Issue #1367 — the decision a request body's `runtimeMode` gets.
 *
 * A retired value is REFUSED, not normalized: answering a `deep_research`
 * request with Auto or Thinking would silently substitute a different product,
 * and would hide a client that still believes the workflow exists. Any other
 * unknown value keeps the long-standing fallback to Auto.
 */
export function resolveRequestedAiRuntimeMode(value: unknown): AiRuntimeModeRequest {
  if (isRetiredAiRuntimeMode(value)) return { ok: false, reason: "retired" };
  return { ok: true, mode: normalizeAiRuntimeMode(value) };
}
