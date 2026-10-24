import { NextRequest, NextResponse } from "next/server";
import {
  businessHost,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel, resolveBusinessBySlug } from "@/lib/host-resolution";

/**
 * "This host isn't the one that serves you — where should you be?"
 *
 * The Node-runtime half of the two cases middleware can see but cannot
 * resolve, because the Edge runtime has no database:
 *
 *  - **an alias host.** After a subdomain rename the old host must keep
 *    working. `page.tsx` handles that for `/`, but a real bookmark is a deep
 *    path, and every deep path hits the isolation check first — which fails
 *    closed and bounces to a login on a host that serves nobody. Middleware
 *    now sends those here instead.
 *  - **a legacy `/{slug}/dashboard` URL.** Slug and subdomain agree for every
 *    business 0066 backfilled but diverge as soon as an admin sets a real
 *    subdomain, so the slug cannot be reinterpreted as a host label.
 *
 * Session-less by necessity — the visitor's session is either absent or valid
 * for a different origin, which is why they are here. This reveals nothing
 * beyond what DNS and the certificate already do: whether a name is in use,
 * and where a renamed one now points. It reads no tenant data and issues only
 * redirects.
 */
export async function GET(request: NextRequest) {
  const root = rootDomain();
  const params = request.nextUrl.searchParams;
  const slug = params.get("slug");

  // Only ever a same-site path. Without this check, `?next=https://evil.example`
  // would turn this into an open redirect. A protocol-relative `//evil.example`
  // is a URL too, hence the second test.
  const requested = params.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  // One question, one header policy. *Which host am I?* and *what URL should
  // the browser be sent to?* must follow the same rule the isolation check in
  // middleware applies (`requestHost`), so the two layers cannot disagree
  // about what origin a request is on. This used to prefer `x-forwarded-host`
  // unconditionally — but unless the deployment declares its proxy rewrites
  // `Host` (TRUST_FORWARDED_HOST), that header is client-supplied, and a
  // caller could make this endpoint redirect to an origin of their choosing.
  // `requestHost` keeps the port (which the browser typed) under exactly the
  // trust contract the tenancy decision already uses (#1062 sibling audit).
  const hostHeader = requestHost(request.headers);
  const proto = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
  const here = parseHost(hostHeader, root);

  const business = slug
    ? await resolveBusinessBySlug(slug)
    : here.kind === "business"
      ? await resolveBusinessByLabel(here.label)
      : null;

  // Nothing here: no such business, or an archived one whose origin should
  // stop answering. Send them to the apex, which can ask who they are.
  if (!business || business.status === "archived") {
    const port = (hostHeader ?? "").match(/:(\d+)$/)?.[1];
    return NextResponse.redirect(`${proto}://${root}${port ? `:${port}` : ""}/`);
  }

  // Already on the right host — the visitor simply isn't signed in here (or
  // holds a session for another business). Hand them this host's login rather
  // than bouncing them between hosts.
  //
  // Built from the validated request host, not `request.url`: inside a route
  // handler that is the *internal* origin (http://localhost:3000 behind a
  // proxy), unlike in middleware where it reflects the external one.
  // Redirecting there would send the browser somewhere it cannot reach.
  if (!slug && here.kind === "business" && here.label === business.subdomain) {
    // `next` is carried through so a deep link survives the sign-in — it has
    // already been narrowed to a same-site path above, so it cannot become an
    // open redirect here either.
    const query = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(`${proto}://${hostHeader}/login${query}`);
  }

  // 308, not 301: a browser must not silently turn a POST into a GET here, and
  // unlike 301 this stays re-checkable if the subdomain is renamed again.
  const target = hostHeader
    ? swapHostLabel(hostHeader, business.subdomain, root)
    : businessHost(business.subdomain, root);
  return NextResponse.redirect(`${proto}://${target}${next}`, 308);
}
