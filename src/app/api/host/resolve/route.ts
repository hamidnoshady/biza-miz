import { NextRequest, NextResponse } from "next/server";
import {
  businessHost,
  hostDebugEnabled,
  hostRoutingEnabled,
  parseHost,
  requestHost,
  trustForwardedHost,
  type HostEnv,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";

/**
 * What business is this hostname? — the Node-runtime half of host resolution.
 *
 * Middleware answers the *isolation* question on Edge by comparing the host's
 * label to the session's own claim, which needs no database. This route
 * answers the *directory* question, which does: whether a label belongs to a
 * business at all, and whether it is an old host that has since been renamed.
 *
 * Deliberately session-less, and deliberately narrow. It reveals only what the
 * DNS record and the TLS certificate already reveal — that a subdomain is or
 * is not in use, and where a renamed one now points — and nothing about the
 * business behind it beyond its display name, which its own login page shows
 * anyway. Callers are the apex router (does this name exist?) and an alias
 * host redirecting itself to the current name.
 *
 * `?debug=1` adds what the app *saw* — the two host headers, which of them the
 * tenancy decision used, and how it parsed. Behind a managed platform that
 * rewrites `Host`, this is the only way to find out that it does: every symptom
 * of it (endless redirects to the apex, a login that never sticks) looks like
 * something else. It echoes the caller's own request headers back to them,
 * plus the root domain, which is in the URL they typed — so the one new fact
 * it can reveal is the platform's internal hostname for the container. That is
 * still reconnaissance for anyone who asks (SECURITY_AUDIT L5), so a production
 * server ignores the parameter unless HOST_RESOLVE_DEBUG=on (issue #1003; see
 * `hostDebugEnabled`).
 */
export async function GET(request: NextRequest) {
  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";
  const used = request.nextUrl.searchParams.get("host") ?? requestHost(request.headers);
  const parsed = parseHost(used, rootDomain);

  const debug =
    request.nextUrl.searchParams.get("debug") === "1" && hostDebugEnabled(process.env)
      ? {
          request: {
            host: request.headers.get("host"),
            forwardedHost: request.headers.get("x-forwarded-host"),
            usedForTenancy: used,
            trustForwardedHost: trustForwardedHost(process.env as HostEnv),
            rootDomain,
            subdomainRouting: hostRoutingEnabled(),
            parsed,
          },
        }
      : null;

  if (parsed.kind !== "business") {
    return NextResponse.json({ kind: parsed.kind, business: null, ...debug });
  }

  const business = await resolveBusinessByLabel(parsed.label);
  // Archived businesses are treated as absent: the origin should stop
  // resolving when the tenant is gone, not offer a login that can never work.
  if (!business || business.status === "archived") {
    return NextResponse.json({ kind: "business", business: null, ...debug });
  }

  return NextResponse.json({
    ...debug,
    kind: "business",
    business: {
      name: business.name,
      subdomain: business.subdomain,
      status: business.status,
      // Set when the caller arrived on an old host: the current origin to go
      // to instead. Null on the canonical host, so a client can redirect on
      // truthiness without comparing strings itself.
      canonicalUrl: business.viaAlias ? `https://${businessHost(business.subdomain, rootDomain)}` : null,
    },
  });
}
