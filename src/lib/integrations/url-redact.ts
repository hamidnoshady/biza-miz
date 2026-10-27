/**
 * Issue #941 — a download URL is a credential for as long as it is valid.
 *
 * The lease mints a presigned S3 GET per delivery and never stores it, but the
 * *words* around a failure can carry one back: a plugin's cURL error echoes the
 * URL it was fetching, a hand-pasted import URL can hold a token, and an old
 * queue row enqueued before lease-time minting still has a signed URL in its
 * payload. Everything that persists or shows free text from a plugin or a
 * remote runs it through `scrubUrls` so none of that outlives the request.
 *
 * Pure and dependency-free so the rules are unit-tested directly, and so
 * `media-service`, `audit` and `payload-redact` can all import it without a cycle.
 */

const MASK = "•••";

/** Query parameter names whose value authorises a request — masked, never shown. */
const SENSITIVE_PARAM_RE =
  /^(x-amz-.*|x-goog-.*|signature|sig|se|sp|sv|token|access[-_]?token|id[-_]?token|refresh[-_]?token|api[-_]?key|key|secret|credential|password|passwd|auth|authorization|policy|expires)$/i;

/** A URL up to the first character that cannot be part of one in free text. */
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>\\^`{|}]+/gi;

function scrubQuery(query: string): string {
  return query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // keep the raw name; the sensitive test below is still applied to it
      }
      return SENSITIVE_PARAM_RE.test(decoded) ? `${name}=${MASK}` : pair;
    })
    .join("&");
}

/** One URL, as it appears in text: userinfo dropped, credential-bearing query values masked. */
export function scrubUrl(raw: string): string {
  let url = raw;
  // https://user:pass@host/… — the credential is the part before the last "@" of the authority.
  url = url.replace(/^(https?:\/\/)[^/?#@]*@/i, `$1${MASK}@`);

  const hashAt = url.indexOf("#");
  const fragment = hashAt >= 0 ? url.slice(hashAt) : "";
  const withoutFragment = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = withoutFragment.indexOf("?");
  if (queryAt < 0) return `${withoutFragment}${fragment}`;
  const base = withoutFragment.slice(0, queryAt);
  const query = withoutFragment.slice(queryAt + 1);
  return `${base}?${scrubQuery(query)}${fragment}`;
}

/** Free text with every embedded http(s) URL scrubbed. Non-strings pass through. */
export function scrubUrls(text: string): string {
  if (!text || (text.indexOf("http") < 0 && text.indexOf("HTTP") < 0)) return text;
  return text.replace(URL_IN_TEXT_RE, (match) => {
    // Sentence punctuation after a URL belongs to the sentence, not to its last parameter.
    const tail = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
    return scrubUrl(tail ? match.slice(0, -tail.length) : match) + tail;
  });
}

/** `scrubUrls` that tolerates null/undefined, for columns that are nullable. */
export function scrubUrlsOrNull(text: string | null | undefined): string | null {
  return typeof text === "string" ? scrubUrls(text) : null;
}
