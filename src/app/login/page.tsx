import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain as configuredRootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { endedSupportSessionClaims, getSession } from "@/lib/auth";
import { safeLoginNextPath } from "@/lib/login-contract";
import { SupportSessionEnded } from "@/app/dashboard/support-session-banner";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import LoginForm from "./login-form";

// The alias resolution above reads the request's Host header, so this route
// must render per-request rather than be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Phase 23 — the login page is the one public page middleware cannot resolve
 * host aliases for (the Edge runtime has no database), so this route is a thin
 * server component in front of the form. A visit to a business's *old* host —
 * an alias left behind by a subdomain rename — is forwarded to the current
 * host's login, because a login served from a renamed host can never succeed:
 * the session it mints names the *current* subdomain, which the old host no
 * longer matches, so the visitor would be bounced straight back to the login
 * page. Forwarding here costs the canonical host nothing and makes a renamed
 * host behave the same way its bookmarked deep links already do.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (hostRoutingEnabled()) {
    const rootDomain = configuredRootDomain();
    const headerList = await headers();
    const host = parseHost(requestHost(headerList), rootDomain);

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      if (business?.viaAlias) {
        const proto = preferredProto(headerList.get("x-forwarded-proto"), "https");
        const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/login`);
      }
    }
  }

  // Every page's `redirect("/login")` lands here, so this is where a support
  // operator whose session is over is sent back to the console instead of
  // being shown the business's staff login.
  const endedSupport = await endedSupportSessionClaims();
  if (endedSupport) return <SupportSessionEnded grantId={endedSupport.imp.grantId} />;

  // Issue #948 P0-2/P0-3 — a valid current session does not belong on the
  // login page: it is redirected into the app (honouring a validated `next`),
  // so nobody re-enters credentials on top of a live session or mistakes the
  // door for the app. Two deliberate exceptions keep the page honest:
  //  - `?changeAccount=1` — the explicit account switch: the form is shown
  //    and the previous session is revoked first (see SignedInNotice);
  //  - `?cloudLogin=<reason>` — a failed «ورود با حساب ابری» hand-off must
  //    surface its error here even when a (weaker) session is still live, and
  //    the signed-in strip offers the switch instead of hiding the failure.
  const search = await searchParams;
  const changeAccount = search.changeAccount === "1" || search.changeAccount === "true";
  const cloudLoginReason = typeof search.cloudLogin === "string" && search.cloudLogin ? search.cloudLogin : null;
  const next = safeLoginNextPath(typeof search.next === "string" ? search.next : null, "/dashboard");
  const session = await getSession();
  if (session && !changeAccount && !cloudLoginReason) {
    redirect(next);
  }

  return (
    <>
      {session ? (
        <div className="fixed inset-x-0 top-4 z-50 flex justify-center px-4">
          <div className="w-full max-w-sm">
            <SignedInNotice
              fullName={session.fullName}
              role={session.role}
              switchMode={changeAccount}
              next={next}
            />
          </div>
        </div>
      ) : null}
      <LoginForm />
    </>
  );
}
