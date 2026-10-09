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

/**
 * The origin to use as the OAuth issuer and as the base of every advertised
 * URL. Scheme falls back to `https` because every deployment that serves an MCP
 * client is behind TLS; a local `http://localhost:3000` is recovered from the
 * request's own protocol via `preferredProto`.
 */
export function mcpIssuer(headers: Headers, requestProtocol = "https:"): string {
  const host = requestHost(headers);
  const proto = preferredProto(headers.get("x-forwarded-proto"), requestProtocol);
  return host ? `${proto}://${host}` : "";
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
