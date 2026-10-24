import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { resolveRootLanding } from "@/lib/root-landing";
import { hasAnyUser, isSetupComplete } from "@/lib/setup-state";
import { BusinessDirectory } from "./business-directory";
import { cardClass } from "./dashboard/page-chrome";

/**
 * Shown when `ROOT_DOMAIN` is set but the request's hostname is not under it.
 *
 * Almost always an operator-facing message rather than a customer-facing one,
 * so it names the two things that actually cause it: a hostname that was never
 * pointed at this deployment, and a proxy that rewrites `Host` (the case
 * `TRUST_FORWARDED_HOST` exists for).
 */
function UnresolvableHost() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className={`w-full max-w-md ${cardClass} p-8 text-center`}>
        <h1 className="mb-2 text-lg font-bold">این نشانی به کسب‌وکاری تعلق ندارد</h1>
        <p className="text-sm text-muted-foreground">
          نشانی اینترنتی کسب‌وکار خود را وارد کنید یا با پشتیبانی تماس بگیرید.
        </p>
        <p className="mt-6 text-start text-xs text-muted-foreground" dir="ltr">
          This hostname is not under ROOT_DOMAIN. If a proxy or platform rewrites the Host header,
          set TRUST_FORWARDED_HOST=on; <code>/api/host/resolve?debug=1</code> shows what the app
          sees.
        </p>
      </div>
    </main>
  );
}

export default async function Home() {
  // Issue #1003 — middleware normally answers `/` before this page runs, by
  // rewriting it to /api/host/landing, which redirects with a real 307 (a
  // redirect thrown from here arrives after the root loading boundary has
  // started streaming, so it can only be a 200 page with a meta refresh). What
  // still renders here are the two answers that are pages — the apex directory
  // and the unknown-host explanation — and any request middleware did not
  // rewrite. The decision itself is shared: `resolveRootLanding`.
  const landing = await resolveRootLanding(await headers(), {
    getSession,
    hasAnyUser,
    isSetupComplete,
    resolveBusinessByLabel,
  });
  if (landing.kind === "directory") return <BusinessDirectory />;
  if (landing.kind === "unresolvable") return <UnresolvableHost />;
  redirect(landing.location);
}
