/**
 * GH #1567 F5 — embedded media is refused, never stored and never silently
 * stripped.
 *
 * Product and menu text (descriptions, Gutenberg HTML, import cells, synced
 * storefront copy, AI drafts) must reference images through the media library
 * (`media_assets.id`) or an authorised URL — never by carrying the bytes
 * inline. A `data:` URI or a raw base64 blob bloats every row, every sync
 * payload and every backup, bypasses the media pipeline's type/size checks
 * (an inline SVG is script) and survives into the storefront unreviewed.
 *
 * The detector is deliberately bypass-resistant: it looks through HTML
 * character references (`&#100;ata:`, `data&colon;`), percent-encoding
 * (`data%3Aimage`), JavaScript and CSS escapes (`\u0064ata:`, `\64 ata:`),
 * the whitespace/control/zero-width characters browsers ignore inside a URL
 * scheme (`da\tta:`), case, and `url(...)` / `srcset` wrappers. Raw base64 is
 * recognised by the magic prefixes of image/PDF/SVG payloads and by long runs
 * of the base64 alphabet (line-wrapped too) that no prose produces.
 *
 * Callers refuse the whole value with a reason (`embedded_media`) the user can
 * act on. Nothing here edits text: "remove the image and save" would silently
 * delete content the owner wrote.
 *
 * Pure and dependency-free so client components (editor counters, import
 * preview) can import it.
 */

export type EmbeddedMediaKind = "data_uri" | "base64_blob";

export interface EmbeddedMediaFinding {
  kind: EmbeddedMediaKind;
  /** A short, safe excerpt of what was found (never the whole payload). */
  excerpt: string;
}

/** A base64 run at least this long is a payload, not prose or an identifier. */
export const BASE64_BLOB_MIN_LENGTH = 256;
/** With a known file signature, a much shorter run is already a payload. */
export const BASE64_SIGNED_MIN_LENGTH = 64;
/** Authorised media URLs are bounded like any other reference. */
export const MEDIA_URL_MAX_LENGTH = 2048;

/** Base64 of common file signatures: PNG, JPEG, GIF, WEBP (RIFF), SVG (`<svg`, `<?xml`), PDF, BMP, ICO, AVIF/HEIC (`ftyp`). */
const BASE64_SIGNATURES = ["iVBORw0KGgo", "/9j/", "R0lGOD", "UklGR", "PHN2Zy", "PD94bWwg", "JVBERi", "Qk0", "AAABAA", "AAAAIGZ0eXA", "AAAAHGZ0eXA", "AAAAGGZ0eXA"];

const NAMED_ENTITIES: Record<string, string> = {
  colon: ":", tab: "\t", newline: "\n", sol: "/", semi: ";", comma: ",", lpar: "(", rpar: ")",
  quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " ", equals: "=", plus: "+", num: "#",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function decodePercent(text: string): string {
  return text.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeEscapes(text: string): string {
  return text
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/\\u([0-9a-f]{4})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    // CSS escape: backslash + 1–6 hex digits + optional single whitespace.
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

/** Characters a browser drops inside a URL scheme, plus invisible formatting. */
const IGNORABLE = /[\u0000-\u0020\u007f\u00ad\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g;
const HAS_IGNORABLE = new RegExp(IGNORABLE.source);

/**
 * Every decoding a browser, a WordPress filter or a JSON parser may apply,
 * repeated until the text stops changing (double-encoding), with a bound.
 */
function canonical(text: string): string {
  let current = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeEscapes(decodePercent(decodeHtmlEntities(current)));
    if (next === current) break;
    current = next;
  }
  return current;
}

const IGN = "[\\u0000-\\u0020\\u007f\\u00ad\\u180e\\u200b-\\u200f\\u2028\\u2029\\u2060-\\u2064\\ufeff]*";
/** `data:` as a URL scheme: not the tail of a longer word (`metadata:`), ignorables allowed between letters. */
const DATA_SCHEME = new RegExp(`(?<![a-z0-9.+-])d${IGN}a${IGN}t${IGN}a${IGN}:`, "gi");
/** What follows the scheme in a real data URI: a MIME type, `;base64`, a bare `;` parameter or the `,` payload. */
const DATA_TAIL = /^(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+|[a-z0-9.+-]*;base64|;|,)/i;

function excerptAround(text: string, index: number): string {
  return text.slice(Math.max(0, index), index + 40).replace(/\s+/g, " ");
}

function findDataUri(text: string): EmbeddedMediaFinding | null {
  const decoded = canonical(text);
  DATA_SCHEME.lastIndex = 0;
  for (let match = DATA_SCHEME.exec(decoded); match; match = DATA_SCHEME.exec(decoded)) {
    const tail = decoded.slice(match.index + match[0].length, match.index + match[0].length + 160).replace(IGNORABLE, "");
    if (DATA_TAIL.test(tail)) return { kind: "data_uri", excerpt: excerptAround(decoded, match.index) };
  }
  return null;
}

function isBase64Token(token: string): boolean {
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(token);
}

function looksEncoded(run: string): boolean {
  // Prose and identifiers do not mix cases and digits densely across
  // hundreds of characters with no separator.
  return /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
}

function findBase64Blob(text: string): EmbeddedMediaFinding | null {
  const decoded = canonical(text);
  // Tokens split on whitespace and on the punctuation that frames a payload
  // in HTML/JSON/CSS (quotes, brackets, `=` of an attribute, `:`/`,`).
  // An `=` splits too unless it is trailing padding (`src=iVBOR…`).
  const tokens = decoded.split(/[\s"'`<>()[\]{},:;|]+|=+(?=[^=\s"'`<>()[\]{},:;|])/).filter(Boolean);
  let run = "";
  const flush = (): EmbeddedMediaFinding | null => {
    const candidate = run;
    run = "";
    if (!candidate) return null;
    const signed = BASE64_SIGNATURES.some((sig) => candidate.startsWith(sig));
    if (signed && candidate.length >= BASE64_SIGNED_MIN_LENGTH && looksEncoded(candidate)) {
      return { kind: "base64_blob", excerpt: candidate.slice(0, 24) };
    }
    if (candidate.length >= BASE64_BLOB_MIN_LENGTH && looksEncoded(candidate)) {
      return { kind: "base64_blob", excerpt: candidate.slice(0, 24) };
    }
    return null;
  };
  for (const token of tokens) {
    const value = token;
    // Line-wrapped base64 (76/64-column) joins into one run; any other token
    // ends the run.
    if (isBase64Token(value) && value.length >= 16) {
      run += value;
      continue;
    }
    const found = flush();
    if (found) return found;
  }
  return flush();
}

/** The first embedded payload in `value`, or null. Non-strings are never media. */
export function findEmbeddedMedia(value: unknown): EmbeddedMediaFinding | null {
  if (typeof value !== "string" || value === "") return null;
  return findDataUri(value) ?? findBase64Blob(value);
}

/** Every string anywhere in a JSON-like value (import rows, sync payloads, MCP args). */
export function findEmbeddedMediaDeep(value: unknown, depth = 0): { path: string; finding: EmbeddedMediaFinding } | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    const finding = findEmbeddedMedia(value);
    return finding ? { path: "", finding } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findEmbeddedMediaDeep(value[i], depth + 1);
      if (hit) return { path: hit.path ? `${i}.${hit.path}` : String(i), finding: hit.finding };
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findEmbeddedMediaDeep(child, depth + 1);
      if (hit) return { path: hit.path ? `${key}.${hit.path}` : key, finding: hit.finding };
    }
  }
  return null;
}

/** The user-facing refusal, shared by every layer so the message is one. */
export const EMBEDDED_MEDIA_MESSAGE =
  "تصویر یا فایل جاسازی‌شده (data: یا base64) پذیرفته نمی‌شود. تصویر را در کتابخانهٔ رسانه بارگذاری کنید و از همان‌جا انتخاب کنید.";

export class EmbeddedMediaError extends Error {
  readonly code = "embedded_media";
  constructor(
    readonly field: string,
    readonly finding: EmbeddedMediaFinding,
  ) {
    super(`embedded_media:${field}`);
    this.name = "EmbeddedMediaError";
  }
}

/** Throws `EmbeddedMediaError` for the first field that carries a payload. */
export function assertNoEmbeddedMedia(fields: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(fields)) {
    const hit = findEmbeddedMediaDeep(value);
    if (hit) throw new EmbeddedMediaError(hit.path ? `${field}.${hit.path}` : field, hit.finding);
  }
}

export type MediaUrlResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: "embedded_media" | "invalid_media_url" | "media_url_too_long" | "media_url_host_not_allowed" };

/**
 * An image reference given as a URL: absolute `https:` (or `http:` for a
 * local/LAN deployment), no credentials, bounded, never `data:`/`blob:`/
 * `javascript:`/`file:`. When `allowedHosts` is given (the business's media
 * host, its connected stores), the host must be one of them or a subdomain.
 * Blank → null (no image).
 */
export function parseMediaUrl(value: unknown, options: { allowedHosts?: readonly string[] } = {}): MediaUrlResult {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, reason: "invalid_media_url" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (findEmbeddedMedia(trimmed)) return { ok: false, reason: "embedded_media" };
  if (trimmed.length > MEDIA_URL_MAX_LENGTH) return { ok: false, reason: "media_url_too_long" };
  if (HAS_IGNORABLE.test(trimmed)) return { ok: false, reason: "invalid_media_url" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_media_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid_media_url" };
  if (url.username || url.password || !url.hostname) return { ok: false, reason: "invalid_media_url" };
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = options.allowedHosts.some((entry) => {
      const h = entry.toLowerCase();
      return host === h || host.endsWith(`.${h}`);
    });
    if (!allowed) return { ok: false, reason: "media_url_host_not_allowed" };
  }
  return { ok: true, value: url.toString() };
}

export const MEDIA_URL_MESSAGES: Record<Exclude<MediaUrlResult, { ok: true }>["reason"], string> = {
  embedded_media: EMBEDDED_MEDIA_MESSAGE,
  invalid_media_url: "نشانی تصویر باید یک پیوند کامل https باشد.",
  media_url_too_long: "نشانی تصویر بیش از حد طولانی است.",
  media_url_host_not_allowed: "این نشانی تصویر از دامنه‌های مجاز این کسب‌وکار نیست.",
};
