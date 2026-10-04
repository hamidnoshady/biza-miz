/**
 * Issue #807 — the explicit outbound-network policy for peer and direct-URL
 * restore (and every other server-initiated fetch in the backup system).
 *
 * Before this, URL validation checked syntax and protocol only. That is not a
 * boundary: `http://169.254.169.254/latest/meta-data/` is a perfectly valid
 * HTTPS-ish address, `http://127.0.0.1:5432/` is a valid address, and a
 * hostname the attacker controls can resolve to either (or to an RFC1918
 * address) at connect time — the classic DNS-rebinding shape.
 *
 * The policy:
 *
 *   • http(s) only, no embedded credentials, no fragments;
 *   • **blocked always**: link-local (169.254.0.0/16, fe80::/10), the cloud
 *     metadata addresses (169.254.169.254, fd00:ec2::254), unspecified
 *     (0.0.0.0/::), multicast, and reserved/benchmark ranges;
 *   • **private / loopback / unique-local / CGNAT**: refused unless the
 *     operator explicitly allows the LAN (`allowPrivateNetwork`), because
 *     "restore from the machine next to me" is a legitimate feature — it just
 *     may not be the default;
 *   • the host is **resolved** and *every* answer is checked, so a name that
 *     resolves to a public address once and a private one later cannot slip
 *     through by DNS rotation;
 *   • redirects are followed manually, re-validated at each hop, capped, and
 *     the `Authorization` header is **never** forwarded to another origin.
 *
 * Pure classification is split from I/O so the rules are unit-testable without
 * a network (see outbound-policy.test.ts).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** What kind of address a target resolves to — the vocabulary of a refusal. */
export type AddressKind =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "unspecified"
  | "multicast"
  | "reserved";

export interface OutboundPolicy {
  /** allow plain `http:` (a LAN peer, the operator's own NAS) */
  allowInsecure?: boolean;
  /** allow private/RFC1918/ULA/CGNAT targets — an explicit LAN restore decision */
  allowPrivateNetwork?: boolean;
  /** allow loopback — only ever set by tests or an explicit same-machine config */
  allowLoopback?: boolean;
  /** per-request timeout (ms) */
  timeoutMs?: number;
  /** maximum redirect hops */
  maxRedirects?: number;
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_REDIRECTS = 3;

export type OutboundUrlResult =
  | { ok: true; url: string; secure: boolean }
  | { ok: false; error: string };

/** The metadata endpoints every major cloud publishes on a link-local address. */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]);

function v4ToInt(address: string): number {
  const parts = address.split(".").map((p) => Number(p));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Range(address: string, base: string, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (v4ToInt(address) & mask) === (v4ToInt(base) & mask);
}

/** Classify one literal IP address. Never resolves anything. */
export function classifyAddress(address: string): AddressKind {
  const bare = address.includes("%") ? address.slice(0, address.indexOf("%")) : address;
  const family = isIP(bare);
  if (family === 4) {
    if (METADATA_ADDRESSES.has(bare)) return "metadata";
    if (bare === "0.0.0.0") return "unspecified";
    if (inV4Range(bare, "127.0.0.0", 8)) return "loopback";
    if (inV4Range(bare, "169.254.0.0", 16)) return "link-local";
    if (
      inV4Range(bare, "10.0.0.0", 8) ||
      inV4Range(bare, "172.16.0.0", 12) ||
      inV4Range(bare, "192.168.0.0", 16) ||
      inV4Range(bare, "100.64.0.0", 10)
    ) {
      return "private";
    }
    if (inV4Range(bare, "224.0.0.0", 4) || inV4Range(bare, "239.0.0.0", 8)) return "multicast";
    if (
      inV4Range(bare, "240.0.0.0", 4) ||
      inV4Range(bare, "192.0.0.0", 24) ||
      inV4Range(bare, "192.0.2.0", 24) ||
      inV4Range(bare, "198.18.0.0", 15) ||
      inV4Range(bare, "198.51.100.0", 24) ||
      inV4Range(bare, "203.0.113.0", 24)
    ) {
      return "reserved";
    }
    return "public";
  }
  if (family === 6) {
    const lower = bare.toLowerCase();
    if (METADATA_ADDRESSES.has(lower)) return "metadata";
    if (lower === "::" || lower === "::0") return "unspecified";
    if (lower === "::1") return "loopback";
    if (lower.startsWith("fe80")) return "link-local";
    if (lower.startsWith("ff")) return "multicast";
    // Unique local (fc00::/7) and IPv4-mapped private ranges.
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return classifyAddress(mapped);
    }
    if (lower.startsWith("2001:db8")) return "reserved";
    return "public";
  }
  return "reserved";
}

/**
 * Which kinds a policy admits. Metadata and multicast are never admitted —
 * there is no legitimate reason for this product to fetch either.
 */
export function addressAllowed(kind: AddressKind, policy: OutboundPolicy): boolean {
  switch (kind) {
    case "public":
      return true;
    case "private":
      return Boolean(policy.allowPrivateNetwork);
    case "loopback":
      return Boolean(policy.allowLoopback) || Boolean(policy.allowPrivateNetwork);
    case "link-local":
    case "metadata":
    case "multicast":
    case "unspecified":
    case "reserved":
      return false;
    default:
      return false;
  }
}

/**
 * Validate the URL's shape *and* its literal host, before any DNS or network
 * work. A hostname is not judged here — `authorizeResolvedTarget` checks the
 * addresses it resolves to.
 */
export function evaluateOutboundUrl(raw: unknown, policy: OutboundPolicy = {}): OutboundUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { ok: false, error: "invalid_url" };
  if (value.length > 2048) return { ok: false, error: "invalid_url" };
  if (/[\s\0\u200b-\u200f]/.test(value)) return { ok: false, error: "invalid_url" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "invalid_url" };
  if (url.username || url.password) return { ok: false, error: "credentials_in_url" };
  if (url.hash) return { ok: false, error: "invalid_url" };
  if (!url.hostname) return { ok: false, error: "invalid_url" };

  const secure = url.protocol === "https:";
  if (!secure && !policy.allowInsecure) return { ok: false, error: "https_required" };

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const kind = classifyAddress(host);
    if (!addressAllowed(kind, policy)) return { ok: false, error: `blocked_address:${kind}` };
  } else if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) {
    // Local names are loopback/private by intent; they still go through the
    // resolve step below (which may return a public address for the rare
    // split-horizon name, and that is then judged on its real address).
    if (!policy.allowLoopback && !policy.allowPrivateNetwork) {
      return { ok: false, error: "blocked_address:private" };
    }
  }

  return { ok: true, url: url.toString(), secure };
}

/**
 * Resolve a hostname and require every answer to be admissible. Returns the
 * pinned addresses so a caller can (where the transport allows) connect to
 * exactly what was checked.
 */
export async function authorizeResolvedTarget(
  url: string,
  policy: OutboundPolicy = {},
  resolver: (hostname: string) => Promise<string[]> = defaultResolver,
): Promise<{ ok: true; addresses: string[] } | { ok: false; error: string }> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (isIP(hostname)) {
    const kind = classifyAddress(hostname);
    return addressAllowed(kind, policy) ? { ok: true, addresses: [hostname] } : { ok: false, error: `blocked_address:${kind}` };
  }
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    return { ok: false, error: "dns_resolution_failed" };
  }
  if (addresses.length === 0) return { ok: false, error: "dns_resolution_failed" };
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (!addressAllowed(kind, policy)) return { ok: false, error: `blocked_address:${kind}` };
  }
  return { ok: true, addresses };
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export interface SafeFetchResult {
  response: Response;
  /** the URL the response actually came from (after redirects) */
  finalUrl: string;
}

/**
 * `fetch` under the outbound policy: manual redirects (each hop re-validated,
 * max `policy.maxRedirects`), and the `Authorization`/`Cookie` headers dropped
 * the moment a hop leaves the original origin — a redirect to a host of the
 * attacker's choosing must never receive a peer token.
 */
export async function fetchWithOutboundPolicy(
  rawUrl: string,
  init: RequestInit = {},
  policy: OutboundPolicy = {},
  fetcher: typeof fetch = fetch,
  /** Where hostnames are resolved; injectable so the policy is testable offline. */
  resolver?: (hostname: string) => Promise<string[]>,
): Promise<SafeFetchResult | { error: string }> {
  const started = evaluateOutboundUrl(rawUrl, policy);
  if (!started.ok) return { error: started.error };
  let current = started.url;
  let origin = new URL(current).origin;
  const headers = new Headers(init.headers);
  const maxRedirects = policy.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const resolved = await authorizeResolvedTarget(current, policy, resolver);
    if (!resolved.ok) return { error: resolved.error };

    let response: Response;
    try {
      response = await fetcher(current, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(policy.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS),
      });
    } catch (error) {
      return { error: `unreachable:${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` };
    }

    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return { response, finalUrl: current };
    if (hop === maxRedirects) return { error: "too_many_redirects" };

    let next: string;
    try {
      next = new URL(location!, current).toString();
    } catch {
      return { error: "invalid_redirect" };
    }
    const evaluated = evaluateOutboundUrl(next, policy);
    if (!evaluated.ok) return { error: `redirect_${evaluated.error}` };
    const nextOrigin = new URL(evaluated.url).origin;
    if (nextOrigin !== origin) {
      // Never forward credentials across origins; a peer token is scoped to
      // the peer's origin and nowhere else.
      headers.delete("authorization");
      headers.delete("cookie");
      origin = nextOrigin;
    }
    current = evaluated.url;
  }
  return { error: "too_many_redirects" };
}

/** Convenience: the refusal codes the restore path maps to operator copy. */
export function isBlockedTargetError(error: string): boolean {
  return error.startsWith("blocked_address:") || error.startsWith("redirect_blocked_address:");
}
