import { NextResponse, type NextRequest } from "next/server";
import { healthBody, type HealthEnv } from "@/lib/health-response";

/**
 * Liveness probe — "is the server on the other end of this origin answering?"
 *
 * Session-less and database-less on purpose, for two callers:
 *
 *  1. The client status strip (src/app/dashboard/offline-queue.tsx). It used to
 *     derive "connected" from `navigator.onLine` alone, which only reports
 *     whether the device has *a* network interface up — not whether this app is
 *     reachable. Any deployment where the page loads but a later request fails
 *     (an edge that drops the container mid-session, a captive Wi-Fi portal,
 *     a proxy 502) left the browser reporting `onLine === true` while nothing
 *     reached the server, so the banner's inverse case — a live server the
 *     browser had briefly given up on — showed "اتصال به سرور قطع است" with no
 *     way to clear it short of a reload. This gives that strip something real
 *     to ask.
 *
 *  2. Platform health checks (Runflare, ParsPack, Komodo, Docker healthcheck).
 *     They need a cheap 200 that does not depend on a session cookie or a
 *     tenant host resolving, so a probe never gets bounced into the host
 *     resolver and read as "down".
 *
 * It deliberately does NOT touch Postgres: this answers "is the web tier up",
 * and a DB blip should not make an edge tear down a container that is still
 * serving cached pages and queueing writes. It is listed in middleware's
 * PUBLIC_PATHS for the same reason.
 *
 * Two callers get a little more, and only by proving who they are (issue
 * #1003 — the body used to carry both to anyone; see src/lib/health-response.ts):
 *
 *  - the post-publish rollout check gets the image's build commit (`version`)
 *    by presenting `HEALTH_VERSION_TOKEN` in `x-health-token`, which turns the
 *    probe into a deployment check: a healthy response from the previous
 *    container is not mistaken for proof that the new image went live;
 *  - the desktop shell gets `instanceProof`, an HMAC of its own random
 *    challenge keyed by DESKTOP_INSTANCE_ID, so a different process that
 *    happens to answer on the configured port is never mistaken for this
 *    installation's backend — without the id itself ever being sent.
 */
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  // `as HealthEnv`: process.env declares no properties TypeScript can match
  // against an all-optional interface (the same reason deployment-role.ts casts).
  return NextResponse.json(healthBody(request.headers, process.env as HealthEnv), {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

export function HEAD() {
  return new Response(null, {
    status: 200,
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
