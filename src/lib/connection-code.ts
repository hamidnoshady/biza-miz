/**
 * What did the owner actually paste into the desktop app's «کد اتصال» box, and
 * what did they type into its address box?
 *
 * This file exists because of a real, reproducible failure. The desktop
 * first-run screen asks for a *pairing code* — twelve characters,
 * `XXXX-XXXX-XXXX`, issued for one business and redeemable once. The only
 * place that issued one used to be the super-admin console, so an owner
 * looking around their own cloud dashboard found instead the one button that
 * says «ساخت توکن» — «اتصال‌های فنی» → «سرور راه دور» (formerly a settings
 * tab) — which mints a
 * `POS1-…` *sync token*: a different credential, for the already-paired
 * server-to-server channel. Pasting it into the desktop produced
 * `code_not_found`, rendered as «کد اتصال معتبر نیست» — "the token is wrong".
 *
 * The credential is now issuable from the owner's own dashboard (see
 * /api/connections/desktop), which removes the trap. `classifyConnectionCode`
 * closes it: a `POS1-…` in the pairing box is recognised for what it is and
 * said out loud, instead of being sent to the server to come back as a generic
 * "not valid".
 *
 * `normalizeServerAddress` is the other half of the same complaint — the
 * address is the one the owner is *logged in at*, so the natural gesture is to
 * copy it out of the browser's address bar. That yields `biz1.example.com`,
 * `https://biz1.example.com/dashboard`, or a value with Persian digits from a
 * Persian keyboard. All three name the same server, so all three are accepted.
 *
 * Framework-free and isomorphic: the desktop pair form is a client component
 * and checks a pasted value before the round trip, so nothing here may import
 * `node:crypto`.
 */
import { foldDigits, PAIRING_CODE_ALPHABET } from "./code-alphabet";
import { API_KEY_PREFIX } from "./api-key-format";
import { SYNC_TOKEN_PREFIX } from "./sync-token";

/** Twelve alphabet characters, however they were grouped when typed. */
const PAIRING_CODE_LENGTH = 12;

/** Issue #974 — Full Offline one-time enrollment token prefix (`OFL1-XXXX-XXXX-XXXX`). */
export const LOCAL_ENROLLMENT_CODE_PREFIX = "OFL1";

/** Issue #974 — Full Offline scoped installation bearer credential prefix (`LOC1-…`). */
export const LOCAL_INSTALLATION_TOKEN_PREFIX = "LOC1";

export type ConnectionCodeKind =
  /** Nothing typed yet. */
  | "empty"
  /** A `XXXX-XXXX-XXXX` pairing code — what this box wants. */
  | "pairing_code"
  /** An `OFL1-XXXX-XXXX-XXXX` Full Offline activation token — for standalone offline installs, not Hybrid pairing. */
  | "local_enrollment_code"
  /** A `LOC1-…` machine-to-cloud validation bearer secret — never typed manually. */
  | "local_installation_token"
  /** A `POS1-…` server-sync token — the mix-up this file is named for. */
  | "sync_token"
  /** A `posk_live_…` public API key — the third credential, also not this one. */
  | "api_key"
  /** Right length, but contains a character the alphabet never issues (`0`, `1`, `O`, `I`, …). */
  | "bad_charset"
  /** Recognisably a code, but not twelve characters long. */
  | "bad_length";

export type LocalEnrollmentCodeKind =
  | "empty"
  | "local_enrollment_code"
  | "pairing_code"
  | "sync_token"
  | "local_installation_token"
  | "api_key"
  | "bad_charset"
  | "bad_length";

/**
 * Which of this product's credentials — if any — was pasted into the Hybrid
 * pairing box.
 */
export function classifyConnectionCode(raw: string): ConnectionCodeKind {
  const trimmed = raw.trim();
  if (!trimmed) return "empty";

  const upper = foldDigits(trimmed).toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, "");
  if (compact.startsWith(SYNC_TOKEN_PREFIX)) return "sync_token";
  if (compact.startsWith(LOCAL_INSTALLATION_TOKEN_PREFIX)) return "local_installation_token";
  if (compact.startsWith(LOCAL_ENROLLMENT_CODE_PREFIX)) return "local_enrollment_code";
  // The API key prefix is lowercase and contains an underscore, so it is
  // compared against the raw value rather than the folded/uppercased one.
  if (trimmed.toLowerCase().startsWith(API_KEY_PREFIX)) return "api_key";

  const body = compact;
  if (body.length !== PAIRING_CODE_LENGTH) return "bad_length";
  if ([...body].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))) return "bad_charset";
  return "pairing_code";
}

/**
 * Issue #974 — classify what the owner pasted into the Full Offline Cloud
 * activation token box (`OFL1-XXXX-XXXX-XXXX`).
 */
export function classifyLocalEnrollmentCode(raw: string): LocalEnrollmentCodeKind {
  const trimmed = raw.trim();
  if (!trimmed) return "empty";

  const upper = foldDigits(trimmed).toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, "");
  if (compact.startsWith(SYNC_TOKEN_PREFIX)) return "sync_token";
  if (compact.startsWith(LOCAL_INSTALLATION_TOKEN_PREFIX)) return "local_installation_token";
  if (trimmed.toLowerCase().startsWith(API_KEY_PREFIX)) return "api_key";

  // Recognise `OFL1` (and common typo `0FL1`) as the Full Offline prefix.
  if (compact.startsWith(LOCAL_ENROLLMENT_CODE_PREFIX) || compact.startsWith("0FL1")) {
    const rest = compact.slice(LOCAL_ENROLLMENT_CODE_PREFIX.length);
    if (rest.length !== PAIRING_CODE_LENGTH) return "bad_length";
    if ([...rest].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))) return "bad_charset";
    return "local_enrollment_code";
  }

  // Tell the owner immediately if they pasted a Hybrid 12-char pairing code.
  if (
    compact.length === PAIRING_CODE_LENGTH &&
    [...compact].every((ch) => PAIRING_CODE_ALPHABET.includes(ch))
  ) {
    return "pairing_code";
  }

  if (compact.length !== PAIRING_CODE_LENGTH + LOCAL_ENROLLMENT_CODE_PREFIX.length) {
    return "bad_length";
  }
  return "bad_charset";
}

/** Canonical normalized string hashed for `local_enrollment_codes.code_hash`. */
export function normalizeLocalEnrollmentCode(raw: string): string {
  const compact = foldDigits(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const rest =
    compact.startsWith(LOCAL_ENROLLMENT_CODE_PREFIX) || compact.startsWith("0FL1")
      ? compact.slice(LOCAL_ENROLLMENT_CODE_PREFIX.length)
      : compact;
  return `${LOCAL_ENROLLMENT_CODE_PREFIX}-${rest}`;
}

export type ServerAddressResult =
  | { ok: true; url: string }
  | { ok: false; error: "missing_address" | "invalid_url" };

/**
 * Anything that names the cloud server -> the origin to call it on.
 *
 * A bare hostname gets `https://`, never `http://`: the pairing response
 * carries credential hashes for a whole business, and silently downgrading the
 * transport because someone omitted a scheme would be the wrong default. An
 * explicit `http://` is kept, because a laptop pairing against a server on the
 * same LAN is a real case and the owner has said so out loud.
 *
 * Any path, query or fragment is dropped — copying the address bar of a
 * logged-in dashboard yields `/dashboard`, and the pairing endpoint hangs off
 * the origin, not off wherever the owner happened to be standing.
 */
export function normalizeServerAddress(raw: string): ServerAddressResult {
  const trimmed = foldDigits(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "missing_address" };

  // A scheme that is present but not http(s) is rejected outright rather than
  // having `https://` prepended to it. Prepending would parse
  // `ftp://example.com` as the host `ftp` with a path — a silently wrong
  // address that then fails as "unreachable", which is the least useful thing
  // this could say.
  const declaredScheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (declaredScheme && declaredScheme !== "http" && declaredScheme !== "https") {
    return { ok: false, error: "invalid_url" };
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "invalid_url" };
  // `new URL("https://")` throws, but `new URL("https://?x")` does not — it
  // parses to an empty hostname. A host with no dot and no port is accepted
  // (`localhost`), anything with a space or a userinfo section is not.
  if (!parsed.hostname || parsed.username || parsed.password) return { ok: false, error: "invalid_url" };

  return { ok: true, url: `${parsed.protocol}//${parsed.host}`.toLowerCase() };
}
