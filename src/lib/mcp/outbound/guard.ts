/**
 * Where an outbound MCP request is allowed to go.
 *
 * This is the whole SSRF defence for `src/lib/mcp/outbound`, and it is written
 * as a policy object rather than a boolean so a test can state the rule it is
 * checking. Three layers, and all three are needed:
 *
 *  1. **An operator allowlist.** Nothing resolves or connects unless the host is
 *     named in `MCP_OUTBOUND_ALLOWED_HOSTS`. This is what makes DNS rebinding
 *     uninteresting: an attacker who controls a name cannot make it resolve
 *     somewhere new unless that name is on the list, and the list is deployment
 *     configuration, not a value a request carries.
 *  2. **Literal-address refusal.** A URL host must be a DNS name. `https://127.0.0.1/`
 *     and `https://[::1]/` are refused before any lookup, so the common
 *     "point it at the metadata service" attempt never reaches the network.
 *  3. **Resolved-address refusal.** Every address the name resolves to is checked
 *     against the private/reserved ranges below, and *any* private answer refuses
 *     the whole request. This is the layer that catches a public name pointed at
 *     `10.0.0.5` by an internal DNS view.
 *
 * What is deliberately not supported: redirects (`redirect: "error"` in the
 * client — one 302 would otherwise walk straight past the allowlist), URL
 * credentials (`https://user:pass@host` is a secret in a string that ends up in
 * logs), and plain HTTP except on an explicitly-configured loopback entry for
 * local development.
 *
 * The residual risk is stated rather than hidden: layer 3 resolves the name, then
 * the client resolves it again when it connects, so a TTL-0 record that flips
 * between the two answers can still win a race. Layer 1 is the mitigation that
 * makes that race worthless — the name has to be one the operator chose.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Why a URL was refused. Stable strings; the caller maps them to a user message. */
export type OutboundUrlRefusal =
  | "invalid_url"
  | "scheme_not_allowed"
  | "credentials_in_url"
  | "fragment_not_allowed"
  | "ip_literal"
  | "host_not_allowed"
  | "port_not_allowed"
  | "reserved_hostname"
  | "resolves_to_private_address"
  | "dns_failed";

export interface OutboundTargetPolicy {
  /** Lower-case `host` or `host:port` entries. Empty means "nothing is allowed". */
  allowedHosts: ReadonlySet<string>;
  /** `http://` is permitted only for a loopback entry, and only when this flag is set. */
  allowLoopbackHttp: boolean;
}

export type OutboundUrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: OutboundUrlRefusal };

const MAX_URL_LENGTH = 2048;

/**
 * Parses `MCP_OUTBOUND_ALLOWED_HOSTS`.
 *
 * The format is a comma-separated list of `host` or `host:port` entries. A bare
 * host means "the default HTTPS port only"; naming a port is how a development
 * server on `localhost:4010` is allowed. Entries are lower-cased and trimmed;
 * anything containing a scheme, path or wildcard is ignored rather than
 * guessed at — a malformed allowlist must fail closed.
 */
export function parseAllowedHosts(raw: string | null | undefined): Set<string> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set<string>();
  for (const entry of entries) {
    // A scheme, a slash or a `*` is a misunderstanding of this option.
    if (entry.includes("/") || entry.includes("*") || entry.includes("://")) continue;
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(entry)) continue;
    allowed.add(entry);
  }
  return allowed;
}

export function outboundPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): OutboundTargetPolicy {
  return {
    allowedHosts: parseAllowedHosts(env.MCP_OUTBOUND_ALLOWED_HOSTS),
    allowLoopbackHttp: env.MCP_OUTBOUND_ALLOW_LOOPBACK_HTTP === "true",
  };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTNAMES.has(bare) || bare.endsWith(".localhost");
}

/**
 * Is this address one a server-side request must never reach?
 *
 * Covers the loopback, link-local, private and carrier-grade-NAT ranges, plus the
 * cloud metadata address that is the usual target (`169.254.169.254` is inside
 * link-local), IPv6 unique-local and link-local, and IPv4-mapped IPv6 forms so
 * `::ffff:127.0.0.1` cannot slip past an IPv4-only check.
 */
export function isReservedAddress(address: string): boolean {
  const bare = address.toLowerCase().split("%")[0] ?? address;

  if (isIP(bare) === 6) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
    if (mapped) return isReservedAddress(mapped[1]!);
    if (bare === "::" || bare === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(bare)) return true; // fe80::/10 link local
    return false;
  }

  if (isIP(bare) !== 4) return true; // not an address at all: refuse it

  const [a, b] = bare.split(".").map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * The synchronous half of the policy: everything that can be decided from the URL
 * alone. Split out so the client can call it before building a request and a test
 * can assert each rule without a resolver.
 */
export function checkOutboundUrl(
  input: string,
  policy: OutboundTargetPolicy,
): OutboundUrlCheck {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "invalid_url" };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  if (url.hash) return { ok: false, reason: "fragment_not_allowed" };

  const hostname = url.hostname.toLowerCase();
  const loopback = isLoopbackHostname(hostname);

  if (url.protocol !== "https:") {
    // Plain HTTP is a development-only affordance, never a production scheme.
    if (!(url.protocol === "http:" && loopback && policy.allowLoopbackHttp)) {
      return { ok: false, reason: "scheme_not_allowed" };
    }
  }

  // A literal address is refused even when it is on the allowlist: the allowlist
  // exists to name a *server*, and an address cannot be re-pointed by DNS but also
  // cannot be reviewed in configuration.
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
    return { ok: false, reason: "ip_literal" };
  }

  if (/(\.local|\.internal|\.home\.arpa)$/.test(hostname)) {
    return { ok: false, reason: "reserved_hostname" };
  }

  const hostWithPort = url.port ? `${hostname}:${url.port}` : hostname;
  const defaultPortOnly = url.port === "" || url.port === (url.protocol === "https:" ? "443" : "80");
  const allowed =
    policy.allowedHosts.has(hostWithPort) ||
    (defaultPortOnly && policy.allowedHosts.has(hostname));

  if (!allowed) return { ok: false, reason: "host_not_allowed" };
  // A port on the URL that the entry did not name is a different service.
  if (!defaultPortOnly && !policy.allowedHosts.has(hostWithPort)) {
    return { ok: false, reason: "port_not_allowed" };
  }

  return { ok: true, url };
}

/** A resolver seam so the address check can be tested without a network. */
export type AddressLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const systemLookup: AddressLookup = (hostname) => lookup(hostname, { all: true });

/**
 * The asynchronous half: resolve the name and refuse if **any** answer is private.
 *
 * `all: true` matters. A hostile name commonly returns one public and one private
 * record, and checking only the first would let the client connect to whichever
 * the resolver happened to hand back.
 */
export async function assertResolvesPublic(
  url: URL,
  resolve: AddressLookup = systemLookup,
): Promise<{ ok: true } | { ok: false; reason: OutboundUrlRefusal }> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(hostname)) return { ok: true };

  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }

  if (addresses.length === 0) return { ok: false, reason: "dns_failed" };
  if (addresses.some((entry) => isReservedAddress(entry.address))) {
    return { ok: false, reason: "resolves_to_private_address" };
  }
  return { ok: true };
}

/** Both halves, in the order the client uses them. */
export async function assertOutboundTarget(
  input: string,
  policy: OutboundTargetPolicy,
  resolve: AddressLookup = systemLookup,
): Promise<OutboundUrlCheck> {
  const checked = checkOutboundUrl(input, policy);
  if (!checked.ok) return checked;
  const resolved = await assertResolvesPublic(checked.url, resolve);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return checked;
}
