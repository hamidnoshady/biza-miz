/**
 * "What address am I being reached at?" — for the MCP realm.
 *
 * Two different questions share one answer here and must not be allowed to
 * drift apart:
 *
 *   * **Which tenant is this?** The MCP endpoint and the whole OAuth flow are
 *     session-less by definition (a token is what a session would otherwise
 *     be), so the host is the only thing that names the business — Phase 23's
 *     rule, the same one login and WebAuthn follow. That makes the host part of
 *     the isolation boundary, so it is read with `requestHost`, exactly as
 *     middleware reads it, rather than with the lenient forwarded-header-first
 *     precedence used for strings that are merely displayed.
 *   * **What issuer do I advertise?** OAuth clients compare the `issuer` in the
 *     metadata document against where they fetched it from, and a mismatch is a
 *     hard failure in a conforming client. So it has to be built from the very
 *     same host the tenant was resolved from.
 *
 * On a deployment with no `ROOT_DOMAIN` — the desktop install, a single-café
 * laptop — there is no host label to read, and `resolveMcpTenant` falls back to
 * the install's sole business. See `resolveSoleBusiness`.
 */
import { hostRoutingEnabled, parseHost, preferredProto, requestHost, rootDomain } from "../host";
import { resolveBusinessByLabel, resolveSoleBusiness, type ResolvedBusinessHost } from "../host-resolution";
import { classifyHostname, splitHostPort } from "../public-origin";

/**
 * The origin to use as the OAuth issuer and as the base of every advertised
 * URL. Scheme falls back to `https` because every deployment that serves an MCP
 * client is behind TLS; a local `http://localhost:3000` is recovered from the
 * request's own protocol via `preferredProto`.
 */
export function mcpIssuer(headers: Headers, requestProtocol = "https:"): string {
  const host = requestHost(headers);
  const declared = preferredProto(headers.get("x-forwarded-proto"), requestProtocol);
  return host ? `${mcpScheme(host, declared)}://${host}` : "";
}

/**
 * A production server answering on a real public name is reached over TLS, so
 * that is the scheme it advertises — whatever the proxy chain declared.
 *
 * Behind a CDN that pulls from the origin over plain HTTP, or a proxy that does
 * not forward `X-Forwarded-Proto`, the container sees `http` and every URL in
 * the discovery documents used to say `http://`. The MCP and OAuth rules refuse
 * that for a non-loopback server, and a client compares the advertised
 * `resource` with the URL it actually connected to, so it rejected the
 * connection before the first tool call and showed nothing but "failed to
 * connect". Loopback, LAN and container names (the desktop install, `npm run
 * dev`) keep whatever the request used.
 */
function mcpScheme(host: string, declared: string): string {
  if (process.env.NODE_ENV !== "production") return declared;
  const { hostname } = splitHostPort(host);
  return classifyHostname(hostname) === "public" ? "https" : declared;
}

export type McpTenantResolution =
  | { ok: true; business: ResolvedBusinessHost }
  | { ok: false; reason: "unknown_host" | "not_a_business_host" | "suspended" | "ambiguous" };

/**
 * Which business this MCP request is for.
 *
 * Fails closed in every direction a host can be wrong: the apex and the admin
 * console serve no tenant, an unknown label belongs to nobody, and a suspended
 * or archived business answers nothing. An *alias* host (left over from a
 * subdomain rename) still resolves — a connector configured before the rename
 * would otherwise break silently in a client with nowhere to show the error,
 * and the alias already resolves for every other session-less entrance.
 */
export async function resolveMcpTenant(headers: Headers): Promise<McpTenantResolution> {
  if (!hostRoutingEnabled()) {
    // `SUBDOMAIN_ROUTING=off` with a ROOT_DOMAIN still serves businesses at
    // `{label}.{root}` — the switch only stops middleware enforcing the
    // origin. The OAuth flow has no session to name the tenant, so without
    // this every register/authorize/token call on such a deployment answered
    // "ambiguous" and no standard MCP client could connect. A label that names
    // an active business is decisive; anything else keeps the old fallback.
    const label = labelledBusinessHost(requestHost(headers), rootDomain());
    if (label) {
      const business = await resolveBusinessByLabel(label);
      if (business && business.status === "active") return { ok: true, business };
    }
    const sole = await resolveSoleBusiness();
    if (!sole) return { ok: false, reason: "ambiguous" };
    return sole.status === "active" ? { ok: true, business: sole } : { ok: false, reason: "suspended" };
  }

  const parsed = parseHost(requestHost(headers), rootDomain());
  if (parsed.kind !== "business") return { ok: false, reason: "not_a_business_host" };

  const business = await resolveBusinessByLabel(parsed.label);
  if (!business) return { ok: false, reason: "unknown_host" };
  if (business.status !== "active") return { ok: false, reason: "suspended" };
  return { ok: true, business };
}

/**
 * Issue #883 P1-6 — may a bearer credential for `businessId` answer on the host
 * this resolution came from?
 *
 * The OAuth flow resolves the tenant from the hostname; before this check the
 * tool endpoint authenticated from the token alone and never compared the two,
 * so a token minted for business A answered on business B's host. The rules,
 * in the order they decide:
 *
 *   * a decisive resolution must name the *same* business — a token replayed
 *     onto another business's host dies here, aliases included (an alias
 *     resolves to the same business, so a rename does not break connectors);
 *   * `unknown_host`, `not_a_business_host` (the apex, the admin console) and
 *     `suspended` deny: none of those hosts may serve a tenant's tools;
 *   * `ambiguous` allows: no host routing and more than one business — the
 *     documented single-origin shape where the token *is* the tenant selector.
 *
 * Pure, so the policy is unit tested rather than only exercised over HTTP.
 */
export function mcpHostAllowsBusiness(
  resolution: McpTenantResolution,
  businessId: string,
): boolean {
  if (!resolution.ok) return resolution.reason === "ambiguous";
  return resolution.business.businessId === businessId;
}

/**
 * The business label a host carries under ROOT_DOMAIN, or null when it names
 * none (no root configured, the apex, the admin console, a foreign host).
 * Pure, so the routing-off fallback above is unit tested.
 */
export function labelledBusinessHost(
  host: string | null | undefined,
  root: string | null | undefined,
): string | null {
  const parsed = parseHost(host, root);
  return parsed.kind === "business" ? parsed.label : null;
}

/**
 * The OAuth `error_description` for a host that names no business. Plain
 * words for a client to show, never the internal resolution code.
 */
export function mcpTenantErrorDescription(reason: Exclude<McpTenantResolution, { ok: true }>["reason"]): string {
  switch (reason) {
    case "suspended":
      return "The business at this address is not active.";
    case "ambiguous":
      return "This address serves several businesses. Use the MCP address shown on the business's own Connections page.";
    default:
      return "This address does not belong to a business. Use the MCP address shown on the business's Connections page.";
  }
}
