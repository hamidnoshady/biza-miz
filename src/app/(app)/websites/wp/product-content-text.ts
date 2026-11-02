/**
 * The readable text of a storefront description, for the preview tab
 * (issue #1215, P1-2).
 *
 * WooCommerce stores a description as Gutenberg HTML. The editor keeps that
 * HTML verbatim — blocks, classes and inline styles included — because
 * round-tripping anything less would silently rewrite the owner's page. The
 * *preview* only needs to say "this is the text a shopper reads", so it strips
 * the markup to plain text.
 *
 * It is deliberately not a sanitizer and must never be used to emit HTML:
 * nothing here is ever rendered with `dangerouslySetInnerHTML`.
 */
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#8217;": "’",
  "&#8216;": "‘",
  "&#8220;": "“",
  "&#8221;": "”",
  "&hellip;": "…",
  "&mdash;": "—",
  "&ndash;": "–",
};

export function storefrontText(html: string | null | undefined): string {
  if (!html) return "";
  let text = String(html)
    // Scripts and styles are markup, not copy a shopper reads.
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // Block ends and line breaks become newlines, so paragraphs stay apart.
    .replace(/<\/(?:p|div|section|li|h[1-6]|blockquote|figure|figcaption|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Everything else is a tag; its content stays.
    .replace(/<[^>]*>/g, "");
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(replacement);
  }
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether the store's HTML carries any markup worth warning the editor about. */
export function looksLikeHtml(value: string | null | undefined): boolean {
  return typeof value === "string" && /<[a-z!/][^>]*>/i.test(value);
}
