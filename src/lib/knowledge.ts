/**
 * The in-product knowledge base — the pure half.
 *
 * Migration 0131 stores the knowledge base the super-admin maintains (the
 * console at /platform/knowledge writes it; member routes under /api/knowledge
 * read it; «مرکز آموزش» at /dashboard/knowledge displays it). Everything here
 * is pure: no database, no request context, so both realms — and the unit
 * tests — share exactly these rules.
 *
 * What lives here:
 *
 *  - Slugs. Article/category/tag slugs are ASCII (`pos-basics`), because they
 *    become URL path segments; a Persian title alone suggests no slug, so the
 *    console either auto-suggests from latin characters or asks the operator.
 *  - Heading anchors. Every article heading gets a stable id derived from its
 *    text (Persian-aware, GitHub-style), so a guide can deep-link «#بستن-صندوق»
 *    and the «در این صفحه» table of contents is computed with the same code
 *    that renders the headings — the two can never disagree.
 *  - Media. An article's video is either a direct file (`.mp4`/…) rendered as
 *    a player, or a page on a video host (Aparat/YouTube/…) rendered as an
 *    embed; the kind is decided here so the console preview and the member
 *    view agree.
 *  - Plain-text extraction for search snippets and summaries.
 *
 * Types shared by the API payloads live here too, so the console editor, the
 * member centre and the routes all speak one shape.
 */

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/** Slugs are URL path segments: lowercase Latin, digits, single dashes. */
export const KB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isKbSlug(value: string): boolean {
  return KB_SLUG_PATTERN.test(value);
}

/**
 * Suggest a slug from a title. Keeps only `[a-z0-9 -]`, so a fully Persian
 * title yields "" and the caller must ask for (or invent) a slug — slugs are
 * URLs, and a URL made of stripped-to-nothing text is worse than no guess.
 */
export function suggestKbSlug(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return isKbSlug(base) ? base : "";
}

// ---------------------------------------------------------------------------
// Heading anchors ("anchor text to titles")
// ---------------------------------------------------------------------------

export interface KbHeading {
  /** Markdown depth: 2 for `##`, 3 for `###`, 4 for `####`. */
  depth: number;
  /** The heading text, stripped of inline markdown marks. */
  text: string;
  /** The anchor id the renderer assigns to the heading element. */
  id: string;
  /**
   * 1-based source line of the heading — how the markdown renderer matches an
   * AST heading node (`node.position.start.line`) to the anchor computed
   * here, so a heading quoted inside a blockquote simply gets no anchor
   * instead of shifting every later id.
   */
  line: number;
}

/**
 * Persian-aware anchor slug: lowercase, strip diacritics and punctuation,
 * ZWNJ (نیم‌فاصله) and whitespace become dashes, Persian/Arabic letters and
 * digits are kept as-is (URL fragments percent-encode them harmlessly).
 */
export function kbHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[ً-ْ]/g, "") // Arabic diacritics (تشکیل)
    .replace(/‌/g, "-") // ZWNJ
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/[\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The headings of a markdown document, in order, each with the unique anchor
 * id the renderer will give it (duplicates get `-2`, `-3`, …). Headings
 * inside fenced code blocks are not headings; ATX (`#`) headings only, since
 * that is the only spelling the editor toolbar and the seed content use, and
 * only `##`–`####` count — `#` is the article title itself in this system.
 */
export function kbHeadings(markdown: string): KbHeading[] {
  const headings: KbHeading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence) continue;
    const m = line.match(/^(#{2,4})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const depth = m[1].length;
    const text = stripInlineMarkdown(m[2]);
    const base = kbHeadingSlug(text) || "section";
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    headings.push({ depth, text, id: count === 1 ? base : `${base}-${count}`, line: i + 1 });
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Rich media
// ---------------------------------------------------------------------------

/** A video the UI can render: a file (player) or a page (iframe embed). */
export type KbVideoKind = "file" | "embed";

/**
 * Where a video URL actually points, with the URL the UI must load.
 *
 * Only hosts whose embed contract is known are turned into iframes: a random
 * http(s) URL is not an embeddable video, and `X-Frame-Options`/CSP would
 * either blank the frame or (worse) trust whatever the editor pasted. Direct
 * video files still play from any host. Everything else returns null and the
 * article view shows an explicit «open externally» link instead of a frame.
 */
export type KbVideoSource =
  | { kind: "file"; src: string; provider: "file" }
  | { kind: "embed"; src: string; provider: "youtube" | "aparat" | "vimeo"; externalUrl: string };

const VIDEO_FILE_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg)$/i;

/** YouTube ids are 11-char base64url-ish; accept a slightly wider bound. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
const VIMEO_ID = /^\d{4,12}$/;
const APARAT_HASH = /^[A-Za-z0-9]{4,40}$/;

function youtubeId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "watch") {
    const id = parsed.searchParams.get("v") ?? "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") {
    const id = parts[1] ?? "";
    return YOUTUBE_ID.test(id) ? id : null;
  }
  return null;
}

function aparatHash(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "aparat.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  // /v/<hash> and /video/video/embed/videohash/<hash>/vt/frame
  if (parts[0] === "v" && parts[1]) {
    const hash = parts[1].replace(/[^A-Za-z0-9]/g, "");
    return APARAT_HASH.test(hash) ? hash : null;
  }
  const at = parts.indexOf("videohash");
  if (at !== -1 && parts[at + 1]) {
    const hash = parts[at + 1];
    return APARAT_HASH.test(hash) ? hash : null;
  }
  return null;
}

function vimeoId(parsed: URL): string | null {
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "vimeo.com") {
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return VIMEO_ID.test(id) ? id : null;
  }
  if (host === "player.vimeo.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    const id = parts[0] === "video" ? (parts[1] ?? "") : "";
    return VIMEO_ID.test(id) ? id : null;
  }
  return null;
}

/**
 * Resolve a media URL to the exact source the page should load.
 *
 *  - a direct video file (`.mp4`/`.webm`/…) keeps its URL and renders a player;
 *  - a known video host page converts to that host's embed URL (YouTube watch
 *    links become `youtube-nocookie.com/embed/<id>`, Aparat `v/<hash>` becomes
 *    its `videohash` frame, Vimeo becomes `player.vimeo.com/video/<id>`);
 *  - anything else is null — callers show the raw URL as an external link
 *    rather than framing a host we have no embed contract with.
 */
export function kbVideoSource(url: string): KbVideoSource | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  if (VIDEO_FILE_EXT.test(parsed.pathname)) {
    return { kind: "file", src: parsed.toString(), provider: "file" };
  }
  const youtube = youtubeId(parsed);
  if (youtube) {
    return {
      kind: "embed",
      provider: "youtube",
      src: `https://www.youtube-nocookie.com/embed/${youtube}?rel=0`,
      externalUrl: parsed.toString(),
    };
  }
  const aparat = aparatHash(parsed);
  if (aparat) {
    return {
      kind: "embed",
      provider: "aparat",
      src: `https://www.aparat.com/video/video/embed/videohash/${aparat}/vt/frame`,
      externalUrl: parsed.toString(),
    };
  }
  const vimeo = vimeoId(parsed);
  if (vimeo) {
    return {
      kind: "embed",
      provider: "vimeo",
      src: `https://player.vimeo.com/video/${vimeo}`,
      externalUrl: parsed.toString(),
    };
  }
  return null;
}

/**
 * Classify a media URL. Returns null for anything that is not a clean,
 * embeddable http(s) URL — the editor stores "" and treats that as "no video".
 * Direct files get the native player; supported hosts get a converted iframe
 * URL (see `kbVideoSource`).
 */
export function kbVideoKind(url: string): KbVideoKind | null {
  return kbVideoSource(url)?.kind ?? null;
}

/** An http(s) URL, trimmed — null for anything else (or ""). */
export function parseHttpUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search normalization (Persian/Arabic variants)
// ---------------------------------------------------------------------------

/**
 * The longest query the search route accepts. Anything longer is almost
 * certainly a paste accident, and tsquery parsing over an unbounded string is
 * an unnecessary cost.
 */
export const KB_SEARCH_MAX_LENGTH = 200;

const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const SEARCH_DIGITS = "0123456789";

/**
 * Fold the spelling variants Persian text mixes in daily so one index answers
 * every form:
 *
 *  - Arabic Yeh/Kaf (ي ي ك) → Persian ی/ک, and ة/ۀ → ه;
 *  - Persian (۰…) and Arabic-Indic (٠…) digits → ASCII digits;
 *  - ZWNJ (نیم‌فاصله) → a space, tatweel and Arabic diacritics dropped;
 *  - Latin case, repeated whitespace and leading/trailing space normalised.
 *
 * Migration 0233 mirrors this in SQL (`kb_normalize_search`) and indexes the
 * folded document, so `جستجوی` and `جستجوي` hit the same stored article.
 */
export function normalizeKbSearchText(input: string): string {
  const out = input
    .toLowerCase()
    .replace(/\u0640/g, "") // tatweel
    .replace(/[\u064b-\u0655\u0670]/g, "") // Arabic diacritics (تشکیل), incl. hamza above/below
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ه")
    .replace(/\u200c/g, " ");
  let digits = "";
  for (const ch of out) {
    const persian = PERSIAN_DIGITS.indexOf(ch);
    const arabic = ARABIC_DIGITS.indexOf(ch);
    digits += persian !== -1 ? SEARCH_DIGITS[persian] : arabic !== -1 ? SEARCH_DIGITS[arabic] : ch;
  }
  return digits.replace(/\s+/g, " ").trim();
}

/**
 * Spellings of one query term that should highlight together: the term, its
 * normalized form, and its Arabic/Persian Yeh-Kaf and digit variants. Used by
 * the highlighter only (matching happens in SQL); bounded so a pathological
 * query cannot explode into thousands of regex alternatives.
 */
export function kbSearchTermVariants(term: string): string[] {
  const base = term.trim();
  if (!base) return [];
  const variants = new Set<string>([base]);
  const swap = (from: string, to: string) => {
    for (const value of [...variants]) variants.add(value.split(from).join(to));
  };
  swap("ی", "ي");
  swap("ی", "ى");
  swap("ي", "ی");
  swap("ى", "ی");
  swap("ک", "ك");
  swap("ك", "ک");
  for (const value of [...variants]) {
    if (/[0-9]/.test(value)) {
      variants.add(
        value.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d),
      );
      variants.add(
        value.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)] ?? d),
      );
    }
    const space = value.replace(/\s+/g, " ");
    variants.add(space);
    variants.add(space.replace(/ /g, "\u200c"));
  }
  return [...variants].filter(Boolean).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Markdown → plain text (search snippets, summary fallback)
// ---------------------------------------------------------------------------

/** Strip inline emphasis/link/code marks so a heading or snippet reads clean. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link → label
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\W)\*([^*\n]+)\*(?!\*)/g, "$1$2") // italic
    .replace(/(^|\W)_([^_\n]+)_(?!_)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/**
 * Collapse a markdown document to searchable plain text: fence markers and
 * list/quote/table punctuation drop out, code and prose stay. Good enough for
 * a snippet around a hit; not a rendering engine (that is react-markdown).
 */
export function stripMarkdown(markdown: string): string {
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1].slice(0, 3);
      fence = fence === marker ? null : fence ?? marker;
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    // Headings and table separator rows lose their markup; images keep alt.
    const cleaned = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/^\|?(?:\s*:?-+:?\s*\|)+\s*$/, "");
    const text = stripInlineMarkdown(cleaned).trim();
    if (text) out.push(text);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function snippetWindow(text: string, at: number, needleLength: number, radius: number): string {
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + needleLength + radius);
  const snippet = text.slice(from, to).trim();
  return `${from > 0 ? "…" : ""}${snippet}${to < text.length ? "…" : ""}`;
}

/**
 * A short window of plain text around the first occurrence of `query`,
 * marked with … when clipped. Falls back to the leading window when the
 * query is absent or not found (e.g. the hit was in the title only).
 *
 * Matching is repeated after `normalizeKbSearchText`, so a query typed with
 * Arabic Yeh/Kaf or Latin digits still finds a Persian-spelled body; the
 * window then shows the normalized text (a literal hit keeps the original).
 */
export function kbSnippet(text: string, query: string, radius = 90): string {
  const haystack = text.toLowerCase();
  const needle = query.trim().toLowerCase();
  const at = needle ? haystack.indexOf(needle) : -1;
  if (at !== -1) return snippetWindow(text, at, needle.length, radius);

  const foldedText = normalizeKbSearchText(text);
  const foldedNeedle = normalizeKbSearchText(query);
  const foldedAt = foldedNeedle ? foldedText.indexOf(foldedNeedle) : -1;
  if (foldedAt !== -1) return snippetWindow(foldedText, foldedAt, foldedNeedle.length, radius);

  const head = text.slice(0, radius * 2).trimEnd();
  return head.length < text.length ? `${head}…` : head;
}

/** Split `text` into segments, each flagged hit/miss against every query term. */
export interface KbHighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Highlight every occurrence of the query's terms (Persian words included),
 * case-insensitively, so the search list can wrap hits in <mark>. Terms are
 * regex-escaped — a query of "(" highlights literally instead of throwing —
 * and each term also matches its Arabic/Persian spelling variants, the same
 * folding the search index applies.
 */
export function kbHighlightSegments(text: string, query: string): KbHighlightSegment[] {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => kbSearchTermVariants(t))
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length || !text) return [{ text, hit: false }];
  // Longest first so an exact term wins over a shorter variant prefix.
  const pattern = new RegExp(`(${[...new Set(terms)].sort((a, b) => b.length - a.length).join("|")})`, "giu");
  const segments: KbHighlightSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: text.slice(last, index), hit: false });
    segments.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), hit: false });
  return segments.length ? segments : [{ text, hit: false }];
}

// ---------------------------------------------------------------------------
// The category tree (the member side menu, the console's category builder)
// ---------------------------------------------------------------------------

export interface KbCategoryFlat {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder: number;
}

export interface KbCategoryNode extends KbCategoryFlat {
  children: KbCategoryNode[];
}

/**
 * Nest the flat category list into a tree.
 *
 * Every level sorts by sort_order then title. The builder is defensive against
 * the one shape the server now rejects (a parent chain that loops back): a
 * cycle would otherwise leave every member of it without a root and make the
 * whole branch vanish. Each chain is walked once with a visited set; the edge
 * that closes a loop is cut and its node becomes a root, so every category in
 * the input appears exactly once and a hand-edited database still renders.
 * The traversal is iterative — a deep tree cannot overflow the call stack.
 */
export function buildKbCategoryTree(flat: readonly KbCategoryFlat[]): KbCategoryNode[] {
  const byId = new Map(
    flat.map((c) => [c.id, { ...c, parentId: c.parentId, children: [] as KbCategoryNode[] }]),
  );
  if (byId.size === 0) return [];

  // 1) Break cycles deterministically. `visiting` only ever holds the chain of
  // the node currently being walked, so a repeat is a real cycle, not a DAG.
  const done = new Set<string>();
  for (const start of byId.values()) {
    if (done.has(start.id)) continue;
    const chain: KbCategoryNode[] = [];
    const visiting = new Set<string>();
    let current: KbCategoryNode | undefined = start;
    while (current && !done.has(current.id)) {
      if (visiting.has(current.id)) {
        // Cut the edge that closes the loop: this node becomes a root.
        current.parentId = null;
        break;
      }
      visiting.add(current.id);
      chain.push(current);
      const parentId: string | null = current.parentId;
      current = parentId ? byId.get(parentId) : undefined;
    }
    for (const node of chain) done.add(node.id);
  }

  // 2) Attach each node to its parent; orphans (and cut cycles) are roots.
  const roots: KbCategoryNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  // 3) Sort every level iteratively (a deep branch must not overflow).
  const stack: KbCategoryNode[][] = [roots];
  while (stack.length) {
    const level = stack.pop()!;
    level.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "fa"));
    for (const node of level) if (node.children.length) stack.push(node.children);
  }
  return roots;
}

/**
 * The ancestor ids of `categoryId`, outermost first, cycle-safe.
 *
 * The side menu uses this to open every branch that contains the article
 * being read — not just the immediate parent, which would leave the root and
 * middle folders collapsed.
 */
export function kbCategoryAncestors(
  flat: readonly KbCategoryFlat[],
  categoryId: string | null,
): string[] {
  if (!categoryId) return [];
  const byId = new Map(flat.map((c) => [c.id, c]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(categoryId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    const parentId: string | null = current.parentId;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return chain.reverse();
}

// ---------------------------------------------------------------------------
// Deep links to headings
// ---------------------------------------------------------------------------

/**
 * The element id a URL fragment names. Browsers hand `location.hash` over
 * percent-encoded (Persian heading ids contain non-ASCII letters), but a
 * hand-written or double-encoded link can carry the raw form; decoding is
 * attempted and the raw value kept when it is malformed.
 */
export function decodeKbHeadingHash(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve a fragment to the heading the document actually renders. Exact ids
 * win (including the `-2` suffix of a repeated heading); a fragment written
 * with a different dash/space spelling falls back to the heading slug, and a
 * fragment that matches no heading returns null so no wrong section is
 * scrolled to.
 */
export function kbHeadingTargetForHash(
  hash: string,
  headings: readonly Pick<KbHeading, "id" | "text">[],
): string | null {
  const wanted = decodeKbHeadingHash(hash).trim();
  if (!wanted) return null;
  const exact = headings.find((h) => h.id === wanted);
  if (exact) return exact.id;
  // A link can be written from the heading *text* (`#تسویهٔ چندگانه`) while the
  // rendered id is its slug (`تسویه-چندگانه`). Fold both sides the same way —
  // including the combining hamza that `kbHeadingSlug` drops — instead of
  // comparing a raw fragment with a slugified one.
  const fold = (value: string) => normalizeKbSearchText(value).replace(/\s+/g, "-");
  const folded = fold(wanted);
  const byText = headings.find(
    (h) =>
      h.id === wanted ||
      fold(h.id) === folded ||
      fold(h.text) === folded ||
      kbHeadingSlug(h.text) === folded,
  );
  return byText?.id ?? null;
}

/** How far below the viewport top a heading lands (the sticky header height). */
export const KB_HEADING_SCROLL_OFFSET = 96;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Scroll to a heading id with the sticky header offset, writing the hash so
 * the link stays shareable. Returns false when the heading is not mounted
 * yet (the article view retries after the async body renders).
 */
export function scrollToKbHeading(
  id: string,
  options: { updateHash?: boolean; smooth?: boolean } = {},
): boolean {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(id);
  if (!element) return false;
  const behavior: ScrollBehavior = options.smooth && !prefersReducedMotion() ? "smooth" : "auto";
  const top = element.getBoundingClientRect().top + window.scrollY - KB_HEADING_SCROLL_OFFSET;
  window.scrollTo({ top: Math.max(0, top), behavior });
  if (options.updateHash !== false) {
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// API payload shapes (member side)
// ---------------------------------------------------------------------------

export interface KbTagRef {
  slug: string;
  label: string;
}

export interface KbArticleListItem {
  id: string;
  slug: string;
  title: string;
  summary: string;
  categoryId: string | null;
  sectionKeys: string[];
  tags: KbTagRef[];
  hasVideo: boolean;
  hasCover: boolean;
  sortOrder: number;
  updatedAt: string;
}

export interface KbArticleDetail extends KbArticleListItem {
  bodyMd: string;
  videoUrl: string;
  videoKind: KbVideoKind | null;
  coverImageUrl: string;
  publishedAt: string | null;
  related: KbArticleListItem[];
}

export interface KbCataloguePayload {
  categories: KbCategoryFlat[];
  articles: KbArticleListItem[];
  tags: KbTagRef[];
}

export interface KbSearchHit {
  slug: string;
  title: string;
  summary: string;
  snippet: string;
  categoryTitle: string | null;
  tags: KbTagRef[];
  updatedAt: string;
}

/** Section keys a stored string array may claim, validated against the catalogue. */
export function normalizeSectionKeys(value: unknown, knownKeys: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (trimmed && knownKeys.has(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}
