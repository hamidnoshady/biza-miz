import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { resolveRootLanding } from "@/lib/root-landing";
import { hasAnyUser, isSetupComplete } from "@/lib/setup-state";

/**
 * Issue #1003 item 8 — the answer to `GET /`, as a real redirect.
 *
 * Middleware rewrites `/` here (see `rewritesToRootLanding`), so the browser
 * still sees `/` answered — now with a 307 to the login page, the first-run
 * wizard, setup or the dashboard, instead of a 200 page that meta-refreshed
 * itself there once the root loading boundary had already started streaming.
 * The decision is `resolveRootLanding`, the same rules page.tsx applied.
 *
 * Every `Location` is a path, never an absolute URL built from `request.url`:
 * inside a route handler that is the *internal* origin (http://localhost:3000
 * behind a proxy), which the browser cannot reach. The renamed-host redirect is
 * the one absolute URL, and `resolveRootLanding` builds it from the request's
 * own Host and forwarded scheme, exactly as the page did.
 *
 * Session-less by necessity (it is where a visitor without one is sent to the
 * login page), and it reveals nothing the page did not: which of those four
 * places this visitor belongs in. The apex directory and the unknown-host
 * explanation are pages, so middleware leaves those hosts to page.tsx; reached
 * directly on one of them, this sends the browser back to `/` to render it.
 */
export async function GET(request: NextRequest) {
  let location: string;
  try {
    const landing = await resolveRootLanding(request.headers, {
      getSession,
      hasAnyUser,
      isSetupComplete,
      resolveBusinessByLabel,
    });
    location = landing.kind === "redirect" ? landing.location : "/";
  } catch (error) {
    // The database could not answer (not migrated yet, restarting, down).
    // When page.tsx made this decision, that surfaced as the root error
    // boundary's friendly page; a route handler has none, and a bare 500 on
    // `/` would leave the desktop window blank. The dashboard is the default
    // destination anyway: its own guards send a visitor without a session to
    // the login page, and its error boundary explains a database outage.
    console.error("[host/landing] could not resolve the landing page", error);
    location = "/dashboard";
  }
  return new NextResponse(null, {
    status: 307,
    headers: {
      Location: location,
      // The answer depends on the session cookie and the install's state.
      "Cache-Control": "no-store",
    },
  });
}
