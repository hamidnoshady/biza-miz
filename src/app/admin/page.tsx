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
import { getSession } from "@/lib/auth";
import { safeLoginNextPath } from "@/lib/login-contract";
import { SignedInNotice } from "@/components/auth/signed-in-notice";
import AdminLoginForm from "./admin-login-form";

// The alias resolution below reads the request's Host header, so this route
// must render per-request rather than be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * The owner/manager door of a tenant's origin — `biz.{root}/admin`.
 *
 * Before the login split the password form shared `/login` with the staff
 * quick login behind a tab switch; the tenant root is now the staff door
 * only, and admin sign-in lives at this subdirectory of the business's own
 * origin. Same alias rule as src/app/login/page.tsx: a visit to a business's
 * *old* host is forwarded to the current host's `/admin`, because a session
 * minted on a renamed host can never stick.
 */
export default async function AdminLoginPage({
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
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/admin`);
      }
    }
  }

  // Issue #948 P0-2/P0-3 — same rule as /login: a live session is redirected
  // into the app (honouring a validated `next`) instead of stacking a second
  // sign-in on top of it. `?changeAccount=1` keeps the door open and revokes
  // the previous session first, so switching from a cashier session to an
  // owner login never leaves the old session behind.
  const search = await searchParams;
  const changeAccount = search.changeAccount === "1" || search.changeAccount === "true";
  const next = safeLoginNextPath(typeof search.next === "string" ? search.next : null, "/dashboard");
  const session = await getSession();
  if (session && !changeAccount) {
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
      <AdminLoginForm />
    </>
  );
}
