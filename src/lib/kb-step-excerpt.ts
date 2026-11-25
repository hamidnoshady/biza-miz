/**
 * Turn one published Knowledge Base article into the few lines a wizard step
 * shows inline (issue #1239 / ESH-90).
 *
 * The «راه‌اندازی اولیه» article describes every step as a numbered line whose
 * bold heading is the step's own title — `**اطلاعات کسب‌وکار** — …`. That shape
 * is already pinned by `setup-wizard-knowledge.test.ts`, so it is the contract
 * this extractor relies on rather than a second, parallel set of copy.
 *
 * Pure and dependency-free: the service hands it the published Markdown, the
 * API hands the result to the step, and a unit test pins the edges without a
 * database.
 */

/** Markdown that should never appear in a one-line help excerpt. */
function stripInlineMarkdown(text: string): string {
  return text
    // A leading list number/bullet, e.g. `3. ` or `- `.
    .replace(/^\s*(?:\d+[.)]|[-*])\s+/, "")
    // Links keep their label: the URL is not useful inline.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Bold/italic/code emphasis.
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "")
    .trim();
}

/**
 * Sentences in the excerpt's own language. Persian uses `.`, `؟` and `!`;
 * a Latin fallback covers an English translation of the same article.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!؟?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * The paragraph that describes `marker`, split into at most `maxLines`
 * sentences. An unknown marker, an empty body or a heading with no prose
 * answers `[]` — the caller then keeps its local fallback, which is the
 * offline-safe layer.
 */
export function extractGuideStepLines(
  bodyMarkdown: string,
  marker: string,
  maxLines = 4,
): string[] {
  if (!bodyMarkdown || !marker) return [];
  const needle = `**${marker}**`;
  const line = bodyMarkdown
    .split(/\r?\n/)
    .find((candidate) => candidate.includes(needle));
  if (!line) return [];

  // Drop the heading itself: the step already prints its own title above the
  // help, so repeating it wastes a line.
  const afterHeading = line.slice(line.indexOf(needle) + needle.length);
  const prose = stripInlineMarkdown(afterHeading.replace(/^\s*[—–:-]\s*/, ""));
  if (!prose) return [];

  return splitSentences(prose).slice(0, Math.max(1, maxLines));
}
