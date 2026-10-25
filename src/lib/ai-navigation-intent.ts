/**
 * Conservative client-navigation intent gate. A tool-calling model is not
 * permitted to turn an informational "where/how" question into browser motion.
 * False negatives are safe: assistant can supply a registered link instead.
 */
export function explicitlyRequestedPageNavigation(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  const input = raw.normalize("NFKC").toLocaleLowerCase("fa")
    .replace(/[ي]/g, "ی").replace(/[ك]/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (/\b(?:open|navigate(?:\s+to)?|go\s+to|take\s+me\s+to|switch\s+to|jump\s+to)\b/i.test(input)) return true;
  return /(?:باز\s+(?:کن|کنید|بکن|بکنید)|برو\s+(?:به|تو|داخل)|برید\s+(?:به|تو|داخل)|ببر(?:م|\s+من(?:و|\s+را)?)?\s+(?:به|تو|داخل)|هدایتم\s+کن|منتقل(?:م)?\s+کن|وارد\s+(?:شو|بشو|شوید))/u.test(input);
}
